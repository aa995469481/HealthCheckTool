/**
 * 巡检计划存储 - 持久化到 server/data/health-check-profiles.json
 *
 * 数据格式：
 *   {
 *     activeProfileId: <string|null>,
 *     profiles: [ { id, name, app_ver, beginTimestamp, endTimestamp, enabled_scenarios: [] } ]
 *   }
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'health-check-profiles.json');
const PROFILES_FILE_DUAL = path.join(DATA_DIR, 'health-check-profiles-dual.json');

/** 按框架解析数据文件：单框架沿用原文件（零迁移），双框架使用 -dual 文件 */
function fileFor(framework) {
  return framework === 'dual' ? PROFILES_FILE_DUAL : PROFILES_FILE;
}

function ensureFile(framework) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = fileFor(framework);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ activeProfileId: null, profiles: [] }, null, 2), 'utf-8');
  }
}

function readStore(framework) {
  ensureFile(framework);
  try {
    return JSON.parse(fs.readFileSync(fileFor(framework), 'utf-8'));
  } catch (e) {
    logger.error('[profiles] read failed', e);
    return { activeProfileId: null, profiles: [] };
  }
}

function writeStore(store, framework) {
  try {
    fs.writeFileSync(fileFor(framework), JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    logger.error('[profiles] write failed', e);
  }
}

function listProfiles(framework) {
  return readStore(framework).profiles;
}

function getActiveProfileId(framework) {
  return readStore(framework).activeProfileId;
}

function saveProfile(profile, framework) {
  const store = readStore(framework);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  if (profile.id) {
    // 更新已有计划
    const idx = store.profiles.findIndex((p) => p.id === profile.id);
    if (idx !== -1) {
      store.profiles[idx] = { ...store.profiles[idx], ...profile, updateTime: ts };
      store.activeProfileId = profile.id;
      writeStore(store, framework);
      logger.info(`[profiles] update id=${profile.id} name=${profile.name} framework=${framework || 'single'}`);
      return store.profiles[idx];
    }
  }
  // 新建计划
  const id = `profile_${ts}_${Math.random().toString(36).slice(2, 6)}`;
  const newProfile = { id, ...profile, createTime: ts, updateTime: ts };
  store.profiles.push(newProfile);
  store.activeProfileId = id;
  writeStore(store, framework);
  logger.info(`[profiles] create id=${id} name=${profile.name} framework=${framework || 'single'}`);
  return newProfile;
}

function setActiveProfile(id, framework) {
  const store = readStore(framework);
  if (store.profiles.some((p) => p.id === id)) {
    store.activeProfileId = id;
    writeStore(store, framework);
    logger.info(`[profiles] set active id=${id}`);
    return true;
  }
  return false;
}

function deleteProfile(id, framework) {
  const store = readStore(framework);
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.profiles.length === before) return false;
  if (store.activeProfileId === id) store.activeProfileId = null;
  writeStore(store, framework);
  logger.info(`[profiles] delete id=${id}`);
  return true;
}

module.exports = { listProfiles, getActiveProfileId, saveProfile, setActiveProfile, deleteProfile };
