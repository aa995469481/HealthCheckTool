<template>
  <div class="hc-page">
    <!-- 凭据设置卡片 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>凭据设置</span>
          <div class="card-actions">
            <el-button size="small" type="primary" :icon="Connection" :loading="loggingIn" @click="wiseLogin">
              Wise 登录
            </el-button>
            <el-button size="small" :icon="Refresh" @click="loadCredentials">刷新状态</el-button>
          </div>
        </div>
      </template>
      <div class="credential-row">
        <span class="dot" :class="credential.configured ? 'dot-green' : 'dot-yellow'"></span>
        <span class="credential-text">
          {{ credential.configured ? '凭据已配置' : '凭据未配置，请点击「Wise 登录」自动获取，或手动粘贴' }}
        </span>
        <el-tag v-if="credential.source" size="small" type="info">{{ credential.source }}</el-tag>
        <el-tag v-if="credential.updatedAt" size="small" type="warning">更新于 {{ credential.updatedAt }}</el-tag>
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
            type="daterange"
            range-separator="至"
            start-placeholder="开始"
            end-placeholder="结束"
            value-format="YYYY-MM-DD HH:mm:ss"
            style="width: 300px"
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
        <el-button type="primary" :icon="Search" :loading="running" @click="runInspection">
          执行巡检
        </el-button>
        <span class="selected-count">已选 {{ plan.enabled_scenarios.length }} 个场景</span>
      </div>
    </el-card>

    <!-- 巡检结果卡片 -->
    <el-card v-if="result" shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>巡检结果</span>
          <div class="card-actions">
            <el-button size="small" :icon="Download" @click="downloadJson">下载完整 JSON</el-button>
            <el-button size="small" :icon="CopyDocument" @click="copyJson">复制完整 JSON</el-button>
          </div>
        </div>
      </template>

      <el-descriptions :column="3" border size="small" class="result-overview">
        <el-descriptions-item label="导出时间">{{ result.exportedAt }}</el-descriptions-item>
        <el-descriptions-item label="建议文件名">{{ result.filename }}</el-descriptions-item>
        <el-descriptions-item label="计划名称">{{ result.planName }}</el-descriptions-item>
        <el-descriptions-item label="目标版本">{{ result.appVer || '-' }}</el-descriptions-item>
        <el-descriptions-item label="时间范围">
          {{ result.beginTimestamp || '-' }} ~ {{ result.endTimestamp || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="整体结论">
          <el-tag :type="result.partial ? 'danger' : 'success'" size="small">
            {{ result.partial ? '存在失败' : '全部正常' }}
          </el-tag>
        </el-descriptions-item>
      </el-descriptions>

      <div class="scenario-grid">
        <el-card v-for="s in result.scenarios" :key="s.id" shadow="hover" class="scenario-card">
          <div class="scenario-card-header">
            <span class="scenario-title">{{ s.title }}</span>
            <el-tag :type="s.status === 'success' ? 'success' : 'danger'" size="small">
              {{ s.status === 'success' ? '成功' : '失败' }}
            </el-tag>
          </div>
          <div class="scenario-meta">{{ s.table }} · {{ s.cluster }}</div>
          <div class="scenario-summary">{{ s.summary }}</div>
          <div class="metric-row">
            <div class="metric"><span class="metric-num">{{ s.stats.hit }}</span><span class="metric-label">命中数</span></div>
            <div class="metric"><span class="metric-num success">{{ s.stats.success }}</span><span class="metric-label">成功数</span></div>
            <div class="metric"><span class="metric-num danger">{{ s.stats.failed }}</span><span class="metric-label">失败数</span></div>
            <div class="metric"><span class="metric-num">{{ s.stats.successRate }}%</span><span class="metric-label">成功率</span></div>
          </div>
          <template v-if="s.failureDistribution.length">
            <div class="dist-title">失败分布</div>
            <div class="dist-row" v-for="d in s.failureDistribution" :key="d.code">
              <el-tag size="small" type="danger">{{ d.code }}</el-tag>
              <span class="dist-count">{{ d.count }} 条</span>
            </div>
          </template>
        </el-card>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, Search, Download, CopyDocument, Connection } from '@element-plus/icons-vue';

const credential = reactive({ configured: false, source: '', updatedAt: '' });
const loggingIn = ref(false);
const savingSecrets = ref(false);
const manualForm = reactive({ cookie: '', xCsrfToken: '' });
const scenarios = ref([]);
const profiles = ref([]);
const selectedProfileId = ref('');
const dateRange = ref(null);
const running = ref(false);
const result = ref(null);

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
    credential.source = data.source || '';
    credential.updatedAt = data.updatedAt || '';
  } catch (e) {
    ElMessage.error(e.message || '加载凭据状态失败');
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
    plan.enabled_scenarios = scenarios.value.filter((s) => s.enabled).map((s) => s.id);
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

async function runInspection() {
  if (plan.enabled_scenarios.length === 0) {
    ElMessage.warning('请至少选择一个巡检场景');
    return;
  }
  running.value = true;
  try {
    const data = await request('/api/health-check/export-json', {
      method: 'POST',
      body: JSON.stringify({
        profile: {
          name: plan.name,
          app_ver: plan.app_ver,
          beginTimestamp: dateRange.value ? dateRange.value[0] : '',
          endTimestamp: dateRange.value ? dateRange.value[1] : '',
          enabled_scenarios: plan.enabled_scenarios
        }
      })
    });
    result.value = data.data;
    ElMessage.success('巡检执行完成');
  } catch (e) {
    ElMessage.error(e.message || '巡检执行失败');
  } finally {
    running.value = false;
  }
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(result.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.value.filename || 'health-check.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(result.value, null, 2));
    ElMessage.success('已复制');
  } catch (e) {
    ElMessage.error('复制失败');
  }
}

onMounted(() => {
  loadCredentials();
  loadScenarios();
  loadProfiles();
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
  gap: 8px;
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
.credential-text {
  font-size: 14px;
  color: #303133;
}
.credential-collapse {
  margin-top: 12px;
  max-width: 720px;
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
.result-overview {
  margin-bottom: 16px;
}
.scenario-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.scenario-card {
  border-radius: 8px;
}
.scenario-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.scenario-title {
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}
.scenario-meta {
  font-size: 12px;
  color: #909399;
  margin: 4px 0 8px;
}
.scenario-summary {
  font-size: 13px;
  color: #606266;
  margin-bottom: 10px;
  line-height: 1.6;
}
.metric-row {
  display: flex;
  gap: 16px;
  margin-bottom: 8px;
}
.metric {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.metric-num {
  font-size: 18px;
  font-weight: 700;
  color: #303133;
}
.metric-num.success {
  color: #52c41a;
}
.metric-num.danger {
  color: #f5222d;
}
.metric-label {
  font-size: 12px;
  color: #909399;
}
.dist-title {
  font-size: 13px;
  color: #303133;
  font-weight: 600;
  margin: 6px 0;
}
.dist-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.dist-count {
  font-size: 13px;
  color: #606266;
}
</style>
