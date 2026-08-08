/**
 * 业务巡检管理系统 - 后端服务
 * 技术：Node.js + Express，数据以 JSON 文件本地存储
 * 启动：node index.js  （默认端口 3000）
 * 日志：所有日志输出到 server/logs/app-YYYY-MM-DD.log（见 lib/logger.js）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { logger, requestLogger } = require('./lib/logger');
const healthCheckRoutes = require('./routes/health-check');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');

app.use(express.json());
app.use(requestLogger);

/* ---------- 业务巡检 API（/api/health-check/*） ---------- */
app.use('/api/health-check', healthCheckRoutes);

/* ---------- 数据初始化：首次启动生成示例数据 ---------- */
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    logger.info('[init] data file not found, creating seed data');
    const seed = [
      { id: 1, taskNo: 'XJ20260806001', name: '机房设备例行巡检', type: '设备巡检', area: 'A栋机房', person: '张伟', planDate: '2026-08-06', status: '进行中', remark: '检查服务器运行状态、温度与告警', createTime: '2026-08-06 09:00:00', updateTime: '2026-08-06 09:00:00' },
      { id: 2, taskNo: 'XJ20260806002', name: '办公楼消防通道检查', type: '消防巡检', area: '办公区', person: '李强', planDate: '2026-08-06', status: '待处理', remark: '检查消防通道是否畅通、灭火器压力', createTime: '2026-08-06 09:10:00', updateTime: '2026-08-06 09:10:00' },
      { id: 3, taskNo: 'XJ20260806003', name: '配电房安全巡检', type: '安全巡检', area: '配电房', person: '王芳', planDate: '2026-08-05', status: '已完成', remark: '检查配电柜运行状态及绝缘情况', createTime: '2026-08-05 14:20:00', updateTime: '2026-08-05 16:30:00' },
      { id: 4, taskNo: 'XJ20260806004', name: '食堂卫生日常巡检', type: '卫生巡检', area: '员工食堂', person: '刘洋', planDate: '2026-08-07', status: '待处理', remark: '检查后厨卫生、食材存储与留样', createTime: '2026-08-06 10:00:00', updateTime: '2026-08-06 10:00:00' },
      { id: 5, taskNo: 'XJ20260806005', name: '生产线设备点检', type: '设备巡检', area: '一号车间', person: '陈杰', planDate: '2026-08-04', status: '已完成', remark: '点检传送带、液压站与安全防护装置', createTime: '2026-08-04 08:30:00', updateTime: '2026-08-04 11:00:00' },
      { id: 6, taskNo: 'XJ20260806006', name: '仓库消防安全巡检', type: '消防巡检', area: '二号仓库', person: '赵敏', planDate: '2026-08-06', status: '进行中', remark: '检查烟感、喷淋及疏散标识', createTime: '2026-08-06 11:20:00', updateTime: '2026-08-06 11:20:00' },
      { id: 7, taskNo: 'XJ20260806007', name: '质检实验室巡检', type: '质量巡检', area: '质检中心', person: '孙丽', planDate: '2026-08-03', status: '已完成', remark: '核查仪器校准状态与环境温湿度', createTime: '2026-08-03 09:40:00', updateTime: '2026-08-03 15:10:00' },
      { id: 8, taskNo: 'XJ20260806008', name: '停车场设施巡检', type: '设施巡检', area: '地下停车场', person: '周军', planDate: '2026-08-05', status: '待处理', remark: '检查照明、排水与标识标线', createTime: '2026-08-05 13:00:00', updateTime: '2026-08-05 13:00:00' }
    ];
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2), 'utf-8');
    logger.info(`[init] seed data created: ${seed.length} tasks`);
  }
}

function readTasks() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    logger.error('[data] read tasks failed', e);
    return [];
  }
}

function writeTasks(tasks) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
  } catch (e) {
    logger.error('[data] write tasks failed', e);
  }
}

function formatTime(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function genTaskNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const maxSeq = readTasks().reduce((max, t) => {
    const m = String(t.taskNo).match(/^XJ(\d{8})(\d{3})$/);
    if (m && m[1] === dateStr) return Math.max(max, parseInt(m[2], 10));
    return max;
  }, 0);
  return `XJ${dateStr}${String(maxSeq + 1).padStart(3, '0')}`;
}

/* ---------- 统一响应 ---------- */
const ok = (data) => ({ code: 0, msg: 'ok', data });
const fail = (msg) => ({ code: 1, msg });

/* ---------- 任务列表（支持查询 + 分页 + 统计） ---------- */
app.get('/api/tasks', (req, res) => {
  let tasks = readTasks();
  const { keyword, type, status, startDate, endDate } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(1, parseInt(req.query.pageSize, 10) || 10);

  if (keyword) {
    const kw = String(keyword).trim().toLowerCase();
    tasks = tasks.filter((t) =>
      String(t.name).toLowerCase().includes(kw) ||
      String(t.taskNo).toLowerCase().includes(kw) ||
      String(t.person).toLowerCase().includes(kw)
    );
  }
  if (type) tasks = tasks.filter((t) => t.type === type);
  if (status) tasks = tasks.filter((t) => t.status === status);
  if (startDate) tasks = tasks.filter((t) => t.planDate >= startDate);
  if (endDate) tasks = tasks.filter((t) => t.planDate <= endDate);

  // 按计划日期倒序
  tasks.sort((a, b) => String(b.planDate).localeCompare(String(a.planDate)) || b.id - a.id);

  const total = tasks.length;
  const list = tasks.slice((page - 1) * pageSize, page * pageSize);

  // 全量统计（与筛选条件无关）
  const all = readTasks();
  const stats = {
    total: all.length,
    pending: all.filter((t) => t.status === '待处理').length,
    inProgress: all.filter((t) => t.status === '进行中').length,
    done: all.filter((t) => t.status === '已完成').length
  };

  res.json(ok({ list, total, stats }));
});

/* ---------- 新增任务 ---------- */
app.post('/api/tasks', (req, res) => {
  const { name, type, area, person, planDate, status, remark } = req.body || {};
  if (!name || !String(name).trim()) return res.json(fail('任务名称不能为空'));
  if (!planDate) return res.json(fail('计划巡检日期不能为空'));

  const tasks = readTasks();
  const task = {
    id: Date.now(),
    taskNo: genTaskNo(),
    name: String(name).trim(),
    type: type || '设备巡检',
    area: area || '',
    person: person || '',
    planDate,
    status: status || '待处理',
    remark: remark || '',
    createTime: formatTime(),
    updateTime: formatTime()
  };
  tasks.push(task);
  writeTasks(tasks);
  logger.info(`[task] create id=${task.id} taskNo=${task.taskNo} name=${task.name}`);
  res.json(ok(task));
});

/* ---------- 更新任务 ---------- */
app.put('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const tasks = readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return res.json(fail('任务不存在'));

  const { name, type, area, person, planDate, status, remark } = req.body || {};
  const old = tasks[idx];
  tasks[idx] = {
    ...old,
    name: name !== undefined ? String(name).trim() : old.name,
    type: type !== undefined ? type : old.type,
    area: area !== undefined ? area : old.area,
    person: person !== undefined ? person : old.person,
    planDate: planDate !== undefined ? planDate : old.planDate,
    status: status !== undefined ? status : old.status,
    remark: remark !== undefined ? remark : old.remark,
    updateTime: formatTime()
  };
  writeTasks(tasks);
  logger.info(`[task] update id=${id} status=${tasks[idx].status} name=${tasks[idx].name}`);
  res.json(ok(tasks[idx]));
});

/* ---------- 删除任务 ---------- */
app.delete('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  let tasks = readTasks();
  const exists = tasks.some((t) => t.id === id);
  if (!exists) return res.json(fail('任务不存在'));
  tasks = tasks.filter((t) => t.id !== id);
  writeTasks(tasks);
  logger.info(`[task] delete id=${id}`);
  res.json(ok({ id }));
});

/* ---------- 启动 ---------- */
const server = app.listen(PORT, () => {
  logger.info(`[start] server listening on http://localhost:${PORT}`);
  console.log('============================================');
  console.log('  业务巡检管理系统 - 后端服务已启动');
  console.log(`  接口地址: http://localhost:${PORT}/api/tasks`);
  console.log(`  日志文件: ${logger.currentLogFile()}`);
  console.log('============================================');
});

// 手动登录（可达数分钟）与 ClickHouse 真实查询（大范围数据较慢）均需较长超时
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 10 * 60 * 1000;
