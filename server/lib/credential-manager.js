/**
 * 凭据管理器 - 登录固定网址，从响应头提取 cookie + x-csrf-token，保存到 secrets.yaml
 *
 * 流程：
 *   1. 请求 config.loginUrl（登录固定网址）
 *   2. 手动跟随所有重定向（SSO/IAM 跳转链），每一跳都收集 Set-Cookie，
 *      并把已收集的 cookie 传给下一跳（模拟浏览器行为）
 *   3. 从响应头提取 x-csrf-token（或按 config.csrfTokenBodyPath 从最终响应体取）
 *   4. 保存到 server/data/secrets.yaml
 *
 * 说明：不使用全局 fetch —— redirect:'follow' 会丢弃中间跳转的 Set-Cookie，
 *       redirect:'manual' 又返回无头的 opaqueredirect，因此用原生 https 模块手动跟随。
 */
const https = require('https');
const http = require('http');
const config = require('../config');
const { logger } = require('./logger');
const secretsStore = require('./secrets-store');

/** 浏览器模拟请求头 */
function browserHeaders(cookie) {
  const h = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none'
  };
  if (cookie) h['cookie'] = cookie;
  return h;
}

/**
 * 原生 HTTP GET（返回完整响应头，支持超时与响应体大小限制）
 */
function httpGet(urlStr, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      const lib = urlStr.startsWith('https:') ? https : http;
      req = lib.get(urlStr, { headers, timeout: timeoutMs }, (res) => {
        let body = '';
        let tooLarge = false;
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 512 * 1024) {
            tooLarge = true;
            req.destroy();
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: tooLarge ? '' : body }));
      });
    } catch (e) {
      return reject(e);
    }
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (e) => reject(e));
  });
}

/** 从 Set-Cookie 头列表中提取 cookie 字符串（Node 的 headers['set-cookie'] 是数组） */
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

  const maxRedirects = 10;
  let url = config.loginUrl;
  const cookieJar = []; // 已收集的 name=value 列表
  let csrfToken = '';
  let finalStatus = 0;
  const hops = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const cookie = cookieJar.join('; ');
    let res;
    try {
      res = await httpGet(url, browserHeaders(cookie), config.loginTimeoutMs);
    } catch (e) {
      logger.error(`[credential] request failed hop=${hop} url=${url}`, e);
      throw new Error(`登录请求失败（第 ${hop} 跳）：${e.message}`);
    }

    // 收集本跳 Set-Cookie
    const setCookies = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [];
    for (const raw of setCookies) {
      const pair = String(raw).split(';')[0].trim();
      if (pair && !cookieJar.includes(pair)) cookieJar.push(pair);
    }

    // 收集本跳 x-csrf-token（任一跳出现即用）
    if (!csrfToken) {
      csrfToken = res.headers[config.csrfTokenHeaderName] || '';
    }

    hops.push({ hop, status: res.status, url, setCookies: setCookies.length });
    logger.info(
      `[credential] hop=${hop} status=${res.status} setCookies=${setCookies.length} cookieTotal=${cookieJar.length} url=${url}`
    );

    // 处理重定向
    const loc = res.headers['location'];
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      logger.info(`[credential] redirect ${res.status} -> ${url}`);
      continue;
    }

    // 最终响应
    finalStatus = res.status;
    if (!csrfToken && config.csrfTokenBodyPath) {
      try {
        csrfToken = pickByPath(JSON.parse(res.body || '{}'), config.csrfTokenBodyPath) || '';
      } catch (e) {
        logger.warn('[credential] parse csrf from body failed', e.message);
      }
    }
    break;
  }

  const cookie = cookieJar.join('; ');
  logger.info(
    `[credential] login done finalStatus=${finalStatus} hops=${hops.length} cookieLen=${cookie.length} csrfLen=${csrfToken.length}`
  );
  logger.info(`[credential] cookie names: ${cookieJar.map((c) => c.split('=')[0]).join(',') || '(none)'}`);

  if (!cookie || !csrfToken) {
    throw new Error(`凭据提取不完整：cookie=${cookie ? 'ok' : '空'} csrf=${csrfToken ? 'ok' : '空'}，请查看日志中 [credential] hop 记录了解跳转过程`);
  }

  return { cookie, xCsrfToken: csrfToken, responseStatus: finalStatus };
}

/** 登录并保存凭据 */
async function loginAndSave() {
  const cred = await loginAndFetchCredentials();
  secretsStore.saveSecrets({ cookie: cred.cookie, xCsrfToken: cred.xCsrfToken, source: 'wise-login' });
  return secretsStore.getStatus();
}

module.exports = { loginAndFetchCredentials, loginAndSave, extractCookieFromHeaders };
