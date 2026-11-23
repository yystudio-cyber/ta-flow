// 运行日志的读取面（只读 + 导出）。
// ★ 这里【只有读】和【导出】，没有任何会改变平台行为的通道 ——
//   日志的定位是旁路观测，不是控制面。
import { shell } from 'electron';
import { handle } from './wrap';
import { IPC } from '../../shared/types';
import { recentEntries, summarize, exportBundle, getOplogDir, getOplogHealth, oplog, hashId } from '../services/oplog';
import { getDb } from '../db';

// PII 脱敏：rpa_logs.message 已由 DB 层解密，导出前必须过一遍脱敏
const PII_RE = /(姓名|name|手机|phone|邮箱|email|简历|resume|电话|tel)[：:=]\s*\S+/gi;
function sanitizeMessage(msg: string): string {
  if (!msg) return '';
  return String(msg).slice(0, 500).replace(PII_RE, '$1：***');
}

function buildDbSections(days: number): Array<{ name: string; content: string }> {
  const sections: Array<{ name: string; content: string }> = [];
  try {
    const db = getDb() as any;
    const cutoff = Date.now() - days * 86400000;

    // rpa_logs
    const logs = db.prepare(
      `SELECT time, platform, kind, message FROM rpa_logs WHERE time >= ? ORDER BY time DESC LIMIT 2000`
    ).all(cutoff) as any[];
    if (logs.length > 0) {
      const lines = logs.map((r: any) =>
        JSON.stringify({ time: r.time, platform: r.platform, kind: r.kind, message: sanitizeMessage(r.message || '') })
      ).join('\n');
      sections.push({ name: `rpa_logs (${logs.length} 条)`, content: lines });
    }

    // risk_history
    const risks = db.prepare(
      `SELECT time, date, platform, level, reason FROM risk_history WHERE time >= ? ORDER BY time DESC LIMIT 500`
    ).all(cutoff) as any[];
    if (risks.length > 0) {
      const lines = risks.map((r: any) =>
        JSON.stringify({ time: r.time, date: r.date, platform: r.platform, level: r.level, reason: r.reason })
      ).join('\n');
      sections.push({ name: `risk_history (${risks.length} 条)`, content: lines });
    }

    // daily_stats
    const stats = db.prepare(
      `SELECT date, platform, viewed, favorited, greeted, high_match, mid_match, low_match, pages, searches, details, risk_events FROM daily_stats WHERE date >= ? ORDER BY date DESC, platform LIMIT 200`
    ).all(new Date(cutoff).toISOString().slice(0, 10)) as any[];
    if (stats.length > 0) {
      sections.push({
        name: `daily_stats (${stats.length} 行)`,
        content: stats.map((r: any) => JSON.stringify(r)).join('\n'),
      });
    }
  } catch { /* DB 读取失败不影响日志导出 */ }
  return sections;
}

export function registerOplogHandlers() {
  handle(IPC.OPLOG_RECENT, (_e, limit?: number) => recentEntries(Number(limit) || 300));
  handle(IPC.OPLOG_SUMMARY, (_e, days?: number) => summarize(Number(days) || 3));
  handle(IPC.OPLOG_EXPORT, (_e, days?: number) => {
    const d = Number(days) || 7;
    return exportBundle(d, buildDbSections(d));
  });
  handle(IPC.OPLOG_OPEN_DIR, () => {
    const d = getOplogDir();
    if (!d) return false;
    shell.openPath(d).catch(() => {});
    return true;
  });
  // A4: 日志健康状态
  handle(IPC.OPLOG_HEALTH, () => getOplogHealth());

  /**
   * 渲染层行为上报（页面切换 / 关键按钮点击）。
   * 为什么需要：主进程侧只看得到 IPC 调用，看不到"用户点了什么但什么都没发生"——
   * 而那恰恰是体验问题最典型的形态（按钮点了没反应、找不到入口、点错地方）。
   * 载荷严格限长且不含任何输入内容，只记动作名。
   */
  handle(IPC.OPLOG_UI, (_e, action: string, detail?: Record<string, any>) => {
    oplog('ui', String(action || '').slice(0, 64), detail);
    return true;
  });
}
