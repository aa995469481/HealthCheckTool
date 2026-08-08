/**
 * 聚类摘要 - 将巡检原始记录按内码分组，生成精简的结构化摘要
 *
 * 设计约定（与用户确认）：
 *   - 主键：walletEventInCode（内码）；记录内码为空时归为「空内码」一类
 *   - 组内：按 walletEventExtCode（外码）出现次数降序排序
 *   - 统计维度：条数/占比、时间分布（小时）、版本分布（_app_ver）
 *   - 小聚类：占比 < 1% 且条数 < 5 的内码组合并到「其他」，只列总条数
 *   - 代表样本：每组抽 2 条，优先非空字段多，且尽量覆盖不同版本/时段
 *
 * 产出：结构化 JSON（前端展示 + 大模型分析共用），并附 toMarkdown() 文本供喂模型
 */
const { logger } = require('./logger');

/* ---------- 字段容错解析 ---------- */

/** 从关注字段里找一个字段：优先完全匹配，其次模糊匹配关键词 */
function pickField(focusFields, exactName, keyword) {
  if (!Array.isArray(focusFields) || focusFields.length === 0) return exactName;
  for (const f of focusFields) {
    if (String(f) === exactName) return String(f);
  }
  for (const f of focusFields) {
    if (String(f).toLowerCase().includes(keyword.toLowerCase())) return String(f);
  }
  return exactName;
}

function resolveFields(scene) {
  const focusFields = (scene && scene.focusFields) || [];
  const inCodeField = pickField(focusFields, 'walletEventInCode', 'InCode');
  const extCodeField = pickField(focusFields, 'walletEventExtCode', 'ExtCode');
  const versionField = pickField(focusFields, '_app_ver', 'app_ver');
  const timeField = pickField(focusFields, 'happenedTime', 'Time');
  return { focusFields, inCodeField, extCodeField, versionField, timeField };
}

/* ---------- 值处理 ---------- */

function fieldValue(record, field) {
  if (!record) return '';
  const v = record[field];
  return v === null || v === undefined ? '' : String(v);
}

/** 解析 happenedTime -> { hour, day }，无法解析返回 null */
function parseHour(value) {
  if (!value) return null;
  const s = String(value);
  let m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):/);
  if (m) return { day: m[1], hour: m[2].padStart(2, '0') };
  // 毫秒时间戳
  if (/^\d{10,13}$/.test(s)) {
    const d = new Date(Number(s));
    if (!isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      return { day, hour: p(d.getHours()) };
    }
  }
  return null;
}

/** 记录信息完整度：非空字段数（用于挑选代表样本） */
function richness(record, fields) {
  let score = 0;
  for (const f of fields) {
    const v = record[f];
    if (v !== null && v !== undefined && String(v) !== '') score++;
  }
  return score;
}

/* ---------- 主逻辑 ---------- */

/**
 * 生成一个场景的聚类摘要
 * @param {object} scene  场景 { title, focusFields, ... }
 * @param {Array}  records 原始记录数组
 * @returns {object} 聚类摘要
 */
function buildClusterSummary(scene, records) {
  const { focusFields, inCodeField, extCodeField, versionField, timeField } = resolveFields(scene);
  const total = Array.isArray(records) ? records.length : 0;

  // 1. 按内码分组
  const groupsMap = new Map(); // inCode -> { inCode, records: [] }
  for (const r of records || []) {
    const key = fieldValue(r, inCodeField) || ''; // 空内码也是一类
    if (!groupsMap.has(key)) groupsMap.set(key, { inCode: key, records: [] });
    groupsMap.get(key).records.push(r);
  }

  // 2. 计算每组统计
  const rawGroups = [];
  for (const { inCode, records: list } of groupsMap.values()) {
    const count = list.length;
    const percent = total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0;

    // 外码分布（降序），含占比
    const extMap = new Map();
    for (const r of list) {
      const ext = fieldValue(r, extCodeField) || '';
      extMap.set(ext, (extMap.get(ext) || 0) + 1);
    }
    const extCodes = [...extMap.entries()]
      .map(([code, c]) => ({ code, count: c, percent: Number(((c / count) * 100).toFixed(1)) }))
      .sort((a, b) => b.count - a.count);

    // 版本分布
    const verMap = new Map();
    for (const r of list) {
      const v = fieldValue(r, versionField) || '未知';
      verMap.set(v, (verMap.get(v) || 0) + 1);
    }
    const versionDist = [...verMap.entries()]
      .map(([v, c]) => ({ version: v, count: c }))
      .sort((a, b) => b.count - a.count);

    rawGroups.push({
      inCode: inCode === '' ? '(空内码)' : inCode,
      inCodeRaw: inCode,
      count,
      percent,
      versionDist,
      extCodes,
      records: list
    });
  }

  // 3. 小聚类合并（占比 < 1% 且条数 < 5 -> 其他）
  const SMALL_PERCENT = 1;
  const SMALL_COUNT = 5;
  const mainGroups = [];
  let othersCount = 0;
  for (const g of rawGroups) {
    if (g.percent < SMALL_PERCENT && g.count < SMALL_COUNT) {
      othersCount += g.count;
    } else {
      mainGroups.push(g);
    }
  }
  mainGroups.sort((a, b) => b.count - a.count);

  // 4. 代表样本：每组抽 2 条（信息全 + 覆盖不同版本/时段）
  for (const g of mainGroups) {
    const candidates = g.records.slice().sort((a, b) => richness(b, focusFields) - richness(a, focusFields));
    const samples = [candidates[0]];
    // 第二条优先选与第一条版本/时段不同的
    let picked = null;
    for (let i = 1; i < candidates.length; i++) {
      const r = candidates[i];
      const sameVer = fieldValue(r, versionField) === fieldValue(samples[0], versionField);
      const sameHour = parseHour(fieldValue(r, timeField))?.hour === parseHour(fieldValue(samples[0], timeField))?.hour;
      if (!sameVer || !sameHour) { picked = r; break; }
    }
    if (picked) samples.push(picked);
    else if (candidates[1]) samples.push(candidates[1]);
    g.samples = samples;
    delete g.records; // 精简输出
  }

  const summary = {
    scenarioTitle: scene && scene.title ? scene.title : '',
    fields: { inCodeField, extCodeField, versionField, timeField },
    total,
    groups: mainGroups.map(({ inCode, inCodeRaw, count, percent, versionDist, extCodes, samples }) => ({
      inCode,
      inCodeRaw,
      count,
      percent,
      versionDist,
      extCodes,
      samples
    })),
    others: othersCount > 0 ? { count: othersCount, note: '占比<1%且条数<5的小聚类合并' } : null
  };

  logger.info(
    `[cluster] scene=${summary.scenarioTitle} total=${total} groups=${mainGroups.length} others=${othersCount}`
  );
  return summary;
}

/* ---------- Markdown 文本（喂大模型用） ---------- */

function toMarkdown(summary) {
  const lines = [];
  lines.push(`## 场景：${summary.scenarioTitle}`);
  lines.push(`- 命中总数：${summary.total} 条`);
  lines.push(`- 内码分组数：${summary.groups.length} 组` + (summary.others ? `，其他小聚类 ${summary.others.count} 条` : ''));
  lines.push('');

  for (const g of summary.groups) {
    lines.push(`### 内码 ${g.inCode}`);
    lines.push(`条数：${g.count}（占比 ${g.percent}%）`);
    if (g.versionDist && g.versionDist.length) {
      lines.push(`版本分布：${g.versionDist.map((v) => `${v.version} ${v.count}条`).join('、')}`);
    }
    if (g.extCodes && g.extCodes.length) {
      lines.push(`外码分布（按次数降序，含占比）：${g.extCodes.map((e) => `${e.code} ${e.count}条(${e.percent}%)`).join('、')}`);
    }
    for (let i = 0; i < g.samples.length; i++) {
      lines.push(`样本${i + 1}：${JSON.stringify(g.samples[i])}`);
    }
    lines.push('');
  }
  if (summary.others) {
    lines.push(`其他小聚类：${summary.others.count} 条（占比小，未细分）`);
  }
  return lines.join('\n');
}

module.exports = { buildClusterSummary, toMarkdown, resolveFields, parseHour };
