// IPC 总入口（H8 重构：按领域拆分到子文件，不再是 300+ 行上帝模块）
// H7 修复：所有 handler 通过 wrap.ts 的 handle() 统一 try/catch，防止主进程崩溃
import { BrowserWindow } from 'electron';
import { registerAppHandlers } from './app';
import { registerSettingsHandlers } from './settings';
import { registerToolsHandlers } from './tools';
import { registerJdHandlers } from './jd';
import { registerRpaHandlers, attachRpaEvents } from './rpa';
import { registerMatchHandlers } from './match';
import { registerCdpHandlers } from './cdp';
import { registerRiskHandlers, attachRiskEvents } from './risk';
import { registerDashboardHandlers } from './dashboard';
import { registerDataHandlers } from './data';
import { registerOplogHandlers } from './oplog';
import { registerTalentHandlers } from './talent';
import { registerPlatformHandlers } from './platform';

export function registerAllIpc(win: BrowserWindow, dataDir: string) {
  const winGetter = () => (win.isDestroyed() ? null : win);

  // 按域隔离注册（隔离改造 2026-07-29）：原来 11 个域顺序裸调，任何一个在【注册期】
  // 抛错（如 talent 域注册时就挂 chromeManager 监听），后面的域全部没有 handler，
  // 页面直接白屏——工具域的一个问题能把 RPA/风控/设置全部拖死。
  // 现在一个域注册失败只损失该域的 IPC，其余域照常服务；失败即刻打日志留痕。
  const domain = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e: any) {
      console.error(`[ipc] 「${name}」域注册失败（已隔离，其余域照常）：`, e?.stack || e);
    }
  };

  domain('app', () => registerAppHandlers(winGetter));
  domain('settings', () => registerSettingsHandlers(winGetter, dataDir));
  domain('tools', () => registerToolsHandlers(winGetter));
  domain('jd', () => registerJdHandlers(winGetter));
  domain('rpa', () => registerRpaHandlers(winGetter));
  domain('match', () => registerMatchHandlers(winGetter));
  domain('cdp', () => registerCdpHandlers(winGetter));
  domain('risk', () => registerRiskHandlers(winGetter));
  domain('dashboard', () => registerDashboardHandlers(winGetter));
  domain('data', () => registerDataHandlers(winGetter, dataDir));
  domain('talent', () => registerTalentHandlers(winGetter)); // G2/G3: 岗位收件箱 + 人才库
  domain('platform', () => registerPlatformHandlers(winGetter));
  domain('oplog', () => registerOplogHandlers()); // 运行日志：只读观测面

  // 事件推送（主进程 -> 渲染进程）
  domain('rpa-events', () => attachRpaEvents(winGetter));
  domain('risk-events', () => attachRiskEvents(winGetter));
}
