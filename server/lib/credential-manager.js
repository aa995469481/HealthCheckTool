/**
 * 凭据管理器 - 拉起系统浏览器完成 Wise DevOps 手动登录（SSO + 短信验证码），
 * 登录成功后自动提取 cookie + x-csrf-token，保存到 secrets.yaml
 *
 * 流程：
 *   1. puppeteer-core 拉起系统 Chrome/Edge（可见窗口）
 *   2. 打开 config.loginUrl，用户手动完成登录（输手机号、短信验证码）
 *   3. 轮询检测登录成功标志 cookie 出现
 *   4. 登录成功后监听页面请求，捕获 x-csrf-token 请求头
 *   5. 收集浏览器全部 cookie，保存到 server/data/secrets.yaml
 *
 * 依赖：puppeteer-core（复用系统浏览器，不下载 Chromium）
 */
const config = require('../config');
const { logger } = require('./logger');
const secretsStore = require('./secrets-store');

let puppeteer = null;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  logger.warn('[credential] puppeteer-core not installed yet');
}

/** 从 cookie 对象数组拼接 cookie 字符串（name=value; ...） */
function cookieToString(cookies) {
  const parts = [];
  for (const c of cookies || []) {
    if (c.name && c.value && !parts.includes(`${c.name}=${c.value}`)) {
      parts.push(`${c.name}=${c.value}`);
    }
  }
  return parts.join('; ');
}

/**
 * 执行浏览器手动登录并提取凭据
 * @returns {{ cookie: string, xCsrfToken: string }}
 */
async function loginAndFetchCredentials() {
  if (!config.loginUrl) {
    throw new Error('登录网址未配置（server/config.js 的 loginUrl 为空）');
  }
  if (!puppeteer) {
    throw new Error('puppeteer-core 未安装，请先执行 npm install（start.bat 会自动处理）');
  }
  if (!config.browser.executablePath) {
    throw new Error('未检测到 Chrome/Edge，请在 server/config.js 的 browser.executablePath 手动指定浏览器路径');
  }

  logger.info(`[credential] browser login start url=${config.loginUrl} browser=${config.browser.executablePath}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: config.browser.executablePath,
      headless: config.browser.headless,
      defaultViewport: null,
      args: ['--start-maximized', '--disable-infobars']
    });
  } catch (e) {
    logger.error('[credential] launch browser failed', e);
    throw new Error(`拉起浏览器失败：${e.message}`);
  }

  const page = await browser.newPage();
  let csrfToken = '';

  // 监听页面所有请求，捕获 x-csrf-token 请求头
  const csrfListener = (req) => {
    try {
      const h = req.headers()[config.csrfTokenHeaderName];
      if (h && !csrfToken) {
        csrfToken = h;
        logger.info('[credential] captured x-csrf-token from page request');
      }
    } catch (e) {
      /* ignore */
    }
  };
  page.on('request', csrfListener);

  try {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    logger.warn(`[credential] goto ${config.loginUrl} warn`, e.message);
  }

  logger.info('[credential] browser opened, waiting for manual login (phone + SMS code)...');

  // 轮询等待登录成功标志 cookie
  const deadline = Date.now() + config.loginTimeoutMs;
  let loggedIn = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let cookies = [];
    try {
      cookies = await page.cookies();
    } catch (e) {
      // 页面可能已关闭
      logger.warn('[credential] read cookies failed', e.message);
      break;
    }
    const names = cookies.map((c) => c.name);
    const hit = config.loginSuccessCookieNames.filter((n) => {
      const c = cookies.find((x) => x.name === n);
      return c && c.value;
    });
    if (hit.length > 0) {
      logger.info(`[credential] login detected by cookies: ${hit.join(',')}`);
      loggedIn = true;
      break;
    }
    // 页面被用户关闭则放弃
    if (page.isClosed()) break;
  }

  if (!loggedIn) {
    await browser.close().catch(() => {});
    throw new Error(`登录超时（${Math.round(config.loginTimeoutMs / 60000)} 分钟内未检测到登录成功），请重试`);
  }

  // 停留片刻，等待页面加载完成后的请求带出 x-csrf-token
  if (!csrfToken) {
    logger.info(`[credential] waiting ${config.browser.settleMs}ms for csrf token...`);
    await new Promise((r) => setTimeout(r, config.browser.settleMs));
  }

  // 仍未捕获到 csrf：刷新页面强制触发一轮新请求（通常携带 x-csrf-token）
  if (!csrfToken && !page.isClosed()) {
    logger.info('[credential] csrf not captured, reloading page to trigger requests...');
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((r) => setTimeout(r, config.browser.settleMs));
    } catch (e) {
      logger.warn('[credential] reload page failed', e.message);
    }
  }

  // 收集全部 cookie
  let cookies = [];
  try {
    cookies = await page.cookies();
  } catch (e) {
    logger.warn('[credential] collect cookies failed', e.message);
  }
  const cookie = cookieToString(cookies);

  await browser.close().catch(() => {});
  page.removeListener('request', csrfListener);

  logger.info(
    `[credential] login done cookieLen=${cookie.length} cookieCount=${cookies.length} csrfLen=${csrfToken.length}`
  );

  if (!cookie || !csrfToken) {
    throw new Error(`凭据提取不完整：cookie=${cookie ? 'ok' : '空'} csrf=${csrfToken ? 'ok' : '空'}，请检查登录是否成功`);
  }

  return { cookie, xCsrfToken: csrfToken };
}

/** 登录并保存凭据 */
async function loginAndSave() {
  const cred = await loginAndFetchCredentials();
  secretsStore.saveSecrets({ cookie: cred.cookie, xCsrfToken: cred.xCsrfToken, source: 'wise-login' });
  return secretsStore.getStatus();
}

module.exports = { loginAndFetchCredentials, loginAndSave, cookieToString };
