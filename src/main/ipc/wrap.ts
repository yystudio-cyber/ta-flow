// IPC handler 包装器：统一 try/catch + 参数校验，防止渲染进程异常调用导致主进程崩溃（修复 H7）
//
// 2026-08-04：接入运行日志（oplog）。
// D1: 错误消息去前缀 + 中文映射，用户不再看到 [rpa:start] 和原始异常堆栈。
import { ipcMain, BrowserWindow } from 'electron';
import { oplog } from '../services/oplog';

type Handler = (_e: Electron.IpcMainInvokeEvent, ...args: any[]) => any;

const SKIP_LOG = /^(rpa:get-state|risk:get-state|cdp:status|dashboard:stats)$/;

/** D1: 把原始异常文案映射成可操作的提示，[channel] 原文只进 oplog 不露给用户。 */
function userMessage(raw: string): string {
  const m = (raw || '').trim();
  // 已知错误 → 中文可操作句
  if (/no-reusable-work-page/i.test(m)) return '浏览器里没找到可用的工作页面。请在浏览器里打开推荐/搜索页面，再点开始找人。';
  if (/浏览器正处于登录|验证页/i.test(m)) return m; // ipc/talent.ts:288 已经有很好的中文文案
  if (/冷却|熔断|退避/i.test(m)) return m;
  if (/今日.*已达上限/i.test(m)) return m;
  if (/当前处于禁跑时段/i.test(m)) return m;
  if (/风控.*尚未解除/i.test(m)) return m;
  if (/连接.*拒绝|ECONNREFUSED|connect ECONNREFUSED/i.test(m)) return '连不上浏览器调试端口。请确认已通过「打开浏览器」启动了专用 Chrome，且 Chrome 还在运行中。';
  if (/端口.*占用|已被.*Chrome.*占用/i.test(m)) return m;
  if (/Unexpected token.*JSON|JSON at position/i.test(m)) return '数据格式异常，可能是浏览器页面临时异常或页面改版。请刷新页面后重试。';
  if (/找不到.*元素|选择器.*失效|等待.*超时/i.test(m)) return '页面上操作超时，可能页面正在加载或被平台拦截。请刷新页面后再试。';
  if (/浏览器.*路径|未找到 Chrome/i.test(m)) return '未找到 Chrome 浏览器，请在设置中指定 Chrome 安装路径。';
  if (/今日.*不再启动/i.test(m)) return m;
  if (/任务不存在/i.test(m)) return m;
  if (/正在启动/i.test(m)) return m;
  if (/未找到.*关键词|没配关键词/i.test(m)) return m;
  // 未知错误 → 统一口径，引导用户导出诊断包
  const hash = Math.abs(m.split('').reduce((s, c) => ((s << 5) - s + c.charCodeAt(0)) | 0, 0)).toString(36).slice(0, 5);
  return `操作没成功（编号 ${hash}），可到「运行日志」页面导出诊断包，或重新打开浏览器后重试。`;
}

export function handle(channel: string, fn: Handler, winGetter?: () => BrowserWindow | null) {
  ipcMain.handle(channel, async (e, ...args) => {
    const t0 = Date.now();
    const skip = SKIP_LOG.test(channel);
    try {
      const r = await fn(e, ...args);
      if (!skip) {
        try {
          oplog('ipc', channel, { argc: args.length }, { ok: true, ms: Date.now() - t0 });
        } catch { /* 日志失败绝不影响返回值 */ }
      }
      return r;
    } catch (err: any) {
      const rawMsg = err?.message || String(err);
      console.error(`[ipc:${channel}] error:`, err);
      try {
        oplog('ipc', channel, { argc: args.length, err: rawMsg }, { ok: false, ms: Date.now() - t0 });
      } catch { /* ignore */ }
      const win = winGetter?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send('ipc-error', { channel, message: rawMsg });
      }
      // D1: 用户看到的是中文提示，原始 [channel] 信息只进 oplog
      throw new Error(userMessage(rawMsg));
    }
  });
}

export function handleSync(channel: string, fn: Handler) {
  ipcMain.on(channel, (e, ...args) => {
    try {
      const ret = fn(e, ...args);
      e.returnValue = ret;
    } catch (err: any) {
      console.error(`[ipc-sync:${channel}] error:`, err);
      try { oplog('ipc-sync', channel, { err: err?.message || String(err) }, { ok: false }); } catch { /* ignore */ }
      e.returnValue = { error: err?.message || String(err) };
    }
  });
}
