/**
 * 巡检失败场景库存储 - 按「场景 + 内码 + 外码」维护案例分析，持久化到 server/data/failure-library.json
 *
 * 设计（与用户确认，2026-08-08）：
 *   - 每条案例 = 场景 + 内码(inCode) + 外码(extCode) + 案例分析文本（根因/影响/处置建议）
 *   - 统计：执行巡检后自动统计该组合在本次巡检中的命中条数，记录 latestHitCount（不手动维护）
 *   - 录入：手动新增/编辑 + 从聚类摘要维度 Top 分组一键导入
 *   - 供 AI 日报生成：aiReferenceText() 生成人工案例分析参考文本，喂给汇总调用
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

const FILE = path.join(__dirname, '..', 'data', 'failure-library.json');

function load() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    logger.warn(`[failure-library] load failed: ${e.message}`);
    return [];
  }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf-8');
}

/** 从场景的聚类字段里解析内码/外码字段名（默认 walletEventInCode / walletEventExtCode） */
function resolveCodeFields(scene) {
  const clusterFields = Array.isArray(scene && scene.clusterFields)
    ? scene.clusterFields.map(String)
    : ['walletEventInCode', 'walletEventExtCode'];
  let inCodeField = 'walletEventInCode';
  let extCodeField = 'walletEventExtCode';
  for (const f of clusterFields) {
    if (/incode/i.test(f)) inCodeField = f;
    else if (/extcode/i.test(f)) extCodeField = f;
  }
  return { inCodeField, extCodeField };
}

function fieldValue(record, field) {
  if (!record) return '';
  const v = record[field];
  return v === null || v === undefined ? '' : String(v);
}

/** 全部案例（按更新时间倒序） */
function list() {
  return load().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/** 新增案例 */
function add({ sceneId, sceneTitle, inCode, extCode, analysis }) {
  const list = load();
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomBytes(8).toString('hex'),
    sceneId: String(sceneId || ''),
    sceneTitle: String(sceneTitle || '').trim(),
    inCode: String(inCode || '').trim(),
    extCode: String(extCode || '').trim(),
    analysis: String(analysis || '').trim(),
    latestHitCount: 0,
    lastCheckedAt: '',
    createdAt: now,
    updatedAt: now
  };
  if (!item.sceneTitle) throw new Error('请选择场景');
  if (!item.inCode && !item.extCode) throw new Error('内码和外码至少填写一个');
  list.push(item);
  save(list);
  logger.info(`[failure-library] add id=${item.id} scene=${item.sceneTitle} in=${item.inCode || '-'} ext=${item.extCode || '-'}`);
  return item;
}

/** 更新案例 */
function update(id, patch = {}) {
  const list = load();
  const item = list.find((c) => c.id === id);
  if (!item) return null;
  if (patch.sceneTitle !== undefined) item.sceneTitle = String(patch.sceneTitle).trim();
  if (patch.sceneId !== undefined) item.sceneId = String(patch.sceneId);
  if (patch.inCode !== undefined) item.inCode = String(patch.inCode).trim();
  if (patch.extCode !== undefined) item.extCode = String(patch.extCode).trim();
  if (patch.analysis !== undefined) item.analysis = String(patch.analysis).trim();
  item.updatedAt = new Date().toISOString();
  save(list);
  logger.info(`[failure-library] update id=${id}`);
  return item;
}

/** 删除案例 */
function remove(id) {
  const list = load();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  save(next);
  logger.info(`[failure-library] remove id=${id}`);
  return true;
}

/** 清空全部案例，返回删除条数 */
function clearAll() {
  const list = load();
  const count = list.length;
  if (count === 0) return 0;
  save([]);
  logger.info(`[failure-library] clear all -> ${count}`);
  return count;
}

/**
 * 执行巡检后自动更新命中数：统计该场景本次巡检记录中 (内码, 外码) 组合的命中条数，
 * 更新库中同一场景条目的 latestHitCount / lastCheckedAt（组合缺失一端时按单字段统计）
 * @returns {number} 更新条数
 */
function updateHitCounts(scene, records) {
  if (!scene || !Array.isArray(records)) return 0;
  const { inCodeField, extCodeField } = resolveCodeFields(scene);
  const comboMap = new Map();
  const inMap = new Map();
  const extMap = new Map();
  for (const r of records) {
    const inV = fieldValue(r, inCodeField);
    const exV = fieldValue(r, extCodeField);
    comboMap.set(`${inV}\u0000${exV}`, (comboMap.get(`${inV}\u0000${exV}`) || 0) + 1);
    inMap.set(inV, (inMap.get(inV) || 0) + 1);
    extMap.set(exV, (extMap.get(exV) || 0) + 1);
  }

  const list = load();
  let updated = 0;
  for (const c of list) {
    if (c.sceneId !== scene.id) continue;
    let count = 0;
    if (c.inCode && c.extCode) {
      count = comboMap.get(`${c.inCode}\u0000${c.extCode}`) || 0;
    } else if (c.inCode) {
      count = inMap.get(c.inCode) || 0;
    } else if (c.extCode) {
      count = extMap.get(c.extCode) || 0;
    }
    if (c.latestHitCount !== count) c.latestHitCount = count;
    c.lastCheckedAt = new Date().toISOString();
    updated++;
  }
  if (updated > 0) {
    save(list);
    logger.info(`[failure-library] hit counts updated scene=${scene.id} updated=${updated}`);
  }
  return updated;
}

/**
 * 统计该场景本次巡检记录中「内码+外码」组合的命中数（精确统计，按命中数降序）
 * 供 export-json 写入聚类摘要（combos），用于一键导入时带出完整组合
 * @returns {Array<{ inCode: string, extCode: string, count: number }>}
 */
function countCombos(scene, records) {
  if (!scene || !Array.isArray(records)) return [];
  const { inCodeField, extCodeField } = resolveCodeFields(scene);
  const comboMap = new Map();
  for (const r of records) {
    const inV = fieldValue(r, inCodeField);
    const exV = fieldValue(r, extCodeField);
    const key = `${inV}\u0000${exV}`;
    comboMap.set(key, (comboMap.get(key) || 0) + 1);
  }
  return [...comboMap.entries()]
    .map(([key, count]) => {
      const [inCode, extCode] = key.split('\u0000');
      return { inCode, extCode, count };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * 从聚类摘要一键导入：优先按「内码+外码」组合生成条目（分析为空，待编辑）
 *   - 组合数据来自执行巡检时写入的 combos（精确命中数）
 *   - 有内码维度时：对内码维度 Top 分组，每个内码值选命中数最高的组合导入（外码一并带出）
 *   - 仅外码维度时：对外码维度 Top 分组，每个外码值选命中数最高的组合导入
 *   - combos 缺失（旧数据）时回退为仅按维度值导入
 * 已存在同 场景+内码+外码 的条目则跳过
 * @param {Array} summaries 聚类摘要数组（latest.json 的 summaries）
 * @param {Array} scenes 场景列表（用于按标题匹配 sceneId）
 * @param {Object} combosByScene 场景标题 -> 组合数组（countCombos 结果）
 * @returns {{ added: number, skipped: number }}
 */
function importFromSummaries(summaries, scenes, combosByScene = {}) {
  const sceneMap = new Map((scenes || []).map((s) => [s.title, s]));
  const list = load();
  let added = 0;
  let skipped = 0;
  const exists = (sceneId, inCode, extCode) =>
    list.some((c) => {
      if (c.sceneId !== sceneId) return false;
      // 导入维度条目不携带另一端码时，按同码值宽松匹配（避免与组合条目重复）
      if (inCode && extCode) return (c.inCode || '') === inCode && (c.extCode || '') === extCode;
      if (inCode) return (c.inCode || '') === inCode;
      if (extCode) return (c.extCode || '') === extCode;
      return false;
    });

  function pushEntry(sceneId, sceneTitle, inCode, extCode, hitCount) {
    const now = new Date().toISOString();
    list.push({
      id: crypto.randomBytes(8).toString('hex'),
      sceneId,
      sceneTitle,
      inCode,
      extCode,
      analysis: '',
      latestHitCount: hitCount || 0,
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now
    });
    added++;
  }

  for (const summary of summaries || []) {
    const sceneTitle = summary.scenarioTitle || '';
    const scene = sceneMap.get(sceneTitle);
    const sceneId = scene ? scene.id : '';
    const dims = summary.dimensions || [];
    const inDim = dims.find((d) => /incode/i.test(d.field));
    const exDim = dims.find((d) => /extcode/i.test(d.field));
    const combos = Array.isArray(combosByScene[sceneTitle]) ? combosByScene[sceneTitle] : [];

    if (combos.length) {
      // 组合导入：按内码 Top 分组（无内码维度则按外码 Top 分组）选命中数最高的组合
      const codeGroups = (inDim && inDim.groups) || (exDim && exDim.groups) || [];
      for (const g of codeGroups) {
        const codeValue = String(g.key === '(空)' ? '' : g.key);
        if (!codeValue) continue;
        const best = inDim
          ? combos.find((c) => c.inCode === codeValue)
          : combos.find((c) => c.extCode === codeValue);
        if (!best) continue;
        if (exists(sceneId, best.inCode, best.extCode)) {
          skipped++;
          continue;
        }
        pushEntry(sceneId, sceneTitle, best.inCode, best.extCode, best.count);
      }
      continue;
    }

    // 回退：combos 缺失（旧摘要）时按维度值导入
    for (const dim of dims) {
      const isInCode = /incode/i.test(dim.field);
      const isExtCode = /extcode/i.test(dim.field);
      if (!isInCode && !isExtCode) continue;
      for (const g of (dim.groups || [])) {
        const inCode = isInCode ? String(g.key === '(空)' ? '' : g.key) : '';
        const extCode = isExtCode ? String(g.key === '(空)' ? '' : g.key) : '';
        if (!inCode && !extCode) continue;
        if (exists(sceneId, inCode, extCode)) {
          skipped++;
          continue;
        }
        pushEntry(sceneId, sceneTitle, inCode, extCode, g.count || 0);
      }
    }
  }
  if (added > 0) save(list);
  logger.info(`[failure-library] import added=${added} skipped=${skipped} scenes=${summaries.length}`);
  return { added, skipped };
}

/**
 * 生成喂给大模型的案例分析参考文本（空则返回 ''）
 * 仅取已有分析文本的条目，最多 20 条，每条分析截断 500 字符
 */
function aiReferenceText() {
  const list = load().filter((c) => c.analysis && String(c.analysis).trim());
  if (!list.length) return '';
  const lines = list.slice(0, 20).map((c, i) => {
    const scene = c.sceneTitle || '未命名场景';
    const code = `${c.inCode || '-'}${c.extCode ? ' / ' + c.extCode : ''}`;
    const hit = c.latestHitCount > 0 ? `（最近巡检命中 ${c.latestHitCount} 条）` : '';
    return `${i + 1}. [${scene}] 内码+外码=${code}${hit}：${String(c.analysis).slice(0, 500)}`;
  });
  return lines.join('\n');
}

module.exports = { list, add, update, remove, clearAll, updateHitCounts, countCombos, importFromSummaries, aiReferenceText, resolveCodeFields };
