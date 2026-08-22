/**
 * Keep Alive 存活探测 - 后台定时发起轻量查询，保持 Wise token 有效
 *
 * 机制：
 *   1. server 启动时调用 start()，注册常驻定时器（intervalMinutes 分钟一次）
 *   2. 每次 tick 检查配置开关，enabled 且凭据已配置时执行探测
 *   3. 探测请求：queryWithTotal 接口，pageNo=1/pageSize=1，查询最近 1 小时，
 *      成功即证明 token 有效；若平台返回 401/凭据失效，标记凭据过期并提示重新登录
 */
const { logger } = require('./logger');
const keepaliveConfig = require('./keepalive-config-store');
const secretsStore = require('./secrets-store');
const { buildRequestBody, queryOnce } = require('./clickhouse-client');

let timer = null;

function formatTime(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/**
 * 立即探测一次
 * @param {boolean} force 手动触发时传 true（忽略 enabled 开关，供「立即探测」按钮使用）
 */
async function probeNow(force = false) {
  const cfg = keepaliveConfig.getStatus();
  if (!cfg.enabled && !force) {
    logger.info('[keepalive] probe skipped: disabled');
    return { result: 'skipped', message: '探测开关未开启' };
  }
  const cred = secretsStore.getStatus();
  if (!cred.configured || cred.expired) {
    const message = '凭据未配置或已过期，无法探测';
    logger.warn(`[keepalive] probe skipped: ${message}`);
    keepaliveConfig.saveConfig({ lastRunAt: formatTime(), lastResult: 'error', lastMessage: message });
    return { result: 'error', message };
  }

  try {
    // 最小探测请求：最近 1 小时、单页 1 条，覆盖真实网关链路即可验证 token 有效性
    const requestBody = buildRequestBody({
      name: 'wallet_client_hmos',
      cluster: 'ulan1-aiops-ch-az1-4',
      beginTimestamp: Date.now() - 60 * 60 * 1000,
      endTimestamp: Date.now(),
      pageNo: 1,
      pageSize: 1
    });
    const res = await queryOnce(requestBody);
    keepaliveConfig.saveConfig({
      lastRunAt: formatTime(),
      lastResult: 'ok',
      lastMessage: `探测成功（total=${res.total || 0}）`
    });
    logger.info(`[keepalive] probe ok total=${res.total || 0}`);
    return { result: 'ok', message: `探测成功（total=${res.total || 0}）` };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const unauthorized = /401|unauthorized|凭据|登录|过期/i.test(msg);
    if (unauthorized) {
      secretsStore.markExpired('keepalive 探测发现 token 失效');
      keepaliveConfig.saveConfig({ lastRunAt: formatTime(), lastResult: 'unauthorized', lastMessage: 'token 已失效，需重新登录' });
      logger.error(`[keepalive] probe unauthorized: ${msg}`);
      return { result: 'unauthorized', message: 'token 已失效，需重新登录' };
    }
    keepaliveConfig.saveConfig({
      lastRunAt: formatTime(),
      lastResult: 'error',
      lastMessage: msg.slice(0, 200)
    });
    logger.error(`[keepalive] probe failed: ${msg}`);
    return { result: 'error', message: msg.slice(0, 200) };
  }
}

/** 启动后台定时探测（常驻定时器，每次 tick 检查开关；启动时立即探测一次） */
function start() {
  if (timer) return;
  const tick = async () => {
    try {
      const cfg = keepaliveConfig.getStatus();
      if (cfg.enabled) await probeNow();
    } catch (e) {
      logger.error('[keepalive] tick failed', e);
    }
  };
  tick();
  timer = setInterval(tick, keepaliveConfig.getStatus().intervalMinutes * 60 * 1000);
  logger.info(`[keepalive] background probe started, interval=${keepaliveConfig.getStatus().intervalMinutes}min`);
}

module.exports = { probeNow, start };
