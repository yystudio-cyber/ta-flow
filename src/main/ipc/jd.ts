// JD handlers
import { BrowserWindow } from 'electron';
import { handle } from './wrap';
import { IPC, JD } from '../../shared/types';
import { getDb } from '../db';
import { uid } from '../../shared/utils';
import { getRuntime } from '../services/runtime-registry';
import { PLATFORMS } from '../../shared/types';

// 2026-08-07 P1-15: 岗位库变更时使引擎的 JD 缓存失效
function invalidateJdCache() {
  for (const p of PLATFORMS) getRuntime(p).engine.invalidateJdCache?.();
}

export function registerJdHandlers(winGetter: () => BrowserWindow | null) {
  handle(IPC.JD_LIST, (): JD[] => {
    const rows = getDb()
      .prepare('SELECT * FROM jds ORDER BY active DESC, updated_at DESC')
      .all() as any[];
    // 修复激活状态双源不一致：以 DB 的 active 列为权威，覆盖 data blob 里可能陈旧的 active 字段。
    // 逐行容错（四线隔离 2026-07-29）：一条 data 写坏，jd-bridge/rpa-launcher 都只是跳过或降级，
    // 唯独这里整个 JD_LIST 抛错、岗位库整页报错——同一份脏数据三种表现。现在与桥同口径：跳过坏行。
    const list: JD[] = [];
    for (const r of rows) {
      try {
        list.push({ ...(JSON.parse(r.data) as JD), active: r.active === 1 });
      } catch {
        console.warn('[jd] 跳过损坏的 JD 记录：', r?.id);
      }
    }
    return list;
  });

  handle(IPC.JD_GET_ACTIVE, (): JD | null => {
    const row = getDb().prepare('SELECT data FROM jds WHERE active = 1 LIMIT 1').get() as any;
    try {
      return row ? ({ ...(JSON.parse(row.data) as JD), active: true }) : null;
    } catch {
      console.warn('[jd] 激活 JD 记录损坏，按无激活处理');
      return null;
    }
  });

  handle(IPC.JD_SET_ACTIVE, (_e, id: string) => {
    getDb().prepare('UPDATE jds SET active = 0').run();
    getDb().prepare('UPDATE jds SET active = 1 WHERE id = ?').run(id);
    invalidateJdCache();
    // H5/H10：JD 切换时推送到所有浏览器页面（isolated world，不写 localStorage）
    // M3(阶段1)：激活 JD 全局共享——一份 JD 库 BOSS/猎聘都用它找人评分，
    // 故切换激活 JD 时遍历所有平台 runtime 各自推送，不再只推 BOSS（否则猎聘浏览器插件评分永远停在旧 JD）。
    const row = getDb().prepare('SELECT data FROM jds WHERE id = ?').get(id) as any;
    const jd = row ? JSON.parse(row.data) : null;
    for (const p of PLATFORMS) getRuntime(p).chrome.pushActiveJdToAllPages(jd).catch(() => {});
    return true;
  });

  handle(IPC.JD_SAVE, (_e, jd: JD) => {
    if (!jd.id) jd.id = uid('jd');
    const now = Date.now();
    if (!jd.createdAt) jd.createdAt = now;
    jd.updatedAt = now;
    if (jd.active) getDb().prepare('UPDATE jds SET active = 0').run();
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO jds (id, name, data, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(jd.id, jd.name, JSON.stringify(jd), jd.active ? 1 : 0, jd.createdAt, jd.updatedAt);
    invalidateJdCache();
    // 如果是活跃 JD，推送到浏览器
    // M3(阶段1)：JD 全局共享，活跃 JD 保存后两平台 runtime 各推一份（不再只推 BOSS）。
    if (jd.active) {
      for (const p of PLATFORMS) getRuntime(p).chrome.pushActiveJdToAllPages(jd).catch(() => {});
    }
    return jd;
  });

  handle(IPC.JD_DELETE, (_e, id: string) => {
    getDb().prepare('DELETE FROM jds WHERE id = ?').run(id);
    invalidateJdCache();
    return true;
  });
}
