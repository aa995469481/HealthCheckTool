/**
 * 巡检日报生成器 - 分场景多次调用大模型，汇总生成三段式标准日报（HTML）
 *
 * 流程（与用户确认）：
 *   1. 读取上次巡检的聚类摘要（server/data/analysis/latest.json，含每场景 markdownTexts）
 *   2. 每个场景调用一次大模型 -> 输出该场景的「问题分析」
 *   3. 汇总（计划信息 + 各场景分析）再调用一次 -> 输出三段式完整日报 Markdown
 *   4. 转 HTML 完整页面（展示 + 下载）
 *
 * 输入长度控制（对齐用户提供的约束）：
 *   - 每次调用输入最大字符数：ai-config.maxCharsPerPrompt（默认 12000）
 *   - 每场景摘要超长时自动裁剪（保留开头主体 + 标注截断）
 *   - 模型输出 finish_reason=length 时由 llm-service 明确报错
 *
 * mock 模式：不真实调用大模型，返回预置示例文本（用于本地自测/无网络环境演示）
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const llm = require('./llm-service');
const aiConfig = require('./ai-config-store');

const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'analysis', 'latest.json');

/* ---------- 系统提示词 ---------- */

const SCENE_SYSTEM = `你是资深业务巡检专家，擅长从日志聚类摘要中定位系统问题并给出专业分析。你的输出将被汇总进一份正式巡检日报。要求：语言精炼专业、结构清晰、重点突出，只输出你负责的该场景分析内容（Markdown 格式），不要输出日报其他章节，不要输出多余说明。`;

const REPORT_SYSTEM = `你是资深业务巡检专家，负责汇总多个场景的巡检分析，输出一份正式的「业务巡检日报」。日报必须严格按以下三段式结构组织（Markdown 格式）：

一、巡检概览
二、各场景问题分析
三、整体结论与处置建议

要求：语言专业、简洁；第三部分需给出总体健康度评价、优先处置事项与后续跟进建议；直接输出日报正文，不要输出任何解释性文字。`;

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

/* ---------- mock 模式：本地自测 / 无网络演示 ---------- */

function mockSceneReport(title, markdown) {
  const totalMatch = String(markdown || '').match(/命中总数[：:]\s*(\d+)/);
  const total = totalMatch ? totalMatch[1] : '?';
  return `## ${title}\n\n### 问题分析\n\n【Mock 模式】该场景共命中 ${total} 条。Top 分组集中在主错误码，占比最高，结合版本分布判断为存量问题；建议优先核对主错误码的触发条件，再按版本分批验证。\n\n- **风险等级**：中\n- **处置建议**：先看主错误码对应服务是否异常，其次关注占比靠前的错误码。`;
}

/* ---------- 主入口 ---------- */

/**
 * 生成巡检日报
 * @param {object} opts { mock?: boolean }
 * @returns {Promise<{ markdown, html, sceneReports, meta }>}
 */
async function generateDailyReport({ mock = false } = {}) {
  if (!fs.existsSync(ANALYSIS_FILE)) {
    throw new Error('暂无巡检数据，请先执行巡检（生成聚类摘要）后再生成日报');
  }
  const analysis = JSON.parse(fs.readFileSync(ANALYSIS_FILE, 'utf-8'));
  const markdownTexts = Array.isArray(analysis.markdownTexts) ? analysis.markdownTexts : [];
  const summaries = Array.isArray(analysis.summaries) ? analysis.summaries : [];
  if (markdownTexts.length === 0) {
    throw new Error('巡检数据中没有场景摘要，请先执行巡检');
  }
  const cfg = aiConfig.getConfig();
  const maxChars = cfg.maxCharsPerPrompt && cfg.maxCharsPerPrompt > 0 ? cfg.maxCharsPerPrompt : 12000;

  logger.info(`[ai-report] start scenes=${markdownTexts.length} mock=${mock} maxChars=${maxChars}`);

  // 第一步：每个场景单独调用，生成该场景的问题分析
  const sceneReports = [];
  for (let i = 0; i < markdownTexts.length; i++) {
    const title = (summaries[i] && summaries[i].scenarioTitle) || `场景${i + 1}`;
    const clipped = clipText(markdownTexts[i], maxChars);
    logger.info(`[ai-report] scene ${i + 1}/${markdownTexts.length} title=${title} inputChars=${clipped.length} (raw=${markdownTexts[i].length})`);
    let content;
    if (mock) {
      content = mockSceneReport(title, markdownTexts[i]);
    } else {
      const user = `以下是场景「${title}」的巡检聚类摘要（Top7 分组、占比、版本分布、代表样本）：\n\n${clipped}\n\n请输出该场景的问题分析（主要问题点、可能原因、风险影响评估）。`;
      const r = await llm.callChat({ system: SCENE_SYSTEM, user });
      content = r.content;
    }
    sceneReports.push({ title, content, inputChars: clipped.length });
    logger.info(`[ai-report] scene ${i + 1} done outputChars=${content.length}`);
  }

  // 第二步：汇总调用，生成三段式完整日报
  const overviewLines = [
    `- 巡检计划：${analysis.plan || '未命名计划'}`,
    `- 目标版本：${analysis.appVer || '未指定'}`,
    `- 巡检时间：${formatTimeRange(analysis.beginTimestamp, analysis.endTimestamp)}`,
    `- 巡检场景数：${markdownTexts.length}`,
    `- 各场景命中条数：${summaries.map((s, i) => `「${s.scenarioTitle || `场景${i + 1}`}」${s.total}条`).join('；')}`
  ].join('\n');

  const sceneSections = sceneReports.map((sr, i) => {
    const clipped = clipText(sr.content, maxChars);
    return `### 场景 ${i + 1}：${sr.title}\n${clipped}`;
  }).join('\n\n');

  const reportUser = `本次巡检概况：\n${overviewLines}\n\n以下是各场景的问题分析结果：\n\n${sceneSections}\n\n请据此生成完整的三段式巡检日报（一、巡检概览；二、各场景问题分析；三、整体结论与处置建议）。`;

  logger.info(`[ai-report] final call inputChars=${reportUser.length}`);
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
      '',
      '## 二、各场景问题分析',
      mockSections,
      '',
      '## 三、整体结论与处置建议',
      '本次巡检各场景整体健康度中等，主要问题集中在主错误码相关路径，建议：1) 优先核查主错误码对应链路；2) 按版本分布定位引入版本；3) 次日巡检验证处置效果。',
      ''
    ].join('\n');
  } else {
    const r = await llm.callChat({ system: REPORT_SYSTEM, user: reportUser });
    markdown = r.content;
  }

  // 第三步：转 HTML
  const html = buildHtmlPage(markdown, {
    plan: analysis.plan || '',
    createdAt: new Date().toISOString()
  });

  const meta = {
    createdAt: new Date().toISOString(),
    plan: analysis.plan || '',
    appVer: analysis.appVer || '',
    beginTimestamp: analysis.beginTimestamp || '',
    endTimestamp: analysis.endTimestamp || '',
    scenes: sceneReports.map((sr) => ({ title: sr.title, outputChars: sr.content.length })),
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

module.exports = { generateDailyReport, markdownToHtml, clipText };
