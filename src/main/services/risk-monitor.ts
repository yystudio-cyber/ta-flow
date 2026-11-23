// 风险监控器
// 修复历史：
//  - H1: danger 冷却自动降级（cooldownHoursAfterDanger 到期且异常标志清除后自动降回 notice）
//  - 午夜自动 resetDaily()
//  - recordFavorite 更新 favoriteCountToday 指标
//  - 夜间时段支持跨午夜（start > end 时用 || 判断）
//  - 双平台化（2026-08-04）：可按 platform 创建实例；daily_stats / risk_history 写入带 platform 谓词；
//    闭环控制器通过 attachController 注入（打破构造期循环依赖；也让 boss/liepin 各自持有自己的控制器）；
//    ANOMALY_KEY 按平台命名空间避免互相覆盖闩。
import { EventEmitter } from 'events';
import { Notification } from 'electron';
import { getDb, getDaily, bumpDaily, getSetting, setSetting } from '../db';
import type {
  RiskState, RiskLevel, RiskMetrics, RiskThresholds, DefenseCooldown,
} from '../../shared/types';
import type { PlatformId, SpeedMode } from '../../shared/types';
import { DEFAULT_RISK_THRESHOLDS, DEFAULT_SETTINGS, normalizeSpeedMode } from '../../shared/constants';
import { getDefaultLimits } from '../../shared/utils';
import { computeRiskIndex } from './risk-index';
import type { AppSettings } from '../../shared/types';
import type { RiskController } from './risk-controller';
import { oplog } from './oplog';

// ── 分级响应策略的【唯一来源】是 RiskController.SIGNAL_POLICY ──────────────
// 本文件原有的 DEFENSE_SPEC / noteSignal 在闭环控制器重构后已无人调用（死代码），
// 且与控制器策略相互矛盾（如 emptyData：旧表 stop vs 控制器 circuit），
// 连带把信号去抖也一起架空。已整体删除；去抖迁到 RiskController.onSignal。
// 引擎统一走 RPAEngine.handleSignal → riskController.onSignal → riskMonitor.recordAnomaly/enterCooldown。

export interface RiskMonitorOptions {
  thresholds?: RiskThresholds;
  platform?: PlatformId;
}

export class RiskMonitor extends EventEmitter {
  readonly platform: PlatformId;
  private state: RiskState;
  private thresholds: RiskThresholds;
  private recentOps: number[] = []; // timestamps
  private recentLoads: number[] = []; // 下滑加载(loadMore)时刻——真实请求频率代理
  private opResults: boolean[] = []; // 最近可判定成败的操作（true=成功），用于失败率监控
  private static readonly OP_WINDOW = 20; // 失败率滑动窗口大小
  private lastDayKey: string = '';
  private tickTimer: NodeJS.Timeout | null = null;
  // 精密防范模型：当前冷却窗口（去抖已上移到 RiskController.onSignal）
  private cooldown: DefenseCooldown = { until: 0, reason: '', severity: 'safe' };
  // 闭环控制器：通过 attachController 注入（构造期避免循环依赖）。未注入时
  // getState()/clearAll() 等对 controller 的调用安全降级（boss 老链路在主进程启动时已 attach）。
  private controller: RiskController | null = null;

  // 2026-08-07 审查项 P1-2: 记住当前生效档位，用于取 limits 计算风险指数。
  // 原来写死 'human'，safe 档跑满自己的配额时暴露度只显示一半（按 human 的双倍上限算）。
  private currentTier: SpeedMode = 'human';

  // 异常闩持久化 key 按平台命名空间
  private readonly anomalyKey: string;
  private static readonly ANOMALY_KEY_BASE = 'risk-anomaly-latch';

  constructor(opts: RiskMonitorOptions = {}) {
    super();
    const { thresholds = DEFAULT_RISK_THRESHOLDS, platform = 'boss' } = opts;
    this.platform = platform;
    this.thresholds = thresholds;
    this.anomalyKey = `${RiskMonitor.ANOMALY_KEY_BASE}-${platform}`;
    // 从 daily_stats 恢复今日累计计数（跨重启保持）
    const todayRow = getDaily(RiskMonitor.todayKey(), platform);
    this.state = {
      level: 'safe',
      metrics: {
        greetCountToday: todayRow.greeted,
        browseCountToday: todayRow.viewed,
        favoriteCountToday: todayRow.favorited,
        lastHourOps: 0,
        lastWindowLoads: 0,
        pageAnomaly: false,
        accountRestricted: false,
        nightActivity: false,
        recentOpFails: 0,
        recentOpTotal: 0,
        consecutiveEmptyPages: 0,
        consecutiveGreetFails: 0,
        // 猎聘三重配额：当日累计从 DB 恢复，上限初始为 0（引擎启动时通过 setQuotaLimits 下推）
        pagesToday: todayRow.pages,
        searchesToday: todayRow.searches,
        detailsToday: todayRow.details,
        pagesLimit: 0,
        searchesLimit: 0,
        detailsLimit: 0,
      },
      reasons: [],
      suggestions: [],
    };
    this.lastDayKey = RiskMonitor.todayKey();
    // 每分钟 tick 一次，用于冷却检查和午夜重置
    this.tickTimer = setInterval(() => this.tick(), 60 * 1000);
    // 不阻止进程退出
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  /** 绑定本平台的闭环控制器。boss 单例由主进程在启动时注入；liepin 等新平台在 runtime-registry 构造时注入。 */
  attachController(controller: RiskController) {
    this.controller = controller;
  }

  private static todayKey(d = new Date()): string {
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
  }

  // M-17: 风险等级严重度排序，仅在"升高"时发系统通知
  private static levelRank(l: RiskLevel): number {
    return l === 'danger' ? 2 : l === 'notice' ? 1 : 0;
  }

  // M-17: 发送系统托盘通知（含风险等级与建议动作）
  private notifyLevelUp(level: RiskLevel, reason?: string, suggestion?: string) {
    try {
      if (!Notification.isSupported()) return;
      // 只在需要人工介入时通知（找人已自动暂停，等你处理）
      const title = '⚠️ 找人已暂停 · 需要你处理';
      const body = `${reason || '检测到风控信号'}\n${suggestion || '请打开应用查看并决定是否继续'}`;
      new Notification({
        title,
        body,
        urgency: level === 'danger' ? 'critical' : 'normal',
      }).show();
    } catch {}
  }

  // 2026-08-07 审查项 P1-2: 加 tier 参数，记住当前档位供 getState() 取 limits。
  // 不传 tier 时保持原有行为（向后兼容），但两处调用方已同步传入 tier。
  updateThresholds(t: RiskThresholds, tier?: SpeedMode) {
    this.thresholds = t;
    if (tier) this.currentTier = tier;
    this.evaluate();
  }

  getState(): RiskState {
    const base: RiskState = {
      level: this.state.level,
      metrics: { ...this.state.metrics },
      reasons: [...this.state.reasons],
      suggestions: [...this.state.suggestions],
      lastDangerAt: this.state.lastDangerAt,
      cooldown: this.cooldown.until > Date.now() ? { ...this.cooldown } : undefined,
      thresholds: { ...this.thresholds },
      controller: this.controller ? this.controller.snapshot() : undefined,
    };
    // 风险指数：纯读派生，算不出来不影响主状态
    // C2: 按当前平台和当前档位取限额（P1-2: 不再写死 'human'，safe 档跑满自己的配额才显示满格）
    try {
      base.riskIndex = computeRiskIndex(base, getDefaultLimits(this.currentTier, this.platform), this.platform);
    } catch { /* 指数失败不影响风险中心其它部分 */ }
    return base;
  }

  // 夜间硬闸（用户要求：夜间绝对禁跑）。支持跨午夜（start > end 用 || 判断）。
  // 与 evaluate() 里的 nightActivity 指标同源，但这里是【禁止启动/立即停机】的判据，不是提示。
  isNightNow(d = new Date()): boolean {
    const hr = d.getHours();
    const t = this.thresholds;
    return t.nightStartHour > t.nightEndHour
      ? hr >= t.nightStartHour || hr < t.nightEndHour
      : hr >= t.nightStartHour && hr < t.nightEndHour;
  }

  nightWindowLabel(): string {
    return `${this.thresholds.nightStartHour}:00–${this.thresholds.nightEndHour}:00`;
  }

  // 是否存在"需人工确认才能继续"的锁定标志（验证码/账号受限/疑似降权留下的闩）
  hasBlockingAnomaly(): boolean {
    return !!(this.state.metrics.pageAnomaly || this.state.metrics.accountRestricted);
  }

  // ── 异常闩持久化 ────────────────────────────────────────────────────────
  // pageAnomaly/accountRestricted 是「需人工确认才能再启动」的硬约束，原先只在内存里：
  // 出验证码硬停 → 关掉 App 再打开 → 闩消失 → 直接又能开跑，整条人工确认门禁被重启绕过。
  // 落库 + 启动恢复后，只有走「我已处理，解除停机」才能真正解除。

  private persistAnomaly() {
    try {
      setSetting(this.anomalyKey, {
        pageAnomaly: !!this.state.metrics.pageAnomaly,
        accountRestricted: !!this.state.metrics.accountRestricted,
        reason: this.state.reasons[0] || '',
        at: Date.now(),
      });
    } catch { /* 落盘失败不影响运行 */ }
  }

  /** 主进程启动时调用：恢复上次遗留的、尚未人工解除的异常闩。 */
  restoreFromDisk() {
    try {
      const s = getSetting<{ pageAnomaly: boolean; accountRestricted: boolean; reason: string } | null>(
        this.anomalyKey, null,
      );
      if (!s) return;
      if (s.pageAnomaly) this.state.metrics.pageAnomaly = true;
      if (s.accountRestricted) this.state.metrics.accountRestricted = true;
      if (s.pageAnomaly || s.accountRestricted) {
        this.state.reasons = [s.reason || '上次运行因风控停机，尚未人工解除'];
        this.evaluate();
      }
    } catch { /* 恢复失败按无闩处理 */ }
  }

  // 人工确认「我已处理」：清异常闩 + 冷却 + 控制器熔断，让引擎能重新启动。
  // 关键修复：原先 pageAnomaly 只有置 true 的路径、从无置 false，一次验证码即让
  // level 永久 danger → 再次启动必被 riskDanger 暂停，且因 level 未跳变而不弹决策框，
  // UI 的「继续」只删 manual 来源 → 本进程内彻底无法再找人（只能重启 App）。
  /**
   * @param opts.clearBackoff 是否连平台退避（控制器熔断 + 入口层升级计数）一起清。
   *   · 风险中心「我已处理，解除停机」→ true（默认）：用户明确说自己已人工核对过账号；
   *   · 运行中风险框的「继续使用，我知道风险」→ false：那只是"我知道，继续看人"，
   *     不该顺手把平台要求的 30~60 分钟退避和"同一次运行内第二次入口层信号即硬停"
   *     的额度一起抹掉——那两样是保护账号的最后一道闸（审查 2026-07-29）。
   */
  clearAll(reason = '用户确认已人工处理', opts?: { clearBackoff?: boolean }) {
    const clearBackoff = opts?.clearBackoff !== false;
    this.cooldown = { until: 0, reason: '', severity: 'safe' };
    this.state.metrics.pageAnomaly = false;
    this.state.metrics.accountRestricted = false;
    this.state.metrics.consecutiveEmptyPages = 0;
    this.state.metrics.consecutiveGreetFails = 0;
    this.state.lastDangerAt = undefined;
    this.persistAnomaly(); // 解除后立刻落盘，否则重启又被旧闩挡住
    if (clearBackoff && this.controller) this.controller.clearCircuit();
    this.recordAnomaly(reason, 'notice');
    // 阶段7 运行日志留痕（只记录，不改行为）：解除停机是安全相关关键动作，
    // 必须可追溯"谁、何时、清了哪些闩"。reason 由调用方传入（脱敏：来源固定为预定义文案）。
    try { oplog('risk', 'latch-clear', { reason, clearBackoff }, { platform: this.platform }); } catch { /* 日志绝不影响解除 */ }
    this.evaluate();
  }

  // 闭环控制器桥接：记录一条"风吹草动"到风险历史（不弹框、不升级 danger）——保证任何信号都留痕。
  recordAnomaly(reason: string, level: RiskLevel = 'notice') {
    try {
      // risk_history 已按 (platform, date) 建索引，必须带 platform 写入，否则两平台历史互串
      getDb().prepare('INSERT INTO risk_history (time, date, platform, level, reason) VALUES (?, ?, ?, ?, ?)')
        .run(Date.now(), RiskMonitor.todayKey(), this.platform, level, reason);
      if (level === 'danger') bumpDaily('risk_events', 1, this.platform);
    } catch {}
    this.state.reasons = [reason, ...this.state.reasons].slice(0, 6);
    this.emit('change', this.getState());
  }

  // 闭环控制器桥接：把熔断冷却镜像到 riskMonitor.cooldown（供 UI 横幅 + 调度/空闲重启门控复用现有管道）。
  enterCooldown(ms: number, reason: string, severity: RiskLevel = 'notice') {
    if (ms <= 0) return;
    const until = Date.now() + ms;
    if (until > this.cooldown.until) this.cooldown = { until, reason, severity, kind: undefined };
    // 阶段7 运行日志留痕（只记录，不改行为）：进入冷却=熔断停机，与 latch-clear（解除）对称。
    // 事后看运行日志能还原"何时因何种信号被熔断、停多久"，而非只见解除不见进入。
    // ok:false 立即落盘——熔断是事后最需要还原的现场，不能等定时器。
    try { oplog('risk', 'cooldown-enter', { reason, severity, cooldownMin: Math.round(ms / 60000) }, { ok: false, platform: this.platform }); } catch { /* 日志绝不影响熔断 */ }
    this.emit('change', this.getState());
  }

  // 冷却剩余毫秒（0=不在冷却）
  getCooldownRemainingMs(): number {
    const r = this.cooldown.until - Date.now();
    return r > 0 ? r : 0;
  }

  inCooldown(): boolean {
    return this.getCooldownRemainingMs() > 0;
  }

  getCooldown(): DefenseCooldown | undefined {
    return this.inCooldown() ? { ...this.cooldown } : undefined;
  }

  // 人工确认后清除冷却（用户在 UI 明确「我已处理，继续」）
  clearCooldown() {
    this.cooldown = { until: 0, reason: '', severity: 'safe' };
    this.emit('change', this.getState());
  }

  /** 修剪频率滑动窗口并同步 metrics。返回窗口计数是否发生变化。 */
  private pruneFreqWindows(): boolean {
    const cutoff = Date.now() - this.thresholds.freqWindowSec * 1000;
    const ops = this.recentOps.length;
    const loads = this.recentLoads.length;
    this.recentOps = this.recentOps.filter((t) => t > cutoff);
    this.recentLoads = this.recentLoads.filter((t) => t > cutoff);
    this.state.metrics.lastHourOps = this.recentOps.length;
    this.state.metrics.lastWindowLoads = this.recentLoads.length;
    return ops !== this.recentOps.length || loads !== this.recentLoads.length;
  }

  // 记录一次操作
  recordOp() {
    const now = Date.now();
    this.recentOps.push(now);
    this.maybeResetDaily();
    this.pruneFreqWindows();
    this.evaluate();
  }

  // 记录一次"下滑加载更多"——推荐流里唯一真正发网络请求的动作（约每 15 人 1 次）。
  // 这是比 recordOp（浏览计数，零请求）更有意义的请求频率代理。
  recordLoadMore() {
    this.maybeResetDaily();
    this.recentLoads.push(Date.now());
    this.pruneFreqWindows();
    // C1: 每次翻页=消耗一份页面配额
    this.recordPage();
    this.evaluate();
  }

  // 供引擎发系统通知（如 code:35 首次自动退避时让用户知情，而不是只在风险中心默默记一笔）
  notifyUser(title: string, body: string, critical = false) {
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body, urgency: critical ? 'critical' : 'normal' }).show();
    } catch {}
  }

  recordGreet() {
    this.maybeResetDaily();
    this.state.metrics.greetCountToday++;
    bumpDaily('greeted', 1, this.platform);
    this.evaluate();
  }

  recordBrowse() {
    this.maybeResetDaily();
    this.state.metrics.browseCountToday++;
    bumpDaily('viewed', 1, this.platform);
    this.recordOp();
  }

  recordFavorite() {
    this.maybeResetDaily();
    this.state.metrics.favoriteCountToday++;
    bumpDaily('favorited', 1, this.platform);
    this.evaluate();
  }

  // ── 猎聘三重配额计数 ──
  recordPage() {
    this.maybeResetDaily();
    this.state.metrics.pagesToday++;
    bumpDaily('pages', 1, this.platform);
  }
  recordSearch() {
    this.maybeResetDaily();
    this.state.metrics.searchesToday++;
    bumpDaily('searches', 1, this.platform);
  }
  recordDetail() {
    this.maybeResetDaily();
    this.state.metrics.detailsToday++;
    bumpDaily('details', 1, this.platform);
  }

  /** 设置猎聘三重配额每日上限（引擎启动时按档位 + 套餐推算后下推） */
  setQuotaLimits(pages: number, searches: number, details: number) {
    this.state.metrics.pagesLimit = pages;
    this.state.metrics.searchesLimit = searches;
    this.state.metrics.detailsLimit = details;
  }

  // P1-1: 当日累计计数（跨多次运行），供引擎按"每日上限"而非"每次运行"门控
  getTodayCounts(): { greet: number; browse: number; favorite: number; pages: number; searches: number; details: number } {
    this.maybeResetDaily();
    return {
      greet: this.state.metrics.greetCountToday,
      browse: this.state.metrics.browseCountToday,
      favorite: this.state.metrics.favoriteCountToday,
      pages: this.state.metrics.pagesToday,
      searches: this.state.metrics.searchesToday,
      details: this.state.metrics.detailsToday,
    };
  }

  recordScoreBucket(level: 'high' | 'medium' | 'low' | 'mismatch') {
    if (level === 'high') bumpDaily('high_match', 1, this.platform);
    else if (level === 'medium') bumpDaily('mid_match', 1, this.platform);
    else bumpDaily('low_match', 1, this.platform); // mismatch 归入低匹配桶
  }

  setPageAnomaly(anomaly: boolean, reason?: string) {
    this.state.metrics.pageAnomaly = anomaly;
    if (anomaly) {
      this.state.reasons.push(reason || '检测到验证码/风险提示');
    }
    this.persistAnomaly(); // 跨重启保持需人工确认闩
    this.evaluate();
  }

  setAccountRestricted(restricted: boolean) {
    this.state.metrics.accountRestricted = restricted;
    this.persistAnomaly();
    this.evaluate();
  }

  // 记录一次可判定成败的操作（打招呼/收藏等），维护滑动窗口失败率 —— 修复 recentOpFails/Total 死字段
  recordOpResult(ok: boolean) {
    this.opResults.push(!!ok);
    if (this.opResults.length > RiskMonitor.OP_WINDOW) this.opResults.shift();
    this.state.metrics.recentOpTotal = this.opResults.length;
    this.state.metrics.recentOpFails = this.opResults.filter((x) => !x).length;
    this.evaluate();
  }

  // 引擎回传：连续空结果页数（降权/限流的核心软信号）—— 修复 consecutiveEmptyPages 死字段
  setConsecutiveEmptyPages(n: number) {
    this.state.metrics.consecutiveEmptyPages = Math.max(0, n | 0);
    this.evaluate();
  }

  // 引擎回传：连续打招呼失败数，同步进指标（与引擎私有计数器一致）—— 修复 consecutiveGreetFails 死字段
  setConsecutiveGreetFails(n: number) {
    this.state.metrics.consecutiveGreetFails = Math.max(0, n | 0);
    this.evaluate();
  }

  resetDaily() {
    this.state.metrics.greetCountToday = 0;
    this.state.metrics.browseCountToday = 0;
    this.state.metrics.favoriteCountToday = 0;
    // C1: 三重配额也需跨天重置
    this.state.metrics.pagesToday = 0;
    this.state.metrics.searchesToday = 0;
    this.state.metrics.detailsToday = 0;
    this.state.metrics.recentOpFails = 0;
    this.state.metrics.recentOpTotal = 0;
    this.state.metrics.consecutiveEmptyPages = 0;
    this.state.metrics.consecutiveGreetFails = 0;
    this.recentOps = [];
    this.recentLoads = [];
    this.opResults = [];
    this.state.metrics.lastHourOps = 0;
    this.state.metrics.lastWindowLoads = 0;
    this.evaluate();
  }

  private maybeResetDaily() {
    const today = RiskMonitor.todayKey();
    if (today !== this.lastDayKey) {
      this.lastDayKey = today;
      this.resetDaily();
    }
  }

  /**
   * H1 修复：定时 tick —— 检查冷却、午夜重置
   * 冷却规则：进入 danger 满 cooldownHoursAfterDanger 小时，且以下异常信号均已清除，
   * 则自动降级回 notice（不会直接回到 safe，需要再观察一段时间）。
   */
  private tick() {
    this.maybeResetDaily();
    // 频率类滑动窗口必须在这里定期修剪，不能只在 recordOp/recordLoadMore 里剪。
    // 否则一旦下滑频率撞红线把等级打到 danger、引擎随即暂停，就再也没有新的 record 调用——
    // 窗口永远不被修剪，lastWindowLoads 冻结在红线值：几小时后风险中心仍显示 danger、
    // 风险指数 D2 恒 100 分，显示层与真实状态长期脱节。
    // 窗口真的衰减了才重算等级，避免每分钟都白广播一次 change。
    if (this.pruneFreqWindows()) this.evaluate();
    // 精密防范模型：冷却到点自然失效，广播一次让 UI/调度门控刷新
    if (this.cooldown.until && this.cooldown.until <= Date.now()) {
      this.cooldown = { until: 0, reason: '', severity: 'safe' };
      this.emit('change', this.getState());
    }
    if (this.state.level === 'danger' && this.state.lastDangerAt) {
      const elapsed = Date.now() - this.state.lastDangerAt;
      const cooldownMs = this.thresholds.cooldownHoursAfterDanger * 3600 * 1000;
      if (elapsed >= cooldownMs) {
        // 必须异常信号都清除（用户手动完成验证、账号恢复）
        if (!this.state.metrics.pageAnomaly && !this.state.metrics.accountRestricted) {
          this.state.level = 'notice';
          this.state.reasons = [
            `风险冷却已结束（距上次 danger 约 ${Math.round(elapsed / 3600000)} 小时），可继续观察使用`,
          ];
          this.state.suggestions = ['建议放慢速度，避免立即恢复高频操作'];
          this.state.lastDangerAt = undefined;
          this.emit('change', this.state);
          // M-18: 冷却到期不静默恢复——发事件请上层弹框询问用户是否恢复 RPA（用户确认才恢复）。
          // 因 lastDangerAt 已清空，本判定分支不会重复触发，事件仅发一次。
          this.emit('cooldownExpired', this.getState());
        }
      }
    }
  }

  // 综合评估当前风险
  evaluate(): RiskLevel {
    this.maybeResetDaily();
    const m = this.state.metrics;
    const t = this.thresholds;
    const reasons: string[] = [];
    const suggestions: string[] = [];
    let level: RiskLevel = 'safe' as RiskLevel;
    // 2026-08-07 P1-9: 阈值 0 表示"本平台不做该操作"，整维退出判定（不参与风险评级）。
    // 对称修复：greetRed 已修，browseRed/freqOps/loadFreqOps 同理。
    const overLimit = (count: number, limit: number) => limit > 0 && count >= limit;

    const hr = new Date().getHours();
    // 支持跨午夜：若 start > end（如 22-6）用 || 判断
    if (t.nightStartHour > t.nightEndHour) {
      m.nightActivity = hr >= t.nightStartHour || hr < t.nightEndHour;
    } else {
      m.nightActivity = hr >= t.nightStartHour && hr < t.nightEndHour;
    }

    // 打招呼数。
    // ★ 上限为 0 的语义是【本平台不做打招呼】，不是"一次都不许打"。
    //   猎聘就是这样：流程只有搜索 + 收藏，不打招呼，故 greetYellow/greetRed 都配成 0
    //   （见 constants.ts getRiskThresholdsForMode 的 liepin 分支）。
    //   原判定 `count >= red` 在 red=0 时于 count=0 就成立 —— 猎聘每次一启动就被
    //   立刻锁进 danger，整条线根本跑不起来。2026-08-05 真机 risk_history 里那条
    //   「今日打招呼数已达 0，超过上限 0」就是这个 bug 的现场。
    //   上限为 0 时整个维度退出判定，不参与风险评级。
    if (t.greetRed > 0) {
      if (m.greetCountToday >= t.greetRed) {
        level = 'danger';
        reasons.push(`今日打招呼数已达 ${m.greetCountToday}，超过上限 ${t.greetRed}`);
        suggestions.push('今日立即停止打招呼（手动也建议停止），明日再使用');
      } else if (t.greetYellow > 0 && m.greetCountToday >= t.greetYellow) {
        if (level !== 'danger') level = 'notice';
        reasons.push(`今日打招呼数已达 ${m.greetCountToday}，接近上限 ${t.greetRed}`);
        suggestions.push('剩余时间不要再用 RPA 自动打招呼');
      }
    }

    // 浏览量（P1-9: 用 overLimit 守卫，阈值 0 = 本平台不做该动作，整维退出）
    if (overLimit(m.browseCountToday, t.browseRed)) {
      level = 'danger';
      reasons.push(`今日浏览量已达 ${m.browseCountToday}，超过上限 ${t.browseRed}`);
      suggestions.push('立即停止 RPA，手动浏览也建议放缓节奏');
    } else if (overLimit(m.browseCountToday, t.browseYellow)) {
      if (level !== 'danger') level = 'notice';
      reasons.push(`今日浏览量已达 ${m.browseCountToday}，接近上限 ${t.browseRed}`);
      suggestions.push('建议放慢节奏或休息一段时间');
    }

    // 浏览频率兜底探测（P1-9: 用 overLimit 守卫）
    if (overLimit(m.lastHourOps, t.freqOps)) {
      if (level !== 'danger') level = 'notice';
      reasons.push(`最近 ${t.freqWindowSec / 60} 分钟内浏览 ${m.lastHourOps} 人，已超过控制器速率上限（异常）`);
      suggestions.push('节奏异常，请检查是否有多实例并发或手动高频操作');
    }
    // 下滑加载频率（真实请求频率）（P1-9: 用 overLimit 守卫）
    if (overLimit(m.lastWindowLoads, t.loadFreqOps * 2)) {
      level = 'danger';
      reasons.push(`最近 ${t.freqWindowSec / 60} 分钟内下滑加载 ${m.lastWindowLoads} 次，请求频率明显过高`);
      suggestions.push('立即停止，翻屏过快会直接撞入口层频率限制');
    } else if (overLimit(m.lastWindowLoads, t.loadFreqOps)) {
      if (level !== 'danger') level = 'notice';
      reasons.push(`最近 ${t.freqWindowSec / 60} 分钟内下滑加载 ${m.lastWindowLoads} 次（正常 1-2 次）`);
      suggestions.push('翻屏偏快，留意是否有空屏导致的反复下滑');
    }

    // 操作失败率（滑动窗口）：样本够且失败率高 → 选择器失效/被拦截，应停
    if (m.recentOpTotal >= 8) {
      const failRate = m.recentOpFails / m.recentOpTotal;
      if (failRate >= 0.6) {
        level = 'danger';
        reasons.push(`最近 ${m.recentOpTotal} 次操作失败 ${m.recentOpFails} 次（失败率 ${Math.round(failRate * 100)}%）`);
        suggestions.push('立即停止，可能被风控拦截或 BOSS 页面改版');
      } else if (failRate >= 0.35) {
        if (level !== 'danger') level = 'notice';
        reasons.push(`操作失败率偏高（${m.recentOpFails}/${m.recentOpTotal}）`);
        suggestions.push('留意是否开始被限流');
      }
    }

    // C1: 猎聘三重配额检查（pages/searches/details）—— 此前只统计不拦截
    if (m.pagesLimit > 0 && m.pagesToday >= m.pagesLimit) {
      level = 'danger';
      reasons.push(`今日翻页已达 ${m.pagesToday}/${m.pagesLimit}，超过每日上限`);
      suggestions.push('今日请停止翻页，避免触发平台反爬');
    } else if (m.pagesLimit > 0 && m.pagesToday >= m.pagesLimit * 0.8) {
      if (level !== 'danger') level = 'notice';
      reasons.push(`今日翻页已用 ${m.pagesToday}/${m.pagesLimit}，接近每日上限`);
      suggestions.push('注意控制翻页频率');
    }
    if (m.searchesLimit > 0 && m.searchesToday >= m.searchesLimit) {
      level = 'danger';
      reasons.push(`今日搜索已达 ${m.searchesToday}/${m.searchesLimit}，超过每日上限`);
      suggestions.push('今日请停止新搜索');
    } else if (m.searchesLimit > 0 && m.searchesToday >= m.searchesLimit * 0.8) {
      if (level !== 'danger') level = 'notice';
      reasons.push(`今日搜索已用 ${m.searchesToday}/${m.searchesLimit}，接近每日上限`);
      suggestions.push('注意控制搜索频率');
    }
    if (m.detailsLimit > 0 && m.detailsToday >= m.detailsLimit) {
      level = 'danger';
      reasons.push(`今日打开详情已达 ${m.detailsToday}/${m.detailsLimit}，超过每日上限（已消耗真金白银）`);
      suggestions.push('今日请停止打开详情，避免超额扣费');
    } else if (m.detailsLimit > 0 && m.detailsToday >= m.detailsLimit * 0.8) {
      if (level !== 'danger') level = 'notice';
      reasons.push(`今日打开详情已用 ${m.detailsToday}/${m.detailsLimit}（已消耗真金白银），接近每日上限`);
      suggestions.push('注意控制打开详情频率');
    }

    // 连续空结果页（降权/限流的核心软信号）：≥3 页无候选人判危险
    if (m.consecutiveEmptyPages >= 3) {
      level = 'danger';
      reasons.push(`连续 ${m.consecutiveEmptyPages} 页无候选人，疑似被降权/限流（返回空数据）`);
      suggestions.push('立即停止，改日或改用真人操作观察是否恢复');
    } else if (m.consecutiveEmptyPages >= 2) {
      if (level !== 'danger') level = 'notice';
      reasons.push(`连续 ${m.consecutiveEmptyPages} 页无候选人`);
      suggestions.push('留意是否被降权');
    }

    // 夜间：绝对禁跑时段（引擎侧硬闸会拒绝启动并立即停机，这里只做等级/文案）
    if (m.nightActivity) {
      if (level === 'safe') level = 'notice';
      reasons.push(`当前处于禁跑时段（${t.nightStartHour}:00–${t.nightEndHour}:00），自动化已被禁止`);
      suggestions.push('禁跑时段内不会启动，运行中会自动停机；请在白天再跑');
    }

    // 页面异常
    if (m.pageAnomaly) {
      level = 'danger';
      reasons.push('检测到验证码或风险提示页面');
      suggestions.push('立即停止 RPA，手动完成验证，再休息至少 1 小时');
    }

    if (m.accountRestricted) {
      level = 'danger';
      reasons.push('打招呼功能可能已被限制');
      suggestions.push('立即停止所有自动化操作，账号需休息恢复');
    }

    if (level === 'safe') {
      suggestions.push('一切正常，可放心使用');
    }

    const prevLevel = this.state.level;
    this.state.level = level;
    this.state.reasons = reasons;
    this.state.suggestions = suggestions;

    if (level !== prevLevel) {
      if (level === 'danger') {
        this.state.lastDangerAt = Date.now();
        // 落库兜错：evaluate 由 60s 定时器驱动，DB 不可用时这里裸抛会变成周期性
        // 未捕获异常；留痕失败不能反过来打断风险升级的广播与通知（下方 emit）
        try {
          getDb()
            .prepare('INSERT INTO risk_history (time, date, platform, level, reason) VALUES (?, ?, ?, ?, ?)')
            .run(Date.now(), RiskMonitor.todayKey(), this.platform, level, reasons.join('; '));
          bumpDaily('risk_events', 1, this.platform);
        } catch (e: any) {
          console.warn('[risk] 风险历史落库失败（不影响风险处置）：', e?.message || e);
        }
        // 阶段7 运行日志留痕（只记录，不改行为）：danger 升级=触发风控停机，是安全相关关键动作。
        // risk_history 表供风险中心页查，oplog 供运行日志页/诊断包查——两条管道互不替代。
        // ok:false 立即落盘。reasons 已是预定义风险文案，无 PII。
        try { oplog('risk', 'danger-up', { reason: reasons.join('; ').slice(0, 200), fromLevel: prevLevel }, { ok: false, platform: this.platform }); } catch { /* 日志绝不影响风险处置 */ }
      }
      this.emit('levelChange', this.state); // H-4: 只有 level 跳变才应该弹对话框
      // 协同/静默原则（用户点"开始找人"后不用管风险）：
      //   - 只有【升到 danger = 真需人工介入】才发系统通知 + 由 ipc/risk 弹决策框；
      //   - notice（接近上限/降速中/软信号）与"风险解除"一律不打扰用户，仅在风险中心可见。
      if (level === 'danger' && RiskMonitor.levelRank(level) > RiskMonitor.levelRank(prevLevel)) {
        this.notifyLevelUp('danger', reasons[0], suggestions[0]);
      }
    }
    // M-12: 每次 evaluate 都广播 metrics 更新（今日计数实时变化）
    this.emit('change', this.getState());

    return level;
  }

  // 从 DB 载入今日计数
  loadFromDb() {
    const daily = getDaily(undefined, this.platform);
    this.state.metrics.greetCountToday = daily.greeted;
    this.state.metrics.browseCountToday = daily.viewed;
    // favorited 也尝试从 daily 拿（dailyStats 已有 favorited 字段）
    this.state.metrics.favoriteCountToday = (daily as any).favorited || 0;
    this.evaluate();
  }
}

// ── 实例统一由 runtime-registry.ts 的 buildRuntime() 创建 ──
// 不再在此处维护模块级单例（export const riskMonitor 已删除）。
