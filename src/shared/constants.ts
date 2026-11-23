// 默认配置常量
import type {
  AppSettings, ScoreWeights, RiskThresholds, SpeedMode, BehaviorProfile, SpeedConfig, Dist, PlatformId,
} from './types';

// v4 默认权重（13 维，合计 100）。
//
// ⚠️ 这四张表必须与 src/shared/scoring-universal.js 里的 WEIGHT_TEMPLATES 【逐键数值相等】。
// contract-check 第 9 节会真的比数值，改一边不改另一边直接红。
//
// 为什么以前是 8 维：引擎在 v4 升到 14 维时，这份常量没跟上。后果不是报错而是"看起来正常"——
// 引擎对缺失的键逐维回落到自己的模板值，于是用户在 UI 里看到的"合计 100%"是假的：
// 实际参与加权的是 8 个用户值 + 6 个引擎默认值，合计约 160，用户填的 30 实际只占 19%。
// 分数照出、排序还对，只是没人知道权重到底是多少——这比报错更难发现。
//
// P1-23：移除 researchOutput（科研产出）维。该维无任何写入点，恒 notApplicable 退出加权，
// 3% 权重从不参与——保留会让「14 维」口径失真。权重按各模板侧重点重新分配进主导维。
export const DEFAULT_WEIGHTS: ScoreWeights = {
  positionFit: 12,
  domainFit: 21,
  taskCoverage: 22,
  keywords: 16,
  experience: 9,
  degree: 5,
  industry: 3,
  companyTier: 3,
  projects: 4,
  salary: 3,
  location: 4,
  age: 2,
  stability: 3,
};

// 岗位类型权重模板
export type WeightTemplateId = 'default' | 'tech' | 'functional' | 'management';

export const WEIGHT_TEMPLATES: Record<WeightTemplateId, { label: string; weights: ScoreWeights; desc: string }> = {
  default: {
    label: '通用（默认）',
    desc: '均衡覆盖所有维度，适合大多数岗位',
    weights: DEFAULT_WEIGHTS,
  },
  tech: {
    label: '技术岗',
    desc: '强化硬技能与任务点覆盖，弱化薪资/城市',
    weights: {
      positionFit: 12, domainFit: 20, taskCoverage: 22, keywords: 19, experience: 8,
      degree: 4, industry: 3, companyTier: 2, projects: 5,
      salary: 2, location: 3, age: 2, stability: 3,
    },
  },
  functional: {
    label: '职能岗',
    desc: '强化岗位名与学历/行业',
    weights: {
      positionFit: 15, domainFit: 16, taskCoverage: 20, keywords: 12, experience: 10,
      degree: 7, industry: 5, companyTier: 5, projects: 4,
      salary: 4, location: 4, age: 2, stability: 2,
    },
  },
  management: {
    label: '管理岗',
    desc: '强化经验、行业与公司层级',
    weights: {
      positionFit: 12, domainFit: 16, taskCoverage: 18, keywords: 10, experience: 15,
      degree: 7, industry: 6, companyTier: 7, projects: 4,
      salary: 3, location: 3, age: 2, stability: 2,
    },
  },
};

/**
 * 权重维度的展示元数据（唯一真源）。
 * 岗位库编辑弹窗与设置页都从这里渲染，杜绝"UI 少列一维、用户永远调不到"。
 * group 用于分组展示：core = v4 主导维（合计 68%），context = 背景维。
 */
export const WEIGHT_FIELDS: { k: keyof ScoreWeights; label: string; group: 'core' | 'context'; hint?: string }[] = [
  { k: 'positionFit', label: '岗位名匹配', group: 'core' },
  { k: 'domainFit', label: '应用域匹配', group: 'core', hint: '需在「应用域」里配置，未配则该维退出加权' },
  { k: 'taskCoverage', label: '任务点覆盖', group: 'core', hint: '需在「任务点」里配置，未配则该维退出加权' },
  { k: 'keywords', label: '硬技能', group: 'core' },
  { k: 'experience', label: '工作年限', group: 'core' },
  { k: 'projects', label: '项目经验', group: 'core' },
  { k: 'degree', label: '学历', group: 'context' },
  { k: 'industry', label: '行业', group: 'context' },
  { k: 'companyTier', label: '公司层级', group: 'context' },
  { k: 'salary', label: '薪资', group: 'context' },
  { k: 'location', label: '位置', group: 'context' },
  { k: 'age', label: '年龄', group: 'context', hint: '仅在填了年龄区间时参与加权' },
  { k: 'stability', label: '履历稳定性', group: 'context', hint: '仅详情页深评可判' },
];

// 风险登记册 §5/R4 口径：保守用量、见风控即停。基线阈值远低于平台风控线，
// 保证预警在"接近危险"很早就介入。fast 档由 getRiskThresholdsForMode 放宽。
// 兜底基线（对应真人档，与 getRiskThresholdsForMode('human') 一致）。运行时由引擎按任务档位覆盖，
// 此常量仅作 riskMonitor 构造/启动前的初值。反风控参数一律系统固定，不接受用户设置覆盖。
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  greetYellow: 13,
  greetRed: 20,         // 招呼上限=15(优雅停)，红线20只留给失控
  browseYellow: 210,
  browseRed: 300,       // 浏览上限=240(优雅停)，红线300只在真异常/失控时触达
  freqOps: 40,
  loadFreqOps: 5,
  freqWindowSec: 300,
  nightStartHour: 22,
  nightEndHour: 7,
  autoPauseOnDanger: true,
  notifyOnNotice: true,
  cooldownHoursAfterDanger: 6,
};

// 归一化速度档：唯一 human 档。兼容 DB 里旧任务的 safe/fast/faster/mimic/slower（一律归 human）。
// ★ 2026-08-20 P2：净删 safe 档，只留 human（猎聘真实配额档）。旧 safe 模式任务经此自动归 human，无需迁移 DB。
export function normalizeSpeedMode(mode: any): SpeedMode {
  // 唯一档 human：safe/fast/faster/mimic/slower 及任意值一律归 human。
  // human 的所有反风控（每日上限/频率/见信号即退/90min硬顶/休息量级）一律保留不削弱。
  return 'human';
}

// 按【唯一 human 档】+ 平台返回【系统固定的】风险阈值——不接受用户覆盖（反风控参数不可人工调）。
// base 参数保留仅为签名兼容，内部忽略：阈值完全由档位决定，杜绝"人工把红线调高绕过风控"。
// platform 参数默认 'boss'，旧调用（两参签名）无需修改；liepin 阈值独立成表。
// ★ 2026-08-20 P2：删 safe 分支，只留 human 阈值——human 的黄/红线/夜间/频率窗口/冷却/自动暂停
//   全部原样保留，未削弱任何反风控断言/配额/阈值。
export function getRiskThresholdsForMode(mode: SpeedMode, _base?: RiskThresholds, platform: PlatformId = 'boss'): RiskThresholds {
  normalizeSpeedMode(mode); // 唯一 human，归一仅作一致性校验（旧 safe 入参也走 human 阈值）
  // 共同的非量类参数（夜间禁跑 / 频率窗口 / 冷却 / 自动暂停）——全部固定、自动生效
  const common = {
    freqWindowSec: 300,
    nightStartHour: 22,
    nightEndHour: 7,
    autoPauseOnDanger: true,   // 危险自动暂停：强制开，人工不可关
    notifyOnNotice: true,
    cooldownHoursAfterDanger: 6,
    // 下滑加载(loadMore)频率：这才是真正产生网络请求的动作（约每 15 人 1 次，稳态 1-2 次/5min）。
    // 阈值 5 = "明显快于正常翻屏节奏"，用于探测控制器失控/循环异常。
    loadFreqOps: 5,
  };
  // 口径：每日上限(getDefaultLimits) = 优雅停机线，落在 yellow 附近；red 高于上限，只在【真异常/失控】
  // 时触达（正常跑到上限=优雅停机，不弹高风险框、不打扰人）。招呼是外呼动作，human 严守。
  // freqOps 说明：它统计的是"浏览候选人次数"，而列表级浏览【零请求】——不能当请求频率用。
  //   控制器满速就是 human 32.5 次/5min，原阈值 10/8 会导致该指标正常运行时恒亮黄
  //   （信号恒真=零信息量）。现抬到高于控制器上限，退化为"控制器失控 / 有人手动狂点"的兜底探测器；
  //   真正的请求频率监控见 loadFreqOps。
  // ── 猎聘：必须独立成表，绝不能复用 BOSS 的量 ──
  // BOSS 的 browseRed 是 300，而猎聘 human 档配额是 1800 张/天。沿用 BOSS 阈值的话
  // 猎聘跑到第 300 张就会被判 danger 自动暂停，等于【永远跑不到自己的配额】，
  // 而且用户会看到一个莫名其妙的高风险告警。
  if (platform === 'liepin') {
    // 口径同 BOSS：停机线(getDefaultLimits) 落在 yellow 之上、red 之下；
    // red 只在真异常/控制器失控时触达，正常跑到上限是【优雅收工】不是风控事件。
    // freqOps（窗口内看卡次数）：猎聘看卡是零请求动作、节奏 2~3.2s，5 分钟窗口内
    //   稳态就有 40~50 次。BOSS 那套 24/40 会导致该指标正常运行时恒亮黄
    //   （信号恒真 = 零信息量），故抬到明显高于稳态，退化为失控兜底探测器。
    // loadFreqOps（窗口内翻页请求次数）：90 页 / ~3.5h ≈ 2.2 次/5min，阈值 5 有余量。
    // human（唯一档）：卡片≤1800(停)/黄1500/红2100；翻页≤90(停)
    return { ...common, greetYellow: 0, greetRed: 0, browseYellow: 1500, browseRed: 2100, freqOps: 90 };
  }

  // human（唯一档）：浏览≤240(停)/黄210/红300；招呼≤15(停)/黄13/红20
  return { ...common, greetYellow: 13, greetRed: 20, browseYellow: 210, browseRed: 300, freqOps: 40 };
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    autoLaunch: false,
    trayOnClose: true,
    theme: 'light',
    language: 'zh-CN',
    // D6(2026-08-05)：当前平台全局持久化，不再每次重启变回 BOSS
    activePlatform: 'boss' as 'boss' | 'liepin',
    // D6(2026-08-05)：首次启动引导是否已跳过
    onboardingDismissed: false,
  },
  browser: {
    mode: 'dedicated',
    cdpPort: 9222,
    extraArgs: '',
    // 猎聘独立浏览器配置（双平台 L1 隔离）
    liepinCdpPort: 9333,
    liepinUserDataDir: '',
    liepinSelectors: '',
  },
  rpa: {
    defaultSpeed: 'human', // 日常推荐"模拟真人"
    logRetentionDays: 30,
    enableScheduler: false,
    enableIdleStart: false,
    learnBehavior: false,
    enableAutoGreet: false,
    // 猎聘 RPA 配置
    // 企业套餐每日看简历份数。真实档位见《猎聘RPA风险调查》§964-966：
    // 基础版 ~10 / 专业版 ~30 / 旗舰版 ~100 份/天。
    // ⚠️ 默认取最保守的 10：原默认 0 表示"未配置→用档位默认值"，等于绕过 R1
    //    「日查看简历压在套餐额度 30~50% 以内」这条硬要求 —— 宁可配额小，
    //    也不能默认放到最宽。用户必须自己确认套餐后再往上调。
    liepinPackageTier: 10,
    liepinEnableStageB: false, // 阶段B（详情精筛）默认关
  },
  risk: DEFAULT_RISK_THRESHOLDS,
  matchScore: {
    highThreshold: 75,
    lowThreshold: 60,
    defaultWeights: DEFAULT_WEIGHTS,
  },
  data: {
    dataDir: '',
    // 合规默认（PIPL/网数条例 R2）：候选人 PII 字段级 AES 默认开启；safeStorage 不可用时优雅降级为明文并告警。
    encryptionEnabled: true,
  },
};

// S4: 拟人化行为 profile（单一来源）
// 由 [lo,hi] 区间构造正态分布，与旧 randNormalRange 的 mean=(lo+hi)/2, std=(hi-lo)/4 等价。
// 三档独立定义：safe→human→fast 逐级提速但全部保留真实人因参数（不过度优化到机器感）。
const R = (lo: number, hi: number): Dist => ({ mean: (lo + hi) / 2, std: (hi - lo) / 4 });
const D = (mean: number, std: number): Dist => ({ mean, std });

// 微观机制默认值（人体工程学固定值，三档共享基础，档位只调时间类）
const MICRO = {
  clickPressMs: R(60, 150),      // 鼠标按下到抬起（真实按压时长）
  prePauseMs: R(80, 200),        // 悬停→点击的准备停顿
  thinkPauseMs: R(200, 600),     // 小型思考停顿
  hesitationOffsetPx: D(30, 8),  // 犹豫移开位移
  hesitationHoldMs: R(250, 700), // 犹豫后停顿再回来
  curveJitterPx: 2.5,            // 贝塞尔末段收敛抖动(px)
  typeBurstChance: 0.25,         // 打字"爆发后停顿"概率（思考下一句）
  typeBurstMs: R(400, 1200),     // 打字思考停顿时长
  scrollBackMs: R(400, 900),     // 回滚后停顿
  // ==== 新增拟人维度（人体工程学固定值）====
  postClickStayMs: R(200, 500),       // 点击后停留（不立即移开）
  hoverMicromovePx: 1.2,              // 悬停微抖动幅度(px)
  overshootChance: 0.50,              // 鼠标过冲修正概率（人类~70%，安全档偏保守）
  overshootPx: R(2, 6),               // 过冲偏移(px)
  overshootCorrectMs: R(60, 140),     // 过冲修正耗时
  trackIntervalJitterMs: D(14, 5),    // 轨迹点采样间隔抖动(ms)，非固定16ms
  startReactionMs: R(120, 280),       // 决定移动→真正开始移动的反应时
  keyDwellMs: R(70, 140),             // 按键按下到释放(dwell time)
  keyFirstDelayMs: R(300, 800),       // 聚焦→首个 keydown 的反应时
  typeBackspaceRate: 0.025,           // 退格（打错）概率 2.5%
  typeCompositionMs: R(900, 2400),    // 中文输入法 composition 总时长
  typeComposeBeforeSubmitMs: R(600, 1800), // 输入完检查→提交
  scrollWheelTickMs: R(40, 120),      // 滚轮单 tick 之间间隔
  scrollAccelSteps: 3,                // 滚轮加速步数
  scrollDecelSteps: 4,                // 滚轮减速步数
  misclickChance: 0.01,               // 误点到相邻元素1%
  tabAwayChance: 0.02,                // 会话中切出窗口概率
  wheelVsScrollbarRatio: 0.85,        // 85%滚轮 / 15%其他
};

// 唯一档 BehaviorProfile（保守偏慢，符合风险登记册"小量、低频、白天"原则）
// ★ 2026-08-20 P2：净删 safe 档，只留 human。human 的拟人节奏(点击间隔/停留/扫卡/滚动/休息/过冲/
//   打错率/峰值速度)全部原样保留，未削弱任何反风控。
export const DEFAULT_BEHAVIOR: Record<SpeedMode, BehaviorProfile> = {
  human: {
    ...MICRO,
    clickIntervalMs: R(1200, 2800),
    pageStayMs: R(6000, 13000),
    cardScanMs: R(2000, 3500),       // 扫卡片2-3.5s（真人档更快；扫卡读已加载DOM零请求，提速不增频率）
    scrollDelayMs: R(700, 1700),
    scrollStep: R(200, 400),
    scrollBackChance: 0.14,
    typePerCharMs: R(100, 220),      // 约55-110 WPM
    hesitationChance: 0.13,
    hesitationOffsetPx: D(30, 7),
    curveSteps: R(13, 22),
    restEveryMs: R(10 * 60000, 15 * 60000),
    restDurationMs: R(30000, 55000),
    shortRestEveryOps: 10,
    shortRestMs: R(3000, 6000),
    secondLookChance: 0.10,         // ★ 2026-08-18：偶发(~10%)「多看两眼」，risk-controller 叠加 8-15s 拉长
    overshootChance: 0.55,
    typeBackspaceRate: 0.025,
    peakVelocityPxS: 1900,
  },
};

// 速度档元数据（按平台）。★ 2026-08-20 P2：删 safe，只留 human。
export interface SpeedMeta {
  label: string;
  labelShort: string;
  desc: string;
}
const SPEED_META_BY_PLATFORM: Record<PlatformId, Record<SpeedMode, SpeedMeta>> = {
  boss: {
    human: { label: '🧑 真人档', labelShort: '真人', desc: '平衡节奏（推荐）·日常/午休·总量最大化·日招呼≤15·浏览≤240（约66分钟）' },
  },
  // TODO(liepin): 按《猎聘RPA风险调查》档位一/档位二的三重配额口径补全文案
  liepin: {
    human: { label: '🧑 真人档（猎聘·待校准）', labelShort: '真人', desc: '猎聘真人档（待校准）' },
  },
};
export const SPEED_META: Record<PlatformId, Record<SpeedMode, SpeedMeta>> & Record<SpeedMode, SpeedMeta> = {
  ...SPEED_META_BY_PLATFORM,
  // 兼容旧签名：SPEED_META.human 等价于 SPEED_META.boss.human
  human: SPEED_META_BY_PLATFORM.boss.human,
};

// S4/S6: 解析任务实际使用的行为 profile。
// human（真人档，唯一档）是默认档，有足够学习样本时用学习到的分布整体覆盖。
export const MIN_LEARN_SAMPLES = 50; // 原20→50，拟合更稳健

// 缩放倍率：唯一 human 档为 1（无 safe 档缩放）。
const SPEED_MULT: Record<SpeedMode, number> = { human: 1 };
const TIME_DIMS: (keyof BehaviorProfile)[] = [
  'clickIntervalMs', 'pageStayMs', 'cardScanMs', 'scrollDelayMs', 'typePerCharMs', 'clickPressMs', 'prePauseMs',
  'thinkPauseMs', 'hesitationHoldMs', 'typeBurstMs', 'scrollBackMs', 'restEveryMs', 'restDurationMs',
  'postClickStayMs', 'overshootCorrectMs', 'trackIntervalJitterMs', 'startReactionMs',
  'keyDwellMs', 'keyFirstDelayMs', 'typeCompositionMs', 'typeComposeBeforeSubmitMs',
  'scrollWheelTickMs', 'shortRestMs',
];
export function resolveBehaviorProfile(speed: SpeedConfig): BehaviorProfile {
  const mode = normalizeSpeedMode(speed.mode);
  const preset: BehaviorProfile = { ...DEFAULT_BEHAVIOR[mode] };
  const hasLearned = !!(speed.learned && speed.learned.sampleCount >= MIN_LEARN_SAMPLES);
  // 无足够学习样本：直接用 human 档完整预设——时间维度 + 行为概率各自独立生效。
  if (!hasLearned) return preset;
  // 有学习样本："模拟真人"用学到的本人分布；
  // 2026-08-07 P1-4: 学习只能在预设附近微调，不能整体替换。
  // 反检测底线：学习后的节奏必须 clamp 在预设的 [0.5×, 2×] 区间内。
  // 否则若用户手动 sourcing 的点击间隔均值是 300ms，pageStayMs 会从 6-22s 降到 300ms，
  // 直接变成机器速度。这是安全底线，不是可调参数。
  const clampDist = (learned: Dist, pst: Dist): Dist => ({
    mean: Math.max(pst.mean * 0.5, Math.min(pst.mean * 2, learned.mean)),
    std:  Math.max(pst.std  * 0.5, Math.min(pst.std  * 2, learned.std)),
  });
  const humanPreset = DEFAULT_BEHAVIOR.human;
  const mult = SPEED_MULT[mode] || 1;
  const out: any = { ...preset };
  for (const k of TIME_DIMS) {
    const learnedDim = (speed.learned!.profile as any)[k] as Dist | undefined;
    if (!learnedDim) continue; // 未采集到该维度：保留 preset
    const presetDim = (humanPreset as any)[k] as Dist | undefined;
    if (!presetDim) continue;
    const clamped = clampDist(learnedDim, presetDim);
    out[k] = { mean: clamped.mean * mult, std: clamped.std * mult };
  }
  return out;
}

// 学历等级映射
export const DEGREE_RANK: Record<string, number> = {
  大专: 1,
  本科: 2,
  硕士: 3,
  博士: 4,
};

export const EXPERIENCE_RANGES: Record<string, [number, number]> = {
  '不限': [0, 50],
  '应届生': [0, 1],
  '1年以内': [0, 1],
  '1-3年': [1, 3],
  '3-5年': [3, 5],
  '5-10年': [5, 10],
  '10年以上': [10, 50],
};

// ── 平台微调常量（单一来源，不入 settings）────────────────────────────────────
// 猎聘单组合最大翻页数：受【干涸判据 + 平台尾页 + 页数上限】三重约束收敛，不再用页数硬限切产量
// ★ 2026-08-20 P2：唯一 human 档，删 safe 键。
export const PLATFORM_TUNING: Record<PlatformId, { maxPagesPerQuery: Record<SpeedMode, number> }> = {
  boss: {
    // BOSS 推荐流无翻页概念 → Infinity，引擎只按 scroll/reachEnd 判定
    maxPagesPerQuery: { human: Infinity },
  },
  liepin: {
    // ★★ 2026-08-18 产量重构（c-in-c 真机实测定案）：原值 2 建立在「猎聘 10 页硬限 /
    //    单查询只吃得到前 ~100 人」的错误前提上——据此把人群切成 144 个窄组合、
    //    每组合 ≤2 页就换。真机实测：分页器共 100 页、第 100 页正常加载 20 卡无封锁，
    //    单次广搜可翻 2000 人。前提错 → 每次广搜只挖了 5% 就走、又去跑高度重合的窄组合，
    //    产量被自己掐死。
    //    改为深翻：一个搜索组合持续翻页，直到 ① 到平台尾页(next disabled)、
    //    ② 连续多页内部去重后新人低于阈值（挖枯）、③ 累计到本上限。
    //    60 是「单组合独占一天」的保护阀（不是产量目标）：真机正常组合挖枯远早于 60 页，
    //    60 页 × 20 卡 = 1200 人，够单广搜吃满；日翻页预算 90 页(见 utils.getDefaultLimits)
    //    仍由 recordLoadMore / 每 5 页休 3-8 分钟 / 夜闸约束，深翻不放宽这些反风控闸。
    maxPagesPerQuery: { human: 60 },
  },
};
