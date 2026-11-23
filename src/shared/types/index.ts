// ==========================================================================
// 共享类型定义（主进程 / 渲染进程通用）
// ==========================================================================

/* ------------------------------ 工具系统 ------------------------------ */
export interface ToolManifest {
  id: string;
  name: string;
  icon: string;
  version: string;
  description: string;
  category: string;
  matches: string[]; // URL 匹配模式
  /** 工作页面入口。平台的「打开」按钮会在【调试 Chrome】里打开它——
   *  平台注入类工具只对已连接的那个浏览器生效，用系统默认浏览器打开工具不会出现。
   *  不填则不显示该按钮。 */
  workUrl?: string;
  entry: string; // 入口脚本（相对 tools/<id>/）
  configSchema?: ConfigField[];
  defaultConfig?: Record<string, any>;
  enabled?: boolean;
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'textarea' | 'select' | 'keywords';
  default?: any;
  options?: { label: string; value: any }[];
  placeholder?: string;
  description?: string;
}

export interface ToolState extends ToolManifest {
  enabled: boolean;
  config: Record<string, any>;
  trusted?: boolean;
  builtin?: boolean;
  permissions?: string[];
  updateAvailable?: boolean; // M-9: 检测到新版本时为 true
  installedVersion?: string; // M-9: DB 中记录的上次已安装版本
}

/* ------------------------------ RPA 系统 ------------------------------ */
export type RPAStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error' | 'terminated';
export type SpeedMode = 'human'; // 真人档（唯一档；风控参数系统固定，人工不可调）。旧 safe/fast/slower 经 normalizeSpeedMode 归 human。
export type TriggerMode = 'manual' | 'schedule' | 'idle';
export type PlatformId = 'boss' | 'liepin';
export const PLATFORMS: PlatformId[] = ['boss', 'liepin'];

export interface RPATask {
  id: string;
  name: string;
  platform: PlatformId;
  search: SearchConfig;
  actions: ActionConfig;
  speed: SpeedConfig;
  schedule: ScheduleConfig;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
}

export interface SearchConfig {
  keywords: string;
  city: string;
  experience: string; // e.g. "3-5年"
  degree: string;
  salary?: string;
  // 更多筛选（方案 4.1.5）
  jobType?: string;        // 职位类别
  companySize?: string;    // 公司规模
  industry?: string;       // 行业（BOSS用）
  financingStage?: string; // 融资阶段
  extraFilters?: Record<string, string>; // 其它扩展筛选
  // 猎聘专属：关键词组/城市列表/行业列表/目标公司/严格筛选模式
  keywordGroups?: string[];
  cities?: string[];
  /**
   * 经验档位列表（如 ["1-3年","3-5年","5-10年"]）。配置后可做二级细分补充。
   *
   * ★ 2026-08-18 产量重构（c-in-c 真机实测定案）：经验/学历【不再】作为笛卡尔积
   *   切分轴一上来就展开。原结论「猎聘按相关度排序、单查询只吃前 ~100 人、不同关键词
   *   前 100 名高度重合」已被真机推翻——分页器共 100 页、单次广搜可翻 2000 人。
   *   产量靠【深翻单个广搜组合】(maxPagesPerQuery=60) 吃满，不靠切 144 个窄组合。
   *   现默认仅取单值 experience/degree 作为 applySearch 的筛选项(pickOptionByText)；
   *   experienceBands/degrees 留作「单广搜已挖枯、仍需更多人」时的二级细分入口
   *   （buildQueries 当前未实现该二级细分，配置了也暂不参与展开）。
   */
  experienceBands?: string[];
  /** 学历档位列表（如 ["本科","硕士","博士/博士后"]）。同上，参与笛卡尔积展开。 */
  degrees?: string[];
  industries?: string[];
  targetCompanies?: string[];
  strictFilters?: boolean;
}

/** 配额停机原因（猎聘三重配额门控） */
export type QuotaStop =
  | 'dailyBrowse'    // 浏览量到顶（BOSS/猎聘通用）
  | 'dailyGreet'     // 招呼到顶（BOSS）
  | 'dailyPages'     // 翻页到顶（猎聘）
  | 'dailySearches'  // 搜索次数到顶（猎聘）
  | 'dailyDetails'   // 详情到顶（猎聘）
  | 'workWindow'     // 超出工作时段
  | 'runDuration';   // 单次运行时长

export interface ActionConfig {
  autoGreet: boolean;
  greetThreshold: number; // 匹配分阈值
  greetTemplate?: string; // 招呼话术文本
  greetTemplateId?: string;
  autoFavorite: boolean;
  favoriteThreshold: number;
  exportCsv: boolean;
}

export type PauseReason = 'manual' | 'idleAuto' | 'riskDanger' | 'riskPage' | 'windowHidden';

// 正态分布参数（毫秒 / 像素等），承载"学习到的"个人节奏
export interface Dist {
  mean: number;
  std: number;
}

// human-ops 消费的完整拟人化行为 profile —— 所有时序/概率维度集中于此，
// 便于"模仿本人"用学习到的分布整体替换（S4 收敛硬编码微时序的目标结构）。
// 新增维度全部设为可选（?），保证旧 profile/旧代码不报错；resolveBehaviorProfile 会兜底默认值。
export interface BehaviorProfile {
  clickIntervalMs: Dist;   // 操作间隔
  pageStayMs: Dist;        // 页面停留（开详情时）
  cardScanMs: Dist;        // 列表级：每张卡片扫读停留（不开详情时的人类阅读节奏）
  scrollDelayMs: Dist;     // 分段滚动间隔
  scrollStep: Dist;        // 每次滚动步长(px)
  typePerCharMs: Dist;     // 逐字打字间隔
  clickPressMs: Dist;      // 点击按压时长
  prePauseMs: Dist;        // 预点击停顿
  thinkPauseMs: Dist;      // 思考停顿(smallWait)
  hesitationChance: number;   // 犹豫概率 0-1
  hesitationOffsetPx: Dist;   // 犹豫位移(px)
  hesitationHoldMs: Dist;     // 犹豫悬停
  curveSteps: Dist;           // 鼠标贝塞尔步数
  curveJitterPx: number;      // 曲线扰动幅度(px)
  typeBurstChance: number;    // 打字爆发停顿概率
  typeBurstMs: Dist;          // 打字爆发停顿时长
  scrollBackChance: number;   // 回滚概率
  scrollBackMs: Dist;         // 回滚停留
  restEveryMs: Dist;          // 长休息间隔
  restDurationMs: Dist;       // 长休息时长

  // ==== 拟人化增强维度（可选，缺省由 resolveBehaviorProfile 补安全默认值）====
  postClickStayMs?: Dist;      // 点击后鼠标在元素上停留时间
  hoverMicromovePx?: number;   // 悬停期间生理性微抖动幅度(px)
  overshootChance?: number;    // 鼠标过冲修正概率 0-1
  overshootPx?: Dist;          // 过冲偏移量(px)
  overshootCorrectMs?: Dist;   // 过冲修正耗时
  trackIntervalJitterMs?: Dist;// 鼠标轨迹采样间隔抖动(ms)（非等间隔）
  startReactionMs?: Dist;      // 开始移动前反应时间
  peakVelocityPxS?: number;    // 鼠标移动峰值速度上限(px/s)，用于校验
  keyDwellMs?: Dist;           // 打字按下到释放时长(dwell time)
  keyFirstDelayMs?: Dist;      // 聚焦后到首个 keydown 的延迟
  typeBackspaceRate?: number;  // 打字退格（打错）概率 0-1
  typeCompositionMs?: Dist;    // 中文输入法 composition 总时长
  typeComposeBeforeSubmitMs?: Dist; // 输入完成到提交的检查时间
  scrollWheelTickMs?: Dist;    // 滚轮单 tick 之间的间隔
  scrollAccelSteps?: number;   // 滚轮加速段步数
  scrollDecelSteps?: number;   // 滚轮减速段步数
  shortRestEveryOps?: number;  // 每 N 次操作触发一次微休
  shortRestMs?: Dist;          // 微休时长
  misclickChance?: number;     // 误点到相邻元素概率（保守，默认 0）
  secondLookChance?: number;   // 高匹配返回后再看一次的概率（risk-controller 消费）
  tabAwayChance?: number;      // 切出窗口概率（blur）
  wheelVsScrollbarRatio?: number; // 滚轮 vs 拖动滚动条比例
}

// 学习到的个人节奏（"模仿本人"的真实数据来源，S6 采集+拟合产出）
export interface LearnedProfile {
  sampleCount: number;               // 采集样本量（不足则回退默认 human）
  updatedAt: number;
  profile: Partial<BehaviorProfile>; // 已拟合的维度（可部分，缺失维度回退默认）
}

export interface SpeedConfig {
  mode: SpeedMode;
  dailyGreetLimit: number;
  dailyBrowseLimit: number;
  dailyFavoriteLimit?: number; // 收藏每日上限（消除 RpaPage 的 as any）
  learned?: LearnedProfile;    // "模仿本人"学习到的分布（S6）
}

export interface ScheduleConfig {
  trigger: TriggerMode;
  runDurationMin: number; // 运行时长（分钟）
  cron?: string; // 定时启动
  idleStartMinutes?: number; // 空闲几分钟启动
  idlePauseOnInput?: boolean;
}

export interface RPAState {
  status: RPAStatus;
  taskId?: string;
  trigger?: TriggerMode;        // 本次运行由何触发（手动/定时/空闲）
  pauseReasons?: PauseReason[]; // 当前暂停来源集合（S1 状态机：集合空才恢复）
  startedAt?: number;
  currentPage?: string;
  elapsedMs: number;
  platform?: PlatformId;        // 双平台化：事件广播时标识来源平台；缺省视为 'boss'
  stats: {
    viewed: number;
    greeted: number;
    favorited: number;
    pagesBrowsed: number;
    /** ★ 2026-08-18：本轮新增(去重后)——跨轮持久去重后的净新增人数(验收周产量口径)。可选：旧状态无此字段。 */
    newTalents?: number;
    /** ★ 2026-08-19：本轮命中已收录跳过人数(配合 newTalents 看净增量/重复率)。可选：旧状态无此字段。 */
    skippedAlreadySeen?: number;
  };
  logs: LogEntry[];
}

export interface LogEntry {
  time: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

/* --------------------------- 匹配评分系统 --------------------------- */
/**
 * 应用域（v4 · domainFit 维，默认权重 20%）。
 *
 * 存在的理由：同样一堆技术词，「金融风控引擎」和「电商推荐引擎」是两个岗位的人。
 * v3 只看技术词面，把两者打成同一档；v4 用这份配置判断候选人的每段经历落在
 * 同域 / 相邻域 / 远域，这是人工 TA 给分差异的首要来源。
 *
 * 全部可选：不填则 domainFit 维整维 notApplicable 退出加权（不是给中性分），
 * 引擎退化为 v3 行为。填不填是 TA 的选择，不填不会报错，但也拿不到这 20% 的区分度。
 */
export interface JdDomain {
  /** 行业锚点，如「汽车智能驾驶」 */
  industry?: string;
  /** 载体/平台，如「服务端」「移动端」「客户端」 */
  platform?: string;
  /** 视角，如「用户侧」「企业侧」 */
  viewpoint?: string;
  /** 具体场景，如 ["在线交易", "核心链路"] */
  scenes?: string[];
  /** 传感器，如 ["环鱼眼相机", "超声波雷达"] */
  sensors?: string[];
  /** 相邻域（可迁移，打折计分），如 ["支付风控", "实时风控"] */
  adjacent?: string[];
  /** 远域（几乎不可迁移，重折扣），如 ["推荐排序", "广告投放"] */
  distant?: string[];
}

/**
 * JD 任务点（v4 · taskCoverage 维，默认权重 20%）。
 *
 * 把 JD 职责拆成可判定的任务点，逐条判断候选人有没有真做过：
 * direct（同域命中）> transfer（异域命中，按 domainSensitive 折扣）> none。
 */
export interface JdTask {
  /** 稳定标识（可选，仅用于调试归因） */
  key?: string;
  /** 任务点名称，如「支付风控规则引擎」 */
  label: string;
  /** 相对权重，默认 1；越核心的任务点给越高 */
  weight?: number;
  /**
   * 是否域敏感。true = 这个任务换个应用域就不算数（如「支付风控」），
   * 异域命中要显著折扣；false = 纯工程能力（如「嵌入式部署」），哪里做的都算。
   */
  domainSensitive?: boolean;
  /** 判定命中用的关键词 */
  keywords: string[];
}

export interface JD {
  id: string;
  name: string;
  title: string;
  active: boolean;
  basic: {
    experienceMin: number;
    experienceMax: number;
    degree: string;
    city: string;
    salaryMin?: number;
    salaryMax?: number;
    /**
     * 岗位职责文本（用于项目经验语义匹配）。
     * ⚠️ 引擎读的是【顶层】`jd.responsibilities`——scoreCandidate 归一化时会把这里的值
     * 提到顶层。曾经两边不一致，导致用户填的职责从未参与评分（静默死字段）。
     * 落库位置保持在 basic 下（历史数据都在这），归一化在 scoring-universal.js 里做。
     */
    responsibilities?: string[];
    /** 年龄要求区间。不填则年龄维度不参与评分——没有岗位依据就不该用年龄筛人 */
    ageMin?: number;
    ageMax?: number;
  };
  /** v4 应用域配置（domainFit 维，20% 权重）。不填 → 该维退出加权 */
  domain?: JdDomain | null;
  /** v4 任务点清单（taskCoverage 维，20% 权重）。不填 → 该维退出加权 */
  tasks?: JdTask[];
  /**
   * 引擎实际读取的岗位职责（由 scoreCandidate 从 basic.responsibilities 归一化而来）。
   * 用户不直接编辑这个字段，写在类型里是为了让"引擎契约"在类型上可见。
   */
  responsibilities?: string[];
  keywords: {
    required: string[];
    bonus: string[];
    negative: string[];
  };
  industry: {
    preferred: string[];
    excluded: string[];
  };
  companyTier?: {
    prefer?: string[];
    avoid?: string[];
  };
  weights?: ScoreWeights;
  weightTemplate?: 'default' | 'tech' | 'functional' | 'management';
  hardFlags?: {
    degree?: boolean;
    experience?: boolean;
    salary?: boolean;
    city?: boolean;
    /** 年龄超出 basic.ageMin/ageMax 是否直接判「岗位不符」。默认 false，只减分 */
    age?: boolean;
  };
  createdAt: number;
  updatedAt: number;
}

/**
 * 评分权重（v4 · 13 维）。P1-23 移除 researchOutput：该维无任何写入点，恒 notApplicable。
 *
 * ⚠️ 唯一真源是 `src/shared/scoring-universal.js` 里的 WEIGHT_TEMPLATES；
 * `src/shared/constants.ts` 的 DEFAULT_WEIGHTS / WEIGHT_TEMPLATES 必须与之逐键相等，
 * contract-check 第 9 节会做数值比对，漂移即红。
 *
 * 新增维度一律【可选】：老 JD 存的是 8 维权重，引擎按模板值逐维兜底（见 scoreCandidate），
 * 不需要数据迁移；设成必填会让所有历史数据编译不过。
 */
export interface ScoreWeights {
  experience: number;
  keywords: number;
  degree: number;
  industry: number;
  companyTier: number;
  /** 项目经验维度。可选：未给出时评分引擎按模板默认值计（见 scoring-universal.scoreCandidate）。 */
  projects?: number;
  salary: number;
  location: number;
  /** 年龄维度。仅在 JD 明确声明 ageMin/ageMax 时才参与加权，否则自动退出（见 scoreAge） */
  age?: number;
  /** v4：岗位名匹配度 */
  positionFit?: number;
  /** v4：应用域匹配（消费 jd.domain）。JD 未配 domain 时整维退出 */
  domainFit?: number;
  /** v4：JD 任务点覆盖（消费 jd.tasks）。JD 未配 tasks 时整维退出 */
  taskCoverage?: number;
  /** v4：履历稳定性（跳槽频率），仅 detail 层可判 */
  stability?: number;
}

export interface CandidateProfile {
  name?: string;
  position?: string;
  company?: string;
  companySize?: string;   // M-10: 公司规模（如 "1000-9999人"）
  companyStage?: string;  // M-10: 融资阶段（如 "上市公司"、"D轮及以上"）
  companyTag?: string;    // M-10: 公司标签（如 "国企"、"外企"、"500强"）
  companyBio?: string;    // M-10: 公司简介文本（用于关键词识别）
  experienceYears?: number;
  degree?: string;
  city?: string;
  salary?: string;
  skills?: string[];
  // 工作经历。BOSS 推荐卡片的 showWorks 里就带完整字段，不必点开详情页（见 platform-adapter 注释）
  workHistory?: {
    company: string; industry?: string; years?: number;
    position?: string;        // 职位名
    description?: string;     // 岗位职责（评分用，不落库）
    performance?: string;     // 工作业绩（评分用，不落库）
    emphasis?: string[];      // 平台抽取的技能标签（workEmphasisList）
    startDate?: string; endDate?: string;
    months?: number;          // 时长（月）
    current?: boolean;        // 是否在职
  }[];
  projects?: { name: string; desc?: string; tech?: string[] }[];      // 项目经历（渐进评分 S7）
  // 教育经历（结构化）。startDate/endDate 用来推算毕业年份与在读状态
  education?: { school?: string; degree?: string; major?: string; startDate?: string; endDate?: string }[];
  url?: string;
  note?: string;
  greeted?: boolean;
  favorited?: boolean;
  // 猎聘 RPA 字段
  sourceId?: string;        // 猎聘侧稳定唯一 ID（resIdEncode），用于去重
  depth?: 'A' | 'B';        // 抓取深度：A=列表级(零额度) B=详情级(已扣额度)
  liepinMeta?: {
    resId?: string;         // 简历 ID（URL 中 resIdEncode 参数值）
    compId?: string;
    jobId?: string;
    cardKey?: string;       // 列表卡指纹，用于搜索前后对比
    resIdEncode?: string;   // ★ 稳定唯一 ID（四级兜底提取链产出），去重/cross-run dedup/source_id
    detailUrl?: string;     // 由 resIdEncode 拼的详情深链
    cardText?: string;      // 卡片 innerText 全文（评分词表输入 + 自测抽样）
    detailText?: string;    // 详情页全文（阶段 B 产出，评分主输入；天然绕开字体反爬）
    sourceKeyword?: string; // 来源关键词（标注用）
    sourceCity?: string;    // 来源城市（标注用）
    sourceIndustry?: string;// 来源行业（标注用）
    pageNo?: number;        // 所在页码（标注用）
    isNew?: boolean;        // ★ 2026-08-18：本次入库是否为新增（跨轮持久去重产出），引擎据此计「本轮新增」
  };
  // ---- 真机校准新增（BOSS 推荐牛人）----
  selfIntro?: string;       // 自我描述（geekDesc.content）
  freshGraduate?: boolean;  // 应届生
  active?: string;          // 活跃状态描述（如"刚刚活跃"）
  matchWords?: string[];    // 平台侧关键词匹配高亮（markWords）
  // ---- 列表级深度提取新增（2026-07-28，全部来自卡片已渲染的 Vue 状态，零额外请求）----
  age?: number;             // 年龄（由 ageDesc "25岁" 解析）。仅在 JD 明确声明年龄区间时参与评分
  graduationYear?: number;  // 最高学历的毕业年份（由 education.endDate 推算）
  currentlyStudying?: boolean; // 在读（最高学历 endDate 晚于今天）
  platformHighlights?: string[]; // 平台高亮匹配项（hlmatches），BOSS 自己算的"哪里匹配"
  contacted?: boolean;      // 已沟通过/已是好友——用于避免重复打扰同一个人
  seen?: boolean;           // 本账号此前已看过
  // ★ 2026-08-18 产量重构·修复5：平台无关的"本轮净新增"信号。
  //   adapter.onCandidateSaved 持久去重时回写：true=人才库此前无此人(净新增)，
  //   false=已收录(跳过)。引擎读此计「本轮新增(去重后)」，不读任何平台专有字段。
  justStoredNew?: boolean;
  // BOSS 会话令牌快照：稳定锚 encryptGeekId + 用于会话重放/深链的令牌
  bossMeta?: {
    encryptGeekId?: string;
    geekId?: string;
    securityId?: string;
    lid?: string;
    expectId?: string;
    jobId?: string;
    encryptJobId?: string;
  };
}

export interface ScoreResult {
  total: number;
  level: 'high' | 'medium' | 'low' | 'mismatch';
  mismatch?: boolean;
  mismatchReasons?: MismatchReason[];
  /** 数据覆盖度 0-100：本次评分实际用上了多少权重。低 = 分数只基于片面信息 */
  coverage?: number;
  /** 覆盖度不足：不给 high 等级，也不做自动打招呼这类不可撤回的对外动作 */
  lowConfidence?: boolean;
  /** 因【候选人侧数据缺失】而退出加权的维度标签（JD 侧未声明的不计入） */
  missingDimensions?: string[];
  /** P1-19：true = 分数是「证据不足」的托底值，不是「确实匹配」的评分，使用方不应据此打标/排序 */
  insufficientEvidence?: boolean;
  /** 评分层级：card = 只有列表卡片字段的速评，detail = 拿到完整履历的深评 */
  tier?: 'card' | 'detail';
  /**
   * 卡片层四档判定（2026-08-11；'unknown' 于 2026-08-11 增补）。
   * 取值时机：
   *   · tier==='card'：恒非 null（四档之一）。
   *   · tier==='detail'：仅当 insufficientEvidence===true 时为 'unknown'（结果必须呈现为
   *     「判不了」而不是被 UI 读成"通过"的数字 60），否则为 null（用数字分）。
   * ★ 三端（BOSS 插件 / BOSS RPA / 猎聘 RPA）在本字段非 null 时一律显示它 + coverage，不显示 total。
   * 原因：卡片上只有职位名/公司/学历/年限/技能标签，权重最大的 taskCoverage + domainFit
   * 在这一层双双退出，剩下的都是人人拿高分的通用维 —— 真机实测一屏全 85 分，
   * 「理想候选人」与「空卡片」同分，数字的精确感是假的。
   * 「值得看」要求岗位专属的正向证据（命中加分词 / 同域 / 必选词强命中），
   * 不能只靠"没有负面证据"，否则空卡片会和理想候选人同档。
   * 'unknown'（信息不足）：判别性维度（keywords/positionFit/domainFit/taskCoverage）评过 <2 个，
   * 既撑不起「值得看」也撑不起「不匹配」。card 层时优先于其余三档。
   */
  cardVerdict?: 'worth' | 'fair' | 'nomatch' | 'unknown' | null;
  /** cardVerdict 的中文文案：值得看 / 一般 / 不匹配 / 信息不足 */
  cardVerdictLabel?: string | null;
  details: ScoreDetail[];
  highlights?: HighlightItem[];
  gaps?: GapItem[];
  skills?: SkillBreakdown;
}

export interface MismatchReason {
  field: string;
  label: string;
  detail: string;
}

export interface HighlightItem {
  label: string;
  note: string;
  score: number;
  dimension: string;
}

export interface GapItem {
  label: string;
  note: string;
  score: number;
  dimension: string;
  severity: 'hard' | 'soft';
}

export interface SkillBreakdown {
  exact: string[];
  semantic: string[];
  bonus: string[];
  negative: string[];
  missingCount: number;
}

export interface ScoreDetail {
  dimension: string;
  label: string;
  score: number;
  weight: number;
  status: 'match' | 'partial' | 'miss' | 'warn';
  note?: string;
  /** false = 这一维「判不了」，退出加权（分子分母都不计），而不是给中性分把所有人拉平 */
  available?: boolean;
  /** true = JD 侧压根没提这个要求（非数据缺失），连覆盖度分母都不计入 */
  notApplicable?: boolean;
}

/* --------------------------- 风险监控系统 --------------------------- */
export type RiskLevel = 'safe' | 'notice' | 'danger';

export interface RiskThresholds {
  greetYellow: number;
  greetRed: number;
  browseYellow: number;
  browseRed: number;
  freqOps: number;     // 窗口内浏览候选人次数（列表级零请求，仅作"控制器失控/人工狂点"兜底探测）
  loadFreqOps: number; // 窗口内下滑加载(loadMore)次数——这才是真正产生网络请求的动作
  freqWindowSec: number;
  nightStartHour: number;
  nightEndHour: number;
  autoPauseOnDanger: boolean;
  notifyOnNotice: boolean;
  cooldownHoursAfterDanger: number;
}

export interface RiskMetrics {
  greetCountToday: number;
  browseCountToday: number;
  favoriteCountToday: number;
  lastHourOps: number;
  lastWindowLoads: number; // 窗口内下滑加载(loadMore)次数——真实请求频率代理
  pageAnomaly: boolean;
  accountRestricted: boolean;
  nightActivity: boolean;
  // 新增：操作失败率监控（合法工程指标，用于尽早发现异常）
  recentOpFails: number;      // 最近20次操作失败次数
  recentOpTotal: number;      // 最近操作总数
  consecutiveEmptyPages: number; // 连续空结果页数（可能被限流）
  consecutiveGreetFails: number; // 连续招呼失败次数
  // 猎聘三重配额（当日累计 + 每日上限）
  pagesToday: number;
  searchesToday: number;
  detailsToday: number;
  pagesLimit: number;
  searchesLimit: number;
  detailsLimit: number;
}

// 精密防范模型：早停信号分级（依据 BOSS-RPA风险调查.md + 猎聘RPA风险调查.md）
export type DefenseSignalKind =
  | 'apiCode35'        // API 200 + code:35「IP地址存在异常行为」
  | 'verifyRedirect'   // 跳 /web/passport/zp/verify.html（会话信誉已丢）
  | 'captchaGeetest'   // 极验滑块/点选 DOM（BOSS）
  | 'captchaYidun'     // 网易易盾滑块/无感 DOM（BOSS）
  | 'captchaEscalate'  // 点选/图标/语音升级（风控升级）
  | 'captchaTencent'   // 腾讯防水墙（猎聘）
  | 'wafChallenge'     // 阿里云 WAF acw_sc__v2/v3 cookie 挑战（猎聘入口层）
  | 'liepinSecReport'  // 猎聘 security.min.js 36项自动化检测静默上报
  | 'accountBanned'    // 账号封禁/冻结/异地登录（猎聘 72h~永久，必须人工硬停）
  | 'interceptAbroadIp' // 猎聘 /secure/intercept-abroad-ip 境外 IP 拦截页（IP 级，非账号级）
  | 'requestTimeout'   // 猎聘列表请求长时间无响应
  | 'http403'          // 接口 403
  | 'http429'          // 接口 429（降速而非硬停）
  | 'bossSecReport'    // Boss 端 Security 模块 100xx 静默上报
  | 'emptyData'        // 连续空数据（降权/限流）
  | 'loginLost'        // 登录态丢失/被踢
  | 'rateWarn'         // 「操作速度过快」温和降速提示
  | 'cookieMutation'   // __a / isOHPC 指纹 Cookie 突变/消失
  | 'skeletonStuck'    // 骨架屏「加载中」停留过久（疑似挑战中）
  | 'securityJsFail'    // 安全/风控 JS 未加载 / window.Security 未定义
  | 'accountRestricted' // 页面文案显示账号被限制/冻结（需人工）
  | 'riskPageUnknown';  // 命中风控页但分不出具体类型（保守按需人工处理）

// 分级响应动作
export type DefenseAction = 'stop' | 'slow' | 'warn';

export interface DefenseCooldown {
  until: number;        // 冷却截止时间戳（0=无冷却）
  reason: string;       // 触发冷却的信号描述
  severity: RiskLevel;  // 该冷却对应的严重度
  kind?: DefenseSignalKind;
}

// 闭环控制器快照（只读监控用）
export interface RiskControllerSnapshot {
  rate: number;            // 当前允许速率（次/分钟，AIMD 自适应）
  rateMin: number;
  rateMax: number;
  suspicion: number;       // 0-100 前瞻可疑度
  circuit: 'closed' | 'open' | 'halfOpen';
  circuitReason?: string;
  consecutiveTrips: number;
  cooldownRemainingMs: number;
  sessionMinutes: number;
  health: { baselineHighRatio: number; todayHighRatio: number; sampled: number; shadowSuspected: boolean } | null;
}

// 风险指数（Composite Risk Index）——单一 0~100 数字 + 可解释的维度拆分。
// 算法见 src/main/services/risk-index.ts（维度与严重度全部对应 BOSS-RPA风险调查.md 的实测结论）。
export interface RiskIndexDimension {
  key: 'signals' | 'frequency' | 'volume' | 'session' | 'timing' | 'history';
  label: string;
  weight: number;       // 权重（合计 100）
  exposure: number;     // 该维度暴露度 0~100
  note: string;         // 一句话解释"为什么是这个分"
  contribution?: number; // 对总分的实际贡献（暴露度×权重/总权重）
}

export interface RiskIndexResult {
  index: number;                       // 0~100
  band: 'steady' | 'watch' | 'converge' | 'retreat';
  bandLabel: string;                   // 稳健 / 留意 / 收敛 / 撤退
  action: string;                      // 该档位对应的建议动作
  dimensions: RiskIndexDimension[];    // 按贡献降序
  topDrivers: string[];                // 主因（Top 3）
  computedAt: number;
}

export interface RiskState {
  level: RiskLevel;
  metrics: RiskMetrics;
  reasons: string[];
  suggestions: string[];
  lastDangerAt?: number;
  // 精密防范模型：当前冷却窗口（供 UI 展示与调度/空闲重启门控）
  cooldown?: DefenseCooldown;
  // 当前【系统固定】生效的风控阈值（按档位自动派生，只读展示用）
  thresholds?: RiskThresholds;
  // 闭环控制器快照（AIMD 速率 / 可疑度 / 熔断 / 健康基线）
  controller?: RiskControllerSnapshot;
  // 风险指数（复合指数，0~100 + 维度拆分 + 主因）
  riskIndex?: RiskIndexResult;
  // 双平台化：事件广播时标识来源平台；缺省视为 'boss'
  platform?: PlatformId;
}

/* --------------------------- 仪表盘数据 --------------------------- */
export interface DashboardStats {
  today: {
    viewed: number;
    greeted: number;
    favorited: number;
    highMatch: number;
    midMatch: number;
    lowMatch: number;
  };
  weekTrend: {
    date: string;
    viewed: number;
    greeted: number;
    riskScore: number;
  }[];
  risk: RiskState;
  activeJD?: JD;
  rpa: {
    isRunning: boolean;
    lastRunDuration?: number;
  };
}

/* --------------------------- 设置项 --------------------------- */
export interface AppSettings {
  general: {
    autoLaunch: boolean;
    trayOnClose: boolean;
    theme: 'light' | 'dark' | 'system'; // system=跟随系统
    language: 'zh-CN' | 'en';
    // D6(2026-08-05)：全局平台选择持久化
    activePlatform?: 'boss' | 'liepin';
    // D6(2026-08-05)：首次启动引导是否已关闭
    onboardingDismissed?: boolean;
  };
  browser: {
    mode: 'dedicated' | 'existing'; // 专用 / 连接现有
    chromePath?: string;
    cdpPort: number;
    userDataDir?: string;
    extraArgs?: string; // M-13: 额外启动参数（空格分隔，如 "--disable-gpu --proxy-server=..."）
    // F-1: BOSS 招聘者/候选人面选择器与 URL 覆盖（JSON 字符串）。默认值为"面向候选人"的推测，
    // 真实招聘者账号可在此粘贴校准后的真实选择器，无需改代码重新打包（键见 DEFAULT_BOSS）。
    bossSelectors?: string;
    // 猎聘专属浏览器设置
    liepinCdpPort?: number;       // 猎聘默认 9333（与 BOSS 9222 隔离）
    liepinUserDataDir?: string;   // 猎聘独立 profile
    liepinSelectors?: string;     // 猎聘选择器覆盖（JSON）
  };
  rpa: {
    defaultSpeed: SpeedMode;
    logRetentionDays: number;
    enableScheduler?: boolean;   // 允许任务按 cron 定时自动启动（S5）
    enableIdleStart?: boolean;   // 允许空闲自动启动（S5）
    learnBehavior?: boolean;     // 采集手动操作节奏用于"模仿本人"（S6）
    enableAutoGreet?: boolean;   // F-3: 自动打招呼总闸（方案 7.2"确认安全后加"，默认关，需显式开启）
    // 猎聘专项配置
    liepinPackageTier?: number;  // 企业套餐额度（每日份数），用于详情配额 = min(档位, 套餐*50%)
    liepinEnableStageB?: boolean; // 是否启用阶段 B（详情级精筛），默认 false（B4:猎聘硬禁用）
    deepScrape?: boolean;        // BOSS 深挖模式（保留旧字段，BOSS 用）；猎聘走 liepinEnableStageB
  };
  risk: RiskThresholds;
  matchScore: {
    highThreshold: number;
    lowThreshold: number;
    defaultWeights: ScoreWeights;
  };
  data: {
    dataDir: string;
    exportDir?: string;
    encryptionEnabled: boolean;
    candidateRetentionDays?: number; // 候选人 PII 保留天数（R2 到期删除，默认 90）
  };
}

/* --------------------------- IPC 通道名 --------------------------- */
export const IPC = {
  // App
  APP_GET_VERSION: 'app:get-version',
  APP_QUIT: 'app:quit',
  APP_OPEN_DEVTOOLS: 'app:open-devtools',
  APP_CHECK_UPDATE: 'app:check-update',
  // Behavior learning（模仿本人 S6）
  BEHAVIOR_STATUS: 'behavior:status',
  BEHAVIOR_APPLY: 'behavior:apply',
  BEHAVIOR_RESET: 'behavior:reset',
  // Tools —— 工具库收口(2026-08-20)：仅保留扩展清单 + 导出安装包两条 IPC。
  // 原 TOOLS_LIST/SET_ENABLED/GET_CONFIG/SAVE_CONFIG/RELOAD/INSTALL（平台注入工具）
  //   与 OPEN_EXTENSION_DIR/EXTENSION_INSTALL/EXTENSION_OPEN_SITE/OPEN_BOSS/OPEN_WORKPAGE/
  //   RECENT_SAMPLES/OPEN_DIAGNOSTICS_DIR（安装/打开/教程/行为采样）已随 handler 一并删除。
  // 浏览器扩展（不走平台注入，独立形态）
  DATA_ENCRYPTION_STATUS: 'data:encryption-status',
  DATA_RESET_ENCRYPTION_KEY: 'data:reset-encryption-key',
  TOOLS_EXTENSIONS: 'tools:extensions',
  // 导出扩展安装包 zip（给别的 TA / 换电脑用）
  TOOLS_EXTENSION_EXPORT: 'tools:extension-export',
  // 飞书需求汇总
  REQSHEET_RUN: 'reqsheet:run',
  REQSHEET_STATUS: 'reqsheet:status',
  REQSHEET_PENDING_COUNT: 'reqsheet:pending-count',
  // RPA
  RPA_GET_STATE: 'rpa:get-state',
  RPA_START: 'rpa:start',
  RPA_PAUSE: 'rpa:pause',
  RPA_RESUME: 'rpa:resume',
  RPA_STOP: 'rpa:stop',
  RPA_TASKS_LIST: 'rpa:tasks-list',
  RPA_TASK_SAVE: 'rpa:task-save',
  RPA_TASK_DELETE: 'rpa:task-delete',
  RPA_CLEAR_LOGS: 'rpa:clear-logs',
  RPA_EVENT: 'rpa:event',
  // JD
  JD_LIST: 'jd:list',
  JD_SAVE: 'jd:save',
  JD_DELETE: 'jd:delete',
  JD_SET_ACTIVE: 'jd:set-active',
  JD_GET_ACTIVE: 'jd:get-active',
  // Match
  MATCH_TEST: 'match:test',
  // Browser / CDP
  CDP_STATUS: 'cdp:status',
  CDP_LAUNCH: 'cdp:launch',
  CDP_CONNECT_EXISTING: 'cdp:connect-existing',
  CDP_SMART_CONNECT: 'cdp:smart-connect', // 连接已登录的浏览器（attach puppeteer）
  CDP_OPEN_FOR_LOGIN: 'cdp:open-for-login', // 只打开 BOSS 浏览器供登录，不连 puppeteer
  CDP_CLOSE: 'cdp:close',
  // Risk
  RISK_GET_STATE: 'risk:get-state',
  RISK_EVENT: 'risk:event',
  RISK_HISTORY: 'risk:history', // M-11: 获取近 N 天趋势 + 最近事件
  RISK_CLEAR: 'risk:clear', // 人工确认「我已处理」：解除异常闩 + 冷却 + 熔断，允许重新启动
  // Dashboard
  DASHBOARD_STATS: 'dashboard:stats',
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_RESET: 'settings:reset',
  // Data
  DATA_EXPORT_CSV: 'data:export-csv',
  DATA_CLEAR_ALL: 'data:clear-all',
  DATA_OPEN_FOLDER: 'data:open-folder',
  DATA_BACKUP: 'data:backup', // M-14: 一键备份
  DATA_RESTORE: 'data:restore', // M-14: 从备份恢复
  // 岗位库（G2）：飞书快照工具推送的 JR 收件箱
  JR_INBOX_LIST: 'jr-inbox:list',
  JR_INBOX_IMPORT: 'jr-inbox:import',
  JR_INBOX_DISMISS: 'jr-inbox:dismiss',
  JR_INBOX_EVENT: 'jr-inbox:new', // main → renderer 推送事件
  // 人才库（G3）
  CANDIDATES_LIST: 'candidates:list',
  CANDIDATES_MARK_VIEWED: 'candidates:mark-viewed',
  CANDIDATES_STATS: 'candidates:stats',
  OPEN_EXTERNAL: 'app:open-external', // 仅 http/https 白名单
  CANDIDATE_OPEN_BOSS: 'candidates:open-boss', // 会话重放：按 encryptGeekId 在推荐帧点开候选人
  // 双平台
  PLATFORM_LIST: 'platform:list',
  CANDIDATES_OPEN_SOURCE: 'candidates:open-source', // 打开候选人来源页（BOSS/Liepin）
  // ── 猎聘人才池子页（长久保存 + 一人多岗多评分 + 标签）──
  LIEPIN_TALENTS_LIST: 'liepin-talents:list',
  LIEPIN_TALENTS_STATS: 'liepin-talents:stats',
  LIEPIN_TALENTS_TAGS: 'liepin-talents:tags',
  LIEPIN_TALENT_SCORES: 'liepin-talents:scores',
  LIEPIN_TALENT_TAG_ADD: 'liepin-talents:tag-add',
  LIEPIN_TALENT_TAG_REMOVE: 'liepin-talents:tag-remove',
  LIEPIN_TALENT_ARCHIVE: 'liepin-talents:archive',
  LIEPIN_TALENT_DELETE: 'liepin-talents:delete',
  LIEPIN_TALENT_EXPIRING: 'liepin-talents:expiring',
  LIEPIN_TALENT_OPEN: 'liepin-talents:open',   // 打开简历详情（★ 消耗一份套餐额度）
  // ── 运行日志（全功能行为记录，只读诊断用）──
  OPLOG_RECENT: 'oplog:recent',
  OPLOG_SUMMARY: 'oplog:summary',
  OPLOG_EXPORT: 'oplog:export',
  OPLOG_OPEN_DIR: 'oplog:open-dir',
  OPLOG_UI: 'oplog:ui',            // 渲染层上报界面行为（页面切换/关键点击）
  OPLOG_HEALTH: 'oplog:health',    // 日志健康状态
} as const;

/* --------------------------- 岗位库 / 人才库（G2/G3） --------------------------- */
// 飞书快照工具推送过来的 JR 收件箱条目
export interface JrInboxItem {
  id: number;
  receivedAt: number;
  source: string; // 工具 id，如 feishu-jr-snapshot
  title: string;
  dept: string;
  city: string;
  status: string;
  raw: string;
  state: 'new' | 'imported' | 'dismissed';
}

// 人才库候选人行（candidates_export 投影）
export interface TalentCandidate {
  id: number;
  date: string;
  platform?: PlatformId;   // 平台分区（v3 迁移后必填）
  jdId: string | null;
  sourceId?: string | null; // 平台侧稳定唯一 ID (boss:encryptGeekId / liepin:resIdEncode)
  name: string | null;
  position: string | null;
  company: string | null;
  city: string | null;
  experience: string | null;
  degree: string | null;
  salary: string | null;
  score: number | null;
  url: string | null;
  greeted: boolean;
  favorited: boolean;
  viewed: boolean;
  note: string | null;
  depth?: 'A' | 'B' | null; // 抓取深度（B=已开详情扣了额度）
  detailAt?: number | null; // 猎聘阶段B：详情打开时间戳（跨运行去重）
}

// 探针脚本计数输出（recon/probe 共享）
export interface ProbeSelectorHit {
  name: string;
  selector: string;
  count: number;
  critical: boolean;
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
