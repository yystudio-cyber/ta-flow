import { BrowserWindow, app } from 'electron';
import { handle } from './wrap';
import { IPC } from '../../shared/types';
import type { PlatformId } from '../../shared/types';
import { PLATFORMS } from '../../shared/types';
import { getRuntime } from '../services/runtime-registry';

export function registerAppHandlers(winGetter: () => BrowserWindow | null) {
  handle(IPC.APP_GET_VERSION, () => app.getVersion() || process.env.npm_package_version || '1.0.0');
  handle(IPC.APP_QUIT, () => {
    const w = winGetter();
    if (w) w.close();
  });
  handle(IPC.APP_OPEN_DEVTOOLS, () => {
    const w = winGetter();
    if (w) w.webContents.openDevTools({ mode: 'detach' });
  });

  // 检查更新（单机版无更新服务器：返回当前版本 = 最新，供设置页"检查更新"按钮）
  handle(IPC.APP_CHECK_UPDATE, () => {
    const current = app.getVersion() || '1.0.0';
    return { current, latest: current, hasUpdate: false, message: '当前已是最新版本' };
  });

  // S6: "模仿本人"行为学习（P1-6: 通过 runtime 访问，不再直接引模块级单例）
  // L7(阶段1): 此前写死 getRuntime('boss')——猎聘 runtime 里也有 behaviorLearner
  // (runtime-registry 每平台一个)，但设置页调这三个 IPC 时永远只取 BOSS 的采样/应用/重置，
  // 猎聘侧永远读不到。改为接 platform 参数(渲染层按当前激活平台传)，兜底 boss。
  // 注:当前行为学习 UI 仅对 BOSS 暴露在设置页，但 IPC 层先打通平台参数，避免日后串台。
  const safePlatform = (p: any): PlatformId =>
    (PLATFORMS as readonly string[]).includes(p) ? (p as PlatformId) : 'boss';
  handle(IPC.BEHAVIOR_STATUS, (_e, platform?: PlatformId) =>
    getRuntime(safePlatform(platform)).behaviorLearner.status());
  handle(IPC.BEHAVIOR_APPLY, (_e, platform?: PlatformId) =>
    getRuntime(safePlatform(platform)).behaviorLearner.applyNow());
  handle(IPC.BEHAVIOR_RESET, (_e, platform?: PlatformId) => {
    getRuntime(safePlatform(platform)).behaviorLearner.reset();
    return true;
  });
}
