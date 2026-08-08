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

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROFILES_FILE)) {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify({ activeProfileId: null, profiles: [] }, null, 2), 'utf-8');
  }
}

function readStore() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
  } catch (e) {
    logger.error('[profiles] read failed', e);
    return { activeProfileId: null, profiles: [] };
  }
}

function writeStore(store) {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    logger.error('[profiles] write failed', e);
  }
}

function listProfiles() {
  return readStore().profiles;
}

function getActiveProfileId() {
  return readStore().activeProfileId;
}

function saveProfile(profile) {
  const store = readStore();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  if (profile.id) {
    // 更新已有计划
    const idx = store.profiles.findIndex((p) => p.id === profile.id);
    if (idx !== -1) {
      store.profiles[idx] = { ...store.profiles[idx], ...profile, updateTime: ts };
      store.activeProfileId = profile.id;
      writeStore(store);
      logger.info(`[profiles] update id=${profile.id} name=${profile.name}`);
      return store.profiles[idx];
    }
  }
  // 新建计划
  const id = `profile_${ts}_${Math.random().toString(36).slice(2, 6)}`;
  const newProfile = { id, ...profile, createTime: ts, updateTime: ts };
  store.profiles.push(newProfile);
  store.activeProfileId = id;
  writeStore(store);
  logger.info(`[profiles] create id=${id} name=${profile.name}`);
  return newProfile;
}

function setActiveProfile(id) {
  const store = readStore();
  if (store.profiles.some((p) => p.id === id)) {
    store.activeProfileId = id;
    writeStore(store);
    logger.info(`[profiles] set active id=${id}`);
    return true;
  }
  return false;
}

function deleteProfile(id) {
  const store = readStore();
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.profiles.length === before) return false;
  if (store.activeProfileId === id) store.activeProfileId = null;
  writeStore(store);
  logger.info(`[profiles] delete id=${id}`);
  return true;
}

module.exports = { listProfiles, getActiveProfileId, saveProfile, setActiveProfile, deleteProfile };
