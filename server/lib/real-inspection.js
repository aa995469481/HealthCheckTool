/**
 * 真实巡检结果构建 - 将 ClickHouse 查询返回的原始记录解析为
 * 与前端展示兼容的巡检结果结构（结构对齐 mock-inspection.js 的输出）
 */
const { SCENARIO_DEFS } = require('./mock-inspection');

function pad(n) {
  return String(n).padStart(2, '0');
}
function formatTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 从记录提取错误码（优先 inCode/extCode，其次解析 walletEventDesc 前缀数字） */
function extractErrorCode(record) {
  if (record.walletEventInCode) return String(record.walletEventInCode);
  if (record.walletEventExtCode) return String(record.walletEventExtCode);
  const desc = String(record.walletEventDesc || '');
  const m = desc.match(/^(\d+):/);
  return m ? m[1] : '未知错误';
}

/**
 * 构建单场景巡检结果
 * @param {object} def 场景定义
 * @param {object} q   { total, records, pages }
 */
function buildScenarioResult(def, q) {
  const total = q.total;
  const records = q.records;
  const failed = records.length;

  // 失败分布：错误码 -> { count, 样例描述 }
  const distMap = new Map();
  for (const r of records) {
    const code = extractErrorCode(r);
    if (!distMap.has(code)) {
      distMap.set(code, { code, count: 0, sample: String(r.walletEventDesc || '').slice(0, 120) });
    }
    distMap.get(code).count++;
  }
  const failureDistribution = Array.from(distMap.values()).sort((a, b) => b.count - a.count);

  const successRate = total > 0 ? Number(((total - failed) / total * 100).toFixed(1)) : 0;
  const summary = failed > 0
    ? `此次巡检命中失败日志 ${failed} 条（服务器总数 ${total} 条），错误码分布：${failureDistribution.map((d) => `${d.code}(${d.count})`).join('、') || '无'}。`
    : `此次巡检未发现失败日志（服务器总数 ${total} 条）。`;

  return {
    id: def.id,
    title: def.title,
    table: def.table,
    cluster: def.cluster,
    status: failed > 0 ? 'failed' : 'success',
    serverTotal: total,
    fetchedCount: records.length,
    statTotal: total,
    summary,
    stats: {
      hit: total,
      success: total - failed,
      failed,
      successRate
    },
    failureDistribution,
    appVer: null
  };
}

/**
 * 构建一次完整巡检结果（真实数据）
 * @param {object} profile 巡检计划
 * @param {Map} queryResults  scenarioId -> { total, records, pages }
 */
function buildInspectionResult(profile, queryResults) {
  const enabled = profile.enabled_scenarios || [];
  const exportedAt = formatTime();

  const scenarios = [];
  for (const id of enabled) {
    const def = SCENARIO_DEFS.find((s) => s.id === id);
    if (!def) continue;
    const q = queryResults.get(id);
    if (!q) continue;
    scenarios.push(buildScenarioResult(def, q));
  }

  const hasFailed = scenarios.some((s) => s.status === 'failed');

  return {
    filename: `health-check-${exportedAt.replace(/[-: ]/g, '')}.json`,
    exportedAt,
    planName: profile.name || '未命名计划',
    appVer: profile.app_ver || '',
    beginTimestamp: profile.beginTimestamp || '',
    endTimestamp: profile.endTimestamp || '',
    enabledScenarios: enabled,
    scenarios,
    summary: `本次巡检共执行 ${scenarios.length} 个场景，${scenarios.filter((s) => s.status === 'success').length} 个正常，${scenarios.filter((s) => s.status === 'failed').length} 个存在失败记录。`,
    partial: hasFailed
  };
}

module.exports = { buildInspectionResult, extractErrorCode };
