/**
 * 巡检历史快照 - server/data/analysis/history/YYYY-MM-DD.json（按天聚合，单框架）
 *              - server/data/analysis-dual/history/YYYY-MM-DD.json（双框架）
 *
 * 用途：AI 巡检日报展示「近 N 天命中趋势」
 * 规则（与用户确认，2026-08-10）：
 *   - 每次执行巡检时写入当天快照，当天多次巡检以最后一次为准（覆盖当日文件）
 *   - 快照内容：日期 + 各场景 { sceneId, sceneTitle, total, combos: [{inCode, extCode, count}] }
 *   - 自动清理 30 天前的历史文件
 * 按框架隔离（与用户确认，2026-08-12）：单框架沿用原目录（零迁移），双框架使用 analysis-dual/history
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const RETENTION_DAYS = 30;

function historyDir(framework) {
  return framework === 'dual'
    ? path.join(__dirname, '..', 'data', 'analysis-dual', 'history')
    : path.join(__dirname, '..', 'data', 'analysis', 'history');
}

function dateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayFile(day, framework) {
  return path.join(historyDir(framework), `${day}.json`);
}

/** 保存当天快照（当天多次巡检以最后一次为准），并清理过期历史（framework: single | dual，默认 single） */
function saveSnapshot(sceneSnapshots, framework) {
  if (!Array.isArray(sceneSnapshots) || !sceneSnapshots.length) return;
  const dir = historyDir(framework);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const day = dateStr();
  const data = { date: day, scenes: sceneSnapshots };
  fs.writeFileSync(dayFile(day, framework), JSON.stringify(data, null, 2), 'utf-8');
  cleanup(framework);
  logger.info(`[history] snapshot saved date=${day} scenes=${sceneSnapshots.length} framework=${framework || 'single'}`);
}

/** 读取最近 N 天（含今天）的历史快照，按日期升序返回 */
function loadTrend(days, framework) {
  const n = Math.max(1, Number(days) || 7);
  const dir = historyDir(framework);
  if (!fs.existsSync(dir)) return [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch (e) {
    logger.warn(`[history] read dir failed: ${e.message}`);
    return [];
  }
  const out = [];
  for (const f of files.slice(-n)) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
    } catch (e) {
      logger.warn(`[history] read failed ${f}: ${e.message}`);
    }
  }
  return out;
}

/** 清理保留期外的历史文件 */
function cleanup(framework) {
  const dir = historyDir(framework);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const t = new Date(m[1] + 'T00:00:00').getTime();
    if (t < cutoff) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch (e) {
        /* ignore */
      }
    }
  }
}

module.exports = { saveSnapshot, loadTrend, dateStr, historyDir, RETENTION_DAYS };
