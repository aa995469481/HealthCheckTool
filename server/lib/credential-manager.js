/**
 * 凭据管理器 - 登录固定网址，从响应头提取 cookie + x-csrf-token，保存到 secrets.yaml
 *
 * 流程：
 *   1. 请求 config.loginUrl（登录固定网址）
 *   2. 从响应头提取：
 *      - cookie：拼接所有 Set-Cookie 头（取 name=value 部分）
 *      - x-csrf-token：响应头 x-csrf-token（或按 config.csrfTokenBodyPath 从响应体取）
 *   3. 保存到 server/data/secrets.yaml
 *
 * 依赖：Node 18+ 内置 fetch，无第三方依赖
 */
const config = require('../config');
const { logger } = require('./logger');
const secretsStore = require('./secrets-store');

/** 从 Set-Cookie 头列表中提取 cookie 字符串 */
function extractCookieFromHeaders(setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length === 0) return '';
  const parts = [];
  for (const raw of setCookieHeaders) {
    // Set-Cookie: name=value; Path=/; HttpOnly ... -> 只取第一个分号前的 name=value
    const first = String(raw).split(';')[0].trim();
    if (first && !parts.includes(first)) parts.push(first);
  }
  return parts.join('; ');
}

/** 按点号路径从对象取值，如 'data.csrfToken' */
function pickByPath(obj, pathStr) {
  if (!pathStr) return '';
  return pathStr.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * 执行登录并提取凭据
 * @returns {{ cookie: string, xCsrfToken: string, responseStatus: number }}
 */
async function loginAndFetchCredentials() {
  if (!config.loginUrl) {
    throw new Error('登录网址未配置（server/config.js 的 loginUrl 为空），请先填入固定登录网址');
  }

  logger.info(`[credential] login start url=${config.loginUrl}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.loginTimeoutMs);
  let response;
  try {
    response = await fetch(config.loginUrl, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none'
      }
    });
  } catch (e) {
    clearTimeout(timer);
    logger.error('[credential] login request failed', e);
    throw new Error(`登录请求失败：${e.message}`);
  }
  clearTimeout(timer);

  // 提取 cookie（兼容 headers.getSetCookie() 与 headers.get() 两种 Node 版本）
  let setCookieHeaders = [];
  try {
    if (typeof response.headers.getSetCookie === 'function') {
      setCookieHeaders = response.headers.getSetCookie();
    } else {
      const raw = response.headers.get('set-cookie');
      if (raw) setCookieHeaders = raw.split(/,(?=\s*[^;]+=)/);
    }
  } catch (e) {
    logger.warn('[credential] parse set-cookie header failed', e.message);
  }

  const cookie = extractCookieFromHeaders(setCookieHeaders);
  let xCsrfToken = response.headers.get(config.csrfTokenHeaderName) || '';

  // 若响应头没有 csrf token，尝试从响应体取
  if (!xCsrfToken && config.csrfTokenBodyPath) {
    try {
      const body = await response.json();
      xCsrfToken = pickByPath(body, config.csrfTokenBodyPath) || '';
    } catch (e) {
      logger.warn('[credential] parse csrf from body failed', e.message);
    }
  }

  logger.info(
    `[credential] login done status=${response.status} cookieLen=${cookie.length} csrfLen=${xCsrfToken.length}`
  );

  if (!cookie || !xCsrfToken) {
    throw new Error(`凭据提取不完整：cookie=${cookie ? 'ok' : '空'} csrf=${xCsrfToken ? 'ok' : '空'}，请检查登录网址响应内容`);
  }

  return { cookie, xCsrfToken, responseStatus: response.status };
}

/** 登录并保存凭据 */
async function loginAndSave() {
  const cred = await loginAndFetchCredentials();
  secretsStore.saveSecrets({ cookie: cred.cookie, xCsrfToken: cred.xCsrfToken, source: 'wise-login' });
  return secretsStore.getStatus();
}

module.exports = { loginAndFetchCredentials, loginAndSave, extractCookieFromHeaders };
