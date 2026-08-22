/**
 * Keep Alive 存活探测配置持久化 - server/data/keepalive.json
 *
 * 字段：
 *   enabled          探测开关（默认 false）
 *   intervalMinutes  探测间隔分钟（默认 20）
 *   lastRunAt        上次探测时间（YYYY-MM-DD HH:mm:ss）
 *   lastResult       上次探测结果（ok | unauthorized | error | skipped）
 *   lastMessage      上次探测结果说明
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'keepalive.json');

const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: 20,
  lastRunAt: '',
  lastResult: '',
  lastMessage: ''
};

function ensureFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    logger.info('[keepalive-config] initialized default config');
  }
}

/** 读取配置 */
function getStatus() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    logger.error('[keepalive-config] read failed, use default', e);
    return { ...DEFAULT_CONFIG };
  }
}

/** 保存配置（intervalMinutes 非法时保留默认 20） */
function saveConfig(partial) {
  const cfg = getStatus();
  const next = { ...cfg, ...partial };
  if (!Number.isFinite(Number(next.intervalMinutes)) || Number(next.intervalMinutes) <= 0) {
    next.intervalMinutes = DEFAULT_CONFIG.intervalMinutes;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
  logger.info(`[keepalive-config] saved enabled=${next.enabled} intervalMinutes=${next.intervalMinutes}`);
  return getStatus();
}

module.exports = { getStatus, saveConfig };
