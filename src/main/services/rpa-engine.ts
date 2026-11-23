// RPA 引擎 + BOSS 直聘 Sourcing 任务流
//
// 修复历史：
//  - H1: 风险冷却降级（6 小时后回到 notice），是否暂停由 attachRiskEvents 处理
//  - H3: saveCandidateExport 使用 per-candidate greeted/favorited 布尔值
//  - H4: 风险弹框由 attachRiskEvents 统一处理（两按钮+autoPause 开关），引擎只在 danger 时 pause
//  - H9: 所有平台相关操作委托给 PlatformAdapter
//  - M-2: 运行时长自动停止（runDurationMin 到期停）
//  - M-3: elapsedMs 1s tick 更新
//  - M-4: 详情页分段滚动阅读，模拟人浏览
//  - M-5: tryFavorite/tryGreet/goNextPage 走 HumanOperator 拟人点击（传 op 参数）
//  - R26: 打招呼发送默认话术
//  - 细粒度动作日志（点击/滚动/收藏/招呼/翻页/返回）
//  - 休息按 wall-clock 时间触发（不是按人数）
import { EventEmitter } from 'events';
import type { Page, Browser } from 'puppeteer-core';
import { HumanOperator } from '../cdp/human-ops';
import { getRuntime } from './runtime-registry';
import type { PaceKind } from '../services/risk-controller';
import { getDb, bumpDaily, persistImmediate, getSetting, setSetting, clearAllLogs } from '../db';
import { oplog, hashId } from './oplog';
import { scoreCandidate, createScoreAudit, type ScoreAudit } from '../services/scoring';
// ⚠️ isRateWarning / classifyRiskKind / probeSessionHealth 【不能】从这里裸导入 ——
//    platform-adapter 把它们原样 re-export 自 adapters/boss，两平台共用等于
//    猎聘跑的是 BOSS 的检测逻辑：境外 IP 拦截、账号封禁、腾讯防水墙、阿里 WAF
//    这些猎聘专属信号全部零覆盖。一律改走 this.getAdapter().xxx。
import { getPlatformAdapter, resetHealthBaseline, scrollMetrics, getLastLoadMoreDiag, isWindowVisible } from '../services/platform-adapter';
import { PLATFORMS, type PlatformId } from '../../shared/types';
import type {
  RPATask,
  RPAState,
  RPAStatus,
  LogEntry,
  CandidateProfile,
  JD,
  ScoreResult,
  AppSettings,
  PauseReason,
  TriggerMode,
  DefenseSignalKind,
  SpeedMode,
} from '../../shared/types';
import type { SearchQuery, ApplySearchResult } from './platform-adapter';
import { sleep, logTime, getDefaultLimits } from '../../shared/utils';
import { resolveBehaviorProfile, DEFAULT_SETTINGS, getRiskThresholdsForMode, normalizeSpeedMode } from '../../shared/constants';

// S1: start() 幂等命令面返回值——供调度器/空闲服务判定本次调用的实际结果
export type StartResult = 'started' | 'already-running' | 'rejected';

export class RPAEngine extends EventEmitter {
  private state: RPAState;
  /**
   * L8(阶段1)：引擎归属平台。由构造时传入并锁定（runtime-registry 每平台 new 一个 RPAEngine）。
   * 此前构造无参，getPlatform 只能靠 task?.platform 推断——任务未设置前任何取平台的调用都兜底成 BOSS，
   * 猎聘引擎在起步阶段被当成 BOSS 处理。改为构造锁定后，getPlatform 优先取 this.platform，
   * 仅当任务自带不同平台时才以任务为准（任务平台应与引擎一致，这里只兜底防御）。
   * ⚠️ 本轮只改构造签名与 getPlatform 兜底，绝不碰猎聘搜索/翻页/切分抓取内核。
   */
  private readonly platform: PlatformId;
  private task: RPATask | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private op: HumanOperator | null = null;
  private running = false;
  // S1: 暂停来源集合（取代单一 paused 布尔）——集合非空即视为暂停，仅当集合清空才真正恢复运行
  private pauseReasons = new Set<PauseReason>();
  private stopRequested = false;
  // S1: stop→真正落地的等待点（stopAndWait/whenStopped 使用），finally 真正结束时统一 resolve
  private stoppedResolvers: Array<() => void> = [];
  private jd: JD | null = null;
  private riskListener: ((s: any) => void) | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  // H3：per-candidate 动作标记
  private candidateGreeted = false;
  private candidateFavorited = false;
  /** 当前正在"阅读"的卡片——供 pace(candidate) 把等待填成真人读卡的轨迹 */
  private lastReadCard: CandidateProfile | null = null;
  /** 窄词跳过：出现过 no-result 的关键词，后续同词切分档直接跳过（切分只对宽词有效）。每轮起清空。 */
  private sparseKeywords = new Set<string>();
  /** 「本平台列表页没有收藏按钮」这条说明每轮只播报一次，避免刷屏淹没真正的日志 */
  private favoriteUnsupportedLogged = false;
  // 注：原有的 lastRestAt / restIntervalMs / lastBigRestAt / behaviorProf / scannedSinceBreak /
  //    slowdownRequested 在闭环控制器重构后已无人读取（节奏统一由 RiskController.planNext 规划），
  //    保留只会让人误以为"引擎还在自己管休息"。已整体删除。
  private consecutiveGreetFails = 0; // P1-2: 连续招呼失败计数，用于探测"账号受限"
  private consecutiveEmptyPages = 0; // 连续空结果页计数（降权/限流软信号，≥3 判危险）
  private emptyGraceLeft = 0;        // 首屏渲染宽限次数：推荐帧尚未渲染出卡时不计入"空页"
  private static readonly EMPTY_GRACE = 3;
  private rateWarnings = 0; // "操作速度过快"温和提示计数（前几次长休续跑，≥3 升级暂停）
  private lastInlineRiskCheckAt = 0; // 内层卡循环里的风控巡检时刻（避免一屏 15 张卡期间出现检测盲区）
  private apmUnreadableWarned = false; // Boss端上报载荷不可读：本次运行只告警一次
  // 块4 推荐流去重：已浏览候选人唯一键集合（本次运行内），杜绝虚拟列表回收导致的重复浏览，
  // 也是"下滑加载更多是否出新人"的判据（新 id 出现=有新内容；连续多次无新 id=已到底）
  private seenCardIds = new Set<string>();
  // 连续读不到推荐帧内容的次数（区别于"读到了但是 0 条"，后者才是平台返空）
  private readFailStreak = 0;
  // 连续"下滑根本没跑成"的次数（blocked：在飞阻塞/看门狗超时/出错），与"跑成了但没新人"分开计
  private blockedScrolls = 0;
  private consecutiveDryScrolls = 0; // 连续"下滑但无新增候选人"次数
  private readonly MAX_DRY_SCROLLS = 4; // 连续 4 次下滑无新增即判定推荐流已浏览完
  // ★ 2026-08-18 产量重构·修复1（深翻干涸判据）：分页平台单页 0/低新人不再立即换组合，
  //   连续多页内部去重后新人低于阈值才判该组合挖枯、换下一个搜索组合。
  //   与 MAX_DRY_SCROLLS(infinite 流到底判据) 互不影响——分页平台 !infinite 走本判据。
  private consecutiveLowYieldPages = 0;
  private readonly MAX_LOW_YIELD_PAGES = 3;   // 连续 3 页低产即判干涸换组合
  private readonly LOW_YIELD_PER_PAGE = 3;   // 内部去重后新人 <3/页算低产
  // ★ 2026-08-19 P1（组合轮换·行为多样性）→ 修复2 改造：单组合·单次会话深翻预算。
  //   真机 95min 长跑只跑组合1 一个：深翻耗尽整窗口，从没轮到更新鲜的组合，且死磕单一搜索
  //   把前瞻可疑度顶高（后半段「前瞻可疑度偏高·主动降速插休」密集触发）。加一道软上限：
  //   一个搜索组合在【本次运行】翻满该预算就轮换到下一个组合——即使它仍在产出新人；
  //   深挖靠【下次会话的游标续翻】继续（游标机制已有）。目的：一次 90min 会话覆盖 3-6 个
  //   深翻组合，行为更像真人、可疑度更低、关键词覆盖更广。
  //   ★ 2026-08-19 修复2：从固定 20 改为【每次进入该组合现采 randInt(15,20) 页】的深翻预算——
  //     目标是尽量翻完/翻深，不是浅翻；15-20 是「单组合别独占太久」的软阀，不是压产量。
  //     翻满/到平台尾页(next disabled)/挖枯(连续 MAX_LOW_YIELD_PAGES 低产)三者谁先到谁换组合。
  //   ★ 不设太小（<10页）会退回「浅翻多组合」高开销老问题；15-20 是深翻与多样性的折中。
  //   ★ 不新增/不放宽任何反风控请求频率、翻页配额、休息时长；可疑度模型本身不动（它工作正常）。
  //   与 MAX_LOW_YIELD_PAGES(连续低产挖枯换组合) 并列：那是「挖枯」退出，这是「翻够」退出，
  //   两者都让 ensureQuery 前进到下一个组合，互不干扰。
  private readonly SOFT_PAGES_MIN = 15; // 单组合单次会话深翻预算下限（现采区间）
  private readonly SOFT_PAGES_MAX = 20; // 单组合单次会话深翻预算上限（现采区间）
  private comboSoftPagesBudget = this.SOFT_PAGES_MAX; // 本次进入该组合现采的深翻预算（每次换组合时重采）

  // ★ 2026-08-19 页深持久化【每组合记住页深，下次用分页器跳页续翻，吃满 2000/组合深池】
  //   现状 pagesInQuery 是【会话级】每次进组合复位0 → 每个组合每次会话都从第1页重翻，
  //   2000 人深池只挖到前 15-20 页(300-400人)，深页人才永远吃不到。页深持久化把「上次挖到第
  //   几页」存进游标，下次进组合直接跳页到 D+1 再开挖，跨会话页深递增(1-20→21-40→…)。
  //   ★ 合规：跳页的每次 •••/页码点击都是真实翻页请求 → 已计入现有频率/翻页配额、走现有
  //     pace('scroll')+recordLoadMore+onCleanRequest（与正常翻页同通道），绝不开绿色通道；
  //     不削弱 90min 硬顶/休息量级/见信号即退。跳页途中只操作分页器，不点卡片/沟通/详情。
  //   游标扩存：{fp,index,label,at} + depth{label→最深真实页码} + done{label→是否到尾页}
  //     + doneAt{label→绕圈时间戳}。fp 变更→整块弃(自然不读旧 depth)。旧游标无 depth→视作空。
  /** 当前组合真实页码（从 ant-lpt-pagination-item-active 读，非 pagesInQuery 会话计数）。
   *  applySearch 出首页=1；翻页/跳页后实时更新；annotateSource 用它写正确页码归因。 */
  private currentRealPageNo = 0;
  /** 本次会话刚提交搜索(ensureQuery return 'next' 前)置 true → 主循环据此在抓卡前续翻跳页。 */
  private queryJustResumed = false;
  /** 会话级页深缓存：label→已翻到最深真实页码。saveCursor 时落盘到游标 depth 字段。 */
  private queryDepth: Record<string, number> = {};
  /** 会话级尾页缓存：label→是否已到平台尾页。saveCursor 时落盘到游标 done 字段。 */
  private queryDone: Record<string, boolean> = {};
  /** 会话级绕圈时间戳：label→上次挖到尾页的时刻(ms)。用于 RESCAN_AFTER_DAYS 续鲜重置。 */
  private queryDoneAt: Record<string, number> = {};
  /** 续翻跳页点击上限（每次±5/直点，12 次约能跨 60 页；防异常分页器无限空耗配额）。 */
  private readonly MAX_RESUME_CLICKS = 12;
  /** 续翻跳页目标页安全上限（≈1000人深池起点；不一次跳到尾页把配额一次性烧光）。 */
  private readonly MAX_RESUME_PAGE = 50;
  /** 已挖满(到尾页)的组合距上次绕圈超过该天数 → 重置 depth/done 再挖一遍（续鲜：dedup 跳旧人只收新更新者）。 */
  private readonly RESCAN_AFTER_DAYS = 7;
  // ★ 2026-08-18 修复5（跨轮持久去重新增计数）：本轮净新增人数(已收录的跳过)。
  //   seenCardIds 是会话级；持久去重在 adapter.onCandidateSaved→upsertLiepinTalentIfNew，
  //   回写 liepinMeta.isNew，引擎据此计 newTalentsThisRun / skippedAlreadySeen。
  private newTalentsThisRun = 0;
  private skippedAlreadySeen = 0;
  private wsRecoveries = 0; // 推荐帧丢失后重定位次数（防提前判到底，也防死循环）
  private readonly MAX_WS_RECOVERIES = 3;
  // 块3 会话健康探针节流 + 指纹Cookie连续缺失计数（连续多次缺失升级为降速）
  private lastHealthProbeAt = 0;
  // 心跳看门狗：记录"上一次真正有进展"的时刻与当前在做什么
  private lastProgressAt = 0;
  private currentStage = '';
  private silenceWarnedAt = 0;
  private cookieGoneStreak = 0;
  private skeletonStreak = 0;   // 骨架屏连续命中（≥2 次即>45s，判卡死）
  private securityWarned = false; // 安全JS缺失本次运行只告警一次，避免刷屏
  // 本轮评分体检：统计各维度有没有真的产生区分度，收尾时把可执行建议写进日志
  private scoreAudit: ScoreAudit | null = null;
  private autoGreetMaster = false;   // F-3: 自动打招呼总闸（start 时从设置读取）
  private jdCache: JD[] = [];          // P1-15: 岗位库缓存，每轮任务只读一次 DB
  private jdCacheValid = false;        // P1-15: 缓存有效标志，JD 变更 IPC 置 false

  /** P1-15: 供 IPC 调用使 JD 缓存失效 */
  invalidateJdCache() {
    this.jdCacheValid = false;
    this.jdCache = [];
  }
  // P1-3: 事件驱动暂停（替代忙等待 sleep(500)）
  private pauseWaiters: Array<() => void> = [];
  private stopWaiters: Array<() => void> = [];
  // 日志批量写入
  private logBuffer: LogEntry[] = [];
  private logFlushTimer: NodeJS.Timeout | null = null;
  private static LOG_FLUSH_INTERVAL = 4000; // 4秒批量写一次
  private static LOG_MAX_BATCH = 50; // 最多攒50条
  // 真机校准：列表级模式（推荐流）——不点开详情，直接用卡片富数据评分落库（风控最低）。
  // 默认开；按平台 adapter.stageBEnabled() 决定是否开阶段B（猎聘第一轮默认关）。
  private listLevelMode = true;
  private candidateIndexOnPage = 0;
  // 猎聘三重配额门控：本次运行打开的详情数（跨多次运行累计由 this.rt().riskMonitor 日统计兜底）
  private detailsOpenedThisRun = 0;
  // H-4: 用户在风险对话框主动选择"继续使用，我知道风险"时标记，
  // 避免 attachRiskEvents 决定不暂停后，主循环又因 risk.level==='danger' 自我 pause。
  // 每次 risk.level 从非 danger 升到 danger 时重置（保证下一次 danger 还会触发对话框）。
  private dangerAcknowledged = false;
  private lastRiskLevel: string = 'safe';
  // M-01/M-02: 暂停时长扣除（effectiveElapsed 用）
  private pausedAccumMs = 0;
  private pauseStartedAt = 0;
  // M-03: 运行代号令牌，stop→start 竞态下防止旧运行 finally 清理/覆盖新运行状态
  private currentRunId = 0;
  // C-3: 页面/浏览器生命周期与崩溃自恢复
  private pageOwned = false; // 本引擎是否拥有该 page（dedicated 模式 newPage=true；existing 复用=false，不主动关）
  private closingPage = false; // 主动 close 时置位，避免 close 事件被误判为崩溃
  private pageDead = false; // crash/close/error/disconnected 事件先于操作抛错时的标记
  private browserDown = false; // 浏览器断开（不可恢复）标记
  private recovering = false; // 正在恢复中
  // ★ 2026-08-19 修复C：断连自恢复的互斥闩——watchdog(异步派发) 与 ensureQuery(同步等待)
  //   可能并发触发 tryRecoverBrowser。用此 promise 串行化：首个调用者持有它执行重连，
  //   重入调用者 await 同一个 promise 拿同一结果，绝不并发 disposePage/reconnect。
  private browserDownRecovering: Promise<boolean> | null = null;
  private lastListUrl = ''; // 断点：当前列表页 URL，恢复后重导航回此处
  private lastBreakpoint: { viewed: number; page: number; url: string; at: number } | null = null;

  // ── 搜索组合遍历（猎聘产量的真正来源；BOSS 退化为单个空组合，行为不变）──
  // 猎聘没有推荐流，产量来自「关键词 × 城市 × 行业」的笛卡尔积遍历。
  // ⚠️ 游标必须持久化：不持久化的话每次运行都从组合 #1 第 1 页重跑，抓回的是同一批人
  //    （DB 唯一索引会挡掉重复行），配额照吃而净新增趋近 0 —— 第二天起产量实际为零。
  private queries: SearchQuery[] = [];
  private queryIndex = 0;
  private pagesInQuery = 0;
  private queryMaxPages = Infinity;
  private queryStarted = false;
  // ★ 2026-08-19 防假成功门控：本轮是否至少有一个搜索组合真正 applySearch 成功过。
  //   "全部跑完一轮/任务结束"只有在浏览器没断 + 确有组合成功搜索过时才报绿色成功；
  //   否则（断连后空转、一上来就断）如实报"断连中止"，不报假成功。
  private hadSuccessfulSearchThisRun = false;
  private pageListeners: Array<{ target: any; event: string; handler: (...a: any[]) => void }> = [];
  private disconnectBrowserRef: Browser | null = null;
  private browserDisconnectHandler: (() => void) | null = null;
  // M-19: 广播节流（合并高频 change 事件，降低 IPC 体积/频率）
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmitAt = 0;
  private readonly EMIT_MIN_INTERVAL = 250;
  // M-21: 导出候选人去重（唯一键 -> 行 id），异常重试不产生重复行
  private exportedKeys = new Map<string, number>();

  // A8：platform 必传（无默认值）。引擎平台归属在实例化时锁定，由 runtime-registry 显式传入；
  // 不给默认值 'boss' 是为避免引擎里出现平台字面量（A8 断言：引擎必须完全平台无关）。
  constructor(platform: PlatformId) {
    super();
    this.platform = platform;
    this.state = {
      status: 'idle',
      elapsedMs: 0,
      stats: { viewed: 0, greeted: 0, favorited: 0, pagesBrowsed: 0, newTalents: 0, skippedAlreadySeen: 0 },
      logs: [],
    };
  }

  getState(): RPAState {
    return { ...this.state, stats: { ...this.state.stats } };
  }

  getTask(): RPATask | null {
    return this.task;
  }

  async start(task: RPATask, jd: JD | null, trigger: TriggerMode = 'manual'): Promise<StartResult> {
    // S1: 幂等命令面——已运行则返回结构化结果，供调度器/空闲服务判定
    if (this.running) return 'already-running';
    // M-03: 领取本次运行令牌；旧运行的 finally/循环通过比对 currentRunId 判断是否已被接管
    const myRunId = ++this.currentRunId;
    this.task = task;
    this.jd = jd;
    this.running = true;
    // ── 僵尸态修复（四线隔离 2026-07-29）────────────────────────────────────
    // try 必须从 running=true 的下一行就开始。此前 try 在几十行之后，而中间的
    // getSetting 在 DB 故障时会抛：异常逃出 start() → running 永远停在 true →
    // ensureRunning 恒返回 already-running、whenStopped 永不 resolve、stop() 无从
    // 落地——RPA 线整条僵死且无任何提示。running=true 之后的每一行都必须在 try 里。
    try {
      this.pauseReasons.clear(); // S1: 清空暂停来源集合
      this.consecutiveGreetFails = 0; // P1-2: 本次运行重置连续招呼失败计数
      this.autoGreetMaster = !!getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS).rpa?.enableAutoGreet; // F-3
      // 真机：默认列表级；按平台决定是否开阶段B（详情深挖）。
      // BOSS 仍走 deepScrape 全局开关；猎聘走 liepinEnableStageB（默认关，第一轮强制禁用阶段B）。
      const adapter = getPlatformAdapter(this.getPlatform());
      const settings = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
      this.listLevelMode = !adapter.stageBEnabled(settings);
      // 按当前档位 + 套餐推算每日配额上限，下推到 riskMonitor（风险中心进度条用）
      // BOSS 侧 pages/searches/details 恒为 0 → setQuotaLimits(0,0,0) 天然无害，不区分平台
      if (adapter.resolveDailyLimits) {
        const limits = adapter.resolveDailyLimits(task.speed.mode, settings);
        this.rt().riskMonitor.setQuotaLimits(limits.pages, limits.searches, limits.details);
      }
      this.stopRequested = false;
      this.candidateGreeted = false;
      this.candidateFavorited = false;
      // 2026-08-07 P1-12: 补四个跨运行不复位的字段 + consecutiveGreetFails
      this.detailsOpenedThisRun = 0;
      this.favoriteUnsupportedLogged = false;
      this.apiEmptyStreak = 0;
      this.consecutiveGreetFails = 0;
      this.dangerAcknowledged = false;
      // P1-15: 每轮任务缓存无效化，下一调用 allJdsForScoring 时重新加载
      this.jdCacheValid = false;
      this.jdCache = [];
      this.lastRiskLevel = 'safe';
      // M-01/M-02: 重置暂停累计
      this.pausedAccumMs = 0;
      this.pauseStartedAt = 0;
      // C-3: 重置崩溃/恢复相关状态
      this.pageDead = false;
      this.browserDown = false;
      this.recovering = false;
      this.lastListUrl = '';
      this.lastBreakpoint = null;
      // ★ 2026-08-19：本轮成功搜索标记复位（防假成功门控用）
      this.hadSuccessfulSearchThisRun = false;
      // M-21: 重置本次运行去重表
      this.exportedKeys.clear();
      this.state = {
        status: 'running',
        taskId: task.id,
        trigger, // S1: 记录本次运行触发来源（手动/定时/空闲）
        pauseReasons: [],
        startedAt: Date.now(),
        elapsedMs: 0,
        currentPage: '启动中...',
        stats: { viewed: 0, greeted: 0, favorited: 0, pagesBrowsed: 0, newTalents: 0, skippedAlreadySeen: 0 },
        logs: [],
      };
      this.log('info', `RPA 启动，任务：${task.name}`);
      this.emitState();
      // 阶段7 运行日志留痕（只记录，不改行为）：启动是状态机外的关键动作，
      // start() 直赋 status='running' 不走 transition()，故单独记一条。
      // 无 PII：task.name 可能含岗位/业务词，只记 task.id 哈希 + trigger + speed + 阶段B开关。
      try {
        oplog('rpa', 'start', {
          taskIdHash: hashId(task.id), trigger, speed: task.speed?.mode,
          stageB: !this.listLevelMode,
        }, { platform: this.getPlatform() });
      } catch { /* 日志绝不影响启动 */ }

      // M-3: 1s tick 更新 elapsedMs（M-01/M-02: 用扣除暂停后的有效时长）
      // M-19: tick 只做轻量计时增量，广播走节流的 scheduleEmit，避免每秒携带全量 logs
      this.tickTimer = setInterval(() => {
        if (this.currentRunId !== myRunId) return;
        if (this.state.startedAt && this.state.status === 'running') {
          this.state.elapsedMs = this.effectiveElapsed();
          // 轻量计时事件（供 IPC 层选择性转发，不含 logs）
          this.emit('tick', { elapsedMs: this.state.elapsedMs, status: this.state.status });
          this.scheduleEmit();
        }
        // ⚠️ 看门狗必须【也覆盖 paused】。卡在暂停态同样是"什么都不发生"的黑洞：
        // 若某条路径静默地把引擎挂在 waitForResumeOrStop 上，只在 running 时播报等于没播。
        if (this.state.status === 'running' || this.state.status === 'paused') this.watchdogTick();
      }, 1000);

      // H6-1: 启动前清理可能遗留的 page/op 引用，防孤儿 tab
      await this.disposePage();
      // 真机隐身：只用用户已登录的浏览器，【绝不新开 tab】（新 tab 导航会被 BOSS 判为自动化 →
      // 关窗 + 连累登出）。优先复用"推荐牛人"页；否则任一 zhipin 页；都没有才提示用户先打开。
      this.browser = this.rt().chrome.getBrowser();
      if (!this.browser) {
        // ★ 文案必须按平台取。原来硬编码「打开 BOSS 浏览器」：猎聘启动失败时，
        //   日志和弹窗都在让用户去开 BOSS 浏览器 —— 用户照做也永远修不好猎聘。
        //   2026-08-05 真机日志里连着两条就是这个误导文案。
        const ad = this.getAdapter();
        throw new Error(`浏览器未连接，请先在设置里点「打开${ad.name}浏览器」并登录后再开始`);
      }
      const pages = await this.browser.pages();
      const workPage = this.findWorkPage(pages);
      if (!workPage) {
        const adapter = this.getAdapter();
        throw new Error(`未找到 ${adapter.name} 工作面，请在浏览器里进入对应页面后再开始找人`);
      }
      this.page = workPage;
      this.pageOwned = false; // 永远复用用户的页，结束不主动关
      // 精密防范模型关键接线：复用的已存在页不经过 targetcreated，必须在此确保挂上风控响应监控，
      // 否则网络层信号（code:35 / 403 / 429 / Boss端100xx）对真正的 RPA 目标页永不触发。
      this.rt().chrome.ensureRiskMonitor(this.page);
      this.op = new HumanOperator(this.page, resolveBehaviorProfile(task.speed));
      // C-3: 注册页面/浏览器生命周期监听（崩溃/关闭/断连）
      this.attachPageLifecycle();

      this.riskListener = () => { /* 风险变化由 attachRiskEvents 统一处理 */ };
      this.rt().riskMonitor.on('change', this.riskListener);

      await this.runTask(myRunId);
      return 'started';
    } catch (e: any) {
      // C-3: 页面已死类错误若走到这里（初始导航等），也归为 error 并记录断点
      if (this.isFatalPageError(e)) {
        this.log('error', `页面崩溃/浏览器断开导致运行终止：${e?.message || e}`);
        this.recordBreakpoint();
      } else {
        this.log('error', `运行出错：${e?.message || e}`);
      }
      this.transition('error'); // S1: 集中状态转移
      return 'started'; // 已实际启动过（运行中出错），供调用方判定
    } finally {
      // M-03: 若已被新的 start 接管，交给新运行清理，绝不触碰共享资源
      // S1: 旧运行被接管——不落地 stop 信号（由接管的新运行 finally 统一 resolve），返回结构化占位值
      if (this.currentRunId !== myRunId) {
        // eslint-disable-next-line no-unsafe-finally
        return 'already-running';
      }
      this.running = false;
      // 收尾再落一次搜索组合游标：切组合时已经存过，这里是"被停止/出错/到点收工"
      // 这几条路径的兜底，保证下次运行能从当前组合继续而不是从头重跑。
      try { this.saveCursor(); } catch { /* 存不下不影响收尾 */ }
      if (this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      if (this.emitTimer) {
        clearTimeout(this.emitTimer);
        this.emitTimer = null;
      }
      if (this.logFlushTimer) {
        clearTimeout(this.logFlushTimer);
        this.logFlushTimer = null;
      }
      this.flushLogs(true);
      if (this.riskListener) {
        this.rt().riskMonitor.off('change', this.riskListener);
        this.riskListener = null;
      }
      // C-3/H6-1: 清崩溃监听 + 关闭本引擎拥有的 page，防 tab/CDPSession 泄漏
      await this.disposePage();
      // S1: finally 收尾竞态——disposePage 为 async await 点，期间可能被新 start 接管，
      // 在写 status='stopped'/elapsedMs/updateTaskLastRun/emitState 前再确认令牌，防旧尾覆盖新运行
      if (this.currentRunId !== myRunId) {
        // eslint-disable-next-line no-unsafe-finally
        return 'already-running';
      }
      // M-01/M-02: 若结束时仍处暂停，先结算暂停区间
      if (this.isPaused) this.accumulatePause();
      this.pauseReasons.clear(); // S1: 清空暂停来源集合
      if (this.state.status !== 'error') {
        this.state.status = 'stopped';
      }
      if (this.state.startedAt) this.state.elapsedMs = this.effectiveElapsed();
      // 阶段7 运行日志留痕（只记录，不改行为）：停止是状态机外的关键动作，
      // finally 直赋 status='stopped' 不走 transition()，故单独记一条收尾。
      // 无 PII：只记本次浏览量、有效运行时长、终态（stopped/error）。
      try {
        oplog('rpa', 'stop', {
          reason: this.state.status === 'error' ? 'error' : (this.stopRequested ? 'stop' : 'completed'),
          viewed: this.state.stats?.viewed ?? 0,
          greeted: this.state.stats?.greeted ?? 0,
          durationMs: this.state.elapsedMs ?? 0,
          finalStatus: this.state.status,
        }, { platform: this.getPlatform() });
      } catch { /* 日志绝不影响收尾 */ }
      // M-24: 更新任务 last_run_at 与本次运行时长
      this.updateTaskLastRun();
      this.emitState();
      persistImmediate();
      this.resolveStopped(); // S1: stop→真正落地信号（whenStopped/stopAndWait 的等待点）
    }
  }

  /**
   * 标记"现在走到哪一步了"。心跳看门狗据此判断有没有卡住，卡住时也能说清卡在哪。
   * 只在内存里记两个字段，无 IO、无广播，可以随便调。
   */
  private mark(stage: string) {
    this.currentStage = stage;
    this.lastProgressAt = Date.now();
    this.silenceWarnedAt = 0;
  }

  /**
   * 心跳看门狗（每秒随 tick 跑一次）。
   *
   * 为什么必须有：2026-07-29 真机那次，浏览器 16:01:39 断开后引擎【整整 17 分钟一条日志都没有】，
   * 事后我把所有能阻塞的路径（帧求值挂起、各类暂停、节奏等待）逐一实测/推演排除，
   * 仍然无法复原它当时在做什么——因为根本没有任何痕迹留下来。
   * 一个跑在别人真实账号上的自动化程序，不允许存在"事后查不出来"的静默黑洞。
   * 现在：超过 SILENCE_WARN_MS 没有任何进展就如实播报卡在哪一步，之后每分钟再播一次。
   */
  private static readonly SILENCE_WARN_MS = 90 * 1000;
  // ★ 2026-08-19 修复C：browserDown 后看门狗触发自恢复的静默阈值。
  //   断连事件(browserDown/pageDead)由生命周期回调即时置位，但若引擎恰好卡在某个 await
  //   点上（pace 长休/熔断冷却），可能 90s 内都不经过 ensureQuery 的断连检查。看门狗兜底：
  //   断连超过此时长就主动派发重连，不再等主循环自己撞到检查点。
  private static readonly BROWSER_DOWN_GIVEUP_MS = 90 * 1000;
  private watchdogTick() {
    if (!this.lastProgressAt) return;
    const idle = Date.now() - this.lastProgressAt;
    if (idle < RPAEngine.SILENCE_WARN_MS) return;
    // 已经播报过就每 60 秒再播一次，别把日志刷满
    if (this.silenceWarnedAt && Date.now() - this.silenceWarnedAt < 60000) return;
    this.silenceWarnedAt = Date.now();
    this.log('warn', `已有 ${Math.round(idle / 1000)} 秒没有任何进展，当前停在：${this.currentStage || '未知步骤'}`
      + `（状态 ${this.state.status} / 页面${this.pageDead ? '已死' : '正常'}`
      + ` / 浏览器${this.browserDown ? '已断开' : '已连接'}`
      + `${this.isPaused ? ' / 暂停来源：' + (Array.from(this.pauseReasons).join(',') || '无') : ''}）`);

    // ★ 2026-08-13：无人值守下的【死等】必须有上限。
    //   风控 danger 暂停原本等的是界面弹框里用户点「继续」，但无人值守时根本没人点——
    //   真机实测卡在 riskDanger 足足 29 分钟，每 60 秒刷一条同样的警告，
    //   既不推进也不结束，日志被刷满而真正的原因只在最开始出现过一次。
    //   超过阈值就【正常收工】：不是失败，是"这次到此为止"，把结论说清楚比空转有价值。
    //   （手动暂停 'manual' 不在此列——那是人有意按下的，等多久都合理。）
    const AUTO_PAUSE_GIVEUP_MS = 8 * 60 * 1000;
    if (this.isPaused && idle >= AUTO_PAUSE_GIVEUP_MS) {
      const reasons = Array.from(this.pauseReasons).filter((r) => r !== 'manual');
      if (reasons.length && !this.pauseReasons.has('manual')) {
        this.log('warn', `已暂停 ${Math.round(idle / 60000)} 分钟仍未恢复（来源：${reasons.join(',')}），`
          + '无人值守下不再空等，本次运行到此结束。'
          + '若是风控暂停，请在浏览器里人工确认账号状态（完成验证/正常浏览几页）后再重新开始。');
        this.stopRequested = true;
      }
    }

    // ★ 2026-08-19 修复C【看门狗对 browserDown 生效】：browserDown 不在原 8 分钟放弃之列
    //   （它只对"自动暂停"生效 + 手动暂停豁免），而真机 2026-08-18 浏览器断开后引擎
    //   【空转 14 分钟】直到"跑完一轮"假成功——browserDown 全程没被任何停机路径拦下。
    //   现在：browserDown（或 pageDead 连续静默）超过 90s，无论 running/paused 都触发重连。
    //   browserDown 不适用"手动暂停豁免"——浏览器都断了，等人点继续也没意义。
    //   重连成功则继续；重连不成则干净停机，不空转、不假成功。
    if (this.isBrowserDown() && !this.browserDownRecovering && idle >= RPAEngine.BROWSER_DOWN_GIVEUP_MS) {
      this.log('warn', `浏览器断开已 ${Math.round(idle / 1000)} 秒，看门狗触发自恢复（不受手动暂停豁免）…`);
      // fire-and-forget：watchdogTick 是同步的，重连是异步的。tryRecoverBrowser 内部用
      // browserDownRecovering promise 互斥，每秒 tick 重复进来时它非空即跳过，不会重入。
      // runId 取当前值，若期间被接管则 tryRecoverBrowser 自行退出。
      const myRunId = this.currentRunId;
      void this.tryRecoverBrowser(myRunId).then((ok) => {
        if (this.currentRunId !== myRunId || this.stopRequested) return;
        if (!ok) {
          this.log('error', `看门狗：浏览器断开重连失败，本次运行中止。`
            + `已浏览${this.state.stats?.viewed ?? 0}人/新增${this.state.stats?.newTalents ?? 0}人。`
            + '请检查并重开 Chrome 调试实例后重启 RPA。');
          this.rt().riskMonitor.recordAnomaly('浏览器断开且重连失败（本地环境故障，非平台风控）', 'notice');
          this.recordBreakpoint();
          this.stopRequested = true; // 干净停机，交主循环 finally 收尾
        }
        // 重连成功：reconnectBrowser 已重置 browserDown/pageDead，下一轮 tick 重新计时。
        // 主循环会在 ensureQuery/操作段恢复推进。
      });
    }
  }

  // S1: 集中状态转移——所有对 state.status 的重赋值统一走此（内部 emitState），
  // 防 recover 与自动暂停/风险联动互相覆盖 status。reason 仅用于可读性/后续埋点。
  private transition(to: RPAStatus, reason?: string) {
    const from = this.state.status;
    this.state.status = to;
    this.emitState();
    // 运行日志（只记录，不改变任何行为）：状态机轨迹是事后还原"它当时在干嘛"的主线索
    try {
      oplog('rpa', 'transition', {
        from, to, reason: reason || '', viewed: this.state.stats?.viewed ?? 0,
      }, { platform: this.getPlatform() });
    } catch { /* 日志失败绝不影响状态机 */ }
    void reason;
  }

  // ---- S1: 暂停来源集合原语 ----
  get isPaused(): boolean {
    return this.pauseReasons.size > 0;
  }

  // 加入一个暂停来源；集合从空到非空的沿触发时记录暂停起点（供暂停时长扣除）
  private addPause(reason: PauseReason) {
    const wasPaused = this.isPaused;
    this.pauseReasons.add(reason);
    if (!wasPaused && this.isPaused) this.pauseStartedAt = Date.now();
  }

  // 移除一个暂停来源；集合从非空到空的沿触发时结算本次暂停区间
  private removePause(reason: PauseReason) {
    const wasPaused = this.isPaused;
    this.pauseReasons.delete(reason);
    if (wasPaused && !this.isPaused) this.accumulatePause();
  }

  // 进入暂停态（幂等）：加来源 + 转 paused（集合已非空时 status 已是 paused，转移幂等）
  private enterPause(reason: PauseReason) {
    if (this.pauseReasons.has(reason)) return;
    this.addPause(reason);
    this.transition('paused', `pause:${reason}`);
  }

  // 尝试真正恢复：仅当集合清空后才转回 running；否则保持 paused（仍有其他暂停来源）
  private tryResumeRunning(): boolean {
    if (this.isPaused) {
      this.emitState(); // 更新 pauseReasons 快照
      return false;
    }
    // 唤醒所有等待暂停解除的 await
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const w of waiters) { try { w(); } catch {} }
    this.transition('running');
    return true;
  }

  // P1-3: 事件驱动暂停等待——暂停时 await，暂停解除或stop时 resolve
  private waitForResumeOrStop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isPaused || this.stopRequested) { resolve(); return; }
      this.pauseWaiters.push(resolve);
    });
  }

  // 唤醒所有等待stop的await
  private notifyStop() {
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    // ⚠️ pauseWaiters 必须【逐个 resolve】，不能只清空数组。
    // 旧实现 `this.pauseWaiters = []` 把 resolver 直接丢了：主循环正 await
    // waitForResumeOrStop() 时点「停止」，那个 await 永远不返回 → finally 不执行 →
    // running 恒为 true、status 卡死、之后所有 start 都返回 already-running，只能重启 App。
    // 触发场景很常见：风险 danger 自动暂停后用户点停止。
    const paused = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const w of waiters) { try { w(); } catch {} }
    for (const w of paused) { try { w(); } catch {} }
  }

  // S1: stop 落地信号——resolve 所有等待 whenStopped 的 promise
  private resolveStopped() {
    if (this.stoppedResolvers.length) {
      const rs = this.stoppedResolvers;
      this.stoppedResolvers = [];
      for (const r of rs) {
        try {
          r();
        } catch {}
      }
    }
  }

  // 手动暂停：加 'manual' 来源
  pause() {
    if (!this.running || this.pauseReasons.has('manual')) return;
    this.enterPause('manual');
    this.log('info', 'RPA 已暂停');
  }

  // 手动恢复（UI「继续」按钮）：删 'manual'；若剩下的只是风控类暂停，视为用户明确"我已处理"，
  // 一并解闩恢复——原实现只删 'manual'，被 riskDanger/riskPage 暂停时按钮点了完全没反应。
  // idleAuto 不在此清除（那由空闲服务自己管）。
  resume() {
    if (!this.running) return;
    if (this.pauseReasons.has('manual')) this.removePause('manual');
    if (this.pauseReasons.has('riskDanger') || this.pauseReasons.has('riskPage')) {
      this.acknowledgeDangerAndContinue();
      return;
    }
    if (this.tryResumeRunning()) {
      this.log('info', 'RPA 已恢复');
      return;
    }
    // ⚠️ 原来这里的文案硬编码成"仍有其他暂停来源（空闲）"，归因是错的：
    // windowHidden 暂停时点「继续」也会走到这条，用户看到"空闲"完全对不上，
    // 而且不知道自己该做什么（该做的是把浏览器窗口露出来）。改为如实列出剩余来源。
    const LABEL: Record<string, string> = {
      manual: '手动暂停', idleAuto: '空闲自动暂停',
      riskDanger: '风险等级过高', riskPage: '页面出现风控',
      windowHidden: '浏览器窗口不可见（最小化或被其它窗口盖住）',
    };
    const left = [...this.pauseReasons].map((k) => LABEL[k] || k);
    if (this.pauseReasons.has('windowHidden')) {
      this.log('warn', `无法继续：${left.join('、')}。请把 Chrome 窗口露出来并让 BOSS 标签页处于前台，`
        + '窗口恢复后会自动继续，无需再点。');
    } else {
      this.log('info', `RPA 手动恢复：仍有其他暂停来源（${left.join('、')}），保持暂停`);
    }
  }

  // H-4: 用户在风险对话框点击"继续使用，我知道风险"时调用——只删风险两来源，不动 idleAuto/manual
  acknowledgeDangerAndContinue() {
    // M-04: 仅当任务确实仍在进行（running/paused 且未结束）才允许恢复；
    // 任务已自然结束后点击"继续"不应把 status 错误改回 running
    if (!this.running || (this.state.status !== 'running' && this.state.status !== 'paused')) {
      this.log('warn', '任务已结束，忽略"继续运行"请求');
      return;
    }
    // ⚠️ 已经在停机流程中就绝不能"继续"。
    // 硬信号（验证码/账号受限/入口层二次触发）走的是 handleSignal → stop()，
    // 而 stop() 不改 status，于是这一刻 status 仍是 'running'、this.running 仍是 true，
    // 上面那道 M-04 守卫拦不住。后果是最危险的一条：平台刚判过的账号，
    // 被一次"继续使用"清掉落盘的人工确认闩与退避，随后调度可以立刻重开跑。
    if (this.stopRequested) {
      this.log('warn', '本次运行已因风控信号停止，"继续"不适用；请人工确认账号无异常后到风险中心解除');
      return;
    }
    this.dangerAcknowledged = true;
    const hadRisk = this.pauseReasons.has('riskDanger') || this.pauseReasons.has('riskPage');
    // 关键修复：用户明确"我知道风险、继续"= 已人工处理，必须同时解掉 this.rt().riskMonitor 的异常闩
    // （pageAnomaly/accountRestricted）与冷却/熔断；否则 level 永远停在 danger，
    // 下一圈主循环又会自我暂停，且因等级未跳变而不再弹框 → 表现为"点了继续也没反应"。
    // clearBackoff:false —— 只解等级闩让任务能继续，绝不顺手清掉平台退避与入口层升级额度
    this.rt().riskMonitor.clearAll('用户在风险对话框选择「继续使用，我知道风险」', { clearBackoff: false });
    // 关键正确性：ack 只删 risk*，若用户回来触发的 idleAuto 仍在集合中，则不会误恢复
    this.removePause('riskDanger');
    this.removePause('riskPage');
    if (!hadRisk) return;
    if (this.tryResumeRunning()) {
      this.log('warn', '用户确认知晓风险，继续运行');
    } else {
      this.log('warn', '用户确认知晓风险，但仍有其他暂停来源（空闲/手动），保持暂停');
    }
  }

  // S1: 空闲服务用——用户返回/需要让路时暂停（加 'idleAuto'）
  pauseByIdle() {
    if (!this.running || this.pauseReasons.has('idleAuto')) return;
    this.enterPause('idleAuto');
    this.log('info', 'RPA 空闲自动化暂停（检测到用户活动）');
  }

  // S1: 空闲服务用——重新空闲时恢复（只删 'idleAuto'）；仅当集合清空才真正恢复
  resumeByIdle() {
    if (!this.pauseReasons.has('idleAuto')) return;
    this.removePause('idleAuto');
    if (this.tryResumeRunning()) {
      this.log('info', 'RPA 空闲自动化恢复');
    } else {
      this.log('info', 'RPA 空闲恢复请求：仍有其他暂停来源，保持暂停');
    }
  }

  // 接口层"返空"的连续次数（与 DOM 路径同口径，连续 3 次才判降权）
  private apiEmptyStreak = 0;
  // 环境类启动拒绝（窗口不可见等）。供启动编排层退避、以及同因告警去重。
  private lastStartRefusal: { at: number; reason: string } | null = null;
  private refusalReportedAt = new Map<string, number>();
  private static readonly REFUSAL_REPORT_GAP_MS = 10 * 60 * 1000;

  /** 最近一次"环境类拒绝启动"，供 rpa-launcher 决定要不要挡住自动重试 */
  getLastStartRefusal(): { at: number; reason: string } | null { return this.lastStartRefusal; }

  /** 同因告警去重：同一原因 10 分钟内只报一次，避免本地噪声灌满风险历史 */
  private shouldReportRefusal(key: string): boolean {
    const last = this.refusalReportedAt.get(key) || 0;
    if (Date.now() - last < RPAEngine.REFUSAL_REPORT_GAP_MS) return false;
    this.refusalReportedAt.set(key, Date.now());
    return true;
  }

  /** 是否已经在停机流程中（stop 已下达但主循环尚未退出）。
   *  ⚠️ state.status 在这段时间里仍然是 'running'——它要等 start() 的 finally 才变 'stopped'。
   *  只看 status 的调用方会误以为任务还活着，风险决策框正是栽在这上面（见 ipc/risk.ts）。 */
  isStopping(): boolean { return this.stopRequested; }

  stop() {
    this.stopRequested = true;
    if (this.isPaused) this.accumulatePause();
    this.pauseReasons.clear();
    this.notifyStop(); // 唤醒所有等待暂停解除/stop的 await
    this.log('info', 'RPA 停止中...');
    this.flushLogs(true); // 停止时立即刷写日志
  }

  // P2-6: 批量日志写入（每4秒或积累50条写一次）
  private flushLogs(force = false) {
    try {
      if (!this.logBuffer.length) return;
      if (!force && this.logBuffer.length < RPAEngine.LOG_MAX_BATCH) return;
      const db = getDb();
      const stmt = db.prepare(
        'INSERT INTO rpa_logs (date, time, level, task_id, platform, message) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const tx = db.transaction((entries: LogEntry[]) => {
        for (const e of entries) {
          stmt.run(
            new Date(e.time).toISOString().slice(0, 10),
            e.time, e.level, this.task?.id || null, this.getPlatform(), e.message,
          );
        }
      });
      tx(this.logBuffer);
      this.logBuffer = [];
    } catch {}
  }

  private scheduleLogFlush() {
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = null;
      this.flushLogs(true);
    }, RPAEngine.LOG_FLUSH_INTERVAL);
    if (this.logFlushTimer.unref) this.logFlushTimer.unref();
  }

  // S1: 幂等命令面——供调度器/空闲服务调用；不会重复起并发运行
  //  - running 且未暂停 → 'already-running'
  //  - 因 idleAuto 暂停 → resumeByIdle() 并返回 'resumed'
  //  - 未运行 → start(...)（fire-and-forget，立即返回 'started'）
  async ensureRunning(
    task: RPATask,
    jd: JD | null,
    trigger: TriggerMode = 'manual',
  ): Promise<StartResult | 'resumed'> {
    if (this.running) {
      if (this.pauseReasons.has('idleAuto')) {
        this.resumeByIdle();
        return 'resumed';
      }
      return 'already-running';
    }
    // start() 直到任务结束才 resolve，这里 fire-and-forget，立即返回启动结果
    void this.start(task, jd, trigger).catch((e) => {
      this.log('error', `ensureRunning 启动失败：${e?.message || e}`);
    });
    return 'started';
  }

  // S1: 返回一个在本次运行真正落地（finally 完成）时 resolve 的 promise；未运行则立即 resolve
  whenStopped(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise<void>((resolve) => this.stoppedResolvers.push(resolve));
  }

  // S1: 请求停止并等待旧运行完全落地——供 dedicated 模式 stop→start 快切时等旧运行清理完成
  async stopAndWait(): Promise<void> {
    if (!this.running) return;
    const done = this.whenStopped();
    this.stop();
    await done;
  }

  // 可被 stop/接管打断的长休眠：分 ≤1s 片检查 stopRequested/接管，避免多分钟冷却期间 stop 要等到结束才响应。
  // stopUntilNight：等待期间若跨入禁跑时段就提前结束等待，让主循环的夜闸立刻接管。
  // 熔断冷却最长 60min、宏观长休 5-10min，不分片检查的话会一路睡过 22:00 才醒来。
  private async interruptibleSleep(ms: number, myRunId: number, stopUntilNight = true) {
    const end = Date.now() + ms;
    // ★ 2026-08-19 修复D【休息期保活防断连】：长休息(3-8min)/熔断冷却期间 CDP websocket
    //   空闲可能被 Chrome/网络层挂起掉线，标签页也可能被 Chrome 后台冻结。等休完才发现断连
    //   已晚（2026-08-18 正是休完 4 分钟后 ~40s 断的）。休期间每 ~15s 做一次轻量 CDP 保活：
    //   page.evaluate('1') + Page.bringToFront——读操作，不发平台请求、不碰反风控配额，只保持
    //   websocket 活跃并提前发现断连。保活失败即置 pageDead/browserDown，交 ensureQuery/watchdog 做重连。
    //   ★ 2026-08-20 P0：30s→15s，并加 Page.bringToFront。c-in-c 真机两轮实证 ~46min 崩都在长暂停
    //     之后：page.evaluate('1') 挡不住 Chrome 对【被遮挡窗口】的丢弃（那是窗口级冻结，在 evaluate
    //     之下），需配合启动参数(CalculateNativeWinOcclusion 等，见 chrome.ts)根治。缩频到 15s 能更早
    //     撞见断连并交重连，bringToFront 进一步阻止后台丢弃。保活失败仍走现有重连流程，不变。
    const KEEPALIVE_INTERVAL = 15 * 1000;
    let lastKeepaliveAt = Date.now();
    while (Date.now() < end) {
      if (this.stopRequested || this.currentRunId !== myRunId) break;
      if (stopUntilNight && this.rt().riskMonitor.isNightNow()) break;
      await sleep(Math.min(1000, end - Date.now()));
      // 保活：到点且仍在等（且没已断连，否则交给重连流程即可）。
      if (!this.browserDown && this.page && Date.now() - lastKeepaliveAt >= KEEPALIVE_INTERVAL) {
        lastKeepaliveAt = Date.now();
        await this.cdpKeepalive();
      }
    }
  }

  /**
   * 轻量 CDP 保活：page.evaluate('1') + page.bringToFront()，或 browser.version()。
   * 成功=连接仍活；失败=websocket 已断，置 pageDead/browserDown 触发重连（修复A/C）。
   * 绝不发任何平台请求、不点任何元素、不触发懒加载——纯读 + 焦点通知，零风控配额影响。
   *
   * ★ 2026-08-20 P0：除 page.evaluate('1') 外，加一次 page.bringToFront()（CDP Page.bringToFront）。
   *   evaluate 挡不住 Chrome 对【被遮挡窗口】的丢弃（窗口级冻结发生在 evaluate 之下），
   *   bringToFront 显式要求 Chrome 把本标签提到前台 / 标记活跃，更有效阻止后台丢弃。
   *   配合启动参数(CalculateNativeWinOcclusion 等，见 chrome.ts)从根上防遮挡冻结。
   *   两者任一成功即视为连接仍活；均失败才落 browser.version() 探测，再失败才判断连。
   */
  private async cdpKeepalive(): Promise<void> {
    const page = this.page;
    const browser = this.rt().chrome.getBrowser();
    try {
      if (page) {
        await page.evaluate('1');
        // bringToFront：保持标签活跃、阻止后台丢弃；失败不致命（evaluate 已证连接活）。
        await page.bringToFront().catch(() => {});
        return;
      }
    } catch {
      // 页面级 evaluate 失败：可能是页死了或连接断了，落下面 browser 探测
    }
    try {
      if (browser) {
        await browser.version();
        return;
      }
    } catch {
      // 浏览器级探测也失败 → 确认断连
    }
    // 两种探测都失败：标记断连，交重连流程处置。不在此重抛——interruptibleSleep 是
    // 等待循环，抛错会打断休息语义；置标记后看门狗/ensureQuery 会在下个检查点接管。
    if (!this.pageDead && !this.browserDown) {
      this.log('warn', '休息期 CDP 保活失败——浏览器/页面连接可能已断开，将尝试重连');
      this.pageDead = true;
      this.browserDown = !this.rt().chrome.getBrowser();
    }
  }

  // M-01/M-02: 有效运行时长 = 墙钟经过 - 已累计暂停 -（当前若仍暂停则再减去正在进行的暂停区间）
  private effectiveElapsed(now = Date.now()): number {
    const started = this.state.startedAt || now;
    let paused = this.pausedAccumMs;
    if (this.isPaused && this.pauseStartedAt) paused += now - this.pauseStartedAt;
    const eff = now - started - paused;
    return eff > 0 ? eff : 0;
  }

  // M-01/M-02: 结算一次暂停区间到累计值
  private accumulatePause() {
    if (this.pauseStartedAt) {
      this.pausedAccumMs += Date.now() - this.pauseStartedAt;
      this.pauseStartedAt = 0;
    }
  }

  // M-19: 立即广播 state（关键状态跳变用）；清掉待触发的节流定时器
  private emitState() {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.state.pauseReasons = Array.from(this.pauseReasons); // S1: 同步暂停来源集合快照
    this.lastEmitAt = Date.now();
    this.emit('change', this.state);
  }

  // M-19: 合并高频广播（日志/计时），最小间隔 EMIT_MIN_INTERVAL
  private scheduleEmit() {
    if (this.emitTimer) return;
    const since = Date.now() - this.lastEmitAt;
    const delay = since >= this.EMIT_MIN_INTERVAL ? 0 : this.EMIT_MIN_INTERVAL - since;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.state.pauseReasons = Array.from(this.pauseReasons); // S1: 同步暂停来源集合快照
      this.lastEmitAt = Date.now();
      this.emit('change', this.state);
    }, delay);
  }

  /**
   * 当前任务的平台 ID。
   * L8(阶段1):优先取任务自带平台，其次取构造时锁定的 this.platform，最后兜底 BOSS。
   * 任务平台应与引擎归属一致；这里的多层兜底纯属防御性，不改抓取内核。
   */
  private getPlatform(): PlatformId {
    return (this.task?.platform || this.platform || PLATFORMS[0]) as PlatformId;
  }

  private getAdapter() {
    return getPlatformAdapter(this.getPlatform());
  }

  /** 取当前任务所属平台的运行时（chrome / riskMonitor / riskController / engine）。 */
  private rt() {
    return getRuntime(this.getPlatform());
  }

  /** 从已打开的页面列表中找回工作面（优先 isAttachedToWorkSurface，其次 hostPattern 兜底）。 */
  private findWorkPage(pages: Page[]): Page | null {
    const adapter = this.getAdapter();
    for (const p of pages) {
      try { if (adapter.isAttachedToWorkSurface(p)) return p; } catch { /* 页面可能刚关闭 */ }
    }
    for (const p of pages) {
      try { if (adapter.hostPattern.test(new URL(p.url()).hostname)) return p; } catch { /* 同上 */ }
    }
    return null;
  }

  private getGreetMessage(): string {
    if (this.task?.actions?.greetTemplate) return this.task.actions.greetTemplate;
    return '您好，看到您的经历很匹配，方便聊聊吗？';
  }

  // C-3: 注册 page（crash/close/error）与 browser（disconnected）生命周期监听
  private attachPageLifecycle() {
    this.detachPageLifecycle(); // 幂等：先清旧的，避免泄漏
    const page = this.page;
    if (!page) return;
    const onCrash = (err?: any) => this.onPageDead('crash', err);
    const onClose = () => {
      // H6-1: 我们主动 close 时（disposePage）不当作崩溃
      if (!this.closingPage) this.onPageDead('close');
    };
    const onError = (err?: any) => this.onPageDead('error', err);
    page.on('crash', onCrash);
    page.on('close', onClose);
    page.on('error', onError);
    // R2-2026-07-24: API层风控信号监听（code:35/HTTP403/429/异常消息）
    // 精密防范模型：不再一律硬停——按信号 kind 走 handleSignal → this.rt().riskController.onSignal 分级处置。
    //   stop=硬停+冷却；slow=不停，标记需降速+冷却（主循环据冷却强制长休降速）；warn=告警。
    const onApiRisk = (sig: any) => {
      if (this.stopRequested || !this.running) return;
      const kind: string = sig.kind || 'apiCode35';
      // 接口层"这一次返空"不是信号，只是一次观察。与 DOM 路径同口径累计到连续 3 次
      // 才当作 emptyData 处置——正常"今天看完了"也会返空，一次就熔断等于每轮都记假降权。
      if (kind === 'emptyDataOnce') {
        this.apiEmptyStreak++;
        if (this.apiEmptyStreak >= 3) {
          this.apiEmptyStreak = 0;
          this.handleSignal('emptyData', `推荐列表接口连续 3 次返空`);
        } else {
          this.log('info', `推荐列表接口返空（第 ${this.apiEmptyStreak} 次，连续 3 次才判降权）`);
        }
        return;
      }
      this.handleSignal(kind as DefenseSignalKind, `${sig.message || ''} (code=${sig.code})`);
    };
    // R2-2026-07-24: Boss端Security模块静默上报监听（比验证码更早的信号）
    const onBossSecReport = (rep: any) => {
      if (this.stopRequested || !this.running) return;
      const desc = this.getAdapter().describeSecReport(rep.p2);
      this.handleSignal('bossSecReport', desc);
    };
    // Boss端上报载荷不可读（puppeteer 拿不到 postData）→ 监控可能失效，必须让人知道，不能静默
    const onSecUnreadable = () => {
      if (this.apmUnreadableWarned || !this.running) return;
      this.apmUnreadableWarned = true;
      this.log('warn', 'Boss端安全上报(zpApm/actionLog)载荷不可读，100xx 环境检测监控本次可能无法生效——请真机抓一次该请求核对载荷格式');
      this.rt().riskMonitor.recordAnomaly('Boss端安全上报载荷不可读（100xx 监控可能失效）', 'notice');
    };
    // 平台化静默上报（猎聘 = security.min.js → statistic.liepin.com/standardFLog）。
    // 与 BOSS 的 zpApm 通道并列：BOSS 走 boss-security-report（p2 码表），
    // 平台化通道走 security-report（adapter 的 parseSecReport 已解析出可读描述）。
    const onPlatformSecReport = (rep: any) => {
      if (this.stopRequested || !this.running) return;
      const kind = this.getAdapter().secReportSignalKind;
      this.handleSignal(kind, `${rep?.desc || '安全检测上报'}（code=${rep?.code ?? '?'}）`);
    };
    const onPlatformSecUnreadable = () => {
      if (this.apmUnreadableWarned || !this.running) return;
      this.apmUnreadableWarned = true;
      this.log('warn', `${this.getAdapter().name}安全上报载荷不可读，本次自动化检测监控可能无法生效`
        + '——请真机抓一次该请求核对载荷格式');
      this.rt().riskMonitor.recordAnomaly('平台安全上报载荷不可读（自动化检测监控可能失效）', 'notice');
    };
    this.rt().chrome.on('api-risk-signal', onApiRisk);
    this.rt().chrome.on('boss-security-report', onBossSecReport);
    this.rt().chrome.on('boss-security-report-unreadable', onSecUnreadable);
    this.rt().chrome.on('security-report', onPlatformSecReport);
    this.rt().chrome.on('security-report-unreadable', onPlatformSecUnreadable);
    this.pageListeners = [
      { target: page, event: 'crash', handler: onCrash },
      { target: page, event: 'close', handler: onClose },
      { target: page, event: 'error', handler: onError },
      { target: this.rt().chrome, event: 'api-risk-signal', handler: onApiRisk },
      { target: this.rt().chrome, event: 'boss-security-report', handler: onBossSecReport },
      { target: this.rt().chrome, event: 'boss-security-report-unreadable', handler: onSecUnreadable },
      { target: this.rt().chrome, event: 'security-report', handler: onPlatformSecReport },
      { target: this.rt().chrome, event: 'security-report-unreadable', handler: onPlatformSecUnreadable },
    ];
    const browser = this.rt().chrome.getBrowser();
    if (browser) {
      const onDisc = () => {
        this.browserDown = true; // 不可恢复
        this.onPageDead('disconnected');
      };
      this.disconnectBrowserRef = browser;
      this.browserDisconnectHandler = onDisc;
      browser.on('disconnected', onDisc);
    }
  }

  // C-3: 移除生命周期监听（防泄漏），幂等
  private detachPageLifecycle() {
    for (const l of this.pageListeners) {
      try {
        l.target.off(l.event, l.handler);
      } catch {}
    }
    this.pageListeners = [];
    if (this.disconnectBrowserRef && this.browserDisconnectHandler) {
      try {
        this.disconnectBrowserRef.off('disconnected', this.browserDisconnectHandler);
      } catch {}
    }
    this.disconnectBrowserRef = null;
    this.browserDisconnectHandler = null;
  }

  // C-3/H6-1: 关闭并释放当前 page（仅关闭本引擎创建的 tab），先摘监听再 close
  private async disposePage() {
    this.detachPageLifecycle();
    const page = this.page;
    const owned = this.pageOwned;
    const op = this.op;
    this.page = null;
    this.op = null;
    this.pageOwned = false;
    // HumanOperator 持有一个长驻 CDP 会话（发 wheel 用），随页面一起释放
    if (op) { try { await op.dispose(); } catch { /* 页面可能已死 */ } }
    if (page && owned) {
      this.closingPage = true; // 避免 close 事件误判为崩溃
      try {
        await page.close();
      } catch {}
      this.closingPage = false;
    }
  }

  // C-3: 生命周期事件回调——仅置标记 + 记日志，真正恢复由主循环驱动
  private onPageDead(kind: string, err?: any) {
    if (this.closingPage || this.recovering) return; // 主动关闭/恢复中，忽略
    if (!this.running || this.stopRequested) return;
    this.pageDead = true;
    const detail = err?.message || err || '';
    if (kind === 'disconnected') {
      this.log('error', `浏览器已断开连接${detail ? '：' + detail : ''}`);
    } else {
      this.log('warn', `页面异常（${kind}）${detail ? '：' + detail : ''}，准备恢复`);
    }
  }

  // C-3: 判断错误是否为"页面/连接已死"（需触发恢复而非直接吞掉）
  private isFatalPageError(e: any): boolean {
    const msg = String(e?.message || e || '');
    return /Target closed|Session closed|Connection closed|browser has disconnected|Page crashed|detached Frame|frame was detached|Protocol error.*Target closed|Requesting main frame too early|WebSocket is not open/i.test(
      msg,
    );
  }

  // C-3: isRiskPage 包装——区分"不是风控页"与"页面已死"。页面死了抛出以触发恢复
  private async checkRiskPage(page: Page): Promise<boolean> {
    try {
      return await this.getAdapter().isRiskPage(page);
    } catch (e) {
      if (this.isFatalPageError(e)) throw e; // 页面已死 → 交上层恢复流程
      return false; // 其它错误：视为"不是风控页"
    }
  }

  // C-3: 安全读取当前 URL（页面死了不抛）
  private safeUrl(): string {
    try {
      return this.page?.url() || '';
    } catch {
      return '';
    }
  }

  // C-3: 记录进度断点（浏览进度 / 当前列表页），供不可恢复时排查与后续续跑
  /** 游标持久化 key：按 平台 + 任务 分开，互不干扰 */
  private cursorKey(taskId: string): string { return `rpa-cursor:${this.getPlatform()}:${taskId}`; }

  /**
   * 组合指纹：关键词/城市/行业/公司【集合】的哈希（label 排序后 join，与顺序无关）。
   * 任务配置一变就作废旧游标，否则会「改了关键词却从旧索引继续」，看起来在跑、实际跑别的组合。
   * ★ 2026-08-19 修复1：改为【集合指纹】(排序后 join)，与组合遍历顺序解耦——
   *   每次会话 Fisher-Yates 打乱遍历顺序时，指纹不变，游标 fp 校验仍能正确匹配，不会被
   *   打乱误判成「配置变更」。打乱只改「先跑哪个组合」，不改「有哪些组合」。
   */
  private queryFingerprint(qs: SearchQuery[]): string {
    return `${qs.length}:${qs.map((q) => q.label).sort().join('|')}`.slice(0, 400);
  }

  // ★ 2026-08-19 修复1【每次运行打乱组合顺序】：真机实测此前每轮都从同一组合(组合1)起、
  //   按固定顺序遍历——机器特征明显，且 90min 常常只覆盖靠前的几个组合。改为每次会话开始
  //   对组合顺序做 Fisher-Yates 原地打乱（时间种子），使每次会话起点与覆盖顺序都不同，
  //   行为更像真人、关键词覆盖更广。
  //   ★ 不削弱任何反风控：打乱只决定「先跑哪个组合」，不影响请求频率/配额/休息/可疑度模型。
  //   ★ 游标语义自洽：queryFingerprint 是【集合指纹】(label 排序后 join，与顺序无关)，打乱
  //     不改 fp → initQueries 的 fp 校验仍能识别「配置是否变更」；游标保存/恢复改为按 label
  //     定位（见 initQueries/saveCursor），打乱只改「上次那个组合」在数组里的下标，不改其
  //     归属 → 组合游标续翻语义不削弱。页深(pagesInQuery)会话级、每次重置，打乱不影响。
  private shuffleQueriesInPlace() {
    const qs = this.queries;
    if (qs.length <= 1) return;
    // Fisher-Yates（时间种子：Date.now 主进程可用）。顺带做轻微加权——把已知的
    // 「上次新增率较高 / 最近较少跑过」排前面没有持久数据支撑，这里仅做无偏打乱，
    // 顺序随机性已足够打破「固定起点」机器特征。加权留待后续有 run-summary 历史时再加。
    for (let i = qs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      if (i !== j) { const tmp = qs[i]; qs[i] = qs[j]; qs[j] = tmp; }
    }
  }

  /** 建组合 + 恢复游标。BOSS：buildQueries 返回单个空组合 → 整段退化为无操作。 */
  private initQueries(task: RPATask, mode: SpeedMode) {
    const adapter = this.getAdapter();
    this.queries = adapter.buildQueries(task.search, mode) || [];
    this.queryMaxPages = adapter.maxPagesPerQuery(mode);
    this.queryIndex = 0;
    this.pagesInQuery = 0;
    this.queryStarted = false;
    this.comboSoftPagesBudget = this.SOFT_PAGES_MAX; // 进入首个组合前由 ensureQuery 现采覆盖
    if (this.queries.length <= 1) return; // BOSS / 单组合：不需要游标

    // 组合数上限保护：20 关键词 × 10 城市 × 5 行业 = 1000 个组合会被全量构造，
    // 而一天最多跑十几个 —— 与其静默截断，不如明确告诉用户跑不完。
    if (this.queries.length > 200) {
      this.log('warn', `搜索组合共 ${this.queries.length} 个，远超单日可跑量；`
        + '建议减少城市/行业维度，否则靠游标要很多天才轮完一圈');
    }

    const fp = this.queryFingerprint(this.queries);

    // ★ 2026-08-19 修复1：每次会话 Fisher-Yates 打乱组合遍历顺序，本次会话从打乱后的某个
    //   组合起、按新顺序遍历（每次会话起点/覆盖顺序都不同，打破「固定从组合1起」的机器特征）。
    //   先打乱，再用游标的 saved.label 在【打乱后】的数组里定位「上次跑到哪个组合」——
    //   打乱只改遍历顺序，不改「上次那个组合」的归属，组合游标续翻语义不削弱。
    //   fp 是集合指纹（顺序无关），打乱不影响它，故 fp 校验仍能正确识别「配置变更」。
    //   单组合(BOSS)上面 length<=1 已 return，不进本段。不削弱频率/配额/休息/可疑度模型。
    this.shuffleQueriesInPlace();

    try {
      // 兼容旧游标 {fp,index}（无 label/depth）与新游标 {fp,label,depth,done,doneAt}。
      const saved = getSetting<{
        fp: string; index?: number; label?: string;
        depth?: Record<string, number>; done?: Record<string, boolean>; doneAt?: Record<string, number>;
      } | null>(this.cursorKey(task.id), null);
      if (saved && saved.fp === fp) {
        // 配置未变 → 续翻：按 saved.label 在打乱后的数组里找位置（找不到落回 index/0）。
        let idx = -1;
        if (saved.label) idx = this.queries.findIndex((q) => q.label === saved.label);
        if (idx < 0 && Number.isFinite(saved.index)) idx = saved.index as number;
        this.queryIndex = Math.max(0, Math.min(idx < 0 ? 0 : idx, this.queries.length - 1));
        // ★ 页深持久化：恢复每组合的页深/尾页/绕圈时间戳到会话级缓存。
        //   fp 已校验（配置未变）→ depth 同任务同组合直接复用；旧游标无 depth→空 Map(D=0，从第1页开挖)。
        this.queryDepth = { ...(saved.depth || {}) };
        this.queryDone = { ...(saved.done || {}) };
        this.queryDoneAt = { ...(saved.doneAt || {}) };
        if (this.queryIndex > 0 || saved.label) {
          this.log('info', `从上次的搜索组合继续：第 ${this.queryIndex + 1}/${this.queries.length} 个`
            + `（${this.queries[this.queryIndex]?.label || ''}）·本次遍历顺序已打乱`);
        }
      } else if (saved) {
        // ★ 配置变更 → fp 不符 → 整块游标作废，页深/尾页一并清空（不读旧 depth，否则会从
        //   上一个关键词组合的页深续翻到新组合，那是张冠李戴）。
        this.queryDepth = {}; this.queryDone = {}; this.queryDoneAt = {};
        this.log('info', '任务的关键词配置已变更，搜索组合游标重置为第 1 个');
      }
    } catch { /* 游标读不到就从头开始，不影响主流程 */ }
  }

  /** 落游标。每次切组合与收尾都调一次，进程被杀也不丢进度。 */
  private saveCursor() {
    if (this.queries.length <= 1 || !this.task) return;
    try {
      setSetting(this.cursorKey(this.task.id), {
        fp: this.queryFingerprint(this.queries),
        index: this.queryIndex,
        label: this.queries[this.queryIndex]?.label,
        // ★ 页深持久化：一并落每组合的页深/尾页/绕圈时间戳，下次会话跳页续翻靠它。
        depth: this.queryDepth,
        done: this.queryDone,
        doneAt: this.queryDoneAt,
        at: Date.now(),
      });
    } catch { /* 存不下不影响本次运行 */ }
  }

  // ★ 2026-08-19 页深持久化：每组合页深/尾页/绕圈的会话级访问器（背后是 queryDepth/queryDone/queryDoneAt）。
  private curQueryLabel(): string | undefined { return this.queries[this.queryIndex]?.label; }
  private depthFor(label?: string): number { return (label && this.queryDepth[label]) || 0; }
  private doneFor(label?: string): boolean { return !!(label && this.queryDone[label]); }
  private doneAtFor(label?: string): number { return (label && this.queryDoneAt[label]) || 0; }
  private setDepth(label: string | undefined, n: number) { if (label) this.queryDepth[label] = n; }
  private setDone(label: string | undefined, v: boolean) {
    if (!label) return;
    this.queryDone[label] = v;
    if (v && !this.queryDoneAt[label]) this.queryDoneAt[label] = Date.now();
  }
  /** 续鲜重置：清掉该组合的页深/尾页/绕圈时间戳，下轮从第1页重挖一遍（dedup 跳旧人只收新更新者）。 */
  private resetDepth(label: string | undefined) {
    if (!label) return;
    this.queryDepth[label] = 0;
    this.queryDone[label] = false;
    delete this.queryDoneAt[label];
  }

  /** 读当前真实页码（委托 adapter.readCurrentPageNo；非分页平台返 0）。 */
  private async readCurrentPageNo(): Promise<number> {
    const fn = this.getAdapter().readCurrentPageNo;
    if (!fn || !this.page) return 0;
    try { return await fn(this.page); } catch { return 0; }
  }

  /**
   * ★ 2026-08-19 页深持久化·续翻：进组合搜索+设排序后，跳到 depth+1 页再开挖。
   *   读 D=depth[label]。D<=0 → 从第1页正常开挖（不跳页、不耗配额）；否则跳到第 D+1 页。
   *   跳页的每次 •••/页码点击都是真实翻页请求 → 走 pace('scroll') + recordLoadMore + onCleanRequest，
   *   与正常翻页同通道，计入频率/翻页配额，不开绿色通道。
   *   targetN 超 MAX_RESUME_PAGE → 只跳到 MAX_RESUME_PAGE，记 RESUME_JUMP_CAPPED 不静默。
   *   跳页途中不扫卡（只定位）；到位后 currentRealPageNo=landed，正常收人。
   *   跳失败/分页器异常 → dump 骨架 RESUME_JUMP_FAIL，退回第1页开挖（不阻断整轮）。
   *   返回实际落地的真实页码（0 表示未跳、从第1页起）。
   */
  private async jumpToResultPage(myRunId: number): Promise<number> {
    const adapter = this.getAdapter();
    const resume = adapter.resumeToPage;
    if (!resume || !this.page || !this.op) return 0; // 非分页平台/无 op：不跳页
    const label = this.curQueryLabel();
    const D = this.depthFor(label);
    if (D <= 0) return 0; // 上次没挖到/首次 → 从第1页正常开挖，不跳页、不耗配额

    // 目标 = D+1，但封顶 MAX_RESUME_PAGE（不一次跳到尾页把配额一次性烧光）
    const want = D + 1;
    const capped = want > this.MAX_RESUME_PAGE;
    const target = capped ? this.MAX_RESUME_PAGE : want;

    this.log('info', `续翻：${label || ''} 上次挖到第 ${D} 页，拟跳到第 ${target} 页再开挖${capped ? '（已封顶 MAX_RESUME_PAGE=' + this.MAX_RESUME_PAGE + '，记 RESUME_JUMP_CAPPED）' : ''}`);

    let k = 0; // 实际计入配额的真实翻页点击次数
    try {
      // 逐次跳页：每次点击前走 pace('scroll')（与正常翻页同档：含 pageBlock 休息/频率窗），
      // 点击成功后 recordLoadMore（翻页配额+频率）+ onCleanRequest。一次一次来，便于 stop 打断。
      let landed = 0;
      let ok = false;
      let cappedHit = false;
      let reason: string | undefined;
      // 外层把 adapter.resumeToPage 的「整段逼近」拆成【逐次真实翻页请求 + 配额计入】：
      // resumeToPage 内部会点击 maxClicks 次，但我们不能让它一口气跑完——每次点击都必须先 pace、
      // 点击后立刻计入配额。故这里用「单步逼近」：让 resumeToPage 每次只点 1 下，引擎侧计配额。
      for (let step = 0; step < this.MAX_RESUME_CLICKS; step++) {
        if (this.stopRequested || this.currentRunId !== myRunId) return 0;
        // 跳页前走 pace（与正常翻页同通道：pageBlock 休息会在这里触发，量级不削弱）
        await this.pace('scroll', myRunId);
        if (this.stopRequested || this.currentRunId !== myRunId) return 0;
        if (this.rt().riskMonitor.isNightNow()) return 0;

        const r = await resume(this.page, this.op, target, 1); // 每次只允许点 1 下
        const used = r.clicks; // 0=已到位(无需点) 或异常未点；1=点了一次真实翻页
        if (used > 0) {
          // ★ 真实翻页请求 → 计入频率/翻页配额（与主循环翻页成功同口径 recordLoadMore）
          this.rt().riskMonitor.recordLoadMore();
          this.rt().riskController.onCleanRequest();
          k += used;
        }
        landed = r.landed;
        ok = r.ok;
        cappedHit = r.capped;
        reason = r.reason;
        if (ok) break;              // 已落到 targetN，续翻完成
        if (used === 0) break;      // adapter 未点击即返回（到位/读不到页码/到不可达边界），不再耗配额
        // used===1 且 ok=false：点了一次但没到 targetN，继续下一步逼近（配额已计）
      }

      this.currentRealPageNo = landed > 0 ? landed : 0;
      if (ok && landed > 0) {
        this.log('info', `续翻：已跳至第 ${landed} 页（跳页 ${k} 次，计入翻页配额 ${k} 次），从该页开挖`);
        return landed;
      }
      // 跳页未到位
      if (capped || cappedHit) {
        this.log('warn', `RESUME_JUMP_CAPPED：${label || ''} 欲跳第 ${target} 页未到位（${reason || ''}，跳页 ${k} 次）。退回第1页开挖，不阻断整轮`);
      } else {
        this.log('warn', `RESUME_JUMP_FAIL：${label || ''} 跳页未到位（${reason || ''}，跳页 ${k} 次）。退回第1页开挖，不阻断整轮`);
      }
      return 0; // 退回第1页
    } catch (e: any) {
      if (this.isFatalPageError(e)) throw e; // 页面已死：交给崩溃恢复，别吞
      this.log('warn', `续翻跳页异常：${e?.message || e}（退回第1页开挖，不阻断整轮）`);
      return 0;
    }
  }

  /**
   * 保证「当前有一个已提交的搜索组合可跑」。返回：
   *   ok      —— 可以继续抓当前组合
   *   next    —— 已切到下一个组合并提交了搜索，调用方 continue 重新取卡
   *   done    —— 所有组合跑完一轮（游标已回绕），本次运行正常收尾
   *   stopped —— 期间被停止/接管
   */
  private async ensureQuery(myRunId: number): Promise<'ok' | 'next' | 'done' | 'stopped'> {
    const adapter = this.getAdapter();
    if (!adapter.applySearch) return 'ok'; // BOSS 推荐流：无搜索概念，整段不适用
    // ★ 需要主动搜索的平台却没有任何搜索组合 —— 绝不能"就这么跑下去"。
    //   不拦的话会变成：附着在当前页、不提交任何搜索条件就开始翻页抓人，
    //   抓回来的是一批与岗位毫无关系的人，而日志上一切正常。宁可停下报错。
    if (this.queries.length === 0) {
      this.log('error', `${adapter.name} 任务没有配置任何搜索关键词，无法开始 —— `
        + '请编辑任务、在「搜索关键词组」里每行填一条后再跑。');
      this.stopRequested = true;
      return 'stopped';
    }

    // ★ 2026-08-19 修复A【断连自恢复——核心】：applySearch 之前先确认浏览器还活着。
    //   真机 2026-08-18 第N轮的致命空转：17:30 浏览器断开后，组合2~16 整整 14 分钟
    //   对着死页跑——每个 applySearch 返回 filter-failed → 被误报"筛选未生效(平台改版)"
    //   → 换组合空转 → 91/151/211…秒干等 → 最后报"全部跑完一轮/任务结束"【假成功】。
    //   根因：ensureQuery 全程【不查 browserDown/pageDead】。死页返回的 filter-failed 必须
    //   先被断连检查拦截，绝不能翻译成"平台改版"这种误导文案，更不能继续换组合。
    //   一旦确认断连：先尝试重连(Chrome 空闲掉线后进程常仍活着，重连即恢复)；
    //   重连成功→重新导航到搜索页、重试当前组合；重连 3 次仍失败→干净停机(修复B)。
    if (this.isBrowserDown()) {
      const recovered = await this.tryRecoverBrowser(myRunId);
      if (this.currentRunId !== myRunId || this.stopRequested) return 'stopped';
      if (!recovered) {
        // 修复B：不可恢复 → 如实停机，不空转、不假成功。
        this.log('error', `浏览器已断开且无法重连（可能 Chrome 崩溃/被关）。本次未正常完成，`
          + `已浏览${this.state.stats?.viewed ?? 0}人/新增${this.state.stats?.newTalents ?? 0}人。`
          + '请检查并重开 Chrome 调试实例后重启 RPA。');
        this.rt().riskMonitor.recordAnomaly('浏览器断开且重连失败（本地环境故障，非平台风控）', 'notice');
        this.recordBreakpoint();
        return 'stopped';
      }
      // 重连成功：重新导航已在 reconnectBrowser 内完成（回列表页断点）。
      // 当前组合尚未提交 → 让主循环 continue 重新进来跑一遍当前组合（queryStarted 仍为 false
      // 或 pagesInQuery 已满，ensureQuery 会重新提交搜索）。return 'next' 触发主循环重取。
      return 'next';
    }

    // ★ 2026-08-19 P1（组合轮换·软页数上限）→ 修复2 改造：当前组合本次会话已翻满【本次现采的
    //   深翻预算 comboSoftPagesBudget(15-20)】就轮换到下一个组合——即使它仍在产出新人。
    //   目的：一次 90min 会话覆盖 3-6 个深翻组合（不再 95min 只跑组合1），行为更像真人、
    //   可疑度更低、关键词覆盖更广。深挖靠【下次会话游标续翻】继续（游标机制已有）。
    //   ★ 预算每次进入新组合时现采 randInt(15,20)（见下方提交搜索前赋值），不是固定值——
    //     目标是尽量翻完/翻深，15-20 只是「单组合别独占太久」的软阀，不是压产量。
    //   ★ 退出三选一谁先到谁换组合：翻满预算 / 到平台尾页(next disabled，queryMaxPages) /
    //     挖枯(连续 MAX_LOW_YIELD_PAGES 低产，见主循环 consecutiveLowYieldPages)。
    //   不动频率/配额/休息/可疑度模型——只改「何时换组合」，请求节奏不变。
    //   必须在下面的「页数预算未用完→继续翻页 return 'ok'」之前判，否则会被它提前放行。
    if (this.queryStarted && this.pagesInQuery >= this.comboSoftPagesBudget
        && this.pagesInQuery < this.queryMaxPages) {
      this.log('info', `本组合本次会话已深翻 ${this.pagesInQuery} 页（本次预算 ${this.comboSoftPagesBudget}）·轮换换组合，下次会话游标续翻深挖：${this.queries[this.queryIndex]?.label ?? ''}`);
      this.consecutiveLowYieldPages = 0; // 软预算轮换不是挖枯，复位低产计数
      // 落到下面的「前进换组合」分支（queryIndex++ → 下一组合）。
    }

    if (this.queryStarted && this.pagesInQuery < this.queryMaxPages) return 'ok';

    if (this.queryStarted) {
      // 当前组合的页数预算用完 → 前进
      this.queryIndex++;
      this.pagesInQuery = 0;
      if (this.queryIndex >= this.queries.length) {
        // ★ 2026-08-19 修复B【成功门控】："跑完一轮/任务结束"绝不能在断连后报绿色成功。
        //   仅当浏览器未断 + 本轮确有组合成功搜索过，才报正常收尾；否则如实报断连中止。
        if (this.isBrowserDown() || !this.hadSuccessfulSearchThisRun) {
          this.queryIndex = 0;
          this.saveCursor();
          this.log('error', `搜索组合遍历中止：浏览器${this.isBrowserDown() ? '已断开' : '本轮无组合成功搜索'}，`
            + '未正常完成一轮。这不是"跑完一轮/任务结束"，而是中途断连空转后被正确拦截。'
            + `已浏览${this.state.stats?.viewed ?? 0}人/新增${this.state.stats?.newTalents ?? 0}人。`);
          return 'stopped';
        }
        this.queryIndex = 0;           // 一轮跑完回绕，下次运行从头再来一遍（人才会更新）
        this.saveCursor();
        this.log('success', '全部搜索组合已跑完一轮');
        return 'done';
      }
      this.saveCursor();
    }

    const q = this.queries[this.queryIndex];
    if (!q) return 'done';

    // ★ 2026-08-19 页深持久化【步骤4·到尾页/绕圈重置续鲜】：已挖满(done)的组合本轮如何处置。
    //   done = 上次已翻到平台尾页(next disabled)或达 MAX_RESUME_PAGE。该组合的 2000 人深池已吃完。
    //   · 距上次绕圈(doneAt)超 RESCAN_AFTER_DAYS(7天) → 重置 depth/done 再挖一遍（续鲜：
    //     dedup 跳过仍在的旧人、只收新入职/更新者），不浪费翻页配额在重复高的人上。
    //   · 否则（未满续鲜窗口）→ 本轮跳过该组合，前进到下一个未挖满的；全 done 则正常回绕 done。
    //   ★ 不削弱配额：跳过 = 不搜索不翻页(0配额开销)；续鲜重挖 = 从第1页正常开挖(走正常配额)。
    if (this.doneFor(q.label)) {
      const doneAt = this.doneAtFor(q.label);
      const daysSince = doneAt > 0 ? (Date.now() - doneAt) / (24 * 60 * 60 * 1000) : Infinity;
      if (daysSince >= this.RESCAN_AFTER_DAYS) {
        this.resetDepth(q.label);
        this.log('info', `组合「${q.label}」已挖满(距上次绕圈 ${Math.floor(daysSince)} 天)，续鲜重置：本轮从第1页重挖一遍（dedup 跳旧人只收新更新者）`);
        // 落到下面的正常 applySearch 流程（从第1页开挖）
      } else {
        this.log('info', `组合「${q.label}」已挖满(深至第 ${this.depthFor(q.label)} 页)，本轮跳过（距上次绕圈 ${Math.floor(daysSince)} 天 < ${this.RESCAN_AFTER_DAYS} 天续鲜窗口）`);
        this.queryStarted = true;
        this.pagesInQuery = this.queryMaxPages; // 逼 ensureQuery 前进到下一个组合
        return 'next';
      }
    }

    // ★ 2026-08-14 窄词跳过：真机发现『卡尔曼滤波』这类窄词的 9 个切分档几乎全 no-result
    //   （切分只对宽词有效）。一个词一旦出现 no-result 就记为稀疏，后续同词切分档直接跳过，
    //   不再 applySearch（不搜、不耗配额、不占 90s 上限）。宽词从不 no-result，不受影响。
    if ((q as any).keyword && this.sparseKeywords.has((q as any).keyword)) {
      this.queryStarted = true;
      this.pagesInQuery = this.queryMaxPages;
      this.log('info', `跳过「${(q as any).keyword}」的切分档（该词已确认无匹配）：${q.label}`);
      return 'next';
    }
    this.queryStarted = true;
    // ★ 2026-08-19 修复2：每次进入新组合现采本次深翻预算 randInt(15,20)。
    //   目标是尽量翻完/翻深；15-20 是「单组合别独占太久」的软阀，不是压产量。
    //   翻满预算 / 到尾页(next disabled) / 挖枯 三者谁先到谁换组合（见上方判定段）。
    this.comboSoftPagesBudget = this.SOFT_PAGES_MIN
      + Math.floor(Math.random() * (this.SOFT_PAGES_MAX - this.SOFT_PAGES_MIN + 1));
    this.state.currentPage = `${adapter.name} · 搜索「${q.label}」`;
    this.emitState();
    this.log('info', `▶ 搜索组合 ${this.queryIndex + 1}/${this.queries.length}：${q.label}（本次深翻预算 ${this.comboSoftPagesBudget} 页）`);

    let res: ApplySearchResult;
    // ★ 2026-08-14：applySearch 整体加 90s 硬上限。真机遇到 no-result 稀有档组合
    //   （卡尔曼滤波·博士 等）applySearch 卡死 7 分钟，30 分钟窗口大半耗在这。
    //   deadline 让内部所有拟人操作的 expired() 生效，单个组合最多 90s 必然收工换下一个。
    //   与 mouse.move 的单步 capped 是双保险：单步卡→2s 放弃这一步；整体卡→90s 放弃这组合。
    this.op!.setDeadline(Date.now() + 90000);
    try {
      res = await adapter.applySearch(this.page!, this.op!, q);
    } catch (e: any) {
      // ★ 2026-08-19 修复A：applySearch 跑到一半浏览器断开 → 抛 fatal page error。
      //   旧实现直接 throw 上去落到 start() 的 catch 报 error（不可恢复式收尾）——但浏览器
      //   断开常常是可重连的（Chrome 空闲掉线、进程仍在）。这里标记断连并走重连，与
      //   filter-failed+down 同一条路径，不直接判死刑。重连不成再由 tryRecoverBrowser 返回 false 停机。
      if (this.isFatalPageError(e)) {
        this.log('warn', `搜索期间检测到页面/连接已断（${e?.message || e}），尝试重连浏览器`);
        this.pageDead = true;
        this.browserDown = !this.rt().chrome.getBrowser();
        const recovered = await this.tryRecoverBrowser(myRunId);
        if (this.currentRunId !== myRunId || this.stopRequested) return 'stopped';
        if (recovered) {
          this.queryStarted = false; // 本组合 applySearch 未成功提交，复位后重新提交
          return 'next';
        }
        this.log('error', `浏览器断开且重连失败。本次未正常完成，已浏览${this.state.stats?.viewed ?? 0}人/`
          + `新增${this.state.stats?.newTalents ?? 0}人。请检查并重开 Chrome 调试实例后重启 RPA。`);
        this.rt().riskMonitor.recordAnomaly('浏览器断开且重连失败（本地环境故障，非平台风控）', 'notice');
        this.recordBreakpoint();
        return 'stopped';
      }
      this.log('warn', `搜索提交异常，跳过本组合：${e?.message || e}`);
      this.rt().riskMonitor.recordOpResult(false);
      this.pagesInQuery = this.queryMaxPages; // 逼下一轮换组合
      return 'next';
    } finally {
      this.op!.clearDeadline();
    }
    if (this.stopRequested || this.currentRunId !== myRunId) return 'stopped';

    // ★ 2026-08-19 修复A【死页 filter-failed 拦截】：applySearch 返回 filter-failed 时，
    //   若浏览器/页面其实已断（断连后死页求值出空壳，正是 2026-08-18 空转的根因），
    //   绝不能翻译成"筛选未生效(平台改版)"——那是误导文案。先拦下做重连。
    if (res === 'filter-failed' && this.isBrowserDown()) {
      this.log('warn', `搜索返回 filter-failed 且浏览器已断开——这【不是】筛选未生效(平台改版)，`
        + '而是死页空壳求值。先尝试重连浏览器。');
      const recovered = await this.tryRecoverBrowser(myRunId);
      if (this.currentRunId !== myRunId || this.stopRequested) return 'stopped';
      if (recovered) {
        // 重连成功，但本组合的 applySearch 并未真正成功提交（死页空壳）。
        // 复位 queryStarted，让下一轮 ensureQuery 重新提交当前组合，而不是把
        // pagesInQuery=0 误读成"已提交、继续抓页"——那会在没搜索过的页上空抓。
        this.queryStarted = false;
        return 'next';
      }
      this.log('error', `浏览器断开且重连失败。本次未正常完成，已浏览${this.state.stats?.viewed ?? 0}人/`
        + `新增${this.state.stats?.newTalents ?? 0}人。请检查并重开 Chrome 调试实例后重启 RPA。`);
      this.rt().riskMonitor.recordAnomaly('浏览器断开且重连失败（本地环境故障，非平台风控）', 'notice');
      this.recordBreakpoint();
      return 'stopped';
    }

    // ★ 只有真的提交成功才记搜索配额。原口径是"调用即记"，
    //   选择器一漂移就会空转把当天搜索配额烧光，还把失败率通道一起抬高。
    if (res === 'ok' || res === 'no-result') this.rt().riskMonitor.recordSearch?.();

    // ★ 2026-08-13：环境类失败（境外拦截 / 未登录）必须【立刻停机并说清真因】，
    //   而不是当成一次普通失败继续换组合：
    //   ① 继续换组合毫无意义——每个组合都会撞同一堵墙，162 个组合就是 162 次空转；
    //   ② 每次空转都记一次 recordOpResult(false)，失败率迅速冲到 100% 触发熔断，
    //      于是最终留在风险历史里的是「熔断」，真因（VPN/登录）被埋掉。
    if (res === 'blocked-abroad-ip' || res === 'not-logged-in') {
      const msg = res === 'blocked-abroad-ip'
        ? '整页被弹到境外 IP 拦截页 —— 这是环境问题不是平台风控，也不是选择器失效。请关闭 VPN 后重新开始。'
        : `${this.getAdapter().name}会话已失效（页面停在登录页）—— 请在该平台专用浏览器窗口重新登录后再开始。`
          + '注意猎聘是单会话：在别的浏览器登录会把这个会话踢下线。';
      this.log('error', `${msg}（本次停在：${q.label}）`);
      this.rt().riskMonitor.recordAnomaly(
        res === 'blocked-abroad-ip' ? '境外 IP 拦截，非平台风控' : '会话失效，需人工重新登录', 'notice',
      );
      return 'stopped';
    }
    if (res !== 'ok') {
      const why = res === 'no-result' ? '该组合无匹配候选人'
        : res === 'filter-failed' ? '筛选条件未生效（疑似平台改版，去「设置 → 猎聘选择器校准」核对）'
        : res === 'not-ready' ? '搜索框未就绪（疑似选择器失效，已停下不搜歪）'
        : '搜索提交失败';
      this.log(res === 'no-result' ? 'info' : 'warn', `${why}：${q.label}`);
      // 该关键词首次 no-result → 记为稀疏，后续同词切分档在上面被直接跳过
      if (res === 'no-result' && (q as any).keyword) this.sparseKeywords.add((q as any).keyword);
      if (res !== 'no-result') this.rt().riskMonitor.recordOpResult(false);
      this.pagesInQuery = this.queryMaxPages;
      return 'next';
    }
    this.rt().riskMonitor.recordOpResult(true);
    this.pagesInQuery = 1; // 结果首页即第 1 页
    this.currentRealPageNo = 1; // ★ 页深持久化：applySearch 出首页=真实第1页
    this.queryJustResumed = true; // ★ 页深持久化：标记「刚搜索成功」，主循环据此在抓卡前续翻跳页
    this.hadSuccessfulSearchThisRun = true; // ★ 修复B：本轮确有组合成功搜索过，收尾可报绿色成功
    return 'next';
  }

  private recordBreakpoint() {
    this.lastBreakpoint = {
      viewed: this.state.stats.viewed,
      page: this.state.stats.pagesBrowsed,
      url: this.lastListUrl || this.safeUrl(),
      at: Date.now(),
    };
    this.log(
      'warn',
      `已记录断点：已浏览 ${this.state.stats.viewed} 人 / 已翻 ${this.state.stats.pagesBrowsed} 页`,
    );
  }

  // C-3: 崩溃/断连恢复。可恢复=浏览器仍在（页面 crash / target closed）：重建 page 并回列表页断点续跑；
  //       不可恢复=浏览器断开：记断点、返回 false（上层置 error 并通知）。
  private async recoverFromPageDeath(myRunId: number): Promise<boolean> {
    if (this.currentRunId !== myRunId || this.stopRequested) return false;
    // 2026-08-07 P1-14: 恢复前清 loadMoreInFlight，否则恢复后可能连吃 3 次 'blocked' 直接结束
    this.loadMoreInFlight = null;
    // 不可恢复：浏览器断开
    if (this.browserDown || !this.rt().chrome.getBrowser()) {
      this.log('error', '浏览器已断开，任务无法自恢复（已记录断点）。这是本地环境问题，与平台风控无关；'
        + '重新打开浏览器并登录后可直接再开始，不需要到风险中心解除。');
      // ⚠️ 绝不调 setPageAnomaly。那是【平台要求人工验证】专用的闩：
      // 它会把等级顶成 danger、把原因改写成"检测到验证码或风险提示页面"（与实情无关）、
      // 落盘后每次启动都被挡死、还污染风险指数与跨天健康基线。
      // 用户不过是关了个 Chrome，却要去风险中心点"我已处理"才能再跑——
      // 更糟的是这会把人训练成"看到停机就点解除"，反过来喂大真信号那条路径的风险
      //（审查 2026-07-29）。本地故障只留痕，不上人工闩。
      this.rt().riskMonitor.recordAnomaly('浏览器断开（本地环境故障，非平台风控）', 'notice');
      this.recordBreakpoint();
      return false;
    }
    this.recovering = true;
    const maxAttempts = 3;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.currentRunId !== myRunId || this.stopRequested) return false;
        const backoff = 1000 * attempt; // 间隔递增：1s / 2s / 3s
        this.log('warn', `页面崩溃/断连，尝试恢复（第 ${attempt}/${maxAttempts} 次，等待 ${backoff / 1000}s）...`);
        await sleep(backoff);
        if (this.browserDown || !this.rt().chrome.getBrowser()) {
          this.log('error', '浏览器已断开，任务无法自恢复（已记录断点）');
          this.recordBreakpoint();
          return false;
        }
        try {
          // 反检测铁律：绝不新开 tab（新 tab + 程序化导航会被 BOSS 判自动化 → 关窗/弹回登录）。
          // 原实现在这里 this.rt().chrome.newPage() + goto，正是 start() 明令禁止的动作。
          // 现在只在【用户已有的标签页】里找回 BOSS 页；找不到就放弃自恢复，交人工。
          await this.disposePage();
          const browser = this.rt().chrome.getBrowser();
          if (!browser) throw new Error('浏览器未连接');
          const pages = await browser.pages();
          const workPage = this.findWorkPage(pages);
          if (!workPage) {
            this.log('warn', `未找到可复用的 ${this.getAdapter().name} 标签页（不新开 tab），本次恢复失败`);
            throw new Error('no-reusable-work-page');
          }
          this.page = workPage;
          this.pageOwned = false; // 复用用户的页，结束不主动关
          this.rt().chrome.ensureRiskMonitor(workPage);
          const op = new HumanOperator(workPage, resolveBehaviorProfile(this.task!.speed));
          this.op = op;
          this.attachPageLifecycle();
          // 已经在推荐页/推荐帧 → 直接附着，不导航（风控最低）；否则站内带 Referer 跳回推荐页
          if (!this.getAdapter().isAttachedToWorkSurface(workPage)) {
            const target = this.lastListUrl || this.getAdapter().buildSearchUrl(this.task!.search);
            await op.goto(target, this.getAdapter().internalReferer);
            await op.wait('page');
          }
          this.lastListUrl = this.safeUrl() || this.lastListUrl;
          this.pageDead = false;
          this.state.currentPage = `${this.getAdapter().name} · 推荐牛人`;
          this.log('success', '已复用现有 BOSS 标签页恢复，从当前列表页继续');
          this.emitState();
          return true;
        } catch (e: any) {
          this.log('warn', `第 ${attempt} 次恢复失败：${e?.message || e}`);
          if (this.browserDown || !this.rt().chrome.getBrowser()) {
            this.log('error', '浏览器已断开，任务无法自恢复（已记录断点）');
            this.recordBreakpoint();
            return false;
          }
        }
      }
      this.log('error', `连续 ${maxAttempts} 次恢复失败，任务停止（已记录断点）`);
      this.recordBreakpoint();
      return false;
    } finally {
      this.recovering = false;
    }
  }

  /**
   * CDP 断连【自恢复】：浏览器 WebSocket 空闲掉线 / Chrome 进程仍在但 puppeteer 附着断了。
   *
   * 与 recoverFromPageDeath 的边界：
   *   recoverFromPageDeath 处理「浏览器还连着、但页面 crash/关闭」——它能 getBrowser，
   *   只是 page 死了，于是重建 page（不重连浏览器）。
   *   本方法处理更底层：browserDown=true，连 getBrowser() 都是 null —— 必须先重连浏览器，
   *   重连成功后再像 recoverFromPageDeath 那样找回工作页、重建 op、重挂生命周期监听。
   *
   * Chrome 在长休空闲掉线后进程通常仍活着，重连即恢复登录态与已打开的工作页（复用，
   * 不新开 tab——反检测铁律）。重连后重新导航到列表页断点，让主循环从当前组合继续。
   *
   * 返回 true=重连+重建 page 成功，可继续；false=不可恢复（Chrome 已退出/被关）。
   * 绝不在重连失败时继续跑 applySearch——死页返回的 filter-failed 会被误报成"平台改版"。
   */
  private async reconnectBrowser(myRunId: number): Promise<boolean> {
    if (this.currentRunId !== myRunId || this.stopRequested) return false;
    this.recovering = true;
    try {
      // 旧 page/op 引用必然已失效（浏览器断开），先清掉监听与 HumanOperator 会话，
      // 防止重连后旧引用与新 page 混用导致监听器叠加/CDPSession 越权。
      await this.disposePage();
      const chrome = this.rt().chrome;
      let browser;
      try {
        browser = await chrome.reconnect();
      } catch (e: any) {
        // connectExisting 在端口连不上时抛 ECONNREFUSED——Chrome 进程已退出，不可恢复。
        this.log('error', `浏览器重连失败：${e?.message || e}（Chrome 进程可能已退出/被关）`);
        return false;
      }
      if (!browser) {
        this.log('error', '浏览器重连未返回可用连接（可能 Chrome 已退出）');
        return false;
      }
      this.browser = browser;
      // 重连后【已有标签页】不会走 targetcreated，找回工作页并补挂风控监控（同 start 流程）。
      const pages = await browser.pages().catch(() => [] as Page[]);
      const workPage = this.findWorkPage(pages);
      if (!workPage) {
        this.log('error', `重连成功但未找到可复用的 ${this.getAdapter().name} 标签页（不新开 tab），本次无法继续`);
        return false;
      }
      this.page = workPage;
      this.pageOwned = false; // 复用用户的页，结束不主动关
      chrome.ensureRiskMonitor(workPage);
      this.op = new HumanOperator(workPage, resolveBehaviorProfile(this.task!.speed));
      this.attachPageLifecycle();
      // 重连后页面可能在任意 URL（甚至空白页），统一带站内 Referer 导航回列表页断点续跑。
      const target = this.lastListUrl || this.getAdapter().buildSearchUrl(this.task!.search);
      try {
        await this.op.goto(target, this.getAdapter().internalReferer);
        await this.op.wait('page');
      } catch (e: any) {
        // 导航失败说明重连后的页又出问题——如实报，不当成功。
        this.log('error', `重连后导航到列表页失败：${e?.message || e}`);
        return false;
      }
      this.lastListUrl = this.safeUrl() || target;
      // ★ 清除断连标记：浏览器已重连、page 已重建，主循环可正常推进。
      //   不清的话 ensureQuery/watchdog 仍认为断连，会再次触发重连形成死循环。
      this.browserDown = false;
      this.pageDead = false;
      this.state.currentPage = `${this.getAdapter().name} · 推荐牛人`;
      this.log('success', '浏览器已断连并重连成功，从当前列表页继续');
      this.emitState();
      return true;
    } finally {
      this.recovering = false;
    }
  }

  /**
   * 浏览器是否已不可用（断连/pageDead/连不上 getBrowser）。
   * 单一判定源：ensureQuery、watchdog、保活都看这一个，避免各查各的漏判。
   */
  private isBrowserDown(): boolean {
    return this.browserDown || this.pageDead || !this.rt().chrome.getBrowser();
  }

  /**
   * 断连自恢复的统一入口：退避重试 reconnectBrowser 最多 3 次（1s/2s/4s 递增）。
   * Chrome 空闲掉线后进程常仍活着，首次重连即恢复；进程已退出则 3 次都失败→返回 false。
   * 期间响应 stop/换轮。返回 true=重连成功可继续，false=不可恢复需干净停机。
   *
   * 互斥：watchdog(异步 fire-and-forget) 与 ensureQuery(同步 await) 可能并发触发本方法。
   * 用 browserDownRecovering promise 串行化——首个调用者执行重连，重入者 await 同一结果，
   * 绝不并发 disposePage/reconnect（否则两个 reconnect 会争同一个 Browser 引用）。
   */
  private async tryRecoverBrowser(myRunId: number): Promise<boolean> {
    // 已有重连在进行中：等它，拿同一结果（不发起第二次重连）。
    if (this.browserDownRecovering) {
      try { return await this.browserDownRecovering; }
      catch { return false; }
    }
    const p = this.doRecoverBrowser(myRunId);
    this.browserDownRecovering = p;
    try {
      return await p;
    } finally {
      // 仅当持有的是自己这次 promise 时才清空，避免清掉更晚发起的重连（防御性）。
      if (this.browserDownRecovering === p) this.browserDownRecovering = null;
    }
  }

  private async doRecoverBrowser(myRunId: number): Promise<boolean> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.currentRunId !== myRunId || this.stopRequested) return false;
      const backoff = 1000 * (1 << (attempt - 1)); // 1s / 2s / 4s 递增
      this.log('warn', `检测到浏览器断连，尝试重连（第 ${attempt}/${maxAttempts} 次，等待 ${backoff / 1000}s）…`);
      if (backoff > 0) await this.interruptibleSleep(backoff, myRunId);
      if (this.currentRunId !== myRunId || this.stopRequested) return false;
      const ok = await this.reconnectBrowser(myRunId);
      if (ok) return true;
      if (this.currentRunId !== myRunId || this.stopRequested) return false;
    }
    this.log('error', `连续 ${maxAttempts} 次重连均失败，浏览器不可恢复。`);
    return false;
  }

  // M-24: 运行结束时更新任务 last_run_at 与本次运行时长
  private updateTaskLastRun() {
    if (!this.task || !this.state.startedAt) return;
    try {
      const now = Date.now();
      const task = this.task;
      task.lastRunAt = now; // 上次运行时间
      (task as any).lastRunDurationMs = this.effectiveElapsed(now); // 本次有效运行时长（无对应类型字段，落在 data JSON）
      task.updatedAt = now;
      const db = getDb();
      db.prepare(
        'INSERT OR REPLACE INTO rpa_tasks (id, name, platform, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(task.id, task.name, this.getPlatform(), JSON.stringify(task), task.createdAt, task.updatedAt);
    } catch (e: any) {
      this.log('warn', `更新任务上次运行时间失败：${e?.message || e}`);
    }
  }

  private async runTask(myRunId: number) {
    if (!this.task || !this.page || !this.op) return;
    const task = this.task;
    const adapter = this.getAdapter();
    this.sparseKeywords.clear(); // 每次运行重新判断哪些关键词稀疏（窄词跳过，见 ensureQuery）

    // 反风控参数系统固定、不可人工调：每日浏览上限【权威取自档位】，忽略任务里可能残留的手填值。
    // ⚠️ 必须带 platform：不带的话猎聘会拿到 BOSS 的 browse 上限（240），
    //    而猎聘档位是 1200/600，等于产量被砍到五分之一还查不出原因。
    const mode = normalizeSpeedMode(task.speed.mode);
    const dailyLimit = getDefaultLimits(mode, this.getPlatform()).browse;
    // P1-1: 每日上限按"当日累计"（跨多次运行）门控，而非会话计数——避免同日多次运行各重获配额
    const browsedToday = () => this.rt().riskMonitor.getTodayCounts().browse;

    // ⚠️ 门闸必须排在【导航 + 清空人才库】之前。
    // 旧实现先导航、再无条件 DELETE FROM candidates_export，最后才由 while 条件判每日上限——
    // 当天已跑满上限时，循环一次都不进，结果是"上一轮导出的人全被删光且零产出"。
    // 夜闸在启动层(rpa-launcher)有拦截，每日上限没有任何启动层门控，这条路径真实可达。
    if (browsedToday() >= dailyLimit) {
      this.log('warn', `今日浏览已达上限（${browsedToday()}/${dailyLimit}），本次不启动，人才库保持不变`);
      return;
    }
    if (this.rt().riskMonitor.isNightNow()) {
      this.log('error', `当前处于禁跑时段（${this.rt().riskMonitor.nightWindowLabel()}），本次不启动，人才库保持不变`);
      return;
    }

    // 开跑前的硬前提：页面必须能收到 CDP 输入事件，否则推荐流根本翻不动。
    // 窗口最小化、或被其它窗口完全遮挡时，Chrome 都不处理 Input.dispatchMouseEvent
    // （真机实测：单发一个 mouseMoved 要等满 60s protocolTimeout 才抛错）。
    // 受影响的不只是下滑——点开详情、收藏、打招呼这些点击动作也全部失效，且没有兜底。
    // 真机 2026-07-28 16:26 那轮就是反例：窗口被遮挡 → 滚轮跳过 → 程序化滚动虽然把位置推到底
    // 却触发不了懒加载 → 连续 4 次无新增 → 报"任务完成"，只看了 15 人。
    // 那是【假成功】，它让人以为"今天就这 15 个"，比直接不跑更糟，所以这里拒绝启动。
    if (!(await this.ensurePageInteractable())) {
      // 记下这次"环境类拒绝"，供启动编排层做退避：
      // 空闲触发每 15 秒重试一次，而窗口被遮挡这种状态可能持续几小时——
      // 不退避就是每分钟 4 次系统通知 + 4 条风险历史，用户离开一小时回来面对
      // 240 条本地噪声，真正的平台信号被埋在里面（审查 2026-07-29）。
      this.lastStartRefusal = { at: Date.now(), reason: '浏览器窗口不可见' };
      // 文案按平台取：原来硬编码「BOSS」，猎聘任务失败时把用户导向错误的浏览器和标签页。
      const adName = this.getAdapter().name;
      this.log('error', `${adName}浏览器窗口不可见（最小化，或被其它窗口完全遮挡），已尝试自动还原但未成功。`
        + '此状态下 Chrome 不处理 CDP 输入事件：真实滚轮送不达，列表翻不动，'
        + `点开详情/收藏/打招呼也会全部失效。请把${adName}那个 Chrome 窗口露出来（最关键的是【不要最小化】）`
        + `并让${adName}标签页处于前台，然后重新开始。本次不启动，人才库保持不变。`);
      // 同因去重：同一个原因 10 分钟内只留一次痕、只通知一次。
      // 风险历史是给平台信号用的，不能被本地环境噪声灌满（上限 2000 条，灌满会把真信号挤出库）。
      if (this.shouldReportRefusal('windowHidden')) {
        this.rt().riskMonitor.recordAnomaly('浏览器窗口不可见，输入事件不可用，拒绝启动', 'notice');
        this.rt().riskMonitor.notifyUser('⚠️ 找人未能启动', `${adName}浏览器窗口不可见（多半是被最小化了），请把该窗口还原后重试。`);
      }
      return;
    }

    const url = adapter.buildSearchUrl(task.search);
    // 真机校准：主用推荐牛人。若已停在推荐页 → 附着当前页面不导航（风控最低）；否则打开推荐页。
    if (this.getAdapter().isAttachedToWorkSurface(this.page)) {
      this.state.currentPage = `${adapter.name} · 推荐牛人`;
      this.log('info', '已在推荐牛人页，附着当前页面（不导航，风控最低）');
    } else {
      this.state.currentPage = `${adapter.name} · 推荐牛人`;
      this.log('info', '打开推荐牛人页（带站内 Referer，避免触发 Boss端 51004 非常态入口检测）');
      await this.op.goto(url, this.getAdapter().internalReferer);
      await this.op.wait('page');
    }
    this.lastListUrl = this.safeUrl() || url; // C-3: 记录当前列表页断点

    // ── 人才库只保留【本轮】结果 ──────────────────────────────────────────
    // BOSS 的候选人链接是会话级重放锚（boss:geek:<encryptGeekId>），换一轮推荐流/换个会话
    // 就打不开了。留着上一轮的人只会让人才库越堆越大、点进去全是死链，没有意义。
    // 故每轮开跑先清空，人才库 = 这一轮找到的人。（门闸已在函数开头拦过，走到这里必然会真跑）
    // ⚠️ 必须按 platform 限定：runTask 是双平台共用路径（通篇走 this.getPlatform()），
    // 不带 WHERE 会让跑猎聘顺手清掉 BOSS 的人才库，反之亦然。v3 迁移专门建的 platform
    // 分区在这里被绕过就白建了。2026-08-07 审查发现。
    try {
      const plat = this.getPlatform();
      const cleared = getDb().prepare('DELETE FROM candidates_export WHERE platform = ?').run(plat).changes;
      if (cleared) this.log('info', `人才库已清空本平台上一轮的 ${cleared} 条记录（候选人链接是会话级的，跨轮打不开）`);
    } catch (e: any) {
      this.log('warn', `清空上一轮人才库失败：${e?.message || e}`);
    }
    // M-2: 运行时长
    // 单次运行时长。⚠️ 登记册「单次连续运行 ≤90 分钟」是硬约束，不接受用户覆盖——
    // 原实现直接取 task.schedule.runDurationMin，而 UI 上 0 表示"不限"，
    // 所有 `runDurationMs > 0 &&` 的检查会被整体短路，一次能跑到当日 240 人上限
    // （human 档约 66 分钟起，叠加长休/熔断等待可远超 90 分钟）。
    // 现在：用户填的值只能【更短】，0/未填/超限一律收敛到 90 分钟。
    const HARD_MAX_RUN_MS = 90 * 60 * 1000;
    const userRunMin = task.schedule?.runDurationMin || 0;
    const runDurationMs = userRunMin > 0
      ? Math.min(userRunMin * 60 * 1000, HARD_MAX_RUN_MS)
      : HARD_MAX_RUN_MS;
    if (userRunMin <= 0 || userRunMin * 60 * 1000 > HARD_MAX_RUN_MS) {
      this.log('info', `单次运行时长按反风控硬约束收敛为 ${Math.round(runDurationMs / 60000)} 分钟`
        + `（登记册：单次连续运行 ≤90 分钟）`);
    }
    // 注：拟人 profile 已在 start() 里交给 HumanOperator（鼠标轨迹/滚轮/打字等微观行为）；
    // 宏观节奏（人均停留/批休/长休/降速）统一归 RiskController.planNext，这里不再需要 profile。
    // 风险阈值【完全由档位决定】——不再读用户 settings.risk（反风控不可人工调，杜绝调高红线绕过风控）。
    // P1-2: 同时传入档位，让风险指数按当前任务档位的上限计算（不再写死 human）
    this.rt().riskMonitor.updateThresholds(getRiskThresholdsForMode(mode, undefined, this.getPlatform()), mode);
    // 闭环控制器复位（AIMD 速率/可疑度/熔断/健康基线按本档位重置；开跑先评估账号健康度）。
    // 传入当前激活 JD：健康基线（high_match 率）是按 JD 统计的，跨 JD 不可比，换岗位不得误判降权。
    this.rt().riskController.reset(mode, this.jd?.id ?? null);
    // ★ 2026-08-19 修复4：把单次会话预算(=runDurationMs，已按 90min 硬顶收敛)交给控制器，
    //   供 planNext 的自然疲劳曲线按 elapsed/budget 算进度温和延长翻页间停顿。
    this.rt().riskController.setSessionBudgetMs(runDurationMs);
    // 开跑即疑似隐形降权（高匹配率跨天骤降）→ 控制器已自动长冷却；这里通知用户需人工决策（是否改真人操作数天）
    const startHealth = this.rt().riskController.snapshot().health;
    if (startHealth?.shadowSuspected) {
      this.log('error', '账号疑似隐形降权（高匹配率较近7天基线骤降），已自动长冷却；强烈建议改真人操作数天再跑');
      this.rt().riskMonitor.recordAnomaly('疑似隐形降权（高匹配率骤降）', 'danger');
      this.rt().riskMonitor.setPageAnomaly(true, '疑似隐形降权，建议改真人操作数天');
    }
    this.candidateIndexOnPage = 0;
    this.consecutiveEmptyPages = 0;
    this.emptyGraceLeft = RPAEngine.EMPTY_GRACE;
    this.rt().riskMonitor.setConsecutiveEmptyPages(0);
    // 2026-08-07 P1-12: runTask 层面的复位
    this.detailsOpenedThisRun = 0;
    this.favoriteUnsupportedLogged = false;
    this.apiEmptyStreak = 0;
    this.rateWarnings = 0;
    this.lastInlineRiskCheckAt = Date.now();
    this.apmUnreadableWarned = false;
    this.seenCardIds.clear(); // 块4：本次运行的推荐流去重集合复位
    // 2026-08-18 产量重构：深翻干涸计数 + 跨轮去重新增计数每轮复位
    this.consecutiveLowYieldPages = 0;
    this.newTalentsThisRun = 0;
    this.skippedAlreadySeen = 0;
    this.state.stats.newTalents = 0;
    this.state.stats.skippedAlreadySeen = 0;
    this.readFailStreak = 0;
    this.blockedScrolls = 0;
    resetHealthBaseline(); // 健康探针基线按轮复位（cookie/骨架屏/Security）
    this.consecutiveDryScrolls = 0;
    this.wsRecoveries = 0;
    this.lastHealthProbeAt = 0;
    this.cookieGoneStreak = 0;
    this.skeletonStreak = 0;
    this.securityWarned = false;
    this.scoreAudit = createScoreAudit();
    this.initQueries(task, mode);
    this.mark('主循环启动');

    while (!this.stopRequested && browsedToday() < dailyLimit) {
      if (this.currentRunId !== myRunId) break; // M-03: 已被新运行接管，退出旧循环

      // ── 搜索组合门闸（猎聘）：当前组合页数跑满就切下一个并提交搜索。
      //    BOSS 无 applySearch → 整段直接返回 ok，一行行为都不变。
      {
        const qs = await this.ensureQuery(myRunId);
        if (qs === 'stopped') break;
        if (qs === 'done') break;
        if (qs === 'next') {
          // 刚换过组合/刚提交过搜索：给结果页一点渲染时间，然后回循环重新取卡
          await this.pace('query', myRunId);
          if (this.stopRequested || this.currentRunId !== myRunId) break;
          continue;
        }
      }

      // 夜间绝对禁跑：跨进禁跑时段立即停机（不是暂停——暂停会在天亮后被空闲/调度悄悄续跑）
      if (this.rt().riskMonitor.isNightNow()) {
        this.log('error', `已进入禁跑时段（${this.rt().riskMonitor.nightWindowLabel()}），自动化立即停止`);
        this.rt().riskMonitor.recordAnomaly(`进入禁跑时段（${this.rt().riskMonitor.nightWindowLabel()}）自动停机`, 'notice');
        break;
      }

      // M-2（M-01/M-02）: 运行时长检查（扣除暂停时间）
      if (runDurationMs > 0 && this.effectiveElapsed() >= runDurationMs) {
        this.log('info', `达到预设运行时长（${task.schedule.runDurationMin}分钟），自动停止`);
        break;
      }

      if (this.isPaused && !this.stopRequested) {
        await this.waitForResumeOrStop();
      }
      if (this.stopRequested) break;
      if (this.currentRunId !== myRunId) break; // M-03

      // C-3: 页面/浏览器已死（事件先于操作触发）→ 主动进入恢复
      if (this.pageDead) {
        const ok = await this.recoverFromPageDeath(myRunId);
        if (this.currentRunId !== myRunId || this.stopRequested) break;
        if (!ok) {
          this.transition('error'); // S1: 集中状态转移
          break;
        }
        continue;
      }

      // C-3: 页面操作段统一捕获"页面已死"错误并走恢复流程；非页面错误上抛
      try {
        // ── 闭环控制器：熔断冷却打开 → 在此分段等冷却（可打断），到点后主循环 planNext 自动转半开低速试探 ──
        {
          const cd = this.rt().riskController.cooldownRemainingMs();
          if (cd > 0) {
            this.state.currentPage = '风控熔断冷却中';
            this.log('warn', `风控熔断冷却中，约 ${Math.round(cd / 60000)} 分钟后自动半开低速试探…`);
            await this.interruptibleSleep(Math.min(cd, 5 * 60000), myRunId); // 分段等，便于响应 stop/时长
            continue;
          }
        }

        // BOSS 温和降速提示（"操作速度过快"）→ 软信号喂控制器（AIMD 降速）；连续多次升级为需人工暂停。
        this.mark('检查BOSS降速提示');
        // ★ 配额耗尽必须排在风控检测【之前】判，且走优雅停机通道。
        //   猎聘的"今日查看简历已达上限"是正常收工，不是平台在施压；
        //   落进下面的 isRiskPage/classifyRiskKind 通道会被记 danger + 进熔断，
        //   用户看到红色告警而账号其实完全正常 —— adapter 的 detectQuotaStop
        //   就是为这个区分写的，之前一直没被主循环调用。
        {
          const qs = await this.getAdapter().detectQuotaStop?.(this.page).catch(() => null);
          if (qs) {
            // 2026-08-07 P1-10: qs 是 QuotaStop 字符串联合类型，qs.detail/qs.reason 是 undefined。
            // 修复：按 QuotaStop 值映射可读文案。
            const QUOTA_LABEL: Record<string, string> = {
              dailyBrowse: '今日浏览量已达上限', dailyGreet: '今日打招呼已达上限',
              dailyPages: '今日翻页次数已达上限', dailySearches: '今日搜索次数已达上限',
              dailyDetails: '今日查看详情已达套餐上限', workWindow: '已超出工作时段',
              runDuration: '单次运行时长已达上限',
            };
            const qsLabel = QUOTA_LABEL[String(qs)] || String(qs);
            this.log('info', `⏹ 正常收工：${qsLabel}。不是风控，账号无异常。`);
            this.rt().riskMonitor.recordAnomaly(`正常收工：${qsLabel}`, 'notice');
            break;
          }
        }
        if (await this.getAdapter().isRateWarning(this.page)) {
          this.rateWarnings++;
          if (this.rateWarnings >= 3) {
            this.log('warn', 'BOSS 多次提示"操作速度过快"，暂停等你决定（建议改日或更慢）');
            this.handleSignal('rateWarn', `连续 ${this.rateWarnings} 次`);
            this.enterPause('riskPage');
            continue;
          }
          this.handleSignal('rateWarn', `第 ${this.rateWarnings} 次`);
          await this.interruptibleSleep(30000 + Math.floor(Math.random() * 30000), myRunId);
          continue;
        } else if (this.rateWarnings) {
          this.rateWarnings = 0; // 恢复正常，复位
        }

        // 验证码/验证页/登录丢失 → 细分类型喂控制器；需人工者 handleSignal 内部已硬停+通知，退避类走熔断冷却。
        this.mark('风控页检测');
        if (await this.checkRiskPage(this.page)) {
          const kind: DefenseSignalKind = await this.getAdapter().classifyRiskKind(this.page);
          this.handleSignal(kind, '页面检测到验证码/风控');
          if (this.stopRequested) break;
          continue;
        }

        const risk = this.rt().riskMonitor.getState();
        // H-4: danger 首次升高时若用户未确认，引擎暂停等待对话框决策；
        // 用户在对话框选"继续"会调用 acknowledgeDangerAndContinue() 删 risk* 来源并置标记，
        // 之后直到下一次 danger 重新升高前不再自我暂停（attachRiskEvents 只在 level 跳变时弹对话框）。
        if (risk.level === 'danger' && this.lastRiskLevel !== 'danger') {
          this.dangerAcknowledged = false;
        }
        if (risk.level === 'danger' && !this.pauseReasons.has('riskDanger') && !this.dangerAcknowledged) {
          // ⛔⛔ 2026-08-13 真机：每日配额耗尽【不是】平台风控，处置方式完全不同。
          //   平台风控（验证码/降权）可能几十分钟后缓解，暂停等待是对的；
          //   而"今日搜索/翻页/详情已达上限"要等【明天 0 点】重置，等下去毫无意义。
          //   原实现一律 enterPause('riskDanger')，实测配额用完后【无限期挂着】：
          //   29 分钟里每 60 秒打一条"已有 N 秒没有任何进展"，既不推进也不结束，
          //   而真正的原因只在最开始出现过一次——用户完全看不出为什么卡住。
          //   这类信号必须【正常结束本次运行】并把"明天再来"说清楚。
          const m: any = risk.metrics || {};
          const quotaHit = (m.searchesLimit > 0 && m.searchesToday >= m.searchesLimit)
            || (m.pagesLimit > 0 && m.pagesToday >= m.pagesLimit)
            || (m.detailsLimit > 0 && m.detailsToday >= m.detailsLimit);
          if (quotaHit) {
            const why = (risk.reasons || []).find((r) => r.includes('每日上限')) || risk.reasons[0] || '今日配额已用完';
            this.log('success', `${why}。本次运行正常结束——配额每天 0 点重置，明天可继续。`
              + `（本次：浏览 ${this.state.stats.viewed} 人、新增(去重后) ${this.newTalentsThisRun} 人、翻页 ${this.state.stats.pagesBrowsed} 次）`);
            break;
          }
          this.log('warn', `风险等级：danger。${risk.reasons[0] || ''}`);
          this.enterPause('riskDanger'); // S1: 风险联动暂停来源
          this.lastRiskLevel = risk.level;
          continue;
        }
        this.lastRiskLevel = risk.level;

        // ── 会话/环境健康探针（节流 ~45s，只读低开销）：软信号喂控制器（AIMD 降速），异常留痕 ──
        // 探针周期从 45s 收到 12s：骨架屏的登记册口径是"停留 >15 秒"，
        // 45 秒一探根本量不出 15 秒这个尺度。探针本身是只读低开销的（三次带超时的求值）。
        if (Date.now() - this.lastHealthProbeAt >= 12000) {
          this.lastHealthProbeAt = Date.now();
          this.mark('会话健康探针');
          const health = await this.getAdapter().probeSessionHealth(this.page);
          // 时长/基线判定已经在探针内部做掉了（见 probeSessionHealth），
          // 这里不再叠加"连续命中 N 次"——那正是把 >15s 拖成 >90s 的原因。
          if (health.includes('cookieMutation')) {
            this.cookieGoneStreak++;
            if (this.cookieGoneStreak === 1) this.handleSignal('cookieMutation', '指纹 Cookie 由有变无');
          } else {
            this.cookieGoneStreak = 0;
          }
          if (health.includes('skeletonStuck')) {
            if (this.skeletonStreak === 0) this.handleSignal('skeletonStuck', '骨架屏驻留超过 15 秒');
            this.skeletonStreak++;
          } else {
            this.skeletonStreak = 0;
          }
          if (health.includes('securityJsFail') && !this.securityWarned) {
            this.securityWarned = true;
            this.handleSignal('securityJsFail', 'window.Security 曾存在但已消失');
          }
        }

        // ── 块4：推荐流「下滑刷新」浏览 —— 读当前屏卡片、按 encryptGeekId 去重、只处理新增，
        //    处理完向下滑动触发懒加载；连续多次下滑无新增即视为浏览完。
        //    关键：不再靠"卡片总数增长"判到底——BOSS 推荐流是虚拟列表会回收 DOM 节点，
        //    卡片总数长期停在 ~15，旧的 count 判据必然把"下滑刷新"误判成"已到最后一页"而停在 15 人。
        const infinite = !!(adapter as any).infiniteScroll;

        // ★ 2026-08-19 页深持久化【步骤2·续翻跳页】：分页平台(猎聘)刚搜索成功(queryJustResumed)后，
        //   在抓卡前先用分页器跳到 depth+1 页再开挖——跨会话页深递增吃满 2000/组合深池。
        //   仅分页平台(!infinite)且刚搜索成功时执行；跳页途中不扫卡(只定位)，到位后正常收人。
        //   跳页的每次 •••/页码点击都是真实翻页请求，已计入频率/翻页配额并走 pace（见 jumpToResultPage）。
        //   不削弱配额/风控闸/90min 硬顶/休息量级。失败→退回第1页开挖，不阻断整轮。
        if (this.queryJustResumed) {
          this.queryJustResumed = false;
          if (!infinite) {
            const landed = await this.jumpToResultPage(myRunId);
            if (this.stopRequested || this.currentRunId !== myRunId) break;
            if (landed > 0) {
              // 跳页到位：pagesInQuery 已在 ensureQuery 设1(=本次会话已翻1页预算计数)，保持；
              // currentRealPageNo 已在 jumpToResultPage 内更新为 landed。
              // 给跳到的页一点渲染时间，再继续取卡。
              await this.op.wait('page');
            }
            // landed===0：上次没挖到/首次/跳页失败退回第1页 → currentRealPageNo 仍=1，正常开挖
          }
        }

        this.mark('读取候选人卡片');
        const rawCards = await adapter.extractCards(this.page);
        // ⚠️ null = 【没读到】（求值超时/上下文销毁），与"读到了但是 0 条"是两回事。
        // 把前者当成"平台返回空数据"会连续 3 轮触发 emptyData → 20min 熔断 + 报"疑似隐形降权"，
        // 把一个本地 CDP/iframe 问题栽赃给平台，还锁 20 分钟。这里只重试，不喂风控信号。
        if (rawCards === null) {
          this.readFailStreak = (this.readFailStreak || 0) + 1;
          this.log('warn', `读取候选人卡片失败（第 ${this.readFailStreak} 次，可能是推荐帧正在重建）`);
          // ⚠️ 这里【不能】调 this.rt().riskMonitor.recordOpResult(false)。
          // 它会进失败率窗口（≥8 样本且失败率 ≥0.6 即 danger 自动暂停），
          // 等于换条路把本地 CDP/iframe 问题又栽赃成平台风控——正是这个分支要避免的事。
          // 读取失败只做重试与计数，不喂任何风控通道。
          if (this.readFailStreak >= 5) {
            this.log('error', '连续多次读不到推荐帧内容，本次运行结束（不判定为平台降权）');
            break;
          }
          await this.interruptibleSleep(3000, myRunId);
          continue;
        }
        this.readFailStreak = 0;
        // C3(2026-08-05)：annotateSource 标注每张卡来自哪个搜索组合/页码——
        // 猎聘产量归因到关键词组合的基础数据，没它组合遍历无法分析效果（产量模型缺字段）。
        // BOSS 侧 annotateSource 是 no-op 实现，调了也无害。
        const curQuery = this.queries[this.queryIndex];
        if (curQuery) {
          // ★ 页深持久化修复：页码归因用 currentRealPageNo(真实页码)，不再用 pagesInQuery+1
          //   (会话已翻页数)。跳页续翻到第21页后 pagesInQuery 仍从1起，旧写法会把真实第21页
          //   标成"第2页"，产量归因到错误页深。currentRealPageNo 由 applySearch/翻页/跳页实时维护。
          const pageNo = this.currentRealPageNo || 1;
          for (const c of rawCards) {
            try { adapter.annotateSource(c, curQuery, pageNo); }
            catch (e) { /* 标注失败不卡主流程 */ }
          }
        }
        const freshCards = rawCards.filter((c) => { const k = this.cardKey(c); return !!k && !this.seenCardIds.has(k); });

        if (freshCards.length === 0) {
          // 推荐帧丢失恢复：DOM 真空且已不在推荐页/推荐帧（如被 BOSS 刷新/跳走）→ 不算"到底"，
          // 先重定位一次推荐页再继续，避免像真机那样在 51 人处因帧丢失被误判浏览完。
          if (rawCards.length === 0 && infinite && !this.getAdapter().isAttachedToWorkSurface(this.page) && this.wsRecoveries < this.MAX_WS_RECOVERIES) {
            this.wsRecoveries++;
            this.log('warn', `推荐帧丢失，重定位推荐牛人页（第 ${this.wsRecoveries} 次）后继续…`);
            try {
              await this.op.goto(url, this.getAdapter().internalReferer);
              await this.op.wait('page');
              this.lastListUrl = this.safeUrl() || url;
            } catch (e) {
              if (this.isFatalPageError(e)) throw e;
            }
            await sleep(2000);
            continue; // 不计入干涸/空页，回到循环重新取卡
          }
          // 诊断：下滑前后滚动指标（真机远程判断——height 不长=懒加载未触发，top 不动=滚动容器选错）
          let domCards = -1;
          if (infinite) {
            try {
              const m = await scrollMetrics(this.page);
              domCards = m.count;
              this.log('info', `滚动诊断：位置 ${m.top}/${m.height}(视口${m.client}) 卡片 ${m.count}`);
            } catch { /* 诊断失败忽略 */ }
          }
          if (rawCards.length === 0) {
            if (domCards > 0) {
              // DOM 里明明有卡片却一条都解析不出来 → 不是降权，是【选择器/Vue 状态结构失效】(登记册 R5)。
              // 走失败率通道告警，不要误报成"平台限流"。
              this.rt().riskMonitor.recordOpResult(false);
              this.log('warn', `推荐帧有 ${domCards} 张卡但解析出 0 条，疑似 BOSS 改版导致选择器失效`);
              this.rt().riskMonitor.recordAnomaly(`卡片解析失败（DOM ${domCards} 张 / 解析 0 条），疑似选择器失效`, 'notice');
            } else if (this.emptyGraceLeft > 0 && this.seenCardIds.size === 0) {
              // 首屏渲染宽限：推荐 iframe 还没渲染出卡时不该算"平台返空"。
              // 原实现会把启动瞬间的 3 次空 DOM 直接判成 emptyData → 误报降权 + 20min 熔断。
              this.emptyGraceLeft--;
              this.log('info', `推荐帧尚未渲染出候选人，等待中（剩余宽限 ${this.emptyGraceLeft} 次）…`);
              await this.interruptibleSleep(3000, myRunId);
              continue;
            } else {
              // DOM 真空：降权/限流软信号
              this.consecutiveEmptyPages++;
              this.rt().riskMonitor.setConsecutiveEmptyPages(this.consecutiveEmptyPages);
              if (this.consecutiveEmptyPages >= 3) {
                this.handleSignal('emptyData', `连续 ${this.consecutiveEmptyPages} 次`);
                // 登记册对 emptyData 的口径是「🟧 停 + 告警（疑似隐形降权/限流）」，所以这里：
                //   · 不能再下滑（那是刚确认被限流就又顶一枪）；
                //   · 也不能只 continue 回外层等冷却——推荐帧持续真空时 consecutiveEmptyPages
                //     一直 ≥3、等级恒 danger，会变成"冷却 20-60min → 醒来又空 → 指数退避再来一轮"，
                //     任务无限期挂在"熔断冷却中/已暂停"，用户等几小时也等不到结束。
                // 结论：本次运行到此为止，熔断窗口由控制器持久化留给下次启动。
                this.log('error', '推荐流连续多屏无数据，疑似隐形降权/限流；本次运行结束，'
                  + '建议改真人操作观察一段时间，勿立即重跑');
                break;
              }
            }
          }
          // 停止/夜闸复查：这行下面就是一次【真实网络请求】，不能在已要求停机后还发出去。
          // （夜闸此前补过，stop 漏了——用户点停止后本分支还会再滚最长 45 秒，与硬停语义矛盾）
          if (this.stopRequested || this.currentRunId !== myRunId) break;
          if (this.rt().riskMonitor.isNightNow()) continue;
          // 输入通道体检：窗口被最小化/遮挡时滚轮送不达，推荐流翻不动。
          // 这时候必须【暂停等环境恢复】，绝不能继续空滚然后判"已到底"。
          if (!(await this.waitUntilInteractable(myRunId))) break;
          // 等待期间用户可能手动暂停、或风控把任务暂停了。窗口恢复只解掉 windowHidden 这一个来源，
          // 若集合里还有别的来源，必须回循环顶走正常的暂停等待，不能直接往下发请求。
          if (this.isPaused) continue;
          this.mark('下滑加载(空屏分支)');
          const res = await this.loadMoreWithWatchdog(adapter, infinite);
          // 只有真的翻/滑成功才计入请求频率与翻页配额（blocked 与"按钮 disabled 直接
          // 返回 false"都没发请求，记了就是虚高，红线 10 次/5min 会被空转打到 danger）
          if (res === 'advanced') this.rt().riskMonitor.recordLoadMore();
          const advanced = res === 'advanced';
          if (advanced) this.pagesInQuery++;
          // 真实请求跑完且没触发任何信号 → 消耗一枚半开探针（探针只认触网动作，见 onCleanRequest）
          if (advanced) this.rt().riskController.onCleanRequest();
          // ⚠️ 只有【读到了但没有新人】才算一次干涸。blocked 是"根本没跑成"，
          // 把它计进干涸就会让页面卡顿/在飞阻塞几次之后打出绿色"任务完成"——假成功。
          if (res === 'blocked') {
            this.blockedScrolls = (this.blockedScrolls || 0) + 1;
            if (this.blockedScrolls >= 3) {
              this.log('error', '连续多次无法完成下滑（页面无响应或上一次下滑仍未结束），'
                + '本次运行结束——这不是"推荐流已到底"。');
              break;
            }
            this.mark('屏间间隔等待');
        await this.pace('scroll', myRunId);
            continue;
          }
          this.blockedScrolls = 0;
          this.consecutiveDryScrolls++;
          // ⚠️ 收敛判据必须和下面"本屏看完"那条分支同口径：只按【连续干涸次数】收敛。
          // 原写法是 `!advanced || dry >= MAX`，单次失败就终结整轮——而一次失败可能只是
          // 页面卡顿导致看门狗超时，却会以 success 记一句"任务完成"，用户看不出区别。
          // 日志里的"连续 N 次"当时也可能 N=1，与文案自相矛盾。
          if (!infinite || this.consecutiveDryScrolls >= this.MAX_DRY_SCROLLS) {
            // 收尾前再确认一次输入通道是好的：如果这几次干涸是在"窗口不可见"下发生的，
            // 那不是推荐流到底，而是环境不具备，不能报"任务完成"。
            if (infinite && (await isWindowVisible(this.page)) === false) {
              this.log('error', `连续 ${this.consecutiveDryScrolls} 次下滑无新增，但期间浏览器窗口不可见——`
                + '真实滚轮送不达、懒加载触发不了，这不是"推荐流已到底"。'
                + '请把 Chrome 窗口露出来后重新开始。');
              this.rt().riskMonitor.recordAnomaly('窗口不可见导致下滑无效，已按环境异常结束（非推荐流到底）', 'notice');
              break;
            }
            this.consecutiveEmptyPages = 0;
            this.rt().riskMonitor.setConsecutiveEmptyPages(0);
            // ★ 2026-08-18 产量重构·修复1（深翻干涸判据）：分页器平台（猎聘 !infinite）
            //   单页 0 新人不再【立即换组合】——真机实测单次广搜可翻 100 页，深翻才有产量。
            //   改为累计 consecutiveLowYieldPages，连续 MAX_LOW_YIELD_PAGES(3) 页内部去重后
            //   新人低于阈值才判该组合挖枯、换下一个搜索组合。这给深翻留出继续翻页的空间：
            //   单页偶尔 0 新人（排序靠后的页）不会一刀切断整个组合。
            //   原实现（!infinite 恒真→一屏 0 新人就换组合）是"猎聘跑起来产量趋零"的直接
            //   成因之一——每次广搜只挖前几页就放弃。2026-08-07 审查发现，2026-08-18 修正。
            if (!infinite) {
              this.consecutiveLowYieldPages++;
              if (this.consecutiveLowYieldPages >= this.MAX_LOW_YIELD_PAGES) {
                this.log('info', `本组合深翻到第 ${this.pagesInQuery} 页挖枯（连续 ${this.consecutiveLowYieldPages} 页新人低于 ${this.LOW_YIELD_PER_PAGE}/页），换下一个搜索组合`);
                // ★ 页深持久化：挖枯(软耗尽,非尾页) → depth 记当前真实页码(下次会话从 depth+1 续翻深挖)，
                //   但 done 不置 true（这不是平台尾页，下次继续往深翻还有产量，不该被续鲜窗口跳过）。
                const label = this.curQueryLabel();
                const curNo = await this.readCurrentPageNo();
                if (curNo > 0 && curNo > this.depthFor(label)) this.setDepth(label, curNo);
                this.pagesInQuery = this.queryMaxPages; // 逼 ensureQuery 换组合
                this.consecutiveLowYieldPages = 0;
                this.consecutiveDryScrolls = 0;
              } else {
                // 未到干涸阈值：继续翻下一页深翻（不计入 infinite 的 dry 收敛）。
                this.consecutiveDryScrolls = 0;
              }
              continue;
            }
            this.log('info', `推荐流已无更多新候选人（连续 ${this.consecutiveDryScrolls} 次下滑无新增），任务完成`);
            break;
          }
          this.state.stats.pagesBrowsed++;
          await this.op.wait('page');
          this.lastListUrl = this.safeUrl() || this.lastListUrl;
          this.candidateIndexOnPage = 0;
          await this.pace('scroll', myRunId); // 下滑批次间隔由控制器规划（压请求频率）
          continue;
        }

        // 有新候选人 → 复位干涸/空页/帧恢复计数
        this.consecutiveDryScrolls = 0;
        this.wsRecoveries = 0;
        this.consecutiveLowYieldPages = 0; // ★ 2026-08-18：有新人即复位深翻干涸计数
        this.emptyGraceLeft = RPAEngine.EMPTY_GRACE;
        this.rt().riskMonitor.recordOpResult(true); // 解析成功：喂失败率窗口（列表级下这是唯一可判成败的动作）
        if (this.consecutiveEmptyPages) { this.consecutiveEmptyPages = 0; this.rt().riskMonitor.setConsecutiveEmptyPages(0); }
        this.log('info', `本屏发现 ${freshCards.length} 位新候选人（累计浏览 ${this.state.stats.viewed}）`);

        for (const card of freshCards) {
          if (this.isPaused && !this.stopRequested) {
            await this.waitForResumeOrStop();
          }
          if (this.stopRequested) break;
          if (this.currentRunId !== myRunId) break; // M-03
          // 浏览器/页面中途死掉 → 立刻跳回外层，由 recoverFromPageDeath 如实处置。
          // 2026-07-29 真机：断连发生在一屏中间，而内层只查暂停/停止/熔断/夜闸，
          // 于是断连要等这一屏 15 张卡跑完才可能被发现；期间任何一次页面求值都会失败，
          // 反而先被风控检测撞上，最后报成了"检测到验证码/风控"——本地故障栽赃给平台。
          if (this.pageDead || this.browserDown) break;
          // 熔断中途打开（网络信号触发）→ 跳出去外层等冷却
          if (this.rt().riskController.cooldownRemainingMs() > 0) break;

          // 夜间硬闸也要在内层生效（一屏可能跑十几分钟，正好跨过 22:00）
          if (this.rt().riskMonitor.isNightNow()) break;

          // 内层风控巡检（≥60s 一次）：一屏最多 15 张卡、每张十几秒，原实现整屏期间
          // 只看网络信号，DOM 层验证码遮罩会有数分钟盲区。这里按时间节流补一次页面级检测。
          if (Date.now() - this.lastInlineRiskCheckAt >= 60000) {
            this.lastInlineRiskCheckAt = Date.now();
            if (await this.checkRiskPage(this.page)) {
              const kind: DefenseSignalKind = await this.getAdapter().classifyRiskKind(this.page);
              this.handleSignal(kind, '卡片浏览中检测到验证码/风控');
              break;
            }
          }

          if (browsedToday() >= dailyLimit) {
            this.log('info', '达到每日浏览上限（当日累计），停止');
            this.stopRequested = true;
            break;
          }
          // M-2（M-01/M-02）: 运行时长检查（内循环，扣除暂停）
          if (runDurationMs > 0 && this.effectiveElapsed() >= runDurationMs) {
            break;
          }

          const k = this.cardKey(card);
          if (k) this.seenCardIds.add(k); // 先登记去重键，杜绝异常/重试重复浏览同一人
          this.candidateIndexOnPage++;
          this.mark('浏览第 ' + this.candidateIndexOnPage + ' 位候选人');
          this.lastReadCard = card;
          if (this.listLevelMode) await this.viewCandidateListLevel(card, this.candidateIndexOnPage);
          else await this.viewCandidate(card, this.candidateIndexOnPage);

          // 闭环控制器：干净动作 → AIMD 加性增速 / 半开合闸；随后按控制器规划的拟人节奏停留
          this.rt().riskController.onCleanAction();
          this.mark('候选人间拟人停顿');
          await this.pace('candidate', myRunId);
        }

        if (this.stopRequested) break;
        if (runDurationMs > 0 && this.effectiveElapsed() >= runDurationMs) break;
        if (this.rt().riskController.cooldownRemainingMs() > 0) continue; // 熔断→回外层等冷却
        // 夜闸复查：一屏 15 人要跑十几分钟，很容易正好跨过 22:00。内层循环的夜间 break 只跳出卡片
        // 循环，若不在这里复查，下面就会在禁跑时段里 pace + 真发一次 getRecommendFriends 请求。
        // continue 回外层，由夜闸统一记日志停机（登记册口径：跨入即停机，不是暂停）。
        if (this.rt().riskMonitor.isNightNow()) continue;

        // 处理完当前屏新卡 → 下滑前批次间隔（控制器规划，压请求频率），再下滑加载/翻页取下一批
        // 真机 #4 反馈：本屏看完后要经历"屏间间隔 + 下滑加载"，加起来可能一分多钟没有任何日志，
        // 用户在界面上只看到沉默，会以为卡死然后手动暂停（实际它还在加载）。故把这两步都播报出来。
        {
          const gapMs = this.rt().riskController.peekNextWaitMs('scroll');
          // ★ 文案按平台语义区分：infinite=推荐流下滑；!infinite（猎聘分页器）=点下一页翻页。
          //   原"下滑加载下一屏"对分页平台误导（猎聘靠点分页器，不是滚轮）。
          this.log('info', `本屏 ${freshCards.length} 人已看完，间隔约 ${Math.round(gapMs / 1000)} 秒后${infinite ? '下滑加载下一屏' : '翻页（点下一页）'}…`);
        }
        await this.pace('scroll', myRunId);
        if (this.stopRequested || this.currentRunId !== myRunId) break;
        if (this.rt().riskMonitor.isNightNow()) continue; // 屏间间隔可能含 5-10min 长休，等完可能已跨入禁跑时段
        // 与空屏分支同一道闸：没有输入通道就别空滚（详见 ensurePageInteractable）
        if (!(await this.waitUntilInteractable(myRunId))) break;
        // 同上：等待期间若被手动/风控暂停，回循环顶按正常暂停流程处理，别直接发请求
        if (this.isPaused) continue;
        this.log('info', infinite ? '正在下滑加载下一屏…' : '正在翻页（点下一页）…');
        this.mark(infinite ? '下滑加载下一屏' : '翻页加载下一屏');
        const res2 = await this.loadMoreWithWatchdog(adapter, infinite);
        // ★ 只有真的翻成功才计翻页配额。原口径是"调用即记"，而 goNextPage 在
        //   「下一页按钮不存在」「按钮 disabled」时根本没发请求就返回 false，
        //   等于每个组合走到尾页都白扣一次配额，几十个组合就是三分之一日配额空转。
        if (res2 === 'advanced') this.rt().riskMonitor.recordLoadMore();
        const advanced = res2 === 'advanced';
        // 翻页成功 → 当前搜索组合的页数 +1（猎聘据此判断何时换下一个组合）
        if (advanced) this.pagesInQuery++;
        // 真实请求跑完且没触发任何信号 → 消耗一枚半开探针（探针只认触网动作，见 onCleanRequest）
        if (advanced) this.rt().riskController.onCleanRequest();
        if (res2 === 'blocked') {
          // 没跑成 ≠ 到底。不打印上一轮的陈旧诊断，也不计入干涸。
          this.blockedScrolls = (this.blockedScrolls || 0) + 1;
          if (this.blockedScrolls >= 3) {
            this.log('error', '连续多次无法完成下滑（页面无响应或上一次下滑仍未结束），'
              + '本次运行结束——这不是"推荐流已到底"。');
            break;
          }
          continue;
        }
        this.blockedScrolls = 0;
        // 把下滑的实际结果写进应用内日志（原先只 console 到主进程，用户看不到）
        const diag = getLastLoadMoreDiag();
        if (diag) this.log(advanced ? 'success' : 'warn', diag);
        if (advanced) {
          await this.op.wait('page');
          this.state.stats.pagesBrowsed++;
          this.lastListUrl = this.safeUrl() || this.lastListUrl; // C-3: 更新断点
          this.candidateIndexOnPage = 0;
          // ★ 页深持久化【步骤3·翻页实时更新页深】：分页平台翻页成功 → 读真实页码、更新 currentRealPageNo
          //   与 depth[label]（已翻到的最深真实页码，跨会话续翻靠它）。saveCursor 在切组合/收尾落盘。
          if (!infinite) {
            const realNo = await this.readCurrentPageNo();
            if (realNo > 0) {
              this.currentRealPageNo = realNo;
              const label = this.curQueryLabel();
              // 只增不减（保留该组合已到的最深页码；dedup/回翻不应让 depth 倒退）
              if (realNo > this.depthFor(label)) this.setDepth(label, realNo);
            }
          }
        } else if (!infinite) {
          // ⛔⛔ 2026-08-13 真机：原来这里是 `log('已到达最后一页，任务完成'); break;` ——
          //   对【分页平台】把「本搜索组合翻不动了」直接当成「整个任务完成」，跳出主循环。
          //   后果是猎聘 12 个搜索组合【永远只跑第 1 个】：实测 30 分钟只出 searches=1、
          //   80 人，而 12 组合 × 每组合 8 页 × 20 人 ≈ 1900 人的潜力全被丢掉，
          //   周产量口径直接从 9000+ 掉到 ~500，6000/周的目标根本够不着。
          //   正确语义：翻不动 = 本组合的页看完了 → 逼下一轮换组合；
          //   只有 ensureQuery 判定「全部组合跑完一轮」时才真正结束任务（它自己会 break）。
          this.log('info', '本组合已到最后一页，换下一个搜索组合');
          // ★ 页深持久化【步骤4·到尾页】：已到平台尾页(next disabled) → 记 done[label]=true、
          //   depth 记当前真实页码、记绕圈时间戳。下次会话按 RESCAN_AFTER_DAYS 决定续鲜重置或跳过。
          const label = this.curQueryLabel();
          const curNo = await this.readCurrentPageNo();
          if (curNo > 0) this.setDepth(label, curNo);
          this.setDone(label, true);
          this.pagesInQuery = this.queryMaxPages; // 逼 ensureQuery 推进到下一个组合
          this.candidateIndexOnPage = 0;
          continue;
        } else {
          // infinite 且本次下滑没能前进（疑似已到底）→ 计一次干涸，连续多次即收敛结束
          this.consecutiveDryScrolls++;
          if (this.consecutiveDryScrolls >= this.MAX_DRY_SCROLLS) {
            // 同上：窗口不可见时的"翻不动"是环境问题，不是推荐流到底，别报成功
            if ((await isWindowVisible(this.page)) === false) {
              this.log('error', `连续 ${this.consecutiveDryScrolls} 次下滑无新增，但期间浏览器窗口不可见——`
                + '真实滚轮送不达、懒加载触发不了，这不是"推荐流已到底"。请把 Chrome 窗口露出来后重新开始。');
              this.rt().riskMonitor.recordAnomaly('窗口不可见导致下滑无效，已按环境异常结束（非推荐流到底）', 'notice');
              break;
            }
            this.log('success', '推荐流已到底，任务完成');
            break;
          }
        }
      } catch (e: any) {
        if (this.stopRequested || this.currentRunId !== myRunId) break;
        // C-3: 页面崩溃/Target closed → 恢复；其它错误上抛给 start() 的 catch
        if (this.isFatalPageError(e) || this.pageDead) {
          const ok = await this.recoverFromPageDeath(myRunId);
          if (this.currentRunId !== myRunId || this.stopRequested) break;
          if (ok) continue;
          this.transition('error'); // S1: 集中状态转移
          break;
        }
        throw e;
      }
    }

    // 评分体检：本轮哪些维度在空转、哪个必选词零命中、JD 城市与候选池是否对得上。
    // 放在收尾统计【之前】打印——它解释的正是"为什么一个高匹配都没有"，
    // 用户看完分数紧接着就该看到原因，而不是自己去数 75 行日志。
    try {
      for (const line of this.scoreAudit?.report(this.jd) || []) this.log('warn', line);
    } catch (e: any) {
      this.log('info', `评分体检未能生成（不影响结果）：${e?.message || e}`);
    }

    // ★ 2026-08-19 P2-b：所有终止路径都落一条统一格式的收尾汇总行。
    //   「任务结束:浏览X·去重后新增Y人·跳过已收录Z人·深翻N页(收尾原因)」。
    //   此前 status==='error'（浏览器断开/崩溃不可恢复）直接跳过、不落汇总行，
    //   90min 收敛 / done / stopped 之外的 browserDown 路径看不到净增量。
    //   现在统一都落一行：error/browserDown 走非绿色文案，其余按原因分级。
    //   ⚠️ 不一律绿色：风控硬停 / 环境异常中止 / 浏览器断开走非绿色，用户在日志里
    //      才分得清"正常跑完"和"被风控/断连停掉"，审计链不断。
    //   ★ 收尾统计含「新增(去重后) N 人 / 跳过 M 人」——周产量 6000+ 目标的验收口径是
    //      不重复的人(非浏览次数)。深翻+更新时间排序+跨轮持久去重后产出都是新人。
    const statsLine = `任务结束:浏览 ${this.state.stats.viewed} 人·去重后新增 ${this.newTalentsThisRun} 人·跳过已收录 ${this.skippedAlreadySeen} 人·深翻 ${this.state.stats.pagesBrowsed} 页`;
    if (this.state.status === 'error' || this.isBrowserDown()) {
      // C-3: 不可恢复错误 / 浏览器断开 —— 非绿色，落汇总行让人看到净增量与原因。
      const why = this.isBrowserDown() ? '浏览器断开/崩溃不可恢复' : '不可恢复错误';
      this.log('error', `${statsLine}（收尾原因：${why}，未正常完成）`);
    } else if (this.rt().riskMonitor.hasBlockingAnomaly()) {
      this.log('error', `${statsLine}（收尾原因：风控停机，需人工确认后才能再启动）`);
    } else if (this.rt().riskMonitor.isNightNow()) {
      this.log('warn', `${statsLine}（收尾原因：进入禁跑时段）`);
    } else if (this.stopRequested) {
      this.log('info', `${statsLine}（收尾原因：手动停止）`);
    } else {
      this.log('success', `${statsLine}（收尾原因：正常完成）`);
    }
  }

  // 真机校准：列表级评分（推荐流）——不点开详情、不导航、零写操作。用卡片富数据直接评分落库，风控最低。
  private async viewCandidateListLevel(card: CandidateProfile, indexOnPage: number) {
    if (!this.page || !this.op) return;
    this.candidateGreeted = false;
    this.candidateFavorited = false;

    this.state.stats.viewed++;
    this.rt().riskMonitor.recordBrowse();

    // C3(2026-08-05)：scoreText 接线——猎聘绕 woff2 字体反爬靠读渲染后文本（detailText/cardText），
    // BOSS 的 scoreText 是 no-op 返回 undefined。把它并到 selfIntro 让评分引擎的 buildSegmentedText 能读到。
    // 用浅副本 + 不修改原 card，避免入库数据被污染。
    const adapter = this.getAdapter();
    const scoreText = typeof adapter.scoreText === 'function' ? adapter.scoreText(card) : undefined;
    const cardForScore: CandidateProfile = scoreText
      ? { ...card, selfIntro: [card.selfIntro, scoreText].filter(Boolean).join('\n') }
      : card;

    let score: ScoreResult | null = null;
    if (this.jd) {
      // 列表级：必须显式声明 card 档（引擎自动判会因卡片恒带 education 而误判成 detail，
      // 使卡片层封顶与"卡片不得评 high"两条安全线失效）。畸形候选人对象不应让整轮崩掉。
      try {
        score = scoreCandidate(cardForScore, this.jd, 'card');
      } catch (e: any) {
        this.log('warn', `评分失败，按未评分处理：${e?.message || e}`);
        score = null;
      }
    }
    if (score) {
      this.rt().riskMonitor.recordScoreBucket(score.level);
      this.scoreAudit?.add(score, cardForScore);
      this.log(
        score.level === 'high' ? 'success' : 'info',
        `#${indexOnPage} ${this.scoreLabel(score)} — ${this.maskName(card.name)}`,
      );
    } else {
      this.log('info', `#${indexOnPage} 已抓取 — ${this.maskName(card.name)}（未激活 JD，暂不评分）`);
    }

    // 列表级：card 已带 url(boss:geek:锚)/令牌，直接落库；收藏/打招呼属写操作，列表级一律跳过
    this.saveCandidateExport(card, score, card.url, cardForScore);
    // 拟人扫读节奏（停留/细看/批休/长休/前瞻降速）已统一交给 RiskController.pace()，此处只做评分落库。
    this.scheduleEmit();
  }

  // C4(2026-08-05)：【当前不可达】阶段 B（详情深挖）代码保留但不会被执行，原因：
  //   · BOSS 侧 deepScrape 默认 false 且 UI 无开关 → stageBEnabled() 恒 false → listLevelMode 恒 true
  //   · 猎聘侧 liepinEnableStageB 默认关，业务方已定第一轮真机强制关闭阶段 B
  //   · SettingsPage 的自动打招呼总闸也属于阶段 B，同样已置灰
  //   保留代码是因为阶段 B 后面要开，删了将来又要加回来。真要开的时候，同时把：
  //   ① UI 上的自动打招呼总开关 / 阶段 B 开关解除置灰  ② 风险登记册再评估
  //   ③ 真机发送流程先跑通  ④ 验收通过后再放出去。
  private async viewCandidate(card: CandidateProfile, indexOnPage: number) {
    if (!this.page || !this.op) return;
    const adapter = this.getAdapter();
    this.candidateGreeted = false;
    this.candidateFavorited = false;

    // 细粒度日志：点击卡片
    this.log('info', `点击第 ${indexOnPage} 位候选人卡片`);
    let clicked = false;
    try {
      const el = await adapter.findCardElement(this.page, card);
      if (el) {
        clicked = await this.op.clickElement(el);
      }
      if (!clicked) {
        this.log('warn', `未找到对应卡片: ${this.maskName(card.name) || card.position?.slice(0, 8) || '未知'}`);
        return;
      }
    } catch (e) {
      if (this.isFatalPageError(e)) throw e; // C-3: 页面已死 → 上抛触发恢复，勿吞成 warn
      this.log('warn', `点击卡片失败: ${e}`);
      return;
    }

    await this.op.wait('page');
    this.state.currentPage = '候选人详情页';
    // M-23: 会话级计数（本次运行内累计）；跨会话/当日累计以 this.rt().riskMonitor 为准（recordBrowse/recordGreet/recordFavorite → bumpDaily）
    this.state.stats.viewed++;
    this.state.stats.pagesBrowsed++;
    this.rt().riskMonitor.recordBrowse();

    if (await this.checkRiskPage(this.page)) {
      // 深挖模式的详情页此前走的是"直接暂停"，绕开了 handleSignal：
      // 不分级、不喂控制器（不降速/不熔断）、不按信号类型给冷却，
      // 等于这条路径上 18 类信号被统一降级成一个笼统的暂停（审计 2026-07-29）。
      // 改为与主循环同一条处置链——外层已经这么做了，没有理由在详情页另搞一套。
      const kind: DefenseSignalKind = await this.getAdapter().classifyRiskKind(this.page);
      this.handleSignal(kind, '候选人详情页检测到验证码/风控');
      return;
    }

    // T3 猎聘详情配额兜底：打开详情前检查是否已达上限
    // 与 browsedToday 同口径：按当日累计（跨多次运行）门控
    const limits = adapter.resolveDailyLimits(
      normalizeSpeedMode(this.task?.speed?.mode || 'human'),
      getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS),
    );
    if (limits.details > 0 && this.detailsOpenedThisRun >= limits.details) {
      this.log('warn', `今日详情已达配额上限（${limits.details}），跳过详情抽取，按列表级落库`);
      // 回退到列表级处理：不打开详情，只用卡片数据评分落库
      return await this.viewCandidateListLevel(card, indexOnPage);
    }
    this.detailsOpenedThisRun++;
    // ★ 打开详情在某些平台 = 真实扣一份套餐额度。必须记在【打开之前】：
    //   平台是"打开即扣"，抽取失败或中途出错都不会把钱退回来。
    //   记什么、怎么记由平台自己决定（引擎不认识任何平台的计费规则）。
    try { adapter.onDetailOpened?.(card); } catch { /* 记账失败不阻断抓取 */ }
    // C1: 记录详情消耗（猎聘打开即扣真金白银）
    this.rt().riskMonitor.recordDetail();

    // M-4: 分段滚动阅读（模拟人浏览详情）
    this.log('info', '阅读候选人详情...');
    await this.op.smallWait();
    await this.op.scrollToBottom(false); // 分段滚动+偶尔回滚，已有拟人等待
    await this.op.wait('scroll');

    // 提取详情。★ 必须走 adapter.mergeDetail，不能 Object.assign：
    //   详情结果只带补充字段，直接展开会把列表阶段拿到的【稳定锚】整块冲掉
    //   （BOSS 的 bossMeta.encryptGeekId、猎聘的 liepinMeta.resIdEncode）——
    //   而去重、详情深链、人才池主键全靠那个锚。两个 adapter 的 mergeDetail
    //   本来就是为此写的，之前一直是死实现。
    const detail = await adapter.extractDetail(this.page);
    const c: CandidateProfile = adapter.mergeDetail(card, detail);

    // C3(2026-08-05)：scoreText 接线（与 listLevel 同口径）
    const st = typeof adapter.scoreText === 'function' ? adapter.scoreText(c) : undefined;
    const cForScore: CandidateProfile = st
      ? { ...c, selfIntro: [c.selfIntro, st].filter(Boolean).join('\n') }
      : c;

    // 评分
    let score: ScoreResult | null = null;
    if (this.jd) {
      // 详情级：显式 detail 档（拿到完整履历才有资格做极端判断）。同样不让畸形对象炸掉整轮。
      try {
        score = scoreCandidate(cForScore, this.jd, 'detail');
      } catch (e: any) {
        this.log('warn', `评分失败，按未评分处理：${e?.message || e}`);
        score = null;
      }
    }
    if (score) {
      this.rt().riskMonitor.recordScoreBucket(score.level);
      this.scoreAudit?.add(score, cForScore);
      this.log(
        score.level === 'high' ? 'success' : 'info',
        `${this.scoreLabel(score)} — ${this.maskName(c.name)}`,
      );
    }

    const actions = this.task!.actions;
    // ★ 平台列表页没有收藏控件时【整步跳过】，不做"试一下失败就算了"。
    //   否则每个候选人都会 tryFavorite 失败一次并计入 recordOpResult，
    //   操作失败率恒 100% → 风控熔断把整条线打停（详见 PlatformAdapter.supportsListFavorite）。
    const listFavoriteSupported = adapter.supportsListFavorite !== false;
    if (actions.autoFavorite && !listFavoriteSupported && !this.favoriteUnsupportedLogged) {
      this.favoriteUnsupportedLogged = true;
      this.log('info', `${adapter.name}列表页没有收藏按钮，跳过收藏——候选人已存入平台自己的人才库，链接可随时打开`);
    }
    if (listFavoriteSupported && actions.autoFavorite && score && score.total >= actions.favoriteThreshold) {
      // 收藏是【写操作】，必须和打招呼同口径受每日上限门控——原先只判匹配分不判配额，
      // 一旦启用深挖模式就会无限收藏且不触发任何风控计数。上限权威取自档位，不可人工调。
      const favLimit = getDefaultLimits(normalizeSpeedMode(this.task!.speed.mode), this.getPlatform()).favorite;
      const favLeft = favLimit - this.rt().riskMonitor.getTodayCounts().favorite;
      if (favLeft <= 0) {
        this.log('warn', `今日收藏已达上限（${favLimit}），跳过收藏`);
      } else {
        this.log('info', '点击「收藏」');
        const ok = await adapter.tryFavorite(this.page, this.op);
        this.rt().riskMonitor.recordOpResult(ok); // 失败率监控
        if (ok) {
          this.candidateFavorited = true;
          this.state.stats.favorited++;
          this.rt().riskMonitor.recordFavorite();
          this.log('success', '已收藏该候选人');
        } else {
          this.log('warn', '收藏按钮未找到');
        }
        await this.op.wait('click');
      }
    }
    // F-3: 自动打招呼受总闸 enableAutoGreet 约束（方案 7.2"确认安全后加"，默认关）
    //
    // 另外两道闸：
    //  · c.contacted —— 卡片上的 haveChatted/isFriend。已经聊过的人不再自动打招呼：
    //    重复打扰对候选人不友好，而登记册 R6 里 BOSS 冻结的 2.5 万账号多数正是因骚扰投诉。
    //    这个字段之前采了却没人用，"避免重复打扰"只停在注释里。
    //  · lowConfidence —— 覆盖度不足时不做对外动作。打招呼是不可撤回的，
    //    证据不充分就不该发（评分侧已把这类降级为 medium，这里再兜一道）。
    const alreadyContacted = !!(c as any).contacted;
    const lowConfidence = !!(score as any)?.lowConfidence;
    if (alreadyContacted) this.log('info', `${this.maskName(c.name)} 此前已沟通过，跳过自动打招呼`);
    const shouldGreet = this.autoGreetMaster && actions.autoGreet && score
      && !score.mismatch && !alreadyContacted && !lowConfidence
      && score.total >= actions.greetThreshold;
    if (shouldGreet) {
      // 招呼上限同样权威取自档位（不可人工调）
      const dailyLimit = getDefaultLimits(normalizeSpeedMode(this.task!.speed.mode), this.getPlatform()).greet;
      const greetLeft = dailyLimit - this.rt().riskMonitor.getTodayCounts().greet;
      if (greetLeft > 0) {
        this.log('info', '点击「立即沟通」发送招呼');
        const ok = await adapter.tryGreet(this.page, this.op, this.getGreetMessage());
        this.rt().riskMonitor.recordOpResult(ok); // 失败率监控
        if (ok) {
          this.candidateGreeted = true;
          this.state.stats.greeted++;
          this.rt().riskMonitor.recordGreet();
          this.log('success', '已发送招呼');
          this.consecutiveGreetFails = 0;
          this.rt().riskMonitor.setAccountRestricted(false);
        } else {
          this.consecutiveGreetFails++;
          this.log('warn', `招呼失败（连续 ${this.consecutiveGreetFails} 次）`);
          if (this.consecutiveGreetFails >= 3) {
            this.log('error', '连续多次招呼失败，疑似账号被限制沟通');
            this.rt().riskMonitor.setAccountRestricted(true);
          }
        }
        this.rt().riskMonitor.setConsecutiveGreetFails(this.consecutiveGreetFails); // 同步指标，杜绝死字段
        await this.op.wait('click');
      } else {
        // 达到当日招呼上限 —— 不计为失败（只是配额到了），但也不再尝试
        this.log('warn', '今日打招呼已达上限，跳过招呼');
        this.consecutiveGreetFails = 0; // P1-2 修复：配额用尽不算"失败"
      }
    } else {
      // 不满足打招呼条件（没开/分不够/总闸关）—— 也不算失败，复位
      this.consecutiveGreetFails = 0;
    }

    this.saveCandidateExport(c, score, card.url, cForScore);

    this.log('info', '返回搜索列表');
    await this.op.back();
    await this.op.wait('click');
    this.state.currentPage = `${adapter.name} · 搜索结果页`;
    this.lastListUrl = this.safeUrl() || this.lastListUrl; // C-3: 返回后更新断点
    this.scheduleEmit(); // M-19: 每候选人一次，合并广播
  }

  // 闭环控制器：统一信号入口。喂控制器(调速率/熔断) + 记风险历史(留痕) + 需人工则硬停通知。
  private handleSignal(kind: DefenseSignalKind, detail?: string) {
    const r = this.rt().riskController.onSignal(kind, detail);
    // 风控信号是最需要事后复盘的一类事件：什么时候、什么信号、怎么处置的、当时跑到哪了
    try {
      oplog('risk', kind, {
        detail: String(detail || '').slice(0, 200),
        needHuman: r.needHuman, tripped: r.tripped, escalated: r.escalated,
        debounced: r.debounced, cooldownMin: Math.round((r.cooldownMs || 0) / 60000),
        viewed: this.state.stats?.viewed ?? 0,
      }, { ok: false, platform: this.getPlatform() });
    } catch { /* ignore */ }
    // 去抖窗口内的重复信号：控制器已吸收（不叠加退避），这里也不再写历史/刷日志。
    // 典型场景：被判 code:35 后 BOSS 每个 wapi 响应都返 35，不吸收会把指数退避一次打到上限、
    // 并向 risk_history 灌几十条重复记录。
    if (r.debounced) {
      if (r.needHuman && !this.stopRequested) this.stop(); // 需人工的信号仍要确保已停
      return;
    }
    // 「任何风吹草动都要记录」——一律留痕，不弹框
    this.rt().riskMonitor.recordAnomaly(r.reason, r.needHuman ? 'danger' : 'notice');
    if (r.needHuman) {
      // 需人工介入（验证码/验证页/账号受限/环境检测，或入口层信号第2次升级）→ 硬停 + 置闩触发通知/决策框
      this.rt().riskMonitor.setPageAnomaly(true, r.reason);
      if (r.escalated) {
        this.log('error', `风控信号[入口层再次触发·升级硬停]：${r.reason}。已停机，需人工确认账号状态后才能再启动`);
        this.rt().riskMonitor.notifyUser('⛔ 入口层风控再次触发 · 已停机', `${r.reason}\n本次运行内第二次，已升级为硬停。请人工确认账号状态后再继续。`, true);
      } else {
        this.log('error', `风控信号[需人工介入·已停]：${r.reason}`);
      }
      this.stop();
    } else if (r.tripped) {
      // 退避熔断（无需人工）→ 不停，镜像冷却到 this.rt().riskMonitor（UI 横幅 + 调度门控），主循环 planNext 会自动等冷却→半开
      this.rt().riskMonitor.enterCooldown(r.cooldownMs, r.reason, 'notice');
      const mins = Math.round(r.cooldownMs / 60000);
      this.log('warn', `风控信号[自动熔断退避]：${r.reason}，冷却 ${mins} 分钟后半开试探`);
      if (r.notify) {
        // 入口层信号（code:35）即使自动退避也要让用户知情——不能只在风险中心默默记一笔
        this.rt().riskMonitor.notifyUser('⚠️ 入口层风控触发 · 已自动退避', `${r.reason}\n已降到最低速率并冷却 ${mins} 分钟；若本次运行内再次触发将直接停机。`);
      }
    } else {
      this.log('info', `风控软信号[降速]：${r.reason}`);
    }
  }

  // 闭环控制器：按控制器规划的节奏等待（拟人停留 + 前瞻降速 + 45min长休 + 批休；熔断则镜像冷却）。
  private async pace(kind: PaceKind, myRunId: number) {
    const plan = this.rt().riskController.planNext(kind);
    if (plan.circuitOpen) {
      this.rt().riskMonitor.enterCooldown(plan.waitMs, plan.reason || '熔断冷却', 'notice');
      this.state.currentPage = '风控熔断冷却中';
      this.log('warn', plan.reason || '风控熔断冷却中');
    } else if (plan.restKind === 'big') {
      this.log('info', `反风控宏观长休约 ${Math.round(plan.waitMs / 60000)} 分钟…`);
    } else if (plan.restKind === 'pageBlock') {
      this.log('info', `已连翻 5 页，按档位一要求强制休息约 ${Math.round(plan.waitMs / 60000)} 分钟…`);
    } else if (plan.restKind === 'predictive') {
      this.log('info', `前瞻可疑度偏高，主动降速插休约 ${Math.round(plan.waitMs / 1000)} 秒…`);
    }
    // ★ 2026-08-13：候选人之间的这段停顿，用「阅读当前卡片」填满，而不是干等。
    //   复盘发现的机器特征：猎聘侧既不打招呼（合规设计）、卡片上又没有收藏控件，
    //   于是每个候选人的处理是纯 DOM 抽取 + 本地评分 + 入库——浏览器里【零交互】，
    //   然后静等 8~16 秒。一屏 20 人 ≈ 4 分钟鼠标完全冻结，接着突然一次精确的滚动+点击。
    //   「死寂 → 精确动作 → 死寂」比"点得太快"更像机器：真人读列表时鼠标会顺着往下飘、
    //   在名字上停一下、偶尔小幅滚动，持续产生低幅噪声；一动不动整整四分钟的人不存在。
    //   readCard 在同样的时长内产生这些噪声，不点击、不发任何请求——
    //   只改变行为轨迹的形状，不改变请求频率，因此不影响任何配额与风控口径。
    // ★★ 2026-08-13 复审修正（agent + 自查合并）：
    //   「是否演拟人动作」的判据是【这次等待是不是一次休息/冷却】，而不是 kind。
    //   原来只给 idleDrift 分支加了 `!circuitOpen && restKind!=='big'` 守卫，
    //   却漏给 readCard——而 candidate 是最高频的 pace（一屏 20 次），
    //   45 分钟宏观长休（restKind='big'，waitMs 5~10 分钟）几乎必然由某个 candidate 撞线。
    //   撞上时 readCard 会拿这 5~10 分钟持续游走鼠标+滚动列表，把本该【静止的宏观休息】
    //   变成【持续动几分钟】——这跟"真人翻久了会离开"的反风控意图完全相反，
    //   等于亲手废掉最贵最像人的那条节奏。所以任何 rest/熔断一律【纯 sleep，不演戏】。
    const isRestOrBreak = plan.circuitOpen
      || plan.restKind === 'big' || plan.restKind === 'predictive' || plan.restKind === 'pageBlock';

    if (!isRestOrBreak && this.op && this.page) {
      // ★ deadline：让 readCard/idleDrift 内部的 expired() 真正生效。此前猎聘链路从不
      //   setDeadline，那些 if(expired()) 全是死代码，导致这段拟人动作【无法被停止打断】。
      //   给一个不超过 waitMs 的截止时间；到点内部循环会干净收工，stop 也能及时生效。
      this.op.setDeadline(Date.now() + plan.waitMs);
      try {
        if (kind === 'candidate' && this.lastReadCard) {
          const el = await this.getAdapter().findCardElement(this.page, this.lastReadCard).catch(() => null);
          await this.op.readCard(el, plan.waitMs);
          await this.op.occasionalSlip();
        } else if (plan.waitMs >= 8000) {
          // 屏间 / 组合切换等较长的普通等待：发呆。短等待（<8s）不值得演，直接落到下面 sleep。
          await this.op.idleDrift(plan.waitMs);
        } else {
          await this.interruptibleSleep(plan.waitMs, myRunId);
        }
        return;
      } catch {
        /* 拟人动作失败绝不中断整轮——但也【不能】再下沉去跑一遍别的拟人分支
           （那会让单个候选人的等待被放大成两段），直接落到最底下的纯 sleep 兜底。 */
      } finally {
        this.op.clearDeadline();
      }
    }
    // 休息/冷断，或上面出异常：纯等待。interruptibleSleep 本身能响应 stop/换轮。
    await this.interruptibleSleep(plan.waitMs, myRunId);
  }

  // 让目标页变成"能收输入事件"的状态，并返回是否成功。
  //
  // 真机 2026-07-28 实测（这条链是硬约束，不是优化）：
  //   · Chrome 窗口最小化 → Input.dispatchMouseEvent 永不回执；
  //   · 窗口最大化但【被其他窗口完全遮挡】（Windows 原生遮挡计算）→ 同样永不回执，
  //     document.visibilityState 也是 hidden。
  // 也就是说 visibilityState 是"输入能不能送达"的可靠预判。
  // 没有输入通道 → 真实滚轮发不出去 → 程序化滚动虽然能把位置推到底，
  // 却触发不了 BOSS 的懒加载 → 推荐流翻不动。
  // 这里先尽力自救（还原窗口 + 把标签页切到前台），自救不了就如实返回 false，
  // 由调用方决定是拒绝启动还是暂停——绝不能当作"推荐流已到底"。
  private async ensurePageInteractable(): Promise<boolean> {
    if (!this.page) return false;
    if ((await isWindowVisible(this.page)) !== false) return true;
    try {
      const s = await (this.page as any).createCDPSession?.();
      if (s) {
        try {
          const { targetInfo } = await s.send('Target.getTargetInfo');
          const w = await s.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
          if (w?.bounds?.windowState === 'minimized') {
            await s.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
          }
        } catch { /* 老版本 Chrome 可能没有 Browser 域权限 */ }
        try { await s.detach(); } catch { /* ignore */ }
      }
      // 把 BOSS 标签页切到它所在窗口的前台（不抢 OS 焦点，窗口若被别的程序盖住仍然无效）
      await this.page.bringToFront();
    } catch { /* 自救失败按不可交互处理 */ }
    await sleep(600);
    return (await isWindowVisible(this.page)) !== false;
  }

  // 等页面重新变得可交互（窗口露出来）。期间进入 windowHidden 暂停态，环境恢复即自动继续。
  // 返回 false 表示应当退出主循环（用户停止/被接管/等太久放弃）。
  private async waitUntilInteractable(myRunId: number): Promise<boolean> {
    if (await this.ensurePageInteractable()) {
      if (this.pauseReasons.has('windowHidden')) {
        this.removePause('windowHidden');
        this.tryResumeRunning();
        this.log('success', '浏览器窗口已恢复可见，继续找人');
      }
      return true;
    }
    if (!this.pauseReasons.has('windowHidden')) {
      this.log('warn', `${this.getAdapter().name}浏览器窗口不可见（多半是被最小化了），拟人化输入事件送不达，`
        + '已暂停等待。把该窗口还原出来即自动继续。');
      this.enterPause('windowHidden');
    }
    // 最多等 10 分钟；期间每 15 秒探一次
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (this.stopRequested || this.currentRunId !== myRunId) { this.removePause('windowHidden'); return false; }
      if (this.rt().riskMonitor.isNightNow()) {
        // 这条路径原来一行日志都不写、也不留痕，等待窗口恢复期间跨进禁跑时段就静默结束了，
        // 事后翻日志完全看不出发生过什么。
        this.log('error', `等待浏览器窗口恢复期间进入禁跑时段（${this.rt().riskMonitor.nightWindowLabel()}），本次运行结束`);
        this.rt().riskMonitor.recordAnomaly('等待窗口恢复期间跨入禁跑时段，自动停机', 'notice');
        this.removePause('windowHidden');
        return false;
      }
      await this.interruptibleSleep(15000, myRunId);
      if (this.stopRequested || this.currentRunId !== myRunId) { this.removePause('windowHidden'); return false; }
      if (await this.ensurePageInteractable()) {
        this.removePause('windowHidden');
        this.tryResumeRunning();
        this.log('success', '浏览器窗口已恢复可见，继续找人');
        return true;
      }
    }
    this.log('error', '等待浏览器窗口恢复可见超过 10 分钟仍未成功，本次运行结束。');
    this.removePause('windowHidden');
    return false;
  }

  // 下滑加载的统一入口：心跳播报 + 硬性兜底超时。
  //
  // 真机 2026-07-28：一次下滑跑了 745 秒，界面上从 11:20:31 到 11:32:51 一条日志都没有，
  // 用户只能凭感觉判断"是不是卡死了"然后手动暂停。适配层已经把预算做实了（30s），
  // 这里再加两道保险：① 每 10 秒播报一次"还在等"，让静默不可能再发生；
  // ② 45 秒仍未返回就当本次下滑失败继续走——引擎绝不为任何一次页面操作无限期等待。
  // 上一次因看门狗超时而被放弃、但仍在后台跑的下滑任务。
  // Promise.race 只放弃【等待】，不会终止【工作】——不设这个闸的话，主循环下一轮又发起一次下滑，
  // 两个 loadMore 会并发操作同一个 HumanOperator/CDP 会话：滚轮事件交错、可能连发两次
  // getRecommendFriends，而 recordLoadMore 只记了新的那次 → 请求频率代理失真，
  // 而这恰恰是登记册里最敏感的风控指标。
  private loadMoreInFlight: Promise<boolean> | null = null;

  private async loadMoreWithWatchdog(
    adapter: ReturnType<typeof getPlatformAdapter>,
    infinite: boolean,
  ): Promise<'advanced' | 'no-new' | 'blocked'> {
    // 上一次的孤儿任务还没落地就别再发起——等它自己结束（最多再等 45s），期间不产生新请求
    if (this.loadMoreInFlight) {
      // ⚠️ 必须有上限。原来是裸 await，孤儿任务可能因为底层 CDP 调用（createCDPSession /
      // dispatchMouseEvent）只受 protocolTimeout 60s 约束而挂很久，实测把下一次下滑
      // 又阻塞了 24 秒、端到端 69 秒；期间点「停止」也没反应（stop 只置标志，await 不返回）。
      this.log('warn', `loadMoreWithWatchdog 进入时已有孤儿任务在飞（inFlight 非空），本轮判 blocked 等它结束（最多 45 秒）`);
      let t: NodeJS.Timeout | null = null;
      try {
        await Promise.race([
          this.loadMoreInFlight.catch(() => false),
          new Promise((r) => { t = setTimeout(r, 45000); }),
        ]);
      } catch { /* 它的错误由它自己那轮处理 */ } finally { if (t) clearTimeout(t); }
      return 'blocked';
    }
    const started = Date.now();
    const beat = setInterval(() => {
      this.log('info', `下滑加载已等待 ${Math.round((Date.now() - started) / 1000)} 秒，页面响应较慢，仍在等待…`);
    }, 10000);
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    // 用 sentinel 区分"工作正常返回 false"和"超时放弃"，并把致命页面错误原样抛出去
    const TIMEOUT = Symbol('loadMore-timeout');
    const work = (infinite
      ? (adapter as any).loadMore(this.page, this.op)
      : adapter.goNextPage(this.page!, this.op!)) as Promise<boolean>;
    // 记为在飞；无论成败都在落地时清掉（超时后这个 then 仍会执行，正是我们要的"落地通知"）
    this.loadMoreInFlight = work;
    work.catch(() => false).finally(() => {
      if (this.loadMoreInFlight === work) this.loadMoreInFlight = null;
    });
    try {
      const r = await Promise.race([
        work,
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            this.log('warn', '下滑加载超过 55 秒仍无结果，判本次未完成（不再等待）');
            resolve(TIMEOUT);
          }, 55000);
        }),
      ]);
      // 超时 ≠ 推荐流到底。区分开，让调用方不要把它计进"连续干涸"。
      if (r === TIMEOUT) {
        this.log('warn', `loadMoreWithWatchdog 返回 blocked（真实取值=blocked，来源=超时 55 秒未完成），进入时 inFlight 非空=N`);
        return 'blocked';
      }
      const adv = r ? 'advanced' : 'no-new';
      this.log('info', `loadMoreWithWatchdog 返回 ${adv}（真实取值=${adv}），进入时 inFlight 非空=N`);
      return adv;
    } catch (e) {
      // ⚠️ 不能盲吞：页面崩溃/Target closed 若被吞成 advanced=false，
      // 空屏分支会把它当成"推荐流已到底"，以 success 记一句"任务完成"结束，
      // C-3 的崩溃恢复链路完全没机会执行，断点也不记录。致命错误必须原样上抛。
      if (this.isFatalPageError(e) || this.pageDead) throw e;
      this.log('warn', `loadMoreWithWatchdog 返回 blocked（真实取值=blocked，来源=出错：${(e as any)?.message || e}），进入时 inFlight 非空=N`);
      return 'blocked';
    } finally {
      if (!timedOut && this.loadMoreInFlight === work) this.loadMoreInFlight = null;
      clearInterval(beat);
      if (timer) clearTimeout(timer);
    }
  }

  // 候选人去重唯一键——委托给平台 adapter（BOSS: encryptGeekId / 猎聘: resIdEncode）。
  private cardKey(c: CandidateProfile): string {
    return this.getAdapter().cardKey(c);
  }

  private maskName(name: string | undefined): string {
    if (!name) return '未知';
    if (name.length <= 1) return name;
    return name[0] + '**';
  }

  /**
   * @param profileForScore 评分用的候选人对象（可能比 `c` 多带平台特有文本）。
   *   猎聘的全部信息量在 `liepinMeta.cardText/detailText` 里，评分前会被拼进 selfIntro 成为
   *   `cardForScore`；而评分引擎只读 `selfIntro`，对 liepinMeta 零引用。此前这里把**原始 c**
   *   递给 onCandidateSaved，猎聘拿它重算一遍写进人才池 —— 那份分丢掉了卡片全文，
   *   系统性偏低，且与日志/导出里的分对不上。TA 实际浏览的正是人才池，无法复核。
   *   2026-08-07 审查发现，故显式下传评分用对象。
   */
  private saveCandidateExport(
    c: CandidateProfile,
    score: ScoreResult | null,
    cardUrl?: string,
    profileForScore?: CandidateProfile,
  ) {
    if (!this.task) return;
    const db = getDb();
    const date = new Date().toISOString().slice(0, 10);
    const url = c.url || cardUrl || null;
    // M-21: 按唯一键 upsert 去重——异常重试重复浏览同一候选人时不产生重复导出行。
    // 唯一键优先用 url，其次 姓名|公司|职位 组合。
    const key = (url || `${c.name || ''}|${c.company || ''}|${c.position || ''}`).trim();
    const existingId = key ? this.exportedKeys.get(key) : undefined;
    if (existingId) {
      try {
        db.prepare('DELETE FROM candidates_export WHERE id = ?').run(existingId);
      } catch {}
    }
    const res = db
      .prepare(
        `INSERT INTO candidates_export (date, jd_id, platform, name, position, company, city, experience, degree, salary, score, url, greeted, favorited, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        date,
        this.jd?.id || null,
        this.getPlatform(),
        c.name || null,
        c.position || null,
        c.company || null,
        c.city || null,
        c.experienceYears ? `${c.experienceYears}年` : null,
        c.degree || null,
        c.salary || null,
        score?.total ?? null,
        url,
        this.candidateGreeted ? 1 : 0,
        this.candidateFavorited ? 1 : 0,
        // P2-6: "标记"——按匹配档写入 note（与"收藏"并列的独立标记维度，导出 CSV 可见）
        // 卡片层落四档判定文案（值得看/一般/不匹配/信息不足），详情层才落高/中/不匹配。
        // 详情层证据不足时 cardVerdictLabel 也为「信息不足」，优先展示它而非误导性的「中匹配」。
        // 人才库列表据此显示，不再显示卡片层那个没有区分度的数字分（2026-08-11）。
        score
          ? (score.cardVerdictLabel
            ? score.cardVerdictLabel as string
            : score.level === 'high' ? '高匹配' : score.level === 'medium' ? '中匹配' : '不匹配')
          : null,
      );
    if (key && res && typeof res.lastInsertRowid === 'number') {
      this.exportedKeys.set(key, res.lastInsertRowid); // 记录本次行 id，供后续重试 upsert
    }
    // 平台可另存一份自己的人才池（猎聘有一套长久保存 + 多岗位评分的独立表）。
    // 引擎只负责把"候选人 + 岗位库全量"递过去，存不存、怎么存由平台决定。
    try {
      this.getAdapter().onCandidateSaved?.(profileForScore || c, this.allJdsForScoring());
    } catch (e: any) {
      this.log('warn', `平台人才池写入失败（不影响本轮抓取）：${e?.message || e}`);
    }
    // ★ 2026-08-18 产量重构·修复5（跨轮持久去重 + 本轮新增计数）：
    //   adapter.onCandidateSaved 内持久去重后回写平台无关的 justStoredNew：
    //   true=人才库此前无此人(本轮净新增)；false=已收录(跳过，不计新增)。
    //   深翻 + 更新时间排序时已收录的人被跳过，产出的都是新人——这是 6000+/周
    //   目标的验收口径(不重复的人，非浏览次数)。seenCardIds 只是会话级，跨运行清空，
    //   持久去重必须查 DB（adapter 内已做）。引擎只读平台无关字段，不触 liepinMeta。
    const isNewTalent = !!(profileForScore || c).justStoredNew;
    if (isNewTalent) {
      this.newTalentsThisRun++;
      this.state.stats.newTalents = this.newTalentsThisRun;
    } else {
      this.skippedAlreadySeen++;
      // ★ 2026-08-19 P2-b：同步进 state.stats，供 launcher 收尾喂给 SkeletonMonitor 落 run-summary。
      this.state.stats.skippedAlreadySeen = this.skippedAlreadySeen;
      // 命中已收录的跳过累计，每 10 人播一次（避免刷屏），满足"日志能看到命中已收录跳过 M 人"。
      if (this.skippedAlreadySeen % 10 === 0) {
        this.log('info', `命中已收录跳过 ${this.skippedAlreadySeen} 人（本轮新增 ${this.newTalentsThisRun}）`);
      }
    }
  }

  /** 参与多岗位评分的 JD 集合。取岗位库全量；读不到就退回当前激活的那个。 */
  private allJdsForScoring(): JD[] {
    // 2026-08-07 P1-15: 缓存 JD 列表，每轮任务只读一次 DB（之前每存一个候选人就全表读一次）。
    // 缓存失效：在 jdCacheValid=false 时或 jdCache 为空时重新加载。
    // 调用方在 start() 中置 jdCacheValid=true，JD 变更 IPC 通过 ipc/jd.ts 置 false。
    if (!this.jdCacheValid || this.jdCache.length === 0) {
      try {
        const rows = getDb().prepare('SELECT id, name, data FROM jds').all() as Array<{ id: string; name: string; data: string }>;
        const out: JD[] = [];
        for (const r of rows) {
          try {
            const d = JSON.parse(r.data || '{}');
            out.push({ ...d, id: r.id, name: r.name } as JD);
          } catch { /* 单条坏数据跳过，不影响其余岗位 */ }
        }
        this.jdCache = out.length ? out : (this.jd ? [this.jd] : []);
      } catch { /* 读不到岗位库就退回单岗位 */ }
      this.jdCacheValid = true;
    }
    return this.jdCache.length > 0 ? this.jdCache : (this.jd ? [this.jd] : []);
  }

  private levelLabel(level: string): string {
    if (level === 'high') return '🟢 高度匹配';
    if (level === 'medium') return '🟡 中度匹配';
    if (level === 'mismatch') return '⛔ 岗位不符';
    return '🔴 不太匹配';
  }

  /**
   * 评分结论的展示文案。卡片层给三档 + 覆盖度，详情层给数字分。
   *
   * 2026-08-11：真机症状是 BOSS 一屏全 85 分毫无区分度。根因是卡片上只有
   * 职位名/公司/学历/年限/技能标签，权重最大的 taskCoverage(22) + domainFit(21)
   * 在这一层双双退出，剩下的都是人人拿高分的通用维，分数全顶到 CARD_MAX=85 ——
   * 实测「理想候选人」与「空卡片」同为 85。数字的精确感是假的，不该展示给 TA。
   * 三端（插件 / BOSS RPA / 猎聘 RPA）统一改成三档判定。
   */
  private scoreLabel(score: ScoreResult): string {
    if (score.mismatch) return '⛔ 岗位不符';
    // 卡片层给四档判定 + 覆盖度；detail 层证据不足时引擎也置 unknown（信息不足），
    // 不显示被托底的数字 60（那会被读成"通过"）。
    if (score.cardVerdictLabel) {
      const v = score.cardVerdict;
      if (v === 'unknown') return `⚪ 信息不足（可判维度太少，待人工核实）`;
      const icon = v === 'worth' ? '🟢' : v === 'nomatch' ? '🔴' : '🟡';
      return `${icon} ${score.cardVerdictLabel}（卡片信息覆盖 ${score.coverage}%）`;
    }
    return `${score.total} 分（${this.levelLabel(score.level)}）`;
  }

  // 清空日志：清运行时缓冲 + 真删库/分文件，广播空态（"清空"按钮持久生效）
  clearLogs() {
    this.state.logs = [];
    try {
      clearAllLogs(this.getPlatform()); // 必须带平台：否则在 BOSS 页点「清空日志」会连猎聘日志一起删
    } catch {
      /* 删库失败不阻断视图清空 */
    }
    this.emit('change', this.state);
  }

  private log(level: LogEntry['level'], message: string) {
    const time = logTime();
    const entry: LogEntry = { time: Date.now(), level, message: `[${time}] ${message}` };
    this.state.logs.push(entry);
    if (this.state.logs.length > 500) this.state.logs.shift();
    this.scheduleEmit();
    // P2-6: 入buffer，批量写入（降低SQLite写频率）
    this.logBuffer.push(entry);
    if (this.logBuffer.length >= RPAEngine.LOG_MAX_BATCH) this.flushLogs(true);
    else this.scheduleLogFlush();
  }
}

// ── 实例统一由 runtime-registry.ts 的 buildRuntime() 创建 ──
// 不再在此处维护模块级单例（export const rpaEngine 已删除）。
