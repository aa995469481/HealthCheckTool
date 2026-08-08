/**
 * 统一日志模块 - 输出到 log 文件（按天滚动）
 *
 * 用法：
 *   const { logger, requestLogger } = require('../lib/logger');
 *   logger.info('msg');
 *   logger.warn('msg');
 *   logger.error('msg', err);
 *
 * 配置（环境变量）：
 *   LOG_DIR    日志目录，默认 server/logs
 *   LOG_LEVEL  日志级别 debug|info|warn|error，默认 info
 *
 * 特性：
 *   - 按天滚动：app-YYYY-MM-DD.log
 *   - 自动清理 7 天前的日志文件
 *   - 对象 / Error 自动序列化，单行记录
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[LOG_LEVEL] !== undefined ? LEVELS[LOG_LEVEL] : LEVELS.info;

function pad(n) {
  return String(n).padStart(2, '0');
}

function nowStr() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

function todayFileName() {
  const d = new Date();
  return `app-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;
}

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  }
  return String(a);
}

function write(level, args) {
  if ((LEVELS[level] || 20) < THRESHOLD) return;
  const line = args.map(formatArg).join(' ');
  const entry = `[${nowStr()}] [${level.toUpperCase()}] ${line}\n`;
  try {
    ensureDir();
    fs.appendFileSync(path.join(LOG_DIR, todayFileName()), entry, 'utf-8');
  } catch (e) {
    // 文件写入失败时兜底到控制台，避免丢失信息
    console.error(`[logger:${level}] ${line}`);
    console.error('[logger] write failed:', e.message);
  }
}

/** 清理 N 天前的日志文件 */
function cleanOldLogs(days = 7) {
  try {
    ensureDir();
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.log')) continue;
      const p = path.join(LOG_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (e) { /* 单个文件清理失败忽略 */ }
    }
  } catch (e) { /* 目录不存在等忽略 */ }
}

const logger = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
  logDir: LOG_DIR,
  currentLogFile: () => path.join(LOG_DIR, todayFileName())
};

/** Express 请求日志中间件：记录方法、路径、状态码、耗时、来源 IP */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
    logger.info(`[REQ] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms}ms (ip: ${ip})`);
  });
  next();
}

cleanOldLogs();

module.exports = { logger, requestLogger };
