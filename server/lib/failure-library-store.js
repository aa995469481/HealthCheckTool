/**
 * 巡检失败场景库存储 - 按「场景 + 内码 + 外码」维护案例分析，持久化到 server/data/failure-library.json
 *
 * 设计（与用户确认，2026-08-08 / 2026-08-10 补充字段）：
 *   - 每条案例 = 场景 + 内码(inCode) + 外码(extCode) + 案例分析文本（根因/影响/处置建议）
 *   - 2026-08-10 新增维护字段：问题类别 category（端侧问题/SP问题/云侧问题/非问题/待确认，默认 待确认）、
 *     问题状态 status（待确认/已分析/已闭环，默认 待确认）、卡维度 cardDimension（自由字符串或 All，默认 All）
 *   - 统计：执行巡检后自动统计该组合在本次巡检中命中的去重用户数（按 uid 去重），记录 latestUserCount（不手动维护）
 *   - 录入：手动新增/编辑 + 从聚类摘要维度 Top 分组一键导入 + CSV 文件导出/导入（按 场景+内码+外码 覆盖更新）
 *   - 供 AI 日报生成：aiReferenceText() 仅引用「已分析/已闭环」且有分析文本的案例，喂给汇总调用
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');
const sceneStore = require('./scene-store');

const FILE = path.join(__dirname, '..', 'data', 'failure-library.json');
const FILE_DUAL = path.join(__dirname, '..', 'data', 'failure-library-dual.json');

/** 按框架解析数据文件：单框架沿用原文件（零迁移），双框架使用 -dual 文件（不存在时视为空库） */
function fileFor(framework) {
  return framework === 'dual' ? FILE_DUAL : FILE;
}

/* ---------- 框架字段映射：内码/外码字段名（不同日志空间字段差异大） ----------
 * 单框架：内码 walletEventInCode / 外码 walletEventExtCode
 * 双框架：内码 event_id / 外码 internal_errcode
 */
const CODE_FIELDS = {
  single: { inCode: 'walletEventInCode', extCode: 'walletEventExtCode', inCodeRe: /incode/i, extCodeRe: /extcode/i },
  dual: { inCode: 'event_id', extCode: 'internal_errcode', inCodeRe: /event_?id/i, extCodeRe: /internal_?errcode/i }
};

/** 按框架取内码/外码字段名识别器（非 dual 一律按单框架处理，不影响现有行为） */
function codeFieldTest(framework) {
  return framework === 'dual' ? CODE_FIELDS.dual : CODE_FIELDS.single;
}

/* ---------- 字段枚举与归一化（新增维护字段） ---------- */
const CATEGORY_ENUM = ['端侧问题', 'SP问题', '云侧问题', '非问题', '待确认'];
const STATUS_ENUM = ['待确认', '已分析', '已闭环'];
const DEFAULT_CATEGORY = '待确认';
const DEFAULT_STATUS = '待确认';
const DEFAULT_CARD = 'All';

const normalizeCategory = (v) => (CATEGORY_ENUM.includes(String(v || '').trim()) ? String(v).trim() : DEFAULT_CATEGORY);
const normalizeStatus = (v) => (STATUS_ENUM.includes(String(v || '').trim()) ? String(v).trim() : DEFAULT_STATUS);
const normalizeCard = (v) => {
  const s = String(v || '').trim();
  return s === '' || s === 'NA' ? DEFAULT_CARD : s;
};

/** CSV 表头（导出/导入共用，列顺序固定） */
const CSV_HEADERS = ['场景', '内码', '外码', '卡维度', '问题类别', '问题状态', '案例分析', '最近用户数', '上一次用户数', '最近检查', '更新时间'];

function load(framework) {
  const file = fileFor(framework);
  try {
    if (!fs.existsSync(file)) return [];
    const arr = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const result = Array.isArray(arr) ? arr : [];
    // 旧数据迁移：默认待确认 -> 待确认；卡维度 NA -> All；latestHitCount -> latestUserCount；缺失字段补默认值
    let changed = false;
    for (const it of result) {
      if (!it.category || it.category === '默认待确认') { it.category = DEFAULT_CATEGORY; changed = true; }
      else if (!CATEGORY_ENUM.includes(it.category)) { it.category = DEFAULT_CATEGORY; changed = true; }
      if (!it.status) { it.status = DEFAULT_STATUS; changed = true; }
      if (!it.cardDimension || it.cardDimension === 'NA') { it.cardDimension = DEFAULT_CARD; changed = true; }
      if (it.latestUserCount === undefined && it.latestHitCount !== undefined) {
        it.latestUserCount = it.latestHitCount;
        delete it.latestHitCount;
        changed = true;
      }
    }
    if (changed) save(result, framework);
    return result;
  } catch (e) {
    logger.warn(`[failure-library] load failed: ${e.message}`);
    return [];
  }
}

function save(list, framework) {
  fs.writeFileSync(fileFor(framework), JSON.stringify(list, null, 2), 'utf-8');
}

/** 从场景的聚类字段里解析内码/外码字段名（单框架默认 walletEventInCode / walletEventExtCode，双框架默认 event_id / internal_errcode） */
function resolveCodeFields(scene, framework) {
  const map = codeFieldTest(framework);
  const clusterFields = Array.isArray(scene && scene.clusterFields)
    ? scene.clusterFields.map(String)
    : [map.inCode, map.extCode];
  let inCodeField = map.inCode;
  let extCodeField = map.extCode;
  for (const f of clusterFields) {
    if (map.inCodeRe.test(f)) inCodeField = f;
    else if (map.extCodeRe.test(f)) extCodeField = f;
  }
  return { inCodeField, extCodeField };
}

function fieldValue(record, field) {
  if (!record) return '';
  const v = record[field];
  return v === null || v === undefined ? '' : String(v);
}

/** 全部案例（按用户数量降序，用户数量相同按更新时间倒序） */
function list(framework) {
  return load(framework).sort((a, b) => {
    const ua = a.latestUserCount || 0;
    const ub = b.latestUserCount || 0;
    if (ua !== ub) return ub - ua;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
}

/** 新增案例 */
function add({ sceneId, sceneTitle, inCode, extCode, analysis, category, status, cardDimension }, framework) {
  const list = load(framework);
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomBytes(8).toString('hex'),
    sceneId: String(sceneId || ''),
    sceneTitle: String(sceneTitle || '').trim(),
    inCode: String(inCode || '').trim(),
    extCode: String(extCode || '').trim(),
    analysis: String(analysis || '').trim(),
    category: normalizeCategory(category),
    status: normalizeStatus(status),
    cardDimension: normalizeCard(cardDimension),
    latestUserCount: 0,
    lastCheckedAt: '',
    createdAt: now,
    updatedAt: now
  };
  if (!item.sceneTitle) throw new Error('请选择场景');
  if (!item.inCode && !item.extCode) throw new Error('内码和外码至少填写一个');
  list.push(item);
  save(list, framework);
  logger.info(`[failure-library] add id=${item.id} scene=${item.sceneTitle} in=${item.inCode || '-'} ext=${item.extCode || '-'} framework=${framework || 'single'}`);
  return item;
}

/** 更新案例 */
function update(id, patch = {}, framework) {
  const list = load(framework);
  const item = list.find((c) => c.id === id);
  if (!item) return null;
  if (patch.sceneTitle !== undefined) item.sceneTitle = String(patch.sceneTitle).trim();
  if (patch.sceneId !== undefined) item.sceneId = String(patch.sceneId);
  if (patch.inCode !== undefined) item.inCode = String(patch.inCode).trim();
  if (patch.extCode !== undefined) item.extCode = String(patch.extCode).trim();
  if (patch.analysis !== undefined) item.analysis = String(patch.analysis).trim();
  if (patch.category !== undefined) item.category = normalizeCategory(patch.category);
  if (patch.status !== undefined) item.status = normalizeStatus(patch.status);
  if (patch.cardDimension !== undefined) item.cardDimension = normalizeCard(patch.cardDimension);
  item.updatedAt = new Date().toISOString();
  save(list, framework);
  logger.info(`[failure-library] update id=${id}`);
  return item;
}

/** 删除案例 */
function remove(id, framework) {
  const list = load(framework);
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  save(next, framework);
  logger.info(`[failure-library] remove id=${id}`);
  return true;
}

/** 清空全部案例，返回删除条数 */
function clearAll(framework) {
  const list = load(framework);
  const count = list.length;
  if (count === 0) return 0;
  save([], framework);
  logger.info(`[failure-library] clear all -> ${count}`);
  return count;
}

/**
 * 构建「已确认问题类别=非问题」记录的剔除匹配器（供聚类摘要 / 用户数统计共用）
 * 匹配规则（与用户确认，2026-08-10）：
 *   - 场景：条目 sceneId 与场景 id 一致（条目缺 sceneId 时按场景标题兜底）
 *   - 内码 / 外码：条目有值则与记录对应字段完全一致才满足
 *   - 卡维度：条目 cardDimension = All 则任意记录满足；否则记录 issueID 与 cardDimension 完全一致才满足
 * @param {object} scene 巡检场景 { id, title, clusterFields }
 * @returns {function|null} 匹配函数（命中返回 true，该记录应被剔除）；无非问题条目时返回 null
 */
function buildNonProblemFilter(scene, framework) {
  const nonProblem = load(framework).filter((c) => c.category === '非问题');
  if (!nonProblem.length) return null;
  const { inCodeField, extCodeField } = resolveCodeFields(scene, framework);
  const sceneId = scene && scene.id ? String(scene.id) : '';
  const sceneTitle = scene && scene.title ? String(scene.title) : '';
  return (record) => {
    const inV = fieldValue(record, inCodeField);
    const exV = fieldValue(record, extCodeField);
    const issueId = fieldValue(record, 'issueID');
    return nonProblem.some((c) => {
      if (c.sceneId ? c.sceneId !== sceneId : c.sceneTitle !== sceneTitle) return false;
      if (c.inCode && c.inCode !== inV) return false;
      if (c.extCode && c.extCode !== exV) return false;
      if (c.cardDimension && c.cardDimension !== 'All' && c.cardDimension !== issueId) return false;
      return true;
    });
  };
}

/**
 * 执行巡检后自动更新用户数量：统计该场景本次巡检记录中 (内码, 外码) 组合命中的去重用户数（按 uid 去重，无 uid 的记录不计入），
 * 更新库中同一场景条目的 latestUserCount / prevUserCount（上一次巡检数量=本次更新前旧值）/ lastCheckedAt（组合缺失一端时按单字段统计）
 * 已确认「非问题」的记录（buildNonProblemFilter 命中）不参与统计
 * @returns {number} 更新条数
 */
function updateUserCounts(scene, records, framework) {
  if (!scene || !Array.isArray(records)) return 0;
  const { inCodeField, extCodeField } = resolveCodeFields(scene, framework);
  const isNonProblem = buildNonProblemFilter(scene, framework);
  const comboUsers = new Map(); // `${inV}\u0000${exV}` -> Set(uid)
  const inUsers = new Map();    // inV -> Set(uid)
  const extUsers = new Map();   // exV -> Set(uid)
  for (const r of records) {
    if (isNonProblem && isNonProblem(r)) continue; // 已确认非问题的记录剔除
    const inV = fieldValue(r, inCodeField);
    const exV = fieldValue(r, extCodeField);
    const uid = fieldValue(r, 'uid');
    if (uid === '') continue; // 无 uid 无法归属用户，不计入
    const comboKey = `${inV}\u0000${exV}`;
    if (!comboUsers.has(comboKey)) comboUsers.set(comboKey, new Set());
    comboUsers.get(comboKey).add(uid);
    if (!inUsers.has(inV)) inUsers.set(inV, new Set());
    inUsers.get(inV).add(uid);
    if (!extUsers.has(exV)) extUsers.set(exV, new Set());
    extUsers.get(exV).add(uid);
  }

  const emptySet = new Set();
  const list = load(framework);
  let updated = 0;
  for (const c of list) {
    if (c.sceneId !== scene.id) continue;
    let count = 0;
    if (c.inCode && c.extCode) {
      count = (comboUsers.get(`${c.inCode}\u0000${c.extCode}`) || emptySet).size;
    } else if (c.inCode) {
      count = (inUsers.get(c.inCode) || emptySet).size;
    } else if (c.extCode) {
      count = (extUsers.get(c.extCode) || emptySet).size;
    }
    // 上一次巡检的用户数量 = 本次更新前的旧值（仅当此前已被巡检过；新条目首次巡检不产生「上一次」数据）
    if (c.lastCheckedAt) c.prevUserCount = c.latestUserCount;
    if (c.latestUserCount !== count) c.latestUserCount = count;
    c.lastCheckedAt = new Date().toISOString();
    updated++;
  }
  if (updated > 0) {
    save(list, framework);
    logger.info(`[failure-library] user counts updated scene=${scene.id} updated=${updated} framework=${framework || 'single'}`);
  }
  return updated;
}

/**
 * 统计该场景本次巡检记录中「内码+外码」组合命中的去重用户数（按 uid 去重，精确统计，按数量降序）
 * 已确认「非问题」的记录不参与统计
 * 供 export-json 写入聚类摘要（combos），用于一键导入时带出完整组合
 * @returns {Array<{ inCode: string, extCode: string, count: number }>}
 */
function countCombos(scene, records, framework) {
  if (!scene || !Array.isArray(records)) return [];
  const { inCodeField, extCodeField } = resolveCodeFields(scene, framework);
  const isNonProblem = buildNonProblemFilter(scene, framework);
  const comboUsers = new Map(); // `${inV}\u0000${exV}` -> Set(uid)
  for (const r of records) {
    if (isNonProblem && isNonProblem(r)) continue; // 已确认非问题的记录剔除
    const inV = fieldValue(r, inCodeField);
    const exV = fieldValue(r, extCodeField);
    const uid = fieldValue(r, 'uid');
    if (uid === '') continue;
    const key = `${inV}\u0000${exV}`;
    if (!comboUsers.has(key)) comboUsers.set(key, new Set());
    comboUsers.get(key).add(uid);
  }
  return [...comboUsers.entries()]
    .map(([key, users]) => {
      const [inCode, extCode] = key.split('\u0000');
      return { inCode, extCode, count: users.size };
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
function importFromSummaries(summaries, scenes, combosByScene = {}, framework) {
  const sceneMap = new Map((scenes || []).map((s) => [s.title, s]));
  const list = load(framework);
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
      category: DEFAULT_CATEGORY,
      status: DEFAULT_STATUS,
      cardDimension: DEFAULT_CARD,
      latestUserCount: hitCount || 0,
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now
    });
    added++;
  }

  // 每个内码/外码值最多导入的组合数（防单码值外码过多导致条目爆炸）
  const MAX_COMBOS_PER_CODE = 5;

  for (const summary of summaries || []) {
    const sceneTitle = summary.scenarioTitle || '';
    const scene = sceneMap.get(sceneTitle);
    const sceneId = scene ? scene.id : '';
    const dims = summary.dimensions || [];
    const { inCodeRe, extCodeRe } = codeFieldTest(framework);
    const inDim = dims.find((d) => inCodeRe.test(d.field));
    const exDim = dims.find((d) => extCodeRe.test(d.field));
    const combos = Array.isArray(combosByScene[sceneTitle]) ? combosByScene[sceneTitle] : [];

    if (combos.length) {
      // 组合导入：对内码 Top 分组（无内码维度则按外码 Top 分组），
      // 把该码值下的所有组合（combos 已按命中数降序）都导入，内码+外码同时带出
      const codeGroups = (inDim && inDim.groups) || (exDim && exDim.groups) || [];
      for (const g of codeGroups) {
        const codeValue = String(g.key === '(空)' ? '' : g.key);
        if (!codeValue) continue;
        const codeMatches = inDim
          ? combos.filter((c) => c.inCode === codeValue)
          : combos.filter((c) => c.extCode === codeValue);
        if (!codeMatches.length) continue;
        for (const combo of codeMatches.slice(0, MAX_COMBOS_PER_CODE)) {
          if (exists(sceneId, combo.inCode, combo.extCode)) {
            skipped++;
            continue;
          }
          pushEntry(sceneId, sceneTitle, combo.inCode, combo.extCode, combo.count);
        }
      }
      continue;
    }

    // 回退：combos 缺失（旧摘要）时按维度值导入
    for (const dim of dims) {
      const isInCode = inCodeRe.test(dim.field);
      const isExtCode = extCodeRe.test(dim.field);
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
  if (added > 0) save(list, framework);
  logger.info(`[failure-library] import added=${added} skipped=${skipped} scenes=${summaries.length} framework=${framework || 'single'}`);
  return { added, skipped };
}

/**
 * 生成喂给大模型的案例分析参考文本（空则返回 ''）
 * 仅取「已分析 / 已闭环」且有分析文本的条目（待确认的不作为 AI 判断依据），最多 20 条，每条分析截断 500 字符
 */
function aiReferenceText(framework) {
  const list = load(framework).filter(
    (c) => (c.status === '已分析' || c.status === '已闭环') && c.analysis && String(c.analysis).trim()
  );
  if (!list.length) return '';
  const lines = list.slice(0, 20).map((c, i) => {
    const scene = c.sceneTitle || '未命名场景';
    const code = `${c.inCode || '-'}${c.extCode ? ' / ' + c.extCode : ''}`;
    const latest = c.latestUserCount || 0;
    // 对比上一次巡检（无上一次数据或持平则不附加）
    const compare = (c.prevUserCount !== undefined && c.prevUserCount !== null && c.prevUserCount !== latest)
      ? `，较上次${latest > c.prevUserCount ? '+' : '-'}${Math.abs(latest - c.prevUserCount)}`
      : '';
    const hit = latest > 0 ? `（最近巡检 ${latest} 个用户${compare}）` : '';
    return `${i + 1}. [${scene}] 内码+外码=${code}${hit}：${String(c.analysis).slice(0, 500)}`;
  });
  return lines.join('\n');
}

/* ---------- CSV 导出 / 导入 ---------- */

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 导出全部案例为 CSV 文本（含 UTF-8 BOM，Excel 可直接打开不乱码） */
function exportCsv(framework) {
  const rows = load(framework).map((c) => [
    c.sceneTitle || '',
    c.inCode || '',
    c.extCode || '',
    c.cardDimension || DEFAULT_CARD,
    c.category || DEFAULT_CATEGORY,
    c.status || DEFAULT_STATUS,
    c.analysis || '',
    c.latestUserCount || 0,
    c.prevUserCount === undefined || c.prevUserCount === null ? '' : c.prevUserCount,
    c.lastCheckedAt || '',
    c.updatedAt || ''
  ]);
  const lines = [CSV_HEADERS, ...rows].map((r) => r.map(csvEscape).join(','));
  return '\uFEFF' + lines.join('\r\n');
}

/** 解析 CSV 文本为二维数组（支持引号包裹的字段，内含逗号/换行/双引号） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * 从 CSV 文本导入（表头需与导出一致）：按 场景+内码+外码 匹配，
 * 已存在则覆盖更新（类别/状态/卡维度/分析，命中数>0 时也更新），不存在则新增。
 * 场景 ID 不在 CSV 中，导入时按标题从场景库解析 sceneId（保证后续命中数更新可用）
 * @returns {{ added: number, updated: number, skipped: number }}
 */
function importCsv(text, framework) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('文件为空或格式不正确');
  const header = rows[0].map((h) => String(h).trim());
  const col = (name) => header.indexOf(name);
  const iScene = col('场景');
  const iIn = col('内码');
  const iExt = col('外码');
  const iCard = col('卡维度');
  const iCat = col('问题类别');
  const iStatus = col('问题状态');
  const iAnalysis = col('案例分析');
  // 兼容旧版导出的 CSV（列名「最近命中」）
  let iHit = col('最近用户数');
  if (iHit < 0) iHit = col('最近命中');
  const iPrev = col('上一次用户数');
  if (iScene < 0) throw new Error('CSV 缺少「场景」列，请使用导出的 CSV 模板格式');
  if (iIn < 0 && iExt < 0) throw new Error('CSV 至少需要「内码」或「外码」列');

  const sceneMap = new Map(sceneStore.listScenes(framework).map((s) => [s.title, s]));
  const list = load(framework);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && String(row[0]).trim() === '') continue; // 空行
    const get = (i) => (i >= 0 && i < row.length ? String(row[i] || '').trim() : '');
    const sceneTitle = get(iScene);
    const inCode = get(iIn);
    const extCode = get(iExt);
    if (!sceneTitle || (!inCode && !extCode)) { skipped++; continue; }
    const scene = sceneMap.get(sceneTitle);
    const exist = list.find(
      (c) => c.sceneTitle === sceneTitle && (c.inCode || '') === inCode && (c.extCode || '') === extCode
    );
    const patch = {
      category: normalizeCategory(get(iCat)),
      status: normalizeStatus(get(iStatus)),
      cardDimension: normalizeCard(get(iCard)),
      analysis: get(iAnalysis)
    };
    if (exist) {
      exist.category = patch.category;
      exist.status = patch.status;
      exist.cardDimension = patch.cardDimension;
      if (patch.analysis !== '') exist.analysis = patch.analysis;
      if (!exist.sceneId && scene) exist.sceneId = scene.id;
      const hit = Number(get(iHit));
      if (!isNaN(hit) && hit > 0) exist.latestUserCount = hit;
      if (iPrev >= 0) {
        const prevRaw = get(iPrev);
        const prevNum = Number(prevRaw);
        exist.prevUserCount = prevRaw !== '' && !isNaN(prevNum) ? prevNum : undefined;
      }
      exist.updatedAt = now;
      updated++;
    } else {
      const hit = Number(get(iHit));
      const prevNum = Number(get(iPrev));
      const prevUserCount = iPrev >= 0 && get(iPrev) !== '' && !isNaN(prevNum) ? prevNum : undefined;
      list.push({
        id: crypto.randomBytes(8).toString('hex'),
        sceneId: scene ? scene.id : '',
        sceneTitle,
        inCode,
        extCode,
        analysis: patch.analysis,
        category: patch.category,
        status: patch.status,
        cardDimension: patch.cardDimension,
        latestUserCount: !isNaN(hit) && hit > 0 ? hit : 0,
        ...(prevUserCount !== undefined ? { prevUserCount } : {}),
        lastCheckedAt: '',
        createdAt: now,
        updatedAt: now
      });
      added++;
    }
  }
  if (added + updated > 0) save(list, framework);
  logger.info(`[failure-library] import csv added=${added} updated=${updated} skipped=${skipped} framework=${framework || 'single'}`);
  return { added, updated, skipped };
}

module.exports = { list, add, update, remove, clearAll, updateUserCounts, countCombos, importFromSummaries, aiReferenceText, resolveCodeFields, buildNonProblemFilter, exportCsv, importCsv };
