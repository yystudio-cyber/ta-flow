// PlatformAdapter —— H9 架构修复：把平台特定逻辑从 RPA 引擎抽出，未来支持猎聘/脉脉时新增 Adapter 即可
//
// 修复历史：
//  - H9: 引擎所有平台相关操作通过 adapter 接口调用，rpa-engine.ts 不含平台硬编码
//  - 第二轮：tryFavorite/tryGreet/goNextPage 改走 HumanOperator 拟人点击（曲线移动+犹豫+down-up）
//  - 第五次审查 F-1/F-2：抓取面由"求职者(geek)找工作页"改为"招聘者搜候选人(牛人)页"，
//    全套 URL/选择器/码表收敛为单一 DEFAULT_BOSS 配置（单一来源），并支持 settings.browser.bossSelectors
//    以 JSON 覆盖——真实招聘者账号可在设置里粘贴校准后的真实选择器，无需改代码重新打包。
//    ⚠️ 默认选择器为"面向候选人"的推测，仍需在真实招聘者账号页面校准后方可端到端可用。
//  - 2026-08-04 拆分：BOSS 实现迁移到 adapters/boss.ts；本文件保留 PlatformAdapter 接口、
//    工厂函数、以及 evalWithTimeout / isFatalPageError / isWindowVisible 等跨平台通用工具。
//    所有历史上从本文件导出的符号，仍从本文件导出（BOSS 专属部分通过 re-export 转出），
//    现有调用方（rpa-engine.ts、scripts/*-lab.mjs）import 路径零变化。
//  - 2026-08-04 feat/liepin-v2：接口扩展以支持猎聘双平台——
//    SoftHealthSignal / SearchQuery / ApplySearchResult / 配额/阶段/搜索面/来源标注/合并详情/评分文本
import type { Page, ElementHandle, Frame } from 'puppeteer-core';
import type { CandidateProfile, SearchConfig, AppSettings, SpeedMode, DefenseSignalKind, QuotaStop, PlatformId, JD } from '../../shared/types';
import type { HumanOperator } from '../cdp/human-ops';
import type { RiskNetRules } from '../cdp/chrome';
import type { DailyLimits } from '../../shared/utils';

// BOSS adapter（导入即完成 adapters{} 注册）
import { bossAdapter } from './adapters/boss';
// 猎聘 adapter
import { liepinAdapter } from './adapters/liepin';

/** 会话/环境健康软信号（只降速，不硬停） */
export type SoftHealthSignal = 'cookieMutation' | 'skeletonStuck' | 'securityJsFail';

/**
 * 一次「搜索组合」。
 * BOSS 推荐流没有搜索参数 → buildQueries 返回单个空 query，applySearch 不实现，引擎照常跑。
 * 猎聘必须主动构造搜索 → buildQueries 展开 关键词 × 城市 × 行业 的笛卡尔积（产量的真正来源）。
 */
export interface SearchQuery {
  /** 展示用标签（日志/UI） */
  label: string;
  keyword?: string;
  city?: string;
  industry?: string;
  company?: string;
  experience?: string;
  degree?: string;
  /** 严格模式：筛选未生效即放弃本组合（宁可少搜，不可搜歪） */
  strict?: boolean;
}

/** applySearch 的结果。区分"工程失败"与"平台无结果"——后者不是风控信号。 */
export type ApplySearchResult =
  | 'ok'            // 搜索已提交且结果容器就绪、有卡片
  | 'no-result'     // 搜索成功但 0 条（正常业务结果，非风控）
  | 'filter-failed' // 筛选项未生效（工程问题，记 opResult=false）
  | 'not-ready'     // 页面没就绪/被遮罩挡住，可重试
  // ★ 2026-08-13：把「页面根本不是搜索页」从 not-ready 里拆出来。
  //   诊断信息指错方向比没有信息更费时间：VPN 开着时整页被弹到境外拦截页，
  //   引擎原来照样报「搜索框未就绪（疑似选择器失效）」，会把人引去重新校准选择器。
  | 'blocked-abroad-ip' // 整页被弹到境外 IP 拦截页（环境问题，关 VPN 即可，不是工程缺陷）
  | 'not-logged-in'     // 页面停在登录页（会话失效，需人工登录；猎聘单会话，别处登录会互踢）
  | 'failed';       // 其它失败

// 页面/会话已死的错误特征（与 rpa-engine.isFatalPageError 保持同一套正则）。
// 适配层必须能识别它——把这类错误吞成"读到 0 条"或"没有风控"，会让引擎做出完全相反的判断。
export function isFatalPageError(e: any): boolean {
  const msg = String(e?.message || e || '');
  return /Target closed|Session closed|Connection closed|browser has disconnected|Page crashed|detached Frame|frame was detached|Protocol error.*Target closed|Requesting main frame too early|WebSocket is not open/i.test(
    msg,
  );
}

// 带超时的 frame.evaluate。
// ⚠️ 必须有：frame 正在导航/被 BOSS 重建时，puppeteer 的 evaluate 会一直等下去而不报错——
// 真机第三次测试里"处理完 15 人后 11 分钟零日志"就是卡在这类调用上。超时后按失败处理，
// 让上层能记日志、能收敛，绝不把整个引擎挂死。
/**
 * 带上限的帧内求值。返回 null = 【这一次没读到】（超时 / 帧正在重建 / 上下文失效）。
 *
 * ⚠️ 致命错误必须【原样抛出】，绝不能吞成 null（2026-07-29 真机事故的根因）。
 * 旧实现是无差别 `catch { return null }`，把两件完全不同的事压成了同一个返回值：
 *   · "页面活着但这次读不到"  → 可以重试，调用方按"没读到"处理是对的；
 *   · "浏览器/页面已经死了"    → 再读一百次也是死的，必须走崩溃恢复流程。
 * 后者被吞掉的后果是实打实的：isRiskPage 里那句 `if (isFatalPageError(e)) throw e`
 * 永远等不到异常，成了死代码；于是"所有帧都读不到"的兜底策略把
 * 【浏览器断开】判成了【平台在对你施压】，用最高等级硬停 + 置需人工确认闩，
 * 而引擎为断连准备的专属提示("浏览器已断开，任务无法自恢复")一次都没机会执行。
 * 真机实测：浏览器一断，每次求值都是 0ms 立刻抛 "Attempted to use detached Frame"，
 * 而 isFatalPageError 本来就能匹配它——正确的路径写好了，只是被这里提前吞了。
 */
export async function evalWithTimeout<T>(
  frame: Frame,
  fn: (...args: any[]) => T,
  ms = 8000,
  ...args: any[]
): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      frame.evaluate(fn as any, ...args) as Promise<T>,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch (e) {
    if (isFatalPageError(e)) throw e;   // 页面已死：交给上层的崩溃恢复，别当成"没读到"
    return null;                        // 其它错误：这一次没读到，可重试
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 仅供测试导出 ────────────────────────────────────────────────────────────
// 「浏览器断开不得被判成平台风控」这条不变量此前零测试覆盖，正是它让 2026-07-29 那个
// 误报活到了真实招聘账号上。这两个薄封装让测试台能在不启动浏览器的前提下，
// 用假 Page/Frame 精确验证致命错误的传播路径。生产代码不引用它们。
export { evalWithTimeout__test, isRiskPage__test } from './adapters/boss';

// 浏览器窗口是否可见。
//
// ⚠️ 这是 CDP 输入事件能不能用的【前提条件】，代价极高的一课（真机 2026-07-28）：
// Chrome 窗口最小化时（实测 visibilityState='hidden'、screenX/Y=-21333、outerSize=159x27），
// Input.dispatchMouseEvent【永远不会回执】——单发一个 mouseMoved 等满 60s protocolTimeout 才抛错。
// 由此产生过两种表现：
//   · 修超时之前：一次 loadMore 卡死 745 秒（多个输入调用各等 180s 默认超时）；
//   · 修超时之后：真实滚轮跑满 10s 预算、一像素没动，全靠程序化兜底在滚。
// 所以窗口不可见时【别再发输入事件】，直接走程序化滚动，省下这 10 秒并给出明确提示。
// 注：page.evaluate 不受影响（最小化时照样能求值），只有 Input 域被挡。
export async function isWindowVisible(page: Page): Promise<boolean | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      page.evaluate(() => document.visibilityState !== 'hidden'),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), 3000); }),
    ]);
  } catch {
    return null; // 判定不了就按"可见"处理，不因为探测失败而降级
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PlatformAdapter {
  // ── 身份与环境 ────────────────────────────────────────────────
  id: PlatformId;
  name: string;
  /** 本平台域名判定：找回标签页、行为采样、信号归属校验都用它 */
  hostPattern: RegExp;
  /** 站内 Referer —— 程序化 goto 默认不带 Referer = "直接访问"，会自触发入口来源检测 */
  internalReferer: string;
  /** 默认调试端口 + profile 目录名（L1 浏览器隔离：两平台必须不同） */
  defaultCdpPort: number;
  profileDirName: string;
  /** 平台专属 Chrome 启动参数（如猎聘需 --disable-features=CalculateNativeWinOcclusion 解决遮挡问题） */
  launchArgs?: string[];
  /** 「打开浏览器」落地页 */
  loginStartUrl: string;
  /** 登录/验证页特征：这些页面上绝不 attach puppeteer */
  loginOrVerifyPattern: RegExp;
  /** 网络层风控监控规则（注入给本平台的 ChromeManager） */
  riskNet: RiskNetRules;
  /** 本平台"静默安全上报"命中时应产生的信号种类（BOSS: bossSecReport / 猎聘: liepinSecReport） */
  secReportSignalKind: DefenseSignalKind;
  /** 平台安全上报码 → 可读描述。引擎不持有码表，全部委托给 adapter。 */
  describeSecReport(code: number): string;

  // ── 配额与阶段（平台自己决定，引擎不认识任何平台专属设置项）────
  /**
   * 本平台本档位的每日配额。
   * 平台可在此叠加自己的二次压制（如猎聘按企业套餐额度的 50% 压制详情配额）。
   */
  resolveDailyLimits(mode: SpeedMode, settings: AppSettings): DailyLimits;
  /** 是否启用阶段B（详情级精筛）。不支持详情深链的平台恒 false。 */
  stageBEnabled(settings: AppSettings): boolean;

  /**
   * 列表卡片上是否存在【收藏】控件。
   *
   * 为什么需要这个声明而不是"试一下失败就算了"：引擎会把 tryFavorite 的结果喂给
   * riskMonitor.recordOpResult() 做失败率监控。若平台列表页压根没有收藏控件，
   * 每个候选人都会失败一次 → 操作失败率恒 100% → 风控熔断，跑着跑着自己停机，
   * 而日志上只会看到一堆"收藏按钮未找到"，根因很难联想到风控。
   *
   * 缺省 true（老适配器不声明＝按有收藏控件处理，行为不变）。
   * 声明 false 时引擎【整步跳过】收藏：不点击、不计失败、不计配额。
   *
   * 猎聘 = false：2026-08-06 三平台结构取证实测，/search 卡片上
   * `[class*=star|collect|fav]` 命中 0，卡片上只有「立即沟通」「超级聊聊」两个
   * 对外发消息的按钮（红线，绝不可点）。猎聘的"收藏"由我们自己的 liepin_talents
   * 表承担——那本来就是产品要的"长久保存人才链接、可随时打开"，不依赖平台侧收藏。
   */
  supportsListFavorite?: boolean;

  // ── 列表形态 ─────────────────────────────────────────────────
  /** true=下滑刷新的无限流（走 loadMore）；false=分页器（走 goNextPage） */
  infiniteScroll: boolean;
  /** 单个搜索组合最多翻几页（猎聘深翻 60 页上限，由干涸判据/平台尾页收敛；BOSS 推荐流无此概念 → Infinity） */
  maxPagesPerQuery(mode: SpeedMode): number;

  // ── 搜索面 ───────────────────────────────────────────────────
  buildSearchUrl(search: SearchConfig): string;
  /** 展开搜索组合。BOSS 返回单个空 query；猎聘展开笛卡尔积 */
  buildQueries(search: SearchConfig, mode: SpeedMode): SearchQuery[];
  /** 是否已停在工作面（在 → 附着不导航，风控最低） */
  isAttachedToWorkSurface(page: Page): boolean;
  /** 主动构造并提交搜索。BOSS 不实现（推荐流无搜索参数） */
  applySearch?(page: Page, op: HumanOperator, query: SearchQuery): Promise<ApplySearchResult>;

  // ── 风控检测（全部收进接口，引擎不得直接 import 具体实现）────────
  isRiskPage(page: Page): Promise<boolean>;
  classifyRiskKind(page: Page): Promise<DefenseSignalKind>;
  /** 温和降速提示（非硬阻断）：不该硬停，强制长休后继续 */
  isRateWarning(page: Page): Promise<boolean>;
  probeSessionHealth(page: Page): Promise<SoftHealthSignal[]>;
  /**
   * 配额/收敛类停机检测（★ 不是风控信号）。
   * 猎聘："今日查看简历已达上限"/"额度不足"/"猎聘币不足" → 优雅停机，绝不进熔断、不记 danger。
   * 原 Python 方案没有这个区分，配额耗尽会被误当限流 → 误熔断 + 误报隐形降权。
   */
  detectQuotaStop?(page: Page): Promise<QuotaStop | null>;

  // ── 抓取 ─────────────────────────────────────────────────────
  extractCards(page: Page): Promise<CandidateProfile[]>;
  /** 平台内稳定唯一键（BOSS encryptGeekId / 猎聘 resIdEncode），去重与落库 source_id 都用它 */
  cardKey(c: CandidateProfile): string;
  findCardElement(page: Page, card: CandidateProfile): Promise<ElementHandle | null>;
  extractDetail(page: Page): Promise<Partial<CandidateProfile>>;
  /** 由候选人直拼详情深链（猎聘可由 resIdEncode 拼出；BOSS 无永久 URL → null） */
  detailUrl?(c: CandidateProfile): string | null;
  /**
   * 在候选人上标注来源（关键词组合 / 页码等）。平台自己知道该写进哪个 meta 字段。
   * 引擎只负责在正确时机调用，不认识 bossMeta / liepinMeta 的存在。
   */
  annotateSource(c: CandidateProfile, query: SearchQuery, pageNo: number): void;
  /**
   * 合并列表卡片与详情结果。平台自己保证 meta 是【合并】而非覆盖
   *（详情只带全文，直接展开会冲掉列表阶段拿到的稳定锚）。
   */
  mergeDetail(card: CandidateProfile, detail: Partial<CandidateProfile>): CandidateProfile;
  /**
   * 供评分使用的补充全文（详情正文 / 卡片全文）。
   * 有些平台的主要信息不在结构化字段里，而在渲染后的整段文本中
   *（这也是绕开字体反爬最稳的做法）。返回 undefined 表示无补充文本。
   */
  scoreText?(c: CandidateProfile): string | undefined;

  // ── 动作 ─────────────────────────────────────────────────────
  tryFavorite(page: Page, op: HumanOperator, card?: ElementHandle<Element>): Promise<boolean>;
  tryGreet(page: Page, op: HumanOperator, message?: string): Promise<boolean>;
  /** 该平台该列表是否为"下滑刷新"的无限流（虚拟列表，无翻页器）。true 时引擎走去重+下滑加载循环。 */
  goNextPage(page: Page, op: HumanOperator): Promise<boolean>;

  // ★ 2026-08-19 页深持久化：续翻跳页用（仅分页平台实现，无限流平台留 undefined）。
  //   readCurrentPageNo：读 ant-lpt-pagination-item-active 文本=当前真实页码。
  //   resumeToPage：用分页器（••• 每次±5 / 直点页码精确落第N页）逼近到 targetN 页并校验落地。
  //     逐次点击：每次都是真实翻页请求，返回 {ok, landed, clicks, capped, reason}；引擎侧据 clicks
  //     计入频率/翻页配额并走 pace（与正常翻页同通道，不开绿色通道）。
  //     途中只操作分页器，不点卡片/沟通/详情。
  readCurrentPageNo?(page: Page): Promise<number>;
  resumeToPage?(
    page: Page, op: HumanOperator, targetN: number, maxClicks: number,
  ): Promise<{ ok: boolean; landed: number; clicks: number; capped: boolean; reason?: string }>;

  /**
   * 候选人已写入主库之后的平台侧扩展点。
   * 猎聘用它把人存进自己那套【长久保存 + 一人多岗多评分】的人才池
   * （BOSS 不实现 → 行为完全不变）。
   * @param jds 岗位库全量。猎聘是"广撒网捞人"，同一个人对不同岗位匹配度天差地别，
   *            只存一个分等于逼 TA 每换一个岗位就重跑一遍 RPA。
   */
  onCandidateSaved?(c: CandidateProfile, jds: JD[]): void;

  /**
   * 详情页【即将打开】时调用（不是打开成功后）。
   * 平台是"打开即扣费"，抽取失败也不退钱，所以记账必须发生在动作之前。
   */
  onDetailOpened?(c: CandidateProfile): void;
  // 无限流平台：向下滑动一段以触发懒加载更多卡片。返回是否"仍能继续前进"
  // （滚动位置前进 或 新卡片渲染出来）；false 表示疑似到底。引擎据此 + 去重结果判定是否浏览完。
  loadMore?(page: Page, op: HumanOperator): Promise<boolean>;

  // ── 元操作 ─────────────────────────────────────────────────────
  /** 真机只读探针（严格只读：不点击、不导航、不写库、不开详情）。返回探针报告 */
  selfTest?(page: Page): Promise<{
    ok: boolean;
    url: string;
    onWorkSurface: boolean;
    riskPage: boolean;
    riskKind?: DefenseSignalKind;
    rateWarning: boolean;
    quotaStop?: string;
    health: string[];
    selectors: Array<{ name: string; selector: string; count: number; critical: boolean }>;
    cards: { parsed: number; domCount: number; dedupCount?: number; withSourceId: number; withName: number; samples: any[] };
    verdict: string[];
  }>;
  /** 当前页面级别指标（卡片数/页码/滚动位等），日志与诊断用 */
  listMetrics?(page: Page): Promise<Record<string, number>>;
}

// BOSS 专属符号 re-export（保持历史 import 路径兼容，rpa-engine / lab 脚本零改动）
export {
  bossAdapter,
  isOnRecommendPage,
  isRateWarning,
  probeSessionHealth,
  resetHealthBaseline,
  classifyRiskKind,
  scrollMetrics,
  getLastLoadMoreDiag,
} from './adapters/boss';
export type { BossCfg } from './adapters/boss';

const adapters: Record<string, PlatformAdapter> = { boss: bossAdapter, liepin: liepinAdapter };

export function getPlatformAdapter(id: string): PlatformAdapter {
  return adapters[id] || bossAdapter;
}
