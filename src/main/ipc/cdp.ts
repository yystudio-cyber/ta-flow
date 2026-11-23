// CDP / Chrome handlers
import { BrowserWindow } from 'electron';
import { handle } from './wrap';
import { IPC } from '../../shared/types';
import { getDb } from '../db';
import { getRuntime } from '../services/runtime-registry';
import { PLATFORMS, type PlatformId } from '../../shared/types';

// ★ 2026-08-04：整个 CDP 控制面原本 11 处硬编码 getRuntime(P(platform)) ——
//   意味着「打开浏览器 / 连接 / 状态 / 关闭」全是 BOSS 专用，猎聘浏览器在界面上
//   根本打不开（而 UI 上摆着按钮）。全部改为按 platform 路由，缺省仍是 boss，
//   老调用方（不传参）行为完全不变。
const P = (v?: string): PlatformId => (PLATFORMS.includes(v as PlatformId) ? (v as PlatformId) : 'boss');

export function registerCdpHandlers(winGetter: () => BrowserWindow | null) {
  // 向渲染进程推一次真实浏览器状态（open=端口就绪/已打开，connected=puppeteer已接管）
  async function pushStatus(platform: PlatformId = 'boss') {
    const w = winGetter();
    if (!w || w.isDestroyed()) return;
    try {
      const s = await getRuntime(platform).chrome.getBrowserStatus();
      w.webContents.send('cdp-status', { platform, connected: s.attached, open: s.open });
    } catch { /* 忽略推送失败 */ }
  }

  handle(IPC.CDP_STATUS, async (_e, platform?: string) => {
    const s = await getRuntime(P(platform)).chrome.getBrowserStatus();
    return { connected: s.attached, open: s.open };
  });

  handle(IPC.CDP_LAUNCH, async (_e, opts?: { headless?: boolean; chromePath?: string }, platform?: string) => {
    await getRuntime(P(platform)).chrome.launch(opts);
    // 启动后推送一次活跃 JD 到新打开的页面
    const row = getDb().prepare('SELECT data FROM jds WHERE active = 1 LIMIT 1').get() as any;
    if (row) {
      const jd = JSON.parse(row.data);
      getRuntime(P(platform)).chrome.pushActiveJdToAllPages(jd).catch(() => {});
    }
    getRuntime(P(platform)).riskMonitor.loadFromDb();
    return true;
  });

  handle(IPC.CDP_CONNECT_EXISTING, async (_e, endpoint?: string, platform?: string) => {
    await getRuntime(P(platform)).chrome.connectExisting(endpoint);
    getRuntime(P(platform)).riskMonitor.loadFromDb();
    void pushStatus(P(platform));
    return true;
  });

  // 一键智能连接：先连已开的调试 Chrome，连不上则自动起一个专用 Chrome（用户无需配端口/模式）
  // 注意：连接后【不】注入、【不】推送 JD——登录期间保持零打扰，避免 BOSS 检测到自动化弹回登录。
  handle(IPC.CDP_SMART_CONNECT, async (_e, platform?: string) => {
    const r = await getRuntime(P(platform)).chrome.smartConnect();
    getRuntime(P(platform)).riskMonitor.loadFromDb();
    void pushStatus(P(platform));
    return r;
  });

  // 只打开 BOSS 浏览器供用户登录，不连 puppeteer（登录期间零程序附着，BOSS 才接受）
  handle(IPC.CDP_OPEN_FOR_LOGIN, async (_e, platform?: string) => {
    // ★ 必须把本平台的落地页传进去：不传的话 openBrowserForLogin 用的是 BOSS 默认值
    //   （zhipin.com），猎聘那个 9333 浏览器会打开 BOSS —— 既没用，又在猎聘 profile
    //   上留下 BOSS 访问痕迹，与 L1 隔离的初衷直接冲突。
    const rt = getRuntime(P(platform));
    const r = await rt.chrome.openBrowserForLogin(rt.adapter.loginStartUrl);
    void pushStatus(P(platform)); // 打开后立即推"已打开"，修界面仍显示"未连接"的误导
    return r;
  });

  handle(IPC.CDP_CLOSE, async (_e, platform?: string) => {
    await getRuntime(P(platform)).chrome.close();
    void pushStatus(P(platform));
    return true;
  });
}
