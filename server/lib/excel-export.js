/**
 * Excel 导出 - 将巡检结果按场景生成多 sheet 的 xlsx
 *
 * 规则：
 *   - 每个场景一个 sheet（sheet 名取场景标题，超过 31 字符自动截断）
 *   - 每列只取该场景 focusFields 指定的关注字段（无 focusFields 时导出全部字段）
 *   - 表头 = 字段名；单元格值 = 记录中对应字段
 */
const ExcelJS = require('exceljs');
const { logger } = require('./logger');

const SHEET_NAME_MAX = 31; // Excel sheet 名长度上限

/** 去掉非法字符并截断，保证 sheet 名合法且不重复 */
function safeSheetName(title, index, used) {
  let name = String(title || `场景${index + 1}`).replace(/[\\/?*[\]:]/g, '_');
  if (name.length > SHEET_NAME_MAX) name = name.slice(0, SHEET_NAME_MAX);
  if (used.has(name)) {
    let suffix = 2;
    while (used.has(`${name.slice(0, SHEET_NAME_MAX - 3)}_${suffix}`)) suffix++;
    name = `${name.slice(0, SHEET_NAME_MAX - 3)}_${suffix}`;
  }
  used.add(name);
  return name;
}

/** 从记录中挑选列（仅关注字段；无 focusFields 时取记录全部字段） */
function pickFields(record, focusFields) {
  const fields = Array.isArray(focusFields) && focusFields.length > 0 ? focusFields : Object.keys(record || {});
  const row = {};
  for (const f of fields) {
    const v = record[f];
    row[f] = v === null || v === undefined ? '' : String(v);
  }
  return row;
}

/**
 * 生成多 sheet 的 xlsx Buffer
 * @param {Array} scenarios [{ scene: {title,focusFields}, records: Array }]
 * @returns {Promise<Buffer>}
 */
async function buildExcelBuffer(scenarios) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Service Inspection System';
  workbook.created = new Date();

  const used = new Set();
  for (let i = 0; i < scenarios.length; i++) {
    const { scene, records } = scenarios[i] || {};
    if (!scene) continue;
    const sheetName = safeSheetName(scene.title, i, used);
    const ws = workbook.addWorksheet(sheetName);

    const focusFields = (scene.focusFields || []).map(String);
    const firstRecord = records && records[0];
    const columns = focusFields.length > 0 ? focusFields : Object.keys(firstRecord || {});

    ws.columns = columns.map((key) => ({
      header: key,
      key,
      width: Math.max(12, Math.min(40, String(key).length + 6))
    }));

    // 表头加粗 + 冻结首行
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const r of records || []) {
      ws.addRow(pickFields(r, focusFields));
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  logger.info(`[excel] generated workbook sheets=${scenarios.length} size=${buffer.length}B`);
  return buffer;
}

module.exports = { buildExcelBuffer, pickFields, safeSheetName };
