// 风险指数（Composite Risk Index）—— 0~100 的单一数字，回答"现在这个账号被平台处置的暴露程度有多高"。
//
// ── 为什么这么算 ──────────────────────────────────────────────────────────
// 用的是风险管理里成熟的 **Composite Risk Index** 骨架（EUROCONTROL CRI / S&P Risk Exposure
// Assessment 都是同一套）：
//     指数 = Σ( 维度暴露度(0~100) × 维度权重 ) / Σ权重
//     维度暴露度 = 可能性(likelihood) × 严重度(severity)
// 不自创玄学公式，只把"维度选取"和"严重度定级"落到 BOSS-RPA风险调查.md 的一手实测结论上。
//
// ── 维度怎么来的（逐条对应登记册）──────────────────────────────────────────
//  D1 平台施压信号 35%  ← §4.5「早停信号清单」。这是唯一直接证明"平台已经在处置你"的证据，
//                        故权重最高。硬信号(验证码/verify页/Boss端100xx/code:35)严重度远高于软信号。
//  D2 请求频率     15%  ← §4.5「BOSS 的主判据是频率+路径模式+会话指纹连续性」。
//                        列表级浏览零请求，真正发请求的是下滑加载，故用 loadMore/5min 作代理。
//  D3 用量负荷     15%  ← §2「保守用量」。今日浏览/招呼/收藏相对档位上限的占比，招呼是外呼动作故加权。
//  D4 会话与环境   15%  ← §4.5 软信号：__a/isOHPC 指纹 Cookie、骨架屏卡死、安全 JS、操作失败率、
//                        连续空数据(隐形降权前兆)。
//  D5 时段与时长   10%  ← §4.5 阈值表「单次≤90min、每45min长休、夜间禁跑」。
//  D6 账号历史     10%  ← §2「隐形降权最阴险，恢复需 7-14 天」。近 7 天 danger 事件 + 跨天高匹配率骤降。
//
// ── 分档（对齐登记册 §8「顺信号退」的响应哲学）──────────────────────────────
//   0–24  稳健：按当前节奏继续
//  25–49  留意：可以继续，但别再加量
//  50–74  收敛：主动降量/提前收工，别硬顶
//  75–100 撤退：停跑，转人工操作/走官方申诉
//
// 指数必须可解释：每个维度都输出自己的贡献值与一句话说明，UI 展示 Top 主因。
// 一个不能说明"为什么高"的分数就是玩具。
import { getDb } from '../db';
import type { PlatformId, RiskState, RiskIndexResult, RiskIndexDimension } from '../../shared/types';

const MIN = 60 * 1000;

// 维度权重（合计 100）
const W = { signals: 35, frequency: 15, volume: 15, session: 15, timing: 10, history: 10 };

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// 指数 → 分档
export function bandOf(index: number): RiskIndexResult['band'] {
  if (index >= 75) return 'retreat';
  if (index >= 50) return 'converge';
  if (index >= 25) return 'watch';
  return 'steady';
}

export const BAND_META: Record<RiskIndexResult['band'], { label: string; action: string }> = {
  steady:   { label: '稳健', action: '按当前节奏继续' },
  watch:    { label: '留意', action: '可以继续，但不要再加量' },
  converge: { label: '收敛', action: '主动降量或提前收工，别硬顶' },
  retreat:  { label: '撤退', action: '停跑，转人工操作；必要时走官方申诉' },
};

// ── D1 平台施压信号：按严重度加权 + 按时间衰减 ──────────────────────────────
// 硬信号(需人工/入口层) 严重度 100，退避类 65，软信号 30。半衰期 2 小时——
// 平台的处置是有记忆的，但 2 小时前的一次滑块显然不该和刚刚出现的等价。
const HARD_RE = /验证码|极验|易盾|verify|验证页|登录态|Security|自动化|环境异常|IP地址存在异常|code:?35|apiCode35|captcha|bossSecReport|loginLost/i;
const BACKOFF_RE = /403|429|空数据|emptyData|限流|降权/i;

function signalExposure(platform: PlatformId): { score: number; note: string; count: number } {
  let score = 0;
  let hard = 0;
  let soft = 0;
  try {
    const since = Date.now() - 6 * 60 * MIN; // 只看近 6 小时
    // 必须带 platform 谓词：两平台 risk_history 行独立，否则 boss 看到猎聘的硬信号/反之
    const rows = getDb()
      .prepare('SELECT time, level, reason FROM risk_history WHERE platform = ? AND time >= ? ORDER BY time DESC LIMIT 200')
      .all(platform, since) as { time: number; level: string; reason: string }[];
    const now = Date.now();
    for (const r of rows) {
      const ageH = (now - r.time) / (60 * MIN);
      const decay = Math.pow(0.5, ageH / 2); // 半衰期 2 小时
      let sev = 30;
      if (r.level === 'danger' || HARD_RE.test(r.reason || '')) { sev = 100; hard++; }
      else if (BACKOFF_RE.test(r.reason || '')) { sev = 65; }
      else soft++;
      score += sev * decay;
    }
  } catch { /* 读不到历史按 0 处理 */ }
  // 一次硬信号(100)就应该把这一维顶到很高；多次累加但收敛到 100
  const exposure = clamp100(100 * (1 - Math.exp(-score / 90)));
  const note = hard
    ? `近 6 小时有 ${hard} 次硬信号（验证码/验证页/入口层异常）`
    : soft
      ? `近 6 小时有 ${soft} 次软信号（降速/环境提示）`
      : '近 6 小时无平台施压信号';
  return { score: exposure, note, count: hard + soft };
}

// ── D2 请求频率：下滑加载次数/窗口，相对黄线 ──────────────────────────────
function frequencyExposure(s: RiskState): { score: number; note: string } {
  const t = s.thresholds;
  const yellow = t?.loadFreqOps || 5;
  const n = s.metrics.lastWindowLoads || 0;
  // 正常 1~2 次/5min；到黄线即 70 分，到红线(2×黄线)即 100
  const score = clamp100((n / (yellow * 2)) * 100);
  return { score, note: `近 ${(t?.freqWindowSec || 300) / 60} 分钟下滑加载 ${n} 次（黄线 ${yellow}）` };
}

// ── D3 用量负荷：今日各项相对档位上限 ────────────────────────────────────
// 2026-08-07 审查项 P1-1: 原分母恒为 4（三维权重之和），导致猎聘（greet=0, fav=0）
// 浏览跑满时 D3 只有 25 分（browse×1 / 4），volume 地板（at:100→floor 45）永不触发。
// 修复：分母只统计上限 > 0 的维度权重之和；上限为 0 的维度整维退出计算。
// 同时修复：「今日用量最高项」的选取跳过上限为 0 的维度（否则会显示「招呼 0/0」）。
function volumeExposure(s: RiskState, limits: { greet: number; browse: number; favorite: number }): { score: number; note: string } {
  const m = s.metrics;
  const pct = (used: number, cap: number) => Math.min(1.2, used / cap);
  // 权重定义：招呼是外呼动作，同样的占比风险更高，故权重加倍
  const DIMS: Array<{ name: string; used: number; cap: number; weight: number; label: string }> = [
    { name: 'greet',   used: m.greetCountToday,    cap: limits.greet,    weight: 2, label: `招呼 ${m.greetCountToday}/${limits.greet}` },
    { name: 'browse',  used: m.browseCountToday,   cap: limits.browse,   weight: 1, label: `浏览 ${m.browseCountToday}/${limits.browse}` },
    { name: 'favorite',used: m.favoriteCountToday, cap: limits.favorite, weight: 1, label: `收藏 ${m.favoriteCountToday}/${limits.favorite}` },
  ];
  // 只纳入上限 > 0 的维度
  const activeDims = DIMS.filter((d) => d.cap > 0);
  if (activeDims.length === 0) return { score: 0, note: '今日无可计量的用量配额' };
  const totalW = activeDims.reduce((a, d) => a + d.weight, 0);
  const weighted = activeDims.reduce((a, d) => a + pct(d.used, d.cap) * d.weight, 0) / totalW;
  const score = clamp100(weighted * 100);
  // 最高项选取：在活跃维度中按用量百分比排最大
  const top = activeDims.reduce((best, d) => pct(d.used, d.cap) >= pct(best.used, best.cap) ? d : best);
  return { score, note: `今日用量最高项：${top.label}` };
}

// ── D4 会话与环境健康 ───────────────────────────────────────────────────
function sessionExposure(s: RiskState): { score: number; note: string } {
  const m = s.metrics;
  let score = 0;
  const reasons: string[] = [];
  if (m.pageAnomaly) { score += 60; reasons.push('存在未解除的风控停机'); }
  if (m.accountRestricted) { score += 40; reasons.push('账号功能疑似受限'); }
  if (m.consecutiveEmptyPages >= 2) { score += 20 * m.consecutiveEmptyPages; reasons.push(`连续 ${m.consecutiveEmptyPages} 屏空数据`); }
  if (m.recentOpTotal >= 8) {
    const fail = m.recentOpFails / m.recentOpTotal;
    if (fail >= 0.35) { score += fail * 60; reasons.push(`操作失败率 ${Math.round(fail * 100)}%`); }
  }
  const ctrl = s.controller;
  if (ctrl?.circuit === 'open') { score += 35; reasons.push('熔断冷却中'); }
  else if (ctrl?.circuit === 'halfOpen') { score += 15; reasons.push('半开试探中'); }
  return { score: clamp100(score), note: reasons.length ? reasons.join('；') : '会话与环境正常' };
}

// ── D5 时段与单次时长 ───────────────────────────────────────────────────
function timingExposure(s: RiskState, nightStart: number, nightEnd: number): { score: number; note: string } {
  const hr = new Date().getHours();
  const inNight = nightStart > nightEnd ? (hr >= nightStart || hr < nightEnd) : (hr >= nightStart && hr < nightEnd);
  // 距禁跑时段还有几小时：越近风险越高（跨入即被硬闸停机，提前收敛更体面）
  let toNight = nightStart - hr;
  if (toNight < 0) toNight += 24;
  const proximity = inNight ? 1 : toNight <= 2 ? 0.5 : toNight <= 4 ? 0.25 : 0;
  const mins = s.controller?.sessionMinutes || 0;
  const duration = Math.min(1, mins / 90); // 单次 90min 为满
  const score = clamp100((proximity * 0.5 + duration * 0.5) * 100);
  const note = inNight
    ? `当前处于禁跑时段（${nightStart}:00–${nightEnd}:00）`
    : `本次已连续运行 ${mins} 分钟（上限 90）${toNight <= 2 ? `，距禁跑时段还有 ${toNight} 小时` : ''}`;
  return { score, note };
}

// ── D6 账号历史：近 7 天 danger 次数 + 隐形降权嫌疑 ────────────────────────
function historyExposure(s: RiskState, platform: PlatformId): { score: number; note: string } {
  let dangerDays = 0;
  let total = 0;
  try {
    // 必须带 platform 谓词：两平台 daily_stats 行独立
    const rows = getDb()
      .prepare('SELECT risk_events FROM daily_stats WHERE platform = ? ORDER BY date DESC LIMIT 7')
      .all(platform) as { risk_events: number }[];
    for (const r of rows) { if ((r.risk_events || 0) > 0) dangerDays++; total += r.risk_events || 0; }
  } catch { /* ignore */ }
  let score = Math.min(70, total * 12);
  const reasons: string[] = [];
  if (total) reasons.push(`近 7 天 ${dangerDays} 天出现过高风险事件（共 ${total} 次）`);
  if (s.controller?.health?.shadowSuspected) {
    score += 40;
    reasons.push('跨天高匹配率骤降，疑似隐形降权');
  }
  return { score: clamp100(score), note: reasons.length ? reasons.join('；') : '近 7 天无高风险事件' };
}

/** 计算当前风险指数。纯读，不产生任何副作用。 */
export function computeRiskIndex(
  s: RiskState,
  limits: { greet: number; browse: number; favorite: number },
  platform: PlatformId = 'boss',
): RiskIndexResult {
  const nightStart = s.thresholds?.nightStartHour ?? 22;
  const nightEnd = s.thresholds?.nightEndHour ?? 7;

  const d1 = signalExposure(platform);
  const d2 = frequencyExposure(s);
  const d3 = volumeExposure(s, limits);
  const d4 = sessionExposure(s);
  const d5 = timingExposure(s, nightStart, nightEnd);
  const d6 = historyExposure(s, platform);

  const dims: RiskIndexDimension[] = [
    { key: 'signals',   label: '平台施压信号', weight: W.signals,   exposure: d1.score, note: d1.note },
    { key: 'frequency', label: '请求频率',     weight: W.frequency, exposure: d2.score, note: d2.note },
    { key: 'volume',    label: '用量负荷',     weight: W.volume,    exposure: d3.score, note: d3.note },
    { key: 'session',   label: '会话与环境',   weight: W.session,   exposure: d4.score, note: d4.note },
    { key: 'timing',    label: '时段与时长',   weight: W.timing,    exposure: d5.score, note: d5.note },
    { key: 'history',   label: '账号历史',     weight: W.history,   exposure: d6.score, note: d6.note },
  ];

  const totalW = dims.reduce((a, d) => a + d.weight, 0) || 1;
  const weighted = clamp100(dims.reduce((a, d) => a + d.exposure * d.weight, 0) / totalW);

  // ── 分指数地板（sub-index floor）────────────────────────────────────────
  // 纯加权平均有个经典缺陷：单一维度爆表会被其它维度稀释。实测场景验证过——
  // "翻屏过快撞请求频率红线"按加权平均只有 23 分、显示「稳健」，这是危险的误导。
  // 空气质量指数 AQI 的解法是取各分指数的【最大值】而非平均。这里用混合：
  // 加权和体现"多点中等风险的叠加"，地板保证"任一关键维度爆表时总分不被稀释"。
  const FLOORS: { key: RiskIndexDimension['key']; at: number; floor: number }[] = [
    { key: 'signals', at: 70, floor: 70 },    // 平台已经在处置你，不允许显示"稳健"
    { key: 'session', at: 70, floor: 60 },    // 熔断/失败率高/连续空数据
    { key: 'frequency', at: 80, floor: 55 },  // 翻屏过快 = 直接撞限流的行为
    { key: 'history', at: 80, floor: 55 },    // 隐形降权，登记册称"最阴险，恢复需 7-14 天"
    { key: 'volume', at: 100, floor: 45 },    // 到顶属优雅停机，不算危险
    { key: 'timing', at: 100, floor: 40 },
  ];
  let index = weighted;
  for (const f of FLOORS) {
    const d = dims.find((x) => x.key === f.key);
    if (d && d.exposure >= f.at) index = Math.max(index, f.floor);
  }

  // 硬闸兜底：存在未解除的人工确认闩时，指数不得低于"撤退"档——
  // 这类状态下"分数不高"会给人错误的安全感。
  if (s.metrics.pageAnomaly || s.metrics.accountRestricted) index = Math.max(index, 75);
  index = clamp100(index);

  // 贡献度 = 暴露度 × 权重 / 总权重，用于给出主因排序
  const withContrib = dims
    .map((d) => ({ ...d, contribution: Math.round((d.exposure * d.weight) / totalW) }))
    .sort((a, b) => b.contribution - a.contribution);

  const band = bandOf(index);
  return {
    index,
    band,
    bandLabel: BAND_META[band].label,
    action: BAND_META[band].action,
    dimensions: withContrib,
    topDrivers: withContrib.filter((d) => d.contribution > 0).slice(0, 3).map((d) => `${d.label}：${d.note}`),
    computedAt: Date.now(),
  };
}
