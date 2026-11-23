// Electron 主进程入口
// P0 隐身：rebrowser-puppeteer-core 的 Runtime.enable 修复模式（addBinding=保留主世界 evaluate，可读页面 Vue）
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE || 'addBinding';
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  shell,
  nativeImage,
  dialog,
  session,
  globalShortcut,
  type NativeImage,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { setupAutoLaunch } from './services/auto-launch';
import { initDatabase, initEncryptionFromSettings, getSetting, setSetting, flushDb, persistImmediate, getDb, reindexLiepinTalentsFts } from './db';
import { registerAllIpc } from './ipc/index';
import { toolManager } from './tools/manager';
import { startJdBridge, stopJdBridge, EXTENSION_ID as MATCH_SCORE_EXTENSION_ID, bridgeEvents, getRecentSamples, getDiagnosticsDir } from './services/jd-bridge';
import { startReqsheetBridge, stopReqsheetBridge, setRunToken } from './services/reqsheet-bridge';
import { startScheduler, stopScheduler } from './services/scheduler';
import { readKnownReqIds, getTargetXlsxPath } from './services/req-sheet-writer';
import { getRuntime, applyBrowserSettings } from './services/runtime-registry';
import { toolsChromeManager, BEHAVIOR_LOG_EXTENSION_ID } from './cdp/chrome';
import { startAutomation, stopAutomation } from './services/automation';
import { PLATFORMS } from '../shared/types';
import { DEFAULT_SETTINGS, getRiskThresholdsForMode, normalizeSpeedMode } from '../shared/constants';
import type { AppSettings, PlatformId } from '../shared/types';
import { oplog, startSession as startOplogSession, shutdown as shutdownOplog, flush as flushOplog } from './services/oplog';

// ── 进程级兜底（隔离改造 2026-07-29）──────────────────────────────────────────
// 此前全进程没有 uncaughtException/unhandledRejection 处理器：jd-bridge 的 http 回调、
// 任何定时器里的一次同步异常，都会让主进程整个退出——支线杀主线的唯一硬路径。
// 这里兜住并留痕，不退出：一个子系统的异常最多坏它自己，不许陪葬其它三条线。
// 不在这里做任何"自动修复"——出错的子系统保持坏着，等它自己的诊断通道暴露问题。
// 2026-08-04：这两个处理器原本只往 stderr 打印 —— 打包后的 App 没有控制台，
// 等于"某个子系统悄悄坏了"永远查不出来。补记进运行日志（只记录，行为不变：仍不退出、不弹框）。
process.on('uncaughtException', (e: any) => {
  try { console.error('[isolate] uncaughtException（已拦截，进程继续）：', e?.stack || e); } catch { /* ignore */ }
  try {
    oplog('proc', 'uncaught-exception', {
      err: String(e?.message || e).slice(0, 400), stack: String(e?.stack || '').slice(0, 600),
    }, { ok: false });
    flushOplog();  // 进程状态已不可信，立刻落盘，别等定时器
  } catch { /* ignore */ }
});
process.on('unhandledRejection', (r: any) => {
  try { console.error('[isolate] unhandledRejection（已拦截，进程继续）：', r?.stack || r); } catch { /* ignore */ }
  try {
    oplog('proc', 'unhandled-rejection', {
      err: String(r?.message || r).slice(0, 400), stack: String(r?.stack || '').slice(0, 600),
    }, { ok: false });
  } catch { /* ignore */ }
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appQuitting = false;
// before-quit 的异步清理只做一次：第一次拦下退出去断 CDP，完成后置位并重新 quit 放行
let quitCleanupDone = false;

const isDev = !app.isPackaged;

function getDataDir(): string {
  const dir = path.join(app.getPath('userData'), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function crashFlagPath(): string {
  return path.join(app.getPath('userData'), 'crash.flag');
}

function setCrashFlag(set: boolean) {
  try {
    const p = crashFlagPath();
    if (set) {
      fs.writeFileSync(p, String(Date.now()), 'utf-8');
    } else {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}
}

function checkCrashFlag(): boolean {
  try {
    return fs.existsSync(crashFlagPath());
  } catch {
    return false;
  }
}

function getIcon(): NativeImage | undefined {
  try {
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
    if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
    const devPath = path.resolve(process.cwd(), 'build', 'icon.png');
    if (fs.existsSync(devPath)) return nativeImage.createFromPath(devPath);
  } catch {}
  return undefined;
}

// Low(CSP): 内容安全策略 —— dev 需放开 HMR（inline/eval/websocket），prod 收紧到本地资源
// 说明：dist/index.html 仅引用同目录 ./assets 下的 module 脚本与样式，故 prod 用 script-src 'self' 即可；
// style-src 保留 'unsafe-inline' 以兼容 Vue/Element 运行时注入的行内样式，避免样式丢失。
// 说明：放行 Google Fonts（Caprasimo/Figtree，设计系统字体）。仅拉取字体资源、不发送用户数据；
// 如需完全离线/零外链，可把字体 woff2 放进 public/fonts 并改用本地 @font-face。
// 字体已本地自托管（woff2 打包进 renderer），CSP 不再放行任何外部源 —— 真正数据不出本地。
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join('; ');

// Low(CSP): 通过 onHeadersReceived 给渲染进程响应注入 CSP 响应头
function setupCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [isDev ? DEV_CSP : PROD_CSP],
      },
    });
  });
}

// E3(2026-08-05)：默认 Electron 全放行权限请求。本应用不用摄像头/麦克风/定位/通知/全屏等，
// 一律 deny 减少攻击面（media/geolocation/notifications/fullscreen）。
// 其他 session（独立浏览器 RPA 会另建 partition）走默认值，不影响 BOSS/猎聘正常登录。
function setupPermissions() {
  const ALLOW_DEFAULT = ['clipboard-read', 'clipboard-sanitized-write', 'mediaKeys', 'idle-detection'];
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    if (ALLOW_DEFAULT.includes(perm)) { cb(true); return; }
    // 显式拒绝：media/geolocation/notifications/fullscreen/midi/pointerLock/openExternal 等
    cb(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

// Low(CSP): 判定目标 URL 是否属于本应用内部（file:// 本地入口 或 dev server 同源），其余视为外链
function isInternalUrl(target: string): boolean {
  try {
    const u = new URL(target);
    if (u.protocol === 'file:') return true;
    if (isDev && process.env.VITE_DEV_SERVER_URL) {
      const dev = new URL(process.env.VITE_DEV_SERVER_URL);
      if (u.origin === dev.origin) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Low(恢复): 读取上次视图路由（hash，如 "#/candidates"）
function getLastRoute(): string {
  const r = getSetting<string>('app.lastRoute', '');
  return typeof r === 'string' && r.startsWith('#') ? r : '';
}

// 页面加载（在 IPC 注册之后调用）——崩溃/重启后恢复到上次视图（hash 路由，file:// 下安全）
async function loadMainWindow(win: BrowserWindow) {
  const lastRoute = getLastRoute();
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL + lastRoute);
  } else {
    await win.loadFile(
      path.join(__dirname, '../../dist/index.html'),
      lastRoute ? { hash: lastRoute.slice(1) } : undefined,
    );
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    title: 'TA Flow',
    icon: getIcon(),
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true, // preload 只用到 ipcRenderer/contextBridge，纯 IPC 桥完全可在 sandbox 下运行
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    frame: true,
  });

  // 注意：页面加载延迟到 registerAllIpc 之后（见 loadMainWindow），
  // 否则渲染层 store.init() 会在 IPC handler 注册前调用 settings:get 而报"No handler registered"。

  // Low(恢复): 记录 SPA 内部路由变化（hash 模式的路由跳转会触发 did-navigate-in-page）
  mainWindow.webContents.on('did-navigate-in-page', (_e, url) => {
    try {
      const h = new URL(url).hash;
      if (h) setSetting('app.lastRoute', h);
    } catch {}
  });

  // Low(CSP): 新窗口一律拒绝，仅把 http/https 外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Low(CSP): 拦截应用内导航 —— 非本应用内部 URL 一律阻止，http/https 用系统浏览器打开，
  // 防止 XSS 后导航到外部页面拿到 window.api
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isInternalUrl(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
  });

  // Low(快捷键): 应用内快捷键（仅窗口聚焦时生效，不劫持系统全局按键）
  //  - F5 / Ctrl+R：刷新当前视图；Ctrl+Shift+I / F12：切换开发者工具
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if (key === 'f5' || (input.control && key === 'r')) {
      mainWindow?.webContents.reload();
    } else if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // Medium 修复：renderer 崩溃时提示用户并尝试重载
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] render-process-gone:', details);
    dialog
      .showMessageBox({
        type: 'error',
        title: '界面已崩溃',
        message: `界面进程异常退出（${details.reason}），是否重新加载？`,
        buttons: ['重新加载', '关闭'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0 && mainWindow) {
          mainWindow.reload();
        }
      })
      .catch(() => {});
  });

  mainWindow.on('unresponsive', () => {
    dialog
      .showMessageBox({
        type: 'warning',
        title: '界面无响应',
        message: '界面暂时无响应，是否等待或重新加载？',
        buttons: ['等待', '重新加载'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (response === 1 && mainWindow) mainWindow.reload();
      })
      .catch(() => {});
  });

  mainWindow.on('close', (e) => {
    // A3: 窗口关闭时立即 flush oplog（定时器是 unref 的，可能不会触发）
    try { flushOplog(); } catch { /* ignore */ }
    const settings = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
    if (!appQuitting && settings.general.trayOnClose) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function createTray() {
  const icon = getIcon();
  if (!icon) return;
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: '暂停 / 恢复 RPA',
      click: () => {
        // 直接驱动引擎（原先只发 tray-action 事件但渲染层无人订阅→点了没反应）。
        // L6(阶段1)：此前写死 getRuntime('boss')——用户切到猎聘 tab 后点托盘「暂停/恢复」，
        // 暂停的却是 BOSS 引擎，与界面所示平台不符。改在 click 时实时读 DB 的当前激活平台，
        // 驱动对应引擎（settings 闭包是启动快照，不能信，必须现读 DB）。
        const s = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
        const p = (PLATFORMS as readonly string[]).includes(s?.general?.activePlatform)
          ? (s!.general.activePlatform as PlatformId)
          : 'boss';
        const st = getRuntime(p).engine.getState().status;
        if (st === 'running') getRuntime(p).engine.pause();
        else if (st === 'paused') getRuntime(p).engine.resume();
        mainWindow?.webContents.send('tray-action', 'toggle-rpa'); // 兼容：仍广播，供渲染层刷新
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        appQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('TA Flow');
  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ── 单实例锁 ──────────────────────────────────────────────────────────────
// 必须在 whenReady 之前抢锁。多开的后果不是"两个窗口"这么轻：
//   ① 两个实例各自跑 RPA → 同一账号被双倍频率操作，直接顶穿风控（这是封号级后果）；
//   ② 风控闭环的所有计数/熔断都是【进程内内存态】，两实例互不可见，限额与退避全部失真；
//   ③ 两实例抢同一个 CDP 端口与 userDataDir；
//   ④ 同时写同一个 SQLite（WAL 不至于损坏，但 busy 错与计数竞态跑不掉）。
// 第二个实例直接退出，并把已有窗口唤到前台。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      if (!w.isVisible()) w.show();
      w.focus();
    }
  });
}

// ── 启动链故障隔离（隔离改造 2026-07-29）────────────────────────────────────
// 原来 whenReady 一条链无任何 catch：toolManager.loadAll()（工具库支线）一抛，
// 后面的窗口、IPC、RPA、JD 桥全部不出现——支线把主线连根拖死。
// 现在每个子系统各自成段兜错：一段失败只损失该段功能，失败清单在窗口起来后告知。
const bootFailures: { step: string; error: string }[] = [];
async function bootStep(step: string, fn: () => unknown | Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e: any) {
    bootFailures.push({ step, error: String(e?.message || e) });
    console.error(`[boot] 「${step}」启动失败（已隔离，其余模块照常）：`, e?.stack || e);
    return false;
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // 已有实例在跑，本进程只负责退出
  startOplogSession();
  // userData 目录不可用（权限/磁盘/杀软）是能走到的现实分支，必须进 bootStep：
  // 建不出目录时退回 userData 本身，数据库段会自己失败进清单，窗口照常起。
  let dataDir = app.getPath('userData');
  await bootStep('数据目录', () => { dataDir = getDataDir(); });
  // 数据库是四条线的共同底座，失败也不中断启动：依赖它的各段会各自失败进清单，
  // 窗口照常起——用户看到的是"哪些子系统没起来"，而不是一个永远不出现的 App。
  await bootStep('数据库', () => initDatabase(dataDir));

  // H4: 根据 settings 决定是否启用加密（safeStorage 需要 app.ready）
  await bootStep('数据加密', () => initEncryptionFromSettings());
  // 阶段5②：加密就绪后幂等回填猎聘人才库 FTS5 影子表（迁移只建表不回填，因那时密钥未初始化）。
  // 已灌齐则秒过；存量密文行在此解密灌明文，之后由 upsert 增量维护。
  await bootStep('猎聘人才库全文索引', () => { try { reindexLiepinTalentsFts(); } catch { /* 失败不阻断启动 */ } });

  // Medium 修复：启动时检测上次是否异常退出
  const crashedLast = checkCrashFlag();
  // 重新设置 crash flag，before-quit 成功 flush 后再清掉
  setCrashFlag(true);

  // 读取设置（读不到就用默认值走完启动，不让配置问题变成全局故障）
  let settings: AppSettings = DEFAULT_SETTINGS;
  await bootStep('读取设置', () => { settings = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS); });
  await bootStep('浏览器与自启配置', async () => {
    if (settings.browser.chromePath) getRuntime('boss').chrome.setChromePath(settings.browser.chromePath);
    if (settings.browser.userDataDir) getRuntime('boss').chrome.setUserDataDir(settings.browser.userDataDir);
    if (settings.browser.extraArgs) getRuntime('boss').chrome.setExtraArgs(settings.browser.extraArgs);
    if (settings.browser.cdpPort) getRuntime('boss').chrome.setPort(settings.browser.cdpPort);
    // 工具专用浏览器：Chrome 路径与 RPA 实例共用一份设置；端口/profile 是它自己的（9333），
    // 刻意不给配置项——它存在的意义就是与 RPA 浏览器零共享。
    if (settings.browser.chromePath) toolsChromeManager.setChromePath(settings.browser.chromePath);
    await setupAutoLaunch(settings.general.autoLaunch);
  });

  // 工具库（支线）：失败只影响工具注入，绝不许波及 RPA/窗口/IPC
  await bootStep('工具库扫描', () => toolManager.loadAll());

  await bootStep('风控恢复', () => {
    // 反风控参数系统固定：启动初值按默认档位派生，不再读用户 settings.risk（运行时再按任务档位覆盖）。
    // P1-2: 同时传入档位，让风险指数按正确上限计算（不再写死 human）
    const initTier = normalizeSpeedMode(settings.rpa?.defaultSpeed || 'human');
    getRuntime('boss').riskMonitor.updateThresholds(getRiskThresholdsForMode(initTier), initTier);
    getRuntime('boss').riskMonitor.loadFromDb();
    // 跨重启恢复风控退避态：熔断冷却窗口 + 需人工确认的异常闩。
    // 不恢复的话，"熔断中/出验证码后把 App 关掉再开"就能把退避与人工确认门禁一起绕过，
    // 而这恰恰是最需要它们生效的场景。
    getRuntime('boss').riskController.restoreFromDisk();
    getRuntime('boss').riskMonitor.restoreFromDisk();
  });

  // ── 人才库只保留【本轮】结果：启动时先清空上一次会话遗留的记录 ──────────────
  // BOSS 的候选人链接是会话级重放锚（boss:geek:<encryptGeekId>），App 一重启、浏览器会话一换，
  // 旧记录的链接就全是死链。只在"开始找人"时清是不够的——用户重启后直接打开人才库，
  // 看到的仍然是上一次的人。故启动时也清一次，保证人才库任何时候都只有当前这轮。
  try {
    const n = getDb().prepare('DELETE FROM candidates_export').run().changes;
    if (n) console.log(`[talent] 启动清理：移除上次会话遗留的 ${n} 条候选人记录（链接已失效）`);
  } catch (e: any) {
    console.warn('[talent] 启动清理失败：', e?.message || e);
  }

  // JD 桥（匹配分插件支线）：给「TA 匹配分助手」扩展供当前激活岗位（只监听 127.0.0.1，只放行固定 ID 的那个扩展）。
  // B(P0)：桥同时接收扩展采回的页面结构样本（POST /structure/sample），落盘到 diagnostics/，
  // 用于适配新的卡片形态（搜索页等），不进数据库。
  const diagsDir = path.join(dataDir, 'diagnostics');
  await bootStep('JD 桥', () => startJdBridge({ diagnosticsDir: diagsDir }));
  await bootStep('需求汇总桥', () => startReqsheetBridge());
  await bootStep('需求汇总定时器', async () => {
    startScheduler(async ({ scheduled, maxPerRun }) => {
      // 定时/补跑触发：读 knownIds → 设置 token → 打开 Chrome
      try {
        const xlsxPath = getTargetXlsxPath();
        const knownIds = await readKnownReqIds(xlsxPath);
        const runId = `sched-${Date.now()}`;
        setRunToken({ runId, knownReqIds: knownIds, config: { scheduled, maxPerRun } });
        const { spawn } = require('child_process');
        const { getRuntime } = require('./services/runtime-registry');
        const chromePath = getRuntime('boss').chrome.findChrome();
        // ⚠️ 必须用带 status=0（全部页签）+ 审批通过筛选的那个 URL，与手动触发同源。
        // 裸 /requirement/list 会被飞书重定向到 status=2（进行中），定时跑就只覆盖
        // 「进行中」那一档，其余状态里的审批通过需求永远同步不到，且界面看不出漏。
        const { REQUIREMENT_LIST_URL } = require('./ipc/tools');
        if (chromePath && process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', '', chromePath, REQUIREMENT_LIST_URL],
            { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } else if (chromePath) {
          // macOS / Linux：直接 spawn 独立 Chrome（与 openBrowserForLogin/launchDetached 的非 win32 分支同源）
          spawn(chromePath, [REQUIREMENT_LIST_URL], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch (e: any) {
        console.warn('[scheduler] 触发失败：', e?.message || e);
      }
    });
  });

  // G3 + A3/A4 反向告警：启动时检查 RPA 专用 profile 里是否装了匹配分插件。
  // 正常情况插件应该装在【用户日常 Chrome】里（不被 puppeteer 附着、不发 zhipin 请求，零风险）。
  // 若用户误把插件装进了 RPA 的 chrome-profile，这里只做【提前预警】——真正的硬阻断在
  // launch/launchDetached/openBrowserForLogin 三处启动路径里（A1），不卸载插件就启不动浏览器。
  // 提前预警让用户在点「开始找人」之前就能看到问题，不会到要跑的时候才被阻断。
  // A3：(1) 不占用 getRuntime('boss').riskMonitor.state.reasons——那 6 个位是给 BOSS 真实风控信号用的
  //   （code:35 / 验证码 / 频率超限），配置问题不该把风控信号挤掉；
  // (2) 同一问题不每次启动都弹通知：用 setSetting 记一个状态键，只有从"没装→装了"转换时才 notify。
  // A4 因果纠正：受影响的是 RPA 线而不是插件线。真人 sourcing 用日常 Chrome，不碰 RPA profile，
  //   插件线零风险前提不因此破坏；真正的风险是 RPA 会话里多了个改 DOM 的扩展，增加被识别面。
  await bootStep('插件线隔离自检', () => {
    // RPA 专用 profile 里不该出现任何我们这两个招聘相关扩展。都装在【日常 Chrome】里才对。
    // 硬阻断由 chrome.ts 的 rejectExtensionIds 在启动/附着时完成；这里是"刚发现"时的软告警。
    const WATCH = [
      { id: MATCH_SCORE_EXTENSION_ID, name: 'TA 匹配分助手', key: 'isolation.rpa-profile-has-matchscore-plugin',
        risk: '一个会给每张候选人卡片插入元素的扩展' },
      { id: BEHAVIOR_LOG_EXTENSION_ID, name: '招聘行为记录', key: 'isolation.rpa-profile-has-behaviorlog-plugin',
        risk: '一个会监听页面点击/滚动的行为采集扩展' },
    ];
    for (const w of WATCH) {
      try {
        const hasNow = getRuntime('boss').chrome.hasInstalledExtensionOnDisk(w.id);
        const hadBefore = !!getSetting<boolean>(w.key, false);
        if (hasNow) {
          const dir = getRuntime('boss').chrome.getUserDataDir();
          const msg =
            `RPA 专用浏览器（profile: ${dir}）里检测到「${w.name}」。\n`
            + `若启动 RPA，被 puppeteer 附着的会话里会多出 ${w.risk}，\n`
            + `增加 RPA 被识别的攻击面（你真人 sourcing 用的日常 Chrome 不受影响）。\n`
            + `请打开 RPA 专用 Chrome 进入 chrome://extensions 卸载「${w.name}」，\n`
            + `它应该装在你日常用的 Chrome 里。不卸载就无法启动 RPA 浏览器。`;
          console.warn(`[isolation] RPA profile 检测到「${w.name}」：` + dir);
          // 只在「刚发现」时弹通知，避免每次启动都打断；日志每次都打。
          if (!hadBefore) {
            setSetting(w.key, true);
            getRuntime('boss').riskMonitor.notifyUser(`⚠️ RPA 浏览器里装了「${w.name}」`, msg);
          }
        } else if (hadBefore) {
          // 用户卸载了：清掉标记，下次再装上时还能弹通知
          setSetting(w.key, false);
        }
      } catch (e: any) {
        // 自检失败不影响启动，只 warn
        console.warn(`[isolation] 「${w.name}」隔离自检失败（已跳过）：`, e?.message || e);
      }
    }
  });

  // Low(CSP): 在建窗前给默认会话装好 CSP 响应头
  await bootStep('CSP', () => setupCsp());
  // E3(2026-08-05)：禁用非必要权限请求（media/geolocation/notifications 等）
  await bootStep('权限收口', () => setupPermissions());

  // 窗口 + IPC 是用户能看到一切的前提，失败就明确弹框退出，不静默消失
  let win: BrowserWindow;
  try {
    win = await createWindow();
  } catch (e: any) {
    dialog.showErrorBox('启动失败', '主窗口创建失败：' + String(e?.message || e));
    app.quit();
    return;
  }
  await bootStep('系统托盘', () => createTray());
  // 必须在加载页面前注册，避免渲染层首个 settings:get 落空。
  // registerAllIpc 内部已按域隔离（一个域注册失败不影响其它域，见 ipc/index.ts）。
  await bootStep('IPC 注册', () => registerAllIpc(win, dataDir));
  await bootStep('加载界面', () => loadMainWindow(win));

  // S5: 启动自动化驱动（定时 cron + 空闲检测）——通过 startTaskById/ensureRunning 幂等驱动引擎
  await bootStep('自动化调度', () => startAutomation());
  // S6: 启动行为学习（按平台各启动一个，P1-6 修复：不再全平台共用 boss 采样器）
  await bootStep('行为学习', () => { for (const p of PLATFORMS) getRuntime(p).behaviorLearner.start(); });

  // Low(快捷键): 全局显示/隐藏主窗口（系统级，选用不常见组合避免冲突；失败不影响启动）
  try {
    globalShortcut.register('CommandOrControl+Alt+T', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch {}

  // 2026-08-07 P1-7: 遍历所有平台挂 disconnected 监听（原来只挂 boss）。
  // 事件 payload 带 {platform, connected, open}，渲染层按 platform 过滤只更新对应平台状态。
  // 猎聘断连原来要等最多 6s 轮询才校正；BOSS 断连时还会误置 boss 之外平台的 browserOpen。
  for (const p of PLATFORMS) {
    getRuntime(p).chrome.on('disconnected', () => {
      win.webContents.send('cdp-status', { platform: p, connected: false, open: false });
    });
  }

  // ── 平台施压信号的【常驻】接收（审计 2026-07-29 补）────────────────────────
  // 此前 api-risk-signal / boss-security-report 的唯一订阅方在 RPA 引擎里，
  // 而那些监听是随每次运行 attach、运行一结束就摘掉的。发出方（页面响应监控）却是
  // 挂在浏览器每个页面全生命周期上的。于是 RPA 不在跑的时候——手动逛 BOSS、
  // 用工具库跑飞书搬运、两次运行之间——检测到了 code:35 / 403 / 429 / Boss端100xx
  // 也【没有任何人接】：不留痕、不冷却、不告警。而 code:35 是 IP/会话信誉级信号，
  // 与 RPA 是否在跑无关，下次点「开始找人」时系统对它一无所知，照原速起跑。
  //
  // 这里补一条常驻链路：引擎在跑时由引擎处置（分级/停机/熔断，逻辑不变，此处让路避免双计），
  // 引擎不在跑时至少【留痕 + 进冷却】，让启动层的冷却门控能挡住随后的自动重启。
  await bootStep('常驻风控信号', () => attachStandingRiskSignals());
  await bootStep('注入告警通道', () => registerInjectBlockedWarning(win));

  // 启动失败清单：如实告知哪些子系统没起来（不弹模态阻断，用户关掉即可继续用其余功能）
  if (bootFailures.length) {
    const detail = bootFailures.map((f) => `· ${f.step}：${f.error}`).join('\n');
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '部分子系统未能启动',
      message: `以下 ${bootFailures.length} 个子系统启动失败，其余功能不受影响：\n\n${detail}\n\n修复后重启 App 即可恢复。`,
      buttons: ['知道了'],
      defaultId: 0,
    }).catch(() => {});
  }

  // D7(2026-08-05)：崩溃提示重写——原来让用户"在设置里关闭硬件加速"但设置页根本没这个开关，
  // 且不回答 TA 最关心的"跑到哪了、人收了吗、要不要重跑"。
  // 注：rpa-engine 的 lastBreakpoint 是内存态，进程崩溃后拿不到精确断点；已落库的数据（人才库/日志/
  // 风险历史）都在，已收入人才库的人不需要重跑，只丢崩溃前几秒未落库的浏览记录。如实告诉用户。
  if (crashedLast) {
    dialog
      .showMessageBox(win, {
        type: 'info',
        title: '检测到上次未正常退出',
        message:
          '检测到上次未正常退出（可能是系统关机、应用崩溃或强制关闭）。\n\n'
          + '· 已收入人才库的候选人都还在，不需要重跑；\n'
          + '· 崩溃前几秒正在浏览的人可能没记上，打开 RPA 控制台继续即可；\n'
          + '· 如频繁出现，请在「运行日志」页点「导出诊断包」把文件发给我排查。',
        buttons: ['知道了'],
        defaultId: 0,
      })
      .catch(() => {});
  }

  // 关键状态已加载完毕，立即落盘一次让 crash flag 时期也有最新数据
  persistImmediate();
}).catch((e: any) => {
  // 启动链的最后防线（四线隔离 2026-07-29）：此前 whenReady 的 then 没有 .catch，
  // 这里一旦 reject 会被进程级 unhandledRejection 静音——表现是"点了图标没反应"，
  // 四条线全灭且零提示零日志。现在如实弹框后退出，故障至少看得见。
  console.error('[boot] 启动链未处理异常：', e?.stack || e);
  try {
    dialog.showErrorBox('启动失败', '应用启动过程中发生未处理异常：' + String(e?.message || e));
  } catch { /* dialog 不可用时也不能吞掉退出 */ }
  app.quit();
});

/**
 * 平台施压信号的常驻兜底处置（引擎不在跑时生效）。
 *
 * 分工：引擎在跑 → 由引擎的 handleSignal 做分级处置（停机/熔断/降速），这里直接让路，
 *       否则同一条信号会被计两次，把指数退避打快一档。
 *       引擎不在跑 → 这里负责【留痕 + 按信号轻重进冷却】。不做停机（没有在跑的东西可停），
 *       但冷却会被 rpa-launcher 的门控读到：调度/空闲不会在冷却期自动起跑，
 *       手动起跑时引擎主循环也会先等冷却。
 * 冷却时长取的是登记册口径的保守值，并且【不碰控制器的熔断计数】——
 *       非运行期的信号不该消耗"同一次运行内第二次即硬停"的额度。
 */
function attachStandingRiskSignals() {
  const COOLDOWN: Record<string, number> = {
    apiCode35: 30 * 60 * 1000,
    http403: 30 * 60 * 1000,
    http429: 15 * 60 * 1000,
    loginLost: 0,        // 会话失效：留痕即可，冷却没有意义（要人重登）
    securityJsFail: 0,   // 软信号：只留痕
  };
  const label: Record<string, string> = {
    apiCode35: '入口层判定 IP/会话异常(code:35)',
    http403: '接口 403',
    http429: '接口 429（请求过于频繁）',
    loginLost: '登录态疑似失效',
    securityJsFail: '安全/风控 JS 加载失败',
  };
  // M5(阶段1)：此前只给 BOSS 浏览器挂了常驻信号兜底，猎聘浏览器在非找人期间
  // 触发的 code:35/403/429/安全 JS 信号【无人接】——猎聘的 WAF 挑战、429 全静默。
  // 改为遍历所有平台 runtime 各自挂载：回调内用闭包内的 rt，写进【该平台自己的】
  // riskMonitor（BOSS 的信号进 BOSS 风控、猎聘的进猎聘风控，不串台）。
  for (const p of PLATFORMS) {
    const rt = getRuntime(p);
    rt.chrome.on('api-risk-signal', (sig: any) => {
      try {
        if (rt.engine.getState().status === 'running' || rt.engine.getState().status === 'paused') return;
        const kind = String(sig?.kind || 'apiCode35');
        const reason = `${label[kind] || kind}（非找人期间检测到，来自浏览器正常使用）`;
        rt.riskMonitor.recordAnomaly(reason, 'notice');
        const ms = COOLDOWN[kind] ?? 0;
        if (ms > 0) {
          rt.riskMonitor.enterCooldown(ms, reason, 'notice');
          rt.riskMonitor.notifyUser(
            '⚠️ 浏览器使用中触发了平台风控',
            `${reason}\n已记录并冷却 ${Math.round(ms / 60000)} 分钟：这期间不会自动开始找人。`,
          );
        }
      } catch { /* 兜底通道本身不能影响主流程 */ }
    });
    // boss-security-report 是 BOSS 专属的页面环境检测信号：猎聘浏览器不会发它，
    // 但若仍遍历挂载也无害（猎聘 chrome 永不发此事件）。为防未来事件名复用串台，
    // 只在 BOSS 平台挂此监听——这是「平台判定守卫」。
    if (p === 'boss') {
      rt.chrome.on('boss-security-report', (rep: any) => {
        try {
          if (rt.engine.getState().status === 'running' || rt.engine.getState().status === 'paused') return;
          const reason = `Boss端环境检测上报 p2=${rep?.p2}（非找人期间）`;
          rt.riskMonitor.recordAnomaly(reason, 'notice');
          rt.riskMonitor.enterCooldown(30 * 60 * 1000, reason, 'notice');
          rt.riskMonitor.notifyUser('⚠️ 平台检测到自动化特征', `${reason}\n已冷却 30 分钟，这期间不会自动开始找人。`);
        } catch { /* 同上 */ }
      });
    }
  }
}

/**
 * 隔离世界不可用导致工具注入被拒时，如实告诉用户。
 * 此前只有一行 console.error：用户点了「打开并使用」、界面说"工具会自动出现"，
 * 而工具其实一个字都没注入，页面上什么都不会有——静默失效是最难自查的一类故障。
 */
function registerInjectBlockedWarning(win: BrowserWindow) {
  // ⚠️ 2026-07-29 回归修复：这里原来是【模态对话框】，而 inject-blocked 会在一些
  // 完全正常的竞态下触发（标签页正在关闭/导航时新文档注入来不及注册）。
  // 结果是用户在做完全不相干的事时，被一个写着"隔离世界不可用/已拒绝注入"的框拦住，
  // 页面还显示"未知"——既吓人又没有可操作信息，而且它说的问题多半根本不存在。
  //
  // 现在：良性竞态已在 chrome.ts 侧过滤掉（不再发事件）；真到了这里的才是"确实建不出
  // 隔离世界"。即便如此也不该用模态框打断——改为系统通知 + 写进风险历史，
  // 用户回头能在风险中心查到，不打断手上的事。同一会话只提醒一次。
  // 四线隔离 2026-07-29：提醒闸与留痕通道按浏览器实例分开。
  // 此前两实例共用一个 warned 闸——工具浏览器先报一次就把闸消耗掉，RPA 浏览器
  // 真故障时用户收不到任何通知；且工具页的注入失败 recordAnomaly 写进 RPA 的
  // 风险历史，把工具线的【本地故障】混进主线的风控通道（违反故障三分原则）。
  const makeInjectBlockedHandler = (source: 'rpa' | 'tools', platform: PlatformId) => {
    let warned = false;
    return (info: any) => {
      const where = info?.url ? String(info.url).slice(0, 120) : '当前页面';
      // M5(阶段1)：留痕/通知走【该平台自己的】riskMonitor——BOSS 注入失败进 BOSS 风险历史，
      // 猎聘注入失败进猎聘风险历史。工具浏览器借用 BOSS 通知通道（工具浏览器非平台浏览器）。
      const rm = getRuntime(platform).riskMonitor;
      if (source === 'rpa') {
        // RPA 浏览器：留痕进风险历史，用户回头能在风险中心查到
        try {
          rm.recordAnomaly(`工具注入被拒（隔离世界不可用）：${where}｜${info?.reason || ''}`, 'notice');
        } catch { /* 留痕失败不影响后续 */ }
      } else {
        // 工具浏览器：只记进程日志，不进 RPA 的风控留痕
        console.warn(`[tools-browser] 工具注入被拒（隔离世界不可用）：${where}｜${info?.reason || ''}`);
      }
      if (warned) return;
      warned = true;
      try {
        rm.notifyUser(
          '工具未能注入页面',
          `${where}\n浏览器的隔离世界不可用，出于安全考虑没有退回主世界执行。`
          + '表现是页面打开了但工具面板不出现，重启浏览器通常可恢复。',
        );
      } catch { /* 通知失败不影响主流程 */ }
      void win;
    };
  };
  // M5(阶段1)：遍历所有平台 chrome 各挂 inject-blocked（原来只挂 BOSS，猎聘浏览器注入失败静默）。
  for (const p of PLATFORMS) {
    getRuntime(p).chrome.on('inject-blocked', makeInjectBlockedHandler('rpa', p));
  }
  toolsChromeManager.on('inject-blocked', makeInjectBlockedHandler('tools', 'boss'));
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  // Low(快捷键): 退出前释放全局快捷键
  try {
    globalShortcut.unregisterAll();
  } catch {}
  // S5: 停止自动化定时器
  try {
    stopAutomation();
  } catch {}
  // S6: 停止行为学习定时器（P1-6: 按平台各停）
  try { for (const p of PLATFORMS) getRuntime(p).behaviorLearner.stop(); } catch {}
});

app.on('before-quit', (e) => {
  appQuitting = true;
  try { shutdownOplog(); } catch { /* 日志收尾失败不影响退出 */ }
  try {
    flushDb();
    // H6: flush 成功后清掉 crash flag
    setCrashFlag(false);
  } catch {
    // flush 失败，保留 crash flag 以便下次启动提示
  }
  // 退出时【只断开附着，不关浏览器】：主路径的 Chrome 是独立 spawn 的，
  // 设计上就要随 app 关闭仍存活以保住 BOSS 登录态。原先调 getRuntime('boss').chrome.close()
  // 会把它一并杀掉（每次退出都得重登），且是未 await 的 async 调用，断连不一定完成。
  stopJdBridge();
  stopReqsheetBridge();
  stopScheduler();
  if (quitCleanupDone) return;
  e.preventDefault();
  void (async () => {
    try {
      await Promise.race([
        // 两个实例都要断（此前只断 RPA 实例，工具实例的 CDP 连接靠进程死亡收尾）
        Promise.allSettled([getRuntime('boss').chrome.disconnect(), toolsChromeManager.disconnect()]),
        new Promise((r) => setTimeout(r, 2000)), // 兜底：断连卡住也不能让 app 关不掉
      ]);
    } catch {
      /* 断连失败不阻断退出 */
    } finally {
      quitCleanupDone = true;
      app.quit();
    }
  })();
});

// A3: Windows 关机/重启/注销时 before-quit 不触发（Electron 官方文档明确），
// 补 session-end 事件（Windows 专有）来收尾日志。
// Electron 31 的类型定义中不含此事件，但运行时实际支持。
(app as any).on('session-end', () => {
  try { shutdownOplog(); } catch { /* ignore */ }
  try { flushDb(); setCrashFlag(false); } catch { /* ignore */ }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
