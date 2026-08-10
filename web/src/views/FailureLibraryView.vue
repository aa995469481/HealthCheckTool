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
            <el-button size="small" type="primary" :icon="Plus" @click="openAdd">
              新增案例
            </el-button>
            <el-button size="small" :icon="Refresh" @click="loadItems">刷新</el-button>
          </div>
        </div>
      </template>

      <div class="library-hint">
        按「场景 + 内码 + 外码」维护失败案例分析（根因 / 影响 / 处置建议）。每次执行巡检后自动更新「最近命中」条数；生成 AI 巡检日报时，此处有分析的案例会作为参考喂给大模型。
      </div>

      <el-table :data="items" stripe v-loading="loading">
        <el-table-column prop="sceneTitle" label="场景" min-width="160" show-overflow-tooltip />
        <el-table-column label="内码" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.inCode" size="small" type="warning" effect="plain">{{ row.inCode }}</el-tag>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="外码" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.extCode" size="small" type="primary" effect="plain">{{ row.extCode }}</el-tag>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="案例分析" min-width="280" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.analysis" class="analysis-text">{{ row.analysis }}</span>
            <el-tag v-else size="small" type="info" effect="plain">待补充</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近命中" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.latestHitCount > 0 ? 'danger' : 'info'" size="small" effect="plain">
              {{ row.latestHitCount || 0 }}
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
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh, Download } from '@element-plus/icons-vue';

const items = ref([]);
const scenes = ref([]);
const loading = ref(false);
const importing = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref('');
const form = reactive({ sceneId: '', sceneTitle: '', inCode: '', extCode: '', analysis: '' });

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
