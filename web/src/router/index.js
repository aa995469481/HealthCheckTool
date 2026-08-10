import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    redirect: '/tasks'
  },
  {
    path: '/tasks',
    name: 'TaskList',
    component: () => import('../views/TaskList.vue'),
    meta: { title: '巡检任务管理' }
  },
  {
    path: '/health-check-export',
    name: 'HealthCheckExport',
    component: () => import('../views/HealthCheckExportView.vue'),
    meta: { title: '业务巡检' }
  },
  {
    path: '/scene-manage',
    name: 'SceneManage',
    component: () => import('../views/SceneManageView.vue'),
    meta: { title: '巡检场景管理' }
  },
  {
    path: '/failure-library',
    name: 'FailureLibrary',
    component: () => import('../views/FailureLibraryView.vue'),
    meta: { title: '巡检失败场景库' }
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - 业务巡检管理系统` : '业务巡检管理系统';
});

export default router;
