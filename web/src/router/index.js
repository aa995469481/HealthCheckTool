import { createRouter, createWebHistory } from 'vue-router';

/**
 * 两级菜单（与用户确认，2026-08-12）：单框架交通卡 / 双框架交通卡，各含 3 个二级菜单。
 * 路径规则：/:framework(single|dual)/<page>，组件复用同一批视图，从路由参数取 framework 请求后端隔离数据。
 * 旧路径 /health-check-export 等重定向到 /single/*，保证历史书签/链接可用。
 */
const pages = [
  {
    path: 'health-check-export',
    name: 'HealthCheckExport',
    component: () => import('../views/HealthCheckExportView.vue'),
    title: '业务巡检'
  },
  {
    path: 'scene-manage',
    name: 'SceneManage',
    component: () => import('../views/SceneManageView.vue'),
    title: '巡检场景管理'
  },
  {
    path: 'failure-library',
    name: 'FailureLibrary',
    component: () => import('../views/FailureLibraryView.vue'),
    title: '巡检失败场景库'
  }
];

const frameworkRoutes = [];
for (const fw of ['single', 'dual']) {
  for (const p of pages) {
    frameworkRoutes.push({
      path: `/${fw}/${p.path}`,
      name: `${fw === 'dual' ? 'Dual' : 'Single'}${p.name}`,
      component: p.component,
      meta: { title: p.title, framework: fw }
    });
  }
}

const routes = [
  { path: '/', redirect: '/single/health-check-export' },
  // 旧路径重定向到单框架，保证兼容
  { path: '/health-check-export', redirect: '/single/health-check-export' },
  { path: '/scene-manage', redirect: '/single/scene-manage' },
  { path: '/failure-library', redirect: '/single/failure-library' },
  ...frameworkRoutes
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.afterEach((to) => {
  const fwName = to.meta.framework === 'dual' ? '双框架交通卡' : '单框架交通卡';
  document.title = to.meta.title ? `${fwName} · ${to.meta.title} - 业务巡检管理系统` : '业务巡检管理系统';
});

export default router;
