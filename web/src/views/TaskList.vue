<template>
  <div class="task-page">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="stat-row">
      <el-col :span="6">
        <div class="stat-card total">
          <div class="stat-icon"><el-icon :size="26"><List /></el-icon></div>
          <div>
            <div class="stat-num">{{ stats.total }}</div>
            <div class="stat-label">全部任务</div>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card pending">
          <div class="stat-icon"><el-icon :size="26"><Clock /></el-icon></div>
          <div>
            <div class="stat-num">{{ stats.pending }}</div>
            <div class="stat-label">待处理</div>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card in-progress">
          <div class="stat-icon"><el-icon :size="26"><Loading /></el-icon></div>
          <div>
            <div class="stat-num">{{ stats.inProgress }}</div>
            <div class="stat-label">进行中</div>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card done">
          <div class="stat-icon"><el-icon :size="26"><CircleCheck /></el-icon></div>
          <div>
            <div class="stat-num">{{ stats.done }}</div>
            <div class="stat-label">已完成</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 查询区 -->
    <el-card shadow="never" class="toolbar">
      <el-form :inline="true" :model="query" @submit.prevent>
        <el-form-item label="关键字">
          <el-input
            v-model="query.keyword"
            placeholder="任务名称 / 编号 / 负责人"
            clearable
            style="width: 220px"
            @keyup.enter="handleSearch"
          />
        </el-form-item>
        <el-form-item label="巡检类型">
          <el-select v-model="query.type" placeholder="全部类型" clearable style="width: 140px">
            <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 130px">
            <el-option v-for="s in statusOptions" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="计划日期">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="YYYY-MM-DD"
            style="width: 260px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" @click="handleSearch">查询</el-button>
          <el-button :icon="Refresh" @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
      <div class="toolbar-right">
        <el-button type="primary" :icon="Plus" @click="openCreate">新增巡检任务</el-button>
      </div>
    </el-card>

    <!-- 任务表格 -->
    <el-card shadow="never" class="table-card">
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="taskNo" label="任务编号" width="150" />
        <el-table-column prop="name" label="任务名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="type" label="巡检类型" width="100">
          <template #default="{ row }">
            <el-tag type="info" effect="plain">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="area" label="巡检区域" width="120" />
        <el-table-column prop="person" label="负责人" width="90" />
        <el-table-column prop="planDate" label="计划日期" width="110" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTag(row).type" effect="light">{{ statusTag(row).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createTime" label="创建时间" width="160" />
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === '待处理'"
              link
              type="primary"
              @click="changeStatus(row, '进行中')"
            >开始巡检</el-button>
            <el-button
              v-if="row.status !== '已完成'"
              link
              type="success"
              @click="changeStatus(row, '已完成')"
            >完成</el-button>
            <el-button link type="warning" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @size-change="loadList"
          @current-change="loadList"
        />
      </div>
    </el-card>

    <!-- 新增 / 编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="form.id ? '编辑巡检任务' : '新增巡检任务'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="任务名称" prop="name">
          <el-input v-model="form.name" placeholder="请输入任务名称" maxlength="50" />
        </el-form-item>
        <el-form-item label="巡检类型" prop="type">
          <el-select v-model="form.type" style="width: 100%">
            <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="巡检区域">
          <el-input v-model="form.area" placeholder="如：A栋机房" maxlength="50" />
        </el-form-item>
        <el-form-item label="负责人">
          <el-input v-model="form.person" placeholder="请输入负责人姓名" maxlength="20" />
        </el-form-item>
        <el-form-item label="计划日期" prop="planDate">
          <el-date-picker
            v-model="form.planDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择计划巡检日期"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="3" placeholder="巡检要点、注意事项等" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Refresh, Plus, List, Clock, Loading, CircleCheck } from '@element-plus/icons-vue';

/* ---------- 常量 ---------- */
const typeOptions = ['设备巡检', '安全巡检', '消防巡检', '卫生巡检', '质量巡检', '设施巡检', '其他'];
const statusOptions = ['待处理', '进行中', '已完成'];

const today = new Date().toISOString().slice(0, 10);
const isOverdue = (row) => row.planDate < today && row.status !== '已完成';
const statusTag = (row) => {
  if (row.status === '已完成') return { type: 'success', label: '已完成' };
  if (row.status === '进行中') return { type: 'primary', label: '进行中' };
  if (isOverdue(row)) return { type: 'danger', label: '已逾期' };
  return { type: 'warning', label: '待处理' };
};

/* ---------- 数据状态 ---------- */
const loading = ref(false);
const saving = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const stats = reactive({ total: 0, pending: 0, inProgress: 0, done: 0 });
const dialogVisible = ref(false);
const formRef = ref();

const query = reactive({ keyword: '', type: '', status: '' });
const dateRange = ref(null);

const emptyForm = () => ({ id: null, name: '', type: '设备巡检', area: '', person: '', planDate: '', remark: '' });
const form = reactive(emptyForm());

const rules = {
  name: [{ required: true, message: '请输入任务名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择巡检类型', trigger: 'change' }],
  planDate: [{ required: true, message: '请选择计划巡检日期', trigger: 'change' }]
};

/* ---------- 数据请求 ---------- */
async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.msg || '请求失败');
  return json.data;
}

async function loadList() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      page: page.value,
      pageSize: pageSize.value
    });
    if (query.keyword) params.set('keyword', query.keyword.trim());
    if (query.type) params.set('type', query.type);
    if (query.status) params.set('status', query.status);
    if (dateRange.value && dateRange.value.length === 2) {
      params.set('startDate', dateRange.value[0]);
      params.set('endDate', dateRange.value[1]);
    }
    const data = await request(`/api/tasks?${params.toString()}`);
    list.value = data.list;
    total.value = data.total;
    Object.assign(stats, data.stats);
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

/* ---------- 操作 ---------- */
function handleSearch() {
  page.value = 1;
  loadList();
}

function handleSizeChange() {
  page.value = 1;
  loadList();
}

function handleReset() {
  query.keyword = '';
  query.type = '';
  query.status = '';
  dateRange.value = null;
  page.value = 1;
  loadList();
}

function openCreate() {
  Object.assign(form, emptyForm());
  dialogVisible.value = true;
}

function openEdit(row) {
  Object.assign(form, {
    id: row.id,
    name: row.name,
    type: row.type,
    area: row.area,
    person: row.person,
    planDate: row.planDate,
    remark: row.remark
  });
  dialogVisible.value = true;
}

async function handleSave() {
  try {
    await formRef.value.validate();
  } catch (e) {
    return; // 表单校验未通过，交由表单组件提示
  }
  saving.value = true;
  try {
    const payload = {
      name: form.name,
      type: form.type,
      area: form.area,
      person: form.person,
      planDate: form.planDate,
      remark: form.remark
    };
    if (form.id) {
      await request(`/api/tasks/${form.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      ElMessage.success('修改成功');
    } else {
      await request('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      ElMessage.success('新增成功');
    }
    dialogVisible.value = false;
    loadList();
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function changeStatus(row, status) {
  try {
    await request(`/api/tasks/${row.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
    ElMessage.success(status === '已完成' ? '已标记完成' : '已开始巡检');
    loadList();
  } catch (e) {
    ElMessage.error(e.message || '操作失败');
  }
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除巡检任务「${row.name}」吗？删除后不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
    await request(`/api/tasks/${row.id}`, { method: 'DELETE' });
    ElMessage.success('删除成功');
    if (list.value.length === 1 && page.value > 1) page.value -= 1;
    loadList();
  } catch (e) {
    /* 取消删除不处理 */
  }
}

onMounted(loadList);
</script>

<style scoped>
.stat-row {
  margin-bottom: 16px;
}
.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}
.stat-icon {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.total .stat-icon { background: #2f54eb; }
.pending .stat-icon { background: #fa8c16; }
.in-progress .stat-icon { background: #13c2c2; }
.done .stat-icon { background: #52c41a; }
.stat-num {
  font-size: 26px;
  font-weight: 700;
  color: #303133;
  line-height: 1.2;
}
.stat-label {
  font-size: 13px;
  color: #909399;
}
.toolbar {
  margin-bottom: 16px;
  border-radius: 8px;
}
.toolbar :deep(.el-card__body) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.toolbar :deep(.el-form-item) {
  margin-bottom: 0;
}
.toolbar-right {
  flex-shrink: 0;
}
.table-card {
  border-radius: 8px;
}
.pagination-wrap {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
