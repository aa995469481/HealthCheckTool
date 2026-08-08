/**
 * 真实巡检结果构建 - 将 ClickHouse 查询返回的原始记录解析为
 * 与前端展示兼容的巡检结果结构
 *
 * 支持自定义巡检场景（含 focusFields：用户重点关注的字段，用于响应数据处理）。
 */
function pad(n) {
  return String(n).padStart(2, '0');
}
function formatTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 从记录提取错误码（优先 inCode/extCode，其次解析 walletEventDesc 前缀数字，最后用 focusFields 中的错误码字段） */
function extractErrorCode(record, focusFields = []) {
  // 场景关注字段中若指定了错误码字段，优先使用
  const codeFields = ['walletEventInCode', 'walletEventExtCode'];
  for (const field of [...codeFields, ...focusFields]) {
    if (record[field] !== undefined && record[field] !== null && String(record[field]) !== '') {
      return String(record[field]);
    }
  }
  const desc = String(record.walletEventDesc || '');
  const m = desc.match(/^(\d+):/);
  return m ? m[1] : '未知错误';
}

/**
 * 构建单场景巡检结果
 * @param {object} scene 场景定义（含 focusFields）
 * @param {object} q   { total, records, pages }
 */
function buildScenarioResult(scene, q) {
  const total = q.total;
  const records = q.records;
  const failed = records.length;

  // 失败分布：错误码 -> { count, 样例描述 }
  const distMap = new Map();
  for (const r of records) {
    const code = extractErrorCode(r, scene.focusFields || []);
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
    id: scene.id,
    title: scene.title,
    table: scene.table,
    cluster: scene.cluster,
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
    focusFields: scene.focusFields || [],
    appVer: null
  };
}

/**
 * 构建一次完整巡检结果（真实数据）
 * @param {object} profile 巡检计划
 * @param {Map} queryResults  scenarioId -> { total, records, pages }
 * @param {Array} scenes 自定义场景定义数组
 */
function buildInspectionResult(profile, queryResults, scenes) {
  const enabled = profile.enabled_scenarios || [];
  const exportedAt = formatTime();

  const scenarios = [];
  for (const id of enabled) {
    const scene = (scenes || []).find((s) => s.id === id);
    if (!scene) continue;
    const q = queryResults.get(id);
    if (!q) continue;
    scenarios.push(buildScenarioResult(scene, q));
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
