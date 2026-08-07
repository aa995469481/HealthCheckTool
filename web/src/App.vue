<template>
  <div class="layout">
    <header class="layout-header">
      <div class="logo">
        <el-icon :size="26"><Monitor /></el-icon>
        <span class="logo-title">业务巡检管理系统</span>
      </div>
      <div class="header-right">
        <el-tag type="info" effect="plain">本地演示环境</el-tag>
        <el-avatar :size="32" class="avatar">巡</el-avatar>
        <span class="user-name">巡检管理员</span>
      </div>
    </header>
    <main class="layout-main">
      <TaskList />
    </main>
  </div>
</template>

<script setup>
import TaskList from './views/TaskList.vue';
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
  display: flex;
  flex-direction: column;
  height: 100%;
}
.layout-header {
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: linear-gradient(90deg, #1f3a93, #2f54eb);
  color: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 1px;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.avatar {
  background: rgba(255, 255, 255, 0.25);
}
.user-name {
  font-size: 14px;
}
.layout-main {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
}
</style>
