/**
 * 业务巡检管理系统 - 后端服务
 * 技术：Node.js + Express，数据以 JSON 文件本地存储
 * 启动：node index.js  （默认端口 3000）
 * 日志：所有日志输出到 server/logs/app-YYYY-MM-DD.log（见 lib/logger.js）
 */
const express = require('express');
const { logger, requestLogger } = require('./lib/logger');
const healthCheckRoutes = require('./routes/health-check');
const keepalive = require('./lib/keepalive');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(requestLogger);

/* ---------- 业务巡检 API（/api/health-check/*） ---------- */
app.use('/api/health-check', healthCheckRoutes);

/* ---------- 启动 ---------- */
const server = app.listen(PORT, () => {
  logger.info(`[start] server listening on http://localhost:${PORT}`);
  console.log('============================================');
  console.log('  业务巡检管理系统 - 后端服务已启动');
  console.log(`  接口地址: http://localhost:${PORT}/api/health-check`);
  console.log(`  日志文件: ${logger.currentLogFile()}`);
  console.log('============================================');
  // 启动后台 Keep Alive 存活探测（按配置开关决定是否执行）
  keepalive.start();
});

// 手动登录（可达数分钟）与 ClickHouse 查询均需较长超时
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 10 * 60 * 1000;
