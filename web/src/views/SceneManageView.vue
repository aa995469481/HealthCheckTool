<template>
  <div class="scene-page">
    <!-- 解析输入区 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>
            {{ editingId ? '编辑巡检场景' : '创建巡检场景' }}
            <el-tag v-if="editingId" size="small" type="warning" class="editing-tag">
              正在编辑：{{ sceneDraft && sceneDraft.title }}
            </el-tag>
          </span>
          <div class="card-actions">
            <el-button v-if="editingId" size="small" @click="cancelEdit">取消编辑</el-button>
            <el-button size="small" :icon="Search" :loading="parsing" :disabled="!!editingId" @click="parseScene">解析生成场景</el-button>
            <el-button size="small" type="primary" :icon="CircleCheck" :loading="saving" @click="saveScene">
              {{ editingId ? '保存修改' : '保存场景' }}
            </el-button>
          </div>
        </div>
      </template>
      <el-form label-width="90px">
        <template v-if="!editingId">
          <el-form-item label="请求 URL">
            <el-input
              v-model="inputUrl"
              type="textarea"
              :rows="5"
              placeholder="粘贴完整的日志检索页面 URL（含 #/log_search#&logConsoleId=...&logSearchParams=...）"
            />
          </el-form-item>
          <el-form-item label="请求体 JSON">
            <el-input
              v-model="inputBody"
              type="textarea"
              :rows="10"
              placeholder='粘贴查询接口的完整请求体 JSON，例如：{ "name": "wallet_client_hmos", "cluster": "...", "filterCondition": { ... } }'
            />
          </el-form-item>
        </template>
      </el-form>

      <!-- 解析结果：校验提示 -->
      <div v-if="warnings.length" class="warn-box">
        <div class="warn-title">解析提示（{{ warnings.length }} 条）</div>
        <div v-for="(w, i) in warnings" :key="i" class="warn-item">{{ w }}</div>
      </div>

      <!-- 解析结果：场景草案 -->
      <div v-if="sceneDraft" class="draft-box">
        <div class="draft-title">解析出的场景信息</div>
        <el-form label-width="110px" class="draft-form">
          <el-form-item label="场景标题" required>
            <el-input v-model="sceneDraft.title" placeholder="请输入场景标题，如：交通卡充值失败巡检" style="max-width: 360px" />
          </el-form-item>
          <el-form-item label="表名 table">
            <el-input v-model="sceneDraft.table" style="max-width: 320px" />
          </el-form-item>
          <el-form-item label="集群 cluster">
            <el-input v-model="sceneDraft.cluster" placeholder="请求体未包含时可手动填写" style="max-width: 320px" />
          </el-form-item>
          <el-form-item label="queryString">
            <el-input v-model="sceneDraft.queryString" style="max-width: 160px" />
          </el-form-item>
          <el-form-item label="granularity">
            <el-input-number v-model="sceneDraft.granularity" :min="0" />
          </el-form-item>
          <el-form-item label="dataSourceServiceId">
            <el-input v-model="sceneDraft.dataSourceServiceId" style="max-width: 420px" />
          </el-form-item>
          <el-form-item label="排序字段">
            <el-input v-model="sceneDraft.orderFieldName" placeholder="orderFieldName，如：happenedTime" style="max-width: 240px" />
            <span class="order-sep">orderType</span>
            <el-select v-model="sceneDraft.orderType" style="width: 110px">
              <el-option label="升序" value="asc" />
              <el-option label="降序" value="desc" />
              <el-option label="空" value="" />
            </el-select>
          </el-form-item>
          <el-form-item label="关注字段">
            <div class="focus-fields">
              <el-tag
                v-for="(f, i) in sceneDraft.focusFields"
                :key="i"
                type="success"
                effect="plain"
                closable
                @close="sceneDraft.focusFields.splice(i, 1)"
              >{{ f }}</el-tag>
              <el-input
                v-if="focusInputVisible"
                ref="focusInputRef"
                v-model="focusInput"
                size="small"
                style="width: 180px"
                @keyup.enter="addFocusField"
                @blur="addFocusField"
              />
              <el-button v-else size="small" @click="showFocusInput">+ 添加</el-button>
            </div>
            <div class="focus-hint">关注字段来自 URL 的 dynamicTableColumns，用于响应数据处理（如错误码提取、结果展示）</div>
          </el-form-item>

          <el-form-item label="聚类字段">
            <div class="cluster-fields">
              <template v-if="sceneDraft.focusFields.length">
                <el-checkbox-group v-model="sceneDraft.clusterFields" class="cluster-check-group">
                  <el-checkbox
                    v-for="f in sceneDraft.focusFields"
                    :key="f"
                    :label="f"
                    class="cluster-check-item"
                  >{{ f }}</el-checkbox>
                </el-checkbox-group>
              </template>
              <template v-else>
                <el-tag
                  v-for="(f, i) in sceneDraft.clusterFields"
                  :key="i"
                  type="warning"
                  effect="plain"
                  closable
                  @close="sceneDraft.clusterFields.splice(i, 1)"
                >{{ f }}</el-tag>
              </template>
              <div class="focus-hint" style="margin-top: 6px">
                可多选，每个字段都是独立的 1 级分析维度（按字段取值分别分组，并列展示，互不级联）；勾选/取消即启用/停用该维度
              </div>

              <!-- 二级聚类配置 + 统计展示列：每个一级维度一行，可配置二级下钻字段与该维度统计展示列 -->
              <template v-if="sceneDraft.clusterFields.length">
                <div class="sub-cluster-title">二级聚类下钻与统计展示列（可选，每个一级维度各自配置）</div>
                <div v-for="f in sceneDraft.clusterFields" :key="f" class="sub-cluster-row">
                  <el-tag size="small" type="warning" effect="plain" class="sub-cluster-level">{{ f }}</el-tag>
                  <el-select
                    :model-value="sceneDraft.clusterSubFields[f] || ''"
                    placeholder="二级下钻字段（可选）"
                    size="small"
                    clearable
                    style="width: 190px"
                    @change="(v) => onSubFieldChange(f, v)"
                  >
                    <el-option v-for="sf in subFieldOptions(f)" :key="sf" :label="sf" :value="sf" />
                  </el-select>
                  <span class="sub-cluster-sep">统计展示列</span>
                  <el-select
                    :model-value="sceneDraft.clusterStatFields[f] || []"
                    placeholder="统计展示列（可选，多选）"
                    multiple
                    collapse-tags
                    size="small"
                    style="width: 300px"
                    @change="(v) => onStatFieldsChange(f, v)"
                  >
                    <el-option v-for="sf in sceneDraft.focusFields" :key="sf" :label="sf" :value="sf" />
                  </el-select>
                </div>
                <div class="focus-hint" style="margin-top: 4px">
                  每个维度的统计展示列独立配置：选中的字段作为该维度聚类摘要中的统计列（按字段取值分布展示，如勾选 _app_ver 即版本分布列）；未配置则该维度不展示统计列，AI 分析输入同样跟随
                </div>
              </template>
            </div>
          </el-form-item>
        </el-form>

        <!-- 过滤条件概览 -->
        <div class="filter-section">
          <div class="draft-subtitle">过滤条件（filterCondition）</div>
          <div v-for="(items, type) in sceneDraft.filterCondition" :key="type" class="filter-line">
            <el-tag size="small" type="info" class="filter-type">{{ type }}</el-tag>
            <span class="filter-content">
              <template v-for="(entry, idx) in items" :key="idx">
                <template v-for="(info, key) in entry" :key="key">
                  <el-tag size="small" type="primary" class="filter-kv">{{ key }} = {{ JSON.stringify(info.propertyList) }}</el-tag>
                </template>
              </template>
            </span>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 已保存场景列表 -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>已保存场景（{{ scenes.length }}）</span>
          <div class="card-actions">
            <el-button size="small" :icon="Download" :loading="exporting" @click="exportScenes">导出 JSON</el-button>
            <el-button size="small" :icon="Upload" :loading="importing" @click="pickImportFile">导入 JSON</el-button>
            <el-button size="small" :icon="Refresh" @click="loadScenes">刷新</el-button>
          </div>
        </div>
      </template>
      <input ref="fileInputRef" type="file" accept=".json,application/json" style="display: none" @change="onFileChange" />
      <div class="import-hint">
        导入为 JSON 文件（巡检场景管理「导出 JSON」生成）：按「场景标题」匹配，已存在则覆盖更新（保留原 ID 与失败场景库的关联），不存在则新增
      </div>
      <el-table :data="scenes" stripe v-loading="loading">
        <el-table-column prop="title" label="场景标题" min-width="200" show-overflow-tooltip />
        <el-table-column prop="table" label="表名" width="160" />
        <el-table-column prop="cluster" label="集群" width="180" />
        <el-table-column label="过滤条件数" width="110">
          <template #default="{ row }">
            {{ countFilters(row.filterCondition) }}
          </template>
        </el-table-column>
        <el-table-column label="关注字段" min-width="180">
          <template #default="{ row }">
            <el-tag v-for="(f, i) in (row.focusFields || [])" :key="i" size="small" type="success" effect="plain">{{ f }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="聚类维度" min-width="170">
          <template #default="{ row }">
            <div v-if="(row.clusterFields || []).length">
              <el-tag
                v-for="f in row.clusterFields"
                :key="f"
                size="small"
                type="warning"
                effect="plain"
                class="scene-cluster-tag"
              >
                {{ f }}<span v-if="row.clusterSubFields && row.clusterSubFields[f]" class="scene-cluster-sub">↓{{ row.clusterSubFields[f] }}</span>
              </el-tag>
            </div>
            <span v-else class="text-muted">默认(内码+外码)</span>
          </template>
        </el-table-column>
        <el-table-column label="统计展示列" min-width="170">
          <template #default="{ row }">
            <div v-for="(fields, f) in (row.clusterStatFields || {})" :key="f" class="scene-stat-row">
              <span class="scene-stat-field">{{ f }}:</span>
              <el-tag v-for="sf in fields" :key="sf" size="small" type="primary" effect="plain">{{ sf }}</el-tag>
            </div>
            <span v-if="!Object.keys(row.clusterStatFields || {}).length" class="text-muted">未配置(不展示)</span>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="170" />
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="editScene(row)">编辑</el-button>
            <el-button link type="danger" @click="removeScene(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Refresh, CircleCheck, Download, Upload } from '@element-plus/icons-vue';

const route = useRoute();

const inputUrl = ref('');
const inputBody = ref('');
const parsing = ref(false);
const saving = ref(false);
const loading = ref(false);
const exporting = ref(false);
const importing = ref(false);
const fileInputRef = ref();
const sceneDraft = ref(null);
const editingId = ref('');
const warnings = ref([]);
const scenes = ref([]);

const focusInputVisible = ref(false);
const focusInput = ref('');
const focusInputRef = ref();

async function request(url, options = {}) {
  const fw = route.meta.framework || 'single';
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}framework=${fw}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.msg || '请求失败');
  return json.data;
}

async function loadScenes() {
  loading.value = true;
  try {
    const data = await request('/api/health-check/scenarios');
    scenes.value = data.scenarios || [];
  } catch (e) {
    ElMessage.error(e.message || '加载场景失败');
  } finally {
    loading.value = false;
  }
}

/** 导出全部场景为 JSON 文件下载 */
async function exportScenes() {
  exporting.value = true;
  try {
    const fw = route.meta.framework || 'single';
    const res = await fetch(`/api/health-check/scenes/export?framework=${fw}`);
    if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const fname = `inspection-scenes-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success(`已导出 ${scenes.value.length} 个场景`);
  } catch (e) {
    ElMessage.error(e.message || '导出失败');
  } finally {
    exporting.value = false;
  }
}

function pickImportFile() {
  fileInputRef.value && fileInputRef.value.click();
}

/** 选择 JSON 文件后读取并导入（按场景标题覆盖更新） */
function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!/\.json$/i.test(file.name)) {
    ElMessage.warning('请选择 JSON 文件');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    importing.value = true;
    try {
      const data = await request('/api/health-check/scenes/import', {
        method: 'POST',
        body: JSON.stringify({ content: reader.result })
      });
      ElMessage.success(`导入完成：新增 ${data.added} 个，更新 ${data.updated} 个，跳过 ${data.skipped} 个`);
      loadScenes();
    } catch (err) {
      ElMessage.error(err.message || '导入失败');
    } finally {
      importing.value = false;
      e.target.value = '';
    }
  };
  reader.onerror = () => {
    importing.value = false;
    ElMessage.error('读取文件失败');
    e.target.value = '';
  };
  reader.readAsText(file, 'utf-8');
}

async function parseScene() {
  if (!inputUrl.value.trim()) {
    ElMessage.warning('请填写请求 URL');
    return;
  }
  if (!inputBody.value.trim()) {
    ElMessage.warning('请填写请求体 JSON');
    return;
  }
  parsing.value = true;
  try {
    const data = await request('/api/health-check/scenes/parse', {
      method: 'POST',
      body: JSON.stringify({ url: inputUrl.value.trim(), requestBody: inputBody.value.trim() })
    });
    sceneDraft.value = data.scene;
    // 兜底默认值（老数据/解析器未返回时）
    if (sceneDraft.value.orderFieldName === undefined) sceneDraft.value.orderFieldName = '';
    if (sceneDraft.value.orderType === undefined) sceneDraft.value.orderType = '';
    if (!Array.isArray(sceneDraft.value.clusterFields)) sceneDraft.value.clusterFields = [];
    if (!sceneDraft.value.clusterSubFields) sceneDraft.value.clusterSubFields = {};
    if (!sceneDraft.value.clusterStatFields) sceneDraft.value.clusterStatFields = {};
    // 兼容旧版场景级统计列：迁移为所有维度的统计列
    if (Array.isArray(sceneDraft.value.statFields) && sceneDraft.value.statFields.length) {
      for (const f of sceneDraft.value.clusterFields) {
        if (!sceneDraft.value.clusterStatFields[f]) sceneDraft.value.clusterStatFields[f] = sceneDraft.value.statFields.slice();
      }
      sceneDraft.value.statFields = [];
    }
    warnings.value = data.warnings || [];
    ElMessage.success('解析成功，请确认场景信息后保存');
  } catch (e) {
    ElMessage.error(e.message || '解析失败');
  } finally {
    parsing.value = false;
  }
}

async function saveScene() {
  if (!sceneDraft.value) {
    ElMessage.warning('请先解析生成场景');
    return;
  }
  if (!sceneDraft.value.title.trim()) {
    ElMessage.warning('请填写场景标题');
    return;
  }
  saving.value = true;
  try {
    await request('/api/health-check/scenes', {
      method: 'POST',
      body: JSON.stringify({ scene: sceneDraft.value })
    });
    ElMessage.success(editingId.value ? '场景修改已保存' : '场景已保存');
    loadScenes();
    cancelEdit();
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

/** 编辑已保存场景：加载到草案表单（保留 id，保存时更新） */
function editScene(row) {
  sceneDraft.value = JSON.parse(JSON.stringify(row));
  editingId.value = row.id;
  warnings.value = [];
  // 兜底默认值（老数据可能缺字段）
  if (sceneDraft.value.orderFieldName === undefined) sceneDraft.value.orderFieldName = '';
  if (sceneDraft.value.orderType === undefined) sceneDraft.value.orderType = '';
  if (!Array.isArray(sceneDraft.value.focusFields)) sceneDraft.value.focusFields = [];
  if (!Array.isArray(sceneDraft.value.clusterFields)) sceneDraft.value.clusterFields = [];
  if (!sceneDraft.value.clusterSubFields) sceneDraft.value.clusterSubFields = {};
  if (!sceneDraft.value.clusterStatFields) sceneDraft.value.clusterStatFields = {};
  // 兼容旧版场景级统计列：迁移为所有维度的统计列
  if (Array.isArray(sceneDraft.value.statFields) && sceneDraft.value.statFields.length) {
    for (const f of sceneDraft.value.clusterFields) {
      if (!sceneDraft.value.clusterStatFields[f]) sceneDraft.value.clusterStatFields[f] = sceneDraft.value.statFields.slice();
    }
    sceneDraft.value.statFields = [];
  }
  focusInputVisible.value = false;
  // 滚动到顶部编辑表单
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 取消编辑，恢复新建状态 */
function cancelEdit() {
  editingId.value = '';
  sceneDraft.value = null;
  warnings.value = [];
  focusInputVisible.value = false;
}

async function removeScene(row) {
  try {
    await ElMessageBox.confirm(`确定删除巡检场景「${row.title}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
    await request(`/api/health-check/scenes/${row.id}`, { method: 'DELETE' });
    ElMessage.success('删除成功');
    loadScenes();
  } catch (e) {
    /* 取消不处理 */
  }
}

function countFilters(fc) {
  if (!fc) return 0;
  return Object.values(fc).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
}

function showFocusInput() {
  focusInputVisible.value = true;
  nextTick(() => focusInputRef.value && focusInputRef.value.focus());
}

function addFocusField() {
  const v = focusInput.value.trim();
  if (v && sceneDraft.value) {
    if (!sceneDraft.value.focusFields.includes(v)) sceneDraft.value.focusFields.push(v);
  }
  focusInput.value = '';
  focusInputVisible.value = false;
}

/** 一级维度可选二级字段：关注字段中排除自身及已选的其他一级维度 */
function subFieldOptions(f) {
  const focus = sceneDraft.value.focusFields || [];
  return focus.filter((sf) => sf !== f && !sceneDraft.value.clusterFields.includes(sf));
}

function onSubFieldChange(f, v) {
  if (!sceneDraft.value.clusterSubFields) sceneDraft.value.clusterSubFields = {};
  if (v) sceneDraft.value.clusterSubFields[f] = v;
  else delete sceneDraft.value.clusterSubFields[f];
}

/** 维度统计展示列变更：clusterStatFields[一级字段] = 统计字段数组 */
function onStatFieldsChange(f, v) {
  if (!sceneDraft.value.clusterStatFields) sceneDraft.value.clusterStatFields = {};
  const arr = Array.isArray(v) ? v.filter((x) => x) : [];
  if (arr.length) sceneDraft.value.clusterStatFields[f] = arr;
  else delete sceneDraft.value.clusterStatFields[f];
}

onMounted(loadScenes);
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
.editing-tag {
  margin-left: 10px;
}
.warn-box {
  margin-bottom: 12px;
  padding: 10px 14px;
  background: #fffbe6;
  border: 1px solid #ffe58f;
  border-radius: 6px;
}
.warn-title {
  font-size: 13px;
  font-weight: 600;
  color: #ad6800;
  margin-bottom: 6px;
}
.warn-item {
  font-size: 12px;
  color: #8c6d1f;
  line-height: 1.6;
}
.draft-box {
  padding: 14px;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
}
.draft-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 12px;
}
.draft-form :deep(.el-form-item) {
  margin-bottom: 12px;
}
.focus-fields {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.focus-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 6px;
}
.import-hint {
  font-size: 12px;
  color: #909399;
  margin-bottom: 8px;
}
.cluster-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cluster-check-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}
.cluster-check-item {
  margin-right: 0;
}
.sub-cluster-title {
  font-size: 12px;
  color: #606266;
  font-weight: 600;
  margin: 8px 0 4px;
}
.sub-cluster-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}
.sub-cluster-sep {
  font-size: 12px;
  color: #909399;
  margin-left: 4px;
}
.sub-cluster-level {
  min-width: 130px;
  font-family: Consolas, monospace;
}
.scene-stat-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 2px;
}
.scene-stat-field {
  font-size: 12px;
  font-family: Consolas, monospace;
  color: #606266;
  margin-right: 2px;
}
.scene-cluster-tag {
  margin: 2px 4px 2px 0;
}
.scene-cluster-sub {
  font-size: 11px;
  color: #409eff;
  margin-left: 4px;
}
.text-muted {
  font-size: 12px;
  color: #909399;
}
.order-sep {
  font-size: 12px;
  color: #909399;
  margin: 0 8px;
}
.filter-section {
  margin-top: 12px;
}
.draft-subtitle {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.filter-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.filter-type {
  flex-shrink: 0;
  width: 110px;
  text-align: center;
}
.filter-content {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.filter-kv {
  font-family: Consolas, monospace;
}
</style>
