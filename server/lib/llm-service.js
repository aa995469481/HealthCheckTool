/**
 * 大模型调用服务 - OpenAI 兼容 Chat Completions
 *
 * 对齐用户提供的大模型接口信息：
 *   - API 地址：config.endpoint（含 /chat/completions）
 *   - 认证：Authorization: Bearer <token>
 *   - 请求体：{ model, messages, temperature, stream: false }（与已验证成功的 curl 完全一致，不携带 max_tokens）
 *   - 超时：config.timeoutMs（默认 120s），走系统 curl.exe（与 ClickHouse 客户端一致，避免挂起）
 *   - 上下文控制：输入长度由调用方（report-generator.js）裁剪，模型超限返回 finish_reason=length 时明确报错
 */
const { logger } = require('./logger');
const aiConfig = require('./ai-config-store');
const { curlJsonPost } = require('./clickhouse-client');
const debugMode = require('./debug-mode');

/** 脱敏 token：仅显示前 6 位与后 4 位，用于日志比对（确认页面配置的 token 是否正确） */
function maskToken(t) {
  const s = String(t || '');
  if (s.length <= 12) return s.slice(0, 2) + '***';
  return s.slice(0, 6) + '...' + s.slice(-4);
}

/**
 * 调用大模型（单轮对话）
 * @param {object} opts { system?: string, user: string }
 * @returns {Promise<{ content: string, finishReason: string }>}
 */
async function callChat({ system, user } = {}) {
  if (!user || !String(user).trim()) throw new Error('调用大模型时 prompt 为空');
  const cfg = aiConfig.getConfig();
  if (!cfg.token || !cfg.token.trim()) {
    throw new Error('AI Token 未配置，请先在「AI 设置」中填写');
  }
  // 兼容：用户可能填成了 "Bearer sk-xxx"，去掉前缀避免 Authorization 变成 "Bearer Bearer sk-xxx"
  const rawToken = cfg.token.trim();
  const token = rawToken.toLowerCase().startsWith('bearer ')
    ? rawToken.slice('bearer '.length).trim()
    : rawToken;

  const messages = [];
  if (system && String(system).trim()) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(user) });

  // 请求体对齐已验证成功的 curl 样例；额外携带 max_tokens 限制模型输出长度（防止超长生成拖死等待，0 表示不限制）
  const body = {
    model: cfg.model || 'DeepSeek_V4_Flash_Client',
    messages,
    temperature: cfg.temperature !== undefined && cfg.temperature !== null ? cfg.temperature : 0.2,
    stream: false
  };
  if (cfg.maxTokens && cfg.maxTokens > 0) body.max_tokens = Number(cfg.maxTokens);

  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 120000;
  const startedAt = Date.now();
  logger.info(
    `[llm] call model=${body.model} endpoint=${cfg.endpoint} token=${maskToken(token)} ` +
    `systemLen=${messages[0] ? messages[0].content.length : 0} userLen=${body.messages[body.messages.length - 1].content.length} ` +
    `timeoutMs=${timeoutMs} maxTokens=${body.max_tokens || '不限'}`
  );

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };

  if (debugMode.getDebugEnabled()) {
    logger.info(`[llm] REQUEST BODY:\n${JSON.stringify(body, null, 2)}`);
  }

  // 超时 / HTTP 5xx 自动重试 1 次（网关排队/偶发抖动时提高成功率）；4xx 等确定性错误不重试
  const MAX_ATTEMPTS = 2;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await curlJsonPost(cfg.endpoint, headers, body, timeoutMs);

      if (res.status !== 200) {
        logger.error(`[llm] http ${res.status}`, String(res.body).slice(0, 2000));
        if (res.status === 401 || res.status === 403) {
          const detail = String(res.body || '').slice(0, 300).trim();
          throw new Error(
            `大模型鉴权失败（HTTP ${res.status}）` + (detail ? `，服务端返回：${detail}` : '') +
            '。请检查 AI 设置中的 Token 是否正确或已过期'
          );
        }
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          const usedMs = Date.now() - startedAt;
          logger.warn(`[llm] http ${res.status} attempt ${attempt}/${MAX_ATTEMPTS} ms=${usedMs}，3s 后重试`);
          await sleep(3000);
          continue;
        }
        throw new Error(`大模型调用失败（HTTP ${res.status}）：${String(res.body).slice(0, 500)}`);
      }

      let json;
      try {
        json = JSON.parse(res.body);
      } catch (e) {
        logger.error('[llm] response not json', String(res.body).slice(0, 1000));
        throw new Error('大模型返回内容解析失败：' + e.message);
      }

      // 网关自定义封装：HTTP 200 但 result.code != 0 表示服务端业务错误（如 Full to incr pod load balance timeout），属偶发负载类错误，标记可重试
      const bizCode = json && json.result && json.result.code !== undefined ? json.result.code : null;
      if (bizCode !== null && Number(bizCode) !== 0) {
        const bizDes = json.result.des ? String(json.result.des) : '';
        const svc = json.result.serviceName ? String(json.result.serviceName) : '';
        const err = new Error(`大模型服务端错误（code=${bizCode}）${bizDes ? '：' + bizDes : ''}${svc ? '（服务：' + svc + '）' : ''}`);
        err.retryable = true;
        throw err;
      }

      const choice = json.choices && json.choices[0];
      const content = choice && choice.message ? String(choice.message.content || '') : '';
      const finishReason = choice ? String(choice.finish_reason || '') : '';

      const usedMs = Date.now() - startedAt;
      if (finishReason === 'length') {
        // 输出达到 max_tokens 上限：保留已生成内容并标记截断，不致命（日报仍可用），提示调大上限
        logger.warn(`[llm] finish_reason=length chars=${content.length} ms=${usedMs} — 输出达到 max_tokens=${body.max_tokens || '不限'} 上限被截断，内容可能不完整`);
        return { content, finishReason: 'length', truncated: true };
      }

      if (!content) {
        logger.error('[llm] empty content', String(res.body).slice(0, 1000));
        throw new Error('大模型返回内容为空');
      }

      logger.info(`[llm] ok finish=${finishReason} chars=${content.length} ms=${usedMs} attempt=${attempt}/${MAX_ATTEMPTS}`);
      return { content, finishReason };
    } catch (e) {
      lastErr = e;
      const retryable = /timeout/i.test(e.message) || e.retryable === true;
      if (!retryable || attempt === MAX_ATTEMPTS) throw e;
      const usedMs = Date.now() - startedAt;
      logger.warn(`[llm] attempt ${attempt}/${MAX_ATTEMPTS} failed ms=${usedMs}: ${e.message}，3s 后重试`);
      await sleep(3000);
    }
  }
  throw lastErr || new Error('大模型调用失败');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------- 模型连通性测试（AI 设置页「测试连接」用） ---------- */

/**
 * 用传入的配置（页面表单，可能尚未保存）发起一次极简调用，验证 endpoint/model/token 是否可用。
 * 缺省字段回退到已保存配置；不写入任何配置。
 * @param {object} opts { endpoint?, model?, token?, temperature?, timeoutMs? }
 * @returns {Promise<{ ok: boolean, reply?: string, ms?: number, model?: string, error?: string }>}
 */
async function testConnection({ endpoint, model, token, temperature, timeoutMs } = {}) {
  const cfg = aiConfig.getConfig();
  const ep = endpoint && String(endpoint).trim() ? String(endpoint).trim() : cfg.endpoint;
  const mdl = model && String(model).trim() ? String(model).trim() : cfg.model;
  const rawToken = token && String(token).trim() ? String(token).trim() : cfg.token;
  const t = timeoutMs && timeoutMs > 0 ? Number(timeoutMs) : cfg.timeoutMs || 240000;
  if (!rawToken) {
    return { ok: false, error: 'Token 未填写，请先填写 Token 再测试' };
  }
  const tokenClean = rawToken.toLowerCase().startsWith('bearer ')
    ? rawToken.slice('bearer '.length).trim()
    : rawToken;

  const body = {
    model: mdl,
    messages: [{ role: 'user', content: '请只回复两个字：正常' }],
    temperature: temperature !== undefined && temperature !== null ? temperature : 0.2,
    stream: false
  };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenClean}` };
  const startedAt = Date.now();
  logger.info(`[llm-test] call model=${mdl} endpoint=${ep} token=${maskToken(tokenClean)} timeoutMs=${t}`);

  try {
    const res = await curlJsonPost(ep, headers, body, t);
    const usedMs = Date.now() - startedAt;
    if (res.status !== 200) {
      const detail = String(res.body || '').slice(0, 300).trim();
      let reason = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) reason = 'Token 无效或已过期';
      else if (res.status === 404) reason = 'API 地址路径错误（应指向 /chat/completions）';
      else if (res.status === 400) reason = '请求被拒绝，常见原因：模型名不存在或不支持该模型';
      logger.error(`[llm-test] http ${res.status}`, detail);
      return { ok: false, error: `${reason}（HTTP ${res.status}）${detail ? '：' + detail : ''}` };
    }
    let json;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      return { ok: false, error: '响应解析失败（返回内容不是 JSON）：' + String(res.body).slice(0, 200) };
    }
    // 网关自定义封装：HTTP 200 但 result.code != 0 表示服务端业务错误（负载均衡超时等）
    const bizCode = json && json.result && json.result.code !== undefined ? json.result.code : null;
    if (bizCode !== null && Number(bizCode) !== 0) {
      return { ok: false, error: `服务端业务错误（code=${bizCode}）：${(json.result.des || '未知')}（网关负载/超时类错误，可稍后重试）` };
    }
    const choice = json.choices && json.choices[0];
    const content = choice && choice.message ? String(choice.message.content || '') : '';
    const finishReason = choice ? String(choice.finish_reason || '') : '';
    if (!content) {
      return { ok: false, error: `模型返回空内容（finish_reason=${finishReason || 'unknown'}）` };
    }
    logger.info(`[llm-test] ok finish=${finishReason} chars=${content.length} ms=${usedMs}`);
    return { ok: true, reply: content.slice(0, 200), ms: usedMs, model: mdl };
  } catch (e) {
    const usedMs = Date.now() - startedAt;
    const msg = String((e && e.message) || e);
    logger.error(`[llm-test] failed ms=${usedMs}`, e);
    if (/timeout/i.test(msg)) {
      return { ok: false, error: `连接超时（${Math.round(usedMs / 1000)}s）：模型 ${t / 1000}s 内未响应。请检查网络能否访问该 API，或在设置中调大超时时间` };
    }
    if (/curl failed/i.test(msg)) {
      return { ok: false, error: `无法连接到该 API 地址（${msg}）。请检查网络/防火墙是否放行该域名，或确认地址拼写是否正确` };
    }
    return { ok: false, error: msg };
  }
}

module.exports = { callChat, testConnection };
