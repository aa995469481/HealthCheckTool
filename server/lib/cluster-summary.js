/**
 * 聚类摘要 - 将巡检原始记录按「用户勾选的聚类字段」多级分组，生成精简的结构化摘要
 *
 * 设计约定（与用户确认）：
 *   - 聚类字段 clusterFields 由用户在场景管理中勾选（默认内码 + 外码），顺序即分组层级
 *   - 第 1 个字段作为分组主键，第 2 个作为组内子维度（降序、含占比），可多级下钻
 *   - 每级统计：条数/占比、版本分布（_app_ver）
 *   - 小聚类：占比 < 1% 且条数 < 5 的分组并入「其他」，只列总条数
 *   - 代表样本：仅最底层叶子分组抽取 2 条（信息全 + 覆盖不同版本/时段）
 *
 * 产出：结构化 JSON（前端树形表格 + 大模型分析共用），并附 toMarkdown() 文本供喂模型
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
  const versionField = pickField(focusFields, '_app_ver', 'app_ver');
  return { focusFields, versionField };
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

/* ---------- 统计工具 ---------- */

function calcVersionDist(records, versionField) {
  const map = new Map();
  for (const r of records) {
    const v = fieldValue(r, versionField) || '未知';
    map.set(v, (map.get(v) || 0) + 1);
  }
  return [...map.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.count - a.count);
}

function pickSamples(records, focusFields, versionField) {
  const candidates = records.slice().sort((a, b) => richness(b, focusFields) - richness(a, focusFields));
  if (candidates.length === 0) return [];
  const samples = [candidates[0]];
  const firstHour = (parseHour(fieldValue(samples[0], 'happenedTime')) || {}).hour;
  let picked = null;
  for (let i = 1; i < candidates.length; i++) {
    const r = candidates[i];
    const sameVer = fieldValue(r, versionField) === fieldValue(samples[0], versionField);
    const hour = (parseHour(fieldValue(r, 'happenedTime')) || {}).hour;
    const sameHour = firstHour !== undefined && hour === firstHour;
    if (!sameVer || !sameHour) { picked = r; break; }
  }
  if (picked) samples.push(picked);
  else if (candidates[1]) samples.push(candidates[1]);
  return samples;
}

/* ---------- 主逻辑 ---------- */

/**
 * 生成一个场景的聚类摘要（多级递归分组）
 * @param {object} scene  场景 { title, focusFields, clusterFields, ... }
 * @param {Array}  records 原始记录数组
 * @returns {object} 聚类摘要
 */
function buildClusterSummary(scene, records) {
  const { focusFields, versionField } = resolveFields(scene);
  // 聚类字段：场景配置优先；缺失时默认内码 + 外码
  let clusterFields = Array.isArray(scene && scene.clusterFields) && scene.clusterFields.length
    ? scene.clusterFields.map(String)
    : ['walletEventInCode', 'walletEventExtCode'];
  // 去掉空项
  clusterFields = clusterFields.filter((f) => String(f).trim() !== '');
  const total = Array.isArray(records) ? records.length : 0;

  // 递归分组（多级）
  function buildLevel(list, levelIdx) {
    const isLast = levelIdx >= clusterFields.length - 1;
    const field = clusterFields[levelIdx];
    const groupMap = new Map();
    for (const r of list) {
      const key = fieldValue(r, field) || '';
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(r);
    }

    const raw = [];
    for (const [key, subList] of groupMap.entries()) {
      const count = subList.length;
      const percent = list.length > 0 ? Number(((count / list.length) * 100).toFixed(1)) : 0;
      const node = {
        nodeKey: `${levelIdx}-${field}=${key}`,
        key: key === '' ? '(空)' : key,
        field,
        count,
        percent,
        versionDist: calcVersionDist(subList, versionField)
      };
      if (isLast) {
        node.samples = pickSamples(subList, focusFields, versionField);
      } else {
        const sub = buildLevel(subList, levelIdx + 1);
        node.children = sub.groups;
        node.others = sub.othersCount;
      }
      raw.push(node);
    }

    // 小聚类合并（占比 < 1% 且条数 < 5 -> 其他）
    const SMALL_PERCENT = 1;
    const SMALL_COUNT = 5;
    const groups = [];
    let othersCount = 0;
    for (const g of raw) {
      if (g.percent < SMALL_PERCENT && g.count < SMALL_COUNT) {
        othersCount += g.count;
      } else {
        groups.push(g);
      }
    }
    groups.sort((a, b) => b.count - a.count);
    return { groups, othersCount };
  }

  const root = buildLevel(records || [], 0);

  const summary = {
    scenarioTitle: scene && scene.title ? scene.title : '',
    clusterFields,
    total,
    groups: root.groups,
    others: root.othersCount > 0 ? { count: root.othersCount, note: '占比<1%且条数<5的小聚类合并' } : null
  };

  logger.info(
    `[cluster] scene=${summary.scenarioTitle} fields=${clusterFields.join('>')} total=${total} groups=${root.groups.length} others=${root.othersCount}`
  );
  return summary;
}

/* ---------- Markdown 文本（喂大模型用） ---------- */

function toMarkdown(summary) {
  const lines = [];
  lines.push(`## 场景：${summary.scenarioTitle}`);
  lines.push(`- 命中总数：${summary.total} 条`);
  lines.push(`- 聚类字段（按层级）：${summary.clusterFields.join(' → ')}`);
  lines.push(`- 分组数：${summary.groups.length} 组` + (summary.others ? `，其他小聚类 ${summary.others.count} 条` : ''));
  lines.push('');

  function walk(groups, depth) {
    for (const g of groups) {
      const indent = '  '.repeat(depth);
      const prefix = depth === 0 ? '### ' : `${indent}- `;
      lines.push(`${prefix}${g.field}=${g.key}：${g.count}条（占比${g.percent}%）`);
      if (g.versionDist && g.versionDist.length) {
        lines.push(`${indent}  版本分布：${g.versionDist.map((v) => `${v.version} ${v.count}条`).join('、')}`);
      }
      if (g.children && g.children.length) {
        lines.push(`${indent}  下级分布：`);
        walk(g.children, depth + 1);
      }
      if (g.samples && g.samples.length) {
        g.samples.forEach((s, i) => {
          lines.push(`${indent}  样本${i + 1}：${JSON.stringify(s)}`);
        });
      }
      lines.push('');
    }
  }
  walk(summary.groups, 0);
  if (summary.others) {
    lines.push(`其他小聚类：${summary.others.count} 条（占比小，未细分）`);
  }
  return lines.join('\n');
}

module.exports = { buildClusterSummary, toMarkdown, resolveFields, parseHour };
