/**
 * AI 大模型配置持久化 - server/data/ai-config.json
 *
 * 字段：
 *   endpoint      API 地址（含 /chat/completions）
 *   token         Bearer Token（页面可修改；读取时不回传明文，仅返回 hasToken）
 *   model         模型名称
 *   temperature   采样温度（默认 0.2）
 *   maxCharsPerPrompt 每次调用输入最大字符数（默认 12000，超出裁剪）
 *   reportRules    关键问题判定规则（趋势天数/用户数阈值/增幅阈值/待确认优先/高危标记）
 *   reportTemplate 结构化提示词模板（关注点/格式要求/附加指令）
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'ai-config.json');

const DEFAULT_CONFIG = {
  endpoint: 'https://console-mlops.hwcloudtest.cn/v1/chat/completions',
  token: '',
  model: 'DeepSeek_V4_Flash_Client',
  temperature: 0.2,
  maxCharsPerPrompt: 12000,
  timeoutMs: 240000,
  maxTokens: 2000,
  maxConcurrentScenes: 2,
  reportRules: {
    trendDays: 7,
    userCountThreshold: 50,
    increasePercent: 50,
    highRiskNew: true,
    pendingFirst: true,
    maxProblems: 15
  },
  reportTemplate: {
    focus: '',
    format: '',
    extra: ''
  }
};

function ensureFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    logger.info('[ai-config] initialized default config');
  }
}

/** 读取完整配置（含 token，仅内部使用） */
function getConfig() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    logger.error('[ai-config] read failed, use default', e);
    return { ...DEFAULT_CONFIG };
  }
}

/** 读取对外安全配置（token 不返回明文） */
function getSafeStatus() {
  const cfg = getConfig();
  return {
    endpoint: cfg.endpoint,
    model: cfg.model,
    temperature: cfg.temperature,
    maxCharsPerPrompt: cfg.maxCharsPerPrompt,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    maxConcurrentScenes: cfg.maxConcurrentScenes,
    reportRules: { ...DEFAULT_CONFIG.reportRules, ...(cfg.reportRules || {}) },
    reportTemplate: { ...DEFAULT_CONFIG.reportTemplate, ...(cfg.reportTemplate || {}) },
    hasToken: Boolean(cfg.token && cfg.token.trim())
  };
}

/** 保存配置（token 为空时保留原值；reportRules / reportTemplate 深层合并） */
function saveConfig(partial) {
  const cfg = getConfig();
  const next = { ...cfg, ...partial };
  if (partial && partial.reportRules && typeof partial.reportRules === 'object') {
    next.reportRules = { ...DEFAULT_CONFIG.reportRules, ...(cfg.reportRules || {}), ...partial.reportRules };
  }
  if (partial && partial.reportTemplate && typeof partial.reportTemplate === 'object') {
    next.reportTemplate = { ...DEFAULT_CONFIG.reportTemplate, ...(cfg.reportTemplate || {}), ...partial.reportTemplate };
  }
  // token 留空不清空（页面编辑场景）；显式传 __clearToken 才清空
  if (partial && partial.__clearToken) {
    next.token = '';
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
  logger.info(`[ai-config] saved endpoint=${next.endpoint} model=${next.model} hasToken=${Boolean(next.token)}`);
  return getSafeStatus();
}

module.exports = { getConfig, getSafeStatus, saveConfig };
