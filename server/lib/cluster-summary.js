/**
 * 聚类摘要 - 将巡检原始记录按「用户勾选的多个聚类字段」分别独立分组，生成精简的结构化摘要
 *
 * 设计约定（与用户确认）：
 *   - 聚类字段 clusterFields 由用户在场景管理中多选（默认内码 + 外码）
 *   - 每个字段都是独立的 1 级分析维度，各自按字段取值分组统计（并列展示，互不级联）
 *   - 字段排列顺序仅决定展示顺序，无层级含义
 *   - 每个维度统计：分组条数/占比、版本分布（_app_ver）
 *   - Top K：每个维度仅保留条数最多的前 7 个分组，其余并入「其他」只列总条数与组数
 *   - 小聚类：每个维度内，占比 < 1% 且条数 < 5 的分组同样并入「其他」
 *   - 代表样本：每个维度每组抽取 2 条（信息全 + 覆盖不同版本/时段）
 *
 * 产出：结构化 JSON（前端多维度表格 + 大模型分析共用），并附 toMarkdown() 文本供喂模型
 */
const { logger } = require('./logger');
const failureLibrary = require('./failure-library-store');

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

/** 统计展示列：按配置的统计字段统计取值分布（Top 前展示，其余计数展示） */
function calcFieldDist(records, statField) {
  const map = new Map();
  for (const r of records) {
    const v = fieldValue(r, statField) || '(空)';
    map.set(v, (map.get(v) || 0) + 1);
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

/** 为分组记录生成所有配置统计字段的分布（statFields 为空则返回空数组） */
function calcStatistics(subList, statFields) {
  if (!statFields || statFields.length === 0) return [];
  return statFields.map((f) => ({ field: f, dist: calcFieldDist(subList, f) }));
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
 * 生成一个场景的聚类摘要（多字段独立分组）
 * @param {object} scene  场景 { title, focusFields, clusterFields, ... }
 * @param {Array}  records 原始记录数组
 * @returns {object} 聚类摘要
 */
function buildClusterSummary(scene, records, framework) {
  const { focusFields, versionField } = resolveFields(scene);
  // 聚类字段：场景配置优先；缺失时默认内码 + 外码
  let clusterFields = Array.isArray(scene && scene.clusterFields) && scene.clusterFields.length
    ? scene.clusterFields.map(String)
    : ['walletEventInCode', 'walletEventExtCode'];
  clusterFields = clusterFields.filter((f) => String(f).trim() !== '');
  // 统计展示列：场景管理按「一级维度」独立配置（clusterStatFields[一级字段]），来源为关注字段；
  // 未配置的维度不展示统计列；兼容旧版场景级 statFields 作为兜底
  const statFieldsFor = (field) => {
    const per =
      scene && scene.clusterStatFields && Array.isArray(scene.clusterStatFields[field]) && scene.clusterStatFields[field].length
        ? scene.clusterStatFields[field]
        : null;
    const arr = per || (scene && Array.isArray(scene.statFields) && scene.statFields.length ? scene.statFields : []);
    return arr.map(String).filter((f) => focusFields.includes(f));
  };
  // 剔除失败场景库中已确认「非问题」的记录（匹配 场景+内码+外码+卡维度），不影响失败场景库数据
  const isNonProblem = failureLibrary.buildNonProblemFilter(scene, framework);
  const allRecords = isNonProblem ? (records || []).filter((r) => !isNonProblem(r)) : (records || []);
  const total = allRecords.length;
  const excludedCount = (Array.isArray(records) ? records.length : 0) - total;
  if (excludedCount > 0) {
    logger.info(`[cluster] excluded non-problem records=${excludedCount} scene=${scene && scene.title} total=${total}`);
  }

  // 对单个字段做一级分组统计，可带二级下钻字段；statFields 为该维度独立配置的统计展示列
  function buildDimension(field, subField, statFields) {
    // 每个维度仅保留条数 Top 7，其余并入其他
    const TOP_K = 7;
    const SMALL_PERCENT = 1;
    const SMALL_COUNT = 5;
    const groupMap = new Map();
    for (const r of allRecords) {
      const key = fieldValue(r, field) || '';
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(r);
    }

    const raw = [];
    for (const [key, subList] of groupMap.entries()) {
      const count = subList.length;
      const percent = total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0;
      const node = {
        nodeKey: `${field}=${key}`,
        key: key === '' ? '(空)' : key,
        field,
        count,
        percent,
        statistics: calcStatistics(subList, statFields),
        samples: pickSamples(subList, focusFields, versionField)
      };
      // 二级下钻：一级分组内再按 subField 细分
      if (subField) {
        const subMap = new Map();
        for (const r of subList) {
          const k2 = fieldValue(r, subField) || '';
          if (!subMap.has(k2)) subMap.set(k2, []);
          subMap.get(k2).push(r);
        }
        const subRaw = [];
        for (const [k2, subSubList] of subMap.entries()) {
          const c2 = subSubList.length;
          subRaw.push({
            nodeKey: `${field}=${key}|${subField}=${k2}`,
            key: k2 === '' ? '(空)' : k2,
            field: subField,
            count: c2,
            percent: count > 0 ? Number(((c2 / count) * 100).toFixed(1)) : 0,
            statistics: calcStatistics(subSubList, statFields),
            samples: pickSamples(subSubList, focusFields, versionField)
          });
        }
        subRaw.sort((a, b) => b.count - a.count);
        // 二级同样仅保留 Top 7（nodeKey 保留，供树形表格 row-key 使用）
        node.children = subRaw.slice(0, TOP_K);
        if (subRaw.length > TOP_K) {
          node.subOthersCount = subRaw.slice(TOP_K).reduce((sum, s) => sum + s.count, 0);
        }
      }
      raw.push(node);
    }

    // 小聚类合并（占比 < 1% 且条数 < 5 -> 其他）
    const sorted = raw.slice().sort((a, b) => b.count - a.count);
    const groups = [];
    let othersCount = 0;
    let othersGroups = 0;
    for (let i = 0; i < sorted.length; i++) {
      const g = sorted[i];
      const isSmall = g.percent < SMALL_PERCENT && g.count < SMALL_COUNT;
      if (i >= TOP_K || isSmall) {
        othersCount += g.count;
        othersGroups++;
      } else {
        groups.push(g);
      }
    }
    groups.sort((a, b) => b.count - a.count);

    return {
      field,
      groups,
      others: othersCount > 0
        ? { count: othersCount, groups: othersGroups, note: '仅保留 Top 7，其余并入此处' }
        : null
    };
  }

  const dimensions = clusterFields.map((field) => {
    const subField = (scene && scene.clusterSubFields && scene.clusterSubFields[field]) || null;
    const dim = buildDimension(field, subField, statFieldsFor(field));
    dim.subField = subField;
    dim.statFields = statFieldsFor(field);
    return dim;
  });

  const summary = {
    scenarioTitle: scene && scene.title ? scene.title : '',
    clusterFields,
    total,
    dimensions,
    others: null // 兼容旧字段：多维度下不再有全局 others
  };

  logger.info(
    `[cluster] scene=${summary.scenarioTitle} fields=[${clusterFields.join(', ')}] statFieldsByDim=[${clusterFields
      .map((f) => `${f}:${summary.dimensions.find((d) => d.field === f).statFields.join(',') || '无'}`)
      .join('; ')}] total=${total} dims=${dimensions.length}`
  );
  return summary;
}

/* ---------- Markdown 文本（喂大模型用） ---------- */

/** 输出配置的统计展示列分布文本，如「版本 _app_ver：v1 2条、v2 1条」 */
function statLine(statistics) {
  if (!statistics || statistics.length === 0) return null;
  return statistics
    .map((s) => `${s.field}：${s.dist.map((d) => `${d.value} ${d.count}条`).join('、')}`)
    .join('；');
}

function toMarkdown(summary) {
  const lines = [];
  lines.push(`## 场景：${summary.scenarioTitle}`);
  lines.push(`- 命中总数：${summary.total} 条`);
  lines.push(`- 聚类维度：${summary.clusterFields.join('、')}`);
  lines.push('');

  for (const dim of summary.dimensions) {
    lines.push(`### 维度 ${dim.field}（按该字段取值分组）` + (dim.subField ? `，二级下钻字段：${dim.subField}` : ''));
    for (const g of dim.groups) {
      lines.push(`- ${g.field}=${g.key}：${g.count}条（占比${g.percent}%）`);
      const line = statLine(g.statistics);
      if (line) lines.push(`  统计分布：${line}`);
      // 二级分组
      if (g.children && g.children.length) {
        lines.push(`  二级细分（${g.children.length} 组）：`);
        for (const sub of g.children) {
          lines.push(`    - ${sub.field}=${sub.key}：${sub.count}条（占一级${sub.percent}%）`);
          const subLine = statLine(sub.statistics);
          if (subLine) lines.push(`      统计分布：${subLine}`);
          if (sub.samples && sub.samples.length) {
            sub.samples.forEach((s, i) => {
              lines.push(`      样本${i + 1}：${JSON.stringify(s)}`);
            });
          }
        }
      }
      if (g.samples && g.samples.length && !g.children) {
        g.samples.forEach((s, i) => {
          lines.push(`  样本${i + 1}：${JSON.stringify(s)}`);
        });
      }
    }
    if (dim.others) {
      lines.push(`- 其他（其余 ${dim.others.groups} 个分组共 ${dim.others.count} 条，占比小/超出 Top 7，未细分）`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { buildClusterSummary, toMarkdown, resolveFields, parseHour };
