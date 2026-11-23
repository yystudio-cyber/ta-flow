import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AppSettings, RPAState, RiskState, PlatformId } from '../../../shared/types';
import { PLATFORMS } from '../../../shared/types';

export const useAppStore = defineStore('app', () => {
  const settings = ref<AppSettings | null>(null);
  // 当前选中的招聘平台 Tab（D6: 从 settings 读，切换时持久化）
  const activePlatform = ref<PlatformId>('boss');
  const rpaState = ref<RPAState>({
    status: 'idle',
    elapsedMs: 0,
    stats: { viewed: 0, greeted: 0, favorited: 0, pagesBrowsed: 0 },
    logs: [],
  });
  const riskState = ref<RiskState>({
    level: 'safe',
    metrics: {
      greetCountToday: 0,
      browseCountToday: 0,
      favoriteCountToday: 0,
      lastHourOps: 0,
      lastWindowLoads: 0,
      pageAnomaly: false,
      accountRestricted: false,
      nightActivity: false,
      recentOpFails: 0,
      recentOpTotal: 0,
      consecutiveEmptyPages: 0,
      consecutiveGreetFails: 0,
      pagesToday: 0,
      searchesToday: 0,
      detailsToday: 0,
      pagesLimit: 0,
      searchesLimit: 0,
      detailsLimit: 0,
    },
    reasons: [],
    suggestions: ['一切正常'],
  });
  const cdpConnected = ref(false); // puppeteer 已接管（找人中）
  const browserOpen = ref(false);  // 浏览器已打开（端口就绪，含登录期零附着）

  function applyCdp(s: any) {
    cdpConnected.value = !!s?.connected;
    browserOpen.value = s?.open ?? !!s?.connected;
  }

  // 事件订阅与轮询只挂一次：init 会被重复调用（App 挂载、设置页保存后刷新），
  // 原来每调一次就再挂一套监听 + 再多一个 6s 轮询，设置页操作会持续放大事件负载。
  let wired = false;

  async function init() {
    // 逐项隔离（隔离改造 2026-07-29）：原来四个 await 串行裸跑，任何一个 IPC 失败
    // （比如某个域没注册成功），后面的【事件订阅】就全部不挂——表现是 RPA 状态
    // 永远停在 idle、风险中心不更新，而根因只是一次 settings:get 抛错。
    // 首屏快照拿不到没关系（事件和 6s 校准会补），订阅必须挂上。
    const soft = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.warn('[store.init] 首屏快照失败（已隔离）：', e); } };
    await soft(async () => {
      settings.value = await window.api.getSettings();
      // D6(2026-08-05)：平台与引导状态从 settings 恢复（持久化）
      const savedPlat = settings.value?.general?.activePlatform as PlatformId | undefined;
      if (savedPlat === 'boss' || savedPlat === 'liepin') activePlatform.value = savedPlat;
    });
    // ★ 必须传平台：不传时主进程缺省按 BOSS 取状态，切到猎聘 tab 后 init 首屏快照仍是 BOSS 数据。
    await soft(async () => { rpaState.value = await window.api.getRpaState(activePlatform.value); });
    await soft(async () => { riskState.value = await window.api.getRiskState(activePlatform.value); });
    // ★ 必须传平台：getCdpStatus() 不传参时主进程缺省按 BOSS 取状态（见 ipc/cdp.ts 的 P()）。
    //   漏传的后果是在猎聘 tab 上永远读到 BOSS 的浏览器状态——猎聘浏览器明明开着，
    //   界面却一直显示「未打开」。
    await soft(async () => { applyCdp(await window.api.getCdpStatus(activePlatform.value)); });

    if (wired) return;
    wired = true;

    // 逐条隔离：三条订阅各自兜错——onRpaEvent 挂失败（如 preload 版本错位时的
    // TypeError），风险与 CDP 的订阅照样要挂上，不许一条失败截断其余两条。
    const sub = (name: string, fn: () => void) => {
      try { fn(); } catch (e) { console.warn(`[store.init] ${name} 订阅失败（已隔离，其余订阅照常）：`, e); }
    };
    // ★ 必须按平台过滤：两个引擎会并行发状态，不过滤就是"谁发谁覆盖" ——
    //   在 BOSS tab 上会看到猎聘的进度，反之亦然，暂停/停止按钮也会作用在错误的理解上。
    //   缺 platform 字段的（老事件形态）视为 boss，保持向后兼容。
    sub('rpa', () => window.api.onRpaEvent((s: any) => {
      if ((s?.platform || 'boss') !== activePlatform.value) return;
      rpaState.value = s;
    }));
    sub('risk', () => window.api.onRiskEvent((s: any) => {
      if ((s?.platform || 'boss') !== activePlatform.value) return;
      riskState.value = s;
    }));
    sub('cdp', () => window.api.onCdpStatus((status: any) => {
      if ((status?.platform || 'boss') !== activePlatform.value) return;
      applyCdp(status);
    }));
    // 主进程 IPC 失败的统一留痕通道（此前主进程一直在发、渲染层无人接的死通道）
    sub('ipc-error', () => (window.api as any).onIpcError?.((info: any) => {
      console.warn('[ipc-error]', info?.channel, info?.message);
    }));

    // 安全网：用户可能直接关掉/打开 Chrome，事件无法覆盖，故每 6s 轻量校准一次真实状态。
    // ★ 同样必须传当前平台。这里漏传的破坏性比首屏那处更大：事件通道（onCdpStatus）是按平台
    //   过滤的、能正确把猎聘的 open=true 送进来，但这个轮询每 6 秒就用 BOSS 的状态把它覆盖掉，
    //   表现为「点开猎聘浏览器 → 状态灯亮一下 → 几秒后变回未打开」。
    setInterval(async () => {
      try { applyCdp(await window.api.getCdpStatus(activePlatform.value)); } catch { /* 忽略 */ }
    }, 6000);
  }

  const platformLabel = (p: PlatformId) => {
    const labels: Record<PlatformId, string> = { boss: 'BOSS 直聘', liepin: '猎聘' };
    return labels[p] || p;
  };

  // D6(2026-08-05)：切换平台并持久化到 settings。
  // 原实现是直接改 ref，只在 RPA 页有效且重启丢失——导致风险中心/仪表盘等页看不到猎聘数据。
  async function setActivePlatform(p: PlatformId) {
    if (p === activePlatform.value) return;
    activePlatform.value = p;
    // 切平台后立即按新平台重取一次浏览器状态：否则要等最多 6 秒的轮询才校准，
    // 这段空窗里界面显示的是【另一个平台】的浏览器状态，会让人以为浏览器没开。
    try { applyCdp(await window.api.getCdpStatus(p)); } catch { /* 取不到就等轮询补 */ }
    // ★ P2-5: 切平台后立即重取 rpaState 和 riskState，否则要等对应引擎推事件才刷新，
    //   空窗期内 UI 显示的是上一个平台的状态（BOSS 切猎聘后，RPA 状态卡显示 BOSS 的进度）。
    try { rpaState.value = await window.api.getRpaState(p); } catch { /* 等事件补 */ }
    try { riskState.value = await window.api.getRiskState(p); } catch { /* 等事件补 */ }
    // 持久化：尽量保存，失败不阻塞 UI 切换
    try {
      const cur = settings.value;
      if (cur?.general) {
        (cur.general as any).activePlatform = p;
        settings.value = await window.api.saveSettings(cur);
      }
    } catch (e) { console.warn('[store] 保存平台选择失败：', e); }
  }

  return {
    settings, rpaState, riskState, cdpConnected, browserOpen,
    activePlatform,
    platformLabel, setActivePlatform,
    init,
  };
});
