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
const fs = require('fs');
const path = require('path');
const { logger } = require('../lib/logger');
const mock = require('../lib/mock-inspection');
const profileStore = require('../lib/profile-store');
const secretsStore = require('../lib/secrets-store');
const credentialManager = require('../lib/credential-manager');
const clickhouse = require('../lib/clickhouse-client');
const realInspection = require('../lib/real-inspection');
const sceneParser = require('../lib/scene-parser');
const sceneStore = require('../lib/scene-store');
const debugMode = require('../lib/debug-mode');
const excelExport = require('../lib/excel-export');
const clusterSummary = require('../lib/cluster-summary');
const aiConfig = require('../lib/ai-config-store');
const reportGenerator = require('../lib/report-generator');
const correctionStore = require('../lib/correction-store');
const emlExport = require('../lib/eml-export');
const emailConfigStore = require('../lib/email-config-store');
const failureLibrary = require('../lib/failure-library-store');

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

/* ---------- 0.5 详细日志模式开关 ---------- */
router.get('/debug-mode', (req, res) => {
  const status = debugMode.getStatus();
  logger.info(`[debug-mode] get -> enabled=${status.enabled}`);
  res.json({ code: 0, msg: 'ok', data: status });
});

router.post('/debug-mode', (req, res) => {
  const { enabled } = req.body || {};
  const data = debugMode.setDebugEnabled(enabled === true);
  logger.info(`[debug-mode] set -> enabled=${data.enabled}`);
  res.json({ code: 0, msg: 'ok', data });
});

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

/* ---------- 2. 场景目录（自定义巡检场景，用户在巡检场景管理页维护） ---------- */
router.get('/scenarios', (req, res) => {
  const scenes = sceneStore.listScenes();
  logger.info(`[scenarios] list -> ${scenes.length} custom scenes`);
  res.json({ code: 0, msg: 'ok', data: { scenarios: scenes } });
});

/* ---------- 2.1 巡检场景管理：解析 URL + 请求体 -> 场景草案 ---------- */
router.post('/scenes/parse', (req, res) => {
  const { url, requestBody } = req.body || {};
  try {
    if (!url || !String(url).trim()) return res.json({ code: 1, msg: '请填写请求 URL' });
    if (!requestBody || !String(requestBody).trim()) return res.json({ code: 1, msg: '请填写请求体 JSON' });
    const { scene, warnings } = sceneParser.parseAndValidate(String(url).trim(), String(requestBody).trim());
    logger.info(`[scenes/parse] ok table=${scene.table} warnings=${warnings.length}`);
    res.json({ code: 0, msg: 'ok', data: { scene, warnings } });
  } catch (e) {
    logger.error('[scenes/parse] failed', e);
    res.json({ code: 1, msg: '解析失败：' + (e.message || '未知错误') });
  }
});

/* ---------- 2.2 巡检场景管理：保存场景 ---------- */
router.post('/scenes', (req, res) => {
  const { scene } = req.body || {};
  try {
    if (!scene || !String(scene.title || '').trim()) {
      return res.json({ code: 1, msg: '场景标题不能为空' });
    }
    if (!scene.table) {
      return res.json({ code: 1, msg: '场景缺少表名 table' });
    }
    const saved = sceneStore.saveScene(scene);
    res.json({ code: 0, msg: 'ok', data: saved });
  } catch (e) {
    logger.error('[scenes] save failed', e);
    res.json({ code: 1, msg: '保存失败：' + (e.message || '未知错误') });
  }
});

/* ---------- 2.3 巡检场景管理：删除场景 ---------- */
router.delete('/scenes/:id', (req, res) => {
  const ok = sceneStore.deleteScene(req.params.id);
  if (!ok) return res.json({ code: 1, msg: '场景不存在' });
  res.json({ code: 0, msg: 'ok' });
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

/* ---------- 5. 核心：执行巡检（真实调用 ClickHouse queryWithTotal）-> 生成 Excel 下载 ---------- */
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
    // 读取自定义巡检场景，对每个启用的场景执行真实查询
    const scenes = sceneStore.listScenes();
    const sceneMap = new Map(scenes.map((s) => [s.id, s]));
    const queryResults = new Map();
    for (const id of profile.enabled_scenarios) {
      const scene = sceneMap.get(id);
      if (!scene) {
        logger.warn(`[export] scenario not found: ${id}`);
        continue;
      }

      logger.info(`[export] query scenario=${id} title=${scene.title} table=${scene.table} cluster=${scene.cluster}`);
      const q = await clickhouse.queryWithTotal({
        name: scene.table,
        cluster: scene.cluster,
        beginTimestamp: profile.beginTimestamp,
        endTimestamp: profile.endTimestamp,
        app_ver: profile.app_ver,
        filterCondition: scene.filterCondition,
        queryString: scene.queryString,
        granularity: scene.granularity,
        dataSourceServiceId: scene.dataSourceServiceId,
        orderFieldName: scene.orderFieldName,
        orderType: scene.orderType
      });
      queryResults.set(id, q);
      logger.info(`[export] scenario=${id} done total=${q.total} fetched=${q.records.length} pages=${q.pages}`);
      // 自动更新失败场景库命中数（该场景下内码+外码组合本次巡检命中条数）
      const hitUpdated = failureLibrary.updateHitCounts(scene, q.records);
      if (hitUpdated > 0) logger.info(`[export] failure-library hits updated=${hitUpdated} scenario=${id}`);
    }

    if (queryResults.size === 0) {
      return res.json({ code: 1, msg: '未找到可执行的场景' });
    }

    // 组装 Excel 数据：每个场景一个 sheet，仅取该场景 focusFields 关注字段
    const excelScenarios = [];
    for (const id of profile.enabled_scenarios) {
      const scene = sceneMap.get(id);
      const q = queryResults.get(id);
      if (!scene || !q) continue;
      excelScenarios.push({ scene, records: q.records });
    }

    // 生成聚类摘要（供大模型分析），持久化到 server/data/analysis/
    const analysisDir = path.join(__dirname, '..', 'data', 'analysis');
    if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true });
    const summaries = excelScenarios.map(({ scene, records }) => clusterSummary.buildClusterSummary(scene, records));
    const markdownTexts = summaries.map((s) => clusterSummary.toMarkdown(s));
    // 精确统计「内码+外码」组合命中数，供失败场景库一键导入带出完整组合
    const combosByScene = {};
    for (const { scene, records } of excelScenarios) {
      const combos = failureLibrary.countCombos(scene, records);
      if (combos.length) combosByScene[scene.title] = combos;
    }
    const analysisFile = path.join(analysisDir, `cluster-${Date.now()}.json`);
    const analysisData = {
      createdAt: new Date().toISOString(),
      // 计划名为空时存空串，避免日报标题/主题出现 "unnamed"（report-generator 对空值有「未命名计划」兜底）
      plan: profile.name || '',
      appVer: profile.app_ver || '',
      beginTimestamp: profile.beginTimestamp || '',
      endTimestamp: profile.endTimestamp || '',
      summaries,
      markdownTexts,
      combosByScene
    };
    fs.writeFileSync(analysisFile, JSON.stringify(analysisData, null, 2), 'utf-8');
    // 固定名 latest.json，供页面展示读取
    fs.writeFileSync(path.join(analysisDir, 'latest.json'), JSON.stringify(analysisData, null, 2), 'utf-8');
    logger.info(`[export] cluster summary saved -> ${analysisFile} scenes=${summaries.length}`);

    const buffer = await excelExport.buildExcelBuffer(excelScenarios);

    const now = new Date();
    const stamp =
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
      `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const filename = `health-check-${stamp}.xlsx`;

    logger.info(`[export] done scenarios=${excelScenarios.length} excelSize=${buffer.length}B filename=${filename}`);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
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

/* ---------- 5.2 调试：直接执行单次真实查询（不依赖场景勾选，用于快速定位问题） ---------- */
router.post('/debug/run-query', async (req, res) => {
  const { profile } = req.body || {};
  logger.info(`[debug/run-query] start range=${(profile && profile.beginTimestamp) || '-'} ~ ${(profile && profile.endTimestamp) || '-'}`);
  try {
    const q = await clickhouse.queryWithTotal({
      name: 'wallet_client_hmos',
      cluster: 'ulan1-aiops-ch-az1-4',
      beginTimestamp: profile && profile.beginTimestamp,
      endTimestamp: profile && profile.endTimestamp,
      app_ver: profile && profile.app_ver
    });
    const first = q.records[0] || {};
    logger.info(`[debug/run-query] done total=${q.total} fetched=${q.records.length} pages=${q.pages}`);
    res.json({
      code: 0,
      msg: 'ok',
      data: {
        total: q.total,
        fetched: q.records.length,
        pages: q.pages,
        histogramCount: q.histogram.length,
        sample: first
      }
    });
  } catch (e) {
    logger.error('[debug/run-query] failed', e);
    res.json({ code: 1, msg: '查询失败：' + (e.message || '未知错误') });
  }
});

/* ---------- 6. 读取聚类摘要（供页面展示 / AI 分析） ---------- */
router.get('/analysis/latest', (req, res) => {
  const file = path.join(__dirname, '..', 'data', 'analysis', 'latest.json');
  if (!fs.existsSync(file)) {
    return res.json({ code: 1, msg: '暂无聚类摘要，请先执行巡检' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    logger.info(`[analysis] latest -> plan=${data.plan} scenes=${(data.summaries || []).length}`);
    res.json({ code: 0, msg: 'ok', data });
  } catch (e) {
    logger.error('[analysis] read latest failed', e);
    res.json({ code: 1, msg: '读取聚类摘要失败：' + (e.message || '未知错误') });
  }
});

/* ---------- 7. 读取缓存数据（调试用） ---------- */
router.get('/cache/:id', (req, res) => {
  const data = getCache(req.params.id);
  if (!data) return res.json({ code: 1, msg: '缓存不存在或已过期' });
  res.json({ code: 0, msg: 'ok', data });
});

/* ---------- 8. AI 设置：读取配置（token 不返回明文） ---------- */
router.get('/ai-config', (req, res) => {
  const status = aiConfig.getSafeStatus();
  logger.info(`[ai-config] get -> endpoint=${status.endpoint} model=${status.model} hasToken=${status.hasToken}`);
  res.json({ code: 0, msg: 'ok', data: status });
});

/* ---------- 8.1 AI 设置：保存配置 ---------- */
router.post('/ai-config', (req, res) => {
  const { endpoint, token, model, temperature, maxCharsPerPrompt, timeoutMs, __clearToken } = req.body || {};
  const patch = {};
  if (endpoint !== undefined) patch.endpoint = String(endpoint).trim();
  if (model !== undefined) patch.model = String(model).trim();
  if (temperature !== undefined) patch.temperature = Number(temperature);
  if (maxCharsPerPrompt !== undefined) patch.maxCharsPerPrompt = Number(maxCharsPerPrompt);
  if (timeoutMs !== undefined) patch.timeoutMs = Number(timeoutMs);
  if (token !== undefined) patch.token = String(token).trim();
  if (__clearToken === true) patch.__clearToken = true;
  const status = aiConfig.saveConfig(patch);
  logger.info(`[ai-config] save -> endpoint=${status.endpoint} model=${status.model} hasToken=${status.hasToken}`);
  res.json({ code: 0, msg: 'ok', data: status });
});

/* ---------- 9. 生成 AI 巡检日报（分场景调用大模型，输出三段式 HTML） ---------- */
router.post('/ai-report', async (req, res) => {
  const { mock } = req.body || {};
  try {
    logger.info(`[ai-report] request received mock=${!!mock}`);
    const result = await reportGenerator.generateDailyReport({ mock: mock === true });
    res.json({ code: 0, msg: 'ok', data: result });
  } catch (e) {
    logger.error('[ai-report] failed', e);
    res.json({ code: 1, msg: e.message || '生成日报失败' });
  }
});

/* ---------- 9.1 人工矫正意见：列表 ---------- */
router.get('/ai-corrections', (req, res) => {
  const list = correctionStore.listCorrections();
  logger.info(`[corrections] list -> ${list.length}`);
  res.json({ code: 0, msg: 'ok', data: { corrections: list } });
});

/* ---------- 9.2 人工矫正意见：新增 ---------- */
router.post('/ai-corrections', (req, res) => {
  const { content } = req.body || {};
  try {
    const item = correctionStore.addCorrection(content);
    res.json({ code: 0, msg: 'ok', data: item });
  } catch (e) {
    logger.warn(`[corrections] add failed: ${e.message}`);
    res.json({ code: 1, msg: e.message || '保存矫正意见失败' });
  }
});

/* ---------- 9.3 人工矫正意见：删除 ---------- */
router.delete('/ai-corrections/:id', (req, res) => {
  const ok = correctionStore.deleteCorrection(req.params.id);
  if (!ok) return res.json({ code: 1, msg: '矫正意见不存在' });
  res.json({ code: 0, msg: 'ok' });
});

/* ---------- 10. 邮件配置：读取（主送/抄送/主题默认值） ---------- */
router.get('/email-config', (req, res) => {
  const cfg = emailConfigStore.getConfig();
  logger.info(`[email-config] get -> to=${cfg.to ? '有' : '空'} cc=${cfg.cc ? '有' : '空'} subject=${cfg.subject ? '有' : '空'}`);
  res.json({ code: 0, msg: 'ok', data: cfg });
});

/* ---------- 10.1 邮件配置：保存 ---------- */
router.post('/email-config', (req, res) => {
  const { from, to, cc, subject } = req.body || {};
  const cfg = emailConfigStore.saveConfig({ from, to, cc, subject });
  res.json({ code: 0, msg: 'ok', data: cfg });
});

/* ---------- 11. 导出巡检日报为 .eml 邮件文件（正文内嵌 HTML，不实际发送） ---------- */
router.post('/ai-report-eml', (req, res) => {
  const { to, cc, subject, html, from } = req.body || {};
  try {
    if (!html || !String(html).trim()) {
      return res.json({ code: 1, msg: '缺少日报 HTML 内容' });
    }
    const toList = emlExport.parseAddresses(to);
    if (toList.length === 0) {
      return res.json({ code: 1, msg: '请至少填写一个主送收件人邮箱' });
    }
    const finalSubject = subject && String(subject).trim() ? String(subject).trim() : '业务巡检日报';
    const finalFrom = from && String(from).trim() ? String(from).trim() : '';
    const eml = emlExport.buildEml({
      to: toList.join(','),
      cc,
      subject: finalSubject,
      html: String(html),
      // 发件人：页面可配置；未填时用占位地址且不显示「业务巡检日报」名称
      from: finalFrom || 'no-reply@localhost',
      fromName: finalFrom ? finalFrom.split('@')[0] : ''
    });
    const now = new Date();
    const stamp =
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
      `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const filename = `business-inspection-report-${stamp}.eml`;
    logger.info(`[ai-report-eml] generate to=${toList.length}人 cc=${cc ? '有' : '无'} from=${finalFrom || 'no-reply@localhost'} subjectLen=${finalSubject.length} emlSize=${eml.length}B filename=${filename}`);
    res.setHeader('Content-Type', 'message/rfc822; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(eml, 'utf-8'));
  } catch (e) {
    logger.error('[ai-report-eml] failed', e);
    res.json({ code: 1, msg: '生成邮件失败：' + (e.message || '未知错误') });
  }
});

/* ---------- 12. 巡检失败场景库：列表 ---------- */
router.get('/failure-library', (req, res) => {
  const items = failureLibrary.list();
  logger.info(`[failure-library] list -> ${items.length}`);
  res.json({ code: 0, msg: 'ok', data: { items } });
});

/* ---------- 12.1 巡检失败场景库：新增 ---------- */
router.post('/failure-library', (req, res) => {
  const { sceneId, sceneTitle, inCode, extCode, analysis } = req.body || {};
  try {
    const item = failureLibrary.add({ sceneId, sceneTitle, inCode, extCode, analysis });
    res.json({ code: 0, msg: 'ok', data: item });
  } catch (e) {
    logger.warn(`[failure-library] add failed: ${e.message}`);
    res.json({ code: 1, msg: e.message || '新增失败' });
  }
});

/* ---------- 12.2 巡检失败场景库：更新 ---------- */
router.put('/failure-library/:id', (req, res) => {
  const item = failureLibrary.update(req.params.id, req.body || {});
  if (!item) return res.json({ code: 1, msg: '案例不存在' });
  res.json({ code: 0, msg: 'ok', data: item });
});

/* ---------- 12.3 巡检失败场景库：删除 ---------- */
router.delete('/failure-library/:id', (req, res) => {
  const ok = failureLibrary.remove(req.params.id);
  if (!ok) return res.json({ code: 1, msg: '案例不存在' });
  res.json({ code: 0, msg: 'ok' });
});

/* ---------- 12.3.1 巡检失败场景库：全部清理 ---------- */
router.delete('/failure-library', (req, res) => {
  const count = failureLibrary.clearAll();
  logger.info(`[failure-library] clear all -> ${count}`);
  res.json({ code: 0, msg: 'ok', data: { cleared: count } });
});

/* ---------- 12.4 巡检失败场景库：从最新聚类摘要一键导入 ---------- */
router.post('/failure-library/import', (req, res) => {
  try {
    const analysisFile = path.join(__dirname, '..', 'data', 'analysis', 'latest.json');
    if (!fs.existsSync(analysisFile)) {
      return res.json({ code: 1, msg: '暂无聚类摘要，请先执行巡检' });
    }
    const analysisData = JSON.parse(fs.readFileSync(analysisFile, 'utf-8'));
    const scenes = sceneStore.listScenes();
    const result = failureLibrary.importFromSummaries(analysisData.summaries || [], scenes, analysisData.combosByScene || {});
    logger.info(`[failure-library] import result=${JSON.stringify(result)}`);
    res.json({ code: 0, msg: 'ok', data: result });
  } catch (e) {
    logger.error('[failure-library] import failed', e);
    res.json({ code: 1, msg: '导入失败：' + (e.message || '未知错误') });
  }
});

module.exports = router;
