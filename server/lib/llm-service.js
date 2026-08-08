/**
 * 大模型调用服务 - OpenAI 兼容 Chat Completions
 *
 * 对齐用户提供的大模型接口信息：
 *   - API 地址：config.endpoint（含 /chat/completions）
 *   - 认证：Authorization: Bearer <token>
 *   - 请求体：{ model, messages, temperature, max_tokens: null, stream: false }
 *   - 超时：config.timeoutMs（默认 120s），走系统 curl.exe（与 ClickHouse 客户端一致，避免挂起）
 *   - 上下文控制：输入长度由调用方（report-generator.js）裁剪，模型超限返回 finish_reason=length 时明确报错
 */
const { logger } = require('./logger');
const aiConfig = require('./ai-config-store');
const { curlJsonPost } = require('./clickhouse-client');

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

  const messages = [];
  if (system && String(system).trim()) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(user) });

  const body = {
    model: cfg.model || 'DeepSeek_V4_Flash_Client',
    messages,
    temperature: cfg.temperature !== undefined && cfg.temperature !== null ? cfg.temperature : 0.2,
    max_tokens: null,
    stream: false
  };

  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 120000;
  const startedAt = Date.now();
  logger.info(`[llm] call model=${body.model} systemLen=${messages[0] ? messages[0].content.length : 0} userLen=${body.messages[body.messages.length - 1].content.length} timeoutMs=${timeoutMs}`);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.token.trim()}`
  };

  const res = await curlJsonPost(cfg.endpoint, headers, body, timeoutMs);

  if (res.status !== 200) {
    logger.error(`[llm] http ${res.status}`, String(res.body).slice(0, 2000));
    if (res.status === 401 || res.status === 403) {
      throw new Error('大模型鉴权失败（HTTP ' + res.status + '），请检查 AI 设置中的 Token 是否正确');
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

  const choice = json.choices && json.choices[0];
  const content = choice && choice.message ? String(choice.message.content || '') : '';
  const finishReason = choice ? String(choice.finish_reason || '') : '';

  const usedMs = Date.now() - startedAt;
  if (finishReason === 'length') {
    logger.error(`[llm] finish_reason=length chars=${content.length} ms=${usedMs} — 输入超出模型上下文限制`);
    throw new Error('模型输出超长（finish_reason=length）：本次输入已超出模型上下文限制，请缩小巡检时间范围或减少聚类样本后再试');
  }

  if (!content) {
    logger.error('[llm] empty content', String(res.body).slice(0, 1000));
    throw new Error('大模型返回内容为空');
  }

  logger.info(`[llm] ok finish=${finishReason} chars=${content.length} ms=${usedMs}`);
  return { content, finishReason };
}

module.exports = { callChat };
