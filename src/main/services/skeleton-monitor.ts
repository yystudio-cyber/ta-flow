/**
 * 后台监控程序 —— 纯只读 DOM 骨架采样 + 运行摘要（2026-08-17 循环第1轮核心交付）。
 *
 * 为什么需要它：猎聘的境外 IP 拦截 / VPN 悖论让"边跑边看页面"不成立（见 memory
 * [[vpn-paradox-console-sampler]]）。真机跑完只能拿到引擎日志文本，而城市弹层、
 * 筛选未生效、翻页判失败这些点的【实际 DOM 结构】才是定位选择器漂移的唯一证据。
 * 本模块在那些失败点把 DOM 骨架存盘，事后离线分析 —— 与 console-sampler.js 同一条思路。
 *
 * ── 隐私边界（与 console-sampler.js v2 完全一致，不放宽）──────────────────────
 *   只带：标签名、class 字符串、id、data-* 属性的【名字】（不带值——
 *   data-resumeidencode 的值就是候选人 ID）、button/a/role=button 上 ≤8 字
 *   且不含数字的短文案、链接 path 形状（≥4 位连续数字打 <num> 码）。
 *   不带：姓名、手机、公司、学校、薪资、简历正文任何文本值。
 *   给陌生人看也认不出任何一个候选人。
 *
 * ── 红线（写进代码即留痕）──────────────────────────────────────────────────
 *   dumpSkeleton 纯 querySelector 只读：绝不 .click()、绝不导航、绝不碰立即沟通 /
 *   超级聊聊 / 详情页；零网络回传（不 fetch / 不 sendBeacon / 不 XHR）。
 *   只在 page.evaluate 里跑 walk，写盘在 Node 侧用 fs。
 *
 * ── schema 复用 ────────────────────────────────────────────────────────────
 *   walk / attrNames / shortLabel / maskUrlPath / envelope 与
 *   `招聘行为采集插件/scripts/console-sampler.js`（schemaVersion: 2）逐字对齐——
 *   所以离线分析器 skeleton-analyze.mjs 能直接吃本模块产出的文件，无需转换。
 *   浏览器端函数 walkTree 内联为字符串经 new Function 注入，是为了：
 *   ① 与 console-sampler.js 保持单函数可审计（人能在控制台对照跑同一份逻辑）；
 *   ② 不引入 puppeteer evaluateHandle 的序列化差异。
 *
 * ── 调用点（只观测，不改抓取控制流）─────────────────────────────────────────
 *   liepin.ts 在以下点调用 dumpSkeleton，均不改返回值 / 不改控制流：
 *     · 首次搜索出结果(≥1卡)              → tag='first-result'
 *     · pickCityFromOverlay 点完「其他」+等待后 → tag='city-overlay'
 *     · 每个诊断码触发点(CITY_OVERLAY_* / 筛选未生效 / goNextPage判失败) → tag=<诊断码>
 */
import type { Page } from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SCHEMA_VERSION = 2;
const SAMPLE_MAX_NODES = 4000;
const SAMPLE_MAX_DEPTH = 24;
const SAMPLE_TEXT_MAX = 8;

/** logs 目录（项目根下），自动建。 */
function logsDir(): string {
  const root = findProjectRoot();
  const dir = path.join(root, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

/** 取当前模块文件所在目录，兼容 cjs（__dirname）与 esm（import.meta.url）两种 bundle。
 *  rpa-dryrun 走 cjs bundle；adapter-lab / selftest 走 esm bundle。
 *  esbuild 对 import.meta.url 在 cjs format 下会自动转成基于 __filename 的等价，故直接用即可。 */
function moduleDir(): string {
  try {
    const url = import.meta.url;
    if (url) {
      const { fileURLToPath } = require('node:url');
      return path.dirname(fileURLToPath(url));
    }
  } catch { /* fallthrough */ }
  try { if (typeof __dirname !== 'undefined') return __dirname; } catch { /* fallthrough */ }
  return process.cwd();
}

/** 向上找 package.json（从模块所在目录起向上找，兜底 cwd）。 */
function findProjectRoot(): string {
  let dir = moduleDir();
  for (let i = 0; i < 8; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** ISO 时间戳（文件名安全）：2026-08-17T14-30-05-123Z */
function isoStamp(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}Z`;
}

// ── 浏览器端 walk（与 console-sampler.js 逐字对齐，schema v2）──────────────────
// 以字符串形式持有，注入 page.evaluate。单函数可审计、可对照控制台原版。
const WALK_TREE_SRC = `
function walkTree(rootEl) {
  var SAMPLE_MAX_NODES = ${SAMPLE_MAX_NODES};
  var SAMPLE_MAX_DEPTH = ${SAMPLE_MAX_DEPTH};
  var SAMPLE_TEXT_MAX = ${SAMPLE_TEXT_MAX};
  var nodeCount = 0;
  var truncated = false;

  function maskUrlPath(u) {
    try {
      var parsed = new URL(u, location.href);
      return (parsed.pathname || '/').replace(/\\d{4,}/g, '<num>').slice(0, 120);
    } catch (e) {
      return String(u || '').split('?')[0].split('#')[0].replace(/\\d{4,}/g, '<num>').slice(0, 120);
    }
  }
  function attrNames(el) {
    var out = [];
    try {
      var as = el.attributes;
      for (var i = 0; i < as.length; i++) {
        var n = as[i].name;
        if (n.indexOf('data-') === 0) out.push(n);   // 只留名字，值就是候选人 ID
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function shortLabel(el) {
    try {
      var tag = (el.tagName || '').toLowerCase();
      if (tag !== 'button' && tag !== 'a' && el.getAttribute('role') !== 'button') return '';
      var t = (el.textContent || '').trim();
      if (!t || t.length > SAMPLE_TEXT_MAX) return '';
      if (/\\d/.test(t)) return '';                   // 含数字的丢掉：可能是薪资/年限/电话片段
      return t;
    } catch (e) { return ''; }
  }
  function walk(el, depth) {
    if (nodeCount >= SAMPLE_MAX_NODES) { truncated = true; return null; }
    if (depth > SAMPLE_MAX_DEPTH) { truncated = true; return null; }
    nodeCount++;
    var node = { t: (el.tagName || '').toLowerCase() };
    var cls = '';
    try { cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || ''; } catch (e) { /* ignore */ }
    if (cls) node.c = String(cls).slice(0, 160);
    if (el.id) node.i = String(el.id).slice(0, 80);
    var da = attrNames(el);
    if (da.length) node.d = da;
    var lab = shortLabel(el);
    if (lab) node.x = lab;

    if (node.t === 'a') {
      try {
        var hrefRaw = el.getAttribute('href') || '';
        if (hrefRaw) { var hp = maskUrlPath(hrefRaw); if (hp) node.h = hp; }
      } catch (e) { /* ignore */ }
    }

    var kids = [];
    try {
      var ch = el.children;
      for (var i = 0; i < ch.length; i++) {
        var k = walk(ch[i], depth + 1);
        if (k) kids.push(k);
        if (nodeCount >= SAMPLE_MAX_NODES) { truncated = true; break; }
      }
    } catch (e) { /* ignore */ }

    // 同源 iframe：与 console-sampler 一致。跨域拿不到 contentDocument 会走 catch 标记。
    if (node.t === 'iframe') {
      var rawSrc = '';
      try { rawSrc = el.getAttribute('src') || ''; } catch (e) { /* ignore */ }
      var maskedSrc = rawSrc.replace(/\\d{4,}/g, '<num>').slice(0, 120);
      try {
        var doc = el.contentDocument;
        if (doc && doc.body) {
          var subPath = maskUrlPath(rawSrc);
          var sub = walk(doc.body, depth + 1);
          if (sub) {
            sub.frame = maskedSrc;
            sub.framePath = subPath;
            kids.push(sub);
          }
        }
      } catch (e) { node.crossOrigin = true; node.frame = maskedSrc; }
    }

    if (kids.length) node.k = kids;
    return node;
  }

  var topPath = maskUrlPath(location.href || '');
  var root = null;
  try { root = walk(rootEl || document.body, 0); } catch (e) { /* ignore */ }
  if (root) { root.framePath = topPath; }
  return { tree: root, nodeCount: nodeCount, truncated: truncated };
}
`;

/** 在浏览器端执行 walkTree，返回骨架对象（不含 envelope）。 */
async function sampleInBrowser(page: Page): Promise<{ tree: any; nodeCount: number; truncated: boolean } | null> {
  try {
    // 注入 walkTree 定义 + 立即调用，避免 puppeteer evaluate 序列化具名函数的边界问题。
    const result = await page.evaluate(new Function(`${WALK_TREE_SRC}\nreturn walkTree(document.body);`) as any).catch(() => null);
    if (!result) return null;
    return result as { tree: any; nodeCount: number; truncated: boolean };
  } catch {
    return null;
  }
}

export interface DumpSkeletonResult {
  ok: boolean;
  file?: string;
  reason?: string;
}

/**
 * 抓当前页 DOM 骨架并落盘。纯只读，零点击零网络回传。
 * @param page  puppeteer Page（猎聘工作页）
 * @param tag   触发点标识：first-result / city-overlay / <诊断码>
 * @returns 落盘结果（含文件路径或失败原因）
 */
export async function dumpSkeleton(page: Page, tag: string): Promise<DumpSkeletonResult> {
  const safeTag = String(tag || 'untagged').replace(/[^\w.-]/g, '_').slice(0, 64);
  let host = '';
  try { host = await page.evaluate(() => location.host || '').catch(() => ''); } catch { /* ignore */ }
  if (!host) host = 'page';
  const safeHost = host.replace(/[^\w.-]/g, '_').slice(0, 80);

  const sampled = await sampleInBrowser(page);
  if (!sampled || !sampled.tree) {
    return { ok: false, reason: 'walkTree 未返回骨架（页面可能已导航/断开）' };
  }

  let url = '';
  let title = '';
  try {
    const meta = await page.evaluate(() => ({ url: location.href, title: document.title || '' })).catch(() => ({ url: '', title: '' }));
    url = meta.url;
    title = meta.title;
  } catch { /* ignore */ }

  const sample = {
    kind: 'dom-skeleton',
    schemaVersion: SCHEMA_VERSION,
    tag: safeTag,
    url: (url || '').replace(/\d{4,}/g, '<num>').slice(0, 300),
    host,
    title: (title || '').slice(0, 60),
    matchedAdapter: 'liepin',
    sampledAt: Date.now(),
    truncated: sampled.truncated,
    nodeCount: sampled.nodeCount,
    tree: sampled.tree,
    sampledBy: 'skeleton-monitor',
  };

  const file = path.join(logsDir(), `skeleton-${safeTag}-${safeHost}-${isoStamp()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(sample, null, 1), 'utf8');
  } catch (e: any) {
    return { ok: false, reason: `写盘失败: ${e?.message || e}` };
  }
  // ★ 2026-08-18 修复5：落盘成功同步累加 skeletonDumps 计数。
  //   原实现只写盘不计数 → run-summary 的 skeletonDumps 恒 0，但实际落了 N 个 skeleton 文件。
  //   getMonitor() 是单例，dryrun/引擎/各调用点共享同一个，这里记一次即全局可见。
  getMonitor().recordSkeletonDump();
  return { ok: true, file };
}

// ── 运行摘要：钩住 console.warn 统计诊断码与风控事件 ──────────────────────────

/** 诊断码正则：[liepin][diagnostic] CITY_OVERLAY_NO_MATCH: ... */
const DIAG_RE = /\[liepin\]\[diagnostic\]\s+([A-Z_][A-Z0-9_]*):/;
/** 风控/环境事件关键词（非诊断码的 warn，单独计数） */
const RISK_KEYWORDS = [
  '境外 IP 拦截', 'intercept-abroad-ip', '页面停在登录页', '会话已失效',
  '配额已用完', '超过每日上限', '风控', '验证码', '补点一次搜索', '搜索提交异常',
  '严格模式：筛选未生效', '筛选未生效（宽松模式继续）',
];

export interface RunSummary {
  startedAt: number;
  endedAt?: number;
  searches: number;
  viewed: number;
  pages: number;
  riskEvents: number;
  diagnostics: Record<string, number>;
  skeletonDumps: number;
  rowsWritten: number;
  // ★ 2026-08-19 P2-b：去重后新增 / 命中已收录跳过。
  //   周产量 6000+ 目标的验收口径是不重复的人（非浏览次数）。run-summary 此前只有
  //   viewed 没有「去重后新增」，90min 收尾看不出净增量。引擎已有 newTalentsThisRun /
  //   skippedAlreadySeen（rpa-engine.ts），收尾时喂给 monitor 落进 run-summary.json。
  //   平台无关字段——不引入任何平台字面量（check:isolation A8 要求）。
  newTalents: number;
  skippedAlreadySeen: number;
  platform: string;
}

/**
 * 运行监控器：钩住 console.warn 做被动统计（绝不改控制流、绝不抛错影响主流程）。
 * 用法：start() 在 dryrun 起跑时调一次；recordSearch/recordViewed/recordPage 由
 * 调用点显式喂；warn 自动从 console 捕获。end() 落 run-summary.json。
 */
export class SkeletonMonitor {
  private summary: RunSummary;
  private origWarn: typeof console.warn | null = null;

  constructor(platform = 'liepin') {
    this.summary = {
      startedAt: Date.now(),
      searches: 0, viewed: 0, pages: 0,
      riskEvents: 0, diagnostics: {}, skeletonDumps: 0, rowsWritten: 0,
      newTalents: 0, skippedAlreadySeen: 0,
      platform,
    };
  }

  /** 钩住 console.warn。幂等。 */
  start(): void {
    if (this.origWarn !== null) return;
    this.origWarn = console.warn;
    const self = this;
    console.warn = (...args: any[]) => {
      try {
        const text = args.map((a) => (typeof a === 'string' ? a : (a?.message || ''))).join(' ');
        const dm = DIAG_RE.exec(text);
        if (dm && dm[1]) {
          const code = dm[1];
          self.summary.diagnostics[code] = (self.summary.diagnostics[code] || 0) + 1;
        }
        if (RISK_KEYWORDS.some((k) => text.includes(k))) {
          // 诊断码不重复计入 riskEvents
          if (!dm) self.summary.riskEvents++;
        }
      } catch { /* 监控绝不影响主流程 */ }
      try { self.origWarn!(...args); } catch { /* ignore */ }
    };
  }

  recordSearch(n = 1): void { this.summary.searches += n; }
  recordViewed(n = 1): void { this.summary.viewed += n; }
  recordPage(n = 1): void { this.summary.pages += n; }
  recordSkeletonDump(): void { this.summary.skeletonDumps++; }
  recordRows(n: number): void { this.summary.rowsWritten += n; }
  /** 设去重后新增人数（绝对值，收尾时由引擎喂入）。 */
  recordNewTalents(n: number): void { this.summary.newTalents = n; }
  /** 设命中已收录跳过人数（绝对值，收尾时由引擎喂入）。 */
  recordSkippedAlreadySeen(n: number): void { this.summary.skippedAlreadySeen = n; }

  getSummary(): RunSummary { return { ...this.summary }; }

  /** 落 run-summary.json。幂等；恢复 console.warn。 */
  end(extra?: Partial<RunSummary>): string {
    this.summary.endedAt = Date.now();
    if (extra) Object.assign(this.summary, extra);
    if (this.origWarn !== null) {
      try { console.warn = this.origWarn; } catch { /* ignore */ }
      this.origWarn = null;
    }
    const file = path.join(logsDir(), 'run-summary.json');
    try {
      fs.writeFileSync(file, JSON.stringify(this.summary, null, 2), 'utf8');
    } catch { /* ignore */ }
    return file;
  }
}

// ── 单实例（dryrun / 引擎共享同一个 monitor）─────────────────────────────────
let _monitor: SkeletonMonitor | null = null;
export function getMonitor(platform = 'liepin'): SkeletonMonitor {
  if (!_monitor) _monitor = new SkeletonMonitor(platform);
  return _monitor;
}
