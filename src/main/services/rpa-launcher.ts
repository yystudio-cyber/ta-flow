// S3: 统一 RPA 启动编排 —— 手动(IPC) / 定时(Scheduler) / 空闲(Idle) 三条路径共用同一入口，
// 杜绝各自复制"取 task + 取 active JD + 载入风险状态 + 启动"逻辑导致的双路径漂移。
import { getDb } from '../db';
import type { RPATask, JD, TriggerMode, PlatformId } from '../../shared/types';
import { getRuntime } from './runtime-registry';
import { withLearnedProfile } from './behavior-learner';
import { getDefaultLimits, buildSearchFromJd } from '../../shared/utils';
import { normalizeSpeedMode } from '../../shared/constants';
import fs from 'node:fs';
import path from 'node:path';
import { getMonitor } from './skeleton-monitor';

// 运行锁：从 ipc/rpa.ts 的模块局部上移到此，使非 IPC 触发（定时/空闲）也共享同一把锁，
// 防止多路径并发启动。
// ★ 必须【按平台】各一把：原来是全局单锁，BOSS 正在启动时猎聘会被挡在门外报
//   "RPA 正在启动，请稍候"，而两个平台本就设计为可并行运行。
const launching = new Map<PlatformId, boolean>();

// 自动触发（定时/空闲）的两道节流阈值。手动触发一律不受约束——用户明确要跑就跑。
// 45 分钟对齐登记册「每 45 分钟强制长休」：两轮自动运行之间至少隔这么久，
// 宏观休息才真的存在，而不是被"跑完 15 秒又起一轮"抹平。
const AUTO_MIN_GAP_MS = 45 * 60 * 1000;
// 环境类拒绝（窗口不可见等）后的重试退避：这类状态通常要人来处理，短周期重试没有意义。
const REFUSAL_BACKOFF_MS = 10 * 60 * 1000;
// 自动触发的上次结束时间同样按平台记，否则 BOSS 跑完会连带压制猎聘的自动触发
const lastAutoRunEndedAt = new Map<PlatformId, number>();

// ── 桌面 app 猎聘监控：run-app-*.log 全过程留痕 + run-summary.json ──────────────
// 为什么只给 liepin 接：猎聘真机跑时承鹏不在场（境外 IP 拦截/VPN 悖论，见 memory
// [[vpn-paradox-console-sampler]]），跑完只能靠落盘日志离线诊断。BOSS 一直是承鹏
// 在场看着跑，没有这个痛点；给 BOSS 接反而会串台（两平台 console.warn 同进程）。
// 引擎 this.log() 只写内存 state.logs + DB，不走 stdout——所以必须主动轮询 state.logs
// 追写文件，否则诊断码/骨架行只会留在 DB 里、真机一关全凭 DB 才能翻。
const MAX_LOG_LINE = 600;        // 普通行放宽到 600 字；诊断码/骨架是 console.warn 直出全量
const LOG_POLL_INTERVAL = 1500;  // 与 rpa-dryrun 轮询节奏一致
interface AppRunLogger {
  file: string;
  seen: number;              // 已刷写的 state.logs 游标
  timer: NodeJS.Timeout | null;
  monitor: ReturnType<typeof getMonitor>;
}

/** 项目根下 logs 目录（与 skeleton-monitor 同目录，自动建）。 */
function appLogsDir(): string {
  let dir = process.cwd();
  try {
    // 与 skeleton-monitor.ts 的 findProjectRoot 一致：向上找 package.json
    let cur = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(cur, 'package.json'))) { dir = cur; break; }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch { /* 兜底 cwd */ }
  const dir2 = path.join(dir, 'logs');
  try { fs.mkdirSync(dir2, { recursive: true }); } catch { /* ignore */ }
  return dir2;
}

/** ISO 时间戳（文件名安全）：2026-08-18T10-30-05-123Z */
function appIsoStamp(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}Z`;
}

/** 桌面 app 跑 liepin 时启动全过程日志轮询 + 诊断码统计。仅在 ensureRunning 之前调。 */
function startAppRunLogging(platform: PlatformId): AppRunLogger {
  const file = path.join(appLogsDir(), `run-app-${appIsoStamp()}.log`);
  // 写一行到 run-app 日志（同步追加，避免事件循环与 RPA 主循环争抢导致丢行）。
  const writeLine = (line: string) => {
    try { fs.appendFileSync(file, line + '\n', 'utf8'); } catch { /* 监控绝不影响主流程 */ }
  };
  writeLine(`═══ RPA run-app log start | platform=${platform} | startedAt=${Date.now()} ═══`);
  const monitor = getMonitor(platform);
  monitor.start();  // 钩 console.warn 统计诊断码/风控事件（幂等）
  writeLine('[监控] SkeletonMonitor 已启动，console.warn 诊断码/风控事件开始计入 run-summary');

  const rt = getRuntime(platform);
  const logger: AppRunLogger = { file, seen: 0, timer: null, monitor };
  const tick = () => {
    try {
      let st: any;
      try { st = rt.engine.getState(); } catch { logger.timer = setTimeout(tick, LOG_POLL_INTERVAL); return; }
      const logs: any[] = st.logs || [];
      for (let i = logger.seen; i < logs.length; i++) {
        const l = logs[i] || {};
        const msg = String(l.message || '');
        const lv = String(l.level || '');
        // 诊断码/骨架行不截断（诊断信息是真机离线揪问题的唯一依据）；
        // 其余行放宽到 600 字，避免极端长行撑爆日志但仍保留足够上下文。
        const clipped = msg.length > MAX_LOG_LINE && !/CITY_OVERLAY_|FILTER_FAILED|GO_NEXT_PAGE|\[diagnostic\]|skeleton-/.test(msg)
          ? msg.slice(0, MAX_LOG_LINE) + '…(截断)'
          : msg;
        writeLine(`  [${lv}] ${clipped}`);
      }
      logger.seen = logs.length;
      // 注：searches/viewed/pages/rowsWritten 的统计喂入统一在 stopAppRunLogging 收尾时
      //   做（viewed/pages 取 getState().stats 累计值，rows 取落库行数）。轮询期间不喂，
      //   避免与收尾重复累加（recordViewed/recordPage 是增量加，非 set）。
    } catch { /* 监控绝不影响主流程 */ }
    logger.timer = setTimeout(tick, LOG_POLL_INTERVAL);
    if (logger.timer.unref) logger.timer.unref();
  };
  logger.timer = setTimeout(tick, LOG_POLL_INTERVAL);
  if (logger.timer.unref) logger.timer.unref();
  return logger;
}

/** 停止全过程日志轮询并落 run-summary.json。ensureRunning 之后必有一一对应的 end。 */
function stopAppRunLogging(logger: AppRunLogger | null, platform: PlatformId, rowsWritten: number): void {
  if (!logger) return;
  if (logger.timer) { clearTimeout(logger.timer); logger.timer = null; }
  // 收尾统计字段（下面 try 里从引擎 state 读到则覆盖，读不到时落 0）。
  // 放在外面声明：end() 要用，且 try 内 getState 抛错时仍要有一个可用值。
  let newTalents = 0;
  let skippedAlreadySeen = 0;
  // 停前最后一刷：把 state.logs 尾部残留行冲进文件，避免最后几秒日志丢失。
  try {
    const st = getRuntime(platform).engine.getState();
    const logs: any[] = st.logs || [];
    for (let i = logger.seen; i < logs.length; i++) {
      const l = logs[i] || {};
      const msg = String(l.message || '');
      const lv = String(l.level || '');
      const clipped = msg.length > MAX_LOG_LINE && !/CITY_OVERLAY_|FILTER_FAILED|GO_NEXT_PAGE|\[diagnostic\]|skeleton-/.test(msg)
        ? msg.slice(0, MAX_LOG_LINE) + '…(截断)'
        : msg;
      try { fs.appendFileSync(logger.file, `  [${lv}] ${clipped}\n`, 'utf8'); } catch { /* ignore */ }
    }
    logger.seen = logs.length;
    // 统计收口：viewed/pages 全量累计、rowsWritten 从落库计数取。
    const stats = (st.stats || {}) as { viewed?: number; pagesBrowsed?: number; newTalents?: number; skippedAlreadySeen?: number };
    if (stats.viewed) logger.monitor.recordViewed(stats.viewed);
    if (stats.pagesBrowsed) logger.monitor.recordPage(stats.pagesBrowsed);
    // ★ 2026-08-19 P2-b：去重后新增 / 命中已收录跳过 —— 引擎在 state.stats 上维护绝对值，
    //   收尾喂给 monitor 落 run-summary.json（此前 run-summary 只有 viewed，看不出净增量）。
    //   end() 用 Object.assign 覆盖，所以这里取到值后直接传给 end()，不走会被覆盖的 record。
    newTalents = stats.newTalents ?? 0;
    skippedAlreadySeen = stats.skippedAlreadySeen ?? 0;
  } catch { /* 监控绝不影响主流程 */ }
  logger.monitor.recordRows(rowsWritten);
  const sumFile = logger.monitor.end({ rowsWritten, newTalents, skippedAlreadySeen });
  try { fs.appendFileSync(logger.file, `═══ RPA run-app log end | run-summary=${sumFile} ═══\n`, 'utf8'); } catch { /* ignore */ }
}

export function loadTaskById(taskId: string): RPATask | null {
  try {
    const row = getDb().prepare('SELECT data FROM rpa_tasks WHERE id = ?').get(taskId) as any;
    if (!row) return null;
    return JSON.parse(row.data) as RPATask;
  } catch {
    return null;
  }
}

export function loadActiveJd(): JD | null {
  try {
    const row = getDb().prepare('SELECT data FROM jds WHERE active = 1 LIMIT 1').get() as any;
    if (!row) return null;
    return JSON.parse(row.data) as JD;
  } catch {
    return null;
  }
}

export interface StartOutcome {
  ok: boolean;
  result?: string; // 引擎 ensureRunning 结果：started / already-running / resumed / rejected
  reason?: string; // 失败原因
}

/**
 * 统一启动：加载任务 + 当前激活 JD + 载入风险状态 → 幂等 ensureRunning。
 * trigger 标记本次由何触发（manual/schedule/idle），引擎据此记录 RPAState.trigger。
 * 幂等：已运行→already-running；因空闲暂停→resumed；未运行→started。绝不产生并发运行。
 */
export async function startTaskById(
  taskId: string,
  trigger: TriggerMode = 'manual',
  platform: PlatformId = 'boss',
): Promise<StartOutcome> {
  if (launching.get(platform)) return { ok: false, reason: '该平台的 RPA 正在启动，请稍候' };
  launching.set(platform, true);
  // 桌面 app 监控 logger 声明在 try 外，使 finally 兜底可见（异常路径也要收尾，不留孤儿轮询）。
  let appLogger: AppRunLogger | null = null;
  try {
    // 夜间绝对禁跑（硬闸，手动也不放行）——登记册「小量、低频、白天」+ 用户明确要求。
    if (getRuntime(platform).riskMonitor.isNightNow()) {
      return {
        ok: false,
        reason: `当前处于禁跑时段（${getRuntime(platform).riskMonitor.nightWindowLabel()}），自动化已被禁止启动，请白天再跑`,
      };
    }
    // 上次因风控硬停留下的异常闩（验证码/账号受限/疑似降权）必须人工确认才能再跑。
    // 关键修复：原先没有这道门，启动会"成功"但主循环第一圈就被 riskDanger 静默暂停，
    // 且因风险等级未跳变而不弹决策框 → 表现为点了没反应、且无任何解除入口。
    if (getRuntime(platform).riskMonitor.hasBlockingAnomaly()) {
      const st = getRuntime(platform).riskMonitor.getState();
      return {
        ok: false,
        reason: `上次运行因风控停机尚未解除：${st.reasons[0] || '检测到风控信号'}。请先人工确认账号无异常（浏览器里手动完成验证/正常浏览几页），再到「风险中心」点击「我已处理，解除停机」。`,
      };
    }
    // 精密防范模型：冷却窗口内禁止「调度/空闲」自动重启（顺信号退，不自动硬顶平台）。
    // 手动触发放行——用户明确知情可覆盖，但会在引擎侧记录冷却剩余以提示谨慎。
    if (trigger !== 'manual') {
      // 取 风控冷却 与 控制器熔断 的较大者作为门控（两者都是"该退避"的信号）
      const cd = Math.max(getRuntime(platform).riskMonitor.getCooldownRemainingMs(), getRuntime(platform).riskController.cooldownRemainingMs());
      if (cd > 0) {
        const info = getRuntime(platform).riskMonitor.getCooldown();
        return { ok: false, reason: `风控冷却/熔断中（剩余约 ${Math.ceil(cd / 60000)} 分钟）：${info?.reason || '退避中'}，暂不自动重启` };
      }
    }
    const task = loadTaskById(taskId);
    if (!task) return { ok: false, reason: '任务不存在' };
    // 每日浏览上限也要在【启动层】拦。
    // 引擎内部虽然也判，但 ensureRunning 是 fire-and-forget、立刻返回 ok:true，
    // 前端已经弹了绿色"开始找人"，引擎随后才在日志里默默拒绝——
    // 用户看到的是"点了成功、然后什么也没发生"。放到这里才能如实回执。
    try {
      const mode = normalizeSpeedMode(task.speed?.mode as any);
      // C2: 必须带 platform 参数，否则猎聘会拿到 BOSS 的 240 上限
      const limit = getDefaultLimits(mode, platform as any).browse;
      const used = getRuntime(platform).riskMonitor.getTodayCounts().browse;
      if (used >= limit) {
        return { ok: false, reason: `今日浏览已达上限（${used}/${limit}），为控制风险今天不再启动，请明天再跑` };
      }
    } catch { /* 取不到计数不阻断启动 */ }
    // ── 自动触发（定时/空闲）专属的两道节流 ─────────────────────────────
    // 审查 2026-07-29：IdleService 每 15 秒 tick 一次，且【不记忆上一次的结果】——
    // 既不记失败，也不记成功。两个后果都很重：
    //   · 成功跑完 → 15 秒后立刻再起一轮。而每轮 getRuntime(platform).riskController.reset() 都会把
    //     sessionStart / lastBigRestAt 归零，于是「每 45 分钟强制长休 5-10 分钟」
    //     这条反风控最核心的宏观节奏【永远不会触发】，同时反复消耗当日配额；
    //   · 启动失败（如窗口被遮挡）→ 每 15 秒重试一次，每次都发系统通知 + 写风险历史，
    //     用户离开一小时回来面对 240 条本地噪声，真信号被埋。
    if (trigger !== 'manual') {
      const lastEnd = lastAutoRunEndedAt.get(platform) || 0;
      const gap = Date.now() - lastEnd;
      if (lastEnd && gap < AUTO_MIN_GAP_MS) {
        return {
          ok: false,
          reason: `距上次自动运行结束不足 ${Math.round(AUTO_MIN_GAP_MS / 60000)} 分钟`
            + `（还需 ${Math.ceil((AUTO_MIN_GAP_MS - gap) / 60000)} 分钟），为保住宏观休息节奏暂不重开`,
        };
      }
      const refusal = getRuntime(platform).engine.getLastStartRefusal();
      if (refusal && Date.now() - refusal.at < REFUSAL_BACKOFF_MS) {
        return {
          ok: false,
          reason: `上次启动因「${refusal.reason}」被拒，${Math.round(REFUSAL_BACKOFF_MS / 60000)} 分钟内不重试`,
        };
      }
    }

    // S6: human 档注入本平台学习到的节奏（P1-6: 传 platform，不再混用 boss 的学习结果）
    task.speed = withLearnedProfile(task.speed, platform);
    const jd = loadActiveJd();
    // ★ 搜索条件来源改为【激活 JD 派生】，使「搜的岗位 = 评的岗位」，根治「搜 A 评 B」。
    //   原先读 task.search 作搜索、另取 jd 作评分 = 两套来源；现统一用 JD 派生 SearchConfig
    //   覆盖 task.search，buildQueries 仍按现有逻辑吃这份条件（逻辑未改）。
    //   无激活 JD 不静默搜错人：明确报错、不启动引擎。
    //   BOSS 走推荐流、搜索条件本就不生效（现有真相），覆盖 task.search 对其无害，评分仍用 jd。
    if (!jd) {
      return { ok: false, reason: '请先在岗位库激活一个岗位再开始找人（无激活岗位时不会启动，避免搜错人）' };
    }
    task.search = buildSearchFromJd(jd);
    getRuntime(platform).riskMonitor.loadFromDb();

    // ── 桌面 app 监控（仅 liepin）：在 ensureRunning 之前起 run-app-*.log 轮询 + 诊断码统计。
    //   只在「真的要起引擎」这一刻起，already-running/resumed 时不重复起（见下方处置）。
    //   appLogger 已在 try 外声明（finally 兜底要用）。
    if (platform === 'liepin') appLogger = startAppRunLogging(platform);

    const result = await getRuntime(platform).engine.ensureRunning(task, jd, trigger);

    // already-running/resumed：引擎本就在跑（或本在暂停被恢复），本轮没有"新启动"，
    // 不挂新的 run-app 日志/monitor——否则会与既有运行的多份轮询重叠串台。立即收尾本次 logger。
    if (appLogger && result !== 'started') {
      stopAppRunLogging(appLogger, platform, 0);
      appLogger = null;
    }

    // 记下"这一轮自动运行何时结束"，供上面的最小间隔门使用（手动运行不参与节流）
    if (result === 'started' && trigger !== 'manual') {
      getRuntime(platform).engine.whenStopped().then(() => { lastAutoRunEndedAt.set(platform, Date.now()); }).catch(() => { /* 忽略 */ });
    }
    // 桌面 app 监控收尾：ensureRunning 真正 started 时，挂 whenStopped 落 run-summary.json
    // （含 rowsWritten：从本轮落库计数取——猎聘表行数，取不到就传 0 但别崩）。
    // start 过就一定有对应 end，异常路径也 end，避免 run-summary 不落盘。
    if (appLogger) {
      const lg = appLogger;
      getRuntime(platform).engine.whenStopped().then(() => {
        let rowsWritten = 0;
        try {
          rowsWritten = (getDb().prepare('SELECT COUNT(*) c FROM liepin_talents').get() as any).c;
        } catch { /* 取不到不崩，传 0 */ }
        stopAppRunLogging(lg, platform, rowsWritten);
      }).catch(() => { stopAppRunLogging(lg, platform, 0); });
      appLogger = null;
    }
    return { ok: true, result };
  } finally {
    // 兜底：若上面因异常未把 logger 交接给 whenStopped 回调，这里立即收尾，绝不留孤儿轮询。
    if (appLogger) { stopAppRunLogging(appLogger, platform, 0); }
    launching.set(platform, false);
  }
}
