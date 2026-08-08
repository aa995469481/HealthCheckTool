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

module.exports = { listScenes, saveScene, deleteScene, getScene, SCENES_FILE };
