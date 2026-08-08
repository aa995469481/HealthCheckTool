<template>
  <el-container class="layout">
    <el-aside width="220px" class="layout-aside">
      <div class="logo">
        <el-icon :size="22"><Monitor /></el-icon>
        <span class="logo-title">业务巡检管理系统</span>
      </div>
      <el-menu
        :default-active="$route.path"
        router
        class="layout-menu"
        background-color="#001529"
        text-color="rgba(255, 255, 255, 0.65)"
        active-text-color="#ffffff"
      >
        <el-menu-item index="/tasks">
          <el-icon><List /></el-icon>
          <span>巡检任务管理</span>
        </el-menu-item>
        <el-menu-item index="/health-check-export">
          <el-icon><DataAnalysis /></el-icon>
          <span>业务巡检</span>
        </el-menu-item>
        <el-menu-item index="/scene-manage">
          <el-icon><Files /></el-icon>
          <span>巡检场景管理</span>
        </el-menu-item>
        <el-menu-item index="/traffic-card-inspection">
          <el-icon><Van /></el-icon>
          <span>交通卡业务巡检</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container class="layout-body">
      <el-header class="layout-header">
        <div class="header-left">
          <span class="page-title">{{ $route.meta.title || '' }}</span>
        </div>
        <div class="header-right">
          <el-tag type="info" effect="plain">本地演示环境</el-tag>
          <el-avatar :size="32" class="avatar">巡</el-avatar>
          <span class="user-name">巡检管理员</span>
        </div>
      </el-header>

      <el-main class="layout-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
}
body {
  font-family: 'Helvetica Neue', Helvetica, 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif;
  background: #f0f2f5;
}
.layout {
  height: 100%;
}
.layout-aside {
  background: #001529;
  display: flex;
  flex-direction: column;
}
.logo {
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 20px;
  color: #fff;
}
.logo-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
}
.layout-menu {
  flex: 1;
  border-right: none;
}
.layout-menu .el-menu-item.is-active {
  background: #2f54eb;
}
.layout-body {
  flex-direction: column;
}
.layout-header {
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}
.page-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.avatar {
  background: #2f54eb;
  color: #fff;
}
.user-name {
  font-size: 14px;
  color: #606266;
}
.layout-main {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
}
</style>
