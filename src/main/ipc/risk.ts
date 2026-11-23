// Risk handlers —— 双平台化
// 所有 handler 接受 platform 参数并路由到对应平台的 riskMonitor/engine，
// 修复「猎聘命中验证码 → 永久砖化」的致命缺陷。
import { BrowserWindow, dialog, Notification } from 'electron';
import { handle } from './wrap';
import { IPC, PlatformId } from '../../shared/types';
import { PLATFORMS } from '../../shared/types';
import { getRuntime } from '../services/runtime-registry';
import { getSetting, getDb } from '../db';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { AppSettings } from '../../shared/types';
import { oplog } from '../services/oplog';

function safePlatform(p: any): PlatformId {
  return (PLATFORMS as readonly string[]).includes(p) ? (p as PlatformId) : 'boss';
}

export function registerRiskHandlers(winGetter: () => BrowserWindow | null) {
  handle(IPC.RISK_GET_STATE, (_e, platform?: PlatformId) =>
    getRuntime(safePlatform(platform)).riskMonitor.getState(),
  );

  // M-11: 获取近 7 天风险事件趋势 + 最近 20 条风险事件
  handle(IPC.RISK_HISTORY, (_e, platform?: PlatformId) => {
    const p = safePlatform(platform);
    const db = getDb() as any;
    const daily = db.prepare(
      `SELECT date, risk_events as count FROM daily_stats WHERE platform = ? ORDER BY date DESC LIMIT 7`
    ).all(p) as { date: string; count: number }[];
    daily.reverse();
    const events = db.prepare(
      `SELECT id, time, date, level, reason FROM risk_history WHERE platform = ? ORDER BY id DESC LIMIT 20`
    ).all(p) as { id: number; time: number; date: string; level: string; reason: string }[];
    return { daily, events };
  });

  // 人工确认「我已处理」：解除 pageAnomaly/accountRestricted 闩 + 冷却 + 控制器熔断。
  // 2026-08-07 P1-8: 返回实际清除范围，让 UI 能给出准确提示。
  // 原来无条件提示「已解除，可以继续开跑」，但 paused 分支不清熔断，引擎还在等冷却，
  // 用户会反复点；且两个分支语义不一致（engine 已确认暂停 vs monitor 直接 clearAll）。
  handle(IPC.RISK_CLEAR, (_e, platform?: PlatformId) => {
    const p = safePlatform(platform);
    const rt = getRuntime(p);
    if (rt.engine.getState().status === 'paused') {
      rt.engine.acknowledgeDangerAndContinue();
    } else {
      rt.riskMonitor.clearAll('用户在风险中心点击「我已处理，解除停机」');
    }
    const state = rt.riskMonitor.getState();
    const ctrl = rt.riskController.snapshot();
    const cooldownRemainingMs = state.cooldown ? Math.max(0, state.cooldown.until - Date.now()) : 0;
    return {
      ...state,
      // 告知 UI：熔断是否仍开（open/halfOpen），以及剩余冷却毫秒
      circuitOpen: ctrl.circuit === 'open' || ctrl.circuit === 'halfOpen',
      circuitState: ctrl.circuit,
      cooldownRemainingMs,
    };
  });
}

function getAutoPauseSetting(): boolean {
  return true;
}

export function attachRiskEvents(winGetter: () => BrowserWindow | null) {
  // B1: 遍历所有平台，各自订阅独立的 riskMonitor 实例
  for (const p of PLATFORMS) {
    let prevLevel: string = 'safe';
    let dialogOpen = false;

    getRuntime(p).riskMonitor.on('change', async (state) => {
      const w = winGetter();
      if (w && !w.isDestroyed()) {
        // 渲染层按 tab 过滤 platform
        w.webContents.send(IPC.RISK_EVENT, { ...state, platform: p });
        // ★ 必须记原因【文本】而不是条数。原来只记 reasons?.length，日志里看到的是
        //   「level:danger, reasons:2」——知道出事了却不知道为什么，等于没记。
        //   2026-08-05 排查猎聘启动即 danger 时，只能回头去翻 risk_history 表才找到
        //   真正原因（「今日打招呼数已达 0，超过上限 0」）。风险原因是本地生成的固定文案，
        //   不含候选人信息，可以安全落盘。
        oplog('risk', 'push:risk-event', {
          level: state.level,
          reasons: (state.reasons || []).slice(0, 6).map((r) => String(r).slice(0, 120)),
        }, { platform: p });
      }

      if (state.level === 'danger' && prevLevel !== 'danger' && !dialogOpen) {
        dialogOpen = true;
        try {
        const autoPause = getAutoPauseSetting();
        let doPause = true;
        let doContinue = false;

        if (w && !w.isDestroyed()) {
          if (w.isMinimized()) w.restore();
          if (!w.isVisible()) w.show();
          w.focus();
          const st = getRuntime(p).engine.getState().status;
          const engineLive = (st === 'running' || st === 'paused') && !getRuntime(p).engine.isStopping();
          const resp = await dialog.showMessageBox(w, {
            type: 'warning',
            title: '⚠️ 风险提醒',
            message: engineLive
              ? `当前风险等级：高风险\n\n${state.reasons[0] || ''}`
              : `当前风险等级：高风险，找人已停止\n\n${state.reasons[0] || ''}`,
            detail: engineLive
              ? (state.suggestions[0] || '')
              : `${state.suggestions[0] || ''}\n\n本次运行已因该信号停止。请先在浏览器里手动确认账号无异常`
                + '（完成验证 / 正常浏览几页），再到「风险中心」点「我已处理，解除停机」才能重新开始。',
            buttons: engineLive
              ? (autoPause ? ['我知道了，暂停RPA', '继续使用，我知道风险'] : ['暂停 RPA', '继续使用（不暂停）'])
              : ['知道了'],
            defaultId: 0,
            cancelId: engineLive ? (autoPause ? 0 : 1) : 0,
            noLink: true,
          });
          doPause = engineLive && resp.response === 0;
          doContinue = engineLive && resp.response === 1;
        } else {
          doPause = true;
          doContinue = false;
          try {
            if (Notification.isSupported()) {
              const n = new Notification({
                title: '⚠️ 账号高风险 · RPA 已暂停',
                body: `${state.reasons[0] || '检测到高风险信号'}\n已自动暂停自动化操作，请打开应用确认是否继续。`,
                urgency: 'critical',
              });
              n.on('click', () => {
                const ww = winGetter();
                if (ww && !ww.isDestroyed()) {
                  ww.show();
                  ww.focus();
                }
              });
              n.show();
            }
          } catch {}
        }

        if (doPause && getRuntime(p).engine.getState().status === 'running') {
          getRuntime(p).engine.pause();
        }
        if (doContinue) {
          getRuntime(p).engine.acknowledgeDangerAndContinue();
        }
        } finally {
          dialogOpen = false;
        }
      }
      prevLevel = state.level;
    });

    // M-18: 冷却到期提示
    getRuntime(p).riskMonitor.on('cooldownExpired', async () => {
      if (getRuntime(p).engine.getState().status !== 'paused') return;
      const w = winGetter();
      if (!(w && !w.isDestroyed())) {
        try {
          if (Notification.isSupported()) {
            new Notification({
              title: '风险冷却已结束',
              body: 'RPA 仍处于暂停状态，请打开应用确认是否恢复。',
            }).show();
          }
        } catch {}
        return;
      }
      if (w.isMinimized()) w.restore();
      if (!w.isVisible()) w.show();
      w.focus();
      const resp = await dialog.showMessageBox(w, {
        type: 'question',
        title: '风险冷却已结束',
        message: '风险冷却已结束，是否恢复 RPA 自动化？',
        detail: '恢复前请留意账号状态；若不确定，可保持暂停稍后手动恢复。',
        buttons: ['恢复 RPA', '保持暂停'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (resp.response === 0 && getRuntime(p).engine.getState().status === 'paused') {
        getRuntime(p).engine.resume();
      }
    });
  }
}
