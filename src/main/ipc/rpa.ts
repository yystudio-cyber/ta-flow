// RPA handlers
// 双平台化骨架：所有 handler 接受 platform 参数（缺省 'boss'，保持兼容），
// 运行时一律通过 getRuntime(platform) 路由，避免 getRuntime('boss') 写死。
import { BrowserWindow } from 'electron';
import { handle } from './wrap';
import { IPC, RPATask, PlatformId } from '../../shared/types';
import { PLATFORMS } from '../../shared/types';
import { getDb } from '../db';
import { getRuntime } from '../services/runtime-registry';
import { uid } from '../../shared/utils';
import { normalizeSpeedMode } from '../../shared/constants';
import { startTaskById } from '../services/rpa-launcher';
import { oplog } from '../services/oplog';

function safePlatform(p: any): PlatformId {
  return (PLATFORMS as readonly string[]).includes(p) ? (p as PlatformId) : 'boss';
}

export function registerRpaHandlers(winGetter: () => BrowserWindow | null) {
  handle(IPC.RPA_GET_STATE, (_e, platform?: PlatformId) =>
    getRuntime(safePlatform(platform)).engine.getState(),
  );

  handle(IPC.RPA_START, async (_e, taskId: string, platform?: PlatformId) => {
    // 任务自身携带 platform；调用方传的 platform 仅作兜底。
    const row = getDb().prepare('SELECT data FROM rpa_tasks WHERE id = ?').get(taskId) as any;
    let p = safePlatform(platform);
    if (row?.data) {
      try {
        const t = JSON.parse(row.data) as RPATask;
        p = safePlatform(t.platform);
      } catch { /* ignore */ }
    }
    // S3: 走统一启动服务（与定时/空闲同一路径，含运行锁 + 幂等 ensureRunning）。
    // ★ 2026-08-04 接线：原来这里对非 boss 平台直接 return 一条"尚未接线"，
    //   而且是 return 不是 throw —— 渲染层的 try/catch 永远不触发，用户只看到一句
    //   自己无法处理的提示，猎聘引擎做完了也够不着。launcher 已按平台改造，这里放行。
    const r = await startTaskById(taskId, 'manual', p);
    if (!r.ok) throw new Error(r.reason || 'RPA 启动失败');
    return true;
  });

  handle(IPC.RPA_PAUSE, (_e, platform?: PlatformId) => getRuntime(safePlatform(platform)).engine.pause());
  handle(IPC.RPA_RESUME, (_e, platform?: PlatformId) => getRuntime(safePlatform(platform)).engine.resume());
  handle(IPC.RPA_STOP, (_e, platform?: PlatformId) => getRuntime(safePlatform(platform)).engine.stop());

  handle(IPC.RPA_TASKS_LIST, (_e, platform?: PlatformId): RPATask[] => {
    const p = safePlatform(platform);
    const rows = getDb()
      .prepare('SELECT * FROM rpa_tasks WHERE platform = ? ORDER BY updated_at DESC')
      .all(p) as any[];
    return rows.map((r) => {
      const t = JSON.parse(r.data) as RPATask;
      // 兼容 DB 里旧任务的 mimic/faster/slower，归一化为 safe/human（否则 UI 不高亮、行为静默降级）
      if (t.speed) t.speed.mode = normalizeSpeedMode(t.speed.mode);
      return t;
    });
  });

  handle(IPC.RPA_TASK_SAVE, (_e, task: RPATask) => {
    const p = safePlatform(task.platform);
    if (!task.id) task.id = uid('task');
    task.platform = p;
    const now = Date.now();
    if (!task.createdAt) task.createdAt = now;
    task.updatedAt = now;
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO rpa_tasks (id, name, platform, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        task.id,
        task.name,
        p,
        JSON.stringify(task),
        task.createdAt,
        task.updatedAt,
      );
    return task;
  });

  handle(IPC.RPA_TASK_DELETE, (_e, id: string) => {
    getDb().prepare('DELETE FROM rpa_tasks WHERE id = ?').run(id);
    return true;
  });

  handle(IPC.RPA_CLEAR_LOGS, (_e, platform?: PlatformId) => {
    getRuntime(safePlatform(platform)).engine.clearLogs();
    return true;
  });
}

export function attachRpaEvents(winGetter: () => BrowserWindow | null) {
  // 两平台 RPA 状态事件都发到同一个 IPC.RPA_EVENT 通道，
  // 但事件载荷里加 platform 字段做区分；渲染层按当前 tab 过滤。
  for (const p of PLATFORMS) {
    getRuntime(p).engine.on('change', (state) => {
      const w = winGetter();
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC.RPA_EVENT, { ...state, platform: p });
        // A6: 记录推送（只记 status 与 platform，不记整个 state）
        oplog('rpa', 'push:rpa-event', { status: state.status, trigger: state.trigger }, { platform: p });
      }
    });
  }
}
