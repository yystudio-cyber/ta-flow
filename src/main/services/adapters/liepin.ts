// 猎聘 Adapter —— lpt.liepin.com 招聘方端简历搜索
//
// 设计依据：
//  ① 《猎聘RPA风险调查.md》三轮实测（对手建模：阿里云 WAF acw_tc→acw_sc__v2/v3 + 自研
//     security.min.js 36 项自动化检测 + 极验/腾讯防水墙 + 数美业务层；Akamai/瑞数未被实证）；
//  ② 原 Python 方案（猎聘rpa/core/liepin_rpa_enhanced.py）已在真机跑通的选择器与
//     resIdEncode 四级兜底提取链 —— 那是真金白银的真机知识，原样继承；
//  ③ 《猎聘RPA设计方案》§4：两阶段（A 列表级广撒网 / B 详情级精筛）+ 三配额门控。
//
// 与 BOSS 的结构性差异（决定了接口为什么要扩展）：
//  · BOSS 是「推荐流·无限下滑·无搜索参数·零配额」；
//    猎聘是「主动搜索·ant 分页器(共100页可翻)·三重配额（翻页/搜索/详情）」。
//  · 猎聘必须 applySearch()（主动填条件并点搜索），BOSS 不需要。
//  · 猎聘不做 DOM 蜜罐（实测无 display:none 陷阱/trap 类名），检测火力集中在 JS 侧全局变量；
//    BOSS 相反（有 #lk-docker/.glue-toolbar/.beisenkeepcore DOM 检测）。故两平台探针各写各的。
//
// 合规边界（写进代码即留痕，见 §2.4）：
//  · 只在 HR 本人登录后的 lpt 招聘端读平台正常展示给该 HR 的页面；
//  · 不做 robots.txt Disallow 的匿名带参抓取（/*?* /hunter/* /user/ /image/randomcode/）；
//  · 不逆向签名走接口、不伪造指纹、不破验证码、不代理池/多账号；
//  · tryGreet 恒返回 false —— 猎聘侧不实现打招呼（R6 刑事+声誉双护栏）。
import type { Page, ElementHandle } from 'puppeteer-core';
import type {
  CandidateProfile, SearchConfig, AppSettings, SpeedMode, DefenseSignalKind, QuotaStop,
  JD, ScoreResult,
} from '../../../shared/types';
import type { HumanOperator } from '../../cdp/human-ops';
import { getSetting, upsertLiepinTalentIfNew, upsertLiepinScore, addLiepinTag, markLiepinDetailOpened } from '../../db';
import { scoreCandidate } from '../scoring';
import type { RiskNetRules } from '../../cdp/chrome';
import type {
  PlatformAdapter, SearchQuery, SoftHealthSignal, ApplySearchResult,
} from '../platform-adapter';
import { isFatalPageError } from '../platform-adapter';
import { mergeSelectorOverride, clearInputHumanly, countSelectors, maskName } from '../adapter-utils';

// 后台监控（2026-08-17 循环第1轮）：纯只读 DOM 骨架采样，零点击零网络。
// dumpSkeleton 在失败/关键点落盘骨架供离线分析；只观测，绝不改抓取控制流。
import { dumpSkeleton } from '../skeleton-monitor';

import { PLATFORM_TUNING, normalizeSpeedMode } from '../../../shared/constants';
import { getDefaultLimits, liepinDetailCap, type DailyLimits } from '../../../shared/utils';

// ---------- lpt 招聘端选择器（单一来源，可被 settings.browser.liepinSelectors 覆盖）----------
// ✔ 标记 = 原 Python 方案真机已跑通；⚠ 标记 = 待真机校准
export interface LiepinCfg {
  searchBase: string;
  /** 结果容器（判定"搜索已出结果"）✔ */
  listBox: string;
  /** 候选人卡片 ✔ */
  card: string;
  list: {
    name: string;      // ✔ 姓名
    detail: string;    // ✔ 摘要行（年限|学历|城市）
    work: string;      // ✔ 工作经历条目（首条=当前）
    edu: string;       // 教育条目（列表页不展示，详情页才用）
    tags: string;      // ✔ 技能/行业标签
    location: string;  // ✔ 城市
    age?: string;      // 年龄 span
    workYears?: string; // 工作年限 span
    eduLevel?: string; // 学历 span（值可能是 "--" 表示未填）
    workCompany?: string; // 首条工作-公司 span
    workPosition?: string; // 首条工作-职位 span（含 duration，需剥掉）
    workDuration?: string; // 首条工作-在职时长 span
    activeStatus?: string; // 活跃状态
    expectPosition?: string; // 期望职位（2026-08-06 结构取证新增）
  };
  detail: {
    /** ⚠ 详情页结构化字段待真机校准。主路径是读渲染后 innerText 交给评分词表
     *  （浏览器已完成 woff2 渲染 → 天然绕开字体反爬，这是原方案最正确的决策，予以保留）。 */
    root: string; name: string; title: string; company: string; city: string;
    exp: string; edu: string; salary: string; skills: string;
  };
  /** 详情深链模板（{id} 替换为 resIdEncode）✔ */
  detailUrlTpl: string;
  /** 分页器 ✔ */
  pagerNext: string;
  pagerCur: string;
  // ★ 2026-08-19 页深持久化：续翻跳页用的分页器子控件（c-in-c 真机实测，金丽丽态）。
  //   · pagerItem：页码项 li.ant-lpt-pagination-item，title=N，内含 <a>，可见时直点【精确落到第 N 页】。
  //   · pagerJumpNext / pagerJumpPrev：「•••」= ant-lpt-pagination-jump-next / -jump-prev，【每次 ±5 页】。
  //   可见可点范围：当前页 ±2、首页 1、末页 100、两个 •••。无快速跳页输入框。
  //   仅用于 jumpToResultPage 续翻定位（只操作分页器，不点卡片）；goNextPage 继续走 pagerNext，不动。
  pagerItem?: string;
  pagerJumpNext?: string;
  pagerJumpPrev?: string;
  /** 搜索按钮 ✔（+ xpath 文案兜底） */
  searchBtn: string;
  /** 职位关键词输入框 ✔ */
  kwInput: string;
  /** 公司定向输入框 ✔ */
  compInput: string;
  /** 已生效筛选 chip ✔ */
  filterChips: string;
  /** 引导浮层关闭按钮文案 ✔ */
  overlayLabels: string[];
  /** "请设置搜索条件进行搜索"——区分【筛选未生效】与【无候选人】的关键哨兵 ✔ */
  emptySentinel: string;
  /** 活跃度码表 ✔ */
  activeTerms: string[];
  /** 配额耗尽文案（★非风控，走优雅停机）*/
  quotaTexts: string[];
  /** 配额浮层容器选择器（优先在此范围内匹配 quotaTexts，防误匹配正文）*/
  quotaModalSelectors?: string[];
  /** 收藏 ⚠（首版零写不调用） */
  favorite: string[];
  // ── 结果排序（2026-08-18 产量重构·修复3）──────────────────────────────────
  // 真机实测：结果页有排序下拉「智能排序 / 活跃度排序 / 更新时间排序」，RPA 此前从未
  //   设过、一直默认智能排序。设「更新时间排序」把最新简历顶上来 = 更值得联系 + 跨轮
  //   跑时新更新的人持续顶上来 = 天然是新人（配合跨轮持久去重，产出都是新人）。
  /** 排序触发器文案（点它展开排序下拉；命中任一即可） */
  sortTriggerTexts: string[];
  /** 目标排序项文案映射：key=模式，value=候选文案（命中任一即点） */
  sortOptions: { updateTime: string[]; active: string[] };
  /** 排序区容器选择器（限定排序点击在此范围内，绝不命中候选人卡片的沟通按钮）⚠ */
  sortContainer: string;
  // ── ant-lpt-select 结构化选择器（2026-08-20 P1：c-in-c 真机实测定案）──────────
  // 真机：排序控件是 ant-design 的 ant-lpt-select，不是普通文本可点元素。
  //   触发器 = span.ant-lpt-select-selection-item（文本「智能排序」）
  //   可点祖先 = .ant-lpt-select-selector（点它开下拉）
  //   下拉浮层 = .ant-lpt-select-dropdown（portal 挂在 document 末尾，不在 select 容器内）
  //   选项条目 = .ant-lpt-select-item-option（文本「更新时间排序」/「活跃度排序」）
  // RPA 真机全页骨架(nodeCount 3007 未截断)却整条排序缺失 = 时序/负载：工具栏异步渲染晚于结果卡，
  // 旧的「全文档扫文本」在节点爆炸时定位慢且易被 portal 浮层吞。改用结构化选择器按 ant-select 协议操作。
  sortSelectSelector: string;
  sortSelectItem: string;
  sortDropdown: string;
  sortOptionItem: string;
}

export const DEFAULT_LIEPIN: LiepinCfg = {
  searchBase: 'https://lpt.liepin.com/search',
  // ✔ 2026-07-28 真机校准：结果容器 = resumeListBox（含 data-selector="mapping-search-result"）
  listBox: "div[class*='resumeListBox']",
  // ✔ 真机校准：外层 LI 自带 data-resumeidencode，class hash resumeCardWrap--，
  //   不要加内层 div（旧 selector 命中 LI+DIV 各 20，extractCards 里做嵌套去重才能正确工作）
  // 2026-08-13：补 data-tlg-elem-id 这个平台自留的【稳定锚】（来自旧版 selectors_liepin.yaml，
  //   2026-05 就在用）。它不带 CSS Module 哈希后缀，构建变更时比 class 更抗漂移，放兜底链首位之后。
  card: "li[data-resumeidencode], li[class*='resumeCardWrap'], div[data-tlg-elem-id='b_pc_search_res_listcard']",
  list: {
    // ✔ 姓名在 nest-resume-personal-name 内（注意其后跟名片简历 icon/businessCardIcon，取纯文本首段）
    name: "[class*='nest-resume-personal-name'], span.candidate-name, .candidate-name, .name",
    // ✔ 摘要行 = 年龄|年限|学历|城市（用 4 个 span 精确取，不再靠正则猜）
    detail: "[class*='nest-resume-personal-detail'], .candidate-detail, .baseInfo--_2KQY",
    // ✔ 真机校准：单条工作经历 = nest-resume-work-item（外层）；work-item-content 下文本是
    //   「公司+职位+时长」无分隔符，用子 span 精确拆
    work: "div[class*='nest-resume-work-item'], div.work-item-content",
    // ✔ 2026-08-06 结构取证修正：卡片上其实**有**学校，选择器是 edu-item-school，
    //   此前一直没采到（原选择器 edu-item-content / nest-resume-edu 都不命中学校名）。
    edu: '[class*="edu-item-school"], div.edu-item-content, [class*="nest-resume-edu"]',
    // 2026-07-28 真机校准：搜索列表卡片上【没有】候选人技能标签区（nest-resume-personal-skills
    //   是「当前行业」，不是个人技能；真正的技能在详情页）。list.tags 只在详情抽取链用，
    //   列表阶段返回空数组即可，不要把行业/按钮当 tags。
    tags: "span.tag, .tag, [class*='skill-tag'], [class*='resume-skills'] span",
    // ✔ 城市在 personal-detail-dq
    location: "span[class*='personal-detail-dq'], span.candidate-location, .location, .city",
    // —— 2026-07-28 新增：精确字段（不用正则猜）——
    age: "span[class*='personal-detail-age']",
    workYears: "span[class*='personal-detail-workyears']",
    eduLevel: "span[class*='personal-detail-edulevel']",
    workCompany: "span[class*='work-item-compname']",
    workPosition: "span[class*='work-item-extra']",
    workDuration: "span[class*='work-item-content-duration']",
    activeStatus: "span[class*='nest-resume-offline'], div[class*='nest-resume-status']",
    // ✔ 2026-08-06 结构取证新增：期望职位。此前完全没采——而它是判断"这个人想不想做
    //   这类岗位"最直接的信号，比从工作经历倒推准得多，评分的 positionFit 维直接受益。
    expectPosition: "[class*='personal-expect-content']",
  },
  detail: {
    root: "div[class*='resumeDetail'], div[class*='cvview'], #resumeDetail, body",
    name: "[class*='resume-name'], [class*='personal-name'], h1, h2",
    title: "[class*='expect-job'], [class*='resume-title']",
    company: "[class*='work-item'] [class*='company'], .work-item-content",
    city: "[class*='personal-detail'], [class*='resume-location']",
    exp: "[class*='work-year'], [class*='personal-detail']",
    edu: "[class*='edu-item'], [class*='education']",
    salary: "[class*='salary'], [class*='expect-salary']",
    skills: "[class*='skill'] span, .tag",
  },
  detailUrlTpl: 'https://lpt.liepin.com/cvview/showresumedetail?resIdEncode={id}&sfrom=R_SEARCH_CONDITION',
  pagerNext: "li.ant-lpt-pagination-next button, li.ant-lpt-pagination-next a, li.ant-pagination-next button, li.ant-pagination-next a, a[title='下一页'], .pager-next",
  pagerCur: 'li.ant-lpt-pagination-item-active, li.ant-pagination-item-active',
  // ★ 2026-08-19 页深持久化·续翻跳页子控件（c-in-c 真机实测）：
  //   页码项 title=N 内 <a> 直点精确落第 N 页；jump-next/-prev「•••」每次 ±5 页。
  //   ant-lpt- 与 ant- 两套都写（与 pagerNext/pagerCur 同口径，兼容 ant-lpt 与 ant 命名）。
  pagerItem: "li.ant-lpt-pagination-item[title], li.ant-pagination-item[title]",
  pagerJumpNext: "li.ant-lpt-pagination-jump-next, li.ant-pagination-jump-next",
  pagerJumpPrev: "li.ant-lpt-pagination-jump-prev, li.ant-pagination-jump-prev",
  // ⛔⛔ 2026-08-07 真机实测，这是整个适配器风险最高的一条选择器。
  //   原值 `button.ant-lpt-btn-primary.ant-lpt-teno-btn:not(.ant-lpt-btn-sm), button.ant-lpt-btn-primary:not(.ant-lpt-btn-sm)`
  //   在【空搜索页】只命中 2 个（所以此前两次探针都没暴露问题），
  //   但在【有结果的页面】命中 **42 个**，其中 40 个是「立即沟通」「超级聊聊」——
  //   给真实候选人发消息、不可撤回。page.$() 取文档顺序第一个，现在恰好是「搜索」，
  //   但只要 DOM 顺序有任何变化（多一个横幅、搜索栏进 portal、加载时序不同），
  //   点下去的就是「立即沟通」。这是那种"平时一直对、出事就是事故"的写法。
  //
  //   真实结构差异（实测祖先链）：
  //     搜索     → searchBarBox-- › searchBar-- › searchKeywords-- › searchInputBox-- › button
  //     立即沟通 → resumeCard--   › btnContainer-- › button（在候选人卡片里）
  //   故改为【容器限定】——结构上就不可能命中卡片内按钮；
  //   第二条是类名收紧兜底（`ant-lpt-teno-btn-secondary` 是沟通按钮独有，注意不是 `-seco`，
  //   之前按截断输出误判过一次）。★ 两条各自单独都安全，这是本条的必要性质：
  //   逗号选择器返回的是文档顺序，任何一条不安全都等于整条不安全。
  //   实测：两条各命中 1 个，都是「搜索」，零沟通按钮。
  searchBtn: "div[class*='searchBar'] button.ant-lpt-btn-primary:not(.ant-lpt-teno-btn-secondary):not(.ant-lpt-btn-background-ghost), button.ant-lpt-btn-primary.ant-lpt-teno-btn:not(.ant-lpt-btn-sm):not(.ant-lpt-teno-btn-secondary):not(.ant-lpt-btn-background-ghost)",
  // ⚠️ 2026-07-28 真机校准（这两条原来是错的，且错得很危险）：
  //   ① `input#rc_select_1` 失效 —— rc-select 的自增 id 会随页面组件数量漂移（真机实测已变成 rc_select_26），
  //      而且它可能命中【任意一个筛选下拉】；
  //   ② `input[placeholder='搜索职位']` 精确命中的是筛选区的「全部职位」下拉，**不是主搜索框**。
  //      主搜索框的 placeholder 是「搜职位/公司/行业等（中文用空格隔开…）」。
  //   若填错框，关键词会进筛选下拉 → 搜出完全无关的人，而且日志上看不出异常。
  //   现按【稳定特征】排序：placeholder 前缀 → class 前缀（哈希后缀会变，用 *= ）→ 容器兜底。
  //   ③ 原兜底 `div.job-input input.ant-lpt-input` 实测同样命中筛选下拉 —— 一并移除。
  //      这里刻意【不留宽泛兜底】：填错框的失败模式是"搜出完全无关的人、日志却一切正常"，
  //      是最难发现的一类错。选择器全失效时宁可 applySearch 直接返回 not-ready 报错停下，
  //      让人去「设置 → 猎聘选择器校准」贴新选择器，也不要静默搜错。
  kwInput: "input[placeholder^='搜职位'], input[class*='searchInput--']",
  // ⚠️ 2026-08-05 真机复验：原兜底 `div[class*='inputBox--'] input.ant-lpt-input` 同时命中
  //   【搜索职位】和【搜索公司】两个框，而 page.$() 取的是文档顺序第一个 —— 也就是【搜索职位】。
  //   实测 querySelectorAll 返回 ['搜索职位','搜索公司']，即配了目标公司时，公司名会被打进
  //   职位筛选框，搜出完全不相干的人、日志上却一切正常。这与 kwInput 上面那段注释警告的是
  //   同一类错误，当时修了 kwInput 却漏了 compInput。
  //   同 kwInput 的处置原则：宁可选择器失效时直接报错停下，也不要静默填错框。
  compInput: "input[placeholder='搜索公司']",
  // ⛔ 2026-08-07 真机实测：原值在有结果的搜索页上【命中 0】——猎聘的选中态类名是
  //   CSS Module 哈希形式 `active--XzZiZ`（LABEL 元素），`.active` 精确匹配根本对不上。
  //   后果：筛选是否真的生效【永远检测不到】，而这正是 applySearch 用来区分
  //   「筛选没生效」与「真的没有候选人」的唯一依据——检测不到就只能盲跑。
  //   实测：原选择器 0 命中，`[class*='active--']` 命中 2（当前两行「不限」）。
  //   哈希后缀会随构建变，必须用 *= 前缀匹配，不能写死 active--XzZiZ。
  // ⛔⛔ 2026-08-13 真机第二次修正：猎聘有【两套】选中态类名，且大小写不同——
  //   · 城市行（目前城市/期望城市）： active--<hash>        小写 a
  //   · 筛选项行（经验/学历/其他筛选）：searchPageFilterItemActive--<hash>  大写 A
  //   CSS 属性选择器 [class*='...'] 默认【大小写敏感】，只写小写版就匹配不到经验/学历，
  //   于是「点击其实成功了、校验却报没生效」→ 严格模式放弃组合 → 162 个切分组合
  //   全废在一个字母上。真机实测：点击前 label 带 searchPageFilterItemActive--XzE4O，
  //   点一下该类名消失（说明点击一直是生效的，只是我们看错了地方）。
  //   两种大小写都写上；哈希后缀会随构建变，必须前缀匹配。
  // ⛔⛔ 2026-08-13 第三次修正。真机逐行取证发现【同一个筛选栏上有三套命名规范】，
  //   而"某项是否已选中"必须三套都能认，少一套那一行就永远判"筛选未生效"：
  //     · 目前城市 / 期望城市 ：未选 = (空)                      选中 = active--<hash>
  //     · 经验                ：未选 = searchPageFilterItem--<hash>   选中 = + searchPageFilterItemActive--<hash>
  //     · 教育经历            ：未选 = search-page-filter-item        选中 = + search-page-filter-item-active
  //       （注意教育经历这套是【纯 kebab-case、不带哈希】，与另两套完全不同源）
  //   此前只覆盖了前两套 → 学历筛选恒判失败 → 每个含学历的组合都被放弃，
  //   而 162 个组合里【全部】都含学历，等于切分轴整体失效。
  //   CSS 属性选择器大小写敏感，三种写法必须都列出；哈希后缀会随构建变，一律前缀匹配。
  filterChips: "[class*='active--'], [class*='Active--'], [class*='filter-item-active'], .selected, .active, .filter-tag, .condition-item, .ant-lpt-tag, .ant-tag",
  // 2026-08-07 真机实测补：「AI 帮搜」是分步引导，按钮文案是「下一步」(1/3)，
  //   原表里一个都不匹配，浮层关不掉会挡住搜索按钮。
  //   ⚠️「确定」不能加进来——筛选区每个下拉里都有「确定」，误点会应用上一次的筛选条件。
  overlayLabels: ['我知道了', '知道了', '关闭', '稍后', '以后再说', '下一步', '跳过', '跳过引导', '不再提示'],
  emptySentinel: '请设置搜索条件进行搜索',
  // 2026-07-28 真机校准：lpt 实际文案是「30天内活跃」「今天活跃」（不是「今日活跃」）
  activeTerms: ['在线', '今天活跃', '3天内活跃', '7天内活跃', '14天内活跃', '30天内活跃', '近两周活跃', '一个月内活跃'],
  // 2026-08-07 P1-11: 改为完整提示句，防止泛化短词误匹配（如广告位里的「额度不足」）。
  // 同时把匹配限定在浮层/弹窗容器内，不扫整页 innerText。
  // 原来「额度不足」「权益已用完」「购买弹性包」过于泛化，可能出现在搜索结果正文或帮助链接里。
  quotaTexts: [
    '今日查看简历已达上限',
    '查看简历次数已用完',
    '今日查看次数已达上限',
    '剩余查看次数为0',
    '今日简历查看次数已用尽',
    '您的查看简历次数已用完',
  ],
  // 浮层/弹窗容器选择器（优先在此范围内匹配 quotaTexts，防止误匹配正文）
  quotaModalSelectors: [
    '.ant-modal-body', '.ant-modal-content',
    "[class*='modal']", "[class*='dialog']",
    "[class*='toast']", "[class*='tip']", "[class*='notice']",
    "[class*='alert']", "[class*='mask']",
  ],
  favorite: ["[class*='collect']", "[class*='favorite']", "[class*='star']"],
  // ⚠️ 排序触发器/选项文案无真机校准 = 零命中探针：applyResultSort 命中失败时 dump 骨架
  //   不静默（SORT_FAILED），真机一跑即暴露文案漂移。容器限定在搜索栏/工具条区域，
  //   结构上不可能命中候选人卡片的「立即沟通/超级聊聊」按钮（L1 安全）。
  sortTriggerTexts: ['智能排序', '默认排序', '综合排序'],
  sortOptions: {
    updateTime: ['更新时间排序', '按更新时间', '更新时间', '最近更新'],
    active: ['活跃度排序', '按活跃度', '活跃度', '活跃'],
  },
  // 排序区容器：结果页顶部搜索栏 / 结果工具条。与 searchBtn 同源容器，绝不在卡片内找。
  sortContainer: "div[class*='searchBar'], div[class*='toolBar'], div[class*='resultHeader'], div[class*='sortBox'], div[class*='filterBar']",
  // ant-lpt-select 结构化选择器（c-in-c 真机实证）。ant- 与 ant-lpt- 两套命名都写，抗构建漂移。
  sortSelectSelector: "div[class*='ant-lpt-select-selector'], div.ant-select-selector",
  sortSelectItem: "span.ant-lpt-select-selection-item, span.ant-select-selection-item",
  sortDropdown: "div.ant-lpt-select-dropdown:not(.ant-lpt-select-dropdown-hidden), div.ant-select-dropdown:not(.ant-select-dropdown-hidden)",
  sortOptionItem: "div.ant-lpt-select-item-option, div.ant-select-item-option, li.ant-lpt-select-item-option, li.ant-select-item-option",
};

function cfg(): LiepinCfg {
  const raw = getSetting<AppSettings>('app-settings', null as any)?.browser?.liepinSelectors;
  return mergeSelectorOverride(DEFAULT_LIEPIN, raw, ['list', 'detail']);
}

// ---------- 网络层风控规则 ----------
// 纠偏后的对手模型（风险报告 §2.9）：前门 = 阿里云 WAF（acw_tc → acw_sc__v2/v3），
// 不是 Akamai 也不是瑞数；签名头 X-Sign 等无猎聘实证，本项目本就不逆向签名，故不监控。
const LIEPIN_RISK_NET: RiskNetRules = {
  // lpt 招聘端 + api-c 企业端网关；统一路由规范 /api/com.liepin.{模块}.{action}
  apiUrl: /\/api\/com\.liepin\.|(^|\/\/)(api-c|apic)\.liepin\.com\//i,
  // 埋点/日志/统计/CSP 上报端点不做业务解析（statistic 走 secReport 通道）
  excludeUrl: /(log|statistic)\.liepin\.com|lpsoc-save-csp|standardFLog|tingyun|apmplus|googletagmanager|\.(js|css|png|jpg|jpeg|gif|webp|woff2?|svg|ico)(\?|$)/i,

  // ① 响应头：阿里云 WAF 挑战升级 —— 最早的入口层信号。
  // 正常态只下发 acw_tc（Max-Age=1800）；越阈才升级下发 acw_sc__v2（JS挑战）/ acw_sc__v3（行为滑块）。
  // 实测：低频单发的正常请求【不会】触发，故它出现即代表频率/行为已越线。
  classifyHeaders(headers) {
    const sc = String(headers['set-cookie'] || headers['Set-Cookie'] || '');
    if (/acw_sc__v3/.test(sc)) {
      return { code: 'acw_sc__v3', message: '阿里云 WAF 行为式滑块挑战已下发（acw_sc__v3）', kind: 'wafChallenge' as DefenseSignalKind };
    }
    if (/acw_sc__v2/.test(sc)) {
      return { code: 'acw_sc__v2', message: '阿里云 WAF JS 挑战已下发（acw_sc__v2）', kind: 'wafChallenge' as DefenseSignalKind };
    }
    return null;
  },

  // ② 响应体：猎聘业务成功标志是 flag===1（api-c 实测形态）或 code===0，两者都判。
  classifyBody(body: any) {
    if (!body || typeof body !== 'object') return null;
    const flag = (body as any).flag;
    const code = (body as any).code;
    const msg = String((body as any).msg || (body as any).message || '');
    const okFlag = flag === undefined || flag === 1 || flag === '1';
    const okCode = code === undefined || code === 0 || code === '0';
    if (okFlag && okCode) return null;
    if (!msg) return null; // 无文案的非 0 码可能是普通业务错误，不当风控
    if (/登录|重新登录|未登录|token失效|会话过期/i.test(msg)) {
      return { code: code ?? flag ?? '?', message: msg.slice(0, 200), kind: 'loginLost' as DefenseSignalKind };
    }
    if (/频繁|过快|稍后再试|请求过多/.test(msg)) {
      return { code: code ?? flag ?? '?', message: msg.slice(0, 200), kind: 'http429' as DefenseSignalKind };
    }
    if (/验证|校验码|人机/.test(msg)) {
      return { code: code ?? flag ?? '?', message: msg.slice(0, 200), kind: 'captchaGeetest' as DefenseSignalKind };
    }
    if (/异常|风控|拒绝|受限|限制|封禁|禁止访问/.test(msg)) {
      return { code: code ?? flag ?? '?', message: msg.slice(0, 200), kind: 'wafChallenge' as DefenseSignalKind };
    }
    return null;
  },

  // ③ security.min.js（v1.0.0，全局入口 window.__lp_cf）的检测结果上报端点。
  // 这是猎聘版的"比验证码更早的信号"（对应 BOSS 的 zpApm p2=100xx）。
  // 载荷格式未在真机核对过 → 用宽松关键词嗅探，命中任一自动化特征词即告警；
  // 载荷不可读时另发 security-report-unreadable，绝不静默失效。
  secReportUrl: /statistic\.liepin\.com\/statisticPlatform\/standardFLog/i,
  parseSecReport(probe: string) {
    // 36 项自动化全局变量（§2.7 实测全清单）的代表性特征词 + webdriver 四级检测标记
    const markers = [
      'webdriver', 'cdc_', '$cdc_', '__playwright', '_playwright_target_', '__pw_manual', '__PW_inspect',
      '__selenium', '_Selenium_IDE_Recorder', 'calledSelenium', 'callSelenium',
      '__fxdriver', '__driver_evaluate', '__driver_unwrapped',
      '__nightmare', '_phantom', 'callPhantom', 'domAutomation',
      '__lastWatir', 'headless', 'automation', 'devtools', 'tampered',
    ];
    const low = probe.toLowerCase();
    const hits = markers.filter((m) => low.includes(m.toLowerCase()));
    if (!hits.length) return null;
    return {
      code: hits.slice(0, 3).join(','),
      desc: `猎聘 security.min.js 上报疑似自动化特征：${hits.slice(0, 5).join('、')}`,
    };
  },
};

// ---------- 工具 ----------
const RES_ID_RE = /^[\w~=-]+$/;

/** 从详情 URL 反解 resIdEncode */
function ridFromUrl(url: string): string {
  if (!url) return '';
  const m = /[?&]resIdEncode=([^&#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

export function buildDetailUrl(id: string): string {
  return cfg().detailUrlTpl.replace('{id}', encodeURIComponent(id));
}

/** 关闭 lpt 的引导浮层（原方案 _dismiss_overlays 的等价实现） */
/**
 * 关闭引导浮层。
 *
 * 2026-08-07 真机实测补强：lpt 搜索页上有两类引导会挡住流程，而原实现【一个都关不掉】——
 *   ① 「AI 帮搜」分步引导：按钮文案是「下一步」(1/3)，不是「我知道了」；
 *   ② 「AI快读」引导卡 `aiReadGuideCard--<hash>`：根本没有文字按钮，只有一个
 *      `closeIcon--<hash>` 图标。
 * 原实现只按文案匹配 button，两类都漏，RPA 会被浮层挡住点不到搜索。
 *
 * ⚠️ 关闭图标必须【限定在引导容器内】找，绝不能全局点 `[class*='close']`：
 *    主搜索框的清空按钮就是 `antlpticon-close-circle`，误点会把刚输入的关键词清空，
 *    然后搜出全量结果——而日志上一切正常，是最难发现的一类错。
 */
async function dismissOverlays(page: Page, labels: string[]): Promise<void> {
  try {
    await page.evaluate((ls: string[]) => {
      // 引导容器特征：类名含 guide/tour/onboard/newbie/introjs（大小写不敏感）
      const GUIDE_RE = /guide|tour|onboard|newbie|introjs|driver/i;
      for (let round = 0; round < 4; round++) {
        let clicked = false;
        // ① 文案按钮（含分步引导的「下一步」「跳过」）
        const btns = Array.from(document.querySelectorAll('button, [role="button"], .ant-lpt-btn'));
        for (const b of btns) {
          const t = (b.textContent || '').trim();
          if (t && ls.includes(t)) {
            try { (b as HTMLElement).click(); clicked = true; } catch { /* ignore */ }
          }
        }
        // ② 引导容器内的关闭图标（只在引导容器内找，不全局扫）
        const guides = Array.from(document.querySelectorAll('div,section'))
          .filter((e) => GUIDE_RE.test(String((e as HTMLElement).className || '')));
        for (const g of guides) {
          if ((g as HTMLElement).offsetParent === null) continue; // 不可见的跳过
          const x = g.querySelector("[class*='closeIcon'], [class*='close-icon'], [aria-label='关闭']");
          if (x) {
            try { (x as HTMLElement).click(); clicked = true; } catch { /* ignore */ }
          }
        }
        if (!clicked) break;
      }
    }, labels);
  } catch { /* 浮层处理失败不阻断 */ }
}

export const liepinAdapter: PlatformAdapter = {
  id: 'liepin',
  name: '猎聘',
  hostPattern: /(^|\.)liepin\.com$/i,
  // 站内 Referer：程序化 goto 不带 Referer = "直接访问"。猎聘虽未实证入口来源检测，
  // 但 CSP report-uri + tlog 行为埋点都会记录，带上站内来源更自然、成本为零。
  internalReferer: 'https://lpt.liepin.com/',
  defaultCdpPort: 9333,                 // ★ 与 BOSS(9222) 必须不同 —— L1 隔离。选 9333 而非 9223：
                                        //   922x 段被各类调试/测试环境高频占用（真机实测撞过），远离它更省事
  profileDirName: 'chrome-profile-liepin', // ★ 独立 profile：cookie/localStorage/指纹完全不共享
  // C-2: 屏幕方案B —— Chrome 默认会跳过被遮挡窗口的绘制/输入，加此参数后
  //      即使窗口被其他应用盖住，CDP Input.dispatchMouseEvent/Input.dispatchKeyEvent 仍正常执行。
  //      猎聘必须（输入框打字 + 分页点选无法用程序化调用替代），BOSS 不需要。
  launchArgs: ['--disable-features=CalculateNativeWinOcclusion'],
  loginStartUrl: 'https://lpt.liepin.com/',
  // passport.liepin.com 已 404（登录整合进主站 SPA 浮层），故按路径特征判定
  loginOrVerifyPattern: /passport|\/login|signin|\/user\/|verify|captcha|callbackUrl=/i,
  riskNet: LIEPIN_RISK_NET,
  secReportSignalKind: 'liepinSecReport',
  describeSecReport(code: number): string {
    return `猎聘安全检测码 p2=${code}`;
  },

  /**
   * 猎聘配额：档位表 + 企业套餐 50% 二次压制（风险报告 R1 硬性要求）。
   * ★ 详情是真金白银的额度，且是猎聘风控敏感度最高的动作 —— 压制不可省。
   */
  resolveDailyLimits(mode: SpeedMode, settings: AppSettings): DailyLimits {
    const nm = normalizeSpeedMode(mode);
    const base = { ...getDefaultLimits(nm, 'liepin') };
    const tier = settings?.rpa?.liepinPackageTier;
    if (tier != null && tier > 0) {
      base.details = liepinDetailCap(nm, tier);
    }
    return base;
  },
  stageBEnabled(settings: AppSettings): boolean {
    return settings?.rpa?.liepinEnableStageB === true; // 默认关（T3：第一轮强制关闭阶段 B）
  },

  // 猎聘是 ant 分页器，不是无限流
  infiniteScroll: false,

  // ★ 2026-08-06 结构取证：/search 卡片上没有任何收藏控件，只有「立即沟通」「超级聊聊」
  //   两个对外发消息的按钮。声明 false 让引擎整步跳过收藏——否则每个候选人失败一次，
  //   操作失败率恒 100%，风控熔断会把整条线打停。
  //   猎聘的"收藏"由 liepin_talents 表承担（永久链接、随时可打开），不依赖平台侧收藏。
  supportsListFavorite: false,
  // 深翻上限见 constants.PLATFORM_TUNING.liepin（60 页，由干涸判据/平台尾页收敛）。
  maxPagesPerQuery(mode: SpeedMode): number {
    return PLATFORM_TUNING.liepin.maxPagesPerQuery[normalizeSpeedMode(mode)];
  },

  buildSearchUrl(): string {
    // 不带任何查询参数 —— 既符合 robots.txt「Disallow: /*?*」的精神，
    // 也因为 lpt 搜索条件是 SPA 交互式填入的（URL 带参不生效）。
    return cfg().searchBase;
  },

  /**
   * 展开搜索组合 —— 这是猎聘产量的真正来源。
   * 产量模型：keywords × cities × industries，每个广搜组合靠【深翻】吃到 1000-2000 人。
   * 两道闸：
   *   ① 组合总数受 dailySearches 配额约束（引擎侧按 searches 计数门控）；
   *   ② 单组合页数受 maxPagesPerQuery 约束（60，由干涸判据/平台尾页收敛，见 constants）。
   *
   * ★ 2026-08-18 产量重构：经验/学历不再做笛卡尔积【切分轴】。
   *   原「切分轴」依据是「猎聘按相关度排序、单查询只吃前 ~100 人」——该前提已被
   *   c-in-c 真机实测推翻（分页器共 100 页、可翻 2000 人）。前提不成立 → 切 144 个
   *   窄组合只为绕开一个不存在的前提，反而把每次广搜 2000 人的潜力掐成 100 人。
   *   现在经验/学历降回【单个筛选项】：仍带进每个 query 的 experience/degree 字段，
   *   applySearch 照常应用为筛选（pickOptionByText），但不参与组合切分——
   *   一个广搜组合深翻吃满，比 N 个窄组合各挖前 2 页多拿远更多新面孔。
   *   经验/学历等切分轴仅在【单广搜已挖枯、仍需更多人】时作为二级细分补充，
   *   不是一上来就切（当前未实现该二级细分，保留 search.experience/degree 单值即可）。
   */
  buildQueries(search: SearchConfig, mode: SpeedMode): SearchQuery[] {
    const kws = (search.keywordGroups || []).map((s) => String(s).trim()).filter(Boolean);
    // 未配置关键词组则回落到单个 keywords 字段（兼容简单用法）
    const keywords = kws.length ? kws : [String(search.keywords || '').trim()].filter(Boolean);
    if (!keywords.length) return [];
    const cities = (search.cities || []).map((s) => String(s).trim()).filter(Boolean);
    const industries = (search.industries || []).map((s) => String(s).trim()).filter(Boolean);
    const companies = (search.targetCompanies || []).map((s) => String(s).trim()).filter(Boolean);
    const strict = search.strictFilters !== undefined
      ? !!search.strictFilters
      // ★ 2026-08-20 P2：唯一 human 档，无 safe 档「默认严格」语义；未显式指定时按宽松(false)，
      //   与原 human 档行为一致。搜索严格性由 search.strictFilters 显式控制（makeDefaultTask 默认 true）。
      : false;

    const cityList = cities.length ? cities : [''];
    const indList = industries.length ? industries : [''];
    // 经验/学历：单值（带进 query 作为筛选项，不参与笛卡尔积切分，理由见上）。
    // 未配 experienceBands/degrees 时回落到单值 experience/degree，行为与老配置一致。
    const exp = (search.experience && search.experience !== '不限') ? search.experience : '';
    const deg = (search.degree && search.degree !== '不限') ? search.degree : '';
    const out: SearchQuery[] = [];
    for (const kw of keywords) {
      // 目标公司定向：关键词里若含目标公司名，把公司名摘出来填进"搜索公司"框，
      // 剩余部分作为职位关键词（原方案 _extract_company_term 的等价实现，实测很有效）。
      let keyword = kw;
      let company = '';
      for (const c of companies) {
        if (c && kw.toLowerCase().includes(c.toLowerCase())) {
          company = c;
          keyword = kw.replace(new RegExp(c, 'ig'), ' ').replace(/\s+/g, ' ').trim();
          break;
        }
      }
      if (!keyword) keyword = kw; // 摘完为空则退回原词，别搜出无意义的全量
      for (const city of cityList) {
        for (const ind of indList) {
          out.push({
            label: [keyword, company && `@${company}`, city, ind, exp, deg].filter(Boolean).join(' · '),
            keyword, company: company || undefined,
            city: city || undefined, industry: ind || undefined,
            experience: exp || undefined,
            degree: deg || undefined,
            strict,
          });
        }
      }
    }
    return out;
  },

  isAttachedToWorkSurface(page: Page): boolean {
    return /lpt\.liepin\.com\/search/i.test(page.url());
  },

  /**
   * 主动构造并提交搜索（BOSS 无此步骤，猎聘的核心差异）。
   *
   * ⛔⛔ 2026-08-18 修复1（真机 c-in-c 实测定案，从根上规避下拉吞点击）：
   *   流程从「输关键词→Escape→筛选→搜索」改为：
   *     ① 关浮层
   *     ② 先 resetFilterRows + 应用全部筛选（城市/行业/经验/学历）—— 在输入关键词【之前】，
   *        此时无联想下拉，筛选点击不会被吞。
   *     ③ 再填职位关键词 + 目标公司
   *     ④ 中性空白点击关掉联想下拉（Escape 兜底但不可依赖）
   *     ⑤ 点搜索（保留 4 秒无变化补点一次重试）
   *     ⑥ 等结果变化 + 权威哨兵：结果区已应用筛选标签校验筛选真生效
   *   根因：输入关键词后弹的联想下拉完全盖住经验/学历筛选行，Escape 对猎聘无效；
   *   原顺序下筛选第一击被下拉吞掉 → 经验静默停「不限」= FILTER_FAILED、翻页空转。
   */
  async applySearch(page: Page, op: HumanOperator, q: SearchQuery): Promise<ApplySearchResult> {
    const C = cfg();
    try {
      await dismissOverlays(page, C.overlayLabels);

      // ② ★ 2026-08-18 修复A（真机实测根因）：搜索出结果后筛选面板会【折叠】——
      //   经验/学历可点选项从 DOM 消失，出现 <a class="toTop--<hash>">「更改条件」</a>
      //   + selectedTag--<hash> 标签容器。折叠态下每个组合的 applySearch 都找不到筛选项 →
      //   pickOptionByText 全失败 → FILTER_FAILED_STRICT×7、searches=0。
      //   真机实测：空态 /search（bare，无 query）面板恒【展开】，经验/学历选项直出可点。
      //   故在应用筛选【之前】，先导航到 bare /search 强制回到展开态。
      //   风控可接受：站内跳搜索页是普通用户的常态动作；op.goto 带同域 Referer + 重试。
      try {
        // 同域 Referer：站内跳搜索页的常态动作，避免程序化 goto 判「直接访问」触发风控。
        // internalReferer 是适配器级常量（'https://lpt.liepin.com/'），与 searchBase 同域。
        await op.goto(C.searchBase, this.internalReferer);
        // 拟人等待：domcontentloaded 后让 security.min.js / 指纹 JS 自然跑完再操作
        await op.wait('page');
        await op.smallWait();
      } catch (navErr: any) {
        // 导航失败不立即放弃：可能是网络抖动，先继续走原流程，由后面断言/哨兵兜底报错。
        console.warn('[liepin] 导航到 bare /search 失败（继续原流程）:', navErr?.message || navErr);
      }
      // 导航关掉引导浮层后再断言面板展开（bare /search 也可能弹「AI 帮搜」引导）。
      await dismissOverlays(page, C.overlayLabels);

      // 断言筛选面板已展开：经验行容器可定位（折叠态下经验/学历选项从 DOM 消失）。
      //   仍不展开则采样骨架并按模式处置（严格模式宁少搜不搜歪）。
      const expanded = await isFilterPanelExpanded(page);
      if (!expanded) {
        console.warn('[liepin][diagnostic] FILTER_PANEL_NOT_EXPANDED: 导航后筛选面板仍折叠，已采样骨架');
        await dumpSkeleton(page, 'FILTER_PANEL_NOT_EXPANDED').catch(() => {});
        if (q.strict) {
          console.warn('[liepin] 严格模式：筛选面板未展开，放弃本组合（宁可少搜不搜歪）');
          return 'filter-failed';
        }
        console.warn('[liepin] 筛选面板未展开（宽松模式继续，筛选大概率失败）');
      }

      // ③ 先验证搜索框存在（环境判定）—— 此时还不输入，只判定页面是否就绪。
      //   ★ 搜索框存在性判定前移到筛选之前：若页面不是搜索页（VPN 拦截/未登录），
      //     根本不该去动筛选项。原顺序里这个判定在关键词输入处，现在关键词挪到后面，
      //     判定也跟着前置，避免在坏页面上白点一堆筛选。
      const kwElProbe = await page.$(C.kwInput).catch(() => null);
      if (!kwElProbe) {
        // ★ 2026-08-13：搜索框找不到时，先分清是【选择器失效】还是【页面根本不是搜索页】。
        //   实测场景：开着 VPN 时整页被弹到 /secure/intercept-abroad-ip，
        //   引擎照样报「搜索框未就绪（疑似选择器失效）」——会把人引去重新校准选择器，
        //   而真因是境外 IP 拦截。诊断信息指错方向比没有信息更费时间。
        const where = await page.evaluate(() => ({
          path: location.pathname,
          login: /请先登录|扫码登录|账号登录|手机号登录/.test(document.body?.innerText || ''),
        })).catch(() => ({ path: '', login: false }));
        if (/intercept-abroad-ip|\/secure\/intercept/i.test(where.path)) {
          console.warn('[liepin] 页面已被弹到境外 IP 拦截页 —— 不是选择器失效，请关闭 VPN 后重试');
          return 'blocked-abroad-ip';
        }
        if (/\/login/i.test(where.path) || where.login) {
          console.warn('[liepin] 页面停在登录页 —— 不是选择器失效，请在 9333 那个窗口重新登录');
          return 'not-logged-in';
        }
        return 'not-ready';
      }

      // ③ 筛选项：城市/行业/经验/学历。lpt 搜索页多数选项直出可见 → 先按文案直点，失败再走下拉。
      //    ★ 2026-08-18 修复1/修复3：resetFilterRows + 筛选【前移到关键词输入之前】——
      //      此时无联想下拉，reset 的清除点击与本组合的筛选点击都不会被下拉吞掉。
      //      学历多选累积问题随此顺序一并解决（reset 在筛选应用之前，清掉上一组合残留）。
      const filters: Array<[string, string | undefined]> = [
        ['city', q.city], ['industry', q.industry], ['experience', q.experience], ['degree', q.degree],
      ];
      // ⛔⛔ 2026-08-13 真机定位到切分轴一直失效的【最终真因】：
      //   猎聘的【教育经历是多选】——点「硕士」不会替换「本科」，而是【累加】。
      //   实测跑到组合 4 时页面状态：学历已选 = [本科, 硕士, 博士/博士后] 三个全在，
      //   于是组合 2 = 本科∪硕士（组合 1 的超集）、组合 3 = 再并上博士，
      //   前 20 名永远是同一批人 → 连续 0 新人。
      //   （经验行是单选，切换正常——这正好解释了此前只有"经验变了"的组合才出新人。）
      //   处置：应用本组合的筛选【之前】，先把上一组合残留的选择清掉。
      await resetFilterRows(page, op);

      for (const [name, value] of filters) {
        if (!value) continue;
        const picked = await pickOptionByText(page, op, value);
        if (!picked) {
          // ★ 2026-08-11 真机 + 用户口径：城市【永不】因筛选失败而放弃组合。
          //   两条依据：
          //   ① 结构事实——「目前城市」只有『不限|其他』，「期望城市」只多两三个近用城市，
          //      武汉/上海这类任意城市必须点开「其他」面板才选得到，行内点不到是常态而非异常。
          //      原来把它当致命错误，导致 12 个搜索组合全部被放弃、一个人都搜不到。
          //   ② 口径——我们真正要匹配的是候选人的【期望城市】，而它已经逐卡抽取
          //      （personal-expect-content 第 1 段）并写进 profile.city，
          //      由评分的 location 维在本地判定。平台侧筛不筛得上都不影响结果正确性，
          //      只影响翻页效率（没筛上就要多翻几页才凑够目标城市的人）。
          //   其余筛选项（行业/经验/学历）维持原严格语义不变。
          if (name === 'city') {
            // ★ 2026-08-17 修复2：城市行内点不到是常态（武汉/上海藏在「其他」弹层里），
            //   先主动走弹层路径：点「其他」展开 → 弹层内按文本匹配点目标城市。
            //   弹层路径也失败才回退到「期望城市在本地评分时判定」（口径依据见下）。零命中会
            //   由 pickCityFromOverlay 记 CITY_OVERLAY_NO_MATCH / NOT_OPENED 诊断码，绝不静默。
            const overlayPicked = await pickCityFromOverlay(page, op, value);
            if (!overlayPicked) {
              console.warn(`[liepin] 城市筛选仍未点上（${value}）——不放弃组合，改由期望城市在本地评分时判定`);
            }
          } else if (q.strict) {
            console.warn(`[liepin] 严格模式：筛选未生效 ${name}=${value}，放弃本组合`);
            // ★ 监控：严格模式筛选未生效（行业/经验/学历）—— 采样供离线定位是哪一项没点上。
            //   只观测：不改返回值，下面照常 return 'filter-failed'。
            console.warn('[liepin][diagnostic] FILTER_FAILED_STRICT: 严格模式筛选未生效，已采样骨架');
            await dumpSkeleton(page, 'FILTER_FAILED_STRICT').catch(() => {});
            return 'filter-failed';
          } else {
            console.warn(`[liepin] 筛选未生效（宽松模式继续）：${name}=${value}`);
            // ★ 监控：宽松模式筛选未生效 —— 采样但不阻断（宽松模式继续往下跑）。
            console.warn('[liepin][diagnostic] FILTER_FAILED_LENIENT: 宽松模式筛选未生效，已采样骨架');
            await dumpSkeleton(page, 'FILTER_FAILED_LENIENT').catch(() => {});
          }
        }
        await op.smallWait();
      }

      // ④ 填职位关键词 + 目标公司（移到筛选之后）。
      // ★ 2026-08-18 修复1：先把筛选点完（无下拉），再输入关键词。输入后弹的联想下拉
      //   不再能盖住已应用好的筛选项；下拉由下面的中性点击关闭，不会吞掉搜索点击。
      const kwEl = await page.$(C.kwInput).catch(() => null);
      if (!kwEl) {
        // 筛选阶段后搜索框消失（极少见：页面重渲染/风控重定向）。前面已判过环境，这里不重复。
        return 'not-ready';
      }
      await op.clickElement(kwEl).catch(() => {});
      await op.wait('click');
      await clearInputHumanly(page, kwEl);
      if (!(await op.typeChatMessage(kwEl, q.keyword || '').catch(() => false))) {
        // typeChatMessage 失败时退回 type（clearFirst），仍是拟人逐字
        await op.type(C.kwInput, q.keyword || '', true).catch(() => {});
      }
      await op.wait('type');

      // 目标公司定向（可选）。★ 关键：上一组合若填过公司、本组合没有，
      //   必须把公司框【清空】，否则会带着上一个公司的定向条件继续搜（搜出来的人全是错的）。
      {
        const compEl = await page.$(C.compInput).catch(() => null);
        if (compEl && !q.company) {
          await op.clickElement(compEl).catch(() => {});
          await clearInputHumanly(page, compEl);
        }
      }
      if (q.company) {
        const compEl = await page.$(C.compInput).catch(() => null);
        if (compEl) {
          await op.clickElement(compEl).catch(() => {});
          await op.wait('click');
          await clearInputHumanly(page, compEl);
          await op.typeChatMessage(compEl, q.company).catch(() => {});
          await op.wait('type');
        } else if (q.strict) {
          console.warn('[liepin] 严格模式：未找到公司输入框，放弃本组合');
          return 'filter-failed';
        }
      }

      // ⑤ 关掉联想下拉：输入关键词后弹的联想词下拉会【吃掉搜索点击】。
      //    ★ 2026-08-18 修复1：点中性空白区关下拉（Escape 对猎聘无效）。
      //    中性点击走拟人 op.clickElement；详见 dismissSuggestDropdown。
      await dismissSuggestDropdown(page, op, C);

      // ⑥ 搜索前指纹：抓当前首卡 key + 卡片数，用于判断搜索是否真的生效了
      //    ★ 2026-08-18 修复4：卡片计数改用去重后的 countCards，不再 40/20 虚高。
      const beforeKey = await firstCardKey(page, C.card);
      const beforeCount = await countCards(page, C);

      // ⑦ 提交搜索
      const submitted = await clickSearchButton(page, op, C.searchBtn);
      if (!submitted) {
        // 兜底：关键词框回车
        try { await page.keyboard.press('Enter'); } catch { return 'failed'; }
      }

      // ⑧ 等待搜索结果【变化】（不是"出现"——旧结果已在 DOM 里，waitForAny 立即满足）。
      //    ≥3s 让 security.min.js / 指纹 JS 自然跑完再操作
      //    （风险报告 §12：未就绪就操作会导致风控评分升高）。
      await op.wait('page');
      let ready = false;
      // ★ 2026-08-11：补一次【有界重试】。上面已用中性点击关联想下拉，但下拉不是唯一会
      //   吞点击的东西（通知气泡、AI 引导卡都可能挡一下）。真机实测「第一次点没反应、
      //   第二次点就出结果」是这条线最高频的失败形态，代价只是多一次点击，
      //   却能把整组合从「判失败放弃」救回来。只重试一次，绝不无限点（避免高频点击触发风控）。
      let retried = false;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 800));
        const nowKey = await firstCardKey(page, C.card);
        const nowCount = await countCards(page, C);
        // 指纹变化：首卡不同 或 卡片数变化（从有到无 或 从无到有 或 数量变化）
        if ((nowKey && nowKey !== beforeKey) || (nowCount !== beforeCount)) {
          ready = true;
          break;
        }
        // 等到第 5 轮（约 4 秒）仍无任何变化 → 极可能第一次点击被浮层吞了，补点一次
        if (i === 4 && !retried) {
          retried = true;
          console.warn('[liepin] 搜索提交后 4 秒无变化，疑似首次点击被浮层吞掉，补点一次搜索');
          await dismissOverlays(page, C.overlayLabels);
          await dismissSuggestDropdown(page, op, C);
          await clickSearchButton(page, op, C.searchBtn);
        }
      }
      await dismissOverlays(page, C.overlayLabels);

      if (!ready) {
        // 哨兵区分：「请设置搜索条件进行搜索」= 筛选未生效（工程问题），不是平台返空
        const body = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '').catch(() => '');
        if (body.includes(C.emptySentinel)) {
          // ★ 监控：筛选未生效（哨兵命中）—— 控制层要靠骨架定位是哪一类筛选没点上。
          //   只观测：不改返回值，下面照常 return 'filter-failed'。
          console.warn('[liepin][diagnostic] FILTER_FAILED_SENTINEL: 结果区命中空态哨兵，筛选未生效');
          await dumpSkeleton(page, 'FILTER_FAILED_SENTINEL').catch(() => {});
          return 'filter-failed';
        }
        // ★ 监控：搜索提交后长时间无结果变化（非筛选未生效、非空结果）——
        //   也可能是页码/容器结构漂移。采样一次供离线对照。
        await dumpSkeleton(page, 'NO_RESULT_READY').catch(() => {});
        return 'no-result';
      }

      // ⑨ 权威哨兵：用结果区【已应用筛选标签】校验筛选真生效（2026-08-18 修复2）。
      //    仅看首卡变化不够可靠（可能是上一组合残留结果在重渲染）。标签是「筛选真生效」
      //    的权威信号：真机实测设「1-3年+硕士」后结果区出现「硕士 ×」「1-3年 ×」。
      //    标签选择器无真机校准 = 零命中探针，零命中也算 FILTER_FAILED_TAGCHECK（不静默）。
      if (q.experience || q.degree || q.city || q.industry) {
        const tagCheck = await verifyAppliedFilterTags(page, C, q);
        if (tagCheck === 'missing') {
          // 标签命中但某设定项缺失 → 筛选没真生效
          if (q.strict) {
            console.warn('[liepin] 严格模式：结果区已应用标签缺失本组合设定项，判筛选未生效');
            console.warn('[liepin][diagnostic] FILTER_FAILED_TAGCHECK: 结果区已应用标签缺失设定项，已采样骨架');
            await dumpSkeleton(page, 'FILTER_FAILED_TAGCHECK').catch(() => {});
            return 'filter-failed';
          }
          console.warn('[liepin] 筛选标签校验缺失（宽松模式继续）：结果区已应用标签未含本组合全部设定项');
        } else if (tagCheck === 'unknown') {
          // 标签选择器零命中 = 结构漂移，不静默（真机一跑即暴露）
          console.warn('[liepin][diagnostic] FILTER_FAILED_TAGCHECK: 结果区标签选择器零命中（疑似结构漂移），已采样骨架');
          await dumpSkeleton(page, 'FILTER_FAILED_TAGCHECK').catch(() => {});
          // 结构漂移不阻断：标签选择器还没校准，不能因此放弃所有组合
        }
      }

      // ⑩ 结果排序（2026-08-18 产量重构·修复3）：把最新最活跃的人顶上来。
      //    默认「更新时间排序」；可由 settings.rpa.liepinSortMode 配置为「活跃度排序」。
      //    先确认有结果卡再设排序（0 卡时排序无意义，且下拉可能不存在）。
      //    排序失败不阻断（只是新人没那么顶），失败已 dump 骨架不静默。
      const n = await countCards(page, C);
      if (n > 0) {
        const sortMode: 'updateTime' | 'active' =
          (getSetting<any>('app-settings', null)?.rpa?.liepinSortMode === 'active') ? 'active' : 'updateTime';
        await applyResultSort(page, op, C, sortMode);
        // ★ 监控调用点①：首次搜索出结果(≥1卡) → tag='first-result'。
        //   只观测：不改返回值，下面照常 return 'ok'。
        await dumpSkeleton(page, 'first-result').catch(() => {});
        return 'ok';
      }
      return 'no-result';
    } catch (e: any) {
      console.warn('[liepin] applySearch 异常:', e?.message || e);
      return 'failed';
    }
  },

  // ---------- 风控检测（猎聘特化）----------
  async isRiskPage(page: Page): Promise<boolean> {
    // 猎聘无业务 iframe（lpt 搜索页是同帧渲染），但验证码可能注入 iframe → 同时看主帧与所有子帧的 src
    try {
      const inMain = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const path = location.pathname.toLowerCase();
        const href = location.href.toLowerCase();
        const has = (sel: string) => !!document.querySelector(sel);

        // 1. URL 路径信号（只看路径 + callbackUrl，不看 query —— 避免被业务参数误判）
        // ★ 2026-08-04 真机踩到：/secure/intercept-abroad-ip（境外 IP 拦截页）。
        //   命中后猎聘会直接把浏览器进程关掉、会话丢失，比验证码严重得多，
        //   所以 'secure'/'intercept' 必须进关键词表，且不能被 whitelist 放行。
        const pathKw = ['verify', 'captcha', 'challenge', 'validate', 'login', 'signin',
          'passport', 'blocked', 'intercept', '/secure/'];
        const whitelist = ['/search', '/cvview/', '/resume', '/im/', '/home'];
        const inWhite = whitelist.some((w) => path.includes(w));
        if (!inWhite && pathKw.some((k) => path.includes(k))) return true;
        if (href.includes('callbackurl=')) return true;

        // 2. 强文案（正文里正常不会出现，命中即判）
        const strong = [
          '拖动滑块', '拖动下方滑块', '人机验证', '请依次点击', '点选验证', '滑动验证',
          '完成安全验证', '请完成验证', '账号已被冻结', '账号已封禁', '账号受限',
          '请先登录', '扫码登录', '异常登录', '访问被拒绝', '禁止访问',
        ];
        if (strong.some((k) => body.includes(k))) return true;

        // 3. 弱文案（需整屏大提示才算：body 短）
        const weak = [
          '访问过于频繁', '操作过于频繁', '请求过于频繁', '请稍后再试', '频率过高',
          '访问异常', '系统检测到异常', '安全验证', '温馨提示', '风险提示', '异地登录', '设备异常',
        ];
        if (body.length < 2000 && weak.some((k) => body.includes(k))) return true;

        // 4. DOM 验证码容器：极验 + 腾讯防水墙 + 传统图形码 + 通用
        // ⚠️ T4 修正：加可见性过滤。lpt 是 React SPA，登录浮层/验证码容器可能常驻 DOM
        // （display:none），不加过滤会导致每次巡检都判 loginLost → 硬停置闩 → 永远跑不起来。
        const _visible = (el: Element): boolean => {
          if (!el) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          // 检查自身及祖先是否有 display:none（React 常用此方式隐藏浮层）
          let p: Element | null = el;
          while (p) {
            const ps = getComputedStyle(p);
            if (ps.display === 'none' || ps.visibility === 'hidden') return false;
            p = p.parentElement;
          }
          return true;
        };
        const hasVisible = (sel: string): boolean => {
          const el = document.querySelector(sel);
          return !!el && _visible(el);
        };
        const sel = [
          // 极验
          '.geetest_holder', '.geetest_box', '.geetest_panel', '.geetest_radar_tip',
          '.geetest_item_img', '#geetest-container', '[class*="geetest"]',
          // 腾讯防水墙（CSP 白名单实证：captcha.gtimg.com / captcha.myqcloud.com）
          '[class*="tcaptcha"]', '#tcaptcha', '#tcaptcha_iframe', '.tcaptcha-transform',
          // 传统图形验证码（/image/randomcode/ 下发 rand cookie）
          'img[src*="/image/randomcode/"]',
          // 阿里云 WAF 行为式滑块
          '[class*="nc_scale"]', '[class*="nc-lang-cnt"]', '#nc_1_wrapper', '.nc-container',
          // 通用
          '.verify-slider', '.captcha', '[class*="captcha"]', '[class*="slider-verify"]',
          'iframe[src*="captcha"]', 'iframe[src*="verify"]', 'iframe[src*="geetest"]',
          'iframe[src*="gtimg.com"]', 'iframe[src*="myqcloud.com"]',
          // 登录浮层（猎聘登录已整合进主站 SPA 浮层）—— 必须可见才算
          '[class*="login-dialog"]', '[class*="loginModal"]', '[class*="login-modal"]',
        ].join(',');
        if (hasVisible(sel)) return true;
        return false;
      });
      if (inMain) return true;
      // 子帧 src 特征（验证码常以 iframe 形式注入）
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        const u = f.url();
        if (/captcha|geetest|gtimg\.com|myqcloud\.com|verify|challenge/i.test(u)) return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  async classifyRiskKind(page: Page): Promise<DefenseSignalKind> {
    try {
      const r = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const path = location.pathname.toLowerCase();
        const has = (sel: string) => !!document.querySelector(sel);
        return {
          // ★ 境外 IP 拦截：IP 级信号，不是账号级。2026-08-04 真机命中过，
          //   表现是整页跳 /secure/intercept-abroad-ip 且随后浏览器进程退出。
          // ⛔⛔ 2026-08-07 真机实测：原正则 `/海外|境外|当前地区|地区限制|IP 归属地|IP归属地/`
          //   会把【完全正常的搜索结果页】判成境外 IP 拦截页 —— 因为「其他筛选」里有一个
          //   筛选标签就叫「**海外工作**」，它出现在每一张结果页的 innerText 里。
          //   后果：RPA 一搜出结果就判定风控、整条线停机。这极可能就是"猎聘真机根本不能用"
          //   最根本的那一条：前面所有环节修好之后，它照样会在第一页结果上停下。
          //   同理「境外」也会被候选人的「境外工作经历」或每候选人的隐私提示命中。
          //
          //   正确口径：境外 IP 拦截是【整页跳转】，以 URL 为准；正文兜底必须用拦截页的
          //   完整特征句（实测原文：「系统检测到您当前网络地址在境外」/「数据安全规则提示」），
          //   绝不能用「海外」「境外」这种在正常业务文案里高频出现的单词。
          abroadIp: path.includes('intercept-abroad-ip') || path.includes('/secure/intercept')
            || /当前网络地址在境外|数据安全规则提示|关闭VPN或切换网络|数据安全保护承诺函/.test(body),
          //   另一条实测原文：「对方设置了境外隐私权限，暂不支持查看简历」——这是 toast 级提示，
          //   页面本身完全正常，**刻意不作为风控信号**（判成风控就会把整条线打停，
          //   而实际只是这一条简历不可看）。开 VPN 时它对所有候选人出现，那属于环境问题，
          //   由上面 abroadIp 的整页跳转判定兜底。
          // ★ 账号封禁：72h~永久，与 30 分钟的验证码完全不是一回事，不能再 fallthrough
          banned: /账号已被冻结|账号已封禁|账号受限|账号异常|已被限制使用|违规操作/.test(body),
          verify: /verify|challenge|validate/.test(path) || location.href.toLowerCase().includes('callbackurl='),
          login: /请先登录|扫码登录|登录后查看|账号登录|手机号登录/.test(body)
            || has('[class*="login-dialog"], [class*="loginModal"], [class*="login-modal"]'),
          escalate: /请依次点击|点选验证|按顺序点击|图标验证|语音验证/.test(body) || has('.geetest_item_img'),
          tencent: has('[class*="tcaptcha"], #tcaptcha, #tcaptcha_iframe'),
          geetest: has('[class*="geetest"], #geetest-container, .geetest_holder, .geetest_box'),
          waf: has('[class*="nc_scale"], [class*="nc-lang-cnt"], #nc_1_wrapper, .nc-container'),
        };
      });
      // 子帧兜底（验证码 iframe）
      let frameTencent = false;
      let frameGeetest = false;
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        const u = f.url();
        if (/gtimg\.com|myqcloud\.com|tcaptcha/i.test(u)) frameTencent = true;
        if (/geetest/i.test(u)) frameGeetest = true;
      }
      // ★ 判定顺序 = 严重度倒序。境外 IP / 账号封禁排最前：它们是 IP 级/账号级信号，
      //   误判成验证码只会得到 30 分钟冷却，而真实代价是 72h~永久或整条出口 IP 被拦。
      if (r.abroadIp) return 'interceptAbroadIp';
      if (r.banned) return 'accountBanned';
      if (r.verify) return 'verifyRedirect';
      if (r.login) return 'loginLost';
      if (r.escalate) return 'captchaEscalate';
      if (r.tencent || frameTencent) return 'captchaTencent';
      if (r.waf) return 'wafChallenge';
      if (r.geetest || frameGeetest) return 'captchaGeetest';
      // ⚠️ 兜底绝不能再返回 captchaGeetest —— 那会把「分不出类型的风控页」
      //   谎报成"验证码，等 30 分钟就好"。分不出来就如实说分不出来，按需人工处理。
      return 'riskPageUnknown';
    } catch {
      return 'riskPageUnknown';
    }
  },

  async isRateWarning(page: Page): Promise<boolean> {
    try {
      const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
      return /访问过于频繁|操作过于频繁|请求过于频繁|请稍后再试|操作太快|频率过高|请降低访问频率/.test(txt);
    } catch {
      return false;
    }
  },

  /**
   * 会话/环境健康探针（猎聘版，与 BOSS 各写各的）。
   *  - cookieMutation：acw_tc / __gc_id / XSRF-TOKEN 缺失（阿里云 WAF 会话追踪 cookie 掉了）
   *  - skeletonStuck：骨架屏/加载中且 0 卡片
   *  - securityJsFail：已渲染出卡片但 window.__lp_cf 未定义（security.min.js 未正常加载）
   * ⚠️ 猎聘【不做】DOM 蜜罐检测 —— 实测首页/搜索页无 display:none 陷阱链接、无 trap/honey 类名，
   *    它的检测火力集中在 JS 侧全局变量。照抄 BOSS 的 DOM 探针只会白跑。
   */
  async probeSessionHealth(page: Page): Promise<SoftHealthSignal[]> {
    const out: SoftHealthSignal[] = [];
    const C = cfg();
    try {
      const r = await page.evaluate((cardSel: string) => {
        const cookie = document.cookie || '';
        // 注：acw_tc 是 HttpOnly，document.cookie 读不到 → 只查可读的 __gc_id / XSRF-TOKEN。
        // 这两个是猎聘首包必下发的长效访客标识与 CSRF 令牌，消失即会话异常。
        const hasGc = /(?:^|;\s*)__gc_id=/.test(cookie);
        const hasXsrf = /(?:^|;\s*)XSRF-TOKEN=/.test(cookie);
        const skeleton = !!document.querySelector('[class*="skeleton"], [class*="ant-lpt-skeleton"], [class*="loading"]');
        const bodyTxt = (document.body?.innerText || '').slice(0, 400);
        const loadingText = /加载中|正在加载|请稍候/.test(bodyTxt);
        // security.min.js 的全局入口（§2.8 实测：window.__lp_cf）
        const secDefined = typeof (window as any).__lp_cf !== 'undefined';
        const onLiepin = /liepin\.com/.test(location.href);
        const cards = document.querySelectorAll(cardSel).length;
        return { hasGc, hasXsrf, skeleton, loadingText, secDefined, onLiepin, cards };
      }, C.card);
      if (!r.hasGc || !r.hasXsrf) out.push('cookieMutation');
      if ((r.skeleton || r.loadingText) && r.cards === 0) out.push('skeletonStuck');
      if (r.onLiepin && r.cards > 0 && !r.secDefined) out.push('securityJsFail');
    } catch { /* 探针不可影响主流程 */ }
    return out;
  },

  /**
   * 配额耗尽检测（★ 非风控信号，走优雅停机通道）。
   * 原 Python 方案没有这个区分 —— 配额耗尽会被误当成"被限流"，触发 20 分钟熔断甚至误判隐形降权，
   * 用户看到红色告警但账号其实完全正常。这是猎聘相对 BOSS 新增的一类状态。
   */
  async detectQuotaStop(page: Page): Promise<QuotaStop | null> {
    const C = cfg();
    try {
      // 2026-08-07 P1-11: 先在浮层/弹窗容器内匹配（精准），再兜底扫整页（保守）。
      // 容器内匹配防止正文里的相似词（如招聘广告位「额度不足」）误触发优雅停机。
      const hit = await page.evaluate((texts: string[], modalSels: string[]) => {
        // 优先在浮层容器里找
        for (const sel of modalSels) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const txt = (el as HTMLElement).innerText || '';
            for (const t of texts) if (txt.includes(t)) return t;
          }
        }
        // 兜底：扫整页（只看前 3000 字符，避免大段 DOM）
        const body = (document.body?.innerText || '').slice(0, 3000);
        for (const t of texts) if (body.includes(t)) return t;
        return '';
      }, C.quotaTexts, C.quotaModalSelectors ?? []);
      return hit ? 'dailyDetails' : null;
    } catch {
      return null;
    }
  },

  // ---------- 抓取（阶段 A：列表级，零请求零写）----------
  async extractCards(page: Page): Promise<CandidateProfile[]> {
    const C = cfg();
    try {
      const raw = await page.evaluate((S: LiepinCfg) => {
        // resIdEncode 四级兜底提取链 —— 原 Python 方案 _safe_profile_url 的完整移植。
        // 实测覆盖了 4 种 DOM 形态，价值很高，一条都不能省。
        const extractRid = (card: Element): { rid: string; url: string } => {
          // ①  a[href] 里带 liepin 域的链接
          const anchors = Array.from(card.querySelectorAll('a[href]')) as HTMLAnchorElement[];
          for (const a of anchors) {
            const href = (a.getAttribute('href') || '').trim();
            if (href && href.includes('liepin.com')) {
              const m = /[?&]resIdEncode=([^&#]+)/.exec(href);
              if (m) return { rid: decodeURIComponent(m[1]), url: href };
            }
          }
          // ②③ data-resumeurl / data-resumeidencode（含祖先 li 与父节点）
          const targets: Element[] = [card];
          const li = card.closest('li');
          if (li) targets.push(li);
          if (card.parentElement) targets.push(card.parentElement);
          for (const t of targets) {
            const ru = (t.getAttribute('data-resumeurl') || '').trim();
            if (ru) {
              const decoded = ru.replace(/&amp;/g, '&');
              const m = /[?&]resIdEncode=([^&#]+)/.exec(decoded);
              if (m) return { rid: decodeURIComponent(m[1]), url: decoded };
            }
            const rid = (t.getAttribute('data-resumeidencode') || '').trim();
            if (rid) return { rid, url: '' };
          }
          // ④ outerHTML 正则（属性被框架转义/藏在内层时）
          const html = card.outerHTML || '';
          let m = /data-resumeidencode="([^"]+)"/.exec(html);
          if (m) return { rid: m[1].replace(/&amp;/g, '&'), url: '' };
          m = /data-resumeurl="([^"]+)"/.exec(html);
          if (m) {
            const decoded = m[1].replace(/&amp;/g, '&');
            const mm = /[?&]resIdEncode=([^&#]+)/.exec(decoded);
            if (mm) return { rid: decodeURIComponent(mm[1]), url: decoded };
          }
          // ⑤ URL 编码的 %22res_id%22%3A%22xxx%22（埋点参数里带的）
          m = /%22res_id%22%3A%22([^%]+)%22/.exec(html);
          if (m) return { rid: decodeURIComponent(m[1]), url: '' };
          return { rid: '', url: '' };
        };

        const txt = (root: Element, sel: string): string => {
          for (const s of sel.split(',')) {
            const el = root.querySelector(s.trim());
            const v = el ? (el.textContent || '').trim() : '';
            if (v) return v;
          }
          return '';
        };

        const cards = Array.from(document.querySelectorAll(S.card));
        // 去掉嵌套命中：多重兜底选择器可能同时命中外层 li 与内层 div[data-tlg-elem-id]
        // （20 卡 → querySelectorAll 返 40 个元素：20 li + 20 内层 div）。
        // ★ 2026-08-18 修复4：双重去重——
        //   ① 按 data-resumeidencode 去重（同 rid 只留一个，与 countCards 同口径）；
        //   ② 仍保留祖先去重兜底（无 rid 的元素不会被误留）。
        //   这样 roots 必然 = 真实卡片数（20），不依赖选择器里有没有内层 div。
        const ridSeen = new Set<string>();
        const set = new Set(cards);
        const roots = cards.filter((c) => {
          // 祖先去重：内层 div 的祖先 li 在集合里 → 把 div 过滤掉
          const hasAncestorInSet = cards.some((o) => o !== c && o.contains(c) && set.has(o));
          if (hasAncestorInSet) return false;
          // rid 去重：同一 rid 的多个元素只留第一个
          const rid = (c.getAttribute('data-resumeidencode') || '').trim()
            || c.closest('li')?.getAttribute('data-resumeidencode') || '';
          if (rid) {
            if (ridSeen.has(rid)) return false;
            ridSeen.add(rid);
          }
          return true;
        });

        // 2026-07-28 真机校准：优先从精确 span 取（公司/职位/年龄/年限/学历/城市/活跃），
        //   回退到正则从 detail blob 猜（兼容老 selector 或选择器被覆盖时）。
        return roots.map((card) => {
          const { rid, url } = extractRid(card);
          const name = txt(card, S.list.name);
          const detail = txt(card, S.list.detail);
          const workNodes = Array.from(card.querySelectorAll(S.list.work));
          const workLines = workNodes.map((w) => (w.textContent || '').trim()).filter(Boolean);
          const eduNodes = Array.from(card.querySelectorAll(S.list.edu));
          const eduLines = eduNodes.map((e) => (e.textContent || '').trim()).filter(Boolean);
          const tags = Array.from(card.querySelectorAll(S.list.tags))
            .map((t) => (t.textContent || '').trim()).filter(Boolean);
          const cardText = (card as HTMLElement).innerText || card.textContent || '';
          const location = txt(card, S.list.location);
          let active = '';
          for (const t of S.activeTerms) { if (cardText.includes(t)) { active = t; break; } }
          // —— 精确字段（2026-07-28 新增，selector 可选，缺失回退正则）——
          const age = S.list.age ? txt(card, S.list.age) : '';
          const workYearsExact = S.list.workYears ? txt(card, S.list.workYears) : '';
          const eduLevelExact = S.list.eduLevel ? txt(card, S.list.eduLevel) : '';
          const workCompany = S.list.workCompany ? txt(card, S.list.workCompany) : '';
          let workPosition = '';
          let workDuration = '';
          if (S.list.workPosition) {
            // work-item-extra 文本是「后端开发工程师2019.08-至今(6年11个月)」——
            //   职位 + 时长黏在一起，没有分隔符。不做 DOM remove（会污染页面），
            //   先取整段，后续在外部用正则剥日期。
            workPosition = txt(card, S.list.workPosition);
          }
          if (S.list.workDuration) workDuration = txt(card, S.list.workDuration);
          // 期望区（2026-08-07 真机取证）：`personal-expect-content` 下是【三个无 class 的子元素】，
          //   依次为 期望城市 / 期望职位 / 期望薪资，例：["郑州","算法工程师","25-35K·13薪"]。
          //   ⚠️ 整块取 textContent 会得到"郑州算法工程师25-35K·13薪"——直接当职位用会严重污染
          //   positionFit 评分。必须按子元素拆，取中间那个。顺带把城市与薪资也收下来。
          let expectPosition = '';
          let expectCity = '';
          let expectSalary = '';
          if (S.list.expectPosition) {
            const exEl = card.querySelector(S.list.expectPosition);
            if (exEl) {
              const kids = Array.from(exEl.children)
                .map((k) => (k.textContent || '').trim()).filter(Boolean);
              if (kids.length >= 3) {
                expectCity = kids[0]; expectPosition = kids[1]; expectSalary = kids[2];
              } else if (kids.length === 2) {
                // 少一段时无法判定缺的是城市还是薪资：带 K/薪/元 的判为薪资，否则判为城市
                if (/[Kk千万]|薪|元/.test(kids[1])) { expectPosition = kids[0]; expectSalary = kids[1]; }
                else { expectCity = kids[0]; expectPosition = kids[1]; }
              } else if (kids.length === 1) {
                expectPosition = kids[0];
              }
            }
          }
          // 学校：⚠️ querySelector('a, b') 返回的是【文档顺序】第一个，不是选择器列表顺序——
          //   把 edu-item-school 写在列表最前面并不会让它优先命中（实测取到的仍是整行容器
          //   "辽宁工业大学车辆硕士统招2020.09-2023.06(3年)"）。必须单独精确查一次。
          const school = (() => {
            const e = card.querySelector("[class*='edu-item-school']");
            return e ? (e.textContent || '').trim() : '';
          })();
          return { rid, url, name, detail, workLines, eduLines, tags, cardText, location, active,
            age, workYearsExact, eduLevelExact, workCompany, workPosition, workDuration,
            expectPosition, expectCity, expectSalary, school };
        });
      }, C);

      const out: CandidateProfile[] = [];
      for (const r of raw || []) {
        if (!r.rid && !r.name) continue; // 既无锚也无姓名的行是噪声
        const rid = RES_ID_RE.test(r.rid) ? r.rid : '';

        // 公司 / 职位：优先精确 span，回退老的分隔符拆分
        let company = r.workCompany || '';
        let position = r.workPosition || '';
        if ((!company || !position) && r.workLines.length) {
          const parts = String(r.workLines[0]).split(/[|｜\n]/).map((s: string) => s.trim()).filter(Boolean);
          if (!company) company = parts[0] || '';
          if (!position) position = parts[1] || '';
        }
        // 剥掉职位末尾的工作时长（"xxx工程师2019.08-至今(6年11个月)" → "xxx工程师"）
        if (position) position = position.replace(/\d{4}\.\d{1,2}[-—至].*$/, '').trim();
        // ★ 期望职位优先（2026-08-06）：评分的 positionFit 维比的是"这个人和这个岗位对不对口"，
        //   候选人自己填的求职意向比"最近一份工作叫什么"更能回答这个问题——
        //   一个想转行做定位算法的嵌入式工程师，最近职位是"嵌入式工程师"、期望职位才是"定位算法"。
        //   与 BOSS 侧 position=求职意向的语义也就此对齐。取不到时才回退最近职位。
        const expectPos = String(r.expectPosition || '').trim();
        if (expectPos) position = expectPos;

        // 年限 / 学历 / 城市：优先精确字段 → 回退正则
        let years: number | undefined;
        if (r.workYearsExact) {
          const my = /(\d{1,2})\s*年/.exec(r.workYearsExact);
          if (my && Number(my[1]) < 60) years = Number(my[1]);
        }
        if (years === undefined) {
          const blob = `${r.detail}\n${r.cardText}`;
          const my = /(\d{1,2})\s*年/.exec(blob);
          if (my && Number(my[1]) < 60) years = Number(my[1]);
        }
        let degree = '';
        if (r.eduLevelExact && r.eduLevelExact !== '--' && !/^\s*--?\s*$/.test(r.eduLevelExact)) {
          degree = r.eduLevelExact.trim();
        }
        if (!degree) {
          const blob = `${r.detail}\n${r.cardText}`;
          for (const d of ['博士后', '博士', '硕士研究生', '硕士', 'MBA', '本科', '大专', '中专', '高中']) {
            if (blob.includes(d)) { degree = d; break; }
          }
        }
        // 城市：★ 2026-08-11 按用户口径纠正——匹配看的是【期望城市】不是【目前所在城市】。
        //   住北京但期望武汉的人是有效目标；住武汉但想去上海的不是。
        //   原实现 `location || expectCity` 把当前城市排在前面，方向反了，
        //   会把"人在目标城市但想走"的人判成高匹配、把"人在外地但想来"的人判低。
        //   故改为期望城市优先，取不到才回退当前城市（卡片上 3/20 没有期望区）。
        let city = r.expectCity || r.location || '';
        if (!city) {
          const mc = /([一-龥]{2,8}\s*-\s*[一-龥]{1,12})/.exec(r.detail || '');
          if (mc) city = mc[1].replace(/\s+/g, '');
        }
        if (!city) {
          const segs = String(r.detail || '').split(/[|｜]/).map((s: string) => s.trim()).filter(Boolean);
          if (segs.length >= 2) city = segs[segs.length - 1];
        }

        const detailUrl = rid ? buildDetailUrl(rid) : (r.url || '');
        // 剥掉姓名后面跟着的非姓名文案（「名片简历」「已认证」「猎头」等 icon 文本），
        // 但保留中文名（2-4 字）与英文名。
        let cleanName = (r.name || '').trim();
        cleanName = cleanName.replace(/^(.*?)(名片简历|已认证|认证猎头|企业代招|金牌顾问.*)$/u, '$1').trim();
        // 若清洗后没中文了，就留原值（避免误伤英文名）
        if (!/[一-龥a-zA-Z]/.test(cleanName)) cleanName = (r.name || '').trim();
        out.push({
          name: cleanName || undefined,
          position: position || undefined,
          company: company || undefined,
          city: city || undefined,
          degree: degree || undefined,
          experienceYears: years,
          skills: r.tags || [],
          active: r.active || undefined,
          // 2026-08-07 真机取证补齐：期望薪资与学校此前完全没采，
          // 而 salary 维与 education 维在评分里都是实打实参与加权的。
          salary: r.expectSalary || undefined,
          education: r.school ? [{ school: r.school, degree: degree || undefined }] : undefined,
          // ★ 落 https 永久深链，不落自定义协议锚。
          //   BOSS 的 boss:geek: 是会话级重放锚、除此之外无永久链接，只能那样存；
          //   但猎聘 buildDetailUrl(rid) 本来就是可直接打开的 https 永久链接。
          //   此前存 `liepin:res:<rid>`，人才库点「打开来源」时被 openExternalSafe
          //   的 http/https 白名单拒绝，恒报「来源链接无效或协议不允许」。
          //   去重锚另有 cardKey(resIdEncode) 承担，不依赖 url 字段。2026-08-07 审查发现。
          url: rid ? buildDetailUrl(rid) : (r.url || undefined),
          depth: 'A',
          liepinMeta: {
            resIdEncode: rid || undefined,
            detailUrl: detailUrl || undefined,
            cardText: r.cardText || undefined,
          },
        });
      }
      return out;
    } catch (e) {
      // ⚠️ 绝不能吞掉致命错误后返回空数组。返回 [] 等于告诉引擎"这一屏 0 条"，
      // 而引擎对分页器平台把"0 条新人"当作组合结束——页面崩溃 / Target closed 就这样
      // 被伪装成正常收工，C-3 崩溃恢复链与断点记录全部跳过。与 boss.ts 同口径：
      // 致命错误上抛交给崩溃恢复，普通解析失败返回 null 让引擎走重试退避。
      if (isFatalPageError(e)) throw e;
      console.warn('[liepin.extractCards] 解析失败：', (e as any)?.message || e);
      return null as any;
    }
  },

  cardKey(c: CandidateProfile): string {
    return (
      c.liepinMeta?.resIdEncode || c.url || `${c.name || ''}|${c.company || ''}|${c.position || ''}`
    ).trim();
  },

  detailUrl(c: CandidateProfile): string | null {
    const rid = c.liepinMeta?.resIdEncode;
    if (rid) return buildDetailUrl(rid);
    return c.liepinMeta?.detailUrl || null;
  },

  /** 标注来源组合 —— 关键词效果复盘 + 猎聘特有的隐形降权基线维度 */
  annotateSource(c: CandidateProfile, query: SearchQuery, pageNo: number): void {
    if (!c.liepinMeta) c.liepinMeta = {};
    c.liepinMeta.sourceKeyword = query.keyword;
    c.liepinMeta.sourceCity = query.city;
    c.liepinMeta.sourceIndustry = query.industry;
    c.liepinMeta.pageNo = pageNo;
  },

  /**
   * ★ 必须【合并】而非展开：extractDetail 只返回 { detailText }，
   * 直接 {...card, ...detail} 会把 liepinMeta 整块换掉，resIdEncode 稳定锚随之丢失 →
   * 去重失效、source_id 写空、会话重放打不开。
   */
  mergeDetail(card: CandidateProfile, detail: Partial<CandidateProfile>): CandidateProfile {
    const merged: CandidateProfile = { ...card, ...detail };
    if (card.liepinMeta || detail.liepinMeta) {
      merged.liepinMeta = { ...card.liepinMeta, ...detail.liepinMeta };
    }
    return merged;
  },

  /**
   * 评分补充文本：详情全文优先，其次卡片全文。
   * 猎聘的信息密度主要在渲染后的整段文本里（也正因为读的是渲染后文本，
   * 天然绕开了 woff2 字体反爬 —— 见风险报告 §三）。
   */
  scoreText(c: CandidateProfile): string | undefined {
    return c.liepinMeta?.detailText || c.liepinMeta?.cardText || undefined;
  },

  async findCardElement(page: Page, card: CandidateProfile): Promise<ElementHandle | null> {
    const C = cfg();
    const rid = card.liepinMeta?.resIdEncode;
    if (rid) {
      for (const sel of [
        `[data-resumeidencode="${rid}"]`,
        `a[href*="resIdEncode=${rid}"]`,
        `[data-resumeurl*="${rid}"]`,
      ]) {
        const el = await page.$(sel).catch(() => null);
        if (el) return el;
      }
    }
    if (card.name) {
      const cards = await page.$$(C.card).catch(() => [] as ElementHandle[]);
      for (const c of cards) {
        const t = await c.evaluate((el) => (el.textContent || '').slice(0, 160)).catch(() => '');
        if (t.includes(card.name)) return c;
      }
    }
    return null;
  },

  /**
   * 阶段 B：详情级抓取。
   * 主路径 = 读渲染后 innerText 交给评分词表 —— 浏览器已完成 woff2 渲染，
   * 天然绕开猎聘字体反爬（风险报告 §三：RPA 读 DOM 文本不受字体混淆影响）。
   * 结构化字段是增强不是依赖：选择器未真机校准时也不影响主流程。
   */
  async extractDetail(page: Page): Promise<Partial<CandidateProfile>> {
    const C = cfg();
    try {
      const info = await page.evaluate((D: LiepinCfg['detail']) => {
        const t = (sel: string) => {
          for (const s of sel.split(',')) {
            const el = document.querySelector(s.trim());
            const v = el ? (el.textContent || '').trim() : '';
            if (v) return v;
          }
          return '';
        };
        const bodyText = (document.body as HTMLElement)?.innerText || '';
        const skills = Array.from(document.querySelectorAll(D.skills))
          .map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 40);
        return {
          bodyText: bodyText.slice(0, 20000), // 截断，避免超大简历撑爆内存/DB
          pageTitle: document.title || '',
          name: t(D.name), title: t(D.title), company: t(D.company),
          city: t(D.city), exp: t(D.exp), edu: t(D.edu), salary: t(D.salary), skills,
        };
      }, C.detail);

      const p: Partial<CandidateProfile> = { depth: 'B' };
      if (info.name) p.name = info.name;
      if (info.title) p.position = info.title;
      if (info.company) p.company = info.company;
      if (info.city) p.city = info.city;
      if (info.salary) p.salary = info.salary;
      if (info.skills?.length) p.skills = info.skills;

      const blob = `${info.bodyText}`;
      const my = /(\d{1,2})\s*年/.exec(blob);
      if (my && Number(my[1]) < 60) p.experienceYears = Number(my[1]);
      for (const d of ['博士后', '博士', '硕士研究生', '硕士', 'MBA', '本科', '大专', '中专', '高中']) {
        if (blob.includes(d)) { p.degree = d; break; }
      }
      // 详情全文进 liepinMeta.detailText（评分词表主要输入；引擎会 merge 进已有 meta）
      p.liepinMeta = { detailText: info.bodyText };
      return p;
    } catch {
      return {};
    }
  },

  // ---------- 动作 ----------
  // 首版零写：收藏不调用（保留实现以备后续，但需真机校准选择器）
  /**
   * ★ 猎聘搜索列表卡片上【没有收藏控件】——2026-08-06 三平台结构取证实测：
   *   `[class*=star|collect|fav]` 在卡片内命中 0，卡片上只有「立即沟通」「超级聊聊」
   *   两个【对外发消息】的按钮（红线，绝不可点）。
   *   故 supportsListFavorite=false，引擎会整步跳过，这个方法正常路径下不会被调用。
   *
   * 保留实现并【收窄到卡片内】，是为了防住一个真实隐患：原实现用 page.$(sel) 做
   * 文档级查找，而猎聘左侧导航里就有「我的收藏」(/resume/collect)，
   * `[class*='collect']` 极可能命中它 —— 点下去会整页导航走，搜索结果全丢，
   * 而日志上只会显示"已收藏该候选人"。宁可返回 false，也不能点到卡片以外的东西。
   */
  async tryFavorite(page: Page, op: HumanOperator, card?: ElementHandle<Element>): Promise<boolean> {
    const C = cfg();
    const root = card || null;
    if (!root) return false; // 没有卡片作用域就不点——绝不退化成文档级查找
    for (const sel of C.favorite) {
      const el = await root.$(sel).catch(() => null);
      if (el) {
        try { return await op.clickElement(el); } catch { try { await el.click(); return true; } catch { /* next */ } }
      }
    }
    return false;
  },

  /**
   * ★ 猎聘不实现打招呼。
   * 依据《猎聘RPA风险调查.md》R6：批量打招呼是投诉/封企业号/品牌受损三重风险，
   * 且「auto-greet 关 + 不爬售数据」是刑事+声誉的双重护栏。
   * 猎聘侧只产出短名单，交 HR 人工触达。恒返回 false 而非抛错 —— 让引擎按"未发送"正常统计。
   */
  async tryGreet(): Promise<boolean> {
    console.warn('[liepin] 按合规设计，猎聘侧不实现自动打招呼（短名单交 HR 人工触达）');
    return false;
  },

  /** ant 分页器翻页。next 变 disabled（平台尾页）或翻页失败 → 返回 false，引擎收敛换组合。 */
  async goNextPage(page: Page, op: HumanOperator): Promise<boolean> {
    const C = cfg();
    console.warn('[liepin][diagnostic] goNextPage 进入');
    try {
      // ★ 2026-08-18 修复4：卡片计数改用去重后的 countCards，不再 40/20 虚高。
      const before = await countCards(page, C);
      const firstBefore = await firstCardKey(page, C.card);
      // 翻页前的页码（ant 分页器高亮项）。与首卡 key 互为备份判据，见下面的沉降等待。
      const pageNoBefore = await page.$eval(C.pagerCur, (el) => (el.textContent || '').trim())
        .catch(() => '');

      // 找可用的"下一页"
      const btn = await page.$(C.pagerNext).catch(() => null);
      console.warn(`[liepin][diagnostic] goNextPage 找到下一页按钮=${btn ? 'Y' : 'N'}`);
      if (!btn) {
        // ★ 监控：分页器「下一页」按钮不存在 —— 真到尾页 / 或分页器选择器漂移。
        //   采骨架供离线区分两种情况（看分页器真实结构）。只观测。
        console.warn('[liepin][diagnostic] GO_NEXT_PAGE_NO_BTN: 分页器「下一页」按钮未找到，已采样骨架');
        console.warn('[liepin][diagnostic] goNextPage 返回=false（按钮未找到）');
        await dumpSkeleton(page, 'GO_NEXT_PAGE_NO_BTN').catch(() => {});
        return false;
      }
      const disabled = await btn.evaluate((el) => {
        const cls = (el.getAttribute('class') || '').toLowerCase();
        const aria = (el.getAttribute('aria-disabled') || '').toLowerCase();
        const li = el.closest('li');
        const liCls = (li?.getAttribute('class') || '').toLowerCase();
        return cls.includes('disabled') || aria === 'true' || (el as any).disabled === true
          || liCls.includes('disabled');
      }).catch(() => true);
      console.warn(`[liepin][diagnostic] goNextPage 按钮disabled=${disabled ? 'Y' : 'N'}`);
      if (disabled) {
        // ★ 监控：下一页 disabled —— 真到尾页的正常路径。采骨架供离线对照"正常尾页"形态。
        //   正常尾页高频出现，不 warn 噪声（只采骨架）；与 NO_BTN/FAILED 的 warn 口径区分。
        console.warn('[liepin][diagnostic] goNextPage 返回=false（下一页disabled，已到尾页）');
        await dumpSkeleton(page, 'GO_NEXT_PAGE_LAST').catch(() => {});
        return false;
      }

      // ★ 2026-08-11 真机：点击前必须把分页器滚到【视口中央】。
      //   puppeteer 的 clickElement 只做最小滚动（元素刚露出下沿就点），
      //   而猎聘结果页底部常驻一条吸底工具条（「全选 / 浏览简历」），
      //   恰好压在分页器上 → 点击落到吸底条上，页面不动，
      //   goNextPage 于是判定「翻不动」并返回 false，整个组合被当成「已到最后一页」收工。
      //   实测：先 scrollIntoView({block:'center'}) 后，该点最上层元素就是分页按钮本身（未被拦截）。
      //   这与主搜索按钮被联想下拉吞点击是同一类问题：这个页面上"点得到"必须显式验证。
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
      }, C.pagerNext).catch(() => {});
      await op.smallWait();

      // 点击前清掉遗留浮层（预览抽屉/引导卡都会挡住分页器）
      await dismissOverlays(page, C.overlayLabels);

      await op.clickElement(btn).catch(async () => { try { await btn.click(); } catch { /* ignore */ } });
      console.warn('[liepin][diagnostic] goNextPage 已点击下一页按钮');
      await op.wait('page');

      // 沉降等待：翻页后首卡应变化（卡片数可能相同）。
      // ★ 2026-08-11 真机：原来只等 10×800ms=8 秒【太短】。实测这一页翻页后
      //   4 秒时卡片数仍是 0（列表整块重渲染），8 秒内不一定能等到新首卡出现，
      //   于是 goNextPage 返回 false → 引擎判「已到最后一页」提前收工，
      //   每个搜索组合只拿到第 1 页的 20 人，产量被砍到 1/10。
      //   放宽到 24×800ms≈19 秒；真到尾页时 li 会带 disabled，上面早就 return false 了，
      //   不会因为放宽而在尾页空等。
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 800));
        const firstNow = await firstCardKey(page, C.card);
        const now = await countCards(page, C);
        if ((firstNow && firstNow !== firstBefore) || (now > 0 && before === 0)) {
          const pageNoNow = await page.$eval(C.pagerCur, (el) => (el.textContent || '').trim())
            .catch(() => '');
          console.warn(`[liepin][diagnostic] goNextPage 沉降${(i + 1) * 0.8}秒后 首卡变化=Y 页码=${pageNoBefore}→${pageNoNow} 返回=true（翻页成功）`);
          return true;
        }
        // ★ 2026-08-13：补一条【页码】判据（来自旧版 RPA 的经验对照）。
        //   只看首卡 key 变化有个盲区：列表整块重渲染期间 firstCardKey 会短暂返回空，
        //   若恰好在这段窗口内耗完重试次数，就会把"其实翻成功了"判成"到最后一页"。
        //   ant 分页器的 pagination-item-active 是翻页成功的【直接信号】，且比卡片先稳定。
        //   旧版（liepin_rpa_enhanced.py::_next_page）更激进——点完只等 1.8~3.2s 就当成功、
        //   完全不校验，所以它的产量高但会把失败当成功。这里取中间：两条判据任一命中即成功。
        if (pageNoBefore) {
          const pageNoNow = await page.$eval(C.pagerCur, (el) => (el.textContent || '').trim())
            .catch(() => '');
          if (pageNoNow && pageNoNow !== pageNoBefore) {
            console.warn(`[liepin][diagnostic] goNextPage 沉降${(i + 1) * 0.8}秒后 首卡变化=N 页码=${pageNoBefore}→${pageNoNow} 返回=true（页码变化，翻页成功）`);
            return true;
          }
        }
      }
      // ★ 监控：沉降等待超时判失败 —— 最危险的假阳性：把"其实翻成功了但首卡/页码
      //   没及时稳定"判成"已到最后一页"，每个组合只拿第 1 页。采骨架看翻页后真实状态。
      //   只观测：不改返回值，下面照常 return false。
      console.warn('[liepin][diagnostic] GO_NEXT_PAGE_FAILED: 翻页沉降等待超时（首卡/页码未变化），已采样骨架');
      console.warn('[liepin][diagnostic] goNextPage 返回=false（沉降超时，首卡/页码均未变化）');
      await dumpSkeleton(page, 'GO_NEXT_PAGE_FAILED').catch(() => {});
      return false;
    } catch (e: any) {
      // ★ 监控：goNextPage 抛异常 —— 采骨架定位异常现场（分页器结构漂移？）。
      console.warn('[liepin][diagnostic] GO_NEXT_PAGE_ERROR: 翻页异常 ' + (e?.message || e) + '，已采样骨架');
      console.warn('[liepin][diagnostic] goNextPage 返回=false（异常）');
      await dumpSkeleton(page, 'GO_NEXT_PAGE_ERROR').catch(() => {});
      return false;
    }
  },

  // ★ 2026-08-19 页深持久化·续翻跳页：读当前真实页码 + 用分页器逼近到目标页。
  //   仅用于 jumpToResultPage 续翻定位（只操作分页器，不点卡片/沟通/详情）。
  //   每次 •••/页码点击都是真实翻页请求——引擎侧据返回的 clicks 计入频率/翻页配额并走 pace，
  //   这里只负责把点击做拟人 + 校验落地，不碰任何配额通道。
  /** 读 ant-lpt-pagination-item-active 文本=当前真实页码。读不到返 0（视为第1页）。 */
  async readCurrentPageNo(page: Page): Promise<number> {
    try {
      const cur = await page.$eval(cfg().pagerCur, (el) => (el.textContent || '').trim()).catch(() => '');
      const n = parseInt(cur, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch { return 0; }
  },

  /**
   * 用分页器逼近到第 targetN 页（c-in-c 真机实测的分页器行为）：
   *   · targetN 在当前可见页码里(li.ant-lpt-pagination-item title===targetN) → 拟人直点，精确落第 N 页。
   *   · 否则点 jump-next(targetN>C)/jump-prev(targetN<C)「•••」每次 ±5 页。
   *   每次 clickElement 后 wait('page') + 沉降校验（item-active 文本变化到预期/或至少变化）。
   *   返回 {ok, landed, clicks, capped, reason}：clicks=本次真实翻页点击次数（引擎据此计配额/pace）。
   *   capped=true 表示 targetN 超引擎给的 maxClicks 预算或命中分页器不可达（如 targetN 远超可见末页），
   *   引擎侧记 RESUME_JUMP_CAPPED 不静默。
   *   分页器异常/连续两次点击页码不变 → dumpSkeleton('RESUME_JUMP_FAIL')，返 ok=false、reason，不抛。
   */
  async resumeToPage(
    page: Page, op: HumanOperator, targetN: number, maxClicks: number,
  ): Promise<{ ok: boolean; landed: number; clicks: number; capped: boolean; reason?: string }> {
    const C = cfg();
    const PAGER_ITEM = C.pagerItem || "li.ant-lpt-pagination-item[title]";
    const JUMP_NEXT = C.pagerJumpNext || "li.ant-lpt-pagination-jump-next";
    const JUMP_PREV = C.pagerJumpPrev || "li.ant-lpt-pagination-jump-prev";
    let clicks = 0;
    let lastPage = -1;
    let staleStreak = 0;

    const readCur = async (): Promise<number> => {
      try {
        const cur = await page.$eval(C.pagerCur, (el) => (el.textContent || '').trim()).catch(() => '');
        const n = parseInt(cur, 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
      } catch { return 0; }
    };

    // 滚动分页器到视口中央（与 goNextPage 同因：吸底工具条会压住分页器）
    const scrollPagerCenter = async () => {
      try {
        await page.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
        }, C.pagerNext).catch(() => {});
      } catch { /* ignore */ }
    };

    while (clicks < maxClicks) {
      const cur = await readCur();
      if (cur === targetN) return { ok: true, landed: cur, clicks, capped: false };
      if (cur <= 0) {
        // 读不到当前页：分页器可能还没渲染/结构漂移，不空耗配额，直接判失败
        await dumpSkeleton(page, 'RESUME_JUMP_FAIL').catch(() => {});
        return { ok: false, landed: cur, clicks, capped: false, reason: '读不到当前页码（分页器未渲染/结构漂移）' };
      }

      await scrollPagerCenter();
      await op.smallWait();
      await dismissOverlays(page, C.overlayLabels);

      // ① 目标页在当前可见页码里 → 直点精确落地
      const targetEl = await page.evaluateHandle((sel: string, target: number) => {
        const els = Array.from(document.querySelectorAll(sel));
        const hit = els.find((el) => parseInt(el.getAttribute('title') || '0', 10) === target);
        return hit || null;
      }, PAGER_ITEM, targetN).catch(() => null);
      const node = targetEl && await targetEl.asElement();
      if (node) {
        await op.clickElement(node).catch(() => { /* 下面校验兜底 */ });
        clicks++;
        await op.wait('page');
        const now = await readCur();
        if (now === targetN) return { ok: true, landed: now, clicks, capped: false };
        if (now > 0 && now !== lastPage) { lastPage = now; staleStreak = 0; }
        else if (++staleStreak >= 2) {
          await dumpSkeleton(page, 'RESUME_JUMP_FAIL').catch(() => {});
          return { ok: false, landed: now, clicks, capped: false, reason: `直点第${targetN}页后页码未变(→${now})` };
        }
        continue;
      }

      // ② 点 ••• 前进 ±5
      const forward = targetN > cur;
      const jumpSel = forward ? JUMP_NEXT : JUMP_PREV;
      const jumpBtn = await page.$(jumpSel).catch(() => null);
      if (!jumpBtn) {
        // 没有该方向的 ••• ：要么已到末页边界(targetN 超出可达范围)，要么结构漂移
        await dumpSkeleton(page, 'RESUME_JUMP_FAIL').catch(() => {});
        return { ok: false, landed: cur, clicks, capped: true, reason: `${forward ? '后' : '前'}跳•••未找到(已到可达边界或结构漂移)` };
      }
      await op.clickElement(jumpBtn).catch(async () => { try { await jumpBtn.click(); } catch { /* 校验兜底 */ } });
      clicks++;
      await op.wait('page');
      const now = await readCur();
      if (now === targetN) return { ok: true, landed: now, clicks, capped: false };
      if (now > 0 && now !== lastPage) { lastPage = now; staleStreak = 0; }
      else if (++staleStreak >= 2) {
        await dumpSkeleton(page, 'RESUME_JUMP_FAIL').catch(() => {});
        return { ok: false, landed: now, clicks, capped: false, reason: `点•••后页码连续2次未变(→${now})` };
      }
    }
    // 用尽 maxClicks 仍未到位：不判成功(避免假成功)，但 landed 可能已推进——引擎据此决定 capped/退回
    const finalCur = await readCur();
    return { ok: false, landed: finalCur, clicks, capped: true, reason: `跳页${clicks}次未到第${targetN}页(当前第${finalCur}页)` };
  },

  /**
   * 真机只读探针（0-1 校准的主力工具）。
   * 严格只读：不点击、不导航、不写库、不开详情 —— 跑一百遍也不消耗任何套餐额度。
   */
  async selfTest(page: Page) {
    const C = cfg();
    const notes: string[] = [];

    const url = page.url();
    const onWorkSurface = this.isAttachedToWorkSurface(page);
    const riskPage = await this.isRiskPage(page).catch(() => false);
    const riskKind = riskPage ? await this.classifyRiskKind(page).catch(() => undefined) : undefined;
    const rateWarning = await this.isRateWarning(page).catch(() => false);
    const qs = await this.detectQuotaStop!(page).catch(() => null);
    const health = await this.probeSessionHealth(page).catch(() => []);

    const selectors = await countSelectors(page, [
      { name: '结果容器', selector: C.listBox, critical: true },
      { name: '候选人卡片', selector: C.card, critical: true },
      { name: '姓名', selector: C.list.name, critical: true },
      { name: '摘要行（年限/学历/城市）', selector: C.list.detail, critical: false },
      { name: '工作经历', selector: C.list.work, critical: false },
      { name: '教育经历', selector: C.list.edu, critical: false },
      { name: '标签', selector: C.list.tags, critical: false },
      { name: '分页器·下一页', selector: C.pagerNext, critical: true },
      { name: '分页器·当前页', selector: C.pagerCur, critical: false },
      // ★ 2026-08-19 页深持久化：续翻跳页子控件也纳入探针，校准页码项/••• 是否存在
      { name: '分页器·页码项', selector: C.pagerItem || 'li.ant-lpt-pagination-item[title]', critical: false },
      { name: '分页器·后跳•••', selector: C.pagerJumpNext || 'li.ant-lpt-pagination-jump-next', critical: false },
      { name: '分页器·前跳•••', selector: C.pagerJumpPrev || 'li.ant-lpt-pagination-jump-prev', critical: false },
      { name: '搜索按钮', selector: C.searchBtn, critical: true },
      { name: '职位关键词输入框', selector: C.kwInput, critical: true },
      { name: '公司定向输入框', selector: C.compInput, critical: false },
      { name: '筛选 chip', selector: C.filterChips, critical: false },
      { name: '稳定锚 data-resumeidencode', selector: '[data-resumeidencode]', critical: false },
      { name: '稳定锚 data-resumeurl', selector: '[data-resumeurl]', critical: false },
      { name: '详情链接 a[href*=resIdEncode]', selector: 'a[href*="resIdEncode"]', critical: false },
    ]);

    // 用真正的抽取逻辑跑一遍（这才有校准意义 —— 数选择器只能说明"元素在"，
    // 不能说明"我们的解析代码能把它变成候选人"）
    const cards = await this.extractCards(page).catch(() => [] as CandidateProfile[]);
    // ★ 2026-08-18 修复4：domCount 是【原始】元素数（含内层 div 嵌套命中，可能 40/20 虚高），
    //   保留作诊断对照；dedupCount 是去重后真实卡片数（applySearch/goNextPage 用这个）。
    const domCount = await page.evaluate((sel: string) => {
      try { return document.querySelectorAll(sel).length; } catch { return -1; }
    }, C.card).catch(() => -1);
    const dedupCount = await countCards(page, C);

    const withSourceId = cards.filter((c) => !!c.liepinMeta?.resIdEncode).length;
    const withName = cards.filter((c) => !!c.name).length;
    const samples = cards.slice(0, 5).map((c) => {
      const rid = c.liepinMeta?.resIdEncode || '';
      return {
        name: maskName(c.name),
        hasSourceId: !!rid,
        sourceIdPreview: rid ? `${rid.slice(0, 6)}…（${rid.length} 字符）` : '（未取到）',
        company: c.company || '—',
        position: c.position || '—',
        city: c.city || '—',
        degree: c.degree || '—',
        years: c.experienceYears ? `${c.experienceYears}年` : '—',
        active: c.active || '—',
        textLen: (c.liepinMeta?.cardText || '').length,
      };
    });

    // ── 结论：给出"能不能开跑 / 下一步做什么"的直给判断 ──
    const verdict: string[] = [];
    const criticalMiss = selectors.filter((s) => s.critical && s.count <= 0);

    if (!onWorkSurface) {
      verdict.push('❌ 当前不在猎聘招聘端搜索页。请在猎聘浏览器里进入 lpt.liepin.com/search 后重跑探针。');
    }
    if (riskPage) {
      verdict.push(`❌ 当前页面被判定为风控页（${riskKind}）。请先在浏览器里手动处理（完成验证/重新登录），再重跑。`);
    }
    if (qs) {
      verdict.push(`⚠️ 检测到平台配额提示（${qs}）。这不是风控，但今天已无法再看简历（阶段B 会自动跳过）。`);
    }
    if (rateWarning) {
      verdict.push('⚠️ 页面出现"访问过于频繁"提示。建议先手动正常浏览一会儿，等提示消失再开跑。');
    }
    if (health.includes('securityJsFail')) {
      verdict.push('⚠️ 页面已渲染出卡片但 window.__lp_cf 未定义 —— 猎聘安全 JS 未正常加载，建议刷新页面后重跑。');
    }
    if (health.includes('cookieMutation')) {
      verdict.push('⚠️ 会话 Cookie（__gc_id / XSRF-TOKEN）缺失，可能未真正登录或会话已过期。');
    }

    if (criticalMiss.length) {
      verdict.push(`❌ ${criticalMiss.length} 条关键选择器命中 0：${criticalMiss.map((s) => s.name).join('、')}。`);
      verdict.push('   → 猎聘可能已改版。请 F12 抓一下真实类名，在「设置 → 浏览器 → 猎聘选择器校准」粘贴 JSON 覆盖后重跑（无需重新打包）。');
      verdict.push('   ⚠️ 注意：探针本身不打开 DevTools，但【正式开跑时必须关掉 F12】—— 猎聘会检测 DevTools。');
    }

    if (domCount > 0 && cards.length === 0) {
      verdict.push(`❌ 页面有 ${domCount} 张卡片元素，但解析出 0 位候选人 —— 是解析逻辑失效，不是没数据。优先看「姓名」与稳定锚两项。`);
    } else if (cards.length > 0) {
      const idRate = Math.round((withSourceId / cards.length) * 100);
      // ★ 2026-08-18 修复4：同时显示原始 DOM 数与去重后真实卡片数，让「40/20 虚高」一眼可见。
      verdict.push(`✅ 解析出 ${cards.length} 位候选人（DOM 元素 ${domCount} 个 / 去重后 ${dedupCount} 张卡片）。`);
      if (idRate === 100) {
        verdict.push('✅ 稳定锚 resIdEncode 提取率 100% —— 去重、跨运行去重、会话重放都能正常工作。');
      } else {
        verdict.push(`❌ 稳定锚提取率仅 ${idRate}%（${withSourceId}/${cards.length}）。缺锚的人无法去重、无法回访，会被反复重抓。`);
        verdict.push('   → 这是四级兜底链全部落空，务必先解决再开跑，否则配额会被重复抓取白白吃掉。');
      }
      const avgLen = Math.round(samples.reduce((a, s) => a + s.textLen, 0) / Math.max(1, samples.length));
      if (avgLen < 40) {
        verdict.push(`⚠️ 卡片全文平均仅 ${avgLen} 字符，偏短 —— 评分词表输入不足，匹配分会普遍偏低。检查卡片选择器是否选到了内层小节点。`);
      }
    } else if (domCount === 0) {
      verdict.push('⚠️ 页面上没有候选人卡片。若你还没执行过搜索，这是正常的 —— 先在页面上手动搜一次再重跑探针。');
    }

    if (!criticalMiss.length && cards.length > 0 && withSourceId === cards.length && !riskPage && onWorkSurface) {
      verdict.push('');
      verdict.push('🟢 具备开跑条件。建议第一次只填 1 条关键词、safe 档、跑 10 分钟观察日志。');
    }

    notes.push('本探针为只读：未点击、未导航、未写库、未打开任何简历详情，不消耗套餐额度。');

    return {
      ok: !criticalMiss.length && !riskPage && onWorkSurface && cards.length > 0 && withSourceId === cards.length,
      url,
      onWorkSurface,
      riskPage,
      riskKind,
      rateWarning,
      quotaStop: qs || undefined,
      health: health as string[],
      selectors,
      cards: { parsed: cards.length, domCount, dedupCount, withSourceId, withName, samples },
      verdict: [...verdict, ...notes],
    };
  },

  async listMetrics(page: Page): Promise<Record<string, number>> {
    const C = cfg();
    try {
      return await page.evaluate((S: LiepinCfg) => {
        const curEl = document.querySelector(S.pagerCur);
        const cur = curEl ? parseInt((curEl.textContent || '0').trim(), 10) || 0 : 0;
        // T4 修正：用独立于 extractCards 的计数方式（data-resumeidencode 稳定锚）。
        // 原实现用同一个 C.card 选择器 → 选择器一坏两个数同时为 0 →
        // 引擎落进"真空"分支 → 连续 3 次触发 emptyData 熔断并记 danger。
        // 独立计数保证"选择器坏"和"真没数据"能被区分。
        const byRid = document.querySelectorAll('[data-resumeidencode]').length;
        // 兜底：resumeListBox 直接子 li 节点数
        const listBox = document.querySelector(S.listBox);
        const byListBox = listBox ? listBox.querySelectorAll('li').length : 0;
        return {
          // ★ 2026-08-18 修复4：cards 是原始元素数（含内层 div 嵌套命中，可能 40/20 虚高）；
          //   cardsByRid 才是去重后真实卡片数（applySearch/goNextPage/extractCards 用这个口径）。
          cards: document.querySelectorAll(S.card).length, // 原始元素数（诊断对照）
          cardsByRid: byRid,                                // 去重后真实卡片数（稳定锚计数）
          cardsByList: byListBox,                            // 独立计数 2：容器直子节点
          currentPage: cur,
          top: Math.round((document.scrollingElement || document.documentElement).scrollTop || 0),
          height: Math.round((document.scrollingElement || document.documentElement).scrollHeight || 0),
        };
      }, C);
    } catch {
      return { cards: -1, cardsByRid: -1, cardsByList: -1, currentPage: -1, top: -1, height: -1 };
    }
  },

  /**
   * 猎聘人才池落库（BOSS 不实现此钩子 → 行为完全不变）。
   *
   * 与 BOSS 最大的不同：BOSS 一次任务只对当前激活的那个岗位评分，
   * 而猎聘是"广撒网捞人"——同一个人对不同岗位的匹配度天差地别，
   * 只存一个分等于逼 TA 每换一个岗位就重跑一遍 RPA。故一次抓取、全岗位评分。
   *
   * 评分用的是【列表级】字段（零额度消耗），足够把明显不合适的人挡在 60 分以下；
   * 阶段B 开过详情的人会带 depth='B' 覆盖重评，分数更准。
   */
  onCandidateSaved(c: CandidateProfile, jds: JD[]): void {
    const resId = String(c.sourceId || c.liepinMeta?.resIdEncode || '').trim();
    // 没有稳定锚就不入库：拿不到 resIdEncode 就拼不出链接，
    // 存进去也是条打不开的死记录，还会污染去重键。
    if (!resId) return;
    // ★ 2026-08-18 产量重构·修复5：跨轮持久去重——upsertLiepinTalentIfNew 与 upsertLiepinTalent
    //   同口径入库，但返回【是否本次新增】。已存在的人只刷新 last_seen/keep_until（不覆盖
    //   结构化字段与 archived/note/detail_at）。回写 isNew 供引擎计「本轮新增(去重后)」。
    const isNew = upsertLiepinTalentIfNew({
      res_id: resId,
      name: c.name || undefined,
      position: c.position || undefined,
      company: c.company || undefined,
      city: c.city || undefined,
      experience: c.experienceYears ? `${c.experienceYears}年` : undefined,
      degree: c.degree || undefined,
      salary: c.salary || undefined,
      active_status: c.active || undefined,
      source_keyword: c.liepinMeta?.sourceKeyword || undefined,
    });
    c.liepinMeta = { ...(c.liepinMeta || {}), isNew };
    c.justStoredNew = isNew; // 平台无关信号，引擎据此计「本轮新增(去重后)」
    const depth: 'A' | 'B' = c.depth === 'B' ? 'B' : 'A';
    for (const jd of jds) {
      if (!jd?.id) continue;
      let s: ScoreResult | null = null;
      // ★ 必须按 depth 显式传 tier：A=列表卡片、B=详情。此前不传，引擎自动判定会因为
      //   卡片恒带 education 而误判成 detail，使卡片层封顶与「卡片不得评 high」两条安全线失效。
      try { s = scoreCandidate(c, jd, depth === 'B' ? 'detail' : 'card'); } catch { continue; }
      if (!s) continue;
      const verdict = s.cardVerdict ?? null;
      const verdictLabel = s.cardVerdictLabel ?? null;
      upsertLiepinScore(resId, jd.id, s.total, s.level, {
        coverage: s.coverage ?? null,
        lowConfidence: s.lowConfidence ?? null,
        mismatch: s.mismatchReasons ?? null,
        missing: s.missingDimensions ?? null,
        // 卡片层三档判定（2026-08-11）：人才池 UI 在 depth=A 时应显示它而非数字分——
        // 卡片层的数字没有区分度（实测理想候选人与空卡片同为 85）。
        cardVerdict: verdict ?? null,
        cardVerdictLabel: verdictLabel ?? null,
      }, depth, s.insufficientEvidence ?? false);
      // P1-19：打标阈值改用设置里的「较低匹配阈值」，不硬编码 60；
      // 同时证据不足被托底的人不打标——total 恰好 = loLine（默认 60）的人实为「没看清」,
      // 不是「确实匹配」，全岗位打标会让下游无从分辨，排序反而倒置。
      const ms = getSetting<any>('app-settings', null)?.matchScore;
      const loTh = (ms?.lowThreshold != null && Number.isFinite(Number(ms.lowThreshold)))
        ? Number(ms.lowThreshold) : 60;
      // 卡片层（depth=A）改用三档判定打标：只有「值得看」才打，「一般」不打。
      // 理由同上——卡片层 total 全顶在 85，按分数阈值打标等于给所有人打标。
      const worthTagging = verdict ? verdict === 'worth' : (s.total >= loTh);
      if (worthTagging && !s.insufficientEvidence) addLiepinTag(resId, jd.name || jd.id, 'auto-jd');
    }
  },

  /** 详情【即将打开】时记账。平台是打开即扣、抽取失败也不退钱，所以必须记在动作之前。 */
  onDetailOpened(c: CandidateProfile): void {
    const resId = String(c.sourceId || c.liepinMeta?.resIdEncode || '').trim();
    if (resId) markLiepinDetailOpened(resId);
  },
};

// ---------- 内部辅助 ----------
async function firstCardKey(page: Page, cardSel: string): Promise<string> {
  try {
    return await page.evaluate((sel: string) => {
      const c = document.querySelector(sel);
      if (!c) return '';
      const rid = c.getAttribute('data-resumeidencode')
        || c.closest('li')?.getAttribute('data-resumeidencode') || '';
      return rid || (c.textContent || '').slice(0, 80);
    }, cardSel);
  } catch {
    return '';
  }
}

/** 等待任一选择器出现 */
async function waitForAny(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) return true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 按可见文本点选选项（lpt 搜索页多数筛选项直出可见）。
 * 命中后校验筛选 chip 是否出现该文本（原方案 _verify_filter_applied 的等价实现）——
 * 只"点了"不算生效，必须看到条件被应用，否则会搜出大量无关卡片（无谓消耗风险预算）。
 *
 * ⚠️ T3 收敛：限定在筛选面板子树内搜索，排除候选人卡片区域。
 * 原实现扫全页 li/span/div/a/label → 候选人卡片的城市文本（如"上海-浦东新区"11字符）
 * 会被 includes 命中 → 点中卡片 = 打开简历详情 = 扣真实额度且不进任何配额计数。
 *   ① 候选人卡片 li[data-resumeidencode] 子树内所有元素一律排除；
 *   ② 优先在筛选栏容器（data-selector 含 'filter'/'search'/'condition'）内找；
 *   ③ 回退到 body 但排除卡片区。
 */
/**
 * 点选一个筛选项（经验/学历/行业…）。
 *
 * ⛔⛔ 2026-08-13 真机第三次踩同一个坑：本函数原来在 page.evaluate 里用
 *   `(n as HTMLElement).click()` —— 【程序化点击在这个页面上无效】。
 *   lpt 是 React + ant-design，筛选项是 <label>，React 的事件处理挂在合成事件系统上，
 *   DOM 的 .click() 不会触发它。表现就是「筛选未生效 experience=5-10年」。
 *   同一个根因此前已在两处踩过：
 *     · 主搜索框（JS 置 value 不触发 onChange，必须真实键入）
 *     · 城市「其他」（label.click() 打不开城市面板）
 *   处置：evaluate 只负责【定位】并返回元素句柄，点击交给 HumanOperator
 *   （CDP Input.dispatchMouseEvent 真实鼠标事件），与搜索按钮/输入框同一套机制。
 *
 * 这条对产量是决定性的：经验/学历是 applySearch 时落地的【筛选项】（pickOptionByText），
 *   必须点上才算真正把筛选条件喂给平台——点不上 = 搜索退化成不带筛选的裸搜。
 *   （注：经验/学历已不再做笛卡尔积切分轴——真机证实分页器共 100 页、单广搜可翻 2000 人，
 *   原「单查询只吃前 ~100 人」前提不成立；产量靠深翻，不靠切窄组合。）
 */
/**
 * 关掉关键词输入后弹出的联想下拉（2026-08-18 修复1 · 真机实测根因）。
 *
 * ⛔⛔ 2026-08-18 真机 c-in-c 实测定案：输入职位关键词后弹出的联想词下拉
 *   会【完全盖住】经验/学历筛选行。adapter 此前用 page.keyboard.press('Escape')
 *   关下拉 —— 【对猎聘无效，下拉不关】。后果：输入关键词后再点筛选，第一击被下拉
 *   吞掉，经验静默停在「不限」= FILTER_FAILED，整条切分轴失效、翻页空转。
 *   实测【点页面中性空白区能关下拉，且保留已输入关键词】；Escape 不行。
 *
 * 重排后的 applySearch 已把筛选【前移到关键词输入之前】（此时无下拉，筛选点击
 *   不会被吞）。本函数只在【输入关键词之后、点搜索之前】调用一次，关掉联想下拉
 *   让搜索按钮点得动。
 *
 * 中性点击目标（按元素定位，不裸坐标；真机实测空态区 (700,555) 就是这么关掉的）：
 *   ① 主路径：结果区空态元素 —— 含 emptySentinel（「请设置搜索条件进行搜索」）的
 *      元素。它在下拉下沿之下、非交互文本，空态时必关下拉且不误触。
 *   ② 回退路径：筛选行最左侧的 label 文字单元格（如「经 验」「教育经历」）——
 *      含该文字的 label 元素，位于下拉左边界之外、非交互、空态/结果态恒在。
 *      （第 2 个搜索组合起页面已是结果态、空态元素消失，必须走这条。）
 *   ⛔ 绝不点筛选面板根容器几何中心 —— 会压在某个筛选项上，把点击喂给筛选/下拉。
 *
 * 安全闸：定位元素时排除 button/a/[role=button]、卡片子树（isInsideCard）、
 *   筛选项本身（带 active/selected 类的 label），确保绝不点到「立即沟通/超级聊聊/
 *   搜索按钮/筛选项」。点击走 op.clickElement（CDP 真实鼠标事件 + 曲线移动 + dwell）。
 * Escape 保留作最后兜底，但不可依赖（猎聘对它无效）。
 */
async function dismissSuggestDropdown(page: Page, op: HumanOperator, C: LiepinCfg): Promise<void> {
  // 候选中性目标：① 含空态哨兵的元素 ② 筛选行 label 文字单元格。
  // 浏览器端定位：返回元素句柄（点击交给 CDP，绝不在 evaluate 里 .click()）。
  const neutralHandle = await page.evaluateHandle((args: {
    emptySentinel: string; listBox: string;
  }): Element | null => {
    const norm = (s: string) => (s || '').replace(/\s+/g, '').trim();
    const visible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = window.getComputedStyle(el as HTMLElement);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      return true;
    };
    // 安全闸：绝不让中性点击落到会触发动作的元素上。
    const isInteractive = (el: Element): boolean => {
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'button' || tag === 'a') return true;
      if (el.getAttribute('role') === 'button') return true;
      // 候选人卡片子树（含「立即沟通」「超级聊聊」）一律排除
      if (el.closest('li[data-resumeidencode]') || el.closest("[class*='resumeCard']")) return true;
      // 排除已选中的筛选项（带 active/selected 类的）——点它会切换筛选状态
      let n: Element | null = el;
      for (let i = 0; i < 3 && n; i++) {
        const cls = (n.getAttribute('class') || '').toLowerCase();
        if (/(^|\s)(active|selected)/.test(cls) || cls.includes('active--') || cls.includes('item-active')) return true;
        n = n.parentElement;
      }
      return false;
    };
    const directText = (el: Element): string =>
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || '')
        .join('').replace(/\s+/g, '').trim();

    // ① 主路径：含空态哨兵的元素（「请设置搜索条件进行搜索」）
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      if (!visible(el) || isInteractive(el)) continue;
      const dt = directText(el);
      if (dt && dt.includes(args.emptySentinel)) return el;
    }
    // ② 回退路径：筛选行 label 文字单元格（「经 验」「教育经历」「目前城市」「行业」…）
    //   这些行标题 label 位于下拉左边界之外、非交互、空态/结果态恒在。
    const rowTitles = ['经验', '经 验', '教育经历', '目前城市', '期望城市', '行业', '职 位'];
    for (const el of all) {
      if (!visible(el) || isInteractive(el)) continue;
      const dt = directText(el);
      if (!dt || dt.length > 8) continue;
      if (rowTitles.some((t) => norm(dt) === norm(t))) return el;
    }
    return null;
  }, { emptySentinel: C.emptySentinel, listBox: C.listBox }).catch(() => null);
  const neutralEl = neutralHandle && neutralHandle.asElement ? neutralHandle.asElement() : null;
  if (neutralEl) {
    try { await op.clickElement(neutralEl); } catch { /* 点击失败走下面 Escape 兜底 */ }
    await op.smallWait();
  }
  // Escape 兜底（猎聘对它无效，但别的浮层/气泡可能被它关掉，保留不依赖）
  try { await page.keyboard.press('Escape'); } catch { /* 关不掉也继续，下面提交处有重试兜底 */ }
  await op.smallWait();
}

/**
 * 搜索提交后读取结果区【已应用筛选标签】，校验本组合设定的筛选是否真生效
 * （2026-08-18 修复2 · 权威哨兵）。
 *
 * 真机实测（金丽丽登录态）：先设「经验1-3年+学历硕士」再点搜索 → 结果区出现
 *   已应用标签「硕士 ×」「1-3年 ×」+「共有161份简历」+结果正确。这些标签是
 *   「筛选真生效」的权威信号，比只看首卡 key 变化可靠得多（首卡变可能是上一个
 *   组合的残留结果在重渲染）。
 *
 * 无真机 DOM 校准结果区标签选择器，故写成【零命中探针】：
 *   命中≥1 个标签 → 逐项校验 experience/degree/city 是否出现在标签文本里；
 *   零命中（选择器漂移）→ 返回 'unknown'（调用方记 FILTER_FAILED_TAGCHECK，不静默）。
 *
 * @returns 'ok' 全部设定项都出现在标签里；
 *          'missing' 至少一项设定项缺失（筛选未真生效）；
 *          'unknown' 标签选择器零命中（结构漂移，待真机校准）。
 */
async function verifyAppliedFilterTags(
  page: Page, C: LiepinCfg, q: SearchQuery,
): Promise<'ok' | 'missing' | 'unknown'> {
  // 结果区已应用标签候选选择器（无真机 DOM，写宽松 + 零命中探针）：
  //   猎聘标签形态「硕士 ×」「1-3年 ×」，常见容器 ant-tag / condition / filter tag 系列。
  const TAG_SEL = [
    '.ant-tag', '.ant-lpt-tag',
    "[class*='conditionItem']", "[class*='condition-item']",
    "[class*='filterTag']", "[class*='filter-tag']",
    "[class*='selectedCondition']", "[class*='selected-condition']",
    "[class*='appliedFilter']", "[class*='applied-filter']",
  ].join(', ');
  try {
    const result = await page.evaluate((args: { tagSel: string; emptySentinel: string }) => {
      const norm = (s: string) => (s || '').replace(/\s+/g, '').trim();
      const tags = Array.from(document.querySelectorAll(args.tagSel))
        .map((t) => norm(t.textContent || ''))
        .filter(Boolean);
      // 排除把空态文案当标签的情况
      const filtered = tags.filter((t) => !t.includes(args.emptySentinel));
      return { tagTexts: filtered.slice(0, 40), count: filtered.length };
    }, { tagSel: TAG_SEL, emptySentinel: C.emptySentinel }).catch(() => ({ tagTexts: [], count: 0 }));
    if (!result.count) return 'unknown'; // 零命中 = 选择器漂移，不静默
    // 断言本组合设定的项都出现在标签里（标签文本通常形如「硕士 ×」「1-3年 ×」「武汉 ×」，
    //   用 includes 匹配设定值即可——「硕士」会命中「硕士 ×」）。
    const checks: Array<[string, string | undefined]> = [
      ['experience', q.experience], ['degree', q.degree], ['city', q.city], ['industry', q.industry],
    ];
    const missing: string[] = [];
    for (const [name, val] of checks) {
      if (!val) continue;
      // 设定值归一化（去掉空格）后做 includes；标签文本可能带「×」「✕」或「删除」图标文字
      const v = val.replace(/\s+/g, '').trim();
      const hit = result.tagTexts.some((t) => t.includes(v));
      if (!hit) missing.push(`${name}=${val}`);
    }
    return missing.length ? 'missing' : 'ok';
  } catch {
    return 'unknown';
  }
}

/**
 * 去重后卡片数（2026-08-18 修复4）。
 * C.card 是逗号 OR 选择器，querySelectorAll 会把内层 div[data-tlg-elem-id] 与外层 li
 *   各算一个 → 20 卡返 40。本函数按 data-resumeidencode 去重，返回与 extractCards
 *   同口径的真实卡片数，替换所有裸 $$eval(C.card, els=>els.length) 计数点。
 */
async function countCards(page: Page, C: LiepinCfg): Promise<number> {
  try {
    return await page.evaluate((sel: string) => {
      const all = Array.from(document.querySelectorAll(sel));
      const rids = new Set<string>();
      let withRid = 0;
      for (const el of all) {
        const rid = (el.getAttribute('data-resumeidencode') || '').trim()
          || el.closest('li')?.getAttribute('data-resumeidencode') || '';
        if (rid) { rids.add(rid); withRid++; }
      }
      // 有 resIdEncode 时按 rid 去重；全部没有（选择器命中但无锚）时回退元素数
      return withRid > 0 ? rids.size : all.length;
    }, C.card).catch(() => 0);
  } catch {
    return 0;
  }
}

/**
 * 把筛选行重置回「不限」，清掉上一个搜索组合的残留选择。
 *
 * 为什么必须有这一步（2026-08-13 真机）：猎聘的【教育经历行是多选】——
 * 点「硕士」不替换「本科」而是累加。不重置的话，第 N 个组合实际是前 N 个组合的
 * 并集，返回的永远是同一批相关度最高的人，切分轴完全失效（连续 0 新人）。
 *
 * 实现取「点该行的『不限』」而不是「点顶部的清除全部」：后者会把关键词和职位/公司
 * 定向一起清掉，而那些是本组合刚设好的，清了要重设，多一次交互多一分出错面。
 * 只有【本轮会用到的行】才重置——没配的行本来就是「不限」，不该去碰它（多点一次
 * 就是多一次可能被计入行为特征的交互）。
 *
 * ★ 2026-08-18 修复1/修复3：resetFilterRows 必须在【关键词输入之前】执行（applySearch
 *   重排后已是此序）。此时无联想下拉，reset 的清除点击不会被下拉吞掉。学历多选累积
 *   问题随此顺序一并解决（reset 在筛选应用之前，清掉上一组合残留）。
 */
/**
 * 断言筛选面板已【展开】（2026-08-18 修复A · 折叠面板根因）。
 *
 * 真机实测（金丽丽登录态）：搜索出结果后筛选面板会【折叠】——经验/学历可点选项
 *   从 DOM 消失，出现 <a class="toTop--<hash>">「更改条件」</a> + selectedTag--<hash>
 *   标签容器。折叠态下经验/学历【行标题及其容器都不在 DOM 里】。
 *   而空态 bare /search 面板恒展开，经验行容器（含「不限」）可定位。
 *
 * 故「面板是否展开」=「经验行容器是否可定位」——折叠时 locateRowContainer('经验')
 *   返回 null（行标题不在 DOM），展开时返回该行容器。
 *   双判据互为冗余：① 经验行容器可定位；② 不存在「更改条件」折叠态 <a>（class 含 toTop--）。
 *
 * @returns true 面板已展开（筛选项可点）；false 面板折叠（筛选项已从 DOM 消失）。
 */
async function isFilterPanelExpanded(page: Page): Promise<boolean> {
  try {
    // ① 经验行容器可定位 → 面板展开（折叠时经验/学历行标题及选项从 DOM 消失）
    const rowHandle = await page.evaluateHandle(locateRowContainer, '经验').catch(() => null);
    const rowOk = !!(rowHandle && rowHandle.asElement && rowHandle.asElement());
    // ② 「更改条件」折叠态 <a>（class 含 toTop--）存在 → 面板折叠
    const collapse = await page.$("a[class*='toTop--']").catch(() => null);
    return rowOk && !collapse;
  } catch {
    return false;
  }
}

async function resetFilterRows(page: Page, op: HumanOperator): Promise<void> {
  // ★ 2026-08-17 去 label 化（修复 VIP 版重置失效）。
  //   VIP 版的筛选项不是 <label>，box.querySelectorAll('label') 命中 0 →
  //   dirty 永远 false → 上一组合的学历残留清不掉 → 切分轴失效（多选累加）。
  //   处置：与 pickOptionByText 同一套版本无关逻辑——按【行标题文本】定位行容器，
  //   在容器内按【直接文本】找选项，按【active/selected 类名前缀】判已选态，不依赖标签名。
  //   ★ 2026-08-17 返工：行容器定位复用导出的 locateRowContainer，消除与 pickCityFromOverlay 的重复。
  for (const row of ['经验', '教育经历']) {
    try {
      const boxH = await page.evaluateHandle(locateRowContainer, row).catch(() => null);
      const box = boxH && boxH.asElement ? boxH.asElement() : null;
      if (!box) continue;
      // 在该行容器内，找需要重置的「不限」选项（只在有非「不限」选中项时才点）。
      const target = await page.evaluateHandle((boxEl: Element) => {
        const norm = (s: string) => (s || '').replace(/\s+/g, '').trim();
        const directText = (el: Element): string =>
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent || '')
            .join('').replace(/\s+/g, '').trim();
        const isInsideCard = (el: Element) =>
          !!(el.closest('li[data-resumeidencode]') || el.closest("[class*='resumeCard']"));
        const visible = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const isSelected = (el: Element): boolean => {
          let n: Element | null = el;
          for (let i = 0; i < 3 && n; i++) {
            const cls = (n.getAttribute('class') || '').toLowerCase();
            if (/(^|\s)(active|selected)/.test(cls) || cls.includes('active--') || cls.includes('item-active')) return true;
            n = n.parentElement;
          }
          return false;
        };
        const opts: Element[] = [];
        for (const el of Array.from(boxEl.querySelectorAll('*'))) {
          if (isInsideCard(el)) continue;
          const dt = directText(el);
          if (!dt || dt.length > 12) continue;
          if (!visible(el)) continue;
          opts.push(el);
        }
        // 该行已有非「不限」的选中项时才需要重置；本来就是「不限」就别去点它
        //   （多点一次就是多一次可能被计入行为特征的交互）。
        const dirty = opts.some((x) => isSelected(x) && norm(directText(x)) !== '不限');
        if (!dirty) return null;
        return opts.find((x) => norm(directText(x)) === '不限') || null;
      }, box);
      const el = target.asElement() as ElementHandle | null;
      if (!el) continue;
      try { await op.clickElement(el); } catch { try { await el.click(); } catch { /* ignore */ } }
      await op.smallWait();
    } catch { /* 重置失败不阻断，后面的选中校验会兜底报出来 */ }
  }
}

/**
 * 按直接文本定位筛选项（浏览器端纯函数，修复1 · 2026-08-17）。
 * pickOptionByText 的定位逻辑抽出成具名导出，供 adapter-lab 合成 DOM 单测直接验证。
 * 不依赖任何 class/标签名：在 root 子树内找【直接文本 === 目标值】的可见非卡片元素，
 * 精确匹配优先、包含匹配兜底，返回命中的元素（最内层）。点击由外层 CDP 真实鼠标事件负责。
 *
 * ★ 2026-08-17 返工：root 参数（默认 document.body）。
 *   城市弹层点击时传弹层容器为 root，真正把搜索限定在弹层内而非全文档——
 *   原实现 overlaySel 算了却没用（全文档扫描），弹层外的同名城市文本会被误命中。
 */
export function locateOptionByText(text: string, root?: Element | null): Element | null {
  const scope: Element = root || document.body;
  // 候选人卡片排除标记（安全闸门，最高优先级）：
  //   ① li[data-resumeidencode] 子树 —— 老结构
  //   ② [class*="resumeCard"] 子树 —— VIP/新版卡片容器
  //   绝不允许命中卡片内的「立即沟通/超级聊聊」（对真实候选人发消息、不可撤回）。
  const isInsideCard = (el: Element): boolean =>
    !!(el.closest('li[data-resumeidencode]') || el.closest("[class*='resumeCard']"));
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el as HTMLElement);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const pt = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!pt && (pt === el || (el as HTMLElement).contains(pt));
  };
  const directText = (el: Element): string =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 /* Node.TEXT_NODE */)
      .map((n) => n.textContent || '')
      .join('')
      .replace(/\s+/g, "")
      .trim();
  // 已选态判定留在 pickOptionByText 外层（locateOptionByText 只负责定位，不判已选）。
  const all = Array.from(scope.querySelectorAll('*'));
  const candidates: Element[] = [];
  for (const el of all) {
    if (isInsideCard(el)) continue;
    const dt = directText(el);
    if (!dt || dt.length > 24) continue;
    if (!visible(el)) continue;
    candidates.push(el);
  }
  const norm = (s: string) => s.replace(/\s+/g, '').trim();
  const target = norm(text);
  for (const pass of [0, 1]) {
    for (const el of candidates) {
      const dt = norm(directText(el));
      const ok = pass === 0 ? dt === target : dt.includes(target);
      if (!ok) continue;
      // 已是选中态也返回它（外层据此跳过点击，重复点 = 取消选择）
      return el;
    }
  }
  return null;
}

/**
 * 按行标题文本定位【筛选行容器】（浏览器端纯函数，2026-08-17 返工抽出）。
 * resetFilterRows 与 pickCityFromOverlay 都需要「先定位到某一行，再在该行内操作」——
 * 原来这套「按行标题文本找小元素 → 向上找含『不限』的最近祖先作行容器」逻辑内联在
 * resetFilterRows 里，无法复用。抽出为具名导出：
 *   - resetFilterRows 用它定位经验/教育经历行容器；
 *   - pickCityFromOverlay 用它定位【城市行容器】作 root，在该行内点「其他」——
 *     避免全文档取首个「其他」时误点经验/学历行的「其他」（返工缺陷2）。
 * 行标题文本恰为 rowName 的小元素（与探针 _probe-vip-filter.mjs 同口径）。
 */
export function locateRowContainer(rowName: string): Element | null {
  const norm = (s: string) => (s || '').replace(/\s+/g, '').trim();
  const directText = (el: Element): string =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent || '')
      .join('').replace(/\s+/g, '').trim();
  const isInsideCard = (el: Element): boolean =>
    !!(el.closest('li[data-resumeidencode]') || el.closest("[class*='resumeCard']"));
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = Array.from(document.querySelectorAll('*'));
  const title = all.find((e) => norm(e.textContent) === rowName && (e.children.length <= 1) && visible(e) && !isInsideCard(e));
  if (!title) return null;
  // 向上找容器：含「不限」的最近祖先。
  let box: Element | null = title, hops = 0, found = false;
  while (box && hops < 8) {
    box = box.parentElement; hops++;
    if (box && (box.textContent || '').includes('不限')) { found = true; break; }
  }
  if (!found || !box) return null;
  return box;
}

async function pickOptionByText(page: Page, op: HumanOperator, value: string, root?: ElementHandle): Promise<boolean> {
  const C = cfg();
  try {
    // ★ 2026-08-17 版本无关文本匹配（修复 VIP 版选择器失效）。
    //   VIP 测试账号是【不同前端构建】：经验行外层 wrap--XzY0Z→wrap--wiaLZ，
    //   「1-3年」不再是独立 <label>，而是嵌在 <div>/<span> 里的文本节点。
    //   原实现优先匹配 `label[class*='FilterItem']` 与 `label` 标签名 ——
    //   VIP 版既没有 label 也没有 FilterItem 类，整段恒定落空，经验/学历永远点不上。
    //   处置：放弃一切 class/标签名依赖，改为「在 root 子树内找【直接文本 === 目标值】的
    //   最内层可见非卡片元素」，精确匹配优先、包含匹配兜底；用 CDP 真实鼠标点其几何中心
    //   （靠事件冒泡触发 React 合成事件，与标签名无关）。
    //   ⚠️ 必须「直接文本」而非 textContent：点「本科」不能命中包着「本科·硕士」的父元素
    //   （那会点错一整行）。直接文本取【元素自身的文本子节点】，不含子孙节点文字。
    //   ★ 2026-08-17 返工：root 参数把搜索限定在指定容器内（如城市行 / 弹层），
    //     避免全文档取首个命中时跨行/跨区域误点。
    const handle = await page.evaluateHandle(locateOptionByText, value, root || null);
    const el = handle.asElement() as ElementHandle | null;
    if (!el) return false;
    // 已经是选中态就别再点（重复点 = 取消选择）。判定复用浏览器内同一逻辑。
    const already = await el.evaluate((n: Element) => {
      let cur: Element | null = n;
      for (let i = 0; i < 3 && cur; i++) {
        const cls = (cur.getAttribute('class') || '').toLowerCase();
        if (/(^|\s)(active|selected)/.test(cls) || cls.includes('active--') || cls.includes('item-active')) return true;
        cur = cur.parentElement;
      }
      return false;
    }).catch(() => false);
    if (already) return true;
    // ★ 真实鼠标事件（CDP Input.dispatchMouseEvent），点几何中心，不是 DOM 的 .click()
    try {
      await op.clickElement(el);
    } catch {
      try { await el.click(); } catch { return false; }
    }
    await new Promise((r) => setTimeout(r, 600));
    // 校验生效：filterChips 覆盖三套选中态命名规范（见 cfg().filterChips 注释）
    return await page.evaluate((args: { chipSel: string; text: string }) => {
      const chips = Array.from(document.querySelectorAll(args.chipSel));
      return chips.some((c) => (c.textContent || '').includes(args.text));
    }, { chipSel: C.filterChips, text: value }).catch(() => false);
  } catch {
    return false;
  }
}

/**
 * 城市筛选「其他」弹层路径（修复2 · 2026-08-17）。
 * 猎聘「目前城市」行内只有『不限|其他』，武汉/上海这类任意城市藏在「其他」后的弹层里。
 * applySearch 行内点不到城市时，调用本函数：点『其他』展开 → 在弹层内按文本匹配点目标城市。
 *
 * ⚠️ 因无真机 DOM，弹层容器选择器写成【宽松 + 零命中探针】：
 *   命中目标城市 → 返回 true；弹层里【没有】目标城市 → 记诊断码 CITY_OVERLAY_NO_MATCH
 *   并 console.warn（【绝不静默跳过】，真机一跑即暴露选择器漂移）。
 *   弹层根本没展开（『其他』也没点上）→ 记 CITY_OVERLAY_NOT_OPENED。
 * 安全：弹层内点击复用 pickOptionByText 的同一套文本匹配 + 卡片排除闸门，绝不命中候选人卡片。
 */
async function pickCityFromOverlay(page: Page, op: HumanOperator, city: string): Promise<boolean> {
  // 弹层容器选择器（无真机 DOM 探针）：overlay/popover/modal/popup/panel/city 系列。
  const OVERLAY_SEL = [
    "[class*='overlay']", "[class*='popover']", "[class*='modal']",
    "[class*='popup']", "[class*='panel']", "[class*='cityPicker']", "[class*='city-picker']",
  ].join(', ');
  try {
    // ① 定位【城市行容器】作 root，在该行内点『其他』展开弹层。
    //   ★ 2026-08-17 返工缺陷2：原实现 pickOptionByText(page, op, '其他') 全文档取首个——
    //     若经验/学历行也有『其他』，会点错行、展开错误的弹层。
    //     处置：复用 locateRowContainer 定位城市行容器，作 root 限定「其他」点击在城市行内。
    //     城市行标题可能是「目前城市」或「期望城市」（见 cfg 注释），两个都尝试。
    let cityRowEl: ElementHandle | null = null;
    let cityRowTitle = '';
    for (const rowName of ['目前城市', '期望城市']) {
      const h = await page.evaluateHandle(locateRowContainer, rowName).catch(() => null);
      const el = h && h.asElement ? h.asElement() : null;
      if (el) { cityRowEl = el; cityRowTitle = rowName; break; }
    }
    if (!cityRowEl) {
      console.warn(`[liepin][diagnostic] CITY_OVERLAY_NO_CITY_ROW: 未定位到城市行容器（city=${city}）——待真机验证城市行标题文本是否为「目前城市」/「期望城市」`);
      // ★ 监控：城市行定位失败 —— 采整页骨架，离线核对城市行标题真实文本。
      await dumpSkeleton(page, 'CITY_OVERLAY_NO_CITY_ROW').catch(() => {});
      return false;
    }
    // ② 在城市行容器内点『其他』（root=cityRowEl，严格限定该行，不碰经验/学历行的「其他」）。
    const opened = await pickOptionByText(page, op, '其他', cityRowEl);
    if (!opened) {
      console.warn(`[liepin][diagnostic] CITY_OVERLAY_NOT_OPENED: 城市行内未找到「其他」入口，弹层无法展开（city=${city}, row=${cityRowTitle}）`);
      // ★ 监控：「其他」入口定位失败 —— 采城市行附近骨架，离线核对入口真实形态。
      await dumpSkeleton(page, 'CITY_OVERLAY_NOT_OPENED').catch(() => {});
      return false;
    }
    // ③ 等弹层渲染（无真机 DOM，给宽裕 800ms；真机若不够可调，但别 0）。
    await new Promise((r) => setTimeout(r, 800));
    // ★ 监控调用点②：pickCityFromOverlay 点完「其他」+等待后 → tag='city-overlay'。
    //   弹层此时应已展开，骨架能直接反映弹层容器/城市项的真实结构 —— 这是定位弹层
    //   选择器漂移与城市别名的主证据。只观测：不改后续控制流。
    await dumpSkeleton(page, 'city-overlay').catch(() => {});
    // ④ 定位弹层容器作 root，在弹层内按文本匹配点目标城市。
    //   ★ 2026-08-17 返工缺陷1：原实现 overlaySel 算了却没用（pickOptionByText 全文档扫描），
    //     弹层外的同名城市文本会被误命中。处置：先用 overlaySel 定位弹层容器，
    //     作 root 传给 pickOptionByText，真正把搜索限定在弹层内。
    //   弹层容器必须存在才往下走——绝不回退全文档（回退就是原缺陷）。0 命中记诊断码。
    const overlayH = await page.evaluateHandle((sel: string) => {
      const norm = (s: string) => (s || '').replace(/\s+/g, '').trim();
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = window.getComputedStyle(el as HTMLElement);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
      };
      const isInsideCard = (el: Element): boolean =>
        !!(el.closest('li[data-resumeidencode]') || el.closest("[class*='resumeCard']"));
      // 选可见、不在卡片内、且文本最长的候选（弹层通常比同名小碎片文本更长）。
      const cands = Array.from(document.querySelectorAll(sel))
        .filter((e) => visible(e) && !isInsideCard(e));
      if (!cands.length) return null;
      cands.sort((a, b) => norm(b.textContent || '').length - norm(a.textContent || '').length);
      return cands[0];
    }, OVERLAY_SEL).catch(() => null);
    const overlayEl = overlayH && overlayH.asElement ? overlayH.asElement() : null;
    if (!overlayEl) {
      console.warn(`[liepin][diagnostic] CITY_OVERLAY_NO_CONTAINER: 「其他」已点但未定位到弹层容器（city=${city}, sel=${OVERLAY_SEL}）——待真机验证弹层容器选择器`);
      // ★ 监控：「其他」已点但弹层容器未定位到 —— 采骨架核对弹层容器真实 class。
      await dumpSkeleton(page, 'CITY_OVERLAY_NO_CONTAINER').catch(() => {});
      return false;
    }
    // ⑤ 在弹层容器 root 内点目标城市。
    const picked = await pickOptionByText(page, op, city, overlayEl);
    if (picked) return true;
    // ⑥ 弹层内零命中目标城市 → 诊断码，绝不静默。真机一跑即暴露：要么弹层选择器漂移，
    //   要么目标城市在弹层里用了别名（如『武汉市』vs『武汉』）。后者由调用方决定是否做归一化。
    console.warn(`[liepin][diagnostic] CITY_OVERLAY_NO_MATCH: 弹层已展开但未命中目标城市（city=${city}）——待真机验证弹层内城市名是否为别名`);
    // ★ 监控：弹层已展开但未命中目标城市 —— 采弹层骨架，离线核对城市项真实文本（别名？）。
    await dumpSkeleton(page, 'CITY_OVERLAY_NO_MATCH').catch(() => {});
    return false;
  } catch (e: any) {
    console.warn(`[liepin][diagnostic] CITY_OVERLAY_ERROR: 城市弹层路径异常 city=${city}:`, e?.message || e);
    // ★ 监控：城市弹层路径异常 —— 采骨架供离线定位异常现场。
    await dumpSkeleton(page, 'CITY_OVERLAY_ERROR').catch(() => {});
    return false;
  }
}

/** 点搜索按钮：CSS 优先，文案 xpath 兜底（原方案 _click_search_button 的等价实现） */
async function clickSearchButton(page: Page, op: HumanOperator, sel: string): Promise<boolean> {
  try {
    const btns = await page.$$(sel).catch(() => [] as ElementHandle[]);
    for (const b of btns) {
      const t = await b.evaluate((el) => (el.textContent || '').trim()).catch(() => '');
      // ⛔ 原写法 `if (t && !t.includes('搜索')) continue;` 有个致命短路：
      //   t 为空串时（图标按钮、或文字尚未渲染完）守卫【被跳过】，直接点下去——
      //   而这个选择器在结果页会命中 40 个「立即沟通」。必须【要求文案确实含"搜索"】，
      //   拿不到文案就跳过，宁可这一轮搜索失败也不能误点发消息按钮。
      if (!t.includes('搜索')) continue;
      // 双保险：即使文案含"搜索"，也绝不点带沟通语义的按钮
      if (/沟通|聊聊|发起|打招呼/.test(t)) continue;
      try {
        await op.clickElement(b);
        return true;
      } catch {
        try { await b.click(); return true; } catch { /* next */ }
      }
    }
    // 文案兜底（同样要挡住沟通类按钮——这里是全文档扫，更需要护栏）
    const hit = await page.evaluateHandle(() => {
      const list = Array.from(document.querySelectorAll('button'));
      return list.find((b) => {
        const t = (b.textContent || '').trim();
        return t.includes('搜索') && !/沟通|聊聊|发起|打招呼/.test(t);
      }) || null;
    }).catch(() => null);
    if (hit) {
      const el = hit.asElement() as ElementHandle | null;
      if (el) {
        try { await op.clickElement(el); return true; } catch { try { await el.click(); return true; } catch { /* ignore */ } }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 结果排序设置（2026-08-18 产量重构·修复3）。
 *
 * 真机实测：结果页排序下拉「智能排序 / 活跃度排序 / 更新时间排序」，RPA 此前从未设过。
 * 设「更新时间排序」= ①最新简历顶上来更值得联系 ②跨轮跑时新更新的人持续顶上来，
 * 配合跨轮持久去重，深翻产出的都是新人。
 *
 * 流程：在【排序区容器】内找文本含触发器文案(智能排序)的可点元素 → 点开下拉 →
 *   在展开的下拉/浮层内按目标文案匹配点目标项 → 校验触发器文案变成所选项。
 *
 * ★ 2026-08-19 P0（排序稳定生效）：整段「找触发器→点开→选目标→校验」包成【有界重试】
 *   （最多 SORT_VERIFY_RETRIES=3 次）。真机长跑出现 SORT_VERIFY_FAIL×1：单次校验太早，
 *   下拉可能被引导浮层吞掉、或校验读触发器太快读不到变更 → 排序没设上、退回默认相关度
 *   序 → 看到反复搜过的老顶部 → 前段大量重复、新增率被拖垮。排序稳定生效是提产量最高
 *   杠杆（更新时间排序=最新简历在前=天然新人）。重试之间先 dismissOverlays + 短等，
 *   排掉「下拉被浮层吞/校验太早」这两类瞬时失败。3 次仍失败才 dump SORT_VERIFY_FAIL
 *   并明确告警「本组合结果可能是旧相关度序、重复会偏多」（不静默、不阻断，继续跑）。
 *   排序在【翻页之前】就设好（applySearch 出首页结果时设一次），使该组合所有页都是
 *   「更新时间」序——见 liepin.ts applySearch 调用点（countCards>0 即设，早于翻页）。
 *
 * ⚠️ 安全：①排序点击限定在 sortContainer 内 + 复用 locateOptionByText 的卡片排除闸门
 *   (li[data-resumeidencode] / resumeCard 子树一概不命中)，结构上不可能点到卡片内
 *   「立即沟通/超级聊聊」；②走 op.clickElement 拟人点击。重试只在排序区/下拉里重找，
 *   不向卡片区扩展，安全边界与单次一致。
 * ⚠️ 文案/选择器无真机校准 = 零命中探针：失败 dump 骨架('SORT_FAILED') 不静默，
 *   但不阻断主流程（排序没设上不影响抓卡，只是新人没那么顶）。
 *
 * @returns true=排序已设(或已是目标项)；false=未设上(已 dump 骨架)
 */
const SORT_VERIFY_RETRIES = 3; // 单次搜索设排序的有界重试上限（见 P0 注释）

// ★ 2026-08-20 P1【ant-select 时序修复】：applySearch 出结果后排序工具栏异步渲染晚于
//   结果卡（c-in-c 真机：skeleton 显示结果卡已渲染、nodeCount 3007 未截断，但「智能排序/
//   共有N份简历」整条 ant-lpt-select 工具栏缺失，重试3次仍缺失 → SORT_NO_TRIGGER_FULL）。
//   旧的「全文档扫 innerText 找触发器文案」在节点爆炸时既慢又易被 portal 浮层干扰；现按
//   ant-select 结构【只查 span.ant-lpt-select-selection-item 存在且文本含「排序」】——
//   这是 ant-design select 渲染完成的权威信号，比扫全文准、且不受节点量影响。
//   轮询超时 6s→12s（工具栏异步渲染 + RPA 真机负载下确实需要更久），每 500ms 查一次。
//   出现再进入设排序流程；未出现按现状跳过（不阻断、不空等太久），仅落 SORT_TOOLBAR_TIMEOUT。
//   ★ 不发请求、不点击，纯只读 DOM 探测。
const SORT_TOOLBAR_POLL_MS = 500;
const SORT_TOOLBAR_WAIT_MS = 12000;
async function waitForSortToolbar(page: Page, C: LiepinCfg): Promise<boolean> {
  const triggerTexts = C.sortTriggerTexts?.length ? C.sortTriggerTexts : ['智能排序'];
  const deadline = Date.now() + SORT_TOOLBAR_WAIT_MS;
  while (Date.now() < deadline) {
    // ant-lpt-select 渲染完成信号：selection-item 存在且文本含「排序」，或结果计数(份简历)出现。
    const hit = await page.evaluate((sel: string, trigs: string[]) => {
      const text = document.body?.innerText || '';
      if (text.includes('份简历')) return true; // 结果计数 = 工具栏已就绪的权威信号（兜底）
      // 主信号：ant-lpt-select 的 selection-item（触发器）已渲染且可见。
      const items = document.querySelectorAll(sel);
      for (const it of items) {
        const t = (it.textContent || '').trim();
        if (!t) continue;
        const r = (it as HTMLElement).getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (t.includes('排序')) return true;
        for (const tr of trigs) { if (t.includes(tr)) return true; }
      }
      return false;
    }, C.sortSelectItem, triggerTexts).catch(() => false);
    if (hit) return true;
    await new Promise((r) => setTimeout(r, SORT_TOOLBAR_POLL_MS));
  }
  console.warn(`[liepin][diagnostic] SORT_TOOLBAR_TIMEOUT: 等待排序工具栏渲染 ${SORT_TOOLBAR_WAIT_MS / 1000}s 仍未出现（selection-item/${triggerTexts.join('/')}/或「份简历」计数），按现状尝试设排序`);
  return false;
}

// 浏览器端纯函数：在 ant-lpt-select 触发器里按文案找可见的 selection-item（排除卡片子树）。
// 返回的元素供外层 op.clickElement 拟人点击其祖先 .ant-lpt-select-selector 开下拉。
function findSelectItemByText(sel: string, trigs: string[], root?: Element | null): Element | null {
  const scope: Element = root || document.body;
  const isInsideCard = (el: Element): boolean =>
    !!(el.closest('li[data-resumeidencode]') || el.closest("[class*='resumeCard']"));
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el as HTMLElement);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
  };
  const items = Array.from(scope.querySelectorAll(sel));
  const norm = (s: string) => s.replace(/\s+/g, '').trim();
  for (const pass of [0, 1]) {
    for (const it of items) {
      if (isInsideCard(it) || !visible(it)) continue;
      const t = norm(it.textContent || '');
      if (!t) continue;
      const ok = pass === 0 ? trigs.some((tr) => t === norm(tr)) : trigs.some((tr) => t.includes(norm(tr)));
      if (ok) return it;
    }
  }
  return null;
}

async function applyResultSort(
  page: Page, op: HumanOperator, C: LiepinCfg, mode: 'updateTime' | 'active',
): Promise<boolean> {
  try {
    const targetTexts = C.sortOptions[mode];
    if (!targetTexts?.length) return false;
    const triggerTexts = C.sortTriggerTexts?.length ? C.sortTriggerTexts : ['智能排序'];

    // ★ 2026-08-20 P1：先轮询等待排序工具栏渲染（最多 ~12s），再操作 ant-select。
    await waitForSortToolbar(page, C);

    // ① 找 ant-lpt-select 触发器（selection-item，文本含「排序」）。限定在 sortContainer 内
    //   找（安全主路径），容器内没有再退到全文档（仍走卡片排除闸门）。
    const findTrigger = async (): Promise<ElementHandle | null> => {
      const containers = await page.$$(C.sortContainer).catch(() => [] as ElementHandle[]);
      for (const ct of containers) {
        const h = await page.evaluateHandle(findSelectItemByText, C.sortSelectItem, triggerTexts, ct).catch(() => null);
        const el = h?.asElement() as ElementHandle | null;
        if (el) return el;
      }
      const h = await page.evaluateHandle(findSelectItemByText, C.sortSelectItem, triggerTexts, null).catch(() => null);
      return (h?.asElement() as ElementHandle | null) || null;
    };
    const triggerTextOf = async (el: ElementHandle | null): Promise<string> =>
      el ? await el.evaluate((e) => (e.textContent || '').trim()).catch(() => '') : '';

    // 先快速判「已是目标项」：触发器文案已是目标文案 → 本组合排序已设好，无需重试。
    {
      const t0 = await findTrigger();
      const text0 = await triggerTextOf(t0);
      if (t0 && targetTexts.some((t) => text0.includes(t))) {
        console.warn(`[liepin] 排序已为 ${targetTexts[0]}（触发器文案已是目标），无需重设`);
        return true;
      }
    }

    // ★ P0 有界重试：每次完整跑「找触发器→点开下拉→选目标→校验」。
    //   失败原因多是瞬时的（下拉被浮层吞、校验读太快读不到变更），重试间先 dismissOverlays
    //   + 短等排掉浮层、等下拉动画收尾，再试一次。命中即返回成功。
    for (let attempt = 1; attempt <= SORT_VERIFY_RETRIES; attempt++) {
      // 重试前（非首试）先关浮层 + 短等，排掉「下拉被浮层吞/上一次校验太早」。
      if (attempt > 1) {
        await dismissOverlays(page, C.overlayLabels);
        await new Promise((r) => setTimeout(r, 500));
      }

      const trigger = await findTrigger();
      if (!trigger) {
        // 触发器整页都找不到 —— 不是瞬时问题（结构漂移 / 工具栏未渲染），重试也不会变，直接定性。
        // dump【全页】骨架到 SORT_NO_TRIGGER_FULL，便于离线判断工具栏到底在 DOM 哪、还是根本没渲染。
        console.warn(`[liepin][diagnostic] SORT_NO_TRIGGER_FULL: 未找到排序触发器(selection-item/文案=${triggerTexts.join('/')})，已采样全页骨架`);
        await dumpSkeleton(page, 'SORT_NO_TRIGGER_FULL').catch(() => {});
        return false;
      }

      // 已是目标排序项就不点（避免重复展开 / 重复点 = 取消选中）。
      const triggerTextNow = await triggerTextOf(trigger);
      if (targetTexts.some((t) => triggerTextNow.includes(t))) {
        console.warn(`[liepin] 排序已设为 ${targetTexts[0]}（重试 ${attempt} 次后校验通过）`);
        return true;
      }

      // ② 点开排序下拉：点 selection-item 的可点祖先 .ant-lpt-select-selector（ant-design 协议）。
      //   原实现直接点 selection-item 文本元素，ant-select 的点击命中区在 .ant-lpt-select-selector
      //   上、点 selection-item 可能不触发开合。取祖先后用 op.clickElement 拟人点击。
      //   ★ 选中器字符串作为参数传进 evaluate 闭包（闭包内取不到外层变量）。
      const selectorEl = await trigger.evaluateHandle(
        (el: Element, sel: string) => el.closest(sel) || el,
        C.sortSelectSelector,
      ).catch(() => trigger);
      try { await op.clickElement(selectorEl); }
      catch { try { await selectorEl.click(); } catch { /* fall through */ } }
      await new Promise((r) => setTimeout(r, 700));

      // ③ 选项在 portal 弹层(document 级，不在 select 容器内)：等 .ant-lpt-select-dropdown 出现，
      //   在 .ant-lpt-select-item-option 里按目标文案匹配并拟人点。复用 locateOptionByText 的
      //   卡片排除闸门作兜底（portal 选项不在卡片内，双保险）。
      let picked = false;
      for (const t of targetTexts) {
        // 先按 ant-select 结构化选择器在 portal 里定位选项条目。
        const optHandle = await page.evaluateHandle((sel: string, txt: string) => {
          const norm = (s: string) => s.replace(/\s+/g, '').trim();
          const target = norm(txt);
          const visible = (el: Element) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = window.getComputedStyle(el as HTMLElement);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
          };
          const isInsideCard = (el: Element): boolean =>
            !!(el.closest('li[data-resumeidencode]') || el.closest("[class*='resumeCard']"));
          const opts = Array.from(document.querySelectorAll(sel));
          for (const pass of [0, 1]) {
            for (const o of opts) {
              if (isInsideCard(o) || !visible(o)) continue;
              const ot = norm(o.textContent || '');
              if (!ot) continue;
              const ok = pass === 0 ? ot === target : ot.includes(target);
              if (ok) return o;
            }
          }
          return null;
        }, C.sortOptionItem, t).catch(() => null);
        let el = optHandle?.asElement() as ElementHandle | null;
        // 结构化未命中 → 退到 locateOptionByText 全文档兜底（仍走卡片排除闸门）。
        if (!el) {
          const h = await page.evaluateHandle(locateOptionByText, t, null).catch(() => null);
          el = h?.asElement() as ElementHandle | null;
        }
        if (!el) continue;
        try { await op.clickElement(el); }
        catch { try { await el.click(); } catch { continue; } }
        picked = true;
        await new Promise((r) => setTimeout(r, 800));
        break;
      }
      if (!picked) {
        // 本轮下拉没命中目标项 —— 可能是被浮层吞了没真展开，重试有机会排掉。
        if (attempt < SORT_VERIFY_RETRIES) {
          console.warn(`[liepin] 排序下拉展开后未命中目标项(${targetTexts.join('/')})，第 ${attempt}/${SORT_VERIFY_RETRIES} 次重试`);
          continue;
        }
        console.warn(`[liepin][diagnostic] SORT_NO_OPTION: 排序下拉展开后未命中目标项(${targetTexts.join('/')})，已采样骨架`);
        await dumpSkeleton(page, 'SORT_NO_OPTION').catch(() => {});
        return false;
      }

      // ④ 校验生效：selection-item 文本变成目标项（重找触发器，避免句柄失效）。
      const afterTrigger = await findTrigger();
      const afterText = await triggerTextOf(afterTrigger);
      if (afterText && targetTexts.some((t) => afterText.includes(t))) {
        console.warn(`[liepin] 排序已设为 ${targetTexts[0]}（校验通过${attempt > 1 ? `，第 ${attempt}/${SORT_VERIFY_RETRIES} 次重试成功` : ''}）`);
        return true;
      }
      // 校验没过 —— 多半是校验读太快 / 下拉没真展开，重试有机会。
      if (attempt < SORT_VERIFY_RETRIES) {
        console.warn(`[liepin] 排序校验未通过(现=${afterText || '?'}，目标=${targetTexts[0]})，第 ${attempt}/${SORT_VERIFY_RETRIES} 次重试`);
        continue;
      }
      // ★ P0：3 次重试仍校验失败 → dump SORT_VERIFY_FAIL + 明确告警（不静默、不阻断）。
      //   让人在日志里看得见「本组合结果可能是旧相关度序、重复会偏多」，而不是默默退回默认序。
      console.warn(`[liepin][diagnostic] SORT_VERIFY_FAIL: 排序点击后触发器文案未变成目标(现=${afterText || '?'}，目标=${targetTexts[0]}，已重试 ${SORT_VERIFY_RETRIES} 次)，已采样骨架`);
      await dumpSkeleton(page, 'SORT_VERIFY_FAIL').catch(() => {});
      console.warn(`[liepin] 排序未设成功，本组合结果可能是旧相关度序、重复会偏多（不影响抓卡，继续运行）`);
      return false;
    }
    // 理论不可达（循环内所有路径都已 return），兜底返回未设。
    return false;
  } catch (e: any) {
    console.warn(`[liepin][diagnostic] SORT_FAILED: 排序设置异常 ${e?.message || e}，已采样骨架`);
    await dumpSkeleton(page, 'SORT_ERROR').catch(() => {});
    return false;
  }
}
