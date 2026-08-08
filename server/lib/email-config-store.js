/**
 * 邮件配置存储 - 持久化生成 .eml 时的主送/抄送/主题默认值（server/data/email-config.json）
 *
 * 设计（与用户确认，2026-08-08）：
 *   - 仅维护收件人/抄送/主题，生成邮件时预填、可修改、可重新保存
 *   - 不包含 SMTP 相关配置（无需实际发送）
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'email-config.json');

const DEFAULTS = { to: '', cc: '', subject: '' };

function load() {
  try {
    if (!fs.existsSync(FILE)) return { ...DEFAULTS };
    const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return { ...DEFAULTS, ...data };
  } catch (e) {
    logger.warn(`[email-config] load failed: ${e.message}`);
    return { ...DEFAULTS };
  }
}

function getConfig() {
  return load();
}

/** 保存配置；字段为空字符串时表示清除 */
function saveConfig(patch = {}) {
  const cur = load();
  const next = { ...cur };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined) next[key] = String(patch[key]).trim();
  }
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf-8');
  logger.info(`[email-config] save to=${next.to ? next.to.split(/[,;，；\s]+/).filter(Boolean).length : 0}收件人 cc=${next.cc ? '有' : '无'} subject=${next.subject ? next.subject.slice(0, 20) : '(空)'}`);
  return next;
}

module.exports = { getConfig, saveConfig, DEFAULTS };
