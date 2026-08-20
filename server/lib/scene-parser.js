/**
 * 巡检场景解析器
 *
 * 输入：完整的请求 URL（log_search 页面）+ 请求体 JSON
 * 输出：巡检场景定义草案 + 交叉校验结果
 *
 * 解析规则（已与用户确认）：
 *   - URL 的 logSearchParams.filterConditionList 与请求体 filterCondition 一一对应（symbol -> 过滤器类型）
 *   - queryString 以请求体为准（"*"）
 *   - cluster 从请求体提取，保存为场景字段（执行时可动态覆盖）
 *   - 时间范围、id、分页参数不存入场景（每次执行时动态传入）
 *   - dynamicTableColumns 提取为 focusFields（响应数据处理重点关注字段）
 *   - orderFieldName / orderType 从请求体提取存入场景（排序字段）
 */

/** symbol -> filterCondition 中的过滤器类型 */
const SYMBOL_TO_FILTER = {
  in: 'inFilters',
  'not in': 'notInFilters',
  '=': 'equalFilters',
  '!=': 'notEqualFilters',
  exists: 'existFilters',
  'does not exist': 'notExistFilters',
  like: 'likeFilters',
  'not like': 'notLikeFilters',
  '>': 'greaterThanFilters',
  '<': 'lessThanFilters',
  '>=': 'greaterFilters',
  '<=': 'lessFilters'
};

/** 请求体 filterCondition 中所有过滤器类型（规范顺序） */
const FILTER_KEYS = [
  'mustFilters', 'mustNotFilters', 'greaterThanFilters', 'lessThanFilters',
  'greaterFilters', 'lessFilters', 'shouldFilters', 'inFilters', 'notInFilters',
  'equalFilters', 'notEqualFilters', 'likeFilters', 'notLikeFilters',
  'existFilters', 'notExistFilters'
];

/** 从 URL 中提取 logSearchParams 并解码为对象 */
function extractLogSearchParams(urlStr) {
  if (!urlStr) return null;
  const url = new URL(urlStr);
  const hash = url.hash || ''; // e.g. #/log_search#&logConsoleId=...&logSearchParams=...
  const paramsStr = hash.split('#/log_search').pop() || '';
  const params = new URLSearchParams(paramsStr.startsWith('#') ? paramsStr.slice(1) : paramsStr);
  const raw = params.get('logSearchParams');
  if (!raw) return null;
  try {
    // 部分浏览器/工具可能已经解码一次，此处做一次解码容错
    const decoded = decodeURIComponent(raw);
    const text = decoded.startsWith('{') ? decoded : raw;
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * 从 curl 命令中提取请求体 JSON
 * 支持：curl 'url' -H '..' --data-raw '{...}' / --data '...' / -d '...'
 * 单引号包裹（DevTools/Windows 复制）与双引号包裹（Linux）均支持
 * @returns {string|null} 提取到的 JSON 字符串
 */
function extractCurlBody(bodyStr) {
  const text = String(bodyStr);
  if (!/^\s*curl/i.test(text)) return null;
  // 单引号包裹：--data-raw '{"name":"x"}'（JSON 内无单引号，直接截取到下一个单引号）
  const single = text.match(/(?:--data-raw|--data)\s+'([^']*)'/i);
  if (single) return single[1];
  // 双引号包裹：--data-raw "{\"name\":\"x\"}"（处理转义双引号）
  const double = text.match(/(?:--data-raw|--data|-d)\s+"((?:[^"\\]|\\.)*)"/i);
  if (double) return double[1].replace(/\\"/g, '"');
  return null;
}

/**
 * 解析请求体 JSON 字符串
 * 支持纯 JSON 或 curl 命令（自动提取 --data-raw/-d 部分）
 * @returns {object} 请求体对象
 */
function parseRequestBody(bodyStr) {
  if (!bodyStr || !String(bodyStr).trim()) throw new Error('请求体不能为空');
  let text = String(bodyStr).trim();

  // curl 命令：提取 --data-raw / -d 后的 JSON
  const curlBody = extractCurlBody(text);
  if (curlBody !== null) text = curlBody;

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`请求体不是有效 JSON（已尝试自动提取 curl 的 --data-raw 部分）：${e.message}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return obj;
}

/** 将 URL filterConditionList 转换为标准 filterCondition 结构 */
function urlListToFilterCondition(list) {
  const result = {};
  for (const key of FILTER_KEYS) result[key] = [];
  if (!Array.isArray(list)) return result;
  for (const item of list) {
    const type = SYMBOL_TO_FILTER[item.symbol];
    if (!type) continue;
    const entry = {};
    entry[item.key] = { propertyList: Array.isArray(item.value) ? item.value : [], disabled: false };
    result[type].push(entry);
  }
  return result;
}

/** 从 filterCondition 中查找指定 key 的条目 */
function findFilterEntry(filterCondition, type, key) {
  const arr = filterCondition[type] || [];
  return arr.find((e) => Object.prototype.hasOwnProperty.call(e, key)) || null;
}

/** 判断两个 propertyList 是否一致（顺序无关） */
function samePropertyList(a, b) {
  const sa = [...new Set((a || []).map(String))].sort();
  const sb = [...new Set((b || []).map(String))].sort();
  return JSON.stringify(sa) === JSON.stringify(sb);
}

/** 规范 filterCondition：去除空的过滤器数组 */
function normalizeFilterCondition(fc) {
  const result = {};
  for (const key of FILTER_KEYS) {
    if (Array.isArray(fc[key]) && fc[key].length > 0) result[key] = fc[key];
  }
  return result;
}

/**
 * 解析 URL + 请求体，生成场景定义草案并做交叉校验
 * @param {string} urlStr 完整请求 URL
 * @param {string} bodyStr 请求体 JSON 字符串
 * @returns {{ scene: object, warnings: string[] }}
 */
function parseAndValidate(urlStr, bodyStr) {
  const warnings = [];
  const logParams = extractLogSearchParams(urlStr);
  if (!logParams) warnings.push('URL 中未解析到 logSearchParams（可能不是 log_search 页面 URL）');

  const body = parseRequestBody(bodyStr);

  /* ---------- 1. 基础字段 ---------- */
  const table = body.name || (logParams && logParams.logSpaceName) || '';
  const cluster = body.cluster || '';
  const dataSourceServiceId = body.dataSourceServiceId || (logParams && logParams.logConsoleId) || '';
  const granularity = body.granularity !== undefined ? body.granularity : (logParams && logParams.granularity) || 0;
  // queryString 以请求体为准（用户确认）
  const queryString = body.filterCondition && body.filterCondition.queryString !== undefined
    ? body.filterCondition.queryString
    : (logParams && logParams.queryString) || '*';

  // 关注字段：URL dynamicTableColumns（用户重点关注的字段，用于响应数据处理）
  const focusFields = (logParams && Array.isArray(logParams.dynamicTableColumns) ? logParams.dynamicTableColumns : [])
    .map(String);

  // 聚类字段：默认不配置，由用户在场景管理页从关注字段中手动勾选（不再默认内码/外码）
  const clusterFields = [];

  // 排序字段：从请求体提取（用户确认存入场景）
  const orderFieldName = body.orderFieldName !== undefined ? body.orderFieldName : '';
  const orderType = body.orderType !== undefined ? body.orderType : '';

  /* ---------- 2. filterCondition：以请求体为准 ---------- */
  const bodyFC = (body.filterCondition && typeof body.filterCondition === 'object') ? body.filterCondition : {};
  const filterCondition = normalizeFilterCondition({
    ...bodyFC,
    queryString: undefined // queryString 单独处理
  });

  /* ---------- 3. 交叉校验 ---------- */
  if (logParams && Array.isArray(logParams.filterConditionList) && logParams.filterConditionList.length > 0) {
    const urlFC = urlListToFilterCondition(logParams.filterConditionList);
    for (const item of logParams.filterConditionList) {
      const type = SYMBOL_TO_FILTER[item.symbol];
      if (!type) {
        warnings.push(`URL 条件 ${item.key} 使用了未支持的符号 "${item.symbol}"，已忽略`);
        continue;
      }
      const urlEntry = findFilterEntry(urlFC, type, item.key);
      const bodyEntry = findFilterEntry(filterCondition, type, item.key);
      if (!bodyEntry) {
        warnings.push(`URL 有条件 ${item.key}(${item.symbol})，但请求体中缺少该条件`);
      } else if (!samePropertyList(urlEntry[item.key].propertyList, bodyEntry[item.key].propertyList)) {
        warnings.push(
          `条件 ${item.key} 的取值不一致：URL=${JSON.stringify(item.value)}，请求体=${JSON.stringify(bodyEntry[item.key].propertyList)}（以请求体为准）`
        );
      }
    }
  }

  // 表名一致性
  if (logParams && logParams.logSpaceName && body.name && logParams.logSpaceName !== body.name) {
    warnings.push(`表名不一致：URL logSpaceName=${logParams.logSpaceName}，请求体 name=${body.name}（以请求体为准）`);
  }
  // queryString 差异提示
  if (logParams && logParams.queryString !== undefined && String(logParams.queryString) !== String(queryString)) {
    warnings.push(`queryString 不一致：URL="${logParams.queryString}"，请求体="${queryString}"（以请求体为准）`);
  }

  /* ---------- 4. 生成场景定义草案 ---------- */
  const scene = {
    id: null, // 保存时生成
    title: '', // 用户填写
    table,
    cluster,
    queryString: String(queryString),
    granularity,
    dataSourceServiceId,
    orderFieldName: String(orderFieldName),
    orderType: String(orderType),
    focusFields,
    clusterFields,
    clusterSubFields: {},
    // 统计展示列：按「一级聚类维度」独立配置（clusterStatFields[一级字段] = [统计字段]），来源为关注字段；
    // 未配置的维度不展示统计列（兼容旧版场景级 statFields 数组由前端迁移为各维度共享）
    clusterStatFields: {},
    filterCondition,
    createdAt: null
  };

  if (!table) warnings.push('未识别到表名（请求体 name / URL logSpaceName 均为空）');
  if (!cluster) warnings.push('未识别到 cluster（请求体 cluster 为空，执行时可能失败）');

  return { scene, warnings };
}

module.exports = { parseAndValidate, parseRequestBody, extractCurlBody, extractLogSearchParams, SYMBOL_TO_FILTER };
