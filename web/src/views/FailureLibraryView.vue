<template>
  <div class="library-page">
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>巡检失败场景库（{{ items.length }}）</span>
          <div class="card-actions">
            <el-button size="small" :icon="Download" :loading="importing" @click="importFromAnalysis">
              从聚类摘要一键导入
            </el-button>
            <el-button size="small" :icon="Download" :disabled="items.length === 0" @click="exportCsv">
              导出 CSV
            </el-button>
            <el-button size="small" :icon="Upload" :loading="importing" @click="pickFile">
              导入 CSV
            </el-button>
            <el-button size="small" :icon="Plus" @click="openAdd">
              新增案例
            </el-button>
            <el-button size="small" :icon="Refresh" @click="loadItems">刷新</el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :icon="Delete"
              :disabled="items.length === 0"
              @click="clearAllItems"
            >清空全部</el-button>
          </div>
        </div>
      </template>

      <input ref="fileInputRef" type="file" accept=".csv,text/csv" style="display: none" @change="onFileChange" />

      <div class="library-hint">
        按「场景 + 内码 + 外码」维护失败案例分析（根因 / 影响 / 处置建议）。每次执行巡检后自动更新「用户数量」（该组合本次巡检命中的去重用户数，按 uid 去重）；生成 AI 巡检日报时，仅「已分析 / 已闭环」且有分析的案例会作为参考喂给大模型。
      </div>

      <div class="filter-bar">
        <el-select v-model="filters.scene" placeholder="全部场景" clearable filterable size="small" style="width: 170px">
          <el-option v-for="s in scenes" :key="s.id" :label="s.title" :value="s.title" />
        </el-select>
        <el-select v-model="filters.category" placeholder="全部类别" clearable size="small" style="width: 130px">
          <el-option v-for="c in CATEGORY_OPTIONS" :key="c" :label="c" :value="c" />
        </el-select>
        <el-select v-model="filters.status" placeholder="全部状态" clearable size="small" style="width: 120px">
          <el-option v-for="s in STATUS_OPTIONS" :key="s" :label="s" :value="s" />
        </el-select>
        <el-input v-model="filters.cardDimension" placeholder="卡维度（如 All）" clearable size="small" style="width: 150px" />
        <el-input v-model="filters.keyword" placeholder="内码/外码/分析关键词" clearable size="small" style="width: 200px" />
        <el-button size="small" :icon="Refresh" @click="resetFilters">重置</el-button>
        <span class="filter-count">共 {{ filteredItems.length }} / {{ items.length }} 条</span>
      </div>

      <el-table :data="filteredItems" stripe v-loading="loading">
        <el-table-column prop="sceneTitle" label="场景" min-width="160" show-overflow-tooltip />
        <el-table-column label="内码" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.inCode" size="small" type="warning" effect="plain">{{ row.inCode }}</el-tag>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="外码" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.extCode" size="small" type="primary" effect="plain">{{ row.extCode }}</el-tag>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="卡维度" width="110">
          <template #default="{ row }">
            <span>{{ row.cardDimension || 'All' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="问题类别" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="categoryTagType(row.category)" effect="plain">{{ row.category || '待确认' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="问题状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)" effect="plain">{{ row.status || '待确认' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="案例分析" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.analysis" class="analysis-text">{{ row.analysis }}</span>
            <el-tag v-else size="small" type="info" effect="plain">待补充</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="用户数量(uid)" width="110">
          <template #default="{ row }">
            <el-tag :type="row.latestUserCount > 0 ? 'danger' : 'info'" size="small" effect="plain">
              {{ row.latestUserCount || 0 }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近检查" width="165">
          <template #default="{ row }">
            <span class="text-muted">{{ row.lastCheckedAt ? formatTime(row.lastCheckedAt) : '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="165">
          <template #default="{ row }">
            <span class="text-muted">{{ formatTime(row.updatedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="removeItem(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新增 / 编辑案例对话框 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑案例' : '新增案例'" width="600px">
      <el-form label-width="90px">
        <el-form-item label="场景" required>
          <el-select
            v-model="form.sceneId"
            placeholder="选择巡检场景"
            filterable
            style="width: 100%"
            @change="onSceneChange"
          >
            <el-option v-for="s in scenes" :key="s.id" :label="s.title" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="内码">
          <el-input v-model="form.inCode" placeholder="如 1001（可与外码二选一，也可组合）" style="width: 260px" />
        </el-form-item>
        <el-form-item label="外码">
          <el-input v-model="form.extCode" placeholder="如 E001" style="width: 260px" />
        </el-form-item>
        <el-form-item label="问题类别">
          <el-select v-model="form.category" placeholder="问题类别" style="width: 260px">
            <el-option v-for="c in CATEGORY_OPTIONS" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="问题状态">
          <el-select v-model="form.status" placeholder="问题状态" style="width: 260px">
            <el-option v-for="s in STATUS_OPTIONS" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="卡维度">
          <el-input v-model="form.cardDimension" placeholder="如 All 或具体卡维度，默认 All" style="width: 260px" />
        </el-form-item>
        <el-form-item label="案例分析">
          <el-input
            v-model="form.analysis"
            type="textarea"
            :rows="5"
            placeholder="填写该内码+外码组合的失败案例分析：问题根因、影响范围、处置建议等（AI 生成日报时会参考）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveItem">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh, Download, Delete, Upload } from '@element-plus/icons-vue';

const CATEGORY_OPTIONS = ['端侧问题', 'SP问题', '云侧问题', '非问题', '待确认'];
const STATUS_OPTIONS = ['待确认', '已分析', '已闭环'];

const items = ref([]);
const scenes = ref([]);
const loading = ref(false);
const importing = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref('');
const fileInputRef = ref();
const form = reactive({ sceneId: '', sceneTitle: '', inCode: '', extCode: '', category: '待确认', status: '待确认', cardDimension: 'All', analysis: '' });
const filters = reactive({ scene: '', category: '', status: '', cardDimension: '', keyword: '' });

/** 列表过滤：场景 / 问题类别 / 问题状态 / 卡维度 / 关键词（内码+外码+分析） */
const filteredItems = computed(() =>
  items.value.filter((it) => {
    if (filters.scene && it.sceneTitle !== filters.scene) return false;
    if (filters.category && (it.category || '待确认') !== filters.category) return false;
    if (filters.status && (it.status || '待确认') !== filters.status) return false;
    if (filters.cardDimension && !String(it.cardDimension || '').toLowerCase().includes(filters.cardDimension.trim().toLowerCase())) return false;
    if (filters.keyword) {
      const kw = filters.keyword.trim().toLowerCase();
      const hay = [it.inCode, it.extCode, it.analysis].join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  })
);

function categoryTagType(cat) {
  return { '端侧问题': 'warning', 'SP问题': 'primary', '云侧问题': 'success', '非问题': 'info', '待确认': 'danger' }[cat || '待确认'] || 'danger';
}
function statusTagType(st) {
  return { '待确认': 'info', '已分析': 'warning', '已闭环': 'success' }[st || '待确认'] || 'info';
}

function resetFilters() {
  filters.scene = '';
  filters.category = '';
  filters.status = '';
  filters.cardDimension = '';
  filters.keyword = '';
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.msg || '请求失败');
  return json.data;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function loadItems() {
  loading.value = true;
  try {
    const data = await request('/api/health-check/failure-library');
    items.value = data.items || [];
  } catch (e) {
    ElMessage.error(e.message || '加载失败场景库失败');
  } finally {
    loading.value = false;
  }
}

async function loadScenes() {
  try {
    const data = await request('/api/health-check/scenarios');
    scenes.value = data.scenarios || [];
  } catch (e) {
    ElMessage.error(e.message || '加载巡检场景失败');
  }
}

function resetForm() {
  editingId.value = '';
  form.sceneId = '';
  form.sceneTitle = '';
  form.inCode = '';
  form.extCode = '';
  form.category = '待确认';
  form.status = '待确认';
  form.cardDimension = 'All';
  form.analysis = '';
}

function onSceneChange(id) {
  const scene = scenes.value.find((s) => s.id === id);
  form.sceneTitle = scene ? scene.title : '';
}

function openAdd() {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row) {
  editingId.value = row.id;
  form.sceneId = row.sceneId || '';
  form.sceneTitle = row.sceneTitle || '';
  form.inCode = row.inCode || '';
  form.extCode = row.extCode || '';
  form.category = row.category || '待确认';
  form.status = row.status || '待确认';
  form.cardDimension = row.cardDimension || 'All';
  form.analysis = row.analysis || '';
  dialogVisible.value = true;
}

async function saveItem() {
  if (!form.sceneId) {
    ElMessage.warning('请选择场景');
    return;
  }
  if (!form.inCode.trim() && !form.extCode.trim()) {
    ElMessage.warning('内码和外码至少填写一个');
    return;
  }
  saving.value = true;
  try {
    const payload = {
      sceneId: form.sceneId,
      sceneTitle: form.sceneTitle,
      inCode: form.inCode,
      extCode: form.extCode,
      category: form.category,
      status: form.status,
      cardDimension: form.cardDimension,
      analysis: form.analysis
    };
    if (editingId.value) {
      await request(`/api/health-check/failure-library/${editingId.value}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      ElMessage.success('已更新');
    } else {
      await request('/api/health-check/failure-library', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      ElMessage.success('已新增');
    }
    dialogVisible.value = false;
    loadItems();
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function removeItem(row) {
  try {
    await ElMessageBox.confirm(`确定删除该案例（${row.sceneTitle} / 内码 ${row.inCode || '-'} / 外码 ${row.extCode || '-'}）吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
    await request(`/api/health-check/failure-library/${row.id}`, { method: 'DELETE' });
    ElMessage.success('已删除');
    loadItems();
  } catch (e) {
    /* 取消不处理 */
  }
}

async function clearAllItems() {
  try {
    await ElMessageBox.confirm(
      `确定要清空全部 ${items.value.length} 条失败场景案例吗？此操作不可恢复！`,
      '清空全部确认',
      {
        type: 'warning',
        confirmButtonText: '全部清空',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger'
      }
    );
    await request('/api/health-check/failure-library', { method: 'DELETE' });
    ElMessage.success('已清空全部案例');
    loadItems();
  } catch (e) {
    /* 取消不处理 */
  }
}

async function importFromAnalysis() {
  importing.value = true;
  try {
    const data = await request('/api/health-check/failure-library/import', { method: 'POST' });
    ElMessage.success(`导入完成：新增 ${data.added} 条，跳过（已存在）${data.skipped} 条`);
    loadItems();
  } catch (e) {
    ElMessage.error(e.message || '导入失败');
  } finally {
    importing.value = false;
  }
}

/** 导出 CSV：请求后端生成文件并触发浏览器下载 */
async function exportCsv() {
  try {
    const res = await fetch('/api/health-check/failure-library/export');
    if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const fname = `failure-library-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success(`已导出 ${items.value.length} 条到 ${fname}`);
  } catch (e) {
    ElMessage.error(e.message || '导出失败');
  }
}

function pickFile() {
  fileInputRef.value && fileInputRef.value.click();
}

/** 选择 CSV 文件后读取并上传导入（覆盖更新已存在条目） */
function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) {
    ElMessage.warning('请选择 CSV 文件');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    importing.value = true;
    try {
      const data = await request('/api/health-check/failure-library/import-file', {
        method: 'POST',
        body: JSON.stringify({ csv: reader.result })
      });
      ElMessage.success(`导入完成：新增 ${data.added} 条，更新 ${data.updated} 条，跳过 ${data.skipped} 条`);
      loadItems();
    } catch (err) {
      ElMessage.error(err.message || '导入失败');
    } finally {
      importing.value = false;
      e.target.value = '';
    }
  };
  reader.onerror = () => {
    ElMessage.error('文件读取失败');
    e.target.value = '';
  };
  reader.readAsText(file, 'utf-8');
}

onMounted(() => {
  loadItems();
  loadScenes();
});
</script>

<style scoped>
.card {
  border-radius: 8px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.library-hint {
  font-size: 12px;
  color: #909399;
  margin-bottom: 12px;
  line-height: 1.7;
}
.filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.filter-count {
  font-size: 12px;
  color: #909399;
}
.analysis-text {
  font-size: 13px;
  color: #303133;
  line-height: 1.6;
}
.text-muted {
  color: #909399;
  font-size: 12px;
}
</style>
