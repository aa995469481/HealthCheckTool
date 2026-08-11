/**
 * 巡检场景存储模块
 * 存储位置：server/data/inspection-scenes.json
 * 结构：{ scenes: [ { id, title, table, cluster, queryString, granularity, dataSourceServiceId, focusFields, filterCondition, createdAt } ] }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SCENES_FILE = path.join(DATA_DIR, 'inspection-scenes.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 读取全部场景 */
function listScenes() {
  ensureDir();
  if (!fs.existsSync(SCENES_FILE)) return [];
  try {
    const json = JSON.parse(fs.readFileSync(SCENES_FILE, 'utf-8'));
    return Array.isArray(json.scenes) ? json.scenes : [];
  } catch (e) {
    logger.error('[scenes] read failed', e);
    return [];
  }
}

function writeScenes(scenes) {
  ensureDir();
  try {
    fs.writeFileSync(SCENES_FILE, JSON.stringify({ scenes }, null, 2), 'utf-8');
    logger.info(`[scenes] written count=${scenes.length}`);
  } catch (e) {
    logger.error('[scenes] write failed', e);
    throw e;
  }
}

function formatTime(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 保存场景（无 id 则新建，有 id 则更新） */
function saveScene(scene) {
  const scenes = listScenes();
  let target;
  if (scene.id) {
    target = scenes.find((s) => s.id === scene.id);
    if (!target) {
      throw new Error(`场景不存在：${scene.id}`);
    }
    Object.assign(target, scene);
  } else {
    target = {
      ...scene,
      id: crypto.randomBytes(8).toString('hex'),
      createdAt: formatTime()
    };
    scenes.push(target);
  }
  writeScenes(scenes);
  logger.info(`[scenes] saved id=${target.id} title=${target.title} table=${target.table}`);
  return target;
}

/** 删除场景 */
function deleteScene(id) {
  const scenes = listScenes();
  const next = scenes.filter((s) => s.id !== id);
  if (next.length === scenes.length) return false;
  writeScenes(next);
  logger.info(`[scenes] deleted id=${id}`);
  return true;
}

/** 按 id 查场景 */
function getScene(id) {
  return listScenes().find((s) => s.id === id) || null;
}

/* ---------- 场景导出 / 导入（JSON 无损，按标题覆盖更新） ---------- */

/** 导入前归一化场景字段（过滤非法/空值，保证结构可用） */
function normalizeScene(raw) {
  const s = raw || {};
  return {
    title: String(s.title || '').trim(),
    table: String(s.table || '').trim(),
    cluster: String(s.cluster || '').trim(),
    queryString: String(s.queryString || '').trim(),
    granularity: Number.isFinite(Number(s.granularity)) ? Number(s.granularity) : 0,
    dataSourceServiceId: String(s.dataSourceServiceId || '').trim(),
    orderFieldName: String(s.orderFieldName || '').trim(),
    orderType: s.orderType === 'asc' || s.orderType === 'desc' ? s.orderType : '',
    focusFields: Array.isArray(s.focusFields) ? s.focusFields.map((x) => String(x).trim()).filter(Boolean) : [],
    filterCondition: s.filterCondition && typeof s.filterCondition === 'object' ? s.filterCondition : {},
    clusterFields: Array.isArray(s.clusterFields) ? s.clusterFields.map((x) => String(x).trim()).filter(Boolean) : [],
    clusterSubFields: s.clusterSubFields && typeof s.clusterSubFields === 'object' ? s.clusterSubFields : {},
    clusterStatFields: s.clusterStatFields && typeof s.clusterStatFields === 'object' ? s.clusterStatFields : {}
  };
}

/** 导出全部场景为 JSON 字符串（含 id/createdAt，便于完整往返） */
function exportJson() {
  const scenes = listScenes();
  const payload = { version: 1, exportedAt: formatTime(), scenes };
  logger.info(`[scenes] export count=${scenes.length}`);
  return JSON.stringify(payload, null, 2);
}

/**
 * 从 JSON 导入场景（与用户确认，2026-08-10）：
 * 按「场景标题」匹配，已存在则覆盖更新（保留原 id 与 createdAt，维持与失败场景库的 sceneId 关联），不存在则新增
 * @param {string|object} json JSON 字符串或已解析对象（支持 scenes 数组或直接数组）
 * @returns {{ added: number, updated: number, skipped: number }}
 */
function importJson(json) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error('JSON 解析失败：' + e.message);
  }
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.scenes) ? data.scenes : null);
  if (!arr) throw new Error('JSON 内容不是场景数组（期望 scenes 数组）');
  const scenes = listScenes();
  const byTitle = new Map(scenes.map((s) => [s.title, s]));
  let added = 0, updated = 0, skipped = 0;
  for (const raw of arr) {
    const scene = normalizeScene(raw);
    if (!scene.title) { skipped++; continue; }
    const exist = byTitle.get(scene.title);
    if (exist) {
      Object.assign(exist, scene); // 保留原 id / createdAt
      updated++;
    } else {
      const created = {
        ...scene,
        id: crypto.randomBytes(8).toString('hex'),
        createdAt: formatTime()
      };
      scenes.push(created);
      byTitle.set(scene.title, created);
      added++;
    }
  }
  writeScenes(scenes);
  logger.info(`[scenes] import added=${added} updated=${updated} skipped=${skipped}`);
  return { added, updated, skipped };
}

module.exports = { listScenes, saveScene, deleteScene, getScene, exportJson, importJson, SCENES_FILE };
