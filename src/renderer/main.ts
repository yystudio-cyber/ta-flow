import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus, { ElConfigProvider } from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css'; // H5-1: Element Plus 暗色变量，配合 html.dark 生效
import App from './src/App.vue';
import router from './src/router';
import { i18n, resolveLocale, setLocale, epLocale } from './src/i18n';
import './src/styles/global.scss';
import './src/styles/organic.css'; // 新设计系统（Organic），在 global.scss 之后加载

// ── 渲染层全局兜底（四线隔离 2026-07-29）────────────────────────────────────
// 此前渲染层三无：无 errorHandler、无 onerror、无 unhandledrejection。任何页面一个
// 渲染期异常会一路冒到根，Vue 中止根组件 patch → 连侧边栏一起白，四条线同屏死。
// 页面级的就地降级在 App.vue 的 PageBoundary；这两个监听是最后一道网：只留痕，不再升级。
window.addEventListener('error', (e) => {
  console.error('[global] window error（已拦截）：', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[global] unhandledrejection（已拦截）：', e.reason);
});

// 初始化本身失败时的最终提示：此时 Vue/Element 都不可用，只能手写最原始的 DOM
function renderFatal(message: string) {
  const el = document.getElementById('app');
  if (!el) return;
  el.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'max-width:520px;margin:120px auto;padding:28px;font-family:system-ui,sans-serif;'
    + 'border:1px solid #e0e0e0;border-radius:12px;background:#fff;color:#1f2430;';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:18px;font-weight:600;margin-bottom:10px;';
  h.textContent = '界面启动失败';
  const p = document.createElement('div');
  p.style.cssText = 'font-size:13px;line-height:1.7;color:#555;white-space:pre-wrap;';
  p.textContent = message;
  const btn = document.createElement('button');
  btn.style.cssText = 'margin-top:16px;padding:8px 18px;border:0;border-radius:8px;background:#12a05c;color:#fff;cursor:pointer;';
  btn.textContent = '重新加载';
  btn.onclick = () => location.reload();
  box.append(h, p, btn);
  el.appendChild(box);
}

async function bootstrap() {
  try {
    if (!(window as any).api) {
      if (import.meta.env.DEV) {
        // 浏览器预览（vite dev / preview:web）：装载样例数据 mock。
        // 该分支在生产构建时被静态消除，mock 代码不进生产包。
        const { installMockApi } = await import('./src/dev/mock-api');
        installMockApi();
      } else {
        // 生产包里 preload 未注入 → 以前会静默装 mock，四条线同时显示伪造数据
        // （仪表盘"已浏览 37 人"、RPA"运行中"），比白屏更危险。现在如实报错。
        renderFatal('预加载脚本未注入（window.api 缺失），界面无法与主进程通信。\n请完全退出后重新打开应用；若反复出现，请保留此界面反馈。');
        return;
      }
    }
    // 阶段8：先从持久化 settings 读初始语言（在 createApp 前取，避免闪一下中文再切英文）。
    let initLocale = resolveLocale(undefined);
    try {
      const s = await window.api.getSettings();
      initLocale = resolveLocale(s?.general?.language);
    } catch { /* 设置读取失败不影响默认中文启动 */ }
    setLocale(initLocale);

    // 用 ElConfigProvider 包裹根：locale 绑响应式 epLocale，切语言时 Element 内置组件文案同步刷新。
    const app = createApp({
      setup() {
        return () => h(ElConfigProvider, { locale: epLocale.value }, () => h(App));
      },
    });
    // 组件树内未被 PageBoundary 捕获的异常（如 Sidebar/App 自身）：留痕即止，不让 Vue 上抛到 window
    app.config.errorHandler = (err, _inst, info) => {
      console.error(`[global] Vue 异常（${info}，已拦截）：`, err);
    };
    app.use(createPinia());
    app.use(router);
    app.use(i18n);
    app.use(ElementPlus);
    app.mount('#app');
  } catch (e: any) {
    console.error('[global] bootstrap 失败：', e);
    renderFatal('界面初始化失败：' + String(e?.message || e));
  }
}
bootstrap();
