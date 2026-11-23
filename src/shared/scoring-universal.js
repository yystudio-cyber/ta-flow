/**
 * 通用评分引擎 v4 —— 纯 JS，无 Node/浏览器依赖，可在主进程与 content script (isolated world) 中共用。
 *
 * 架构：四层漏斗 + 校准
 *   L1  硬门槛过滤（Hard Filter）→ 任一硬门槛不达标 → mismatch 标记 + 原因
 *   L2  分维评分（满幅锚点 0-100，判不了的维度整体退出加权）
 *   L3  语义相似匹配（Semantic Match）→ 可选扩展，通过 setSemanticProvider 注入
 *   L4  加权汇总 → 必选词零命中闸门 → 单调校准拉伸 → 可解释输出
 *
 * v4（2026-07-30，针对"技术词表面命中掩盖域错配"的重造）：
 *   · 新增【应用域匹配 domainFit】：消费 jd.domain（industry/platform/scenes/sensors/adjacent/distant），
 *     判定候选人所在域与 JD 的距离（同域/相邻/远域/无信号）——这是人工 TA 给分差异的首要来源，
 *     v3 里同一堆技术词换个应用场景照样把硬技能维刷满，就是因为完全没看应用域；
 *   · 新增【JD 任务点覆盖 taskCoverage】：消费 jd.tasks（任务点列表 + domainSensitive 标记），
 *     按 direct / transfer / none 三级证据计分——domainSensitive 任务在异域命中必须显著折扣，
 *     非域敏感任务（如嵌入式部署、多目标跟踪）异域也按全额计，不搞一刀切；
 *   · 硬技能维带上域上下文：同域经历里命中的技术词比异域命中的权重高，
 *     进一步压制"相邻域技术词凑满硬技能分"的问题；
 *   · 新增【科研产出 researchOutput】维：顶会/论文/专利，权重小，工程岗不主导排序；
 *   · card / detail 两级 tier 差异化加强：card 层证据不足时不允许给出 ≥85 或 ≤15 的极端分，
 *     这是产品安全底线——卡片层的分会驱动真人决定点不点开，不许草率；
 *   · 权重重排：domainFit(20) + taskCoverage(20) 合计 40% 占主导，硬技能从 24 降到 16，
 *     项目经验从 9 降到 4，industry 降为 3（domainFit 已经消费域信号，industry 退化为纯行业词面匹配）。
 *
 * 主进程通过 src/main/services/scoring.ts 的包装调用此文件；
 * content script 通过 chrome.ts 注入时内联此文件，调用 window.__TA_SCORE__；
 * Chrome 扩展直接加载此文件。
 * 任何评分逻辑修改只在此处进行，避免多份实现分叉。
 */
(function (root) {
  'use strict';

  // ===================== 常量 =====================
  // 学历档位（P1-18 补全）：liepin 适配器会产出「博士后」「硕士研究生」，
  // MBA（工商管理硕士）归入硕士档。所有读档处必须经 degreeRank() 走同一口径。
  var DEGREE_RANK = { 中专: 0, 高中: 0, 大专: 1, 本科: 2, 硕士: 3, 硕士研究生: 3, MBA: 3, 博士: 4, 博士后: 5 };

  // 学历归一化统一函数（P1-18）：统一剥「及以上/以上」后缀、未知学历返回 undefined（不猜档）。
  // 三处（硬门槛学历、经验维抵扣、学历维）共用，杜绝一处剥一处不剥的归一化漂移。
  function degreeRank(s) {
    if (s == null) return undefined;
    var r = DEGREE_RANK[String(s).replace(/及以上|以上/g, '').trim()];
    return r != null ? r : undefined;
  }

  // P1-21：数组清洗。Array.isArray 判定，拒绝 `|| []`（挡不住类型错误的非空标量，
  // 如 skills='foo'、keywords.required=5）。元素逐个滤掉 null/undefined，
  // 避免下游 reading 'company'/'weight' 抛 TypeError。onlyObj 时连标量元素也滤掉。
  function arrOf(x, onlyObj) {
    if (!Array.isArray(x)) return [];
    return x.filter(function (el) {
      if (el == null) return false;
      if (onlyObj) return typeof el === 'object' && !Array.isArray(el);
      return true;
    });
  }

  // P1-21：research 数值字段必须 Number.isFinite 校验，否则 research={papers:'x'}
  // 直接让 total 变 NaN 流到落库与 UI。
  function fin(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  }

  // P1-21：数值字段统一强转。字符串数字（'3'）→ 3；'x'/NaN/Infinity/对象 → null
  // （视为"无信息"而非参与 NaN 运算）。experienceYears/age 等在归一化处过一遍，
  // 杜绝 `gap = 'x' - '3' = NaN` 这类字符串相减污染总分。
  function numOrNull(x) {
    if (x == null || x === '') return null;
    var n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  // 学历超配折算年限（P1-18 抽取为共享 helper）：候选人学历高于 JD 要求一档折 2 年、两档折 4 年。
  // 硬门槛（checkHardFilters）与经验维（scoreExperience）必须用同一份折算，否则一个说
  // 「视同满足」、另一个判 mismatch，同一次评分自相矛盾（P1-18 问题 A）。
  function degreeYearCredit(c, jd) {
    if (!jd.basic || !jd.basic.degree || !c.degree) return 0;
    var reqRank = degreeRank(jd.basic.degree);
    var candRank = degreeRank(c.degree);
    if (reqRank == null || candRank == null) return 0;
    if (candRank > reqRank) return Math.min(2, candRank - reqRank) * 2;
    return 0;
  }

  // 权重模板（14 维）。
  // ⚠️ 合计不是 100（default=107 / tech=105 / functional=106 / management=105），也不需要是：
  // scoreCandidate 最后按【实际参与加权的维度之和】归一化，所以只有维度间的【比例】有意义。
  // 别为了凑整去改数字——改比例就是改评分口径，会动 score:eval 的硬门槛。
  // src/shared/constants.ts 的同名表必须与本表逐键相等（contract-check 第 14 节比数值）。
  // v4 新增 domainFit（应用域匹配）、taskCoverage（JD任务点覆盖）、researchOutput（科研产出）：
  // 老配置里没有这三个键时，引擎用模板默认值补上（scoreCandidate 里逐维 fallback），
  // 无需迁移已保存的权重。同时 v4 调整了 tech 模板下 keywords/projects/industry 的权重，
  // 让 domainFit + taskCoverage 合计 40（default/tech）~36（functional/management）占主导。
  // ⚠️ 不含 researchOutput（P1-23）：该维无任何写入点（src/main、插件 parts 均不采
  // 科研产出），恒 notApplicable 退出加权，3% 权重从不参与——保留会让「14 维」口径
  // 失真。已移除并把权重重新分配进主导维（见各模板备注）。contract-check 逐键比对。
  var WEIGHT_TEMPLATES = {
    default: {
      positionFit: 12, domainFit: 21, taskCoverage: 22, keywords: 16, experience: 9,
      degree: 5, industry: 3, companyTier: 3, projects: 4,
      salary: 3, location: 4, age: 2, stability: 3,
    },
    tech: {
      positionFit: 12, domainFit: 20, taskCoverage: 22, keywords: 19, experience: 8,
      degree: 4, industry: 3, companyTier: 2, projects: 5,
      salary: 2, location: 3, age: 2, stability: 3,
    },
    functional: {
      positionFit: 15, domainFit: 16, taskCoverage: 20, keywords: 12, experience: 10,
      degree: 7, industry: 5, companyTier: 5, projects: 4,
      salary: 4, location: 4, age: 2, stability: 2,
    },
    management: {
      positionFit: 12, domainFit: 16, taskCoverage: 18, keywords: 10, experience: 15,
      degree: 7, industry: 6, companyTier: 7, projects: 4,
      salary: 3, location: 3, age: 2, stability: 2,
    },
  };

  // card 层极端分压制常数（M5）：卡片层信息有限，证据不足时不允许给出太极端的分，
  // 这是产品安全底线——卡片分驱动"点不点开"这个真人决策，草率给 90 或 10 会误事。
  // detail 层不受此限。
  var CARD_MAX = 85;
  var CARD_MIN = 15;

  // ── 校准拉伸（v3）────────────────────────────────────────────────────────
  // 加权平均天然向心（k 个独立维度的均值方差按 1/√k 收缩），即便分维已是满幅，
  // 总分也会往中间挤。这里把聚合分过一条【单调】曲线：S 形（中心 55、斜率 1/11）
  // 与恒等函数按 65/35 混合——排序不变（单调），只把 45-75 的密集区拉开。
  // 对照工业做法：Platt scaling 同样用单调 sigmoid 重整分布而不动排序。
  function calibrate(x) {
    var s = 100 / (1 + Math.exp(-(x - 55) / 11));
    return Math.max(0, Math.min(100, Math.round(0.35 * x + 0.65 * s)));
  }

  // 关键词特异性权重：越长/越专业的词，命中越说明问题（"大型分布式系统性能调优" >> "系统"）。
  // 通用短词人人都有，给同样的权重只会稀释区分度——对照 ATS 实践中的 keyword weighting。
  function kwWeight(k) {
    var s = String(k || '').trim();
    if (!s) return 1;
    var cjk = /[一-龥]/.test(s);
    if (cjk) return s.length >= 4 ? 1.5 : s.length >= 3 ? 1.25 : 1;
    return s.length >= 8 ? 1.5 : s.length >= 5 ? 1.25 : 1;
  }

  // 覆盖度低于此值不给 high 等级（见 scoreCandidate 里的说明）。
  // 2026-07-29 上调 60→75：60 挡不住"资料越少分越高"这个偏置。
  // 实测反例（真机 JD + 推荐卡样本）：只有职位/城市/学历/期望薪资的稀疏卡片，
  // 因为工作年限/公司层级/项目经验三维全部"无数据"被整体免罚，覆盖度 74% 仍评到 89 分 high；
  // 而资料齐全、明显更对口的候选人，项目经验维拿到真实分数 50 反被拖到 74 medium。
  // 缺失即免罚是维度剔除机制的固有副作用，只能靠覆盖度门槛兜住——门槛必须高于
  // "只有卡片基础字段"那一档（约 74%），才能真正要求"证据充分"。
  var MIN_COVERAGE_FOR_HIGH = 75;

  // 「敢不敢下否定结论」的覆盖度下限。低于它，引擎没资格说这个人不合适——
  // 只能说「没看清」。与 MIN_COVERAGE_FOR_HIGH 对称：一个管高分要证据，一个管低分要证据。
  // 取 60 的依据：2026-08-07 用 10 份进面简历 + 20 例跨岗错配实测，
  // 进面样本覆盖度最低 61%，跨岗错配样本 95% 落在 60% 以下——60 这条线正好把两者分开。
  var MIN_COVERAGE_FOR_REJECT = 60;

  // 否定结论的文本体量下限（字符）。低于它 = 简历没抓全，不是人不行。见 scoreCandidate 里第二道托底。
  var MIN_TEXT_FOR_REJECT = 350;

  // 硬门槛（任一不达标即「岗位不符」）
  // degreeHard / experienceHard / salaryHard / cityHard 可通过 JD 或全局设置开关
  var DEFAULT_HARD_FLAGS = {
    degree: true,       // 学历低于要求 → 岗位不符
    experience: true,   // 经验低于下限 → 岗位不符
    salary: false,      // 薪资超预算 → 默认只减分，不算硬门槛（可开）
    city: false,        // 城市不匹配 → 默认只减分，不算硬门槛（可开）
    age: false,         // 年龄超出 JD 声明区间 → 默认只减分；置 true 才作硬门槛
  };

  // ===================== 工具函数 =====================
  // 拉丁技术词的「词内字符集」——这些字符连在一起才算同一个 token。
  // 含 + # . _ - 是因为 C++ / C# / node.js / scikit-learn 都是一个词。
  var TOKEN_CHAR = /[A-Za-z0-9+#._-]/;
  var HAS_CJK = /[一-龥]/;

  // 词边界匹配，强/弱双轨。2026-08-07。
  //
  // 中文没有词边界可言（「感知算法」里找「感知」本就该命中），一律子串。
  // 拉丁词裸 indexOf 会制造假命中：GO 命中 Golang/Google、C 命中 C++。
  // 但**不能因此直接判不命中**——「微服务」出现在「微服务治理」里是真命中，
  // 一刀切的边界匹配会把这类复合技术词判脱靶，进而触发「必选词零命中封顶 55」把合格的人打到 60 以下。
  //
  // 所以分两档，服务于「60 分以下必须极其准确、60 分以上允许模糊」这条非对称要求：
  //   strong = 有词边界的命中 → 参与排序打分，可信
  //   weak   = 只有子串的命中 → **不参与加分，但足以否决「零命中」这道拒绝闸门**
  // 换言之：拿不准的证据只用于「不拒绝」，绝不用于「加分」。宁可少给分，不可错杀。
  function matchOneStrong(lowerText, k) {
    // 空关键词必须先挡住：下面 from = idx + 1 的步进对空串不收敛（indexOf('') 恒被钳到
    // 同一位置），会死循环挂死主进程 / content script。当前调用方都过滤了空值，这里是兜底。
    if (!k || !lowerText) return false;
    if (HAS_CJK.test(k)) return lowerText.indexOf(k) !== -1;
    var from = 0;
    for (;;) {
      var idx = lowerText.indexOf(k, from);
      if (idx === -1) return false;
      var before = idx > 0 ? lowerText.charAt(idx - 1) : '';
      var afterIdx = idx + k.length;
      var after = afterIdx < lowerText.length ? lowerText.charAt(afterIdx) : '';
      if ((!before || !TOKEN_CHAR.test(before)) && (!after || !TOKEN_CHAR.test(after))) return true;
      from = idx + 1;
    }
  }

  function matchKeywords(text, keywords) {
    var hit = [];
    var weak = [];
    if (!text || !keywords || !keywords.length) return { hit: hit, count: 0, weak: weak, weakCount: 0 };
    var lower = String(text).toLowerCase();
    for (var i = 0; i < keywords.length; i++) {
      var k = String(keywords[i]).trim().toLowerCase();
      if (!k) continue;
      if (matchOneStrong(lower, k)) hit.push(keywords[i]);
      else if (lower.indexOf(k) !== -1) weak.push(keywords[i]);
    }
    return { hit: hit, count: hit.length, weak: weak, weakCount: weak.length };
  }

  function arrayToText(arr) {
    if (!arr || !arr.length) return '';
    return arr.join(' ');
  }

  // 构造候选人「全量技能文本」——用于关键词和语义匹配
  function buildSkillText(c) {
    var parts = [];
    if (c.position) parts.push(c.position);
    if (c.skills && c.skills.length) parts.push(c.skills.join(' '));
    if (c.selfIntro) parts.push(c.selfIntro);
    // 工作经历
    if (c.workHistory && c.workHistory.length) {
      for (var i = 0; i < c.workHistory.length; i++) {
        var w = c.workHistory[i];
        if (w.company) parts.push(w.company);
        if (w.industry) parts.push(w.industry);
        if (w.description) parts.push(w.description);
        if (w.position) parts.push(w.position);
        // 2026-07-28：BOSS 卡片的 showWorks 还带业绩与平台抽好的技能标签，
        // 后者是质量最高的关键词来源（如 接口测试开发/Python/Jmeter/Selenium），必须计入
        if (w.performance) parts.push(w.performance);
        if (w.emphasis && w.emphasis.length) parts.push(w.emphasis.join(' '));
      }
    }
    // 注：教育经历（专业/院校）在下方已有统一处理，勿重复累加——重复会放大 TF 权重
    // 项目经历
    if (c.projects && c.projects.length) {
      for (var j = 0; j < c.projects.length; j++) {
        var p = c.projects[j];
        if (p.name) parts.push(p.name);
        if (p.desc) parts.push(p.desc);
        if (p.tech && p.tech.length) parts.push(p.tech.join(' '));
        if (p.role) parts.push(p.role);
      }
    }
    // 科研（v4）：顶会/论文/专利只在文本里轻量计入，由独立维度 researchOutput 主评；
    // 这里仅把 note 的关键词带给硬技能维，避免专利标题与公司/院校名污染 TF。
    if (c.research && c.research.note) parts.push(c.research.note);
    // 教育经历
    if (c.education && c.education.length) {
      for (var k = 0; k < c.education.length; k++) {
        var e = c.education[k];
        if (e.school) parts.push(e.school);
        if (e.major) parts.push(e.major);
      }
    }
    return parts.join(' ');
  }

  // 构造候选人【分段文本数组】——每段 = 一段独立经历（工作/项目/自我介绍/技能），
  // 用于 v4 的域判定与"同域命中关键词 vs 异域命中关键词"区分（M3）。
  // 因为域信息是随经历附着的（两个应用域可能同时出现在一个人的不同工作里），
  // 全量文本拼接会把这些上下文完全洗掉。
  function buildSegmentedText(c) {
    var segs = [];
    if (c.position) segs.push({ kind: 'profile', text: c.position, weight: 0.8 });
    if (c.selfIntro) segs.push({ kind: 'selfIntro', text: c.selfIntro, weight: 0.8 });
    if (c.skills && c.skills.length) segs.push({ kind: 'skills', text: c.skills.join(' '), weight: 0.6 });
    if (c.workHistory && c.workHistory.length) {
      for (var i = 0; i < c.workHistory.length; i++) {
        var w = c.workHistory[i];
        var t = [w.company, w.industry, w.position, w.description, w.performance,
          (w.emphasis && w.emphasis.length) ? w.emphasis.join(' ') : ''].filter(Boolean).join(' ');
        if (t) segs.push({ kind: 'work', text: t, weight: 1.0 });
      }
    }
    if (c.projects && c.projects.length) {
      for (var j = 0; j < c.projects.length; j++) {
        var p = c.projects[j];
        var pt = [p.name, p.desc, p.role, (p.tech && p.tech.length) ? p.tech.join(' ') : ''].filter(Boolean).join(' ');
        if (pt) segs.push({ kind: 'project', text: pt, weight: 0.9 });
      }
    }
    // ⚠️ 教育与科研必须在这里出现。2026-08-07 审查抓到的取材不一致：
    // scoreKeywords 在 JD 配了 domain 时走本函数、没配时走 buildSkillText，而 buildSkillText
    // 含 education（学校/专业）与 research.note，本函数原先两者都没有。后果是给岗位配上
    // 「应用域」（v4 主推配置）反而让技术证据主要在专业和论文里的人被判必选词零命中并封顶 55
    // ——实测同一候选人 total 从 91 掉到 52。两条取材路径必须等价。
    // 低权重：这类文本是背景证据，不该与工作经历同权；classifySegment 也天然把它归 none。
    if (c.education && c.education.length) {
      for (var e = 0; e < c.education.length; e++) {
        var ed = c.education[e];
        if (!ed) continue;
        var et = [ed.school, ed.major, ed.degree].filter(Boolean).join(' ');
        if (et) segs.push({ kind: 'edu', text: et, weight: 0.5 });
      }
    }
    if (c.research && c.research.note) segs.push({ kind: 'research', text: String(c.research.note), weight: 0.5 });
    return segs;
  }

  // 薪资解析
  function parseSalary(salaryStr) {
    if (!salaryStr) return null;
    var s = String(salaryStr);
    s = s.replace(/[·\*].*薪/g, '').replace(/\(.*?薪.*?\)/g, '').replace(/（.*?薪.*?）/g, '');
    var m = s.match(/(\d{1,3})\s*[-~到]\s*(\d{1,3})\s*[Kk千]/);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    var m2 = s.match(/(\d{1,3})\s*[Kk千](?:以上|以內|内)?/);
    if (m2) { var v = parseInt(m2[1], 10); return { min: v, max: v }; }
    var m3 = s.match(/(\d{4,6})\s*[-~到]\s*(\d{4,6})/);
    if (m3) return { min: Math.round(parseInt(m3[1], 10) / 1000), max: Math.round(parseInt(m3[2], 10) / 1000) };
    return null;
  }

  // 语义匹配 provider（可选，P1 注入）
  var semanticProvider = null;
  function setSemanticProvider(p) {
    semanticProvider = p;
  }
  function hasSemantic() {
    return !!(semanticProvider && semanticProvider.similarity);
  }
  // 语义相似度：返回 0-1，不可用时返回 null
  function semanticSim(textA, textB) {
    if (!hasSemantic() || !textA || !textB) return null;
    try {
      var s = semanticProvider.similarity(textA, textB);
      if (s == null || isNaN(s)) return null;
      return Math.max(0, Math.min(1, s));
    } catch (e) { return null; }
  }
  // 长文本 vs 单个关键词的相似度。provider 若提供了针对关键词优化的 kwSim（例如带上位词
  // 展开：命中"spring"也算命中"java"）就用它，没有就退回通用 similarity——老 provider 不受影响。
  function semanticKwSim(text, keyword) {
    if (!hasSemantic() || !text || !keyword) return null;
    if (!semanticProvider.kwSim) return semanticSim(text, keyword);
    try {
      var s = semanticProvider.kwSim(text, keyword);
      if (s == null || isNaN(s)) return null;
      return Math.max(0, Math.min(1, s));
    } catch (e) { return null; }
  }

  // ===================== L1 硬门槛 =====================
  function checkHardFilters(c, jd, hardFlags) {
    var reasons = [];
    // ⚠️ 必须【合并】而不是整体替换：JD 里只写了 {age:true} 时，
    // 整体替换会把默认开启的学历/经验硬门槛静默关掉。
    var flags = {};
    for (var dk in DEFAULT_HARD_FLAGS) { if (Object.prototype.hasOwnProperty.call(DEFAULT_HARD_FLAGS, dk)) flags[dk] = DEFAULT_HARD_FLAGS[dk]; }
    if (hardFlags) { for (var hk in hardFlags) { if (Object.prototype.hasOwnProperty.call(hardFlags, hk) && hardFlags[hk] != null) flags[hk] = hardFlags[hk]; } }

    // 学历
    if (flags.degree && jd.basic && jd.basic.degree && c.degree) {
      // ⚠️ 不能用 ||：中专/高中的 rank 是 0，是 falsy，|| 2 会把它们悄悄当成"本科"。
      // 实测后果：JD 要求中专、候选人大专 → 判 mismatch"大专，低于要求中专"，
      // 而学历维度同时给出"大专，高于要求 98 分"，同一次评分自相矛盾。
      // 与 scoreDegree(下方) 统一口径：认不出的学历要求视为"不设门槛"，不猜成本科。
      var req = degreeRank(jd.basic.degree);
      var got = degreeRank(c.degree);
      if (got != null && req != null && got < req) {
        reasons.push({ field: 'degree', label: '学历', detail: c.degree + '，低于要求' + jd.basic.degree });
      }
    }

    // 经验低于下限。P1-18 问题 A：学历超配折算【同样计入硬门槛】——
    // 否则经验维输出「1年+学历超配折算，视同满足 3年」、硬门槛却判 mismatch
    // 「1年，要求3以上年」，同一次评分自相矛盾。折算生效后达标就不再是 mismatch。
    if (flags.experience && jd.basic && jd.basic.experienceMin != null && c.experienceYears != null) {
      var effMin = c.experienceYears + degreeYearCredit(c, jd);
      if (effMin < jd.basic.experienceMin) {
        reasons.push({
          field: 'experience',
          label: '工作年限',
          detail: c.experienceYears + '年，要求' + jd.basic.experienceMin
            + (jd.basic.experienceMax != null ? '-' + jd.basic.experienceMax : '以上') + '年',
        });
      }
    }

    // 年龄超出 JD 声明区间（默认关）。
    // 只有 JD 明确写了 ageMin/ageMax 才可能触发——没有岗位依据就不该用年龄卡人。
    if (flags.age && jd.basic && (jd.basic.ageMin != null || jd.basic.ageMax != null) && c.age != null) {
      var aMin = jd.basic.ageMin != null ? jd.basic.ageMin : -Infinity;
      var aMax = jd.basic.ageMax != null ? jd.basic.ageMax : Infinity;
      if (c.age < aMin || c.age > aMax) {
        reasons.push({
          field: 'age', label: '年龄',
          detail: c.age + '岁，要求' + (jd.basic.ageMin != null ? jd.basic.ageMin : '不限') + '-' + (jd.basic.ageMax != null ? jd.basic.ageMax : '不限') + '岁',
        });
      }
    }

    // 薪资超预算（默认关）
    if (flags.salary && jd.basic && jd.basic.salaryMax != null && c.salary) {
      var ps = parseSalary(c.salary);
      if (ps && ps.min > jd.basic.salaryMax) {
        reasons.push({ field: 'salary', label: '薪资', detail: c.salary + '，超出预算' + jd.basic.salaryMax + 'K' });
      }
    }

    // 城市不匹配（默认关）
    if (flags.city && jd.basic && jd.basic.city && c.city) {
      if (c.city.indexOf(jd.basic.city) === -1 && jd.basic.city.indexOf(c.city) === -1) {
        reasons.push({ field: 'city', label: '城市', detail: c.city + ' ≠ ' + jd.basic.city });
      }
    }

    return reasons;
  }

  // ===================== L2 各维度评分 =====================

  function scoreExperience(c, jd, w) {
    var emin = jd.basic.experienceMin, emax = jd.basic.experienceMax;
    var years = c.experienceYears;
    if (years == null) {
      return { dimension: 'experience', label: '工作年限', score: 0, weight: w, status: 'partial', available: false, note: '无年限信息' };
    }
    if (emin == null && emax == null) {
      return { dimension: 'experience', label: '工作年限', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未设年限要求' };
    }
    // 学历超配抵扣年限（2026-08-07，只作用于本维的差距计算，不动硬门槛口径）：
    // 候选人学历高于 JD 要求一档折 2 年、两档折 4 年（硕士对本科要求 +2，博士对本科要求 +4）。
    // 依据两处独立事实：① 招聘进展表 575 条需求里，实际录用级别低于需求区间 82 次（31%）——
    // 「年限不足但学历/潜力补上」是真实录用常态；② 进面简历实测：2 年硕士对 5 年要求岗、
    // 1 年硕士对 3 年要求岗都被 TA 筛进了面试。不折算就是引擎替 TA 收紧了口径。
    var effYears = years + degreeYearCredit(c, jd);
    // v3 满幅锚点：差 1 年 50、差 2 年 28、差 3 年及以上贴地——"不够格"必须看得出来。
    // 硬门槛开着时低于下限本就 mismatch，这里的分数服务于硬门槛关掉/仅排序的场景。
    if (emin != null && effYears < emin) {
      var gap = emin - effYears;
      var sc = Math.max(8, 72 - gap * 22);
      return { dimension: 'experience', label: '工作年限', score: sc, weight: w, status: 'miss', note: years + '年，要求' + emin + (emax != null ? '-' + emax : '以上') + '年' };
    }
    if (emin != null && years < emin && effYears >= emin) {
      return { dimension: 'experience', label: '工作年限', score: 80, weight: w, status: 'partial', note: years + '年+学历超配折算，视同满足 ' + emin + '年' };
    }
    if (emax != null && years > emax + 3) {
      var over = years - emax - 3;
      return { dimension: 'experience', label: '工作年限', score: Math.max(45, 78 - over * 6), weight: w, status: 'warn', note: years + '年，超出要求较多（可能过高定级）' };
    }
    if (emax != null && years > emax) {
      return { dimension: 'experience', label: '工作年限', score: 88, weight: w, status: 'partial', note: years + '年，略超要求' };
    }
    return { dimension: 'experience', label: '工作年限', score: 96, weight: w, status: 'match', note: years + '年，完全匹配' };
  }

  // v4 硬技能评分（域上下文加权版本，见 scoreKeywordsV4 设计注释）：
  // 同一个技术词出现在同域经历里权重大、异域经历里权重打折；老 JD 不配 domain 时退化为 v3 行为。
  function scoreKeywords(c, jd, w, tier) {
    var req = jd.keywords.required || [];
    var bonus = jd.keywords.bonus || [];
    var neg = jd.keywords.negative || [];
    var reqTotal = req.length;
    var bonusTotal = bonus.length;
    var negTotal = neg.length;

    // 按段分桶：同域段、相邻段、远域段、其他段（skills/selfIntro/未判域）。
    // 与 scoreDomainFit / scoreTaskCoverage 保持一致的"远域传播"启发式。
    var domSets = jd.domain ? buildDomainKwSets(jd.domain) : null;
    var sameText = '', adjText = '', distText = '', otherText = '';
    var wSameKw = 0, wAdjKw = 0, wDistKw = 0, wOthKw = 0;
    if (domSets) {
      var segs = buildSegmentedText(c);
      for (var si = 0; si < segs.length; si++) {
        var seg = segs[si];
        var cls = classifySegment(seg.text, domSets);
        var len = String(seg.text).length;
        var lenW = len < 10 ? 0.3 : len < 60 ? 0.3 + 0.7 * (len - 10) / 50 : 1.0;
        var sw = (seg.weight || 1) * lenW;
        if (cls === 'same') { sameText += ' ' + seg.text; wSameKw += sw; }
        else if (cls === 'adjacent') { adjText += ' ' + seg.text; wAdjKw += sw; }
        else if (cls === 'distant') { distText += ' ' + seg.text; wDistKw += sw; }
        else { otherText += ' ' + seg.text; wOthKw += sw; }
      }
      // 远域传播：零同域 + 远域段权重占比 ≥30% → 把 other 段并入远域（半信）
      var totalKw = wSameKw + wAdjKw + wDistKw + wOthKw;
      if (wSameKw < 0.01 && totalKw > 0 && wDistKw / totalKw >= 0.3 && wOthKw > 0) {
        distText = distText + ' ' + otherText;
        wDistKw += wOthKw * 0.5;
        wOthKw = 0;
        otherText = '';
      }
    } else {
      otherText = buildSkillText(c);
    }
    var allText = (sameText + ' ' + adjText + ' ' + distText + ' ' + otherText).toLowerCase();
    var sameLow = sameText.toLowerCase(), adjLow = adjText.toLowerCase(), distLow = distText.toLowerCase(), othLow = otherText.toLowerCase();

    // 语义扩展：对未精确命中的必选词，用 provider 做相似度
    var semanticHits = [];
    var semanticHitCount = 0;
    if (hasSemantic() && reqTotal > 0) {
      for (var sm = 0; sm < req.length; sm++) {
        var kwl0 = String(req[sm]).trim().toLowerCase();
        if (allText.indexOf(kwl0) !== -1) continue;
        var sim = semanticKwSim(allText, req[sm]);
        if (sim != null && sim >= 0.7) { semanticHits.push({ keyword: req[sm], sim: sim }); semanticHitCount++; }
      }
    }

    // 弱命中（只有子串、没有词边界）——只用于否决「零命中」这道拒绝闸门，不参与任何加分。
    // 典型场景：必选词「微服务」，候选人写的是「微服务治理 / SpringCloud」。这是真本事，
    // 不能因为拿不到词边界就把人打到 60 以下。
    var weakReqHit = reqTotal > 0 ? matchKeywords(allText, req).weakCount : 0;

    var score;
    var status = 'match';
    var notes = [];
    var sameHit = 0, adjHit = 0, distHit = 0, othHit = 0;

    if (reqTotal === 0) {
      score = 50;
      status = 'partial';
      notes.push('无必选关键词');
    } else {
      var wAll = 0, wHit = 0;
      for (var ki = 0; ki < req.length; ki++) {
        var kwv = kwWeight(req[ki]);
        wAll += kwv;
        var kwls = String(req[ki]).trim().toLowerCase();
        // ⚠️ 必须走 matchOneStrong 而不是裸 indexOf。2026-08-07 审查抓到：那次「强/弱双轨」
        // 改造只把边界匹配接进了 note 与 zeroRequiredHit，算分循环仍是子串匹配 ——
        // 结果必选词 go 命中 Google、AI 命中 detail/maintain，弱命中拿满额分，
        // 与真命中的人同分。双轨的全部意义（弱命中只否决拒绝、不参与加分）当时等于没生效。
        var inSame = matchOneStrong(sameLow, kwls);
        var inAdj = !inSame && matchOneStrong(adjLow, kwls);
        var inDist = !inSame && !inAdj && matchOneStrong(distLow, kwls);
        var inOth = !inSame && !inAdj && !inDist && matchOneStrong(othLow, kwls);
        // 必选词是岗位的"硬技术门槛"（如 Java/分布式/部署），
        // 即便在异域经历里命中，也说明候选人具备该技术能力——这是可迁移的硬技能，折扣要轻；
        // 真正的域错配由 domainFit 维（20%权重）和 taskCoverage 的域敏感折扣（20%权重）承担。
        if (inSame) { wHit += kwv * 1.0; sameHit++; }
        else if (inAdj) { wHit += kwv * 0.92; adjHit++; }
        else if (inDist) { wHit += kwv * 0.75; distHit++; }
        else if (inOth) { wHit += kwv * 1.0; othHit++; }
      }
      for (var sh = 0; sh < semanticHits.length; sh++) wHit += kwWeight(semanticHits[sh].keyword) * 0.6;
      var ratio = wAll > 0 ? Math.min(1, wHit / wAll) : 0;
      score = Math.round(Math.pow(ratio, 1.3) * 100);
      var exactHit = sameHit + adjHit + distHit + othHit;
      if (exactHit + semanticHitCount < reqTotal) {
        status = 'partial';
        var brk = [];
        if (sameHit) brk.push('同域' + sameHit);
        if (adjHit) brk.push('相邻' + adjHit);
        if (distHit) brk.push('远域' + distHit);
        if (othHit) brk.push('其他' + othHit);
        notes.push('必选命中 ' + (exactHit + semanticHitCount) + '/' + reqTotal + (brk.length ? '（' + brk.join('/') + '）' : ''));
        if (semanticHitCount > 0) notes.push('语义近似 ' + semanticHitCount + '项');
      } else {
        notes.push('必选全命中');
      }
      if (exactHit + semanticHitCount === reqTotal) status = 'match';
    }

    // 加分词：同域 1.0 / 相邻 0.85 / 远域 0.6 / 其他 1.0，按有效命中数边际递减
    var BONUS_STEPS = [8, 5, 3, 2];
    var bonusSame = 0, bonusAdj = 0, bonusDist = 0, bonusOth = 0;
    for (var bi = 0; bi < bonus.length; bi++) {
      var bk = String(bonus[bi]).trim().toLowerCase();
      // 同 §必选词：加分词也只认强命中，弱命中一律不加分。
      if (matchOneStrong(sameLow, bk)) bonusSame++;
      else if (matchOneStrong(adjLow, bk)) bonusAdj++;
      else if (matchOneStrong(distLow, bk)) bonusDist++;
      else if (matchOneStrong(othLow, bk)) bonusOth++;
    }
    var bonusEff = bonusSame * 1.0 + bonusAdj * 0.95 + bonusDist * 0.8 + bonusOth * 1.0;
    var bonusEffInt = Math.ceil(bonusEff);
    for (var bs = 0; bs < bonusEffInt; bs++) score += bs < BONUS_STEPS.length ? BONUS_STEPS[bs] : 1;

    // 减分词：不分域
    var negHit = negTotal ? matchKeywords(allText, neg) : { count: 0, hit: [] };
    score -= negHit.count * 18;
    score = Math.max(0, Math.min(100, score));
    if (bonusTotal) notes.push('加分 ' + (bonusSame + bonusAdj + bonusDist + bonusOth) + '项');
    if (negHit.count) { status = 'miss'; notes.push('减分词 ' + negHit.count + '项: ' + negHit.hit.join(',')); }

    // exactHits：合并所有段的命中，保持字段形状（供 extractSkills 使用）
    var allExact = [];
    function pushMatches(text) { if (text) { var m = matchKeywords(text, req); for (var h = 0; h < m.hit.length; h++) allExact.push(m.hit[h]); } }
    pushMatches(sameText); pushMatches(adjText); pushMatches(distText); pushMatches(otherText);
    var allBonus = [];
    function pushBonus(text) { if (text) { var m = matchKeywords(text, bonus); for (var h2 = 0; h2 < m.hit.length; h2++) allBonus.push(m.hit[h2]); } }
    pushBonus(sameText); pushBonus(adjText); pushBonus(distText); pushBonus(otherText);
    var exactHitCount = sameHit + adjHit + distHit + othHit;

    return {
      dimension: 'keywords',
      label: '硬技能',
      score: score,
      weight: w,
      status: status,
      available: (reqTotal > 0 || bonusTotal > 0 || negTotal > 0),
      notApplicable: !(reqTotal > 0 || bonusTotal > 0 || negTotal > 0),
      note: notes.join('；'),
      exactHits: allExact,
      bonusHits: allBonus,
      negativeHits: negHit.hit || [],
      semanticHits: semanticHits,
      missed: Math.max(0, reqTotal - exactHitCount - semanticHitCount),
      reqTotal: reqTotal,
      // 只有「强命中 + 语义命中 + 弱命中」三者皆空，才算真的一个必选词都没沾上。
      // 弱命中在这里的唯一作用就是拦住误判——它不加分，只否决拒绝。
      zeroRequiredHit: reqTotal > 0 && exactHitCount === 0 && semanticHitCount === 0 && weakReqHit === 0,
      weakRequiredHit: weakReqHit,
    };
  }

  function scoreDegree(c, jd, w) {
    // JD 未设学历要求时 req=0（不设门槛），而非默认本科（P2 修复）
    // 与 checkHardFilters 同口径：统一走 degreeRank()（含剥「及以上/以上」、未知不猜档）
    var req = jd.basic.degree ? (degreeRank(jd.basic.degree) != null ? degreeRank(jd.basic.degree) : 0) : 0;
    var got = c.degree ? degreeRank(c.degree) : undefined;
    if (got == null) {
      return { dimension: 'degree', label: '学历', score: 0, weight: w, status: 'partial', available: false, note: '无学历信息' };
    }
    if (got >= req) {
      // v3：达标 88 / 高一档 96 / 高两档以上 90（超配略回落，与"过高定级"同理）
      var sc = got === req ? 88 : got === req + 1 ? 96 : 90;
      var extra = got > req ? '，高于要求' : '，满足要求';
      return { dimension: 'degree', label: '学历', score: sc, weight: w, status: 'match', note: c.degree + extra };
    }
    return { dimension: 'degree', label: '学历', score: 18, weight: w, status: 'miss', note: c.degree + '，低于要求' + jd.basic.degree };
  }

  function scoreIndustry(c, jd, w) {
    var companies = (c.workHistory || []).map(function (x) { return (x.industry || x.company || ''); }).join(' ');
    var pref = matchKeywords(companies, jd.industry.preferred);
    var exc = matchKeywords(companies, jd.industry.excluded);

    // 语义扩展：偏好行业的语义匹配
    var semanticPrefScore = null;
    if (hasSemantic() && jd.industry.preferred && jd.industry.preferred.length) {
      var prefText = jd.industry.preferred.join(' ');
      semanticPrefScore = semanticSim(companies, prefText);
    }

    if ((!jd.industry.preferred || !jd.industry.preferred.length) && (!jd.industry.excluded || !jd.industry.excluded.length)) {
      return { dimension: 'industry', label: '行业背景', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: '无行业偏好' };
    }
    if (exc.count) {
      return { dimension: 'industry', label: '行业背景', score: 8, weight: w, status: 'miss', note: '行业不符: ' + exc.hit.join(',') };
    }
    if (pref.count) {
      return { dimension: 'industry', label: '行业背景', score: 92, weight: w, status: 'match', note: '行业匹配: ' + pref.hit.join(',') };
    }
    // 语义近似命中
    if (semanticPrefScore != null && semanticPrefScore >= 0.55) {
      return {
        dimension: 'industry', label: '行业背景',
        score: Math.round(45 + semanticPrefScore * 45),
        weight: w, status: 'partial',
        note: '行业语义相关（' + Math.round(semanticPrefScore * 100) + '%）',
      };
    }
    if (!companies.trim()) {
      return { dimension: 'industry', label: '行业背景', score: 0, weight: w, status: 'partial', available: false, note: '未采集到公司/行业信息' };
    }
    return { dimension: 'industry', label: '行业背景', score: 38, weight: w, status: 'partial', note: '无明显匹配行业' };
  }

  // 公司层级
  function scoreCompanyTier(c, jd, w) {
    // v3：基线 45，增减幅放大——有信息时把层级差异真拉开（原版 ±5/10 全挤在 55-80）
    var score = 45;
    var notes = [];
    var allText = [c.companySize, c.companyStage, c.company, c.companyTag, c.companyBio].filter(Boolean).join(' ');
    // 一个字都没采集到就别硬给常数——那会让所有人都背上同一个分，把区分度冲掉
    if (!allText.trim()) {
      return { dimension: 'companyTier', label: '公司层级', score: 0, weight: w, status: 'partial', available: false, note: '未采集到公司信息' };
    }

    // 规模分
    if (allText.match(/10000人以上|万人/)) { score += 28; notes.push('万人级'); }
    else if (allText.match(/1000[-–—]9999人|千[人余]/)) { score += 20; notes.push('千人级'); }
    else if (allText.match(/500[-–—]999人/)) { score += 13; notes.push('中大型'); }
    else if (allText.match(/100[-–—]499人/)) { score += 6; notes.push('中型'); }
    else if (allText.match(/\d+[-–—]?\d+人/) && allText.match(/[0-9]+\s*[-–—]\s*[0-9]+人/) && allText.match(/[0-9]+/)[0] < 50) {
      score -= 15; notes.push('小微');
    }

    // 融资/上市阶段
    if (allText.match(/上市|纳斯达克|港股|A股|NYSE|NASDAQ|HKEx/)) { score += 18; notes.push('上市'); }
    else if (allText.match(/D轮|E轮|F轮|Pre-IPO/)) { score += 12; notes.push('成熟期'); }
    else if (allText.match(/C轮|B轮/)) { score += 6; notes.push('成长期'); }
    else if (allText.match(/A轮|天使轮|未融资/)) { score -= 8; notes.push('早期'); }

    // 国企/外企/合资
    if (allText.match(/国企|央企|国有|国资委/)) { score += 10; notes.push('国企'); }
    if (allText.match(/外资|外企|外商独资|合资|500强|世界500/)) { score += 12; notes.push('外资/500强'); }

    // JD 偏好/避开
    var tierConf = jd.companyTier || {};
    if (tierConf.prefer && tierConf.prefer.length && c.company) {
      var m = matchKeywords(c.company, tierConf.prefer);
      if (m.count > 0) { score += 20; notes.push('偏好:' + m.hit.join(',')); }
    }
    if (tierConf.avoid && tierConf.avoid.length && c.company) {
      var a = matchKeywords(c.company, tierConf.avoid);
      if (a.count > 0) { score -= 30; notes.push('避开:' + a.hit.join(',')); }
    }

    score = Math.max(5, Math.min(100, score));
    return { dimension: 'companyTier', label: '公司层级', score: score, weight: w, status: notes.length ? 'match' : 'partial', note: notes.join(' ') || '无足够信息' };
  }

  function scoreSalary(c, jd, w) {
    if (!c.salary) {
      return { dimension: 'salary', label: '薪资', score: 0, weight: w, status: 'partial', available: false, note: '无薪资信息' };
    }
    // JD 压根没设预算 → 维度不适用（原版没有预算也给 90"在预算内"，是人人一样的假高分）
    if (jd.basic.salaryMax == null && jd.basic.salaryMin == null) {
      return { dimension: 'salary', label: '薪资', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未设预算' };
    }
    var parsed = parseSalary(c.salary);
    if (!parsed) {
      return { dimension: 'salary', label: '薪资', score: 0, weight: w, status: 'partial', available: false, note: c.salary + '（无法解析，不计入加权）' };
    }
    var jdMax = jd.basic.salaryMax != null ? jd.basic.salaryMax : Infinity;
    var jdMin = jd.basic.salaryMin != null ? jd.basic.salaryMin : 0;
    if (parsed.min <= jdMax && parsed.max >= jdMin) {
      return { dimension: 'salary', label: '薪资', score: 92, weight: w, status: 'match', note: c.salary + '，在预算内' };
    }
    if (parsed.min > jdMax) {
      var over = parsed.min - jdMax;
      var sc = Math.max(10, 62 - over * 7);
      return { dimension: 'salary', label: '薪资', score: sc, weight: w, status: 'miss', note: c.salary + '，超出预算' + jdMax + 'K' };
    }
    // 期望低于预算下限：便宜但可能级别不够，轻微保留
    return { dimension: 'salary', label: '薪资', score: 76, weight: w, status: 'partial', note: c.salary + '，低于预算下限' };
  }

  // 地理位置：增加同省梯度
  function scoreLocation(c, jd, w) {
    if (!jd.basic.city || jd.basic.city === '全国') {
      return { dimension: 'location', label: '地理位置', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未限城市' };
    }
    if (!c.city) {
      return { dimension: 'location', label: '地理位置', score: 0, weight: w, status: 'partial', available: false, note: '无城市信息' };
    }
    if (c.city.indexOf(jd.basic.city) !== -1 || jd.basic.city.indexOf(c.city) !== -1) {
      return { dimension: 'location', label: '地理位置', score: 98, weight: w, status: 'match', note: c.city };
    }
    // 同省梯度：判断两个城市是否同属一个省（简化启发式）
    var sameProvince = isSameProvince(c.city, jd.basic.city);
    if (sameProvince) {
      return { dimension: 'location', label: '地理位置', score: 52, weight: w, status: 'partial', note: c.city + '（同省）' };
    }
    return { dimension: 'location', label: '地理位置', score: 12, weight: w, status: 'miss', note: c.city + ' ≠ ' + jd.basic.city };
  }

  // 简化的同省判断：用常见省/市名前缀匹配
  function isSameProvince(cityA, cityB) {
    // 直辖市特殊处理
    var directCities = ['北京', '上海', '天津', '重庆', '深圳', '广州'];
    for (var i = 0; i < directCities.length; i++) {
      if (cityA.indexOf(directCities[i]) !== -1 && cityB.indexOf(directCities[i]) !== -1) return true;
    }
    // 提取省名（含「省」字的省）
    var provincePairs = [
      ['广东', '广州', '深圳', '珠海', '东莞', '佛山', '中山', '惠州', '汕头'],
      ['浙江', '杭州', '宁波', '温州', '嘉兴', '绍兴', '金华', '台州'],
      ['江苏', '南京', '苏州', '无锡', '常州', '南通', '扬州', '徐州'],
      ['四川', '成都', '绵阳', '德阳', '宜宾', '泸州'],
      ['湖北', '武汉', '宜昌', '襄阳', '荆州'],
      ['湖南', '长沙', '株洲', '湘潭', '岳阳'],
      ['福建', '福州', '厦门', '泉州', '漳州'],
      ['山东', '济南', '青岛', '烟台', '潍坊', '威海'],
      ['河南', '郑州', '洛阳', '开封', '新乡'],
      ['河北', '石家庄', '唐山', '保定', '廊坊'],
      ['安徽', '合肥', '芜湖', '蚌埠', '马鞍山'],
      ['江西', '南昌', '九江', '赣州', '宜春'],
      ['陕西', '西安', '咸阳', '宝鸡'],
      ['辽宁', '沈阳', '大连', '鞍山'],
      ['黑龙江', '哈尔滨', '大庆', '齐齐哈尔'],
      ['吉林', '长春', '吉林', '延边'],
      ['云南', '昆明', '大理', '丽江'],
      ['贵州', '贵阳', '遵义', '六盘水'],
      ['广西', '南宁', '桂林', '柳州'],
      ['山西', '太原', '大同', '临汾'],
      ['甘肃', '兰州', '天水', '酒泉'],
      ['内蒙', '呼和浩特', '包头', '鄂尔多斯'],
      ['新疆', '乌鲁木齐', '喀什'],
      ['海南', '海口', '三亚'],
      ['宁夏', '银川', '石嘴山'],
      ['青海', '西宁', '海东'],
      ['西藏', '拉萨', '林芝'],
    ];
    for (var p = 0; p < provincePairs.length; p++) {
      var foundA = false, foundB = false;
      for (var c = 0; c < provincePairs[p].length; c++) {
        if (cityA.indexOf(provincePairs[p][c]) !== -1) foundA = true;
        if (cityB.indexOf(provincePairs[p][c]) !== -1) foundB = true;
      }
      if (foundA && foundB) return true;
    }
    // 省名直接匹配
    if (cityA.indexOf('省') !== -1 && cityB.indexOf('省') !== -1) {
      var a = cityA.substring(0, cityA.indexOf('省') + 1);
      var b = cityB.substring(0, cityB.indexOf('省') + 1);
      if (a === b) return true;
    }
    return false;
  }

  // 年龄维度。
  //
  // 设计原则：**只在 JD 明确声明了年龄区间（basic.ageMin/ageMax）时才参与评分**，
  // 没声明就整个维度退出加权（available:false）。理由有两条，一条实务一条合规：
  //   · 实务：没有岗位依据的年龄偏好不是"匹配度"，把它算进分只会污染排序；
  //   · 合规：就业年龄歧视在国内有实际法律风险，把判据绑定到 JD 的明示要求上，
  //     既可审计（每条打分都带 note 说明依据），也把责任落在岗位定义而不是隐式规则里。
  // 命中区间给高分，越界按距离线性衰减而不是一刀切，避免边界上 1 岁之差断崖。
  function scoreAge(c, jd, w) {
    var lo = jd.basic.ageMin;
    var hi = jd.basic.ageMax;
    if (lo == null && hi == null) {
      return { dimension: 'age', label: '年龄', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未设年龄要求' };
    }
    if (c.age == null) {
      return { dimension: 'age', label: '年龄', score: 0, weight: w, status: 'partial', available: false, note: '无年龄信息' };
    }
    var a = c.age;
    var min = lo != null ? lo : -Infinity;
    var max = hi != null ? hi : Infinity;
    if (a >= min && a <= max) {
      return { dimension: 'age', label: '年龄', score: 95, weight: w, status: 'match', note: a + '岁，符合要求' };
    }
    var over = a > max ? a - max : min - a;
    var sc = Math.max(20, 85 - over * 12); // 每超 1 岁扣 12 分，地板 20
    return {
      dimension: 'age', label: '年龄', score: Math.round(sc), weight: w, status: over <= 2 ? 'warn' : 'miss',
      note: a + '岁，要求' + (lo != null ? lo : '不限') + '-' + (hi != null ? hi : '不限') + '岁',
    };
  }

  // 项目经验维度（新增）
  function scoreProjects(c, jd, w) {
    var jdDuty = (jd.responsibilities && jd.responsibilities.length) ? jd.responsibilities.join(' ') : '';
    var jdRequirements = (jd.keywords && jd.keywords.required) ? jd.keywords.required.join(' ') : '';
    var jdText = jdDuty || jdRequirements;

    if (!c.projects || !c.projects.length) {
      // 没有项目经历时，如果有工作经历描述，用工作经历文本代替
      var workText = (c.workHistory || []).map(function (x) { return (x.description || ''); }).join(' ');
      if (!workText && !jdText) {
        return { dimension: 'projects', label: '项目经验', score: 0, weight: w, status: 'partial', available: false, note: '无项目信息' };
      }
      if (!jdText) {
        return { dimension: 'projects', label: '项目经验', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD无职责描述' };
      }
      if (!workText) {
        return { dimension: 'projects', label: '项目经验', score: 0, weight: w, status: 'partial', available: false, note: '未采集到项目/工作经历' };
      }
    }

    var projText = (c.projects || []).map(function (p) {
      return [p.name, p.desc, p.role, (p.tech || []).join(' ')].filter(Boolean).join(' ');
    }).join(' ');
    if (!projText && c.workHistory) {
      projText = (c.workHistory || []).map(function (x) { return (x.description || ''); }).join(' ');
    }

    if (!projText || !jdText) {
      return { dimension: 'projects', label: '项目经验', score: 0, weight: w, status: 'partial', available: false, note: '信息不足' };
    }

    // 关键词命中（基础分）。v3：命中率过 1.2 次幂 ×85——项目正文里出现必选词
    // 是很强的证据，全中应逼近满幅；一半命中 ≈ 37 而不是原来的 30+20=50 中庸值
    var projKeywords = matchKeywords(projText, jd.keywords.required || []);
    var kwTotal = (jd.keywords.required && jd.keywords.required.length) || 0;
    var kwScore = kwTotal > 0 ? Math.pow(projKeywords.count / kwTotal, 1.2) * 85 : 40;

    // 语义匹配（加分）
    var semScore = null;
    if (hasSemantic()) {
      semScore = semanticSim(projText, jdText);
      if (semScore != null) {
        var finalScore = Math.round(kwScore * 0.5 + semScore * 100 * 0.5);
        return {
          dimension: 'projects', label: '项目经验',
          score: Math.max(0, Math.min(100, finalScore)),
          weight: w, status: finalScore >= 70 ? 'match' : finalScore >= 50 ? 'partial' : 'miss',
          note: '关键词命中 ' + projKeywords.count + '项，语义相似度 ' + Math.round(semScore * 100) + '%',
          projectCount: c.projects ? c.projects.length : 0,
        };
      }
    }

    // 无语义时纯关键词 + 项目数量小加成（边际递减，封顶 +12）
    var pc = c.projects ? c.projects.length : 0;
    var final2 = Math.round(Math.min(100, kwScore + Math.min(12, pc * 4)));
    return {
      dimension: 'projects', label: '项目经验',
      score: final2,
      weight: w,
      status: final2 >= 65 ? 'match' : final2 >= 40 ? 'partial' : 'miss',
      note: '关键词命中 ' + projKeywords.count + '/' + kwTotal,
      projectCount: pc,
    };
  }

  // ===================== v3 新维度 =====================

  // bigram Dice 相似度（中文友好、零依赖）。空串/单字回退到包含判断。
  function _bigramSet(s) {
    var out = {}; var n = 0;
    for (var i = 0; i < s.length - 1; i++) { var b = s.substr(i, 2); if (!out[b]) { out[b] = 1; n++; } }
    return { set: out, n: n };
  }
  function diceSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) ? 0.8 : 0;
    var A = _bigramSet(a), B = _bigramSet(b);
    var inter = 0;
    for (var k in A.set) { if (Object.prototype.hasOwnProperty.call(A.set, k) && B.set[k]) inter++; }
    if (!A.n || !B.n) return 0;
    return (2 * inter) / (A.n + B.n);
  }
  // 职位标题归一：去空白/标点/资历前后缀，只留职能与领域词
  function normTitle(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/[\s/\\|·．.。，,()（）\-—_~～【】\[\]]+/g, '')
      .replace(/(高级|资深|中级|初级|见习|助理|实习生|实习|专员|主管|经理|总监|leader|senior|junior|intern)/g, '');
  }
  // 职能族：跨写法的粗粒度对齐（"测试工程师"与"资深测试开发工程师"同族）。
  // 同族托底、异族封顶——职能对不上时不允许字面巧合把分抬高。
  // 2026-08-17 修复（roleFamily 顺序 bug）：原顺序里 ['开发','研发','程序','软件'] 在
  // ['项目','pmo'] 之前，导致「软件项目经理」归一化后含「软件」→ 先命中开发族，而「it项目经理」
  // 含「项目」→ 命中项目族；同是项目经理却被判异族，0.62 同族托底不生效，A 候选人(it项目经理 vs
  // 软件项目经理)只拿 39 分、卡片/详情双双误杀。把项目族提到开发族之前：「软件项目经理」先
  // 命中「项目」→ 项目族，「it项目经理」→ 项目族，同族 → 托底生效。「软件开发工程师」不含
  // 「项目」，仍落开发族，不受影响。
  var ROLE_FAMILIES = [
    ['项目', 'pmo', '项目经理'], ['测试', 'qa', '质量'], ['前端'], ['后端', '服务端'],
    ['算法'], ['数据'], ['嵌入式', '单片机', 'mcu'], ['硬件'],
    ['开发', '研发', '程序', '软件'], ['产品'], ['运营'], ['设计', 'ui', 'ue', '视觉'],
    ['销售', '客户'], ['人力', 'hr', '招聘'], ['财务', '会计', '审计'], ['采购', '供应链'],
  ];
  function roleFamily(t) {
    for (var i = 0; i < ROLE_FAMILIES.length; i++) {
      for (var j = 0; j < ROLE_FAMILIES[i].length; j++) {
        if (t.indexOf(ROLE_FAMILIES[i][j]) !== -1) return i;
      }
    }
    return -1;
  }
  // 领域归一：把职位里的行业领域词归到粗粒度领域标签，用于同族托底的领域感知（见 scorePositionFit）。
  // 同族 + 同领域 = 高置信同义（如 it项目经理 vs 软件项目经理，都是「软件/IT 领域的项目经理」）；
  // 同族但领域明确不同（如 财务项目管理 vs 软件项目经理）= 跨域，不许靠同族托底抬高。
  // 标签只用于「判断两边是不是同一个领域」，不参与打分本身，因此不必穷举行业。
  // 你所在行业的关键词若要参与对齐，配在岗位的 domain.keywords 里（那里才真正影响 domainFit）。
  function canonicalDomain(t) {
    var s = String(t || '').toLowerCase();
    if (/\bit\b|互联网|软件|数字化|信息/.test(s)) return 'sw';
    if (/制造|工厂|产线|供应链|质量/.test(s)) return 'mfg';
    if (/财务|会计|税务|审计|核算/.test(s)) return 'fin';
    if (/销售|商务|渠道|客户/.test(s)) return 'sales';
    if (/人力|招聘|人事|hr/.test(s)) return 'hr';
    return '';
  }

  // 职位匹配（v3 新增）：期望职位 vs JD 标题——卡片层最强的单一信号。
  // ATS 工业实践里 job title 相关性是与技能并列的头部特征；旧版完全没用它，
  // 卡片层只能靠技能标签碰运气，是"人人 50-65"的直接成因之一。
  function scorePositionFit(c, jd, w) {
    var targets = [];
    if (jd.title) targets.push(jd.title);
    if (jd.name && jd.name !== jd.title) targets.push(jd.name);
    if (!targets.length) {
      return { dimension: 'positionFit', label: '职位匹配', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD无标题' };
    }
    var cand = normTitle(c.position);
    if (!cand) {
      return { dimension: 'positionFit', label: '职位匹配', score: 0, weight: w, status: 'partial', available: false, note: '无期望职位' };
    }
    var best = 0, bestT = '';
    for (var i = 0; i < targets.length; i++) {
      var t = normTitle(targets[i]);
      if (!t) continue;
      var s = diceSim(cand, t);
      if (cand.indexOf(t) !== -1 || t.indexOf(cand) !== -1) s = Math.max(s, 0.82);
      var sem = semanticSim(c.position, targets[i]);
      if (sem != null) s = Math.max(s, sem * 0.95);
      // 职能族对齐（2026-08-17 领域感知改造）：
      //   · 同族 + 同领域（两侧领域都明确且相同，或任一侧无领域信号）→ 托底 0.62。
      //     it项目经理 vs 软件项目经理：都是 sw 领域的项目族 → 托底生效（修 roleFamily bug 后两者同族）。
      //   · 同族但两侧领域明确且不同（汽车项目管理 vs 软件项目经理：auto vs sw）→ 不给托底，
      //     让 dice 自然低，挡住跨域同族字面巧合被抬（B 候选人「跨域项目管理」不误升）。
      //   · 两侧职能族都明确但不同 → 封顶 0.35。
      // 任一侧无领域信号时仍按旧行为托底（向后兼容「产品经理」vs「B端产品经理」这类一侧无
      // 领域词的合理部分匹配，不回退到只看负向词的粗判）。
      var fa = roleFamily(cand), fb = roleFamily(t);
      var dc = canonicalDomain(c.position), dt = canonicalDomain(targets[i]);
      var domainConsistent = (dc === dt) || !dc || !dt;
      if (fa !== -1 && fa === fb && domainConsistent) s = Math.max(s, 0.62);
      else if (fa !== -1 && fb !== -1 && fa !== fb) s = Math.min(s, 0.35);
      if (s > best) { best = s; bestT = targets[i]; }
    }
    var score = Math.round(Math.pow(best, 0.85) * 100);
    return {
      dimension: 'positionFit', label: '职位匹配', score: score, weight: w,
      status: score >= 75 ? 'match' : score >= 45 ? 'partial' : 'miss',
      note: (c.position || '') + ' vs ' + bestT + '（相似 ' + Math.round(best * 100) + '%）',
    };
  }

  // 稳定性（v3 新增，详情层）：平均在职时长。跳槽频繁是 sourcing 实操里的一票关注项。
  // 卡片层拿不到完整履历 → 标 notApplicable（不拖累卡片层覆盖度）；
  // 详情层有 ≥2 段经历且有总年限时才计算，否则 available:false 如实进覆盖度。
  function scoreStability(c, jd, w, tier) {
    if (tier === 'card') {
      return { dimension: 'stability', label: '稳定性', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: '卡片层不评估' };
    }
    var n = (c.workHistory || []).length;
    if (n < 2 || c.experienceYears == null || c.experienceYears <= 0) {
      return { dimension: 'stability', label: '稳定性', score: 0, weight: w, status: 'partial', available: false, note: '履历段数/年限不足' };
    }
    var avg = c.experienceYears / n;
    var score, status, desc;
    if (avg >= 3) { score = 95; status = 'match'; desc = '平均在职 ' + avg.toFixed(1) + ' 年，稳定'; }
    else if (avg >= 2) { score = 82; status = 'match'; desc = '平均在职 ' + avg.toFixed(1) + ' 年'; }
    else if (avg >= 1.2) { score = 58; status = 'partial'; desc = '平均在职 ' + avg.toFixed(1) + ' 年，偏短'; }
    else if (avg >= 0.8) { score = 35; status = 'warn'; desc = '平均在职 ' + avg.toFixed(1) + ' 年，跳槽偏频繁'; }
    else { score = 18; status = 'miss'; desc = '平均在职 ' + avg.toFixed(1) + ' 年，跳槽频繁'; }
    return { dimension: 'stability', label: '稳定性', score: score, weight: w, status: status, note: desc };
  }

  // ===================== v4 新维度：domainFit / taskCoverage / researchOutput =====================
  //
  // 【应用域匹配 domainFit】
  // 设计：JD 声明一个核心域 D（platform + viewpoint + scenes + sensors 描述），
  // 候选人的每段经历/项目独立判断"落在哪个域"——用 jd.domain 给出的 adjacent[] 与 distant[]
  // 以及各域的平台/视角/场景关键词做文本匹配。逐段打分，按段长加权取平均，避免"一段异域经历把全
  // 文污染成同域"或"一段同域经历把全文救回来"的问题。
  //
  // 域距离四档：
  //   same      = 同域（平台+场景+视角都对上）→ 全额分
  //   adjacent  = 相邻域（同一大方向下的相邻应用场景）→ 中度分
  //   distant   = 远域（另一个不相干的业务场景）→ 低分
  //   none      = 无域信号 → 不计入
  //
  // 为什么不用语义模型：评分引擎要在插件 isolated world 里跑，没有语义 provider 兜底，
  // 必须纯关键词。JD 的 domain 配置本身就是关键词集合，配置者可以显式决定哪些算相邻/远域。
  //
  // 同域关键词：从 jd.domain 的 platform/viewpoint/scenes/sensors + industry 构造。
  // adjacent 关键词来自 jd.domain.adjacent[]，distant 关键词来自 jd.domain.distant[]。
  // 为了避免平台短词（如 "服务端"）误伤，我们对每段文本同时检查：
  //   · 命中同域词 ≥1 个 → same
  //   · 未命中同域，但命中相邻词 ≥1 → adjacent
  //   · 命中远域词 ≥1 → distant
  //   · 三者都没有 → none
  // 冲突优先级：distant > same > adjacent（一段里同时说"做过金融风控，也做过电商推荐"
  //   我们优先按远域折扣——保守给分，避免"两边都沾"的人被错误推高）。
  //   注：这里实际算法是"段级独立打标 + 段级累计权重"，所以冲突发生在段内时按上述优先级；
  //   跨段不冲突：金融段归金融、电商段归电商，按段长度加权平均。

  // 通用平台近义词：当 JD 写了 platform: "服务端" 时，这些词也视作同域信号。
  // 这里只放最通用的几种写法，避免过宽（比如不把"公司"算作"平台"的同域）。
  // 你所在行业特有的平台/载体会话，请加进 JD 的 domain.keywords —— 那才是本岗位真正生效的域信号。
  var PLATFORM_SYNONYMS = {
    '服务端': ['服务端', '后端', 'server', '云端', '服务集群'],
    '移动端': ['移动端', 'app', '手机', '客户端', '移动终端'],
    'web前端': ['web', '前端', '浏览器', 'h5', '页面端'],
    '桌面端': ['桌面端', '客户端', 'desktop', 'windows', 'mac'],
    '嵌入式': ['嵌入式', '固件', '硬件', '单片机', '设备端'],
    '机器人': ['机器人', 'robot', 'agv', 'amr', '机械臂', '无人车'],
    '云平台': ['云平台', '公有云', '私有云', 'k8s', '云原生'],
  };
  // scenes / viewpoint 的通用近义词：与上面同样的原则——只收最主流写法。
  var SCENE_SYNONYMS = {
    '在线交易': ['在线', '实时', '交易', '下单', '支付'],
    '批量处理': ['批量', '离线', '定时', '跑批', '对账'],
    '核心链路': ['核心', '主链路', '主干', '大促', '峰值'],
    '后台管理': ['后台', '管理端', 'b端', '中后台', '运营平台'],
    '面向用户': ['to c', 'toc', '用户端', '消费者'],
    '面向企业': ['to b', 'tob', '企业端', '商用'],
  };
  var SENSOR_SYNONYMS = {
    '数据采集': ['埋点', '采集', '日志', '上报'],
    '监控告警': ['监控', '告警', '可观测', '看板'],
  };

  // 展开同义词：把一个关键词数组按 PLATFORM/SCENE/SENSOR_SYNONYMS 展开，
  // 返回去重后的扁平数组。大小写已统一在 matchKeywords 里处理，这里保留原大小写即可。
  function expandSynonyms(kws, map) {
    var out = [];
    var seen = {};
    function add(w) {
      var k = String(w || '').trim().toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = 1;
      out.push(w);
    }
    for (var i = 0; i < kws.length; i++) {
      var w = kws[i];
      add(w);
      if (!map) continue;
      for (var key in map) {
        if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
        // 若关键词命中 map 的 key（即这个词是我们认识的领域词），把它的近义词全部加入
        if (w === key || w.indexOf(key) !== -1 || key.indexOf(w) !== -1) {
          for (var j = 0; j < map[key].length; j++) add(map[key][j]);
        }
      }
    }
    return out;
  }

  // 构造 JD 的域关键词集合同域/相邻/远域三套 + 同域锚点词（用来判定"这段是同域"的强信号）。
  //
  // ⚠️ 关键设计：通用能力词（如"监控告警"）虽然是同域特征，但很多域都在用，
  // 仅凭一个"监控"或"报表"出现在技能标签里，不能判定这个候选人
  // 就在做核心交易链路。所以把 same 集合拆成两层：
  //   same         = 全部同域词（锚点+传感器+同义词），用于"段已经判为同域后再做关键词命中计数"
  //   sameAnchor   = 仅平台/视角/场景/行业强锚点，用于"判定这个段属于哪个域"
  // 判定段为 same 时，必须至少命中 1 个 sameAnchor；只命中 sensor 词而没有锚点词，归入 other。
  // adjacent/distant 不拆：这两类词本身就是强域锚点（"支付""风控"一旦出现就是明确的域）。
  function buildDomainKwSets(domain) {
    if (!domain) return null;
    var anchor = [];     // 强域锚点：platform/viewpoint/scenes/industry
    var sensors = [];    // 传感器弱信号
    if (domain.industry) anchor.push(domain.industry);
    if (domain.platform) anchor.push(domain.platform);
    if (domain.viewpoint) anchor.push(domain.viewpoint);
    if (domain.scenes && domain.scenes.length) { for (var s = 0; s < domain.scenes.length; s++) anchor.push(domain.scenes[s]); }
    if (domain.sensors && domain.sensors.length) { for (var sn = 0; sn < domain.sensors.length; sn++) sensors.push(domain.sensors[sn]); }
    var adj = (domain.adjacent || []).slice();
    var dist = (domain.distant || []).slice();
    // 2026-08-07 修：原实现把 adj 并进 anchorAll，下面第 1024 行又用 anchorAll 过滤 adj，
    // 而两者经过同一组同义词展开，adj ⊆ anchorAll 恒成立 → adjClean 恒为空数组，
    // classifySegment 的 adjacent 分支永不可达，相邻域一律按同域走 92 档。
    // 这正是「相邻域排不开」的一半成因：相邻域不该拿满分。
    // 现在 sameAnchor 只由强域锚点（industry/platform/viewpoint/scenes）构成，adjacent 独立成档。
    var anchorAll = expandSynonyms(anchor, PLATFORM_SYNONYMS);
    anchorAll = expandSynonyms(anchorAll, SCENE_SYNONYMS);
    // adjacent 词本身展开后也用作"adjacent 段"判定
    adj = expandSynonyms(adj, PLATFORM_SYNONYMS);
    adj = expandSynonyms(adj, SCENE_SYNONYMS);
    // 传感器词单独展开，但不进 anchor 集合
    sensors = expandSynonyms(sensors, SENSOR_SYNONYMS);
    sensors = expandSynonyms(sensors, SCENE_SYNONYMS);
    dist = expandSynonyms(dist, PLATFORM_SYNONYMS);
    var sameFull = anchorAll.concat(sensors);
    // 去 adjacent 里已经在 dist 里的词
    function inArr(x, arr) {
      var xl = String(x).toLowerCase();
      for (var i = 0; i < arr.length; i++) if (String(arr[i]).toLowerCase() === xl) return true;
      return false;
    }
    var adjClean = [];
    for (var a = 0; a < adj.length; a++) { if (!inArr(adj[a], anchorAll) && !inArr(adj[a], dist)) adjClean.push(adj[a]); }
    return { same: sameFull, sameAnchor: anchorAll, sensors: sensors, adjacent: adjClean, distant: dist };
  }

  // 给一段文本打域标签：返回 'same' / 'adjacent' / 'distant' / 'none'。
  // 冲突优先级：distant > same > adjacent（保守给分——一段里既说金融又说电商时按远域算）。
  // 判定 same 时必须命中至少 1 个 sameAnchor（强域锚点）；只命中传感器词不算 same。
  function classifySegment(segText, sets) {
    if (!segText || !sets) return 'none';
    var hitDistant = matchKeywords(segText, sets.distant).count > 0;
    if (hitDistant) return 'distant';
    var hitAnchor = matchKeywords(segText, sets.sameAnchor).count > 0;
    if (hitAnchor) return 'same';
    var hitAdj = matchKeywords(segText, sets.adjacent).count > 0;
    if (hitAdj) return 'adjacent';
    return 'none';
  }

  function scoreDomainFit(c, jd, w, tier) {
    var dom = jd.domain;
    if (!dom) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未配置应用域' };
    }
    var sets = buildDomainKwSets(dom);
    if (!sets || (!sets.same.length && !sets.adjacent.length && !sets.distant.length)) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD域配置为空' };
    }

    // card 层：只能用 position / company / skills / selfIntro，拿不到完整经历描述，
    // 域信号很弱——只在 company 名或期望职位明确写出了同域/远域词时才给判断，否则 available:false。
    var segs;
    if (tier === 'card') {
      segs = [];
      if (c.position) segs.push({ kind: 'profile', text: c.position, weight: 1.0 });
      if (c.company) segs.push({ kind: 'company', text: c.company, weight: 1.2 });
      if (c.skills && c.skills.length) segs.push({ kind: 'skills', text: c.skills.join(' '), weight: 0.4 });
      if (c.selfIntro) segs.push({ kind: 'selfIntro', text: c.selfIntro, weight: 0.5 });
    } else {
      segs = buildSegmentedText(c);
    }
    if (!segs.length) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, note: '无文本可用于域判定' };
    }

    // 逐段分类加权
    var wSame = 0, wAdj = 0, wDist = 0, wNone = 0;
    var segEvid = { same: [], adjacent: [], distant: [] };
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var cls = classifySegment(seg.text, sets);
      // 段文本长度参与权重：10 字以下的公司名短句别跟一段 300 字的经历描述等权。
      // 启发式：长度 0-60 字线性插值 0.3→1.0，60 字以上封顶 1.0。
      var len = String(seg.text).length;
      var lenW = len < 10 ? 0.3 : len < 60 ? 0.3 + 0.7 * (len - 10) / 50 : 1.0;
      var sw = seg.weight * lenW;
      if (cls === 'same') { wSame += sw; segEvid.same.push(seg.kind); }
      else if (cls === 'adjacent') { wAdj += sw; segEvid.adjacent.push(seg.kind); }
      else if (cls === 'distant') { wDist += sw; segEvid.distant.push(seg.kind); }
      else { wNone += sw; }
    }
    var total = wSame + wAdj + wDist + wNone;
    if (total <= 0) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, note: '无域信号' };
    }
    // card 层若有信号段权重占比 < 30%，视为"信号太弱"——available:false 退出加权，
    // 避免凭一条公司名里的两个字就给出 80+ 的误判。
    var signalRatio = (wSame + wAdj + wDist) / total;
    if (tier === 'card' && signalRatio < 0.3) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, note: '卡片层域信号不足' };
    }
    var rSame = wSame / total, rAdj = wAdj / total, rDist = wDist / total, rNone = wNone / total;

    // 【启发式】段级域信号传播：
    // 适用边界：当候选人【完全没有同域段】且远域段占比 ≥30% 时，没有域锚点词的段（skills 标签、
    // 项目名称里没写具体域）有较大概率是和远域工作同期做的（技能标签是整段工作的技能，
    // 不是独立于行业的抽象技能），把 none 段按"半信远域"处理——none 权重的一半并入远域、
    // 另一半保留中性。避免"异域候选人的技能标签段全给 55 中性分"抬高总分。
    // 失效场景：跨行业跳槽且老经历没写域词时，可能把中性段错归为远域。此时该候选人本来就复杂，
    // 给保守低分合理——详情层可以让 recruiter 看到任务点覆盖 note 后自行判断。
    // 当候选人【有同域段】时，不做传播——同域才是主方向，none 段保持中性更安全。
    var inferredDist = 0;
    if (wSame < 0.01 && rDist >= 0.3 && rNone > 0) {
      inferredDist = rNone * 0.5;
      rNone = rNone - inferredDist;
      rDist = rDist + inferredDist;
    }

    // 分数：same 段贡献 92、adjacent 贡献 55、distant 贡献 22、none 贡献 55（中性，不奖不罚）。
    // 常数基于通用招聘语义：同域=强对口、相邻=可迁移（给 55 而不是 50 略抬）、远域=要重新学
    // （给 22 而不是 15：保留"技术硬实力可迁移"的基础分，不至于让"域不对"把总分压到 30）。
    var score = Math.round(rSame * 92 + rAdj * 55 + rDist * 22 + rNone * 55);
    score = Math.max(0, Math.min(100, score));

    // 可解释 note：说清各档占比和证据来源
    var notes = [];
    if (rSame >= 0.1) notes.push('同域 ' + Math.round(rSame * 100) + '%（' + uniqJoin(segEvid.same) + '）');
    if (rAdj >= 0.1) notes.push('相邻域 ' + Math.round(rAdj * 100) + '%（' + uniqJoin(segEvid.adjacent) + '）');
    if (rDist >= 0.1) notes.push('远域 ' + Math.round(rDist * 100) + '%（' + uniqJoin(segEvid.distant) + (inferredDist > 0 ? '，含推断' : '') + '）');
    if (!notes.length) notes.push('无明确域信号');
    var status = score >= 75 ? 'match' : score >= 50 ? 'partial' : 'miss';
    return {
      dimension: 'domainFit', label: '应用域匹配', score: score, weight: w, status: status,
      note: notes.join('；'),
      // 暴露给硬技能/任务点维使用（M3）：这里返回的 rDist 包含推断部分，
      // 下游维也用这个传播后的比例——否则关键词/任务点在 none 段仍然按同域计，传播失效。
      _domainWeights: { same: rSame, adjacent: rAdj, distant: rDist, none: rNone },
    };
  }

  function uniqJoin(arr) {
    var seen = {}; var out = [];
    for (var i = 0; i < arr.length; i++) { if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); } }
    return out.join(',') || '—';
  }

  // 【JD 任务点覆盖 taskCoverage】（M2）
  //
  // 对每个 task（来自 jd.tasks）：
  //   direct   = 同域段命中关键词 → 按 task.weight 全额得分
  //   transfer = 异域（adjacent/distant）命中关键词 → 按折扣系数：
  //              · domainSensitive=true  + adjacent → 0.5（相邻域可迁移但要打五折）
  //              · domainSensitive=true  + distant  → 0.15（远域几乎不算，"支付风控"≠"推荐排序"）
  //              · domainSensitive=false + 任意异域 → 1.0（纯工程能力，哪里都能用，不打折）
  //   none     = 未命中 → 0
  //
  // 注意：判定"命中"用的是同域段的原文，不是全文——如果某词只在异域段出现，那它在该任务点
  // 最多算 transfer 分，而不是 direct 分。这是 M2 的核心：domainSensitive 任务要"同域+命中"
  // 才给 direct，异域命中一律折扣。
  //
  // 为什么折扣分两档（adjacent 0.5 / distant 0.15），不是统一 0：
  // 避免"一刀切压死异域候选人"——部署、性能优化这些非域敏感能力在别的域也是真本事，
  // 给它 1.0；核心链路的领域特有能力，异域做过的≠本域做过的，
  // 只是"补齐"不是本域深耕的，必须打狠折；相邻域做过同类机制、链路是通的，
  // 虽然没做过这个场景，但方法论与工程链路是可迁移的，给 0.5 合理。
  //
  // card 层：没有经历正文，taskCoverage 基本无证据 → notApplicable 退出加权，不进覆盖度分母。
  var TASK_DIRECT_SCORE = 1.0;
  var TASK_ADJ_SENSITIVE = 0.7;
  var TASK_DIST_SENSITIVE = 0.5;
  var TASK_TRANSFER_INSENSITIVE = 1.0;

  function scoreTaskCoverage(c, jd, w, tier) {
    var tasks = jd.tasks;
    if (!tasks || !tasks.length) {
      return { dimension: 'taskCoverage', label: '任务点覆盖', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未配置任务点' };
    }
    if (tier === 'card') {
      // 卡片层完全没有经历正文 → 任务点命中判定不可靠，整维退出
      return { dimension: 'taskCoverage', label: '任务点覆盖', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: '卡片层无法评估任务点覆盖' };
    }
    var segs = buildSegmentedText(c);
    if (!segs.length) {
      return { dimension: 'taskCoverage', label: '任务点覆盖', score: 0, weight: w, status: 'partial', available: false, note: '无经历/项目文本' };
    }
    // 先按段分组：同域段、相邻域段、远域段、未判域段（none/other）。
    var domSets = buildDomainKwSets(jd.domain || {});
    var sameText = '', adjText = '', distText = '', otherText = '';
    var sameSegs = [], adjSegs = [], distSegs = [], otherSegs = [];
    var wSame = 0, wAdj = 0, wDist = 0, wOth = 0;
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var cls = domSets ? classifySegment(seg.text, domSets) : 'none';
      var len = String(seg.text).length;
      var lenW = len < 10 ? 0.3 : len < 60 ? 0.3 + 0.7 * (len - 10) / 50 : 1.0;
      var sw = (seg.weight || 1) * lenW;
      if (cls === 'same') { sameText += ' ' + seg.text; sameSegs.push(seg); wSame += sw; }
      else if (cls === 'adjacent') { adjText += ' ' + seg.text; adjSegs.push(seg); wAdj += sw; }
      else if (cls === 'distant') { distText += ' ' + seg.text; distSegs.push(seg); wDist += sw; }
      else { otherText += ' ' + seg.text; otherSegs.push(seg); wOth += sw; }
    }
    // 【启发式】域信号传播：零同域 + 远域段权重 ≥30% → 把 other 段一半并入远域（与 scoreDomainFit 一致）。
    // 这让"技能标签/未写行业的项目"这些 none 段在整体远域背景下被正确当作远域处理，
    // 避免"分布式/高并发"这些出现在技能标签里时被算成"同域命中"。
    var totalSW = wSame + wAdj + wDist + wOth;
    var distInfer = 0;
    if (wSame < 0.01 && totalSW > 0 && wDist / totalSW >= 0.3 && wOth > 0) {
      // other 段文本按字符长度一半划入 distText（粗略：拼接后半段）
      distInfer = wOth * 0.5;
      wDist += distInfer; wOth -= distInfer;
      // 把 otherText 也并入一半给 distText（直接拼接——反正只是关键词命中检查，重复不影响）
      distText = distText + ' ' + otherText;
      otherText = '';
    }
    // 如果 domainFit 维完全没识别出同域/相邻/远域（domSets 空或都为 none），
    // 把所有文本当作"未判域"→ sameText，任务点命中按 direct 计——退化为纯关键词覆盖率，
    // 避免老 JD 不写 domain 时这一维全 0。
    var noDom = !domSets || (!sameText && !adjText && !distText);
    var fullText = sameText + ' ' + adjText + ' ' + distText + ' ' + otherText;
    if (noDom) { sameText = fullText; adjText = distText = otherText = ''; }

    // 逐任务点计分
    var totalW = 0, earnW = 0;
    var directHits = [], transferHits = [], misses = [];
    for (var t = 0; t < tasks.length; t++) {
      var task = tasks[t];
      var tw = task.weight || 1;
      var kws = task.keywords || [];
      if (!kws.length) { totalW += tw; earnW += tw * 0.5; continue; } // 没配关键词的任务给 0.5 中性分
      totalW += tw;
      var hitSame = matchKeywords(sameText, kws).count > 0;
      var hitAdj = !hitSame && adjText && matchKeywords(adjText, kws).count > 0;
      var hitDist = !hitSame && !hitAdj && distText && matchKeywords(distText, kws).count > 0;
      var hitOth = !hitSame && !hitAdj && !hitDist && otherText && matchKeywords(otherText, kws).count > 0;
      var hitAny = noDom ? matchKeywords(fullText, kws).count > 0 : (hitSame || hitAdj || hitDist || hitOth);
      if (!hitAny) {
        misses.push(task.label);
        continue;
      }
      if (hitSame || noDom) {
        earnW += tw * TASK_DIRECT_SCORE;
        directHits.push(task.label);
      } else if (hitOth) {
        // 出现在"未判域"段（技能标签、没写行业的项目）：
        //   · 有同域信号时（传播未触发）——保守按 adjacent 折扣，避免仅凭技能标签词给 direct；
        //   · 无同域但远域占比不高时（传播条件不满足）——仍按 adjacent 保守。
        // 非域敏感任务给全额，域敏感任务按 adjacent 折扣。
        if (!task.domainSensitive) { earnW += tw * TASK_TRANSFER_INSENSITIVE; transferHits.push(task.label + '(域无关,全计)'); }
        else { earnW += tw * TASK_ADJ_SENSITIVE; transferHits.push(task.label + '(未判域段×' + TASK_ADJ_SENSITIVE + ')'); }
      } else if (!task.domainSensitive) {
        // 异域命中但不敏感 → 全额
        earnW += tw * TASK_TRANSFER_INSENSITIVE;
        transferHits.push(task.label + '(域无关,全计)');
      } else if (hitAdj) {
        earnW += tw * TASK_ADJ_SENSITIVE;
        transferHits.push(task.label + '(相邻域×' + TASK_ADJ_SENSITIVE + ')');
      } else {
        // hitDist + domainSensitive
        earnW += tw * TASK_DIST_SENSITIVE;
        transferHits.push(task.label + '(远域×' + TASK_DIST_SENSITIVE + ')');
      }
    }
    if (totalW <= 0) {
      return { dimension: 'taskCoverage', label: '任务点覆盖', score: 50, weight: w, status: 'partial', note: '无有效任务点' };
    }
    // 覆盖率：把累计得分映射到 0-100。加一个幂次 0.9，让"覆盖一半任务点"不是 50 分而是 ~54 分，
    // 保持一点凸性但不激进——全中必须 100，零个命中必须贴近 0。
    var ratio = earnW / totalW;
    var score = Math.round(Math.pow(ratio, 0.9) * 100);
    score = Math.max(0, Math.min(100, score));

    var noteParts = [];
    if (directHits.length) noteParts.push('命中：' + directHits.join('、'));
    if (transferHits.length) noteParts.push('迁移：' + transferHits.join('、'));
    if (misses.length) noteParts.push('缺：' + misses.join('、'));
    var status = score >= 75 ? 'match' : score >= 45 ? 'partial' : 'miss';
    return {
      dimension: 'taskCoverage', label: '任务点覆盖', score: score, weight: w, status: status,
      note: noteParts.join('；'),
      directHits: directHits, transferHits: transferHits, misses: misses,
    };
  }

  // ===================== L4 汇总 + 可解释 =====================

  function extractHighlights(details) {
    var highlights = [];
    for (var i = 0; i < details.length; i++) {
      var d = details[i];
      // P1-20：available:false 的维恒为 score:0/status:'partial'（没数据），
      // 不是候选人的真实短板/亮点，必须剔除，否则"JD 未配置应用域"会冒充短板。
      if (d.notApplicable || d.available === false) continue;
      if (d.status === 'match' && d.score >= 85) {
        highlights.push({ label: d.label, note: d.note, score: d.score, dimension: d.dimension });
      }
    }
    // 按得分降序
    highlights.sort(function (a, b) { return b.score - a.score; });
    return highlights.slice(0, 3);
  }

  function extractGaps(details) {
    var gaps = [];
    for (var i = 0; i < details.length; i++) {
      var d = details[i];
      // P1-20：available:false 的维恒为 score:0/status:'partial'（没数据），
      // 且因升序排序会占满 gaps 前 3 位，把真实短板（硬技能/行业不符）挤掉。
      // 插件徽章直接渲染成「✗ 差距提示：应用域匹配：JD未配置应用域」——错误信息。
      if (d.notApplicable || d.available === false) continue;
      if (d.status === 'miss' || (d.status === 'partial' && d.score < 50)) {
        gaps.push({ label: d.label, note: d.note, score: d.score, dimension: d.dimension, severity: d.status === 'miss' ? 'hard' : 'soft' });
      }
    }
    // 按得分升序（最差的放前面）
    gaps.sort(function (a, b) { return a.score - b.score; });
    return gaps.slice(0, 3);
  }

  function extractSkills(keywordsDim) {
    return {
      exact: keywordsDim.exactHits || [],
      semantic: (keywordsDim.semanticHits || []).map(function (s) { return s.keyword + '(≈' + Math.round(s.sim * 100) + '%)'; }),
      bonus: keywordsDim.bonusHits || [],
      negative: keywordsDim.negativeHits || [],
      missingCount: keywordsDim.missed || 0,
    };
  }

  // ===================== 主入口 =====================

  function scoreCandidate(c, jd, thresholds, options) {
    var opts = options || {};
    // 就地改写入参会污染调用方（P1-22）：
    // 插件把 jdCache.jd 原对象递进来、rpa-engine 在无 scoreText 时把 card 本体递进去随后落库；
    // 传入 Object.freeze 的 jd/c 会直接抛 "Cannot add property basic"。
    // 归一化前先浅拷贝顶层——下面所有归一化都是整体重新赋值（jd.basic/jd.keywords/c.research），
    // 不就地改嵌套，所以浅拷贝足够且开销可忽略（对比深拷贝，避免 0.89ms/人 的性能劣化）。
    var jdInput = jd;
    var cInput = c;
    jd = jdInput && typeof jdInput === 'object' ? Object.assign({}, jdInput) : {};
    c = cInput && typeof cInput === 'object' ? Object.assign({}, cInput) : {};
    // JD 结构归一化（P1 修复：防止畸形 JD 抛 TypeError）。
    // keywords/industry 必须【重新构造】而不是浅拷贝引用：下面的 required/bonus/negative/
    // preferred/excluded 是就地赋值，若入参嵌套对象被 Object.freeze 会抛 "Cannot assign to
    // read only property"。构造全新对象即与入参彻底解耦（P1-22）。
    jd.basic = jd.basic || {};
    // P1-21：JD basic 数值字段强转（experienceMin/Max/ageMin/Max/salaryMin/Max）。
    // 脏值（'x'/NaN）→ null，参与比较时按"未设"处理，杜绝 `gap='x'-3=NaN`。
    if (jd.basic && typeof jd.basic === 'object') {
      jd.basic = Object.assign({}, jd.basic);
      jd.basic.experienceMin = numOrNull(jd.basic.experienceMin);
      jd.basic.experienceMax = numOrNull(jd.basic.experienceMax);
      jd.basic.ageMin = numOrNull(jd.basic.ageMin);
      jd.basic.ageMax = numOrNull(jd.basic.ageMax);
    }
    var jdKw = (jd.keywords && typeof jd.keywords === 'object') ? jd.keywords : {};
    // P1-21：required/bonus/negative 用 arrOf 清洗——`|| []` 挡不住非空标量（如 5），
    // 下面 jd.keywords.required.join 会 "join is not a function"。
    jd.keywords = {
      required: arrOf(jdKw.required),
      bonus: arrOf(jdKw.bonus),
      negative: arrOf(jdKw.negative),
    };
    var jdInd = (jd.industry && typeof jd.industry === 'object') ? jd.industry : {};
    jd.industry = { preferred: arrOf(jdInd.preferred), excluded: arrOf(jdInd.excluded) };
    jd.companyTier = jd.companyTier || {};
    // v4：domain/tasks/research 字段归一化（缺省不报错，整维 notApplicable 退出）。
    // P1-21：tasks 逐元素滤 null/非对象，避免下面 reading 'weight' 抛 TypeError。
    jd.domain = jd.domain || null;
    jd.tasks = arrOf(jd.tasks, true);
    // 候选人的数组字段同样清洗（P1-21）：skills 为字符串、workHistory/projects 含
    // null 元素、education 元素为标量，都是 658 例模糊测试里实测会抛的组合。
    c.skills = arrOf(c.skills);
    c.workHistory = arrOf(c.workHistory, true);
    c.projects = arrOf(c.projects, true);
    c.education = arrOf(c.education, true);
    // P1-21：候选人数值字段强转，字符串数字参与评分、脏值视为无信息。
    c.experienceYears = numOrNull(c.experienceYears);
    c.age = numOrNull(c.age);
    // 岗位职责归一化：引擎读顶层 jd.responsibilities，而平台的岗位库把它存在 jd.basic.responsibilities
    // （类型定义与 UI 都在 basic 下）。两边不一致时，用户在「岗位职责/核心工作」里填的内容
    // 【一个字都到不了引擎】。2026-08-03 审查查出，修在归一化处：落库位置不动，两处都认。
    //
    // 据实说明作用边界（别高估这条修复）：在 hasSemantic()==false（当前生产配置）下，
    // scoreProjects 只把 jdText 当"有没有依据"的门禁用，真正算分的是必选关键词命中率。
    // 所以只有【JD 没配必选关键词】时，这一栏才会改变结果（项目经验维从"信息不足/不计入"
    // 变成可评）。语义 provider 打开后它才直接参与算分。
    if ((!jd.responsibilities || !jd.responsibilities.length)
        && jd.basic && jd.basic.responsibilities && jd.basic.responsibilities.length) {
      jd.responsibilities = jd.basic.responsibilities;
    }
    if (c.research == null) c.research = null;

    var tpl = opts.weightTemplate ? WEIGHT_TEMPLATES[opts.weightTemplate] : WEIGHT_TEMPLATES.default;
    var weights = jd.weights || tpl;
    // v4：老 JD 保存的权重可能缺新键（domainFit/taskCoverage），用模板默认值兜底。
    // 不做整表替换：用户自定义过的键（如把 keywords 调 30）必须保留。
    var wDefaults = {
      positionFit: 12, domainFit: 21, taskCoverage: 22, keywords: 16, experience: 9,
      degree: 5, industry: 3, companyTier: 3, projects: 4,
      salary: 3, location: 4, age: 2, stability: 3,
    };
    // 合并：优先 jd.weights 自定义值 → 模板值 → wDefaults
    var w = {};
    for (var wk in wDefaults) {
      if (!Object.prototype.hasOwnProperty.call(wDefaults, wk)) continue;
      // ⚠️ 必须数值校验。2026-08-07 审查实测：<input type="number" v-model.number> 在用户清空
      // 输入框时产出空字符串，一路存进 jd.weights；下面 totalWeight 用 += 累加，一个字符串
      // 就把累加器变成字符串拼接 —— 同一 JD 下完美匹配的人从 98 掉到 0、coverage 89%→1%，
      // 整轮 RPA 的分全废且不报任何错。NaN/Infinity 则直接让 total 变 NaN 流到落库与 UI。
      // 非有限值或负数一律弃用，逐级回落，绝不让脏值进加权。
      var wv = weights ? Number(weights[wk]) : NaN;
      if (weights && weights[wk] != null && Number.isFinite(wv) && wv >= 0) w[wk] = wv;
      else if (tpl && Number.isFinite(Number(tpl[wk]))) w[wk] = Number(tpl[wk]);
      else w[wk] = wDefaults[wk];
    }

    var hardFlags = opts.hardFlags || (jd.hardFlags ? jd.hardFlags : DEFAULT_HARD_FLAGS);

    // 两级 tier：card = 只有列表卡片信息的速评；detail = 拿到详情/完整履历后的深评。
    // 不显式传就自动判：出现项目/教育经历/带正文的工作经历 → detail，否则 card。
    var tier = opts.tier;
    if (tier !== 'card' && tier !== 'detail') {
      var deepEvidence = (c.projects && c.projects.length)
        || (c.education && c.education.length);
      if (!deepEvidence && c.workHistory) {
        for (var we = 0; we < c.workHistory.length; we++) {
          if (c.workHistory[we] && (c.workHistory[we].description || '').length > 20) { deepEvidence = true; break; }
        }
      }
      tier = deepEvidence ? 'detail' : 'card';
    }

    // L1 硬门槛
    var mismatchReasons = checkHardFilters(c, jd, hardFlags);

    // L2+L3 各维度评分。
    // ⚠️ 保持每个元素都写成 scoreXxx(...) 形式：scripts/test-ext.mjs 通过正则从这里数维度数，
    // 用中间变量会让测试数错——见 test-ext.mjs:91 ENGINE_DIMS 注释。
    // 维度间通过共享的 buildDomainKwSets/classifySegment 自洽计算，不通过参数耦合。
    var details = [
      scorePositionFit(c, jd, w.positionFit),
      scoreDomainFit(c, jd, w.domainFit, tier),
      scoreTaskCoverage(c, jd, w.taskCoverage, tier),
      scoreKeywords(c, jd, w.keywords, tier),
      scoreExperience(c, jd, w.experience),
      scoreDegree(c, jd, w.degree),
      scoreIndustry(c, jd, w.industry),
      scoreCompanyTier(c, jd, w.companyTier),
      scoreProjects(c, jd, w.projects),
      scoreSalary(c, jd, w.salary),
      scoreLocation(c, jd, w.location),
      scoreAge(c, jd, w.age),
      scoreStability(c, jd, w.stability, tier),
    ];

    // 加权总分。
    //
    // ⚠️ 关键：把「判不了」的维度整个踢出加权（分子分母都不算），而不是给个中性分照常参与。
    // 真机 2026-07-28 暴露的问题：RPA 列表级模式只读推荐卡片，拿不到工作年限/公司/工作经历/项目，
    // 于是 experience/companyTier/projects/industry 对【每个人】都返回同一个常数，
    // 占掉 33%~45% 的权重。常数不产生区分度，只会把所有人朝中间拉——
    // 实测 47 人分数全挤在 53~58，高匹配 0 人，评分对筛人毫无价值。
    // 剔除后，分数由真正有数据的维度决定，区间自然拉开；同时输出 coverage 让使用者知道
    // 这个分基于多少信息（覆盖度低 = 需要开详情补数据）。
    // 两种"退出"语义：
    //   · notApplicable = JD 侧压根没提这个要求（如没配 domain/tasks、没配年龄区间）
    //     → 不是"数据缺失"，不该拖低覆盖度，分母里也要去掉；
    //   · available:false 且非 notApplicable = 候选人侧数据没采到 → 计入分母，拉低覆盖度。
    var usable = [];
    var allWeight = 0;
    for (var i = 0; i < details.length; i++) {
      if (details[i].notApplicable) continue;
      allWeight += details[i].weight;
      if (details[i].available !== false) usable.push(details[i]);
    }
    var pool = usable.length ? usable : details;
    var totalWeight = 0;
    for (var k = 0; k < pool.length; k++) totalWeight += pool[k].weight;
    if (totalWeight <= 0) totalWeight = 1;
    var total = 0;
    for (var j = 0; j < pool.length; j++) total += pool[j].score * pool[j].weight;
    total = total / totalWeight;
    total = Math.max(0, Math.min(100, total));
    var coverage = allWeight > 0 ? Math.round((usable.length ? totalWeight : 0) / allWeight * 100) : 0;

    // 校准拉伸（单调）：把加权均值天然堆积的 45-75 密集区拉开，排序不变。
    total = calibrate(total);

    // 必选词零命中闸门：JD 配了 ≥2 个必选词、精确+语义全部脱靶 → 总分封 55（单词 65）。
    // 硬技能是 must-have，不许被学历/薪资/城市这些 context 维凑成"看起来还行"的 70+。
    var gates = [];
    // 上界追踪（P1-17）：两道封顶（必选词零命中 / card CARD_MAX）先施加并记录到 upperCap，
    // 后到的证据托底若想把分抬上去，不得突破任何已施加的上界。
    var upperCap = Infinity;
    var kdim = null;
    for (var kd = 0; kd < details.length; kd++) if (details[kd].dimension === 'keywords') { kdim = details[kd]; break; }
    if (kdim && kdim.zeroRequiredHit) {
      var cap = kdim.reqTotal >= 2 ? 55 : 65;
      if (total > cap) {
        total = cap;
        gates.push('必选关键词零命中，总分封顶 ' + cap);
      }
      upperCap = Math.min(upperCap, cap);
    }

    // v4（M5）：card 层极端分压制。卡片层只有表面信息（职位/城市/学历/年限/公司/技能标签），
    // 域判定弱、任务点覆盖整维 notApplicable，给 90+ 或 10- 都是在误导真人做"点不点开"的决策。
    // detail 层有完整履历，才有证据做极端判断。
    if (tier === 'card') {
      if (total > CARD_MAX) {
        total = CARD_MAX;
        gates.push('卡片层信息有限，总分封顶 ' + CARD_MAX);
      } else if (total < CARD_MIN) {
        total = CARD_MIN;
        gates.push('卡片层信息有限，总分托底 ' + CARD_MIN);
      }
      upperCap = Math.min(upperCap, CARD_MAX);
    }

    total = Math.round(total);

    // 硬门槛不达标 → 总分封顶 45，并标记 mismatch
    var mismatch = mismatchReasons.length > 0;
    if (mismatch) total = Math.min(total, 45);

    // ============ 证据托底闸门（2026-08-07）============
    // 非对称要求：「低于 60 分」这一档必须极其准确（说不合适就是不合适，可以直接丢），
    // 「60 分以上」允许模糊（反正真人还会看）。所以拒绝必须有据，不能因为没采到数据就拒。
    //
    // 引擎此前把两件性质完全不同的事混同了：
    //   ① 确凿不符——学历/年限/城市明确越界（有 mismatchReasons），或证据充分但确实分低；
    //   ② 没采到——简历没解析出来、英文简历、卡片层字段稀疏。
    // ② 会让人拿到极低分。2026-08-07 实测：一份英文 CV 在生产配置下拿了 9 分，
    // 而这个人是进过面的——分低的原因是十几个维度全部 available:false，不是他不合格。
    //
    // 处置：够不着 low 线、又没有任何硬门槛证据、且覆盖度低于下限时 → 托底到 low 线，
    // 标 insufficientEvidence。它落进「待核」而不是「拒绝」，交回真人判断。
    // 注意不改 level 的枚举值（避免下游 UI/落库要跟着改），只是把人从可丢弃的那一桶里捞出来。
    // 但「覆盖度低」不等于「没看清」。判别性维度只要真评过、且评出来就是不匹配，
    // 那就是【看清了不合适】，该拒就拒——否则跨职能错配（做财务的人投技术岗）会全被托底放行，
    // 实测放宽到只看 coverage 时，跨岗错配识别率从 95% 掉到 45%。
    // 所以要求：判别性维度里至少有 2 个真的评过（有数据且 JD 提了要求），才承认拒绝有据。
    var DECISIVE = ['keywords', 'positionFit', 'domainFit', 'taskCoverage'];
    var decisiveEvaluated = 0;
    for (var dv = 0; dv < details.length; dv++) {
      var dd = details[dv];
      if (DECISIVE.indexOf(dd.dimension) === -1) continue;
      if (!dd.notApplicable && dd.available !== false) decisiveEvaluated++;
    }

    var loLine = thresholds && thresholds.low != null ? thresholds.low : 60;
    var insufficientEvidence = false;
    // 两道证据托底闸门对 coverage 的处理分档不同：
    //   · detail 层：coverage 仍是「信息是否足够下否定结论」的有效指标（进面样本覆盖度最低 61%，
    //     跨岗错配样本 95% 落在 60% 以下，60 这条线能把两者分开，见 MIN_COVERAGE_FOR_REJECT 注释）。
    //   · card 层：coverage 是反向指标 —— taskCoverage 在该层结构上 notApplicable、被剔出分母，
    //     缺失反而抬高 coverage。实测 13 张真顶卡全部 68~95%，MIN_COVERAGE_FOR_REJECT=60 永不触发，
    //     这条覆盖度门槛在 card 层形同虚设。所以 card 路径只认 decisiveEvaluated（真正评过的
    //     岗位专属维度个数），不再叠加 coverage 条件；detail 路径行为保持原样。
    if (!mismatch && total < loLine && decisiveEvaluated < 2
      && (tier === 'card' || coverage < MIN_COVERAGE_FOR_REJECT)) {
      insufficientEvidence = true;
      total = Math.min(loLine, upperCap);
      gates.push('证据不足（覆盖度 ' + coverage + '%，判别性维度仅 ' + decisiveEvaluated +
        ' 个可判），不作否定结论，托底 ' + total);
    }

    // 第二道证据托底：文本体量下限（2026-08-07，用飞书 62 份真实已终止样本实测出的洞）。
    // 覆盖度和判别性维度都骗得过残缺数据——一份只抓到 240 字顶卡的简历，keywords/domainFit
    // 照样"可判"，覆盖度照样 79%，然后引擎自信地给出 25 分。而这个人是简历评估通过、
    // 进过面试的（实测两例：岗位甲·候选人 C 25 分、岗位乙·候选人 A 35 分，均为文本残片）。
    // 判不了 ≠ 不合格：正文不足下限时不作否定结论。阈值 350 字的依据：真实简历正文
    // （含 OCR 版）最短 1000+ 字，残片均 <300 字，350 在两者之间留了余量。
    // 仅当既无成段文本、又无结构化字段（skills/education 全空）时才触发——
    // 有结构化卡片字段的稀疏候选人（BOSS 卡片层）照常判，那是真采到的证据。
    // 文本量按去重后的段落算：selfIntro 与 workHistory 常携带同一段文本，重复计数会骗过下限。
    var hasStructured = (c.skills && c.skills.length) || (c.education && c.education.length) ||
      (c.workHistory && c.workHistory.length > 1 && c.workHistory[0] && c.workHistory[0].company);
    if (!mismatch && !insufficientEvidence && total < loLine && !hasStructured) {
      var segsAll = buildSegmentedText(c);
      var uniqSeg = {};
      for (var tl = 0; tl < segsAll.length; tl++) uniqSeg[String(segsAll[tl].text || '')] = 1;
      var textLen = 0;
      for (var uk in uniqSeg) textLen += uk.length;
      if (textLen < MIN_TEXT_FOR_REJECT) {
        insufficientEvidence = true;
        total = Math.min(loLine, upperCap);
        gates.push('候选人文本仅 ' + textLen + ' 字（<' + MIN_TEXT_FOR_REJECT + '）且无结构化字段，证据体量不足，不作否定结论，托底 ' + total);
      }
    }

    // 等级
    var hi = thresholds && thresholds.high != null ? thresholds.high : 75;
    var lo = thresholds && thresholds.low != null ? thresholds.low : 60;
    var level = mismatch ? 'mismatch' : (total >= hi ? 'high' : total >= lo ? 'medium' : 'low');
    // 覆盖度太低时不得评为 high（高分会驱动自动打招呼这种对外动作，必须要求证据充分）。
    // v4（M5）：card 层天生低置信——没有经历正文，域判定弱、任务点覆盖整维退出，
    // 哪怕 coverage 看起来高（因为很多维 notApplicable 被剔出分母），也不许给 high 置信。
    // 只有 detail 层才有资格谈"高置信推荐"。
    var lowConfidence = (tier === 'card') || (coverage < MIN_COVERAGE_FOR_HIGH);
    if (level === 'high' && lowConfidence) level = 'medium';

    // 可解释输出
    var keywordsDim = null;
    for (var kdi = 0; kdi < details.length; kdi++) if (details[kdi].dimension === 'keywords') { keywordsDim = details[kdi]; break; }

    // ============ 卡片层三档判定（2026-08-11）============
    //
    // 【为什么卡片层不给数字分】
    // 真机症状：BOSS 插件一屏全是 85 分，毫无区分度。复现后根因清楚：
    // 卡片上只有职位名/公司/学历/年限/几个技能标签，而权重最大的两维
    // taskCoverage(22) + domainFit(21) —— 合计约 40% 权重 —— 在卡片层双双退出，
    // 剩下的全是"人人都拿高分"的通用维（年限 96 / 学历 96 / 行业 92 / 职位名相似 84），
    // 分数于是全部堆到 CARD_MAX=85 的天花板。实测「理想候选人」「空卡片（技能全无）」
    // 同为 85 分 —— 数字的精确感是假的，把它显示给 TA 只会消耗信任。
    //
    // 【三档怎么定：值得看必须有"正向证据"，不能只靠"没有负面证据"】
    // 这是本判定的核心。若只按 total 切档，空卡片（85）会和理想候选人（85）同档 ——
    // 那等于什么都没改。所以「值得看」额外要求岗位专属的正向信号：
    // 命中加分词 / 同域 / 必选词强命中。空卡片这些一个都没有，自然落到「一般」。
    //
    // detail 层不走这套：拿到完整履历后数字分是有意义的，照常输出。
    var cardVerdict = null;
    // 第四档「信息不足」：判别性维度评过的太少，既撑不起「值得看」也撑不起「不匹配」。
    // 判别性维度 = keywords / positionFit / domainFit / taskCoverage（岗位专属，通用维不算）。
    // 阈值 2 的依据：① 详情层证据托底同样要求 decisiveEvaluated ≥ 2 才承认拒绝有据（见上）；
    //   ② card 层 taskCoverage 结构上不可判，card 至多评 3 个判别维，<2 说明连"是不是干这行的"
    //   都没看清，这时不该下任何结论，归入「信息不足」。
    //
    // 两档都写本字段，三端（BOSS 插件 / BOSS RPA / 猎聘 RPA）只认 cardVerdict/cardVerdictLabel：
    //   · card 层：decisiveEvaluated < 2 → 'unknown'；但【可核验的硬门槛优先】——
    //     mismatch 成立说明学历/年限/年龄等字段确实采到了且明确越界（字段缺失时硬门槛根本
    //     不触发，见 checkHardFilters：c.degree 为空直接跳过），所以 fired 的硬门槛在卡片数据上
    //     就是可核验的拒绝依据（2026-08-11 决策，对应 A1 的例外条款：学历明示且低于要求即拒）。
    //     真正的 Rule 2(b) 场景（卡片没采到字段）压根不会走到 mismatch。
    //   · detail 层：insufficientEvidence === true → 结果必须呈现为「判不了」，而不是数字 60。
    //     60 是内部托底值（排序/落库仍用），但 UI 显示 60 会读成"通过"——详情层的"数字 60"
    //     和"确实匹配"的 60 无法分辨。所以 detail 层证据不足时也置 'unknown'，让三端统一读一个字段。
    //     若置 unknown 说明该人已被托底、非真实匹配，下游不得据此打标/排序（见 insufficientEvidence 契约）。
    var detailUnknown = (tier === 'detail' && insufficientEvidence);
    if (tier === 'card') {
      if (!mismatch && decisiveEvaluated < 2) {
        cardVerdict = 'unknown';
      } else {
        var bonusHitCount = (keywordsDim && keywordsDim.bonusHits) ? keywordsDim.bonusHits.length : 0;
        var reqStrongHit = keywordsDim ? (keywordsDim.reqTotal > 0 && !keywordsDim.zeroRequiredHit) : false;
        var domDim = null;
        for (var dvi = 0; dvi < details.length; dvi++) if (details[dvi].dimension === 'domainFit') { domDim = details[dvi]; break; }
        var domainSame = !!(domDim && !domDim.notApplicable && domDim.available !== false && domDim.score >= 70);
        var domainFar = !!(domDim && !domDim.notApplicable && domDim.available !== false && domDim.score <= 35);
        // 期望职位强对齐：卡片上最可靠的岗位专属信号（期望职位与 JD title 的对齐度 ≥70）。
        // 通用维（年限/学历/城市）一律不算正向证据。
        var pfDim = null;
        for (var pfi = 0; pfi < details.length; pfi++) if (details[pfi].dimension === 'positionFit') { pfDim = details[pfi]; break; }
        var positionAligned = !!(pfDim && !pfDim.notApplicable && pfDim.available !== false && pfDim.score >= 70);
        // 正向证据（Task C，2026-08-11 收紧）：必须【期望职位强对齐】叠加至少一个实质信号
        // （命中加分词 / 同域 / 必选强命中）。单靠公司名带来的域信号（缑向超：奇瑞→域92但无期望职位）
        // 或加分词的弱命中（子串，如"软件"命中公司名）不再足以撑起「值得看」——实测 13 张真顶卡里
        // 5 个 HR 拒绝的人仅凭这些弱信号拿到「值得看」，卡片层判定几乎不带信息。
        // 收紧后：真顶卡正样本候选人 D/E（期望职位 100% 对齐 + 加分/必选命中）仍稳居「值得看」；
        // 负样本从 5 个降到 2 个，且剩的 2 个（候选人 F/G）本身就是 title 100% 对齐的真实匹配——
        // 卡片层信息只能支撑"值得点开"，履历错配要到详情层才能判，这正是 card 与 detail 的分工。
        // 收紧只影响 worth→fair 的落档，不改变 total / nomatch 判定，故 Rule 1（正样本 <60、
        // 或 worth→nomatch）不可能被触发——worst case 是正样本从 worth 掉到 fair（允许）。
        var positiveEvidence = positionAligned
          && ((bonusHitCount >= 2) || domainSame || (reqStrongHit && bonusHitCount >= 1));

        if (mismatch || domainFar || total < lo) {
          cardVerdict = 'nomatch';
        } else if (positiveEvidence && total >= lo) {
          cardVerdict = 'worth';
        } else {
          cardVerdict = 'fair';
        }
      }
    } else if (detailUnknown) {
      cardVerdict = 'unknown';
    }

    return {
      total: total,
      level: level,
      tier: tier,
      gates: gates,
      mismatch: mismatch,
      mismatchReasons: mismatchReasons,
      coverage: coverage,
      missingDimensions: (function () {
        var out = [];
        for (var mi = 0; mi < details.length; mi++) {
          if (details[mi].available === false && !details[mi].notApplicable) out.push(details[mi].label);
        }
        return out;
      })(),
      lowConfidence: lowConfidence,
      // true = 这个分是「没看清」的托底，不是「看清了不合适」。使用方不该据此丢人。
      insufficientEvidence: insufficientEvidence,
      // 卡片层四档：'worth'值得看 / 'fair'一般 / 'nomatch'不匹配 / 'unknown'信息不足。
      //   'unknown' 只在判别性维度评过 <2 个时给出，且优先于其余三档。
      // detail 层：insufficientEvidence 时也置 'unknown'（三端统一读本字段，不再显示误导性的数字 60）；
      //   否则为 null（用数字分）。
      // ★ 三端（BOSS 插件 / BOSS RPA / 猎聘 RPA）在 tier==='card' 或本字段非 null 时一律显示它，
      //   不显示 total —— 卡片层的数字分没有区分度（见上方判定处的注释）。
      cardVerdict: cardVerdict,
      cardVerdictLabel: cardVerdict === 'worth' ? '值得看' : cardVerdict === 'fair' ? '一般'
        : cardVerdict === 'nomatch' ? '不匹配' : cardVerdict === 'unknown' ? '信息不足' : null,
      details: details,
      highlights: extractHighlights(details),
      gaps: extractGaps(details),
      skills: keywordsDim ? extractSkills(keywordsDim) : null,
    };
  }

  // ===================== 评分体检（本轮标定）=====================
  //
  // 解决的问题：真机 2026-07-29 跑了 75 人，分数全挤在 52~58、零高匹配，用户只能看到
  // 一串"不太匹配"，无从判断是"人真的不行"还是"评分配错了"。事后查库才发现两件事：
  //   · 75 人全在武汉，而 JD 城市写的是杭州 → 地理位置(权重15%)对每个人都给 30 分，
  //     既是统一扣分又零区分度；
  //   · 必选词「分布式架构」命中 0/75 → 权重最高的硬技能维(40%)被锁死在半命中基线。
  // 也就是说 55% 的权重在空转，而工具当时一个字都没提。
  //
  // 体检不改任何分数，只统计"这一维在本轮候选池上到底有没有产生区分度"，
  // 并把可执行的建议交给使用者（改必选词/改城市），判断权归人。
  function createScoreAudit() {
    var n = 0;
    var dims = {};        // dimension -> { label, weight, values: {}, counted, distinct }
    var reqHit = {};      // 必选词 -> 命中人数
    var cities = {};      // 候选人城市 -> 人数
    var levels = { high: 0, medium: 0, low: 0, mismatch: 0 };
    var totals = [];

    function bump(map, k) { if (!k) return; map[k] = (map[k] || 0) + 1; }

    return {
      count: function () { return n; },
      add: function (r, c) {
        if (!r) return;
        n++;
        if (levels[r.level] != null) levels[r.level]++;
        totals.push(r.total);
        bump(cities, c && c.city);
        var det = r.details || [];
        for (var i = 0; i < det.length; i++) {
          var d = det[i];
          if (d.notApplicable) continue;          // JD 没提要求的维度不参与体检
          var e = dims[d.dimension];
          if (!e) { e = dims[d.dimension] = { label: d.label, weight: d.weight, values: {}, counted: 0 }; }
          if (d.available === false) continue;     // 没数据的这一次不算，只统计真正计入加权的
          e.counted++;
          bump(e.values, String(d.score));
        }
        // 必选词逐词命中：exactHits 是本次命中的必选词数组
        var kw = null;
        for (var j = 0; j < det.length; j++) if (det[j].dimension === 'keywords') kw = det[j];
        if (kw && kw.exactHits) for (var k = 0; k < kw.exactHits.length; k++) bump(reqHit, kw.exactHits[k]);
      },
      /** 返回可直接写进运行日志的建议行；没有值得说的就返回空数组 */
      report: function (jd) {
        var out = [];
        if (n < 10) return out;                   // 样本太少，任何"常数维"的判断都不可靠
        jd = jd || {}; jd.basic = jd.basic || {}; jd.keywords = jd.keywords || {};

        // ① 零区分度维度：本轮所有人拿同一个分 → 这份权重完全没参与筛选
        var deadWeight = 0, liveWeight = 0, deadList = [];
        for (var key in dims) {
          if (!Object.prototype.hasOwnProperty.call(dims, key)) continue;
          var e = dims[key];
          if (e.counted < Math.max(5, n * 0.5)) continue; // 半数以上有数据才判定
          var distinct = 0;
          for (var v in e.values) if (Object.prototype.hasOwnProperty.call(e.values, v)) distinct++;
          if (distinct <= 1) { deadWeight += e.weight; deadList.push(e.label + '(' + e.weight + '%)'); }
          else liveWeight += e.weight;
        }
        if (deadList.length) {
          out.push('评分体检：' + deadList.join('、') + ' 这些维度本轮对所有候选人给出相同分数，'
            + '合计 ' + deadWeight + '% 权重没有产生任何区分度');
        }

        // ② 必选关键词零命中/极低命中 → 权重最高的一维被锁死
        var req = jd.keywords.required || [];
        for (var r2 = 0; r2 < req.length; r2++) {
          var hits = reqHit[req[r2]] || 0;
          var rate = Math.round(hits / n * 100);
          if (rate < 10) {
            out.push('评分体检：必选关键词「' + req[r2] + '」命中 ' + hits + '/' + n + ' 人（' + rate + '%）。'
              + '必选词几乎无人命中会把硬技能维锁在半命中基线，建议把它改成【加分词】，'
              + '或换成候选人简历里真会出现的写法');
          }
        }

        // ③ JD 城市与候选池不符 → 地理位置维对所有人统一扣分
        var jdCity = jd.basic.city;
        if (jdCity && jdCity !== '全国') {
          var top = '', topN = 0, matched = 0, total = 0;
          for (var ct in cities) {
            if (!Object.prototype.hasOwnProperty.call(cities, ct)) continue;
            total += cities[ct];
            if (cities[ct] > topN) { topN = cities[ct]; top = ct; }
            if (ct.indexOf(jdCity) !== -1 || jdCity.indexOf(ct) !== -1) matched += cities[ct];
          }
          if (total > 0 && matched / total < 0.2) {
            out.push('评分体检：JD 城市写的是「' + jdCity + '」，但本轮 ' + topN + '/' + total
              + ' 位候选人在「' + top + '」。BOSS 推荐流是按你在 BOSS 上的在招职位派人的，'
              + '与平台 JD 的城市不一致时，地理位置这一维会对每个人统一扣分且不产生区分度——'
              + '建议把 JD 城市改成「' + top + '」或「全国」');
          }
        }

        // ④ 总体结论
        if (out.length) {
          out.push('评分体检：本轮 ' + n + ' 人，高匹配 ' + levels.high + ' / 中 ' + levels.medium
            + ' / 低 ' + levels.low + ' / 不匹配 ' + levels.mismatch
            + '。以上几处修好之前，分数只在剩余 ' + liveWeight + '% 权重上区分人，参考价值有限');
        }
        return out;
      },
    };
  }

  // ===================== 对外 API =====================

  var api = {
    // 核心
    scoreCandidate: scoreCandidate,
    createScoreAudit: createScoreAudit,
    setSemanticProvider: setSemanticProvider,
    hasSemantic: hasSemantic,

    // 工具
    parseSalary: parseSalary,
    matchKeywords: matchKeywords,
    buildSkillText: buildSkillText,

    // 常量
    DEGREE_RANK: DEGREE_RANK,
    WEIGHT_TEMPLATES: WEIGHT_TEMPLATES,
    DEFAULT_HARD_FLAGS: DEFAULT_HARD_FLAGS,

    // 兼容旧调用（v1 只返回 total/level/details），上层若访问 highlights 等新增字段也能拿到
  };

  // 同时支持 Node (module.exports) 和浏览器 (window.__TA_SCORE__)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.__TA_SCORE__ = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
