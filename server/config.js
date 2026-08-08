/**
 * 全局配置 - 业务巡检系统
 * 说明：登录网址等环境相关配置集中在此，便于后续切换真实环境
 */
module.exports = {
  // Wise DevOps 登录网址（用于自动获取 cookie + x-csrf-token）
  // 说明：该网址需在能访问 Wise DevOps 的环境（公司电脑）下请求；
  //       响应头中应包含 Set-Cookie 与 x-csrf-token
  loginUrl: 'https://console-drcn.wisedevops.huawei.com/home',

  // 登录请求超时（毫秒）
  loginTimeoutMs: 30000,

  // 登录后需要从响应中提取凭据的配置
  // cookie 来源：响应头 Set-Cookie 字段（自动拼接）
  // x-csrf-token 来源：响应头 x-csrf-token 字段；若目标网站将 token 放在响应体，
  // 可在此配置响应体 JSON 的取值路径，如 'data.csrfToken'
  csrfTokenHeaderName: 'x-csrf-token',
  csrfTokenBodyPath: ''
};
