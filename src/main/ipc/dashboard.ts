// Dashboard handlers
import { BrowserWindow } from 'electron';
import { handle } from './wrap';
import { IPC } from '../../shared/types';
import { getDb, getDaily, getLiepinTalentStats } from '../db';
import { getRuntime } from '../services/runtime-registry';

export function registerDashboardHandlers(winGetter: () => BrowserWindow | null) {
  handle(IPC.DASHBOARD_STATS, () => {
    const daily = getDaily(undefined, 'boss');
    const trend: { date: string; viewed: number; greeted: number; riskScore: number }[] = [];
    const pad = (n: number) => String(n).padStart(2, '0');
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      // 修复：用【本地】日期键，与入库(bumpDaily/getDaily 的本地 dateKey)一致；
      // 原先用 UTC(toISOString) 在 00:00-08:00(东八区)会与"今日"差一天取到 0。
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      // 双平台化后 daily_stats 主键是 (date, platform)，这里取 boss 视角（兼容旧仪表盘；后续按平台分面再改）
      const row = getDb().prepare('SELECT * FROM daily_stats WHERE date = ? AND platform = ?').get(key, 'boss') as any;
      trend.push({
        date: key.slice(5),
        viewed: row?.viewed || 0,
        greeted: row?.greeted || 0,
        riskScore: row?.risk_events || 0,
      });
    }
    const activeJdRow = getDb().prepare('SELECT data FROM jds WHERE active = 1 LIMIT 1').get() as any;
    const activeJd = activeJdRow ? JSON.parse(activeJdRow.data) : null;
    const state = getRuntime('boss').engine.getState();
    return {
      today: {
        viewed: daily.viewed,
        greeted: daily.greeted,
        favorited: daily.favorited,
        highMatch: daily.high_match,
        midMatch: daily.mid_match,
        lowMatch: daily.low_match,
      },
      weekTrend: trend,
      risk: getRuntime('boss').riskMonitor.getState(),
      activeJD: activeJd,
      rpa: {
        isRunning: state.status === 'running',
        lastRunDuration: state.elapsedMs,
      },
      // ── 猎聘分面（与 BOSS 并排展示，数据完全独立）──
      // 注意 today.viewed 是"看过多少张卡"，会把重复浏览也算进去；
      // 净新增（人才池今日首次入库人数）才是真实产量，两个都给，别让看板撒谎。
      liepin: (() => {
        const d = getDaily(undefined, 'liepin');
        const st = getRuntime('liepin').engine.getState();
        const lt = getLiepinTalentStats();
        const trendLp: { date: string; viewed: number; pages: number }[] = [];
        for (let i = 6; i >= 0; i--) {
          const dd = new Date();
          dd.setDate(dd.getDate() - i);
          const k = `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`;
          const row = getDb().prepare('SELECT * FROM daily_stats WHERE date = ? AND platform = ?').get(k, 'liepin') as any;
          trendLp.push({ date: k.slice(5), viewed: row?.viewed || 0, pages: row?.pages || 0 });
        }
        return {
          today: {
            viewed: d.viewed,               // 今日看过的卡片数
            pages: (d as any).pages || 0,   // 今日翻页数
            searches: (d as any).searches || 0,
            details: (d as any).details || 0,
            highMatch: d.high_match,
          },
          talents: lt,                      // 人才池：在库 / 今日净新增 / 已归档 / 待清理
          weekTrend: trendLp,
          risk: getRuntime('liepin').riskMonitor.getState(),
          rpa: { isRunning: st.status === 'running', lastRunDuration: st.elapsedMs },
        };
      })(),
    };
  });
}
