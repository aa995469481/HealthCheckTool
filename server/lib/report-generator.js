/**
 * 巡检日报生成器 - 分场景、分批调用大模型，汇总生成三段式标准日报（HTML）
 *
 * 流程（与用户确认，2026-08-08 增加分批）：
 *   1. 读取上次巡检的聚类摘要（server/data/analysis/latest.json）
 *   2. 每个场景：基于结构化 summaries 构建精简输入（不再直接使用原始 markdownTexts，避免单次输入过长导致超时）
 *      - 样本配额：每分组(错误码)最多 2 条、每场景最多 5 条、字段值截断 200 字符
 *      - 输入仍超长时按「维度块」分批，每批 <= maxCharsPerPrompt，逐批调用 -> 拼接为该场景分析
 *   3. 汇总（计划信息 + 各场景分析）调用一次 -> 三段式完整日报 Markdown
 *   4. 转 HTML 完整页面（展示 + 下载）
 *
 * 输入长度控制（对齐用户提供的约束）：
 *   - 每次调用输入最大字符数：ai-config.maxCharsPerPrompt（默认 12000）
 *   - 样本上限：每场景 5 条（MAX_SAMPLES_PER_SCENE）、每错误码 2 条（MAX_SAMPLES_PER_GROUP）
 *   - 超长裁剪：样本字段值截断 + 批次内单块 clipText
 *   - 模型输出 finish_reason=length 时由 llm-service 明确报错
 *
 * mock 模式：不真实调用大模型，返回预置示例文本（用于本地自测/无网络环境演示）
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const llm = require('./llm-service');
const aiConfig = require('./ai-config-store');
const correctionStore = require('./correction-store');
const failureLibrary = require('./failure-library-store');
const inspectionHistory = require('./inspection-history');

const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'analysis', 'latest.json');

/* ---------- 样本裁剪约束（对齐用户提供的参考实现） ---------- */

const MAX_SAMPLES_PER_SCENE = 5; // 每场景最多保留样本条数
const MAX_SAMPLES_PER_GROUP = 2; // 每分组（错误码）最多保留样本条数
const MAX_SAMPLE_FIELD_LEN = 200; // 单个样本字段值最大长度
// 样本只保留这些业务关键字段，控制输入体积
const SAMPLE_FIELDS = [
  'walletEventInCode', 'walletEventExtCode', 'walletEventID', 'walletEventDesc',
  'issueName', 'issueDesc', 'errorCode', 'errorMsg', 'message',
  '_app_ver', 'appVersion', 'happenedTime', 'userProvince', 'userCity'
];

/** 裁剪单条样本：只保留关键字段 + 值截断 */
function trimSample(sample) {
  const out = {};
  for (const f of SAMPLE_FIELDS) {
    const v = sample && sample[f];
    if (v !== undefined && v !== null && String(v) !== '') {
      let s = String(v);
      if (s.length > MAX_SAMPLE_FIELD_LEN) s = s.slice(0, MAX_SAMPLE_FIELD_LEN) + '…';
      out[f] = s;
    }
  }
  return JSON.stringify(out);
}

/* ---------- 系统提示词 ---------- */

const SCENE_SYSTEM = `你是资深业务巡检专家，擅长从日志聚类摘要中定位系统问题并给出专业分析。你的输出将被汇总进一份正式巡检日报。要求：语言精炼专业、结构清晰、重点突出，只输出你负责的该场景分析内容（Markdown 格式），不要输出日报其他章节，不要输出多余说明。`;

/* ---------- 文本裁剪 ---------- */

function clipText(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const head = s.slice(0, Math.max(0, maxChars - 60));
  return `${head}\n\n>（注：原文过长已截断，剩余 ${s.length - maxChars} 字符未展示）`;
}

function formatTimeRange(begin, end) {
  const b = String(begin || '');
  const e = String(end || '');
  if (!b && !e) return '未设置';
  return `${b} ~ ${e}`;
}

/* ---------- 关键问题判定规则（与用户确认，2026-08-10，AI 设置可配置） ---------- */

const DEFAULT_RULES = {
  trendDays: 7,
  userCountThreshold: 50,
  increasePercent: 50,
  highRiskNew: true,
  pendingFirst: true,
  maxProblems: 15
};

/** 失败场景库索引：key = `${sceneTitle}|${inCode}|${extCode}` -> entry */
function buildLibMap() {
  const map = new Map();
  for (const c of failureLibrary.list()) {
    if (c && c.sceneTitle && (c.inCode || c.extCode)) {
      map.set(`${c.sceneTitle}|${c.inCode || ''}|${c.extCode || ''}`, c);
    }
  }
  return map;
}

/**
 * 问题级数据（内码+外码组合）构建 + 关键问题判定与排序
 * 规则：新出现(prev=0)/激增(增幅>=increasePercent) 标高危 > 待确认且达阈值 > 用户数降序
 */
function buildProblems(sceneTitle, combos, rules, libMap) {
  if (!Array.isArray(combos)) return [];
  const threshold = rules.userCountThreshold || DEFAULT_RULES.userCountThreshold;
  const pct = (rules.increasePercent || DEFAULT_RULES.increasePercent) / 100;
  const out = [];
  for (const c of combos) {
    if (!(c.count > 0)) continue;
    const lib = libMap.get(`${sceneTitle}|${c.inCode || ''}|${c.extCode || ''}`);
    const prev = lib && lib.prevUserCount !== undefined && lib.prevUserCount !== null ? lib.prevUserCount : undefined;
    const isNew = prev !== undefined && prev === 0;
    const isSpike = prev !== undefined && prev > 0 && c.count >= prev && (c.count - prev) / prev >= pct;
    const highRisk = (rules.highRiskNew !== false) && (isNew || isSpike);
    const pending = !!(lib && lib.status === '待确认');
    out.push({
      sceneTitle,
      inCode: c.inCode || '',
      extCode: c.extCode || '',
      count: c.count,
      prev,
      status: lib ? lib.status : '待确认',
      category: lib ? lib.category : '',
      analysis: lib ? String(lib.analysis || '').slice(0, 200) : '',
      highRisk,
      isNew,
      isSpike,
      pending,
      aboveThreshold: c.count >= threshold
    });
  }
  out.sort((a, b) => {
    if (a.highRisk !== b.highRisk) return b.highRisk ? 1 : -1;
    if (rules.pendingFirst !== false) {
      const pa = a.pending && a.aboveThreshold ? 1 : 0;
      const pb = b.pending && b.aboveThreshold ? 1 : 0;
      if (pa !== pb) return pb - pa;
    }
    return (b.count || 0) - (a.count || 0);
  });
  return out;
}

/** 单条问题总览行文本 */
function problemLine(p, idx) {
  const trend = p.prev === undefined
    ? '无上次'
    : (p.count > p.prev ? `+${p.count - p.prev}` : `-${p.prev - p.count}`);
  const flags = [];
  if (p.highRisk) flags.push('高危');
  if (p.pending) flags.push('待确认');
  const code = `${p.inCode}${p.extCode ? '/' + p.extCode : ''}`;
  const flagText = flags.length ? `｜标记：${flags.join('、')}` : '';
  return `${idx}. [${p.sceneTitle}] ${code}：${p.count} 用户（较上次${trend}）｜类别：${p.category || '未归类'}｜状态：${p.status}${flagText}${p.analysis ? '｜人工结论：' + p.analysis : ''}`;
}

/** 人工分析情况统计 + 待确认清单（仅统计本次巡检涉及的场景） */
function buildManualStats(sceneTitles, libMap) {
  const entries = [...libMap.values()].filter((c) => sceneTitles.has(c.sceneTitle));
  const stats = { total: entries.length, 已分析: 0, 待确认: 0, 已闭环: 0, category: { 端侧问题: 0, SP问题: 0, 云侧问题: 0, 非问题: 0 } };
  const pending = [];
  for (const c of entries) {
    if (c.status && stats[c.status] !== undefined) stats[c.status]++;
    if (c.category && stats.category[c.category] !== undefined) stats.category[c.category]++;
    if (c.status === '待确认') {
      pending.push({ sceneTitle: c.sceneTitle, inCode: c.inCode || '', extCode: c.extCode || '', count: c.latestUserCount || 0 });
    }
  }
  pending.sort((a, b) => b.count - a.count);
  return { stats, pending: pending.slice(0, 10) };
}

/** 人工分析情况文本（统计 + 待确认清单） */
function buildManualText(manual) {
  const s = manual.stats;
  if (!s.total) return '- 失败场景库暂无人工分析记录';
  const cat = s.category;
  const catParts = ['端侧问题', 'SP问题', '云侧问题', '非问题']
    .filter((k) => cat[k] > 0)
    .map((k) => `${k} ${cat[k]}条`);
  const lines = [
    `- 失败场景库共 ${s.total} 条：已分析 ${s.已分析}、待确认 ${s.待确认}、已闭环 ${s.已闭环}${catParts.length ? '；类别分布：' + catParts.join('、') : ''}`
  ];
  if (manual.pending.length) {
    lines.push('- 待确认问题清单（人工尚未分析，Top 10）：');
    manual.pending.forEach((p, i) => lines.push(`  - ${i + 1}. [${p.sceneTitle}] ${p.inCode}${p.extCode ? '/' + p.extCode : ''}（${p.count} 用户）`));
  }
  return lines.join('\n');
}

/** 单场景近 N 天命中趋势行（缺某天显示 -） */
function sceneTrendLine(sceneTitle, trend) {
  const parts = trend.map((d) => {
    const sc = (d.scenes || []).find((s) => s.sceneTitle === sceneTitle);
    return `${d.date.slice(5)}:${sc ? sc.total : '-'}`;
  });
  return `- 「${sceneTitle}」：${parts.join('，')}`;
}

/** 五段式系统提示词（含用户结构化模板要求） */
function buildReportSystem(tpl = {}) {
  let s = `你是资深业务巡检专家，负责汇总多个场景的巡检分析，输出一份正式的「业务巡检日报」。日报必须严格按以下五段式结构组织（Markdown 格式）：

一、巡检概览（计划/版本/时间/各场景命中数，以及近 N 天命中趋势）
二、问题总览表（用 Markdown 表格列出关键问题：场景｜问题(内码/外码)｜用户数｜较上次变化｜问题类别｜人工状态｜处置建议）
三、关键问题分析（对标记为高危、待确认或用户数较高的问题逐个深入分析：现象、可能原因、影响面）
四、人工分析情况（统计已分析/待确认/已闭环数量与类别分布，引用关键问题对应的人工分析结论，列出待确认问题清单）
五、整体结论与处置建议（总体健康度、优先处置事项、后续跟进建议）

要求：语言专业、简洁；关键问题必须依据「问题总览」的优先级展开，结合人工分析结论，避免泛泛而谈；直接输出日报正文，不要输出任何解释性文字。`;
  const extras = [tpl.focus, tpl.format, tpl.extra]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (extras.length) {
    s += `\n\n以下为用户对日报的特殊要求，必须严格执行：\n${extras.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
  }
  return s;
}

/* ---------- 分批：基于结构化摘要构建精简输入 + 打包批次 ---------- */

/**
 * 基于结构化聚类摘要构建「维度文本块」数组
 * 相比原始 markdownTexts（可达 20 万字符）精简得多：
 *   - 样本配额：每分组最多 MAX_SAMPLES_PER_GROUP 条、每场景最多 MAX_SAMPLES_PER_SCENE 条（跨维度轮询均分）
 *   - 样本字段裁剪：trimSample
 *   - 版本分布只取前 3、二级细分只列统计不列样本
 */
function buildSceneBlocks(summary, problems) {
  const dims = summary.dimensions || [];
  // 第一步：按配额分配样本（跨维度轮询，保证每个维度都有代表样本）
  //   轮次 0：每个维度的 Top 分组先各取 1 条；轮次 1：再各取第 2 条，直到场景配额用尽
  const samplesPlan = new Map(); // `${di}|${groupKey}` -> 样本数组
  const entriesPerDim = dims.map((dim, di) =>
    (dim.groups || [])
      .map((g, gi) => ({ g, gi, samples: (g.samples || []).slice(0, MAX_SAMPLES_PER_GROUP) }))
      .filter((e) => e.samples.length)
  );
  let remaining = MAX_SAMPLES_PER_SCENE;
  for (let round = 0; round < MAX_SAMPLES_PER_GROUP && remaining > 0; round++) {
    for (let di = 0; di < entriesPerDim.length && remaining > 0; di++) {
      for (const e of entriesPerDim[di]) {
        if (e.taken === undefined) e.taken = 0;
        if (e.taken > round) continue;
        if (e.taken >= e.samples.length || remaining <= 0) break;
        const planKey = `${di}|${e.g.key}`;
        if (!samplesPlan.has(planKey)) samplesPlan.set(planKey, []);
        samplesPlan.get(planKey).push(e.samples[e.taken]);
        e.taken++;
        remaining--;
      }
    }
  }
  // 第二步：构建文本块
  const blocks = [];
  for (let di = 0; di < dims.length; di++) {
    const dim = dims[di];
    const lines = [];
    lines.push(`- 聚类维度 ${di + 1}：${dim.field}` + (dim.subField ? `（二级下钻字段：${dim.subField}）` : ''));
    for (const g of dim.groups || []) {
      lines.push(`- ${dim.field}=${g.key}：${g.count}条（占比${g.percent}%）`);
      // 统计展示列：跟随该维度（一级聚类维度）独立配置（dim.statFields），未配置则不输出
      const stats = (g.statistics || [])
        .map((s) => {
          const top = (s.dist || []).slice(0, 3);
          if (!top.length) return null;
          const more = (s.dist || []).length > 3 ? ' 等' : '';
          return `${s.field}：${top.map((d) => `${d.value} ${d.count}条`).join('、')}${more}`;
        })
        .filter(Boolean);
      if (stats.length) lines.push(`  统计分布：${stats.join('；')}`);
      if (g.children && g.children.length) {
        lines.push(`  二级细分：${g.children.map((c) => `${c.key} ${c.count}条(${c.percent}%)`).join('、')}`);
        if (g.subOthersCount) lines.push(`  其余二级 ${g.subOthersCount} 条超 Top7 未列出`);
      }
      const planKey = `${di}|${g.key}`;
      const samples = samplesPlan.get(planKey) || [];
      if (samples.length) {
        lines.push('  代表样本：');
        samples.forEach((s, idx) => lines.push(`    - 样本${idx + 1}：${trimSample(s)}`));
      }
    }
    if (dim.others) lines.push(`- 其他：${dim.others.groups} 个分组共 ${dim.others.count} 条（占比小/超 Top7 未细分）`);
    blocks.push({ title: `维度 ${di + 1}：${dim.field}`, text: lines.join('\n') });
  }
  // 问题级组合（内码+外码，来自 countCombos 精确统计 + 失败场景库人工信息）
  if (problems && problems.length) {
    const plines = ['- 问题级组合（内码+外码，按用户数/风险排序，含人工分析）：'];
    for (const p of problems.slice(0, 10)) {
      const trend = p.prev === undefined
        ? '无上次'
        : (p.count > p.prev ? `+${p.count - p.prev}` : `-${p.prev - p.count}`);
      const flags = [];
      if (p.highRisk) flags.push('高危');
      if (p.pending) flags.push('待确认');
      const code = `${p.inCode}${p.extCode ? '/' + p.extCode : ''}`;
      plines.push(
        `  - ${code}：${p.count} 用户（较上次${trend}）｜类别：${p.category || '未归类'}｜状态：${p.status}${flags.length ? '｜标记：' + flags.join('、') : ''}${p.analysis ? '｜人工结论：' + p.analysis : ''}`
      );
    }
    blocks.push({ title: '问题级组合', text: plines.join('\n') });
  }
  return blocks;
}

/**
 * 将维度文本块贪心打包成批次，每批总字符 <= maxChars（单块超限时内部裁剪）
 */
function packBlocks(blocks, maxChars) {
  const batches = [];
  let cur = [];
  let curLen = 0;
  for (const b of blocks) {
    let text = b.text;
    if (text.length > maxChars) text = clipText(text, maxChars);
    if (curLen + text.length > maxChars && cur.length) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push({ title: b.title, text });
    curLen += text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** 并发池：以 limit 并发执行 fn，按下标写回结果，返回数组保持 items 原始顺序 */
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * 生成单个场景的问题分析（输入超长时按批次多次调用，逐批分析后拼接）
 * @param {object} ctx { summary, problems } 场景摘要 + 问题级组合数据
 * @returns {Promise<{ content, batches, inputChars }>}
 */
async function analyzeScene(ctx, title, maxChars, mock) {
  const blocks = buildSceneBlocks(ctx.summary, ctx.problems);
  const batches = packBlocks(blocks, maxChars);
  const parts = [];
  let totalInputChars = 0;
  for (let b = 0; b < batches.length; b++) {
    const batchText = batches[b].map((blk) => `### ${blk.title}\n${blk.text}`).join('\n\n');
    totalInputChars += batchText.length;
    let content;
    if (mock) {
      content = mockSceneReport(title, batchText);
    } else {
      const user =
        `以下是场景「${title}」的巡检聚类摘要${batches.length > 1 ? `（第 ${b + 1}/${batches.length} 批）` : ''}` +
        `（Top7 分组、占比、版本分布、代表样本）：\n\n${batchText}\n\n` +
        `请输出该场景的问题分析（主要问题点、可能原因、风险影响评估）。` +
        (batches.length > 1 ? '注意：仅分析本批次给出的内容，各批次结果会合并进同一场景，不要遗漏本批次的主要问题点。' : '');
      const r = await llm.callChat({ system: SCENE_SYSTEM, user });
      content = r.content;
    }
    parts.push(content);
    logger.info(`[ai-report] scene=${title} batch ${b + 1}/${batches.length} inputChars=${batchText.length} outputChars=${content.length}`);
  }
  const content = batches.length > 1
    ? parts.map((c, idx) => `#### 批次 ${idx + 1}/${batches.length}\n${c}`).join('\n\n')
    : parts[0];
  return { content, batches: batches.length, inputChars: totalInputChars };
}

/* ---------- mock 模式：本地自测 / 无网络演示 ---------- */

function mockSceneReport(title, markdown) {
  const totalMatch = String(markdown || '').match(/命中总数[：:]\s*(\d+)/);
  const total = totalMatch ? totalMatch[1] : '?';
  return `## ${title}\n\n### 问题分析\n\n【Mock 模式】该场景共命中 ${total} 条。Top 分组集中在主错误码，占比最高，结合版本分布判断为存量问题；建议优先核对主错误码的触发条件，再按版本分批验证。\n\n- **风险等级**：中\n- **处置建议**：先看主错误码对应服务是否异常，其次关注占比靠前的错误码。`;
}

/* ---------- 主入口 ---------- */

/**
 * 生成巡检日报（五段式，含问题总览/关键问题/人工分析情况/近 N 天趋势）
 * @param {object} opts { mock?: boolean }
 * @returns {Promise<{ markdown, html, sceneReports, meta }>}
 */
async function generateDailyReport({ mock = false } = {}) {
  if (!fs.existsSync(ANALYSIS_FILE)) {
    throw new Error('暂无巡检数据，请先执行巡检（生成聚类摘要）后再生成日报');
  }
  const analysis = JSON.parse(fs.readFileSync(ANALYSIS_FILE, 'utf-8'));
  const summaries = Array.isArray(analysis.summaries) ? analysis.summaries : [];
  if (summaries.length === 0) {
    throw new Error('巡检数据中没有场景摘要，请先执行巡检');
  }
  const cfg = aiConfig.getConfig();
  const maxChars = cfg.maxCharsPerPrompt && cfg.maxCharsPerPrompt > 0 ? cfg.maxCharsPerPrompt : 12000;
  // 计划名清洗：空或历史遗留的 'unnamed' 一律视为未命名，避免出现在日报标题/主题中
  const planName = analysis.plan && String(analysis.plan) !== 'unnamed' ? String(analysis.plan) : '';
  const rules = { ...DEFAULT_RULES, ...(cfg.reportRules || {}) };
  const template = { ...(cfg.reportTemplate || {}) };
  const trendDays = Math.max(1, Number(rules.trendDays) || DEFAULT_RULES.trendDays);
  const maxProblems = Math.max(1, Number(rules.maxProblems) || DEFAULT_RULES.maxProblems);
  const trend = inspectionHistory.loadTrend(trendDays);
  const libMap = buildLibMap();

  logger.info(`[ai-report] start scenes=${summaries.length} mock=${mock} maxChars=${maxChars} plan=${planName || '(未命名)'} trendDays=${trendDays} trendFiles=${trend.length}`);

  // 第一步：每个场景分批调用，生成该场景的问题分析（含问题级组合数据）
  // 可控并发（默认 2，最多 3）：串行时 N 个场景 × 单次调用等待，总时长过长，并发可显著缩短
  const sceneTasks = summaries.map((s, i) => {
    const title = s.scenarioTitle || `场景${i + 1}`;
    const combos = (analysis.combosByScene && analysis.combosByScene[title]) || [];
    const problems = buildProblems(title, combos, rules, libMap);
    return { s, i, title, problems };
  });
  const concurrency = Math.max(1, Math.min(3, Number(cfg.maxConcurrentScenes) || 2));
  logger.info(`[ai-report] scene calls concurrency=${concurrency}`);
  const sceneResults = await runPool(sceneTasks, concurrency, async (task) => {
    const sr = await analyzeScene({ summary: task.s, problems: task.problems }, task.title, maxChars, mock);
    logger.info(`[ai-report] scene ${task.i + 1}/${summaries.length} title=${task.title} problems=${task.problems.length} batches=${sr.batches} inputChars=${sr.inputChars} outputChars=${sr.content.length}`);
    return { title: task.title, content: sr.content, batches: sr.batches, inputChars: sr.inputChars, problems: task.problems.slice(0, maxProblems) };
  });
  // runPool 按下标写回，sceneResults 天然保持原始场景顺序
  const sceneReports = sceneResults;

  // 第二步：汇总调用，生成五段式完整日报
  const overviewLines = [
    `- 巡检计划：${planName || '未命名计划'}`,
    `- 目标版本：${analysis.appVer || '未指定'}`,
    `- 巡检时间：${formatTimeRange(analysis.beginTimestamp, analysis.endTimestamp)}`,
    `- 巡检场景数：${summaries.length}`,
    `- 各场景命中条数：${summaries.map((s, i) => `「${s.scenarioTitle || `场景${i + 1}`}」${s.total}条`).join('；')}`
  ].join('\n');

  // 近 N 天各场景命中趋势（来自历史快照）
  const trendLines = summaries.length && trend.length
    ? `近${trendDays}天各场景命中趋势：\n${summaries.map((s, i) => sceneTrendLine(s.scenarioTitle || `场景${i + 1}`, trend)).join('\n')}`
    : '';

  // 人工分析情况（统计 + 待确认清单，仅统计本次巡检涉及的场景）
  const sceneTitles = new Set(summaries.map((s) => s.scenarioTitle || '').filter(Boolean));
  const manualText = buildManualText(buildManualStats(sceneTitles, libMap));

  // 问题总览（跨场景 Top，供大模型重点分析）
  const allProblems = sceneReports.flatMap((sr) => sr.problems).slice(0, maxProblems);
  const problemText = allProblems.length
    ? `\n\n问题总览（关键问题，按优先级排序：高危/待确认优先，供你重点分析与排序）：\n${allProblems.map((p, i) => problemLine(p, i + 1)).join('\n')}\n`
    : '';

  // 人工矫正意见（全局生效，喂给汇总调用，不重复出现在各场景分析 prompt）
  const correctionsText = correctionStore.correctionsText();
  const correctionBlock = correctionsText
    ? `\n\n以下为巡检工程师提供的人工矫正意见与建议（务必在日报中参考并体现，用于修正分析与结论）：\n${correctionsText}\n`
    : '';
  const correctionHint = correctionsText
    ? '\n\n注意：请结合上述人工矫正意见修正场景分析与整体结论，避免与人工判断冲突。'
    : '';

  // 失败场景库参考（人工维护的案例分析，按场景+内码+外码组织，喂给汇总调用）
  const failureText = failureLibrary.aiReferenceText();
  const failureBlock = failureText
    ? `\n\n以下为巡检失败场景库中的人工案例分析（用于判断问题根因与处置方向，请参考并结合到对应场景的分析与建议中）：\n${failureText}\n`
    : '';
  const failureHint = failureText
    ? '\n\n请结合失败场景库的案例分析，使各场景问题分析与处置建议与人工判断保持一致。'
    : '';

  // 汇总输入控制：每场景分析限长，保证总输入不超过 maxChars（避免汇总调用超时）
  const perSceneBudget = Math.max(800, Math.floor((maxChars * 0.8) / sceneReports.length));
  const sceneSections = sceneReports.map((sr, i) => {
    const clipped = clipText(sr.content, perSceneBudget);
    return `### 场景 ${i + 1}：${sr.title}\n${clipped}`;
  }).join('\n\n');

  const reportUser = [
    `本次巡检概况：\n${overviewLines}`,
    trendLines ? `\n${trendLines}\n` : '',
    `\n人工分析情况：\n${manualText}`,
    problemText,
    correctionBlock,
    failureBlock,
    `\n以下是各场景的问题分析结果：\n\n${sceneSections}`,
    `\n请据此生成完整的五段式巡检日报（一、巡检概览；二、问题总览表；三、关键问题分析；四、人工分析情况；五、整体结论与处置建议）。${correctionHint}${failureHint}`
  ].join('');

  logger.info(`[ai-report] final call inputChars=${reportUser.length} perSceneBudget=${perSceneBudget} problems=${allProblems.length} corrections=${correctionsText ? correctionsText.split('\n').length : 0} failureCases=${failureText ? failureText.split('\n').length : 0}`);
  let markdown;
  if (mock) {
    const mockSections = sceneReports.map((sr, i) => `### 场景 ${i + 1}：${sr.title}\n\n${sr.content}`).join('\n\n');
    markdown = [
      '# 业务巡检日报',
      '',
      '> （Mock 模式示例报告，未真实调用大模型）',
      '',
      '## 一、巡检概览',
      overviewLines.replace(/- /g, '- '),
      trendLines ? trendLines.replace(/- /g, '- ') : '',
      '',
      '## 二、问题总览表',
      problemText.trim() || '（暂无问题级数据）',
      '',
      '## 三、关键问题分析',
      mockSections,
      '',
      '## 四、人工分析情况',
      manualText,
      '',
      '## 五、整体结论与处置建议',
      '本次巡检各场景整体健康度中等，主要问题集中在高危/待确认组合，建议：1) 优先核查高危问题链路；2) 结合人工分析定位根因；3) 次日巡检验证处置效果。',
      ''
    ].join('\n');
    if (correctionsText) {
      markdown += `\n## 附：人工矫正意见\n${correctionsText}\n`;
    }
    if (failureText) {
      markdown += `\n## 附：失败场景库参考\n${failureText}\n`;
    }
  } else {
    const r = await llm.callChat({ system: buildReportSystem(template), user: reportUser });
    markdown = r.content;
  }

  // 第三步：转 HTML
  const html = buildHtmlPage(markdown, {
    plan: planName,
    createdAt: new Date().toISOString()
  });

  const meta = {
    createdAt: new Date().toISOString(),
    plan: planName,
    appVer: analysis.appVer || '',
    beginTimestamp: analysis.beginTimestamp || '',
    endTimestamp: analysis.endTimestamp || '',
    trendDays,
    rules: {
      userCountThreshold: rules.userCountThreshold,
      increasePercent: rules.increasePercent,
      highRiskNew: rules.highRiskNew,
      pendingFirst: rules.pendingFirst
    },
    scenes: sceneReports.map((sr) => ({ title: sr.title, batches: sr.batches, inputChars: sr.inputChars, outputChars: sr.content.length, problems: sr.problems.length })),
    totalCalls: sceneReports.reduce((s, x) => s + x.batches, 0) + 1,
    mock
  };
  logger.info(`[ai-report] done scenes=${sceneReports.length} markdownChars=${markdown.length} htmlChars=${html.length}`);

  return { markdown, html, sceneReports, meta };
}

/* ---------- Markdown -> HTML（轻量转换，覆盖常见格式，避免新增依赖） ---------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function markdownToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  const html = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let tableRows = [];
  let inCode = false;
  let codeBuf = [];

  const closeUl = () => { if (inUl) { html.push('</ul>'); inUl = false; } };
  const closeOl = () => { if (inOl) { html.push('</ol>'); inOl = false; } };
  const closeTable = () => {
    if (!inTable) return;
    if (tableRows.length) {
      const header = tableRows[0].map((c) => `<th>${inline(c)}</th>`).join('');
      const body = tableRows.slice(2).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      html.push(`<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`);
    }
    inTable = false;
    tableRows = [];
  };

  for (const raw of lines) {
    // 代码块
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeUl(); closeOl(); closeTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const line = raw.trimEnd();

    // 表格行
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      if (!inTable) { closeUl(); closeOl(); inTable = true; tableRows = []; }
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      tableRows.push(cells);
      continue;
    }
    closeTable();

    // 空行 -> 关闭列表
    if (line.trim() === '') { closeUl(); closeOl(); html.push(''); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeUl(); closeOl();
      const level = h[1].length;
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (!inUl) { closeOl(); html.push('<ul>'); inUl = true; }
      html.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\d+[.、)]\s+(.*)$/);
    if (ol) {
      if (!inOl) { closeUl(); html.push('<ol>'); inOl = true; }
      html.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    const quote = line.match(/^>\s*(.*)$/);
    if (quote) {
      closeUl(); closeOl();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    closeUl(); closeOl();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeUl(); closeOl(); closeTable();
  if (inCode) html.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
  return html.join('\n');
}

function buildHtmlPage(markdown, info) {
  const body = markdownToHtml(markdown);
  const title = info.plan ? `业务巡检日报 - ${info.plan}` : '业务巡检日报';
  const created = info.createdAt ? new Date(info.createdAt).toLocaleString('zh-CN') : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 32px 24px; background: #f5f7fa; color: #303133; }
  .report { max-width: 900px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px 40px; box-shadow: 0 2px 12px rgba(0,0,0,.06); }
  .report-head { border-bottom: 2px solid #409eff; padding-bottom: 14px; margin-bottom: 20px; }
  .report-head h1 { margin: 0; font-size: 22px; color: #303133; }
  .report-head .sub { margin-top: 6px; font-size: 12px; color: #909399; }
  h1 { font-size: 20px; border-bottom: 1px solid #e4e7ed; padding-bottom: 8px; margin: 24px 0 12px; }
  h2 { font-size: 17px; margin: 22px 0 10px; color: #409eff; }
  h3 { font-size: 15px; margin: 18px 0 8px; }
  h4 { font-size: 14px; margin: 14px 0 6px; }
  p { font-size: 14px; line-height: 1.8; margin: 8px 0; }
  ul, ol { font-size: 14px; line-height: 1.8; padding-left: 24px; }
  li { margin: 4px 0; }
  code { background: #f5f7fa; border: 1px solid #e4e7ed; border-radius: 3px; padding: 1px 5px; font-size: 12px; color: #d14; }
  pre { background: #f5f7fa; border: 1px solid #e4e7ed; border-radius: 6px; padding: 12px; overflow: auto; font-size: 12px; }
  pre code { background: none; border: none; padding: 0; color: inherit; }
  blockquote { margin: 10px 0; padding: 8px 14px; background: #f0f9ff; border-left: 3px solid #409eff; color: #606266; font-size: 13px; }
  table { border-collapse: collapse; margin: 12px 0; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #e4e7ed; padding: 6px 10px; text-align: left; }
  th { background: #f5f7fa; font-weight: 600; }
  strong { color: #303133; }
</style>
</head>
<body>
<div class="report">
  <div class="report-head">
    <h1>${escapeHtml(title)}</h1>
    <div class="sub">生成时间：${escapeHtml(created)}</div>
  </div>
${body}
</div>
</body>
</html>`;
}

module.exports = { generateDailyReport, markdownToHtml, clipText, buildSceneBlocks, packBlocks, trimSample, buildProblems, buildManualStats, sceneTrendLine, buildReportSystem, DEFAULT_RULES };
