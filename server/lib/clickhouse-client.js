/**
 * ClickHouse 真实数据查询客户端 - 调用 Wise DevOps queryWithTotal 接口
 *
 * 特性：
 *   - 通过系统 curl.exe 发送请求（格式完全对齐浏览器生成的 curl，规避网关拦截）
 *   - 请求体完全对齐用户提供的真实请求（filterCondition 过滤结构）
 *   - 请求头除 cookie / x-csrf-token 外全部固定（对齐用户提供的 curl）
 *   - 完整请求体 / curl 命令 / 响应体写入日志（便于问题定位）
 *   - 支持分页拉取（pageSize 500，自动翻页直到取完 total）
 *   - 凭据从 server/data/secrets.yaml 读取
 */
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

/**
 * 通过系统 curl.exe 发送 POST JSON 请求
 * 返回 { status:number, body:string }
 */
function curlJsonPost(urlStr, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const bodyFile = path.join(os.tmpdir(), `hcb-body-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);

    const args = ['-s', '-S', '--max-time', String(Math.floor(timeoutMs / 1000))];
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      args.push('-H', `${k}: ${v}`);
    }
    args.push('--data-raw', payload, '-o', bodyFile, '-w', '%{http_code}', urlStr);

    // 完整命令日志（cookie 值较长，便于定位请求差异）
    logger.info(`[clickhouse] CURL CMD:\ncurl ${args.map((a) => `"${a}"`).join(' ')}`);

    execFile(
      'curl',
      args,
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let body = '';
        try {
          body = fs.readFileSync(bodyFile, 'utf-8');
        } catch (e) {
          body = '';
        }
        try {
          fs.unlinkSync(bodyFile);
        } catch (e) {
          /* ignore */
        }

        const httpCode = String(stdout || '').trim();

        if (err) {
          if (err.killed) {
            return reject(new Error(`curl timeout after ${timeoutMs}ms`));
          }
          // curl 进程非零退出，输出 stderr 辅助定位
          const detail = (stderr || err.message || '').toString().slice(0, 2000);
          return reject(new Error(`curl failed: ${detail}`));
        }
        resolve({ status: Number(httpCode) || 200, body });
      }
    );
  });
}

/** 构建固定请求头（cookie / csrf 动态注入，其余完全对齐用户提供的 curl） */
function buildRequestHeaders(cookie, csrfToken) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    origin: 'https://console-drcn.wisedevops.huawei.com',
    priority: 'u=1, i',
    referer: 'https://console-drcn.wisedevops.huawei.com/microApp/serviceInsight/aiops5Logservice',
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    service: 'com.huawei.wisecloudvirtualcardmgmtservice',
    'serviceinsight-console-service': 'com.huawei.wisecloudvirtualcardmgmtservice',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
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
 * @returns {Promise<{status:number, total:number, records:Array, histogram:Array, rawBody:string}>}
 */
async function queryOnce(requestBody) {
  const cred = secretsStore.getCredentialPair();
  if (!cred.cookie || !cred.xCsrfToken) {
    throw new Error('凭据未配置，请先在「凭据设置」中完成 Wise 登录');
  }

  const headers = buildRequestHeaders(cred.cookie, cred.xCsrfToken);
  logger.info(`[clickhouse] === REQUEST BODY (page=${requestBody.pageNo}) ===\n${JSON.stringify(requestBody, null, 2)}`);

  const res = await curlJsonPost(QUERY_URL, headers, requestBody, config.queryTimeoutMs);

  logger.info(`[clickhouse] === RESPONSE status=${res.status} (page=${requestBody.pageNo}) ===`);
  try {
    logger.info(`[clickhouse] RESPONSE BODY:\n${res.body}`);
  } catch (e) {
    logger.error('[clickhouse] write response log failed', e);
  }

  if (res.status !== 200) {
    // 401：凭据过期/失效，标记过期并提示用户重新登录刷新凭据
    if (res.status === 401) {
      secretsStore.markExpired('HTTP 401 user don\'t login');
      throw new Error('凭据已过期，请重新点击「Wise 登录」刷新凭据');
    }
    throw new Error(`查询接口返回异常状态码 ${res.status}：${String(res.body).slice(0, 500)}`);
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
    histogram: Array.isArray(json.histogram) ? json.histogram : [],
    rawBody: res.body
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
  let rawBodies = [];

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
    if (page.rawBody) rawBodies.push(page.rawBody);

    logger.info(`[clickhouse] page=${pageNo} got=${page.records.length} accumulated=${allRecords.length} total=${total}`);
    // 已取完或该页为空
    if (allRecords.length >= total || page.records.length === 0) break;
  }

  return { total, records: allRecords, histogram, pages, beginTimestamp, endTimestamp, rawBodies };
}

module.exports = {
  QUERY_URL,
  PAGE_SIZE,
  buildRequestBody,
  buildRequestHeaders,
  queryOnce,
  queryWithTotal,
  toTimestampMs,
  PILOT_FILTER_CONDITION
};
