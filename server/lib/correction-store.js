/**
 * 人工矫正意见存储 - 用户在生成 AI 巡检日报前录入的矫正/建议，持久化到 server/data/ai-corrections.json
 *
 * 设计（与用户确认，2026-08-08）：
 *   - 意见针对整个巡检内容，全局生效（不按场景关联）
 *   - 生成日报时统一喂给「汇总调用」，让大模型在写日报时参考矫正，不重复出现在每个场景分析 prompt 中
 *   - 支持增删查；内容为自由文本，可含多行
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'ai-corrections.json');

function load() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    logger.warn(`[corrections] load failed: ${e.message}`);
    return [];
  }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf-8');
}

/** 全部矫正意见（按创建时间升序） */
function listCorrections() {
  return load().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/** 新增一条矫正意见，返回保存后的条目 */
function addCorrection(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('矫正内容不能为空');
  const list = load();
  const item = {
    id: crypto.randomBytes(8).toString('hex'),
    content: text,
    createdAt: new Date().toISOString()
  };
  list.push(item);
  save(list);
  logger.info(`[corrections] add id=${item.id} len=${item.content.length} total=${list.length}`);
  return item;
}

/** 删除一条矫正意见，返回是否删除成功 */
function deleteCorrection(id) {
  const list = load();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  save(next);
  logger.info(`[corrections] delete id=${id} total=${next.length}`);
  return true;
}

/**
 * 生成喂给大模型的矫正意见文本（空则返回 ''）
 * 每条截断到 500 字符、最多取 10 条，避免挤占 prompt 预算
 */
function correctionsText() {
  const list = load();
  if (!list.length) return '';
  return list
    .slice(0, 10)
    .map((c, i) => `${i + 1}. ${String(c.content || '').slice(0, 500)}`)
    .join('\n');
}

module.exports = { listCorrections, addCorrection, deleteCorrection, correctionsText };
