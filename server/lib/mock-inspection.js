/**
 * Mock 巡检数据层 - 在无法访问真实 ClickHouse 时提供模拟数据
 *
 * 说明：
 *   - 场景定义严格对齐《业务巡检功能详细介绍.txt》第三节
 *   - 巡检结果用确定性伪随机生成（seed = 场景ID），保证多次执行结果可复现，便于调试
 *   - 后续接入真实数据源时，仅需替换本模块内部实现，对外接口签名保持不变
 *
 * 对外接口：
 *   getCredentialStatus()            -> { configured, source, validUntil }
 *   listScenarios()                  -> [场景目录，按表分组]
 *   buildInspectionResult(profile)   -> { filename, exportedAt, beginTimestamp, endTimestamp, appVer, planName, scenarios: [结果] }
 */
const crypto = require('crypto');

/* ---------- 场景定义（对齐文档 2.3 节） ---------- */
const SCENARIO_DEFS = [
  {
    id: 'wallet_client_hmos/moveIn',
    title: '单框架交通卡迁入巡检日志',
    table: 'wallet_client_hmos',
    cluster: 'ulan1-aiops-ch-az1-4',
    enabled: true,
    failureField: 'funcResult',
    failureValues: [1],
    failureMatchMode: 'not_in'
  },
  {
    id: 'wallet_client_hmos/开卡',
    title: '单框架交通卡开卡巡检日志',
    table: 'wallet_client_hmos',
    cluster: 'ulan1-aiops-ch-az1-4',
    enabled: true,
    failureField: 'funcResult',
    failureValues: [1, 2],
    failureMatchMode: 'not_in'
  },
  {
    id: 'wallet_client_hmos/充值',
    title: '单框架交通卡充值巡检日志',
    table: 'wallet_client_hmos',
    cluster: 'ulan1-aiops-ch-az1-4',
    enabled: true,
    failureField: 'funcResult',
    failureValues: [1, 2],
    failureMatchMode: 'not_in'
  },
  {
    id: 'wallet_client_hmos/迁出',
    title: '单框架交通卡迁出巡检日志',
    table: 'wallet_client_hmos',
    cluster: 'ulan1-aiops-ch-az1-4',
    enabled: true,
    failureField: 'funcResult',
    failureValues: [1, 2],
    failureMatchMode: 'not_in'
  },
  {
    id: 'wallet_client_hmos/暂停服务',
    title: '单框架交通卡暂停服务巡检日志',
    table: 'wallet_client_hmos',
    cluster: 'ulan1-aiops-ch-az1-4',
    enabled: true,
    failureField: 'funcResult',
    failureValues: [0],
    failureMatchMode: 'not_in'
  },
  {
    id: 'wallet_client_hmos/注销服务',
    title: '单框架交通卡注销服务巡检日志',
    table: 'wallet_client_hmos',
    cluster: 'ulan1-aiops-ch-az1-4',
    enabled: true,
    failureField: 'funcResult',
    failureValues: [0],
    failureMatchMode: 'not_in'
  },
  {
    id: 'wallet_client/backup_restore_retry',
    title: 'Wallet 备份/恢复-retry 日志',
    table: 'wallet_client',
    cluster: 'ulan1-aiops-ch-az1-3',
    enabled: false, // 默认禁用
    failureField: 'internal_errcode',
    failureValues: [0],
    failureMatchMode: 'not_in'
  }
];

/* ---------- 输出字段（对齐文档 2.3 节交通卡场景） ---------- */
const RESPONSE_FIELDS = [
  'cplc', 'funcResult', 'happenedTime', 'issueID', 'issueName', 'uid',
  'walletEventDesc', 'walletEventExtCode', 'walletEventID', 'walletEventInCode', '_app_ver'
];

/* ---------- 工具 ---------- */
function pad(n) {
  return String(n).padStart(2, '0');
}
function formatTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 确定性伪随机数 [0, 1)，seed 固定则结果固定 */
function seededRandom(seedStr) {
  const h = crypto.createHash('sha256').update(seedStr).digest('hex');
  return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}

/** 在 [min, max] 之间生成确定性整数 */
function seededInt(seedStr, min, max) {
  return Math.floor(seededRandom(seedStr) * (max - min + 1)) + min;
}

/* ---------- 对外接口 ---------- */

/** 凭据状态（mock：固定未配置，模拟真实环境需登录） */
function getCredentialStatus() {
  return {
    configured: false,
    source: 'mock',
    validUntil: null,
    note: '当前为 Mock 模式，未配置 Wise DevOps 凭据'
  };
}

/** 场景目录（对齐文档，前端按表分组勾选） */
function listScenarios() {
  return SCENARIO_DEFS.map((s) => ({
    id: s.id,
    title: s.title,
    table: s.table,
    cluster: s.cluster,
    enabled: s.enabled,
    failureField: s.failureField,
    failureValues: s.failureValues,
    failureMatchMode: s.failureMatchMode,
    responseFields: RESPONSE_FIELDS
  }));
}

/**
 * 生成一次完整巡检的 Mock 结果
 * @param {object} profile { name, app_ver, beginTimestamp, endTimestamp, enabled_scenarios: [scenarioId] }
 * @returns 结构与真实巡检导出 JSON 对齐
 */
function buildInspectionResult(profile) {
  const enabled = profile.enabled_scenarios || SCENARIO_DEFS.filter((s) => s.enabled).map((s) => s.id);
  const defs = SCENARIO_DEFS.filter((s) => enabled.includes(s.id));

  const exportedAt = formatTime();
  const scenarios = defs.map((def) => {
    // 确定性基数：命中量在 80~500 之间
    const total = seededInt(`${def.id}|${profile.app_ver || 'default'}|total`, 80, 500);
    // 失败率 2%~18%
    const failureRate = 0.02 + seededRandom(`${def.id}|${profile.app_ver || 'default'}|rate`) * 0.16;
    const failed = Math.min(total, Math.max(1, Math.round(total * failureRate)));
    const success = total - failed;
    const successRate = (success / total) * 100;

    // 失败分布：按错误码分组（mock 错误码来自 walletEventInCode 字段）
    const failureDistribution = buildFailureDistribution(`${def.id}|${profile.app_ver || 'default'}|dist`, failed, def.failureValues);

    return {
      id: def.id,
      title: def.title,
      table: def.table,
      cluster: def.cluster,
      status: failed === 0 ? 'success' : 'failed',
      serverTotal: total,
      fetchedCount: total,
      statTotal: total,
      summary: `此次巡检命中了${total}条，其中成功了${success}条，失败了${failed}条，成功率为${successRate.toFixed(1)}%。`,
      stats: {
        hit: total,
        success,
        failed,
        successRate: Number(successRate.toFixed(1))
      },
      failureDistribution,
      appVer: profile.app_ver || null
    };
  });

  // 是否存在失败场景
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
    summary: `本次巡检共执行 ${scenarios.length} 个场景，${scenarios.filter((s) => s.status === 'success').length} 个成功，${scenarios.filter((s) => s.status === 'failed').length} 个存在失败记录。`,
    partial: hasFailed
  };
}

/** 构建失败分布：错误码 -> 条数（确定性） */
function buildFailureDistribution(seedStr, failedCount, okValues) {
  // mock 错误码集合
  const errorCodes = ['A0001', 'A0002', 'B0010', 'B0015', 'C1001', 'E5000'];
  const dist = [];
  let remaining = failedCount;
  let i = 0;
  while (remaining > 0 && i < errorCodes.length) {
    const share = i === errorCodes.length - 1 ? remaining : Math.max(1, Math.round(remaining / (errorCodes.length - i) * (0.4 + seededRandom(`${seedStr}|${i}`) * 0.6)));
    dist.push({ code: errorCodes[i], count: Math.min(share, remaining) });
    remaining -= Math.min(share, remaining);
    i++;
  }
  return dist;
}

module.exports = { getCredentialStatus, listScenarios, buildInspectionResult, SCENARIO_DEFS };
