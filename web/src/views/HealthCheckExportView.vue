<template>
  <div class="hc-page">
    <!-- 凭据设置卡片 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>凭据设置</span>
          <div class="card-actions">
            <el-button size="small" :icon="Setting" @click="openAiConfig">AI 设置</el-button>
            <el-button size="small" type="primary" :icon="Connection" :loading="loggingIn" @click="wiseLogin">
              Wise 登录
            </el-button>
            <el-button size="small" :icon="Refresh" @click="loadCredentials">刷新状态</el-button>
          </div>
        </div>
      </template>
      <div class="credential-row">
        <span class="dot" :class="credential.expired ? 'dot-red' : (credential.configured ? 'dot-green' : 'dot-yellow')"></span>
        <span class="credential-text">
          <template v-if="credential.expired">
            凭据已过期{{ credential.expiredAt ? '（' + credential.expiredAt + '）' : '' }}，请重新点击「Wise 登录」刷新
          </template>
          <template v-else-if="credential.configured">凭据已配置</template>
          <template v-else>凭据未配置，请点击「Wise 登录」自动获取，或手动粘贴</template>
        </span>
        <el-tag v-if="credential.expired" size="small" type="danger">已过期</el-tag>
        <el-tag v-if="credential.source && !credential.expired" size="small" type="info">{{ credential.source }}</el-tag>
        <el-tag v-if="credential.updatedAt && !credential.expired" size="small" type="warning">更新于 {{ credential.updatedAt }}</el-tag>
      </div>

      <el-collapse class="credential-collapse">
        <el-collapse-item title="高级：手动粘贴 Cookie（回退方案）">
          <el-form label-width="120px">
            <el-form-item label="Cookie">
              <el-input v-model="manualForm.cookie" type="textarea" :rows="3" placeholder="从 F12 → Network → 请求头中复制 Cookie" />
            </el-form-item>
            <el-form-item label="x-csrf-token">
              <el-input v-model="manualForm.xCsrfToken" placeholder="从 F12 → Network → 请求头中复制 x-csrf-token" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" size="small" :loading="savingSecrets" @click="saveSecrets">保存到 secrets.yaml</el-button>
            </el-form-item>
          </el-form>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <!-- 巡检计划卡片 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>巡检计划</span>
          <div class="card-actions">
            <el-select
              v-model="selectedProfileId"
              placeholder="加载已保存计划"
              clearable
              size="small"
              style="width: 200px"
              @change="loadProfile"
            >
              <el-option v-for="p in profiles" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
            <el-button size="small" @click="saveProfile">保存计划</el-button>
          </div>
        </div>
      </template>
      <el-form :inline="true" class="profile-form">
        <el-form-item label="计划名称">
          <el-input v-model="plan.name" placeholder="如：1.0.23.300 发版巡检" style="width: 220px" />
        </el-form-item>
        <el-form-item label="目标版本">
          <el-input v-model="plan.app_ver" placeholder="app_ver，可留空" style="width: 160px" />
        </el-form-item>
        <el-form-item label="时间范围">
          <el-date-picker
            v-model="dateRange"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            value-format="YYYY-MM-DD HH:mm:ss"
            style="width: 400px"
          />
        </el-form-item>
      </el-form>

      <div class="scenario-group" v-for="group in scenarioGroups" :key="group.table">
        <div class="scenario-group-title">
          <span>{{ group.table }}</span>
          <div class="scenario-group-actions">
            <el-button link type="primary" size="small" @click="checkGroup(group, true)">全选</el-button>
            <el-button link type="info" size="small" @click="checkGroup(group, false)">全不选</el-button>
          </div>
        </div>
        <el-checkbox-group v-model="plan.enabled_scenarios">
          <el-checkbox v-for="s in group.items" :key="s.id" :value="s.id" :label="s.id" border class="scenario-checkbox">
            {{ s.title }}
          </el-checkbox>
        </el-checkbox-group>
      </div>

      <div class="profile-actions">
        <el-button type="primary" :icon="Download" :loading="running" @click="runInspection">
          执行巡检并下载 Excel
        </el-button>
        <span class="selected-count">已选 {{ plan.enabled_scenarios.length }} 个场景</span>
      </div>
    </el-card>

    <!-- 聚类摘要卡片 -->
    <el-card v-if="analysis" shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>聚类摘要</span>
          <div class="card-actions">
            <el-tag v-if="analysis.plan" size="small" type="info">{{ analysis.plan }}</el-tag>
            <el-tag v-if="analysis.appVer" size="small">版本 {{ analysis.appVer }}</el-tag>
            <el-tag v-if="analysis.beginTimestamp" size="small">
              {{ analysis.beginTimestamp }} ~ {{ analysis.endTimestamp }}
            </el-tag>
          </div>
        </div>
      </template>

      <!-- 每个场景默认折叠，由用户按需展开查看维度 -->
      <el-collapse v-model="expandedScenes" class="cluster-collapse">
        <el-collapse-item v-for="s in analysis.summaries" :key="s.scenarioTitle" :name="s.scenarioTitle">
          <template #title>
            <div class="cluster-scene-title">
              <span class="cluster-scene-name">{{ s.scenarioTitle }}</span>
              <el-tag size="small" type="info">共 {{ s.total }} 条</el-tag>
              <el-tag v-if="s.clusterFields && s.clusterFields.length" size="small" type="warning">
                聚类维度：{{ s.clusterFields.join('、') }}
              </el-tag>
            </div>
          </template>

          <div v-for="dim in (s.dimensions || [])" :key="dim.field" class="cluster-dim">
            <div class="cluster-dim-title">
              维度「{{ dim.field }}」按字段取值分组（Top 7）
              <el-tag v-if="dim.subField" size="small" type="info">二级下钻：{{ dim.subField }}</el-tag>
              <el-tag v-if="dim.others" size="small" type="warning">其他 {{ dim.others.groups }} 组共 {{ dim.others.count }} 条</el-tag>
            </div>
            <el-table
              :data="dim.groups"
              row-key="nodeKey"
              :tree-props="{ children: 'children' }"
              border
              size="small"
              class="cluster-table"
            >
              <el-table-column label="取值" min-width="180">
                <template #default="{ row }">
                  <span class="tree-level-tag" v-if="row.children">一级</span>
                  <span class="tree-level-tag sub" v-else-if="dim.subField">二级</span>
                  <el-tag size="small" type="primary">{{ row.key }}</el-tag>
                  <span v-if="row.subOthersCount" class="cell-more">另 {{ row.subOthersCount }} 条超 Top7</span>
                </template>
              </el-table-column>
              <el-table-column prop="count" label="条数" width="80" />
              <el-table-column prop="percent" label="占比" width="100">
                <template #default="{ row }">{{ row.percent }}%</template>
              </el-table-column>
              <!-- 统计展示列：按该维度（一级聚类维度）独立配置的 dim.statFields 动态渲染，未配置则不展示 -->
              <el-table-column
                v-for="sf in (dim.statFields || [])"
                :key="sf"
                :label="sf"
                min-width="160"
              >
                <template #default="{ row }">
                  <template v-if="(row.statistics || []).length">
                    <el-tag v-for="v in statDist(row, sf).slice(0, 3)" :key="v.value" size="small" class="cell-tag">
                      {{ v.value }} {{ v.count }}条
                    </el-tag>
                    <span v-if="statDist(row, sf).length > 3" class="cell-more">…等{{ statDist(row, sf).length }}个</span>
                  </template>
                  <span v-else class="text-muted">-</span>
                </template>
              </el-table-column>
              <el-table-column label="代表样本" min-width="240">
                <template #default="{ row }">
                  <el-collapse>
                    <el-collapse-item
                      v-for="(sample, i) in row.samples"
                      :key="i"
                      :title="`样本 ${i + 1}`"
                    >
                      <pre class="sample-body">{{ JSON.stringify(sample, null, 2) }}</pre>
                    </el-collapse-item>
                  </el-collapse>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <!-- AI 巡检日报卡片 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>AI 巡检日报</span>
          <div class="card-actions">
            <el-tag v-if="aiStatus.hasToken" size="small" type="success">Token 已配置</el-tag>
            <el-tag v-else size="small" type="danger">Token 未配置</el-tag>
            <el-tag v-if="aiStatus.model" size="small" type="info">{{ aiStatus.model }}</el-tag>
            <el-button size="small" :icon="MagicStick" :loading="generating" @click="generateReport(false)">
              生成日报
            </el-button>
            <el-button size="small" :icon="Cpu" :loading="generating" @click="generateReport(true)">Mock 生成</el-button>
            <el-button
              v-if="aiReport"
              size="small"
              type="primary"
              :icon="Download"
              @click="downloadReport"
            >下载 HTML</el-button>
            <el-button
              v-if="aiReport"
              size="small"
              :icon="Message"
              @click="openEmailDialog"
            >导出邮件(.eml)</el-button>
          </div>
        </div>
      </template>
      <div class="ai-report-hint">
        日报基于最近一次执行巡检生成的聚类摘要，分场景多次调用大模型（每次输入控制在 {{ aiStatus.maxCharsPerPrompt || 12000 }} 字内）后汇总，输出五段式日报（一、巡检概览；二、问题总览表；三、关键问题分析；四、人工分析情况；五、整体结论与处置建议），并按 AI 设置中的「报告规则与模板」判定关键问题、展示近 {{ aiStatus.reportRules.trendDays || 7 }} 天命中趋势。
        「Mock 生成」不调用大模型，用于本地演示与测试。
      </div>

      <!-- 人工矫正意见（全局生效，生成日报时喂给大模型参考） -->
      <el-collapse class="ai-corrections">
        <el-collapse-item :name="'corrections'">
          <template #title>
            <span class="ai-corrections-title">人工矫正意见</span>
            <el-tag size="small" type="warning" class="ai-corrections-count">{{ corrections.length }} 条</el-tag>
            <span class="ai-corrections-desc">生成日报时喂给大模型作为矫正/建议（全局生效）</span>
          </template>
          <div class="corrections-editor">
            <el-input
              v-model="correctionInput"
              type="textarea"
              :rows="3"
              placeholder="输入矫正意见/建议，如：外码 1001 属于正常业务流程，不算问题；充值失败的主要根因在 XX 服务"
            />
            <div class="corrections-actions">
              <el-button type="primary" size="small" :icon="Plus" @click="addCorrection">添加矫正意见</el-button>
            </div>
          </div>
          <div v-if="corrections.length" class="corrections-list">
            <div v-for="c in corrections" :key="c.id" class="correction-item">
              <span class="correction-content">{{ c.content }}</span>
              <el-button link type="danger" size="small" @click="removeCorrection(c)">删除</el-button>
            </div>
          </div>
          <el-empty v-else description="暂无矫正意见" :image-size="48" />
        </el-collapse-item>
      </el-collapse>

      <div v-if="generating" class="ai-generating">
        <el-progress :percentage="100" :indeterminate="true" :duration="3" :show-text="false" />
        <span>正在生成日报，可能需要数十秒到数分钟，请耐心等待…</span>
      </div>
      <div v-else-if="aiReport" class="ai-report-wrap">
        <iframe class="ai-report-frame" :srcdoc="aiReport.html" title="巡检日报" />
      </div>
      <el-empty v-else description="尚未生成日报，请先执行巡检（生成聚类摘要），再点击「生成日报」" :image-size="80" />
    </el-card>

    <!-- 调试面板：展示当前将发送的完整请求体（置于页面最下方） -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>调试</span>
          <div class="card-actions">
            <div class="debug-toggle">
              <span class="debug-toggle-label">详细日志模式</span>
              <el-switch v-model="debugModeEnabled" size="small" @change="toggleDebugMode" />
            </div>
            <el-button size="small" :icon="Search" @click="previewRequestBody">生成请求体</el-button>
            <el-button size="small" :icon="CopyDocument" @click="copyRequestBody">复制请求体</el-button>
            <el-button
              size="small"
              type="primary"
              :icon="VideoPlay"
              :loading="debugRunning"
              @click="runDebugQuery"
            >执行巡检（调试）</el-button>
          </div>
        </div>
      </template>
      <div class="debug-hint">此请求体为执行巡检时发送给 ClickHouse 的完整内容（cookie / x-csrf-token 由后端自动注入，不在此展示）。「执行巡检（调试）」不依赖场景勾选，直接对 wallet_client_hmos 表发起真实查询。</div>
      <pre class="debug-body">{{ requestBodyText || '（点击「生成请求体」查看完整请求体）' }}</pre>
      <div v-if="debugResultText" class="debug-result">
        <div class="debug-result-title">调试查询结果</div>
        <pre class="debug-body">{{ debugResultText }}</pre>
      </div>
    </el-card>

    <!-- AI 设置对话框 -->
    <el-dialog v-model="aiDialogVisible" title="AI 大模型设置" width="640px" @closed="resetAiForm">
      <el-form label-width="110px">
        <el-form-item label="API 地址">
          <el-input v-model="aiForm.endpoint" placeholder="https://.../v1/chat/completions" />
        </el-form-item>
        <el-form-item label="Token">
          <el-input v-model="aiToken" type="password" show-password placeholder="sk-xxx，仅填令牌本身（无需带 Bearer 前缀）" />
          <div class="ai-form-tip">
            已配置：{{ aiStatus.hasToken ? '是' : '否' }}
            <el-button v-if="aiStatus.hasToken" link type="danger" size="small" @click="clearAiToken">清除 Token</el-button>
          </div>
        </el-form-item>
        <el-form-item label="模型名称">
          <el-input v-model="aiForm.model" placeholder="如 DeepSeek_V4_Flash_Client" />
        </el-form-item>
        <el-form-item label="temperature">
          <el-input-number v-model="aiForm.temperature" :min="0" :max="2" :step="0.1" />
        </el-form-item>
        <el-form-item label="单次输入上限">
          <el-input-number v-model="aiForm.maxCharsPerPrompt" :min="1000" :max="100000" :step="1000" />
          <span class="ai-form-tip">字符（超出自动裁剪，默认 12000）</span>
        </el-form-item>
        <el-form-item label="超时时间">
          <el-input-number v-model="aiForm.timeoutMs" :min="30000" :max="600000" :step="10000" />
          <span class="ai-form-tip">毫秒（默认 120000）</span>
        </el-form-item>

        <el-divider content-position="left">报告规则与模板</el-divider>
        <el-form-item label="趋势天数">
          <el-input-number v-model="aiForm.reportRules.trendDays" :min="1" :max="30" />
          <span class="ai-form-tip">天（日报展示近 N 天各场景命中趋势）</span>
        </el-form-item>
        <el-form-item label="用户数阈值">
          <el-input-number v-model="aiForm.reportRules.userCountThreshold" :min="0" :max="100000" :step="10" />
          <span class="ai-form-tip">用户数 ≥ 阈值视为关键问题</span>
        </el-form-item>
        <el-form-item label="增幅阈值">
          <el-input-number v-model="aiForm.reportRules.increasePercent" :min="0" :max="1000" />
          <span class="ai-form-tip">%（较上次增幅 ≥ 阈值标为高危）</span>
        </el-form-item>
        <el-form-item label="关键问题上限">
          <el-input-number v-model="aiForm.reportRules.maxProblems" :min="1" :max="50" />
          <span class="ai-form-tip">条（问题总览最多列出）</span>
        </el-form-item>
        <el-form-item label="高危标记">
          <el-switch v-model="aiForm.reportRules.highRiskNew" active-text="新出现/激增标为高危" />
        </el-form-item>
        <el-form-item label="待确认优先">
          <el-switch v-model="aiForm.reportRules.pendingFirst" active-text="待确认且达阈值的问题排前" />
        </el-form-item>
        <el-form-item label="关注点">
          <el-input v-model="aiForm.reportTemplate.focus" type="textarea" :rows="2" placeholder="如：重点核查充值链路、关注 XX 版本回归问题（可空）" />
        </el-form-item>
        <el-form-item label="格式要求">
          <el-input v-model="aiForm.reportTemplate.format" type="textarea" :rows="2" placeholder="如：问题总览表需给出处置优先级、结论按影响面排序（可空）" />
        </el-form-item>
        <el-form-item label="附加指令">
          <el-input v-model="aiForm.reportTemplate.extra" type="textarea" :rows="2" placeholder="其他要求（可空）" />
        </el-form-item>
      </el-form>
      <!-- 模型测试结果（测试连接成功后展示） -->
      <div v-if="aiTestResult" class="ai-test-result" :class="aiTestResult.ok ? 'ok' : 'fail'">
        <template v-if="aiTestResult.ok">
          <div class="ai-test-title">连接成功 · 耗时 {{ aiTestResult.ms }} ms · 模型 {{ aiTestResult.model }}</div>
          <div class="ai-test-reply">模型回复：{{ aiTestResult.reply }}</div>
        </template>
        <template v-else>
          <div class="ai-test-title">连接失败</div>
          <div class="ai-test-reply">{{ aiTestResult.error }}</div>
        </template>
      </div>
      <template #footer>
        <div class="ai-test-footer">
          <el-button :loading="testingAi" :icon="Connection" @click="testAiConfig">测试连接</el-button>
          <span class="ai-test-footer-spacer"></span>
          <el-button @click="aiDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="savingAi" @click="saveAiConfig">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 导出邮件(.eml) 对话框 -->
    <el-dialog v-model="emailDialogVisible" title="导出为邮件（.eml，正文内嵌日报 HTML）" width="560px">
      <el-form label-width="80px">
        <el-form-item label="发件人">
          <el-input v-model="emailForm.from" placeholder="你的邮箱（可选，如 zhang@xx.com）" />
        </el-form-item>
        <el-form-item label="主送" required>
          <el-input v-model="emailForm.to" placeholder="多个邮箱用逗号分隔，如 a@xx.com,b@yy.com" />
        </el-form-item>
        <el-form-item label="抄送">
          <el-input v-model="emailForm.cc" placeholder="多个邮箱用逗号分隔（可空）" />
        </el-form-item>
        <el-form-item label="主题">
          <el-input v-model="emailForm.subject" placeholder="邮件主题" />
        </el-form-item>
      </el-form>
      <div class="email-hint">生成 .eml 文件后，用 Outlook / Foxmail 等双击打开会以「待发送」状态显示（可直接点发送按钮）；发件人留空时使用占位地址。</div>
      <template #footer>
        <el-button @click="emailDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="exportingEmail" @click="exportEml">保存并导出</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { ElMessage, ElNotification } from 'element-plus';
import { Refresh, Search, Download, CopyDocument, Connection, VideoPlay, Setting, MagicStick, Cpu, Plus, Message } from '@element-plus/icons-vue';

const credential = reactive({ configured: false, expired: false, expiredAt: '', source: '', updatedAt: '' });
const debugModeEnabled = ref(false);
const loggingIn = ref(false);
const savingSecrets = ref(false);
const manualForm = reactive({ cookie: '', xCsrfToken: '' });
const scenarios = ref([]);
const profiles = ref([]);
const selectedProfileId = ref('');
const dateRange = ref(null);
const running = ref(false);
const analysis = ref(null);
const requestBodyText = ref('');
const debugRunning = ref(false);
const debugResultText = ref('');

/* AI 巡检日报 */
const defaultReportRules = { trendDays: 7, userCountThreshold: 50, increasePercent: 50, highRiskNew: true, pendingFirst: true, maxProblems: 15 };
const defaultReportTemplate = { focus: '', format: '', extra: '' };
const aiStatus = reactive({ hasToken: false, model: '', endpoint: '', maxCharsPerPrompt: 12000, temperature: 0.2, timeoutMs: 240000, reportRules: { ...defaultReportRules }, reportTemplate: { ...defaultReportTemplate } });
const aiDialogVisible = ref(false);
const aiForm = reactive({ endpoint: '', model: '', temperature: 0.2, maxCharsPerPrompt: 12000, timeoutMs: 240000, reportRules: { ...defaultReportRules }, reportTemplate: { ...defaultReportTemplate } });
const aiToken = ref('');
const testingAi = ref(false);
const aiTestResult = ref(null);
const savingAi = ref(false);
const aiReport = ref(null);
const generating = ref(false);
/* 人工矫正意见 */
const corrections = ref([]);
const correctionInput = ref('');
/* 导出邮件(.eml) */
const emailDialogVisible = ref(false);
const exportingEmail = ref(false);
const emailForm = reactive({ from: '', to: '', cc: '', subject: '' });
/* 聚类摘要：展开的场景名列表，默认全部折叠 */
const expandedScenes = ref([]);

const plan = reactive({
  name: '',
  app_ver: '',
  enabled_scenarios: []
});

const scenarioGroups = computed(() => {
  const map = {};
  for (const s of scenarios.value) {
    if (!map[s.table]) map[s.table] = [];
    map[s.table].push(s);
  }
  return Object.keys(map).map((table) => ({ table, items: map[table] }));
});

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.msg || '请求失败');
  return json.data;
}

async function loadCredentials() {
  try {
    const data = await request('/api/health-check/credentials');
    credential.configured = data.configured;
    credential.expired = !!data.expired;
    credential.expiredAt = data.expiredAt || '';
    credential.source = data.source || '';
    credential.updatedAt = data.updatedAt || '';
  } catch (e) {
    ElMessage.error(e.message || '加载凭据状态失败');
  }
}

async function loadDebugMode() {
  try {
    const data = await request('/api/health-check/debug-mode');
    debugModeEnabled.value = !!data.enabled;
  } catch (e) {
    debugModeEnabled.value = false;
  }
}

async function toggleDebugMode(enabled) {
  try {
    await request('/api/health-check/debug-mode', {
      method: 'POST',
      body: JSON.stringify({ enabled })
    });
    ElMessage.success(enabled ? '已开启详细日志模式' : '已关闭详细日志模式');
  } catch (e) {
    debugModeEnabled.value = !enabled;
    ElMessage.error(e.message || '切换失败');
  }
}

async function wiseLogin() {
  loggingIn.value = true;
  try {
    ElMessage({
      message: '浏览器窗口已打开（或即将打开），请在弹出的浏览器中完成登录（手机号 + 短信验证码）。登录成功后本页面将自动更新。',
      type: 'info',
      duration: 8000,
      showClose: true
    });
    const data = await request('/api/health-check/wise-login', { method: 'POST' });
    credential.configured = data.configured;
    credential.expired = false;
    credential.expiredAt = '';
    credential.source = data.source || '';
    credential.updatedAt = data.updatedAt || '';
    ElMessage.success(data.configured ? '登录成功，凭据已获取' : '登录完成，但凭据不完整');
  } catch (e) {
    ElMessage.error(e.message || '登录失败');
  } finally {
    loggingIn.value = false;
  }
}

async function saveSecrets() {
  if (!manualForm.cookie.trim() || !manualForm.xCsrfToken.trim()) {
    ElMessage.warning('请填写 Cookie 和 x-csrf-token');
    return;
  }
  savingSecrets.value = true;
  try {
    const data = await request('/api/health-check/secrets', {
      method: 'POST',
      body: JSON.stringify({ cookie: manualForm.cookie.trim(), xCsrfToken: manualForm.xCsrfToken.trim() })
    });
    credential.configured = data.configured;
    credential.expired = false;
    credential.expiredAt = '';
    credential.source = data.source || '';
    credential.updatedAt = data.updatedAt || '';
    manualForm.cookie = '';
    manualForm.xCsrfToken = '';
    ElMessage.success('凭据已保存');
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    savingSecrets.value = false;
  }
}

async function loadScenarios() {
  try {
    const data = await request('/api/health-check/scenarios');
    scenarios.value = data.scenarios;
    // 自定义场景无 enabled 字段，默认全选所有已保存场景
    plan.enabled_scenarios = scenarios.value.map((s) => s.id);
  } catch (e) {
    ElMessage.error(e.message || '加载场景失败');
  }
}

async function loadProfiles() {
  try {
    const data = await request('/api/health-check/inspection-profiles');
    profiles.value = data.profiles;
    if (data.activeProfileId) {
      selectedProfileId.value = data.activeProfileId;
      const active = profiles.value.find((p) => p.id === data.activeProfileId);
      if (active) applyProfile(active);
    }
  } catch (e) {
    ElMessage.error(e.message || '加载巡检计划失败');
  }
}

function applyProfile(p) {
  plan.name = p.name;
  plan.app_ver = p.app_ver || '';
  plan.enabled_scenarios = Array.isArray(p.enabled_scenarios) ? [...p.enabled_scenarios] : [];
  if (p.beginTimestamp && p.endTimestamp) {
    dateRange.value = [p.beginTimestamp, p.endTimestamp];
  } else {
    dateRange.value = null;
  }
}

function loadProfile(id) {
  const p = profiles.value.find((x) => x.id === id);
  if (p) applyProfile(p);
}

function checkGroup(group, checked) {
  const ids = group.items.map((s) => s.id);
  if (checked) {
    plan.enabled_scenarios = [...new Set([...plan.enabled_scenarios, ...ids])];
  } else {
    plan.enabled_scenarios = plan.enabled_scenarios.filter((id) => !ids.includes(id));
  }
}

async function saveProfile() {
  if (!plan.name.trim()) {
    ElMessage.warning('请输入计划名称');
    return;
  }
  try {
    await request('/api/health-check/inspection-profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: plan.name,
        app_ver: plan.app_ver,
        beginTimestamp: dateRange.value ? dateRange.value[0] : '',
        endTimestamp: dateRange.value ? dateRange.value[1] : '',
        enabled_scenarios: plan.enabled_scenarios
      })
    });
    ElMessage.success('计划已保存');
    await loadProfiles();
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  }
}

function currentProfilePayload() {
  return {
    name: plan.name,
    app_ver: plan.app_ver,
    beginTimestamp: dateRange.value ? dateRange.value[0] : '',
    endTimestamp: dateRange.value ? dateRange.value[1] : '',
    enabled_scenarios: plan.enabled_scenarios
  };
}

async function runInspection() {
  if (plan.enabled_scenarios.length === 0) {
    ElMessage.warning('请至少选择一个巡检场景');
    return;
  }
  running.value = true;
  try {
    const res = await fetch('/api/health-check/export-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: currentProfilePayload() })
    });
    // 错误时后端返回 JSON；成功时为 xlsx 文件流
    const contentType = res.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const json = await res.json();
      throw new Error(json.msg || '巡检执行失败');
    }
    if (!res.ok) throw new Error(`巡检执行失败：HTTP ${res.status}`);
    const blob = await res.blob();
    // 从 Content-Disposition 解析文件名
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : `health-check-${Date.now()}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    ElMessage.success('巡检完成，Excel 已开始下载');
    // 下载后加载最新聚类摘要
    loadAnalysis();
  } catch (e) {
    ElMessage.error(e.message || '巡检执行失败');
    // 刷新凭据状态：若凭据确已过期，卡片立即显示红色过期提示
    loadCredentials();
    if (e.message && e.message.includes('凭据')) {
      ElNotification({
        title: '凭据需要更新',
        message: '执行巡检时凭据校验失败，请重新点击「Wise 登录」刷新凭据后再试',
        type: 'warning',
        duration: 0,
        showClose: true
      });
    }
  } finally {
    running.value = false;
  }
}

async function loadAnalysis() {
  try {
    const data = await request('/api/health-check/analysis/latest');
    analysis.value = data;
  } catch (e) {
    analysis.value = null;
  }
}

/** 从分组统计中取指定统计字段的取值分布（statistics 为 [{field, dist}]） */
function statDist(row, sf) {
  const s = (row.statistics || []).find((x) => x.field === sf);
  return s ? s.dist : [];
}

async function previewRequestBody() {
  if (plan.enabled_scenarios.length === 0) {
    ElMessage.warning('请至少选择一个巡检场景');
    return;
  }
  try {
    const body = await request('/api/health-check/debug/request-body', {
      method: 'POST',
      body: JSON.stringify({ profile: currentProfilePayload() })
    });
    requestBodyText.value = JSON.stringify(body, null, 2);
    ElMessage.success('请求体已生成');
  } catch (e) {
    ElMessage.error(e.message || '生成请求体失败');
  }
}

async function copyRequestBody() {
  if (!requestBodyText.value) {
    ElMessage.warning('请求体为空，请先生成');
    return;
  }
  try {
    await navigator.clipboard.writeText(requestBodyText.value);
    ElMessage.success('已复制');
  } catch (e) {
    ElMessage.error('复制失败，请手动选择复制');
  }
}

async function runDebugQuery() {
  debugRunning.value = true;
  debugResultText.value = '';
  try {
    const data = await request('/api/health-check/debug/run-query', {
      method: 'POST',
      body: JSON.stringify({
        profile: {
          app_ver: plan.app_ver,
          beginTimestamp: dateRange.value ? dateRange.value[0] : '',
          endTimestamp: dateRange.value ? dateRange.value[1] : ''
        }
      })
    });
    debugResultText.value = JSON.stringify(data, null, 2);
    ElMessage.success('调试查询完成');
  } catch (e) {
    debugResultText.value = '';
    ElMessage.error(e.message || '调试查询失败');
    // 刷新凭据状态 + 凭据过期醒目提示
    loadCredentials();
    if (e.message && e.message.includes('凭据')) {
      ElNotification({
        title: '凭据需要更新',
        message: '调试查询时凭据校验失败，请重新点击「Wise 登录」刷新凭据后再试',
        type: 'warning',
        duration: 0,
        showClose: true
      });
    }
  } finally {
    debugRunning.value = false;
  }
}

async function loadAiConfig() {
  try {
    const data = await request('/api/health-check/ai-config');
    aiStatus.hasToken = !!data.hasToken;
    aiStatus.model = data.model || '';
    aiStatus.endpoint = data.endpoint || '';
    aiStatus.maxCharsPerPrompt = data.maxCharsPerPrompt || 12000;
    aiStatus.temperature = data.temperature !== undefined ? data.temperature : 0.2;
    aiStatus.timeoutMs = data.timeoutMs || 240000;
    aiStatus.reportRules = { ...defaultReportRules, ...(data.reportRules || {}) };
    aiStatus.reportTemplate = { ...defaultReportTemplate, ...(data.reportTemplate || {}) };
  } catch (e) {
    ElMessage.error(e.message || '加载 AI 配置失败');
  }
}

function openAiConfig() {
  aiForm.endpoint = aiStatus.endpoint;
  aiForm.model = aiStatus.model;
  aiForm.temperature = aiStatus.temperature;
  aiForm.maxCharsPerPrompt = aiStatus.maxCharsPerPrompt;
  aiForm.timeoutMs = aiStatus.timeoutMs;
  aiForm.reportRules = { ...aiStatus.reportRules };
  aiForm.reportTemplate = { ...aiStatus.reportTemplate };
  aiToken.value = '';
  aiDialogVisible.value = true;
}

function resetAiForm() {
  aiToken.value = '';
  aiTestResult.value = null;
}

/** 测试模型连通性：用表单当前值（未保存也能测），不写入配置 */
async function testAiConfig() {
  testingAi.value = true;
  aiTestResult.value = null;
  try {
    const data = await request('/api/health-check/ai-test', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: aiForm.endpoint,
        model: aiForm.model,
        temperature: aiForm.temperature,
        timeoutMs: aiForm.timeoutMs,
        // 自动去掉用户误填的 Bearer 前缀；Token 留空时后端回退到已保存的 Token
        token: aiToken.value.trim().replace(/^Bearer\s+/i, '') || undefined
      })
    });
    aiTestResult.value = data;
  } catch (e) {
    aiTestResult.value = { ok: false, error: e.message || '测试失败' };
  } finally {
    testingAi.value = false;
  }
}

async function saveAiConfig() {
  savingAi.value = true;
  try {
    const data = await request('/api/health-check/ai-config', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: aiForm.endpoint,
        model: aiForm.model,
        temperature: aiForm.temperature,
        maxCharsPerPrompt: aiForm.maxCharsPerPrompt,
        timeoutMs: aiForm.timeoutMs,
        reportRules: aiForm.reportRules,
        reportTemplate: aiForm.reportTemplate,
        // 自动去掉用户误填的 Bearer 前缀，避免 Authorization 双写
        token: aiToken.value.trim().replace(/^Bearer\s+/i, '') || undefined
      })
    });
    aiStatus.hasToken = !!data.hasToken;
    aiStatus.model = data.model || '';
    aiStatus.endpoint = data.endpoint || '';
    aiStatus.maxCharsPerPrompt = data.maxCharsPerPrompt || 12000;
    aiStatus.temperature = data.temperature !== undefined ? data.temperature : 0.2;
    aiStatus.timeoutMs = data.timeoutMs || 240000;
    aiStatus.reportRules = { ...defaultReportRules, ...(data.reportRules || {}) };
    aiStatus.reportTemplate = { ...defaultReportTemplate, ...(data.reportTemplate || {}) };
    aiDialogVisible.value = false;
    ElMessage.success(aiToken.value.trim() ? 'AI 配置已保存（Token 已更新）' : 'AI 配置已保存');
  } catch (e) {
    ElMessage.error(e.message || '保存 AI 配置失败');
  } finally {
    savingAi.value = false;
  }
}

async function clearAiToken() {
  try {
    await request('/api/health-check/ai-config', {
      method: 'POST',
      body: JSON.stringify({ __clearToken: true })
    });
    aiStatus.hasToken = false;
    aiToken.value = '';
    ElMessage.success('Token 已清除');
  } catch (e) {
    ElMessage.error(e.message || '清除 Token 失败');
  }
}

async function generateReport(mock) {
  if (!mock && !aiStatus.hasToken) {
    ElMessage.warning('AI Token 未配置，请先点击「AI 设置」填写 Token（或使用 Mock 生成）');
    return;
  }
  if (!analysis.value) {
    ElMessage.warning('暂无聚类摘要，请先执行巡检');
    return;
  }
  generating.value = true;
  aiReport.value = null;
  try {
    ElMessage({ message: '正在调用大模型生成日报，可能需要数十秒到数分钟，请耐心等待…', type: 'info', duration: 5000, showClose: true });
    const data = await request('/api/health-check/ai-report', {
      method: 'POST',
      body: JSON.stringify({ mock })
    });
    aiReport.value = data;
    ElMessage.success(mock ? 'Mock 日报已生成' : '日报生成完成');
  } catch (e) {
    ElMessage.error(e.message || '生成日报失败');
  } finally {
    generating.value = false;
  }
}

function downloadReport() {
  if (!aiReport.value || !aiReport.value.html) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([aiReport.value.html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `巡检日报-${stamp}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  ElMessage.success('日报 HTML 已开始下载');
}

/* ---------- 人工矫正意见 ---------- */
async function loadCorrections() {
  try {
    const data = await request('/api/health-check/ai-corrections');
    corrections.value = data.corrections || [];
  } catch (e) {
    ElMessage.error(e.message || '加载矫正意见失败');
  }
}

async function addCorrection() {
  const content = correctionInput.value.trim();
  if (!content) {
    ElMessage.warning('请先输入矫正意见');
    return;
  }
  try {
    await request('/api/health-check/ai-corrections', {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    correctionInput.value = '';
    ElMessage.success('矫正意见已添加');
    loadCorrections();
  } catch (e) {
    ElMessage.error(e.message || '添加失败');
  }
}

async function removeCorrection(c) {
  try {
    await request(`/api/health-check/ai-corrections/${c.id}`, { method: 'DELETE' });
    ElMessage.success('已删除');
    loadCorrections();
  } catch (e) {
    ElMessage.error(e.message || '删除失败');
  }
}

/* ---------- 导出邮件(.eml) ---------- */
async function loadEmailConfig() {
  try {
    const data = await request('/api/health-check/email-config');
    emailForm.from = data.from || '';
    emailForm.to = data.to || '';
    emailForm.cc = data.cc || '';
    emailForm.subject = data.subject || '';
  } catch (e) {
    /* 忽略加载失败，使用空表单 */
  }
}

async function openEmailDialog() {
  emailDialogVisible.value = true;
  await loadEmailConfig();
  // 主题为空时给默认值（计划名为空或为 'unnamed' 时不带计划名）
  if (!emailForm.subject.trim()) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const planName = analysis.value ? analysis.value.plan : '';
    const planLabel = planName && planName !== 'unnamed' ? ` - ${planName}` : '';
    emailForm.subject = `业务巡检日报${planLabel} - ${day}`;
  }
}

async function exportEml() {
  if (!aiReport.value || !aiReport.value.html) {
    ElMessage.warning('请先生成日报');
    return;
  }
  if (!emailForm.to.trim()) {
    ElMessage.warning('请填写主送收件人邮箱');
    return;
  }
  exportingEmail.value = true;
  try {
    // 保存配置，供下次预填
    await request('/api/health-check/email-config', {
      method: 'POST',
      body: JSON.stringify({ from: emailForm.from, to: emailForm.to, cc: emailForm.cc, subject: emailForm.subject })
    });
    // 生成 .eml 并下载
    const res = await fetch('/api/health-check/ai-report-eml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: emailForm.from, to: emailForm.to, cc: emailForm.cc, subject: emailForm.subject, html: aiReport.value.html })
    });
    const contentType = res.headers.get('Content-Type') || '';
    if (contentType.includes('message/rfc822')) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `巡检日报-${new Date().toISOString().slice(0, 10)}.eml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      ElMessage.success('邮件文件已生成，可用 Outlook / Foxmail 打开后发送');
      emailDialogVisible.value = false;
    } else {
      const json = await res.json();
      throw new Error(json.msg || '生成邮件失败');
    }
  } catch (e) {
    ElMessage.error(e.message || '生成邮件失败');
  } finally {
    exportingEmail.value = false;
  }
}

onMounted(() => {
  loadCredentials();
  loadScenarios();
  loadProfiles();
  loadDebugMode();
  loadAnalysis();
  loadAiConfig();
  loadCorrections();
});
</script>

<style scoped>
.card {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.debug-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 4px;
}
.debug-toggle-label {
  font-size: 13px;
  color: #606266;
}
.credential-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.dot-green {
  background: #52c41a;
}
.dot-yellow {
  background: #faad14;
}
.dot-red {
  background: #f5222d;
}
.credential-text {
  font-size: 14px;
  color: #303133;
}
.credential-collapse {
  margin-top: 12px;
  max-width: 720px;
}
.debug-hint {
  font-size: 12px;
  color: #909399;
  margin-bottom: 8px;
}
.debug-body {
  max-height: 320px;
  overflow: auto;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.debug-result {
  margin-top: 12px;
}
.debug-result-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.profile-form {
  margin-bottom: 8px;
}
.scenario-group {
  margin-bottom: 14px;
}
.scenario-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.scenario-checkbox {
  margin-right: 12px;
  margin-bottom: 8px;
}
.profile-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.selected-count {
  font-size: 13px;
  color: #909399;
}
.cluster-collapse {
  border: none;
}
.cluster-collapse :deep(.el-collapse-item__header) {
  border-bottom: 1px solid #e4e7ed;
}
.cluster-collapse :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}
.cluster-scene {
  margin-bottom: 18px;
}
.cluster-dim {
  margin-bottom: 12px;
}
.cluster-dim-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tree-level-tag {
  display: inline-block;
  font-size: 11px;
  color: #e6a23c;
  border: 1px solid #e6a23c;
  border-radius: 3px;
  padding: 0 4px;
  margin-right: 6px;
}
.tree-level-tag.sub {
  color: #909399;
  border-color: #c0c4cc;
}
.cluster-scene-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 0;
  padding-right: 8px;
}
.cluster-scene-name {
  font-weight: 600;
  font-size: 15px;
  color: #303133;
}
.cluster-table {
  margin-bottom: 6px;
}
.cell-line {
  display: block;
  font-size: 13px;
  color: #606266;
  line-height: 1.8;
}
.cell-tag {
  margin-right: 6px;
  margin-bottom: 4px;
}
.cell-more {
  font-size: 12px;
  color: #909399;
}
.ext-line {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.9;
}
.ext-tag {
  flex-shrink: 0;
}
.ext-count {
  font-size: 13px;
  color: #606266;
}
.ext-percent {
  font-size: 12px;
  color: #909399;
}
.sample-body {
  font-size: 12px;
  line-height: 1.5;
  background: #f5f7fa;
  border-radius: 4px;
  padding: 8px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.ai-report-hint {
  font-size: 12px;
  color: #909399;
  margin-bottom: 10px;
  line-height: 1.7;
}
.ai-corrections {
  margin: 4px 0 12px;
  border: none;
}
.ai-corrections :deep(.el-collapse-item__header) {
  border-bottom: 1px solid #e4e7ed;
}
.ai-corrections-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-right: 8px;
}
.ai-corrections-count {
  margin-right: 8px;
}
.ai-corrections-desc {
  font-size: 12px;
  color: #909399;
  margin-left: 4px;
}
.corrections-editor {
  padding: 4px 0;
}
.corrections-actions {
  margin-top: 8px;
}
.corrections-list {
  margin-top: 10px;
  max-height: 260px;
  overflow: auto;
}
.correction-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  margin-bottom: 8px;
  background: #fafafa;
}
.correction-content {
  font-size: 13px;
  color: #303133;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.email-hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
  margin-top: -4px;
  padding: 0 2px;
}
.ai-generating {
  padding: 24px 8px;
  text-align: center;
  color: #909399;
  font-size: 13px;
}
.ai-generating span {
  display: block;
  margin-top: 10px;
}
.ai-report-wrap {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  overflow: hidden;
}
.ai-report-frame {
  width: 100%;
  height: 640px;
  border: none;
  display: block;
  background: #fff;
}
.ai-form-tip {
  font-size: 12px;
  color: #909399;
  margin-left: 8px;
}
.ai-test-result {
  margin: 12px 0 0;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.7;
  word-break: break-all;
}
.ai-test-result.ok {
  background: #f0f9eb;
  border: 1px solid #e1f3d8;
  color: #529b2e;
}
.ai-test-result.fail {
  background: #fef0f0;
  border: 1px solid #fde2e2;
  color: #f56c6c;
}
.ai-test-title {
  font-weight: 600;
}
.ai-test-reply {
  margin-top: 4px;
  color: #606266;
}
.ai-test-footer {
  display: flex;
  align-items: center;
  width: 100%;
}
.ai-test-footer-spacer {
  flex: 1;
}
</style>
