import { createRouter, createWebHashHistory } from 'vue-router';
import { ElMessage } from 'element-plus';

const routes = [
  {
    path: '/',
    name: 'dashboard',
    component: () => import('../pages/dashboard/DashboardPage.vue'),
    meta: { title: '仪表盘' },
  },
  {
    path: '/rpa',
    name: 'rpa',
    component: () => import('../pages/rpa/RpaPage.vue'),
    meta: { title: 'RPA 控制台' },
  },
  {
    path: '/tools',
    name: 'tools',
    component: () => import('../pages/tools/ToolsPage.vue'),
    meta: { title: '工具库' },
  },
  {
    path: '/match',
    name: 'match',
    component: () => import('../pages/match/MatchPage.vue'),
    meta: { title: '岗位库' },
  },
  {
    path: '/talent',
    name: 'talent',
    component: () => import('../pages/talent/TalentPage.vue'),
    meta: { title: '人才库' },
  },
  {
    path: '/risk',
    name: 'risk',
    component: () => import('../pages/risk/RiskPage.vue'),
    meta: { title: '风险中心' },
  },
  {
    path: '/oplog',
    name: 'oplog',
    component: () => import('../pages/oplog/OpLogPage.vue'),
    meta: { title: '运行日志' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../pages/settings/SettingsPage.vue'),
    meta: { title: '设置' },
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 页面 chunk 加载失败（四线隔离 2026-07-29）：此前该次导航静默 reject——用户点了没反应、
// 无提示无日志。当前页保持不变（其它线不受影响），这里如实告知这个页面坏了。
router.onError((err, to) => {
  console.error('[router] 页面加载失败（仅该页受影响）：', to?.fullPath, err);
  try {
    (window as any).api?.oplogUi?.('route-load-failed', {
      to: String(to?.fullPath || ''), err: String((err as any)?.message || err).slice(0, 200),
    });
  } catch { /* ignore */ }
  try {
    ElMessage.error(`页面「${String(to?.meta?.title || to?.fullPath || '')}」加载失败：${(err as any)?.message || err}`);
  } catch { /* 提示失败不影响其余功能 */ }
});

// 页面切换轨迹（只记录，不拦截导航）。
// 用途：还原"用户当时在哪个页面、点了什么之后出的问题"——主进程侧只看得到 IPC，
// 看不到"点了按钮但什么都没发生"这类体验问题，而那恰恰最常见。
router.afterEach((to, from) => {
  try {
    (window as any).api?.oplogUi?.('route', {
      to: String(to.name || to.path), from: String(from.name || from.path || ''),
    });
  } catch { /* 日志绝不能影响导航 */ }
});

export default router;
