// RiskController —— 闭环自适应反风控控制器
//
// 把原先"信号→固定分级响应"的【开环、反应式】升级为【闭环、自适应 + 前瞻】控制系统。
// 四件套：
//   ① AIMD 自适应速率：平台顺畅 → 加性缓增(慢慢提量)；一见信号 → 乘性骤降(砍半)。
//      在"未知平台限额"下自动逼近安全上限（Netflix concurrency-limits / 阿里 Sentinel 同思路），
//      直接服务"最大化总量又不触风控"。速率(次/分钟)决定动作间隔基准，拟人抖动叠加其上。
//   ② 前瞻可疑度评分(0-100)：频率/会话时长/近期软信号密度/时段 加权。分数升高 → 在硬信号出现【之前】
//      主动降速/插长休（predictive avoidance），而不是等硬信号才退。
//   ③ 熔断 + 指数退避 + 半开恢复：退避类信号(code35/403/429/空数据) → 熔断(暂停+冷却)，
//      冷却随连续触发指数增长(cap 60min)；冷却后"半开"放几张探针卡低速试探，干净则合闸复速。
//   ④ 跨天健康基线：读 daily_stats 近 7 天"高匹配率"，今日骤降(量正常但产出崩) → 疑似隐形降权(shadow-ban)，
//      发通知 + 长冷却，提示改用真人操作数天恢复。
//
// 边界：本控制器只做"更聪明的礼貌退让/节奏管理"，不碰伪造指纹/破验证码/卡阈值等明确禁止项。
import { getDb, getSetting, setSetting } from '../db';
import { randRange, sleep } from '../../shared/utils';
import { DEFAULT_BEHAVIOR, normalizeSpeedMode } from '../../shared/constants';
import type { PlatformId, SpeedMode, DefenseSignalKind, RiskControllerSnapshot } from '../../shared/types';

// 2026-08-07 P1-5: 对数正态采样器 —— 真人停留时间是右偏分布，均匀分布可被统计检出。
// Box-Muller 变换 → 标准正态 → 转对数正态：保证 E[X]=mean, 众数 < mean（右拖尾）。
function sampleLogNormal(mean: number, std: number): number {
  // 从 mean/std 推导对数正态参数 mu/sigma
  const sigma2 = Math.log(1 + (std / mean) ** 2);
  const mu = Math.log(mean) - sigma2 / 2;
  // Box-Muller
  let u: number, v: number, s: number;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const z = u * Math.sqrt(-2 * Math.log(s) / s);
  return Math.exp(mu + Math.sqrt(sigma2) * z);
}

// 信号处置策略：human=需人工介入(引擎硬停+通知)；circuit=退避熔断(自动半开恢复)；soft=仅降速。
type SignalMode = 'human' | 'circuit' | 'soft';
interface SignalPolicy { mode: SignalMode; decrease: number; baseCooldownMs: number }

const MIN = 60 * 1000;
const SIGNAL_POLICY: Record<DefenseSignalKind, SignalPolicy> = {
  // 需人工（会话多半已废/需人操作）——引擎侧硬停+通知；控制器也长冷却兜底
  captchaGeetest:  { mode: 'human', decrease: 0.25, baseCooldownMs: 30 * MIN },
  captchaYidun:    { mode: 'human', decrease: 0.25, baseCooldownMs: 30 * MIN },
  captchaEscalate: { mode: 'human', decrease: 0.2,  baseCooldownMs: 60 * MIN },
  // 猎聘腾讯防水墙
  captchaTencent:  { mode: 'human', decrease: 0.25, baseCooldownMs: 30 * MIN },
  verifyRedirect:  { mode: 'human', decrease: 0.2,  baseCooldownMs: 60 * MIN },
  loginLost:       { mode: 'human', decrease: 0.3,  baseCooldownMs: 15 * MIN },
  bossSecReport:   { mode: 'human', decrease: 0.2,  baseCooldownMs: 30 * MIN },
  // 猎聘 security.min.js 36 项自动化检测静默上报（告警级，比账号封禁低）
  liepinSecReport: { mode: 'human', decrease: 0.2,  baseCooldownMs: 30 * MIN },
  // 页面明说账号被限制/冻结——登记册口径是立即停 + 走官方申诉，绝不自动重试
  accountRestricted: { mode: 'human', decrease: 0.2, baseCooldownMs: 60 * MIN },
  // 猎聘账号封禁/冻结/异地登录（72h~永久，必须人工硬停）
  accountBanned:   { mode: 'human', decrease: 0.15, baseCooldownMs: 12 * 60 * MIN },
  // 猎聘境外 IP 拦截（2026-08-04 真机命中 /secure/intercept-abroad-ip）。
  // 这是【出口 IP 级】拦截，不是等一会儿就好的——等多久都没用，要么换网络要么找客户经理。
  // 而且命中后猎聘会把浏览器进程直接关掉，会话必然丢失。故：人工硬停 + 超长冷却兜底。
  interceptAbroadIp: { mode: 'human', decrease: 0.15, baseCooldownMs: 6 * 60 * MIN },
  // 命中风控页但认不出类型：宁可保守按需人工处理，也不要误当成"极验滑块"自动退避
  riskPageUnknown:   { mode: 'human', decrease: 0.25, baseCooldownMs: 30 * MIN },
  // 退避熔断（无需人工，自动冷却+半开试探恢复）
  apiCode35:       { mode: 'circuit', decrease: 0.3, baseCooldownMs: 30 * MIN },
  // 猎聘阿里云 WAF acw_sc__v2/v3 挑战（入口层，同口径 code:35）
  wafChallenge:    { mode: 'circuit', decrease: 0.3, baseCooldownMs: 30 * MIN },
  http403:         { mode: 'circuit', decrease: 0.3, baseCooldownMs: 30 * MIN },
  http429:         { mode: 'circuit', decrease: 0.5, baseCooldownMs: 15 * MIN },
  emptyData:       { mode: 'circuit', decrease: 0.4, baseCooldownMs: 20 * MIN },
  // 猎聘列表请求长时间无响应（降速类）
  requestTimeout:  { mode: 'circuit', decrease: 0.4, baseCooldownMs: 10 * MIN },
  // 软信号（仅 AIMD 降速，不熔断）
  rateWarn:        { mode: 'soft', decrease: 0.55, baseCooldownMs: 0 },
  cookieMutation:  { mode: 'soft', decrease: 0.5,  baseCooldownMs: 0 },
  skeletonStuck:   { mode: 'soft', decrease: 0.7,  baseCooldownMs: 0 },
  securityJsFail:  { mode: 'soft', decrease: 0.85, baseCooldownMs: 0 },
};

// 每档速率带（次/分钟）与 AIMD 参数。★ 2026-08-20 P2：唯一 human 档，删 safe。
interface TierCfg { rateMin: number; rateMax: number; rateStart: number; additive: number; cleanWindow: number }
const TIER: Record<SpeedMode, TierCfg> = {
  // human：日常/午休，速率带更宽以最大化总量（顺畅时缓增至 ~6.5/min≈9s/人）
  human: { rateMin: 1.5, rateMax: 6.5, rateStart: 3.8, additive: 0.25, cleanWindow: 4 },
};

// candidate=看一张卡（列表级，零网络请求）；scroll=下滑/翻页（1 请求）；
// query=切关键词组合并提交搜索（1 请求）；detail=打开简历详情（1 请求 + 消耗套餐额度）
export type PaceKind = 'candidate' | 'scroll' | 'query' | 'detail';
export interface PacePlan {
  waitMs: number;                 // 本次动作前应等待的毫秒（拟人抖动 + 速率 + 前瞻/长休）
  circuitOpen: boolean;           // 熔断打开：应暂停等冷却（waitMs 即冷却剩余）
  reason?: string;                // 展示/日志用
  restKind?: 'big' | 'predictive' | 'batch' | 'pageBlock'; // 触发了哪类额外休息
}
// debounced=同类信号在去抖窗口内重复到达：已被吸收，调用方不得再写风险历史/刷日志/叠加冷却。
// escalated=入口层信号在同一次运行内再次触发，已由"自动退避"升级为"硬停+需人工确认"。
// notify=该信号应发系统通知（入口层信号即使自动退避也要让用户知情）。
export interface SignalResult {
  needHuman: boolean; tripped: boolean; cooldownMs: number; reason: string;
  debounced: boolean; escalated: boolean; notify: boolean;
}

// 入口层信号（IP/会话信誉级）口径（2026-07-27 决策，已同步登记册）：
//   首次 → 熔断退避 30min + 半开低速试探，但【发系统通知】让用户知情；
//   同一次运行内再次 → 升级为硬停 + 需人工确认（与验证码同级），不反复硬顶平台。
// 按平台分开维护。
// ⚠️ 猎聘的 403/429 必须进这张表。原实现把它们当普通 circuit：半开 3 次干净探针后
//    consecutiveTrips 完全复位 → 下次 403 又从 30min 起算 → 全天可以无限循环
//    「403 → 退避 → 再冲」，而且 notify=false 用户全程不知情。
//    这与调研 §0/§13 R4「见 403/429 立即停 + 走官方申诉」的口径直接冲突，是全仓
//    唯一一处对抗式实现。改为入口层语义：首次退避且通知，同次运行第 2 次即硬停。
const ENTRY_LAYER_KINDS_BY_PLATFORM: Record<PlatformId, DefenseSignalKind[]> = {
  boss: ['apiCode35'],
  liepin: ['wafChallenge', 'http403', 'http429'],
};

// 健康基线的 JD 归属标记：daily_stats 的 high_match 是按【当时激活的 JD】统计的，
// 换岗位后跨天基线不可比（换 JD 会让高匹配率天然骤降 → 误判隐形降权）。
// 故记录"当前基线对应哪个 JD、自哪天起"，JD 变更即重置起算日，未攒够天数不做判定。
interface HealthJdMarker { jdId: string; since: string }

export class RiskController {
  readonly platform: PlatformId;
  private entryLayerKinds: ReadonlySet<DefenseSignalKind>;
  private tier: SpeedMode = 'human';
  private cfg: TierCfg = TIER.human;
  private rate = TIER.human.rateStart;      // 当前速率 次/分钟
  private consecutiveClean = 0;
  private actionTimestamps: number[] = [];  // 近 40 次动作时刻（算频率/规律性）
  private softEwma = 0;                      // 软信号密度指数滑动均值
  private suspicion = 0;
  private sessionStart = 0;
  private lastBigRestAt = 0;
  private bigRestIntervalMs = 45 * MIN;
  private lastPredictiveRestAt = 0;
  private scannedSinceBatchRest = 0;
  // 猎聘档位一：每翻 N 页强制休息 3~8 分钟（调研 §10「连续翻页限制」）
  // ★ 2026-08-19 修复3：N 从固定 5 改为每区间现采 randInt(3,8)——休息落点不再机械「每5页整」，
  //   休息时长仍从 3-8min 采。休息量级不减（合规）。连续随机保持（底层 randRange）。
  private pagesSinceBlockRest = 0;
  private static readonly LIEPIN_REST_EVERY_MIN = 3; // 翻页休息触发区间下限（现采）
  private static readonly LIEPIN_REST_EVERY_MAX = 8; // 翻页休息触发区间上限（现采）
  private restEveryPagesTarget = 5; // 当前区间目标：翻满这么多页触发一次休息（每次触发后重采）
  // ★ 2026-08-19 修复3：低概率(~6%)在与页数无关的随机时点插一个「分心」中停(20-60s)，
  //   模拟被消息/别的事打断。不发请求、不碰配额（纯 sleep，叠加在已规划的 wait 上）。
  private static readonly DISTRACTION_CHANCE = 0.06;
  private static readonly DISTRACTION_MIN_MS = 20 * 1000;
  private static readonly DISTRACTION_MAX_MS = 60 * 1000;
  // ★ 2026-08-19 修复4【自然疲劳曲线（温和，不砍产量）】：随会话 elapsed/budget 平滑连续地小幅
  //   延长【翻页/扫卡间的基础停顿】，模拟真人越跑越松弛。★ 幅度温和：末段停顿均值 +约30%
  //   （FATIGUE_MAX=0.3，落在任务要求的 +20~40%）。只延长不缩短（不因此提速触发频率闸）。
  //   ★ 只作用于【非休息】的普通停顿分支（!restKind）——休息(pageBlock/big/batch)量级不动，
  //     既不削弱休息量级(合规)也不大幅放大长休砍产量。前瞻可疑度安全网(见信号即退)保留。
  private static readonly FATIGUE_MAX = 0.3;
  private sessionBudgetMs = Infinity; // 单次会话预算（= runDurationMs，无上限则不疲劳）
  // 熔断
  private circuit: 'closed' | 'open' | 'halfOpen' = 'closed';
  private circuitOpenUntil = 0;
  private consecutiveTrips = 0;
  private circuitReason = '';
  // 是哪一类信号打开的熔断——同类信号在这次冷却期内一律视为"同一场风暴"，直接吸收（见 onSignal）
  private circuitKind: DefenseSignalKind | null = null;
  private halfOpenProbesLeft = 0;
  private static readonly HALF_OPEN_PROBES = 3;
  private static readonly CIRCUIT_CAP_MS = 60 * MIN;
  // 信号去抖：BOSS 被判 code:35 后是【每个 wapi 响应都返 35】，不去抖会让 consecutiveTrips
  // 一次性冲到指数退避上限、并向 risk_history 灌几十条重复记录，分级退避被打穿。
  private lastSignalAt = new Map<DefenseSignalKind, number>();
  private static readonly SIGNAL_DEBOUNCE_MS = 3000;
  // 本次运行内每类信号的【去抖后】触发次数——入口层信号第 2 次即升级硬停
  private tripCountByKind = new Map<DefenseSignalKind, number>();
  // 前瞻插休门槛（0-100）。满速运行 freq=30、跑满 45min session=30，故 55 可在"高频 + 半程"
  // 或"高频 + 少量软信号"时就主动退，而不必等到硬信号。
  private static readonly PREDICTIVE_THRESHOLD = 55;
  // 健康基线
  private health: RiskControllerSnapshot['health'] = null;

  // 持久化 key 按平台命名空间，避免两平台互相覆盖熔断/基线状态
  private circuitKey: string;
  private healthJdKey: string;

  private static readonly HEALTH_JD_KEY_BASE = 'health-baseline-jd';

  constructor(platform: PlatformId = 'boss') {
    this.platform = platform;
    this.entryLayerKinds = new Set<DefenseSignalKind>(ENTRY_LAYER_KINDS_BY_PLATFORM[platform] || []);
    this.circuitKey = `${RiskController.CIRCUIT_KEY_BASE}-${platform}`;
    this.healthJdKey = `${RiskController.HEALTH_JD_KEY_BASE}-${platform}`;
  }

  // ── 熔断状态持久化 ──────────────────────────────────────────────────────
  // 退避的全部意义是"这段时间内不要再碰平台"。原先 circuit/circuitOpenUntil/consecutiveTrips
  // 只活在内存里：熔断冷却中 App 崩溃或被用户关掉 → 重启即全新实例 → 冷却清零 →
  // 调度/空闲服务可以立刻重新开跑，退避在最需要它的崩溃场景下恰好失效。
  // 故把"到期时间 + 连续触发次数 + 原因"落库，启动时恢复；已过期的自然丢弃。
  private static readonly CIRCUIT_KEY_BASE = 'risk-circuit-state';

  private persistCircuit() {
    try {
      setSetting(this.circuitKey, {
        openUntil: this.circuitOpenUntil,
        trips: this.consecutiveTrips,
        reason: this.circuitReason,
      });
    } catch { /* 持久化失败不影响运行 */ }
  }

  /** 主进程启动时调用：把未过期的熔断窗口恢复出来（跨重启保持退避）。 */
  restoreFromDisk() {
    try {
      const s = getSetting<{ openUntil: number; trips: number; reason: string } | null>(
        this.circuitKey, null,
      );
      if (!s || typeof s.openUntil !== 'number') return;
      if (s.openUntil > nowSafe()) {
        this.circuit = 'open';
        this.circuitOpenUntil = s.openUntil;
        this.consecutiveTrips = Number(s.trips) || 0;
        this.circuitReason = s.reason || '上次运行遗留的风控冷却';
        this.rate = this.cfg.rateMin;
      } else {
        setSetting(this.circuitKey, null); // 已过期，清掉
      }
    } catch { /* 恢复失败按无冷却处理 */ }
  }

  reset(mode: SpeedMode, jdId?: string | null) {
    // ★ 2026-08-20 P2：唯一 human 档。旧 safe 入参经 normalizeSpeedMode 归 human。
    this.tier = normalizeSpeedMode(mode);
    this.cfg = TIER[this.tier];
    this.rate = this.cfg.rateStart;
    this.consecutiveClean = 0;
    this.actionTimestamps = [];
    this.softEwma = 0;
    this.suspicion = 0;
    const now = nowSafe();
    this.sessionStart = now;
    this.lastBigRestAt = now;
    this.bigRestIntervalMs = 42 * MIN + Math.floor(randRange(0, 8 * MIN));
    this.lastPredictiveRestAt = 0;
    this.scannedSinceBatchRest = 0;
    this.pagesSinceBlockRest = 0; // 2026-08-19 修复3：每会话复位翻页休息计数（原未复位，跨运行残留）
    this.restEveryPagesTarget = this.rollRestEveryPages(); // 首个区间目标现采
    // ⚠️ 未过期的熔断窗口【不能】被新一轮 reset 清掉——否则"退避中重启 App 再点开始"
    // 就把冷却抹平了，跨重启持久化也就白做。只有已到期的才复位。
    if (this.circuit === 'open' && this.circuitOpenUntil > now) {
      this.rate = this.cfg.rateMin; // 保持冷却，速率压到最低
    } else {
      this.circuit = 'closed';
      this.circuitOpenUntil = 0;
      this.consecutiveTrips = 0;
      this.circuitReason = '';
    this.circuitKind = null;
      this.persistCircuit();
    }
    this.halfOpenProbesLeft = 0;
    this.lastSignalAt.clear();
    this.tripCountByKind.clear();
    this.assessHealth(jdId ?? null); // 开跑先评估账号健康度（按当前 JD 归属基线）
  }

  // ★ 2026-08-19 修复4：引擎在 reset 后、按 HARD_MAX_RUN_MS 收敛出 runDurationMs 时调用，
  //   告知控制器本次会话预算（=单次连续运行硬顶，登记册 ≤90min）。planNext 据此算疲劳进度。
  //   budget<=0 或无上限(Infinity)则不启用疲劳曲线（无预算参照系，不臆测）。
  setSessionBudgetMs(budgetMs: number) {
    this.sessionBudgetMs = budgetMs > 0 && Number.isFinite(budgetMs) ? budgetMs : Infinity;
  }

  // 人工确认「我已处理」后复位熔断（与 riskMonitor.clearAll 配套，杜绝清了冷却却仍被熔断挡住）
  clearCircuit() {
    this.circuit = 'closed';
    this.circuitOpenUntil = 0;
    this.consecutiveTrips = 0;
    this.circuitReason = '';
    this.circuitKind = null;
    this.halfOpenProbesLeft = 0;
    this.lastSignalAt.clear();
    this.tripCountByKind.clear();
    if (this.health) this.health = { ...this.health, shadowSuspected: false };
    this.rate = this.cfg.rateStart;
    this.persistCircuit(); // 人工解除后同步落盘，避免重启又被旧冷却挡住
  }

  // ── 信号入口：AIMD 降速 + 熔断判定 ──
  onSignal(kind: DefenseSignalKind, detail?: string): SignalResult {
    const p = SIGNAL_POLICY[kind];
    const now = nowSafe();
    const reasonEarly = detail ? `${kind}:${detail}` : kind;
    // 同一场风暴的判据：熔断正因【同一类信号】打开着 → 后续同类信号都是这次事件的余波，一律吸收。
    // 这条比 3s 去抖窗更根本：BOSS 判 code:35 后是每个 wapi 响应都返 35，风暴能持续几分钟，
    // 光靠固定 3s 窗会变成每 3s 触发一次 tripCircuit + 灌一条 risk_history（约 20 条/分钟）。
    // 而登记册要的"同一次运行内再次触发即硬停"，语义上指的是【冷却结束、半开试探时又被打回来】，
    // 不是同一场风暴里的第 N 条响应——所以在 open 期内吸收，半开后再触发才计数升级，两者不矛盾。
    const sameStorm = this.circuit === 'open' && now < this.circuitOpenUntil && this.circuitKind === kind;
    // 去抖：同类信号 3s 内重复只处置一次（避免 code:35 风暴把退避打到上限 + 灌历史）
    const last = this.lastSignalAt.get(kind) || 0;
    if (sameStorm || now - last < RiskController.SIGNAL_DEBOUNCE_MS) {
      // ⚠️ 被吸收的命中【不刷新时间戳】——必须是固定窗口而不是滑动窗口。
      // 旧实现在这里 set(kind, now)，于是只要信号间隔持续 <3s，窗口就被无限顺延，
      // tripCountByKind 永不 +1。而 code:35 风暴恰恰就是"每个 wapi 响应都返 35"，
      // 结果是登记册要求的「同一次运行内第 2 次入口层信号即硬停」可能永远数不到 2。
      return {
        needHuman: p.mode === 'human',
        tripped: p.mode !== 'soft',
        cooldownMs: Math.max(0, this.circuitOpenUntil - now),
        reason: reasonEarly,
        debounced: true, escalated: false, notify: false,
      };
    }
    this.lastSignalAt.set(kind, now);
    const occurrence = (this.tripCountByKind.get(kind) || 0) + 1;
    this.tripCountByKind.set(kind, occurrence);
    // AIMD 乘性降速（所有信号都压速率）
    this.rate = Math.max(this.cfg.rateMin, this.rate * p.decrease);
    this.consecutiveClean = 0;
    // 软信号密度 EWMA 抬升（喂前瞻评分）
    this.softEwma = this.softEwma * 0.7 + 0.3;
    const reason = detail ? `${kind}:${detail}` : kind;

    if (p.mode === 'human') {
      // 需人工：控制器也开长冷却兜底（防调度自动重启），但引擎会硬停+通知
      this.tripCircuit(p.baseCooldownMs, reason, now, /*fromHuman*/ true, kind);
      return {
        needHuman: true, tripped: true, cooldownMs: this.circuitOpenUntil - now, reason,
        debounced: false, escalated: false, notify: true,
      };
    }
    if (p.mode === 'circuit') {
      const entry = this.entryLayerKinds.has(kind);
      // 入口层信号第 2 次（同一次运行内）→ 升级为硬停 + 需人工确认，不再自动半开重试
      const escalated = entry && occurrence >= 2;
      this.tripCircuit(p.baseCooldownMs, reason, now, escalated, kind);
      return {
        needHuman: escalated, tripped: true, cooldownMs: this.circuitOpenUntil - now, reason,
        debounced: false, escalated, notify: entry,
      };
    }
    // soft：仅降速
    this.computeSuspicion(now);
    return {
      needHuman: false, tripped: false, cooldownMs: 0, reason,
      debounced: false, escalated: false, notify: false,
    };
  }

  private tripCircuit(baseMs: number, reason: string, now: number, fromHuman: boolean, kind: DefenseSignalKind | null = null) {
    // 半开期内再撞 → 连续触发数递增（指数退避更久）
    if (this.circuit === 'halfOpen' || this.circuit === 'open') this.consecutiveTrips++;
    else this.consecutiveTrips = Math.max(this.consecutiveTrips, fromHuman ? 1 : 0) + (fromHuman ? 0 : 0);
    const factor = Math.pow(2, Math.min(this.consecutiveTrips, 4)); // 指数退避，cap 2^4
    const dur = Math.min(RiskController.CIRCUIT_CAP_MS, Math.max(baseMs, baseMs * factor));
    this.circuit = 'open';
    this.circuitOpenUntil = Math.max(this.circuitOpenUntil, now + dur);
    this.circuitReason = reason;
    this.circuitKind = kind;
    this.halfOpenProbesLeft = 0;
    this.persistCircuit(); // 跨重启保持退避
  }

  // ── 干净的【真实请求】动作：半开探针专用（登记册：冷却后只以最低速率放 3 张探针试探）──
  //
  // 探针必须绑定在会真正打到平台的动作（下滑加载 loadMore）上，不能绑在 onCleanAction。
  // onCleanAction 是"每看完一张卡"调一次的，而列表级浏览是【零网络请求】的——
  // 旧实现于是变成：冷却结束后看 3 张早就在内存里的卡（完全没碰平台）就合闸、速率跳回 rateStart，
  // 冷却后第一个真正触网的请求反而是在"探针已通过、速率已复位"之后才发出的，试探等于没试探。
  onCleanRequest() {
    if (this.circuit !== 'halfOpen') return;
    this.halfOpenProbesLeft--;
    if (this.halfOpenProbesLeft > 0) return;
    // 探针全部干净 → 合闸。速率不直接跳回 rateStart：刚从熔断出来就恢复原速等于白冷却，
    // 改为从最慢档起步，再由 AIMD 加性缓增自己爬回去。
    this.circuit = 'closed';
    this.consecutiveTrips = 0;
    this.circuitReason = '';
    this.circuitKind = null;
    this.rate = Math.min(this.cfg.rateStart, this.cfg.rateMin + this.cfg.additive);
    this.persistCircuit();
  }

  // ── 清洁动作：AIMD 加性增速 ──
  onCleanAction() {
    const now = nowSafe();
    this.actionTimestamps.push(now);
    if (this.actionTimestamps.length > 40) this.actionTimestamps.shift();
    this.softEwma *= 0.85; // 软信号密度自然衰减
    this.consecutiveClean++;

    if (this.circuit === 'closed') {
      // 加性缓增：每 cleanWindow 次干净动作提一档速率
      if (this.consecutiveClean % this.cfg.cleanWindow === 0) {
        this.rate = Math.min(this.cfg.rateMax, this.rate + this.cfg.additive);
      }
    }
    this.computeSuspicion(now);
  }

  // ── 前瞻可疑度评分 0-100 ──
  // 标定说明：原实现 sessionScore 以 90min 归一、门槛 75，而任务默认 runDurationMin=90 到点即停，
  // 现实中 suspicion 上限只到 ~60 → 前瞻插休分支永不进入（形同虚设）。
  // 现按"单次连续运行 45min 即应长休"标定 sessionScore，并把门槛降到 PREDICTIVE_THRESHOLD。
  private computeSuspicion(now: number) {
    // 频率分：近 60s 动作数相对速率上限
    const recent = this.actionTimestamps.filter((t) => now - t < 60000).length;
    const freqScore = Math.min(30, (recent / Math.max(1, this.cfg.rateMax)) * 30);
    // 会话时长分：以 45min 为满分点（对齐"每 45 分钟强制休息"的保守口径）
    const mins = (now - this.sessionStart) / MIN;
    const sessionScore = Math.min(30, (mins / 45) * 30);
    // 软信号密度分
    const softScore = Math.min(25, this.softEwma * 25);
    // 时段分：夜间(22-7)
    const hr = new Date(now).getHours();
    const nightScore = hr >= 22 || hr < 7 ? 15 : 0;
    this.suspicion = Math.round(Math.min(100, freqScore + sessionScore + softScore + nightScore));
  }

  // ★ 2026-08-19 修复3：现采下一个「翻满 N 页触发休息」的 N（区间 [MIN,MAX] 整数）。
  //   N 不再固定 5，休息落点不规则；休息时长仍 3-8min 分布采（见 planNext pageBlock 分支）。
  private rollRestEveryPages(): number {
    return RiskController.LIEPIN_REST_EVERY_MIN
      + Math.floor(Math.random() * (RiskController.LIEPIN_REST_EVERY_MAX - RiskController.LIEPIN_REST_EVERY_MIN + 1));
  }

  // ── 节奏规划：引擎每个动作前调用，拿到应等待多久 / 是否熔断 ──
  planNext(kind: PaceKind): PacePlan {
    const now = nowSafe();
    // 熔断打开中
    if (this.circuit === 'open') {
      if (now < this.circuitOpenUntil) {
        return { waitMs: this.circuitOpenUntil - now, circuitOpen: true, reason: `熔断冷却中：${this.circuitReason}` };
      }
      // 冷却到点 → 转半开，放探针低速试探
      this.circuit = 'halfOpen';
      this.halfOpenProbesLeft = RiskController.HALF_OPEN_PROBES;
      this.rate = this.cfg.rateMin;
    }
    this.computeSuspicion(now);

    // 基准间隔 = 60/速率 秒；半开期强制最慢
    const effRate = this.circuit === 'halfOpen' ? this.cfg.rateMin : this.rate;
    const base = 60000 / effRate;
    // 拟人抖动（对数正态感：0.6~1.6x），偶尔"细看"更久
    let wait = base * randRange(0.6, 1.6);

    // ★ 猎聘：列表级「看一张卡」是【零网络请求】动作——卡片摘要早就随搜索结果一起
    //   下发到本地了，看快看慢服务端一无所知。风险绑在请求频率上，不在"看一张卡花多久"。
    //   使用各档位 cardScanMs profile（safe 3-5s / human 2-3.5s），对数正态采样（右偏分布，
    //   与真人停留时间特征一致；均匀分布可被统计检出 —— 2026-08-07 P1-5 修复）。
    //   ★ 2026-08-18 产量重构：真人扫卡就是 3-5 秒，原 8-16s 是把「读详情」时长错套到
    //     「扫卡」上——既慢又不像人。单卡停留改 3-5s 既降低风控(更像真人)又直接提产量。
    //     这【不增加请求频率】：扫卡读已加载 DOM 不发请求，真正发请求的是翻页，翻页频率
    //     仍受现有配额(10次/5min 等)约束，深翻靠「每翻 N 页休 3-8 分钟」控制，不动该闸。
    //   ~10% 概率「这个人有点意思多看两眼」——叠加固定 8-15s 拉长（不随 cardScanMs 缩放，
    //     否则改完 cardScanMs 后拉长也跟着缩水）。半开试探期例外：一切动作都压到最慢。
    if (kind === 'candidate' && this.platform === 'liepin' && this.circuit !== 'halfOpen') {
      // 2026-08-07 P1-5: 改用对数正态采样 + cardScanMs profile；safe 与 human 真的有区别
      const profile = DEFAULT_BEHAVIOR[this.tier];
      const csMs = profile.cardScanMs;
      wait = Math.max(500, sampleLogNormal(csMs.mean, csMs.std));
      const secondLookChance = profile.secondLookChance ?? 0.10;
      if (Math.random() < secondLookChance) {
        // ★ 2026-08-18：拉长用固定区间 8-15s（mean=11000, std=1750，与 cardScanMs 解耦），
        //   模拟「这个人有点意思多看两眼」。sampleLogNormal 保证右偏。
        wait += Math.max(500, sampleLogNormal(11000, 1750));
      }
    } else if (kind === 'candidate' && Math.random() < 0.15) {
      wait += base * randRange(0.4, 1.0);
    }
    // 以下三类都会真的发请求，额外拉开以压请求频率（档位一：翻页 15-25s、
    // 关键词切换 20-40s、详情 15-30s；本方案一律取更保守端）
    if (kind === 'scroll') wait += 8000 + randRange(0, 12000);
    if (kind === 'query') wait += 25000 + randRange(0, 20000);
    if (kind === 'detail') wait += 20000 + randRange(0, 15000);

    // 前瞻避让：可疑度高 → 主动插一次较长休息（在硬信号之前退）
    let restKind: PacePlan['restKind'];
    if (this.suspicion >= RiskController.PREDICTIVE_THRESHOLD && now - this.lastPredictiveRestAt > 8 * MIN) {
      this.lastPredictiveRestAt = now;
      this.rate = Math.max(this.cfg.rateMin, this.rate * 0.7); // 顺带降速
      wait += randRange(90000, 180000); // +1.5~3min
      restKind = 'predictive';
    }
    // ★ 猎聘档位一硬性要求：每翻 N 页强制休息 3~8 分钟（调研 §10「连续翻页限制」）。
    //   它是档位一里最"贵"也最有效的一条——真人翻几页确实会停下来看看，而连续不断地
    //   翻页是最容易被行为风控盯上的模式。放在这里而不是引擎里，是因为只有控制器知道
    //   "上一次休息是什么时候"。
    //   ★ 2026-08-19 修复3：N 不再固定 5，每区间现采 randInt(3,8)（restEveryPagesTarget），
    //     休息落点不规则「不再每5页整」；触发后重采下一区间目标。休息时长仍 3-8min 分布采，
    //     量级不减（合规）。
    if (kind === 'scroll' && this.platform === 'liepin') {
      this.pagesSinceBlockRest++;
      if (this.pagesSinceBlockRest >= this.restEveryPagesTarget) {
        this.pagesSinceBlockRest = 0;
        this.restEveryPagesTarget = this.rollRestEveryPages(); // 下一区间目标重采
        wait += randRange(3 * MIN, 8 * MIN);
        restKind = 'pageBlock';
      }
    }
    // 45min 强制长休（宏观拉开）
    if (now - this.lastBigRestAt >= this.bigRestIntervalMs) {
      this.lastBigRestAt = now;
      this.bigRestIntervalMs = 42 * MIN + Math.floor(randRange(0, 8 * MIN));
      wait += randRange(5 * MIN, 10 * MIN);
      restKind = 'big';
    }
    // 每 8~14 次动作一次小批休
    this.scannedSinceBatchRest++;
    if (!restKind && this.scannedSinceBatchRest >= 8 + Math.floor(randRange(0, 7))) {
      this.scannedSinceBatchRest = 0;
      wait += randRange(4000, 12000);
      restKind = 'batch';
    }
    // ★ 2026-08-19 修复3：低概率(~6%)在与页数无关的随机时点插一个「分心」中停(20-60s)，
    //   模拟被消息/别的事打断。★ 不发请求、不碰配额——纯 sleep 叠加在已规划的 wait 上；
    //   不计入任何 restKind（不改变休息/熔断状态机，不顶替 pageBlock/big），只在总停顿时长上
    //   叠加，因此不削弱频率配额/见信号即退/90分钟硬顶/休息量级。
    if (!restKind && this.circuit !== 'halfOpen' && Math.random() < RiskController.DISTRACTION_CHANCE) {
      wait += randRange(RiskController.DISTRACTION_MIN_MS, RiskController.DISTRACTION_MAX_MS);
    }
    // ★ 2026-08-19 修复4【自然疲劳曲线】：仅对【非休息】的普通停顿（!restKind）随会话进度
    //   平滑连续小幅延长——progress 从 0→1，停顿乘 (1 + FATIGUE_MAX*progress)，末段均值 +约30%。
    //   只延长不缩短（不会提速触发频率闸）；休息(pageBlock/big/batch)量级不动（不砍产量、不削弱
    //   休息量级）。budget 未知(Infinity)则不启用。前瞻可疑度安全网(见信号即退)保留。
    if (!restKind && Number.isFinite(this.sessionBudgetMs) && this.sessionBudgetMs > 0) {
      const progress = Math.min(1, Math.max(0, (now - this.sessionStart) / this.sessionBudgetMs));
      wait *= 1 + RiskController.FATIGUE_MAX * progress;
    }
    return { waitMs: Math.round(wait), circuitOpen: false, restKind };
  }

  // 预告下一次动作大概要等多久（只读估算，【不改变任何状态】，不能用 planNext 代替——
  // planNext 会推进批休计数、记录长休时刻）。仅用于把"接下来要静默多久"提前告诉用户。
  peekNextWaitMs(kind: PaceKind): number {
    if (this.circuit === 'open') return Math.max(0, this.circuitOpenUntil - nowSafe());
    const effRate = this.circuit === 'halfOpen' ? this.cfg.rateMin : this.rate;
    const base = 60000 / effRate;
    // 取抖动区间的中位数作估算；scroll 额外叠加固定的批次间隔
    let wait = base * 1.1;
    if (kind === 'scroll') wait += 14000;
    return Math.round(wait);
  }

  cooldownRemainingMs(): number {
    if (this.circuit !== 'open') return 0;
    const r = this.circuitOpenUntil - nowSafe();
    return r > 0 ? r : 0;
  }

  // ── 跨天健康基线：近 7 天高匹配率 vs 今日，检测隐形降权 ──
  // ⚠️ high_match 是按【当时激活的 JD】统计的，跨 JD 不可比。故：
  //   - 未激活 JD（jdId 为空）→ high_match 恒 0，不做判定；
  //   - JD 与基线标记不一致 → 重置起算日，等重新攒够 ≥3 个可比天再判；
  //   - 只用 date >= marker.since 的历史天做基线。
  // 否则"换个岗位跑"会天然让高匹配率骤降 → 误判隐形降权 → 误锁账号。
  assessHealth(jdId?: string | null): RiskControllerSnapshot['health'] {
    try {
      const todayKey = localDateKey();
      const marker = this.syncHealthJdMarker(jdId ?? null, todayKey);
      const db = getDb();
      // 必须带 platform 谓词：两平台 daily_stats 行独立，跨平台混取会让基线完全失真
      const rows = db.prepare(
        `SELECT date, viewed, high_match FROM daily_stats WHERE platform = ? ORDER BY date DESC LIMIT 14`,
      ).all(this.platform) as { date: string; viewed: number; high_match: number }[];
      if (!rows.length) { this.health = null; return null; }
      const today = rows.find((r) => r.date === todayKey);
      // 只取"同一 JD 期内"且有量的历史天
      const comparable = rows.filter(
        (r) => r.date !== todayKey && r.viewed >= 15 && (!marker || r.date >= marker.since),
      );
      const past = comparable.slice(0, 7).map((r) => r.high_match / Math.max(1, r.viewed));
      const baseline = past.length ? median(past) : 0;
      const todayRatio = today && today.viewed > 0 ? today.high_match / today.viewed : 0;
      const sampled = today?.viewed || 0;
      // 隐形降权：今日有足够量(≥25)但高匹配率骤降到基线 40% 以下（且基线本身有意义、JD 可比）
      const comparableBaseline = !!marker && past.length >= 3 && baseline > 0.02;
      const shadowSuspected = comparableBaseline && sampled >= 25 && todayRatio < baseline * 0.4;
      this.health = { baselineHighRatio: round3(baseline), todayHighRatio: round3(todayRatio), sampled, shadowSuspected };
      if (shadowSuspected) {
        // 疑似隐形降权 → 开熔断（实际时长受 CIRCUIT_CAP_MS 上限 60min 约束；
        // 真正的"停数天改真人操作"由引擎置 pageAnomaly + 通知用户决策，不靠这里的定时器）
        this.tripCircuit(RiskController.CIRCUIT_CAP_MS, '疑似隐形降权(高匹配率骤降)', nowSafe(), false);
      }
      return this.health;
    } catch {
      this.health = null;
      return null;
    }
  }

  // 同步"基线归属哪个 JD / 自哪天起"。JD 变更或未激活 JD 时返回 null（本次不做隐形降权判定）。
  private syncHealthJdMarker(jdId: string | null, todayKey: string): HealthJdMarker | null {
    if (!jdId) {
      // 未激活 JD：high_match 不会累计，基线无意义；同时清标记，避免下次误用旧基线
      try { setSetting(this.healthJdKey, null); } catch { /* 忽略 */ }
      return null;
    }
    let marker: HealthJdMarker | null = null;
    try { marker = getSetting<HealthJdMarker | null>(this.healthJdKey, null); } catch { marker = null; }
    if (!marker || marker.jdId !== jdId) {
      const next: HealthJdMarker = { jdId, since: todayKey };
      try { setSetting(this.healthJdKey, next); } catch { /* 忽略 */ }
      return null; // 刚换 JD：起算日即今天，无可比历史天 → 本次不判
    }
    return marker;
  }

  snapshot(): RiskControllerSnapshot {
    const now = nowSafe();
    return {
      rate: round2(this.rate),
      rateMin: this.cfg.rateMin,
      rateMax: this.cfg.rateMax,
      suspicion: this.suspicion,
      circuit: this.circuit,
      circuitReason: this.circuitReason || undefined,
      consecutiveTrips: this.consecutiveTrips,
      cooldownRemainingMs: this.cooldownRemainingMs(),
      sessionMinutes: Math.round((now - this.sessionStart) / MIN),
      health: this.health,
    };
  }
}

// —— 工具 ——（避免使用被禁的 Date.now()/Math.random 之外的东西；这里在主进程，允许 Date.now）
function nowSafe(): number { return Date.now(); }
function localDateKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function median(arr: number[]): number {
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

// ── 实例统一由 runtime-registry.ts 的 buildRuntime() 创建 ──
// 不再在此处维护模块级单例（export const riskController 已删除）。
export { sleep };
