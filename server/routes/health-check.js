/**
 * 业务巡检 API 路由（/api/health-check/*）
 * 对齐《业务巡检功能详细介绍.txt》3.1 节
 *
 * 当前实现：
 *   - 数据来源为 Mock（server/lib/mock-inspection.js），真实 ClickHouse 可访问后替换数据层即可
 *   - 巡检结果缓存（inspectCacheId）已实现基础版（内存 Map，2h TTL）
 *   - 所有关键路径均写日志
 */
const express = require('express');
const crypto = require('crypto');
const { logger } = require('../lib/logger');
const mock = require('../lib/mock-inspection');
const profileStore = require('../lib/profile-store');
const secretsStore = require('../lib/secrets-store');
const credentialManager = require('../lib/credential-manager');
const clickhouse = require('../lib/clickhouse-client');
const realInspection = require('../lib/real-inspection');

const router = express.Router();

/* ---------- 巡检结果缓存（inspectCacheId，2h TTL） ---------- */
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const CACHE_MAX = 24;
const inspectCache = new Map(); // cacheId -> { data, createdAt }

function putCache(data) {
  if (inspectCache.size >= CACHE_MAX) {
    // 淘汰最旧的
    const oldestKey = inspectCache.keys().next().value;
    inspectCache.delete(oldestKey);
  }
  const id = crypto.randomBytes(8).toString('hex');
  inspectCache.set(id, { data, createdAt: Date.now() });
  logger.info(`[cache] put id=${id} size=${JSON.stringify(data).length}B ttlMs=${CACHE_TTL_MS}`);
  return id;
}

function getCache(id) {
  const item = inspectCache.get(id);
  if (!item) return null;
  if (Date.now() - item.createdAt > CACHE_TTL_MS) {
    inspectCache.delete(id);
    logger.info(`[cache] expired id=${id}`);
    return null;
  }
  return item.data;
}

/* ---------- 1. 凭据状态 ---------- */
router.get('/credentials', (req, res) => {
  const status = secretsStore.getStatus();
  logger.info(`[credentials] status -> configured=${status.configured} source=${status.source}`);
  res.json({ code: 0, msg: 'ok', data: status });
});

/* ---------- 1.1 触发 Wise 登录，自动获取凭据 ---------- */
router.post('/wise-login', async (req, res) => {
  try {
    logger.info('[wise-login] triggered');
    const status = await credentialManager.loginAndSave();
    res.json({ code: 0, msg: 'ok', data: status });
  } catch (e) {
    logger.error('[wise-login] failed', e);
    res.json({ code: 1, msg: e.message || '登录失败' });
  }
});

/* ---------- 1.2 手动保存凭据（回退方案） ---------- */
router.post('/secrets', (req, res) => {
  const { cookie, xCsrfToken } = req.body || {};
  if (!cookie || !xCsrfToken) {
    return res.json({ code: 1, msg: 'cookie 和 x-csrf-token 均不能为空' });
  }
  secretsStore.saveSecrets({ cookie: String(cookie).trim(), xCsrfToken: String(xCsrfToken).trim(), source: 'manual' });
  const status = secretsStore.getStatus();
  logger.info(`[secrets] manual save -> configured=${status.configured}`);
  res.json({ code: 0, msg: 'ok', data: status });
});

/* ---------- 2. 场景目录 ---------- */
router.get('/scenarios', (req, res) => {
  const scenarios = mock.listScenarios();
  logger.info(`[scenarios] list -> ${scenarios.length} scenarios`);
  res.json({ code: 0, msg: 'ok', data: { scenarios } });
});

/* ---------- 3. 巡检计划：列表 ---------- */
router.get('/inspection-profiles', (req, res) => {
  const profiles = profileStore.listProfiles();
  const activeProfileId = profileStore.getActiveProfileId();
  logger.info(`[profiles] list -> ${profiles.length} profiles, active=${activeProfileId || 'none'}`);
  res.json({ code: 0, msg: 'ok', data: { profiles, activeProfileId } });
});

/* ---------- 4. 巡检计划：保存/新建 ---------- */
router.post('/inspection-profiles', (req, res) => {
  const { id, name, app_ver, beginTimestamp, endTimestamp, enabled_scenarios } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.json({ code: 1, msg: '计划名称不能为空' });
  }
  const profile = profileStore.saveProfile({
    id: id || undefined,
    name: String(name).trim(),
    app_ver: app_ver || '',
    beginTimestamp: beginTimestamp || '',
    endTimestamp: endTimestamp || '',
    enabled_scenarios: Array.isArray(enabled_scenarios) ? enabled_scenarios : []
  });
  res.json({ code: 0, msg: 'ok', data: profile });
});

/* ---------- 5. 核心：执行巡检（真实调用 ClickHouse queryWithTotal） ---------- */
router.post('/export-json', async (req, res) => {
  const { profile } = req.body || {};
  if (!profile || !Array.isArray(profile.enabled_scenarios) || profile.enabled_scenarios.length === 0) {
    logger.warn('[export] rejected: no enabled scenarios');
    return res.json({ code: 1, msg: '请至少选择一个巡检场景' });
  }

  logger.info(
    `[export] start plan=${profile.name || 'unnamed'} app_ver=${profile.app_ver || '-'} scenarios=${profile.enabled_scenarios.length} range=${profile.beginTimestamp || '-'} ~ ${profile.endTimestamp || '-'}`
  );

  try {
    // 对每个启用的场景执行真实查询；同一 (table, cluster) 的场景复用同一次查询结果
    const queryResults = new Map();
    const tableCache = new Map();
    const debugRequestBodies = [];
    for (const id of profile.enabled_scenarios) {
      const def = mock.SCENARIO_DEFS.find((s) => s.id === id);
      if (!def) continue;

      const cacheKey = `${def.table}|${def.cluster}`;
      if (!tableCache.has(cacheKey)) {
        logger.info(`[export] query table=${def.table} cluster=${def.cluster}`);
        // 构造并记录完整请求体
        const requestBody = clickhouse.buildRequestBody({
          name: def.table,
          cluster: def.cluster,
          beginTimestamp: profile.beginTimestamp,
          endTimestamp: profile.endTimestamp,
          pageNo: 1,
          pageSize: clickhouse.PAGE_SIZE,
          app_ver: profile.app_ver
        });
        debugRequestBodies.push(requestBody);

        const q = await clickhouse.queryWithTotal({
          name: def.table,
          cluster: def.cluster,
          beginTimestamp: profile.beginTimestamp,
          endTimestamp: profile.endTimestamp,
          app_ver: profile.app_ver
        });
        tableCache.set(cacheKey, q);
        logger.info(`[export] table=${def.table} done total=${q.total} fetched=${q.records.length} pages=${q.pages}`);
      }
      queryResults.set(id, tableCache.get(cacheKey));
    }

    if (queryResults.size === 0) {
      return res.json({ code: 1, msg: '未找到可执行的场景' });
    }

    const data = realInspection.buildInspectionResult(profile, queryResults);
    const cacheId = putCache(data);
    const failedCount = (data.scenarios || []).filter((s) => s.status === 'failed').length;
    logger.info(`[export] done scenarios=${data.scenarios.length} failedScenarios=${failedCount} cacheId=${cacheId}`);
    res.json({
      code: 0,
      msg: 'ok',
      data: {
        data,
        inspectCacheId: cacheId,
        partial: data.partial,
        filename: data.filename,
        // 调试：回传本次使用的完整请求体（首个场景）
        debugRequestBody: debugRequestBodies[0] || null
      }
    });
  } catch (e) {
    logger.error('[export] failed', e);
    res.json({ code: 1, msg: '巡检执行失败：' + (e.message || '未知错误') });
  }
});

/* ---------- 5.1 调试：预览当前将发送的完整请求体（不执行查询） ---------- */
router.post('/debug/request-body', (req, res) => {
  const { profile } = req.body || {};
  try {
    const requestBody = clickhouse.buildRequestBody({
      name: (profile && profile.table) || 'wallet_client_hmos',
      cluster: (profile && profile.cluster) || 'ulan1-aiops-ch-az1-4',
      beginTimestamp: profile && profile.beginTimestamp,
      endTimestamp: profile && profile.endTimestamp,
      pageNo: 1,
      pageSize: clickhouse.PAGE_SIZE,
      app_ver: profile && profile.app_ver
    });
    res.json({ code: 0, msg: 'ok', data: requestBody });
  } catch (e) {
    logger.error('[debug/request-body] failed', e);
    res.json({ code: 1, msg: '生成请求体失败：' + (e.message || '未知错误') });
  }
});

/* ---------- 6. 读取缓存数据（调试用） ---------- */
router.get('/cache/:id', (req, res) => {
  const data = getCache(req.params.id);
  if (!data) return res.json({ code: 1, msg: '缓存不存在或已过期' });
  res.json({ code: 0, msg: 'ok', data });
});

module.exports = router;
