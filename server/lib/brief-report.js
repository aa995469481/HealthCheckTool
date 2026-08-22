/**
 * 巡检简要报告 - 执行巡检后生成（与上次巡检对比）
 *
 * 报告内容（与用户确认，2026-08-22）：
 *   1. 新增错误码 Top5：本次有、上次没有的内码+外码组合，按命中条数降序取前 5
 *   2. 用户数量增加 Top10：本次与上次都有的组合，去重用户数增量（本次-上次）降序取前 10
 *   3. 每个错误下 issuer_id 分布：按组合分组，再按 issuer_id 统计命中条数
 *
 * 对比基准：巡检历史快照（inspection-history，每天覆盖一次），取最近一份作为「上次巡检」
 */
const failureLibrary = require('./failure-library-store');

/** 去重用户数统计字段 */
const UID_FIELD = 'uid';
/** issuer 分布统计字段（真实日志 select * 全字段返回） */
const ISSUER_FIELD = 'issuer_id';

const KEY_SEP = '\u0001';

function comboKey(inCode, extCode) {
  return `${inCode}${KEY_SEP}${extCode}`;
}

/**
 * 统计场景记录的内码+外码组合
 * @returns [{ inCode, extCode, count, users, issuers: [{issuer_id, count}] }]
 */
function comboStats(scene, records, framework) {
  const { inCodeField, extCodeField } = failureLibrary.resolveCodeFields(scene, framework);
  const map = new Map();
  for (const r of records || []) {
    const inCode = r && r[inCodeField] !== undefined && r[inCodeField] !== null && r[inCodeField] !== '' ? String(r[inCodeField]) : '(空)';
    const extCode = r && r[extCodeField] !== undefined && r[extCodeField] !== null && r[extCodeField] !== '' ? String(r[extCodeField]) : '(空)';
    const key = comboKey(inCode, extCode);
    if (!map.has(key)) map.set(key, { inCode, extCode, count: 0, users: new Set(), issuers: new Map() });
    const st = map.get(key);
    st.count++;
    const uid = r && r[UID_FIELD];
    if (uid !== undefined && uid !== null && uid !== '') st.users.add(uid);
    const iss = r && r[ISSUER_FIELD];
    if (iss !== undefined && iss !== null && iss !== '') {
      st.issuers.set(String(iss), (st.issuers.get(String(iss)) || 0) + 1);
    }
  }
  return Array.from(map.values())
    .map((st) => ({
      inCode: st.inCode,
      extCode: st.extCode,
      count: st.count,
      users: st.users.size,
      issuers: Array.from(st.issuers.entries())
        .map(([issuer_id, c]) => ({ issuer_id, count: c }))
        .sort((a, b) => b.count - a.count)
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 构建本次巡检的历史快照 scenes（供 saveSnapshot；含去重用户数，供下次对比用户数变化）
 * @param {{scene, records}[]} sceneRecords
 */
function buildSnapshotScenes(sceneRecords, framework) {
  return (sceneRecords || []).map(({ scene, records }) => {
    const combos = comboStats(scene, records, framework).map(({ inCode, extCode, count, users }) => ({
      inCode,
      extCode,
      count,
      users
    }));
    return {
      sceneId: scene.id,
      sceneTitle: scene.title,
      total: Array.isArray(records) ? records.length : 0,
      combos
    };
  });
}

/**
 * 生成本次巡检简要报告
 * @param {{scene, records}[]} sceneRecords 本次巡检各场景及记录
 * @param {'single'|'dual'} framework
 * @param {{scenes: []}|null} prevSnapshot 上次巡检快照（loadTrend 最新一份），无历史时为 null
 * @returns [{ sceneTitle, total, prevTotal, newTop5, userGainTop10, issuerByError }]
 */
function buildReport(sceneRecords, framework, prevSnapshot) {
  const prevByScene = new Map();
  if (prevSnapshot && Array.isArray(prevSnapshot.scenes)) {
    for (const sc of prevSnapshot.scenes) {
      const combos = new Map();
      for (const c of sc.combos || []) combos.set(comboKey(c.inCode, c.extCode), c);
      prevByScene.set(sc.sceneTitle, { total: sc.total || 0, combos });
    }
  }

  return (sceneRecords || []).map(({ scene, records }) => {
    const stats = comboStats(scene, records, framework);
    const cur = new Map(stats.map((c) => [comboKey(c.inCode, c.extCode), c]));
    const prev = prevByScene.get(scene.title) || { total: 0, combos: new Map() };

    // 1. 新增错误码 Top5（本次有、上次没有，按条数降序）
    const newTop5 = stats
      .filter((c) => !prev.combos.has(comboKey(c.inCode, c.extCode)))
      .slice(0, 5);

    // 2. 用户数量增加 Top10（两次都有的组合，增量 = 本次-上次，仅取增加）
    const userGainTop10 = [];
    for (const c of stats) {
      const pc = prev.combos.get(comboKey(c.inCode, c.extCode));
      if (!pc) continue;
      const usersPrev = pc.users || 0;
      const delta = (c.users || 0) - usersPrev;
      if (delta > 0) {
        userGainTop10.push({ inCode: c.inCode, extCode: c.extCode, count: c.count, usersPrev, users: c.users, delta });
      }
    }
    userGainTop10.sort((a, b) => b.delta - a.delta);
    userGainTop10.length = Math.min(userGainTop10.length, 10);

    // 3. 每个错误下 issuer_id 分布（仅保留有 issuer 记录的组合）
    const issuerByError = stats
      .filter((c) => c.issuers.length > 0)
      .map((c) => ({ inCode: c.inCode, extCode: c.extCode, count: c.count, issuers: c.issuers }));

    return {
      sceneTitle: scene.title,
      total: Array.isArray(records) ? records.length : 0,
      prevTotal: prev.total,
      newTop5,
      userGainTop10,
      issuerByError
    };
  });
}

module.exports = { buildReport, buildSnapshotScenes, comboStats };
