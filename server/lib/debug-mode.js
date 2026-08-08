/**
 * 详细日志模式开关 - 控制是否输出完整 CURL 命令 / 请求体 / 响应体等大段日志
 *
 * 存储位置：server/data/debug-mode.json
 * 格式：
 *   { "enabled": false, "updatedAt": "2026-08-08 12:00:00" }
 *
 * 默认关闭：只输出摘要日志（分页进度、场景完成等），避免日志文件过大
 * 打开后：额外输出完整请求体、响应体、curl 命令，便于问题定位
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MODE_FILE = path.join(DATA_DIR, 'debug-mode.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function formatTime(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 当前是否开启详细日志模式（默认 false） */
function getDebugEnabled() {
  ensureDir();
  if (!fs.existsSync(MODE_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(MODE_FILE, 'utf-8'));
    return data.enabled === true;
  } catch (e) {
    logger.error('[debug-mode] read failed', e);
    return false;
  }
}

/** 设置详细日志模式，持久化到文件 */
function setDebugEnabled(enabled) {
  ensureDir();
  const data = { enabled: Boolean(enabled), updatedAt: formatTime() };
  try {
    fs.writeFileSync(MODE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    logger.info(`[debug-mode] set -> enabled=${Boolean(enabled)}`);
  } catch (e) {
    logger.error('[debug-mode] write failed', e);
    throw e;
  }
  return data;
}

/** 查询状态（含更新时间） */
function getStatus() {
  ensureDir();
  if (!fs.existsSync(MODE_FILE)) return { enabled: false, updatedAt: '' };
  try {
    const data = JSON.parse(fs.readFileSync(MODE_FILE, 'utf-8'));
    return { enabled: data.enabled === true, updatedAt: data.updatedAt || '' };
  } catch (e) {
    return { enabled: false, updatedAt: '' };
  }
}

module.exports = { getDebugEnabled, setDebugEnabled, getStatus, MODE_FILE };
