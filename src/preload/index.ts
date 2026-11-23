// Preload script - 暴露 API 给渲染层
// 安全修复：移除通用 on(channel,cb) 通道，改为白名单事件，防止渲染进程 XSS 升级到任意 IPC
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type {
  AppSettings,
  JD,
  RPATask,
  RPAState,
  RiskState,
  DashboardStats,
  JrInboxItem,
  TalentCandidate,
} from '../shared/types';

// 允许渲染进程订阅的事件白名单（仅这些 channel 可监听）
const ALLOWED_EVENTS = new Set<string>([
  IPC.RPA_EVENT,
  IPC.RISK_EVENT,
  IPC.JR_INBOX_EVENT, // G2: 快照岗位入箱通知
  'cdp-status',
  'tray-action',
  'ipc-error', // 主进程 IPC 失败留痕（此前主进程一直在发、渲染层无人接的死通道）
  // 工具库收口(2026-08-20)：'tools:sample'(行为采样) 与 'tool-install-trust-request'(信任流程)
  //   的主进程侧 handler 已删除，渲染层不再监听，从白名单移除。
]);

function invoke(channel: string, ...args: any[]) {
  return ipcRenderer.invoke(channel, ...args);
}

function on(channel: string, cb: (...args: any[]) => void): () => void {
  if (!ALLOWED_EVENTS.has(channel)) {
    console.error('[preload] blocked listener on non-whitelisted channel:', channel);
    return () => {};
  }
  const fn = (_e: any, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.off(channel, fn);
}

const api = {
  // App
  getVersion: () => invoke(IPC.APP_GET_VERSION),
  quit: () => invoke(IPC.APP_QUIT),
  openDevTools: () => invoke(IPC.APP_OPEN_DEVTOOLS),
  checkUpdate: (): Promise<{ current: string; latest: string; hasUpdate: boolean; message: string }> =>
    invoke(IPC.APP_CHECK_UPDATE),

  // 行为学习（模仿本人 S6）
  // L7(阶段1): 三个接口加 platform 参数，渲染层按当前激活平台传，兜底 boss。
  behaviorStatus: (platform?: string): Promise<{ enabled: boolean; sampleCount: number; scrollCount: number; learned: any }> =>
    invoke(IPC.BEHAVIOR_STATUS, platform),
  behaviorApply: (platform?: string) => invoke(IPC.BEHAVIOR_APPLY, platform),
  behaviorReset: (platform?: string) => invoke(IPC.BEHAVIOR_RESET, platform),

  // Settings
  getSettings: (): Promise<AppSettings> => invoke(IPC.SETTINGS_GET),
  saveSettings: (s: AppSettings): Promise<AppSettings> => invoke(IPC.SETTINGS_SAVE, s),
  resetSettings: () => invoke(IPC.SETTINGS_RESET),

  // 工具库收口(2026-08-20)：仅保留 listExtensions / exportExtension 两条。
  // 原 listTools/setToolEnabled/getToolConfig/saveToolConfig/reloadTools/installTool/trustTool
  //   绑定已删（主进程 handler 同步删除）。

  // JD
  listJds: (): Promise<JD[]> => invoke(IPC.JD_LIST),
  saveJd: (jd: JD): Promise<JD> => invoke(IPC.JD_SAVE, jd),
  deleteJd: (id: string) => invoke(IPC.JD_DELETE, id),
  setActiveJd: (id: string) => invoke(IPC.JD_SET_ACTIVE, id),
  getActiveJd: (): Promise<JD | null> => invoke(IPC.JD_GET_ACTIVE),

  // RPA
  // ★ 必须传 platform：不传时主进程按 'boss' 兜底。
  //   pauseRpa/resumeRpa/stopRpa/clearRpaLogs 缺平台时，在猎聘 tab 操作会命中 BOSS 引擎；
  //   getRpaState 缺平台时，切到猎聘 tab 拿到的是 BOSS 的状态，直到 BOSS 引擎推事件才会更新。
  //   2026-08-11 P2-5 审查补全。
  getRpaState: (platform?: string): Promise<RPAState> => invoke(IPC.RPA_GET_STATE, platform),
  startRpa: (taskId: string, platform?: string) => invoke(IPC.RPA_START, taskId, platform),
  pauseRpa: (platform?: string) => invoke(IPC.RPA_PAUSE, platform),
  resumeRpa: (platform?: string) => invoke(IPC.RPA_RESUME, platform),
  stopRpa: (platform?: string) => invoke(IPC.RPA_STOP, platform),
  clearRpaLogs: (platform?: string) => invoke(IPC.RPA_CLEAR_LOGS, platform),
  // ★ 必须传 platform：不传时主进程按 'boss' 兜底，导致猎聘 tab 拿到的是 BOSS 的任务列表 ——
  //   进而"在猎聘 tab 编辑却改了 BOSS 任务"、"每次开始找人都偷偷新建一个看不见的猎聘任务"。
  listTasks: (platform?: string): Promise<RPATask[]> => invoke(IPC.RPA_TASKS_LIST, platform),
  saveTask: (task: RPATask): Promise<RPATask> => invoke(IPC.RPA_TASK_SAVE, task),
  deleteTask: (id: string) => invoke(IPC.RPA_TASK_DELETE, id),
  onRpaEvent: (cb: (state: RPAState) => void) => on(IPC.RPA_EVENT, cb),

  // Risk
  // ★ 与 listTasks 同理，这四个必须传 platform。主进程 safePlatform(undefined) 会兜底成 'boss'：
  //   · 猎聘被风控闩住时，UI 唯一的解除入口打不到猎聘 → 猎聘永久砖化；
  //   · 反向更危险——在猎聘页点「我已处理，解除停机」，清掉的是 BOSS 的异常闩和熔断，
  //     若 BOSS 引擎正处于 paused，还会直接把它恢复运行。一个刚被平台判过的会话就这么被放出去了。
  //   2026-08-07 审查发现。
  getRiskState: (platform?: string): Promise<RiskState> => invoke(IPC.RISK_GET_STATE, platform),
  onRiskEvent: (cb: (state: RiskState) => void) => on(IPC.RISK_EVENT, cb),
  getRiskHistory: (platform?: string): Promise<{
    daily: { date: string; count: number }[];
    events: { id: number; time: number; date: string; level: string; reason: string }[];
  }> => invoke(IPC.RISK_HISTORY, platform),
  // 2026-08-07 P1-8: 返回扩展类型，包含熔断状态和剩余冷却毫秒
  clearRisk: (platform?: string): Promise<RiskState & { circuitOpen?: boolean; circuitState?: string; cooldownRemainingMs?: number }> => invoke(IPC.RISK_CLEAR, platform),

  // 数据加密状态（如实暴露降级，杜绝以为加密了其实没有）
  getEncryptionStatus: (): Promise<{ mode: 'off' | 'on' | 'degraded'; reason: string; available: boolean; encryptedFields: Record<string, string[]> }> =>
    invoke(IPC.DATA_ENCRYPTION_STATUS),
  resetEncryptionKey: (): Promise<{ ok: boolean; reason?: string }> => invoke(IPC.DATA_RESET_ENCRYPTION_KEY),

  // 浏览器扩展（不走平台注入）—— 工具库收口后仅保留 listExtensions / exportExtension 两条
  listExtensions: (): Promise<{
    baseDir: string | null;
    items: { dirName: string; dir: string; name: string; version: string; description: string; matches: string[] }[];
    bridge: {
      running: boolean; port: number; extensionId: string; lastPolledAt: number;
      extensionSeen: boolean; activeJdName: string | null;
      bossOpen: boolean; bossCards: number; lastBossAliveAt: number;
      extVersion: string | null;
    };
  }> => invoke(IPC.TOOLS_EXTENSIONS),
  // 导出扩展安装包 zip。canceled=true 表示用户在保存框里取消了，不是失败。
  exportExtension: (dirName: string): Promise<{ ok: boolean; reason?: string; canceled?: boolean; file?: string }> =>
    invoke(IPC.TOOLS_EXTENSION_EXPORT, dirName),

  // Dashboard
  getDashboard: (): Promise<DashboardStats> => invoke(IPC.DASHBOARD_STATS),

  // CDP
  // ★ 全部支持 platform（缺省 boss，老调用方行为不变）。
  //   此前整条 CDP 通道是 BOSS 专用，猎聘浏览器在界面上根本打不开。
  getCdpStatus: (platform?: string): Promise<{ connected: boolean; open: boolean }> => invoke(IPC.CDP_STATUS, platform),
  launchBrowser: (opts?: any, platform?: string) => invoke(IPC.CDP_LAUNCH, opts, platform),
  connectBrowser: (endpoint?: string, platform?: string) => invoke(IPC.CDP_CONNECT_EXISTING, endpoint, platform),
  smartConnect: (platform?: string): Promise<{ mode: 'already' | 'existing' | 'launched' }> => invoke(IPC.CDP_SMART_CONNECT, platform),
  openBrowserForLogin: (platform?: string): Promise<{ launched: boolean; alreadyOpen: boolean; focused: boolean; url?: string }> =>
    invoke(IPC.CDP_OPEN_FOR_LOGIN, platform),
  closeBrowser: (platform?: string) => invoke(IPC.CDP_CLOSE, platform),
  onCdpStatus: (cb: (s: { connected: boolean; open: boolean }) => void) => on('cdp-status', cb),

  // Match
  testMatch: (profile: any, jd: JD, tier?: 'card' | 'detail') => invoke(IPC.MATCH_TEST, profile, jd, tier),

  // 岗位收件箱（G2：飞书快照工具推送）
  listJrInbox: (state?: string): Promise<JrInboxItem[]> => invoke(IPC.JR_INBOX_LIST, state),
  importJrInbox: (ids: number[]): Promise<number> => invoke(IPC.JR_INBOX_IMPORT, ids),
  dismissJrInbox: (ids: number[]): Promise<number> => invoke(IPC.JR_INBOX_DISMISS, ids),
  onJrInbox: (cb: (info: { added: number }) => void) => on(IPC.JR_INBOX_EVENT, cb),

  // 人才库（G3）
  // H2(阶段1):listCandidates / candidateStats 必须传 platform（后端按平台过滤，缺省 boss）
  listCandidates: (args?: { jdId?: string | null; viewed?: boolean; limit?: number; platform?: string }): Promise<TalentCandidate[]> =>
    invoke(IPC.CANDIDATES_LIST, args),
  markCandidateViewed: (id: number, viewed: boolean): Promise<boolean> =>
    invoke(IPC.CANDIDATES_MARK_VIEWED, id, viewed),
  candidateStats: (platform?: string): Promise<Record<string, { total: number; unviewed: number }>> =>
    invoke(IPC.CANDIDATES_STATS, platform),
  openExternal: (url: string): Promise<boolean> => invoke(IPC.OPEN_EXTERNAL, url),
  openBossGeek: (encryptGeekId: string): Promise<{ ok: boolean; reason?: string }> =>
    invoke(IPC.CANDIDATE_OPEN_BOSS, encryptGeekId),
  // 双平台
  platformList: (): Promise<{ id: string; name: string }[]> => invoke(IPC.PLATFORM_LIST),
  openCandidateSource: (candidateId: number): Promise<{ ok: boolean; reason?: string }> =>
    invoke(IPC.CANDIDATES_OPEN_SOURCE, candidateId),

  // 猎聘人才池子页（长久保存 + 一人多岗多评分 + 标签）
  liepinTalents: (q: any): Promise<{ rows: any[]; total: number }> => invoke(IPC.LIEPIN_TALENTS_LIST, q),
  liepinTalentStats: (): Promise<any> => invoke(IPC.LIEPIN_TALENTS_STATS),
  liepinTalentTags: (): Promise<Array<{ tag: string; n: number; source: string }>> => invoke(IPC.LIEPIN_TALENTS_TAGS),
  liepinTalentScores: (resId: string): Promise<any[]> => invoke(IPC.LIEPIN_TALENT_SCORES, resId),
  liepinTalentExpiring: (): Promise<any[]> => invoke(IPC.LIEPIN_TALENT_EXPIRING),
  liepinTagAdd: (resId: string, tag: string): Promise<boolean> => invoke(IPC.LIEPIN_TALENT_TAG_ADD, resId, tag),
  liepinTagRemove: (resId: string, tag: string): Promise<boolean> => invoke(IPC.LIEPIN_TALENT_TAG_REMOVE, resId, tag),
  liepinTalentArchive: (resIds: string[], archived: boolean): Promise<number> =>
    invoke(IPC.LIEPIN_TALENT_ARCHIVE, resIds, archived),
  liepinTalentDelete: (resIds: string[]): Promise<number> => invoke(IPC.LIEPIN_TALENT_DELETE, resIds),
  /** ★ 打开简历详情会消耗一份套餐额度，调用前必须已向用户明示 */
  liepinTalentOpen: (resId: string): Promise<{ ok: boolean; reason?: string }> =>
    invoke(IPC.LIEPIN_TALENT_OPEN, resId),

  // 运行日志（只读观测 + 导出诊断包）
  oplogRecent: (limit?: number): Promise<any[]> => invoke(IPC.OPLOG_RECENT, limit),
  oplogSummary: (days?: number): Promise<any[]> => invoke(IPC.OPLOG_SUMMARY, days),
  oplogExport: (days?: number): Promise<{ ok: boolean; file?: string; reason?: string }> =>
    invoke(IPC.OPLOG_EXPORT, days),
  oplogOpenDir: (): Promise<boolean> => invoke(IPC.OPLOG_OPEN_DIR),
  // D5/D8(2026-08-05)：日志健康状态（自证在工作）
  oplogHealth: (): Promise<{ enabled: boolean; dir: string; todayBytes: number; lastWriteAt: number; disabledReason?: string }> =>
    invoke(IPC.OPLOG_HEALTH),
  /** 界面行为上报。失败静默——日志绝不能让界面报错 */
  oplogUi: (action: string, detail?: Record<string, any>): void => {
    try { void invoke(IPC.OPLOG_UI, action, detail); } catch { /* ignore */ }
  },

  // Data
  // H2(阶段1):exportCsv 按 platform 过滤导出（后端 WHERE platform=?，缺省 boss）。
  // 仍接受老的 date 字符串用法（向后兼容），也接受对象形态 { date, startDate, endDate, mode, platform }。
  exportCsv: (args?: string | { date?: string; startDate?: string; endDate?: string; mode?: string; platform?: string }) =>
    invoke(IPC.DATA_EXPORT_CSV, args),
  clearAllData: () => invoke(IPC.DATA_CLEAR_ALL),
  openDataFolder: () => invoke(IPC.DATA_OPEN_FOLDER),
  backupData: () => invoke(IPC.DATA_BACKUP),
  restoreData: () => invoke(IPC.DATA_RESTORE),
  importData: () => invoke('data:import'),

  // 托盘/系统事件（白名单）
  onTrayAction: (cb: (action: string) => void) => on('tray-action', cb),
  // 主进程 IPC 失败的统一留痕（store 里只 console.warn，不打扰用户）
  onIpcError: (cb: (info: { channel: string; message: string }) => void) => on('ipc-error', cb),
};

contextBridge.exposeInMainWorld('api', api);

export type TAAPIType = typeof api;
