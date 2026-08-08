/**
 * .eml 邮件文件生成器 - 将巡检日报 HTML 内嵌为邮件正文，生成可发送的 .eml 文件
 *
 * 设计（与用户确认，2026-08-08）：
 *   - 不实际发送邮件（无需 SMTP），仅生成标准 .eml 文件，用户可用 Outlook/Foxmail 等打开后发送
 *   - 正文为富文本 HTML（直接内嵌日报页面）
 *   - 维护主送(To)、抄送(Cc)、主题(Subject)：由 email-config-store 持久化记忆，生成时可修改
 *   - 中文主题按 RFC 2047 做 base64 编码；换行统一 CRLF
 */

/** RFC 2047 编码：=?UTF-8?B?<base64>?= */
function encodeRFC2047(text) {
  return `=?UTF-8?B?${Buffer.from(String(text), 'utf-8').toString('base64')}?=`;
}

/** base64 按 76 字符换行（MIME 规范） */
function wrapBase64(b64) {
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join('\r\n');
}

/**
 * 构建 .eml 文件内容
 * @param {object} opts { to, cc?, subject, html, from?, fromName?, includeUnsent? }
 * @returns {string} eml 内容（CRLF 换行）
 *
 * 说明：
 *   - X-Unsent: 1（RFC 4155）：标识这是一封「未发送」的邮件，
 *     Outlook / Windows 邮件等客户端双击打开时会以「待发送」模式显示（出现发送按钮），
 *     而不是当作已保存的完整邮件只读预览
 *   - From 默认 no-reply@localhost；fromName 为空时不在 From 中显示名称
 */
function buildEml({ to, cc, subject, html, from = 'no-reply@localhost', fromName = '', includeUnsent = true }) {
  const fromHeader = fromName && String(fromName).trim()
    ? `From: ${encodeRFC2047(String(fromName).trim())} <${String(from)}>`
    : `From: ${String(from)}`;
  const headers = [
    fromHeader,
    `To: ${String(to || '').trim()}`,
    cc && String(cc).trim() ? `Cc: ${String(cc).trim()}` : '',
    `Subject: ${encodeRFC2047(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    includeUnsent ? 'X-Unsent: 1' : '',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    ''
  ].filter((l) => l !== '').join('\r\n') + '\r\n';

  const bodyB64 = Buffer.from(String(html || ''), 'utf-8').toString('base64');
  return headers + '\r\n' + wrapBase64(bodyB64) + '\r\n';
}

/** 从邮箱列表字符串解析为数组（逗号/分号/空格分隔，去空） */
function parseAddresses(text) {
  return String(text || '')
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

module.exports = { buildEml, encodeRFC2047, parseAddresses };
