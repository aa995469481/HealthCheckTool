/**
 * ClickHouse 真实数据查询客户端 - 调用 Wise DevOps queryWithTotal 接口
 *
 * 特性：
 *   - 请求体完全对齐用户提供的真实请求（filterCondition 过滤结构）
 *   - 请求头除 cookie / x-csrf-token 外全部固定（对齐用户提供的 curl）
 *   - 完整请求体与响应体写入日志（便于问题定位）
 *   - 支持分页拉取（pageSize 500，自动翻页直到取完 total）
 *   - 凭据从 server/data/secrets.yaml 读取
 */
const https = require('https');
const crypto = require('crypto');
const config = require('../config');
const { logger } = require('./logger');
const secretsStore = require('./secrets-store');

/** Wise DevOps 日志查询接口地址 */
const QUERY_URL =
  'https://console-drcn.wisedevops.huawei.com/edge/WiseEyeAIOpsService/aiops/gateway/api/logretrieval/api/clickhouse/queryWithTotal/';

/** 单页大小与最大翻页数 */
const PAGE_SIZE = 500;
const MAX_PAGES = 50;

/** 试点场景使用的过滤条件（对齐用户提供的真实请求体） */
const PILOT_FILTER_CONDITION = {
  mustFilters: [],
  mustNotFilters: [],
  greaterThanFilters: [],
  lessThanFilters: [],
  greaterFilters: [],
  lessFilters: [],
  shouldFilters: [],
  inFilters: [{ funcID: { propertyList: ['005', '010'], disabled: false } }],
  notInFilters: [
    { walletEventID: { propertyList: ['TransportCard_005_006', 'TransportCard_010_003'], disabled: false } }
  ],
  equalFilters: [
    { eventId: { propertyList: ['TransportCard'], disabled: false } },
    { funcResult: { propertyList: ['3'], disabled: false } }
  ],
  notEqualFilters: [{ walletEventExtCode: { propertyList: ['2101'], disabled: false } }],
  likeFilters: [],
  notLikeFilters: [],
  existFilters: [],
  notExistFilters: [{ wearWalletModel: { propertyList: [], disabled: false } }],
  queryString: '*'
};

/** 'YYYY-MM-DD' 或毫秒时间戳字符串 -> 毫秒数；空则默认今天 00:00(+08:00) */
function toTimestampMs(dateStr, isEnd) {
  if (dateStr === '' || dateStr == null) {
    const d = new Date();
    if (isEnd) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (/^\d{10,13}$/.test(String(dateStr))) return Number(dateStr);
  return new Date(`${String(dateStr)}T${isEnd ? '23:59:59' : '00:00:00'}+08:00`).getTime();
}

/** POST JSON 请求（返回完整响应体字符串与状态码） */
function httpJsonPost(urlStr, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    let receivedBytes = 0;
    try {
      const url = new URL(urlStr);
      const payload = JSON.stringify(bodyObj);
      const h = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers
      };
      req = https.request(
        url,
        { method: 'POST', headers: h, timeout: timeoutMs },
        (res) => {
          let body = '';
          res.setEncoding('utf-8');
          res.on('data', (c) => {
            body += c;
            receivedBytes = Buffer.byteLength(body);
            if (body.length > 20 * 1024 * 1024) {
              req.destroy();
              reject(new Error('响应体超过 20MB'));
            }
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }
      );
    } catch (e) {
      return reject(e);
    }
    req.on('timeout', () => {
      // 记录已接收字节数，便于判断服务器是否在响应中
      req.destroy(new Error(`request timeout after ${timeoutMs}ms, receivedBytes=${receivedBytes}`));
    });
    req.on('error', (e) => reject(e));
    req.end();
  });
}

/** 构建固定请求头（cookie / csrf 动态注入，其余对齐 curl） */
function buildRequestHeaders(cookie, csrfToken) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: 'https://console-drcn.wisedevops.huawei.com',
    referer: 'https://console-drcn.wisedevops.huawei.com/microApp/serviceInsight/aiops5Logservice',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    service: 'com.huawei.wisecloudvirtualcardmgmtservice',
    'serviceinsight-console-service': 'com.huawei.wisecloudvirtualcardmgmtservice',
    'x-wisecloud-application-id': 'com.huawei.wallet',
    'x-wisecloud-language-code': 'zh-cn',
    'x-wisecloud-route': 'cn_product_default',
    'x-wisecloud-service-id': 'com.huawei.wisecloudvirtualcardmgmtservice',
    'x-wisecloud-site': 'cn_product_default',
    'x-wisecloud-tenant-id': 'T011'
  };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  if (cookie) headers['cookie'] = cookie;
  return headers;
}

/**
 * 构建一次查询的完整请求体（内部统一将时间转为毫秒时间戳）
 * @param {object} opts { name, cluster, beginTimestamp, endTimestamp, pageNo, pageSize, app_ver }
 */
function buildRequestBody(opts = {}) {
  const filterCondition = JSON.parse(JSON.stringify(PILOT_FILTER_CONDITION));
  // 文档 2.2：app_ver 注入 inFilters（未填则不加）
  if (opts.app_ver) {
    filterCondition.inFilters.push({ _app_ver: { propertyList: [opts.app_ver], disabled: false } });
  }
  return {
    id: crypto.randomUUID(),
    name: opts.name || 'wallet_client_hmos',
    cluster: opts.cluster || 'ulan1-aiops-ch-az1-4',
    beginTimestamp: toTimestampMs(opts.beginTimestamp, false),
    endTimestamp: toTimestampMs(opts.endTimestamp, true),
    pageNo: opts.pageNo || 1,
    pageSize: opts.pageSize || PAGE_SIZE,
    filterCondition,
    limit: 0,
    granularity: 0,
    dataSourceServiceId: 'com.huawei.wisecloudvirtualcardmgmtservice',
    orderFieldName: '',
    orderType: ''
  };
}

/**
 * 查询一次（单页），完整记录请求体与响应体日志
 * @returns {Promise<{status:number, total:number, records:Array, histogram:Array}>}
 */
async function queryOnce(requestBody) {
  const cred = secretsStore.getCredentialPair();
  if (!cred.cookie || !cred.xCsrfToken) {
    throw new Error('凭据未配置，请先在「凭据设置」中完成 Wise 登录');
  }

  const headers = buildRequestHeaders(cred.cookie, cred.xCsrfToken);
  logger.info(`[clickhouse] === REQUEST BODY (page=${requestBody.pageNo}) ===\n${JSON.stringify(requestBody, null, 2)}`);

  const res = await httpJsonPost(QUERY_URL, headers, requestBody, config.queryTimeoutMs);

  logger.info(`[clickhouse] === RESPONSE status=${res.status} (page=${requestBody.pageNo}) ===`);
  try {
    logger.info(`[clickhouse] RESPONSE BODY:\n${res.body}`);
  } catch (e) {
    logger.error('[clickhouse] write response log failed', e);
  }

  if (res.status !== 200) {
    throw new Error(`查询接口返回异常状态码 ${res.status}`);
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`响应体解析失败：${e.message}`);
  }
  return {
    status: res.status,
    total: Number(json.total) || 0,
    records: Array.isArray(json.result) ? json.result : [],
    histogram: Array.isArray(json.histogram) ? json.histogram : []
  };
}

/**
 * 执行完整巡检查询（自动分页拉取所有记录）
 * @param {object} params { name, cluster, beginTimestamp, endTimestamp, app_ver }
 * @returns {Promise<{ total:number, records:Array, histogram:Array, pages:number }>}
 */
async function queryWithTotal(params = {}) {
  const beginTimestamp = toTimestampMs(params.beginTimestamp, false);
  const endTimestamp = toTimestampMs(params.endTimestamp, true);

  const allRecords = [];
  let histogram = [];
  let total = 0;
  let pages = 0;

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const requestBody = buildRequestBody({
      name: params.name,
      cluster: params.cluster,
      beginTimestamp,
      endTimestamp,
      pageNo,
      pageSize: PAGE_SIZE,
      app_ver: params.app_ver
    });

    const page = await queryOnce(requestBody);
    pages++;
    allRecords.push(...page.records);
    total = page.total;
    if (page.histogram.length) histogram = page.histogram;

    logger.info(`[clickhouse] page=${pageNo} got=${page.records.length} accumulated=${allRecords.length} total=${total}`);
    // 已取完或该页为空
    if (allRecords.length >= total || page.records.length === 0) break;
  }

  return { total, records: allRecords, histogram, pages, beginTimestamp, endTimestamp };
}

module.exports = {
  QUERY_URL,
  PAGE_SIZE,
  buildRequestBody,
  queryWithTotal,
  toTimestampMs,
  PILOT_FILTER_CONDITION
};
