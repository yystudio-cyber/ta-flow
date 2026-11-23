// S5: RPA 自动启动方式 —— 定时启动(Scheduler) + 离开启动/空闲检测(Idle)
// 方案 4.1.6：手动 / 定时(每天固定时间) / 离开(空闲 N 分钟自动启动，操作回来自动暂停)。
// 二者都只通过 startTaskById(幂等 ensureRunning) 与引擎的 pauseByIdle/resumeByIdle 驱动，
// 不直接碰 start/pause，杜绝在现状上贴调度层产生的竞态（见第四次审查评估 E3）。
import { powerMonitor } from 'electron';
import { getDb, getSetting } from '../db';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { RPATask, AppSettings } from '../../shared/types';
import { startTaskById } from './rpa-launcher';
import { getRuntime } from './runtime-registry';

function loadTasks(): RPATask[] {
  try {
    const rows = getDb().prepare('SELECT data FROM rpa_tasks').all() as any[];
    return rows.map((r) => JSON.parse(r.data) as RPATask).filter(Boolean);
  } catch {
    return [];
  }
}

function settings(): AppSettings {
  return getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
}

// ---- 极简 5 字段 cron 匹配（分 时 日 月 周），支持 * , - / ----
function matchField(spec: string, val: number, min: number, max: number): boolean {
  if (spec === '*') return true;
  for (const token of spec.split(',')) {
    if (token.includes('/')) {
      const [range, stepS] = token.split('/');
      const step = parseInt(stepS, 10) || 1;
      let lo = min;
      let hi = max;
      if (range && range !== '*') {
        const [a, b] = range.split('-').map((n) => parseInt(n, 10));
        lo = a;
        hi = isFinite(b) ? b : a;
      }
      for (let v = lo; v <= hi; v += step) if (v === val) return true;
    } else if (token.includes('-')) {
      const [a, b] = token.split('-').map((n) => parseInt(n, 10));
      if (val >= a && val <= b) return true;
    } else if (parseInt(token, 10) === val) {
      return true;
    }
  }
  return false;
}

export function cronMatch(cron: string, d: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [mi, ho, dom, mo, dow] = parts;
  return (
    matchField(mi, d.getMinutes(), 0, 59) &&
    matchField(ho, d.getHours(), 0, 23) &&
    matchField(dom, d.getDate(), 1, 31) &&
    matchField(mo, d.getMonth() + 1, 1, 12) &&
    matchField(dow, d.getDay(), 0, 6)
  );
}

// ============ 定时启动 ============
class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private firedKeys = new Set<string>(); // taskId@yyyy-mm-dd-hh-mm，防同一分钟内重复触发

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 30_000);
    console.log('[automation] Scheduler 已启动（30s 轮询 cron）');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (!settings().rpa?.enableScheduler) return;
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    // 清理非本分钟的旧 key，防止无限增长
    for (const k of this.firedKeys) if (!k.endsWith('@' + minuteKey)) this.firedKeys.delete(k);
    for (const task of loadTasks()) {
      if (task.schedule?.trigger !== 'schedule' || !task.schedule.cron) continue;
      if (!cronMatch(task.schedule.cron, now)) continue;
      const key = `${task.id}@${minuteKey}`;
      if (this.firedKeys.has(key)) continue;
      this.firedKeys.add(key);
      // B2: 从任务自身取 platform 路由
      const p = (task as any).platform || 'boss';
      const r = await startTaskById(task.id, 'schedule', p);
      console.log(`[automation] 定时启动任务 ${task.name}: ${r.ok ? r.result : r.reason}`);
    }
  }
}

// ============ 离开启动（空闲检测） ============
class IdleService {
  private timer: NodeJS.Timeout | null = null;

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 15_000);
    console.log('[automation] Idle 检测已启动（15s 轮询系统空闲）');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 选取用于空闲启动的任务：trigger==='idle' 的任务，取最近更新的一个
  private pickIdleTask(): RPATask | null {
    const list = loadTasks().filter((t) => t.schedule?.trigger === 'idle');
    if (!list.length) return null;
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list[0];
  }

  private async tick() {
    if (!settings().rpa?.enableIdleStart) return;
    const idleSec = powerMonitor.getSystemIdleTime();
    const task = this.pickIdleTask();
    if (!task) return;
    const p = (task as any).platform || 'boss';
    const thresholdSec = Math.max(1, (task.schedule.idleStartMinutes || 5)) * 60;
    const state = getRuntime(p).engine.getState();

    if (idleSec >= thresholdSec) {
      await startTaskById(task.id, 'idle', p);
    } else {
      if (
        task.schedule.idlePauseOnInput !== false &&
        state.status === 'running' &&
        state.trigger === 'idle'
      ) {
        getRuntime(p).engine.pauseByIdle();
      }
    }
  }
}

export const scheduler = new SchedulerService();
export const idleService = new IdleService();

export function startAutomation() {
  scheduler.start();
  idleService.start();
}

export function stopAutomation() {
  scheduler.stop();
  idleService.stop();
}
