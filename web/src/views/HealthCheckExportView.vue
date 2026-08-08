<template>
  <div class="hc-page">
    <!-- 凭据设置卡片 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>凭据设置</span>
          <div class="card-actions">
            <div class="debug-toggle">
              <span class="debug-toggle-label">详细日志模式</span>
              <el-switch v-model="debugModeEnabled" size="small" @change="toggleDebugMode" />
            </div>
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

    <!-- 调试面板：展示当前将发送的完整请求体 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>调试：请求体预览</span>
          <div class="card-actions">
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

      <div v-for="s in analysis.summaries" :key="s.scenarioTitle" class="cluster-scene">
        <div class="cluster-scene-title">
          <span class="cluster-scene-name">{{ s.scenarioTitle }}</span>
          <el-tag size="small" type="info">共 {{ s.total }} 条</el-tag>
          <el-tag v-if="s.clusterFields && s.clusterFields.length" size="small" type="warning">
            聚类：{{ s.clusterFields.join(' → ') }}
          </el-tag>
          <el-tag v-if="s.others" size="small" type="warning">其他小聚类 {{ s.others.count }} 条</el-tag>
        </div>

        <el-table
          :data="s.groups"
          row-key="nodeKey"
          :tree-props="{ children: 'children' }"
          border
          size="small"
          class="cluster-table"
          default-expand-all
        >
          <el-table-column label="分组（多级下钻）" min-width="240">
            <template #default="{ row }">
              <el-tag size="small" :type="row.children ? 'danger' : 'primary'">
                {{ row.field }} = {{ row.key }}
              </el-tag>
              <span v-if="row.others" class="cell-more">下级另有 {{ row.others }} 条小聚类</span>
            </template>
          </el-table-column>
          <el-table-column prop="count" label="条数" width="80" />
          <el-table-column prop="percent" label="占比" width="90">
            <template #default="{ row }">{{ row.percent }}%</template>
          </el-table-column>
          <el-table-column label="版本分布" min-width="190">
            <template #default="{ row }">
              <el-tag v-for="v in row.versionDist.slice(0, 3)" :key="v.version" size="small" class="cell-tag">
                {{ v.version }} {{ v.count }}条
              </el-tag>
              <span v-if="row.versionDist.length > 3" class="cell-more">…等{{ row.versionDist.length }}个版本</span>
            </template>
          </el-table-column>
          <el-table-column label="代表样本" min-width="240">
            <template #default="{ row }">
              <el-collapse v-if="row.samples && row.samples.length">
                <el-collapse-item
                  v-for="(sample, i) in row.samples"
                  :key="i"
                  :title="`样本 ${i + 1}`"
                >
                  <pre class="sample-body">{{ JSON.stringify(sample, null, 2) }}</pre>
                </el-collapse-item>
              </el-collapse>
              <span v-else class="cell-more">展开下级分组查看样本</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { ElMessage, ElNotification } from 'element-plus';
import { Refresh, Search, Download, CopyDocument, Connection, VideoPlay } from '@element-plus/icons-vue';

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

onMounted(() => {
  loadCredentials();
  loadScenarios();
  loadProfiles();
  loadDebugMode();
  loadAnalysis();
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
.cluster-scene {
  margin-bottom: 18px;
}
.cluster-scene-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
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
</style>
