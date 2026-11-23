// 飞书需求汇总 —— 每日定时任务
//
// 默认 11:00 本地时间触发，实现为每 60 秒比对本地时钟（不用长 setTimeout，
// 因为机器休眠 / 合盖会让长计时器推迟甚至永不触发）。
//
// 配置（app-settings.reqSheet.scheduler）：
//   enabled        — 是否启用定时任务
//   time           — "HH:MM" 触发时间（默认 "11:00"）
//   catchUpOnStart — 启动时若今天还没跑就补跑一次（默认 true）
//   maxPerRun      — 单次最多处理多少条新需求（默认 50）
import { getSetting } from '../db';
import { oplog } from './oplog';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';

type TriggerCallback = (opts: { scheduled: boolean; maxPerRun: number }) => Promise<void>;

interface SchedulerConfig {
  enabled: boolean;
  time: string;        // "HH:MM"
  catchUpOnStart: boolean;
  maxPerRun: number;
}

const DEFAULT_SCHED: SchedulerConfig = {
  enabled: true,
  time: '11:00',
  catchUpOnStart: true,
  maxPerRun: 50,
};

let tickInterval: NodeJS.Timeout | null = null;
let running = false;
let lastRunDate = '';   // "YYYY-MM-DD"，持久化在 settings 里
let onTrigger: TriggerCallback | null = null;

function getConfig(): SchedulerConfig {
  try {
    const s = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
    const cfg = (s as any).reqSheet?.scheduler as Partial<SchedulerConfig> | undefined;
    return { ...DEFAULT_SCHED, ...cfg };
  } catch {
    return { ...DEFAULT_SCHED };
  }
}

function todayKey(): string {
  const d = new Date();
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

function loadLastRunDate(): string {
  try {
    const s = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
    return (s as any).reqSheet?.lastRunDate as string ?? '';
  } catch { return ''; }
}

function saveLastRunDate(d: string): void {
  try {
    // 用 merge-style 写（不能破坏其他设置）
    const { setSetting, getSetting: gs } = require('../db');
    const s = gs('app-settings', DEFAULT_SETTINGS) as any;
    s.reqSheet = s.reqSheet || {};
    s.reqSheet.lastRunDate = d;
    setSetting('app-settings', s);
  } catch { /* ignore */ }
}

function parseTime(hhmm: string): { h: number; m: number } {
  const parts = (hhmm || '11:00').split(':');
  return { h: parseInt(parts[0] ?? '11', 10), m: parseInt(parts[1] ?? '0', 10) };
}

async function doRun(scheduled: boolean): Promise<void> {
  if (running) {
    oplog('reqsheet', 'scheduler-reentry-blocked', { scheduled });
    return;
  }
  running = true;
  const today = todayKey();
  try {
    const cfg = getConfig();
    oplog('reqsheet', 'scheduler-trigger', { scheduled, today });
    if (onTrigger) {
      await onTrigger({ scheduled, maxPerRun: cfg.maxPerRun });
    }
    lastRunDate = today;
    saveLastRunDate(today);
    oplog('reqsheet', 'scheduler-done', { scheduled, today });
  } catch (e: any) {
    oplog('reqsheet', 'scheduler-error', { reason: e?.message || String(e) }, { ok: false });
  } finally {
    running = false;
  }
}

export function dateKey(d: Date): string {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/**
 * 今天该不该跑 —— 唯一判据，定时 tick 与启动补跑共用。
 *
 * ⚠️ 判据是「已过点 且 今天还没跑」，**不是**「此刻正好是 11:00 这一分钟」。
 * 精确到分钟的判法看着更"准"，实际有两个必炸的场景：
 *   · 笔记本 11:00 在睡眠、11:07 醒来而 app 一直开着 —— tick 永远等不到
 *     分钟数等于 0 的那一刻，这一天就【静默不跑】了；
 *   · setInterval(60s) 会漂移，某次 10:59:59.6、下次 11:01:00.2，
 *     整个 11:00 分钟被跨过去，同样整天不跑。
 * 改成单调判据后，过点之后任何一次 tick 都能补上，跨日由 lastRunDate 挡重复。
 */
export function shouldRunNow(now: Date, lastRun: string, timeHHmm: string): boolean {
  if (lastRun === dateKey(now)) return false;      // 今天已跑
  const { h, m } = parseTime(timeHHmm);
  return (now.getHours() * 60 + now.getMinutes()) >= (h * 60 + m);
}

/**
 * 启动定时器。
 * @param triggerFn 每次触发时调用的回调（主进程传入，负责打开 Chrome + 拉起扩展流程）
 * @param nowMs 注入当前时间（测试用）
 */
export function startScheduler(triggerFn: TriggerCallback, nowMs?: () => number): void {
  if (tickInterval) return;
  onTrigger = triggerFn;
  lastRunDate = loadLastRunDate();

  const getNow = nowMs ?? (() => Date.now());

  // 用可注入时钟的 tick（测试时覆盖 getNow）
  const schedulerTick = () => {
    const cfg = getConfig();
    if (!cfg.enabled) return;
    const d = new Date(getNow());
    if (!shouldRunNow(d, lastRunDate, cfg.time)) return;
    doRun(true);
  };

  tickInterval = setInterval(schedulerTick, 60_000);
  if (typeof tickInterval.unref === 'function') tickInterval.unref();

  // catchUpOnStart：启动时如果今天该跑还没跑，立刻补一次。
  // 判据与 tick 完全相同（shouldRunNow），差别只在这次是「补跑」不是「定时」。
  const cfg = getConfig();
  if (cfg.catchUpOnStart && cfg.enabled) {
    const d = new Date(getNow());
    if (shouldRunNow(d, lastRunDate, cfg.time)) {
      oplog('reqsheet', 'scheduler-catchup', { today: dateKey(d) });
      doRun(false);
    }
  }
}

export function stopScheduler(): void {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  onTrigger = null;
}

export function getSchedulerStatus(): {
  enabled: boolean;
  time: string;
  lastRunDate: string;
  running: boolean;
} {
  const cfg = getConfig();
  return { enabled: cfg.enabled, time: cfg.time, lastRunDate, running };
}

/** 手动触发（平台 UI「立即运行」按钮用） */
export function triggerManual(): void {
  doRun(false);
}

/**
 * 测试用：将内部时钟注入点和状态暴露出来，供 scheduler-lab.mjs 注入假时钟。
 * 生产代码不应依赖此函数。
 */
export function _testExports() {
  return {
    setLastRunDate: (d: string) => { lastRunDate = d; },
    getLastRunDate: () => lastRunDate,
    isRunning: () => running,
  };
}
