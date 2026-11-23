// 通用工具函数
export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 默认 RPA 任务工厂：真实用户无需理解"任务"，「开始找人」时按激活岗位 + 默认参数自动生成。
// 推荐流不用 search 字段（保留占位以满足类型）；首轮默认不自动招呼/收藏（安全）。
// 风险登记册基线：默认human档，招呼≤15/浏览≤40/收藏≤25/单次≤90分钟。
import type { RPATask, PlatformId } from './types';
import type { JD, SearchConfig, SpeedMode } from './types';
import { normalizeSpeedMode } from './constants'; // ★ 2026-08-20 P2：唯一 human 档归一（防旧 safe 入参）
import { EXPERIENCE_RANGES } from './constants'; // buildSearchFromJd 反查经验档位

// 每日上限的完整形态（按平台不同有不同配额项）。
// BOSS 只有 browse/greet/favorite（推荐流无翻页/搜索配额概念）。
// 猎聘有三重配额：pages(翻页) / searches(搜索组合) / details(详情) — 决定真实网络请求量与套餐消耗。
// 所有平台都有 durationMin（单次运行时长上限，相同）。
export interface DailyLimits {
  browse: number;
  greet: number;
  favorite: number;
  pages: number;       // 翻页次数上限（猎聘用；BOSS=0 表示不限制）
  searches: number;    // 搜索次数上限（猎聘用；BOSS=0 表示不限制）
  details: number;     // 详情次数上限（猎聘用；BOSS=0 表示走打招呼/收藏的配额）
  durationMin: number;
}

// 按平台 + 档位返回【系统固定的】每日上限（= sourcing 每日总量的优雅停机线，反风控不可人工调）。
//
// BOSS 口径：列表级模式浏览零请求，真正的风控绑定在请求频率/单次时长/招呼量/风控信号上。
// 2026-07-27 校正：浏览 240（约 66 分钟 / 16 次加载请求）。
//
// 猎聘口径（对齐《猎聘RPA风险调查》档位一 / 档位二）：
//   - 一页约 20 张卡（列表级零额度消耗）
//   - 真实请求量绑定翻页/搜索次数
//   - 详情是付费动作（企业套餐额度），受"套餐额度 × 50%" 硬上限约束
//
// ★ 2026-08-20 P2：净删 safe 档，只留 human。human 的所有配额(招呼/浏览/收藏/翻页/搜索/详情/时长)
//   原样保留，未削弱任何反风控配额/阈值。旧 safe 模式任务经 normalizeSpeedMode 归 human，走 human 配额。
export function getDefaultLimits(mode: SpeedMode, platform: PlatformId = 'boss'): DailyLimits {
  normalizeSpeedMode(mode); // 唯一 human，归一仅作一致性校验（旧 safe 入参也走 human 配额）
  if (platform === 'liepin') {
    // ── 猎聘配额（2026-08-04 业务方拍板「按建议运行位」）──
    //
    // 推导（真机确认每页 20 张卡；调研 §9/§10）：
    //   红线（绝不可越）：小时峰值 30 页/h、单 IP 日请求 500、单账号日搜索 200、
    //                     日看简历 100 且 R1 要求压到套餐 30~50%
    //   （注：原列「单关键词 10 页平台硬限」系误判——真机实测分页器共 100 页，已删；deep-paging
    //    由干涸判据/平台尾页收敛，详见 constants.PLATFORM_TUNING 与下方 2026-08-18 注释。）
    //   瓶颈不是风控阈值而是【时间】：档位一强制"每翻 5 页休 3~8 分钟"，
    //   按每页 ≈2.3 分钟算，7.5h 窗口物理上跑不过 ~190 页。
    //
    // human（唯一档 = 建议日常位）：90 页/天 ≈ 12 页/小时 = 红线的 40%
    //   → 1,800 张/天、9,000 张/周；日请求 ≈110 次 = 单 IP 红线的 22%
    //   业务目标是 6,000/周，这个位置留了 50% 余量。
    //
    // ⚠️ 上限不是"能跑多少"而是"敢跑多少"：贴着 30 页/h 的线跑，一旦页面变慢、
    //    重试变多，瞬时值就冲过去了。留一半余量才叫较为安全。
    // ★★ 2026-08-18 产量重构（c-in-c 真机实测定案）：回到【广搜为主 + 深翻】形态。
    //
    //    原前提「猎聘 10 页硬限 / 单查询只吃前 ~100 人」被真机推翻：分页器共 100 页、
    //    第 100 页正常加载 20 卡无封锁 = 单次广搜可翻 2000 人。原据此把人群切成 144 个
    //    窄组合、每组合 ≤2 页就换，产量被自己掐死（深挖无效的结论是建立在错误前提上的）。
    //
    //    改法：searches 60 不变、maxPagesPerQuery 2→60（见 constants.PLATFORM_TUNING）。
    //      · 一个广搜组合持续深翻，直到 ① 到平台尾页(next disabled) ② 连续多页内部
    //        去重后新人低于阈值（挖枯） ③ 累计到 60 页。
    //      · 日翻页仍 90（≈2 个广搜吃满），日请求量、日浏览量、时长窗口全不变 →
    //        风控暴露面没有实质变化；深翻靠【每翻 N 页休 3-8 分钟】控制请求频率，不动该闸。
    //      · 配「更新时间排序」+ 跨轮持久去重：已收录的人被跳过，深翻产出的是新人。
    //    红线对照（调研 §9/§10）：单账号日搜索红线 200，配 60 = 30%；
    //    真正的瓶颈（日翻页 90 ≈ 红线 40%、日请求 ≈110 = 单 IP 红线 22%）一点没动。
    return { greet: 0, browse: 1800, favorite: 0, pages: 90, searches: 60, details: 30, durationMin: 450 };
  }
  // BOSS（默认，唯一 human 档）
  return { greet: 15, browse: 240, favorite: 40, pages: 0, searches: 0, details: 0, durationMin: 90 };
}

// 猎聘详情配额 = min(档位详情上限, 企业套餐额度 × 50%)
// 风险报告 R1 硬性要求：每日详情消耗 ≤ 套餐额度 50%（留余量应对真人操作 + 平台波动）。
export function liepinDetailCap(mode: SpeedMode, packageDailyQuota: number): number {
  const limit = getDefaultLimits(mode, 'liepin').details;
  const cap = Math.floor(packageDailyQuota * 0.5);
  return Math.min(limit, Math.max(0, cap));
}

export function makeDefaultTask(name: string, speedMode: SpeedMode = 'human', platform: PlatformId = 'boss'): RPATask {
  const limits = getDefaultLimits(speedMode, platform);
  return {
    id: '', name: name || '找人任务', platform,
    search: platform === 'liepin'
      ? { keywords: '', city: '全国', experience: '不限', degree: '不限', salary: '', keywordGroups: [], cities: [], industries: [], strictFilters: true }
      : { keywords: '', city: '全国', experience: '不限', degree: '不限', salary: '' },
    actions: { autoGreet: false, greetThreshold: 75, greetTemplate: '您好，看到您的经历很匹配，方便聊聊吗？', autoFavorite: false, favoriteThreshold: 70, exportCsv: true },
    speed: { mode: speedMode, dailyGreetLimit: limits.greet, dailyBrowseLimit: limits.browse, dailyFavoriteLimit: limits.favorite },
    schedule: { trigger: 'manual', runDurationMin: limits.durationMin, cron: '', idleStartMinutes: 5, idlePauseOnInput: true },
    createdAt: 0, updatedAt: 0,
  } as RPATask;
}

/**
 * 从激活 JD 结构化字段派生 RPA 搜索条件（scope A：纯字段映射，不做智能提取）。
 *
 * 病根修复：原 startTaskById 读 task.search 作搜索词、另 loadActiveJd 取 JD 作评分，
 * 搜/评两套来源 → 「搜 A 评 B」。本函数把「喂给引擎的搜索条件来源」从 task.search
 * 改为 JD 派生，使搜的岗位 = 评的岗位。
 *
 * 映射规则（空字段一律「不限」，绝不硬塞）：
 *   · keywordGroups ← jd.keywords.required（必备词作搜索词组；保守起见只用 required，
 *     不纳 bonus——bonus 是加分项，不该作必备搜索词收紧候选池）
 *   · cities        ← jd.basic.city 有值且非「全国/不限」→ [city]；否则空
 *   · experience    ← 由 jd.basic.experienceMin/Max 反查 EXPERIENCE_RANGES，落在某档
 *                     区间上下界完全相等 → 该档文案（如「3-5年」）；映射不到精确档就留空（不限），别硬塞
 *   · degree        ← jd.basic.degree 有值且非「不限」→ 透传（JD 存的就是「本科/硕士」平台档文案）
 *   · industries    ← 【恒为空】。jd.industry.preferred 是岗位领域行业词（汽车电子/智能网联/汽车），
 *                     不是猎聘「当前行业」筛选框的合法选项。真机实测：applySearch 对行业走
 *                     pickOptionByText 直点(strict)，点不到这些领域词 → strict 判 FILTER_FAILED_STRICT
 *                     → 整组合作废(12 组合首轮全弃)。行业精度改由评分引擎 domainFit/industry 维度负责
 *                     （JD.industry 照常参与评分，不在此收紧平台筛选）。
 *
 * buildQueries 仍按现有逻辑吃这份 SearchConfig：keywordGroups 为空时回落 keywords。
 * 故 keywords 字段同步设为 required.join(' ')，保证两条路径取值一致。
 * 引擎/评分/buildQueries/applySearch/去重/反风控/页深/断连自恢复逻辑一律不动。
 */
export function buildSearchFromJd(jd: JD): SearchConfig {
  const required = (jd.keywords?.required || []).map((s) => String(s).trim()).filter(Boolean);
  const keywords = required.join(' ');

  // 城市：单值，非「全国/不限」才限定。
  const rawCity = (jd.basic?.city || '').trim();
  const cities = rawCity && rawCity !== '全国' && rawCity !== '不限' ? [rawCity] : [];

  // 经验：用 EXPERIENCE_RANGES 反查。仅当 min/max 完全等于某档区间上下界才取该档，
  // 匹配不到留空（不限）——宁可不限也不硬塞一个近似的档把人筛错。
  const expMin = jd.basic?.experienceMin;
  const expMax = jd.basic?.experienceMax;
  let experience = '';
  if (typeof expMin === 'number' && typeof expMax === 'number') {
    for (const [label, [lo, hi]] of Object.entries(EXPERIENCE_RANGES)) {
      if (label !== '不限' && expMin === lo && expMax === hi) { experience = label; break; }
    }
  }

  // 学历：JD 存的就是平台档文案（本科/硕士/大专/博士），直接透传；「不限」或空则不限。
  const rawDegree = (jd.basic?.degree || '').trim();
  const degree = rawDegree && rawDegree !== '不限' ? rawDegree : '';

  // 行业：恒为空。jd.industry.preferred 是岗位领域行业词，不是猎聘「当前行业」筛选框合法选项；
  // 带进去会让 applySearch 的 strict 行业筛选点不到选项 → FILTER_FAILED_STRICT 整组作废。
  // 行业精度交评分引擎 domainFit/industry 维度（JD.industry 照常参与评分），平台筛选不带行业。
  const industries: string[] = [];

  return {
    keywords,
    city: cities[0] || '不限',
    experience: experience || '不限',
    degree: degree || '不限',
    salary: '',
    keywordGroups: required,
    cities,
    industries,
    // ★ 保持 makeDefaultTask 对 liepin 的默认严格性（true）。buildQueries 在 strictFilters
    //   未定义时回落宽松(false)——若这里漏设，覆盖 task.search 会把严格筛选从 true 降到 false，
    //   即静默放宽筛选、可能空转翻页，属于「影响现有功能」。BOSS 不走 applySearch，该字段对其无影响。
    strictFilters: true,
  };
}

// 正态分布随机数 (Box-Muller)
export function normalRandom(mean: number, std: number, min?: number, max?: number): number {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random() || 1e-9;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  let v = mean + z * std;
  if (min !== undefined) v = Math.max(v, min);
  if (max !== undefined) v = Math.min(v, max);
  return v;
}

// 区间随机（平均）
export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// 区间正态随机
export function randNormalRange(lo: number, hi: number): number {
  const mean = (lo + hi) / 2;
  const std = (hi - lo) / 4;
  return normalRandom(mean, std, lo, hi);
}

// S4: 从正态分布参数 {mean,std} 采样（裁剪到 [mean-3σ, mean+3σ] 且 ≥ floor）。
// 拟人化时序/像素统一走这里，使"模仿本人"学习到的分布可整体替换默认档。
export function sampleDist(d: { mean: number; std: number }, floor = 0): number {
  const lo = Math.max(floor, d.mean - 3 * d.std);
  const hi = d.mean + 3 * d.std;
  return normalRandom(d.mean, d.std, lo, hi);
}

/**
 * 人类操作间隔的采样：对数正态，而不是正态。
 *
 * ★ 2026-08-13：为什么要换分布——截断正态是【对称】的，样本紧紧围着均值、
 *   在 ±3σ 处被硬切掉。真人的操作间隔不是这样：绝大多数偏短（熟练、连续动作），
 *   偶尔出现远长于均值的间隔（走神、接电话、多看两眼、被别的事打断），
 *   形态是【右偏重尾】。一串"每次都在 8~16 秒、几乎不越界"的间隔，
 *   其分布形状本身就是可被统计出来的机器特征——即便每个单值看着都随机。
 *
 * 实现：保均值的对数正态。给定目标均值 m 与标准差 s：
 *   σ² = ln(1 + s²/m²)，μ = ln(m) − σ²/2，样本 = exp(μ + σ·Z)
 *   这样 E[X] 恰好等于 m —— 换形状不换总量，配额与时长预算完全不受影响。
 * 上限按 m + 6s 兜底：允许出现"长尾"，但不允许真的卡住不动。
 */
export function sampleHumanDelay(d: { mean: number; std: number }, floor = 0): number {
  const m = Math.max(1, d.mean);
  const s = Math.max(1, d.std);
  const sigma2 = Math.log(1 + (s * s) / (m * m));
  const sigma = Math.sqrt(sigma2);
  const mu = Math.log(m) - sigma2 / 2;
  // Box-Muller 取标准正态
  let u = 0; let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const x = Math.exp(mu + sigma * z);
  return clamp(x, Math.max(floor, m - 3 * s > 0 ? m - 3 * s : floor), m + 6 * s);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// 简单中文关键词匹配（大小写/空格无关，中文无空格）
export function matchKeywords(text: string, keywords: string[]): { hit: string[]; count: number } {
  const hit = new Set<string>();
  if (!text) return { hit: [], count: 0 };
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    const k = kw.trim().toLowerCase();
    if (!k) continue;
    if (lower.includes(k)) hit.add(kw);
  }
  const arr = Array.from(hit);
  return { hit: arr, count: arr.length };
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

export function logTime(d = new Date()): string {
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}
