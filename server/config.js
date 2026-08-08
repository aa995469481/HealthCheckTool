/**
 * 全局配置 - 业务巡检系统
 * 说明：登录网址、浏览器路径等环境相关配置集中在此，便于后续切换真实环境
 */
const fs = require('fs');
const path = require('path');

/** 常见 Chrome / Edge 安装路径（Windows） */
const CHROME_PATHS = [
  process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe'
];

/** 探测系统可用的浏览器可执行文件路径 */
function findBrowser() {
  for (const p of CHROME_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

module.exports = {
  // Wise DevOps 登录网址（手动登录页面，登录成功后自动提取凭据）
  loginUrl: 'https://console-drcn.wisedevops.huawei.com/home',

  // 手动登录总超时（毫秒）：等待用户在浏览器中完成 SSO 登录 + 短信验证码
  // 注意：需小于 index.js 中 server.requestTimeout（已设为 6 分钟）
  loginTimeoutMs: 4 * 60 * 1000, // 4 分钟

  // 单次 ClickHouse 查询超时（毫秒）：真实查询大范围数据可能较慢
  // 注意：需小于 index.js 中 server.requestTimeout（已设为 10 分钟）
  queryTimeoutMs: 5 * 60 * 1000, // 5 分钟

  // 判定登录成功的标志 cookie 名称（出现且非空即视为登录成功）
  loginSuccessCookieNames: [
    'x-console-user-at',
    'x-wisecloud-user-at',
    'prod_J_SESSION_ID'
  ],

  // 浏览器配置（puppeteer-core）
  browser: {
    // 留空则自动探测 Chrome/Edge；也可手动指定完整路径
    executablePath: findBrowser(),
    headless: false, // 可见窗口，需要人工输验证码
    // 登录成功后停留时间（毫秒），等待前端请求带出 x-csrf-token
    settleMs: 5000
  },

  // 登录后需要从响应中提取凭据的配置
  // cookie 来源：浏览器 cookie 自动拼接
  // x-csrf-token 来源：登录成功后监听页面请求的请求头 x-csrf-token
  csrfTokenHeaderName: 'x-csrf-token'
};
