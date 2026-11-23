// BOSS 直聘 Adapter —— 从原 platform-adapter.ts 拆分而来，行为与拆分前完全一致。
//
// 拆分目的：让 platform-adapter.ts 成为平台无关的接口 + 注册表；猎聘 adapter 能并列注册。
// 拆分原则：所有从 platform-adapter.ts 原来导出的符号，在拆分后仍由 platform-adapter.ts 继续 re-export，
//           现有调用方（rpa-engine.ts 等）import 路径零变化，保证行为零回归。
//
// 修复历史（保留自原文件）：
//  - H9: 引擎所有平台相关操作通过 adapter 接口调用
//  - 第二轮：tryFavorite/tryGreet/goNextPage 改走 HumanOperator 拟人点击
//  - 第五/六次审查：DEFAULT_BOSS 单一来源 + settings 覆盖；evalWithTimeout 致命错误传播；
//    reboundRetrigger 翻页哨兵边沿修复；isWindowVisible 前置闸；多帧风控检测；
//    probeSessionHealth 基线修正；classifyRiskKind 兜底 riskPageUnknown 等
import type { Page, ElementHandle, Frame } from 'puppeteer-core';
import type { CandidateProfile, SearchConfig, AppSettings, DefenseSignalKind, SpeedMode, QuotaStop } from '../../../shared/types';
import { parseBossSalary } from '../scoring';
import type { HumanOperator } from '../../cdp/human-ops';
import { getSetting } from '../../db';
import type { RiskNetRules } from '../../cdp/chrome';
import type { DailyLimits } from '../../../shared/utils';
import { getDefaultLimits } from '../../../shared/utils';
import type { PlatformAdapter, SearchQuery, SoftHealthSignal, ApplySearchResult } from '../platform-adapter';

// ---------- BOSS 直聘 · 候选人(牛人)搜索面配置（单一来源，可被 settings 覆盖） ----------
export interface BossCfg {
  searchBase: string;
  card: string;
  list: { name: string; position: string; salary: string; company: string; city: string; tags: string; link: string };
  detail: {
    name: string; position: string; company: string; city: string; salary: string; degree: string; exp: string;
    companyInfo: string; companyBio: string; work: string; workCompany: string; workIndustry: string; skills: string;
  };
  pagerNext: string; pagerCur: string;
  favorite: string[]; chat: string[]; chatInput: string[]; send: string[]; sentMsg: string;
  cityCodes: Record<string, string>; expCodes: Record<string, string>;
  degreeCodes: Record<string, string>; salaryCodes: Record<string, string>;
}

const DEFAULT_BOSS: BossCfg = {
  searchBase: 'https://www.zhipin.com/web/boss/recommend',
  card: '.candidate-card-wrap, .card-item, [class*="candidate-card"], [class*="geek-item"], [role="listitem"], li[class*="geek"]',
  list: {
    name: '.geek-name, .name, [class*="geek-name"], [class*="candidate-name"]',
    position: '.geek-position, .expect-position, [class*="expect"] [class*="position"], .job-name',
    salary: '.geek-salary, .expect-salary, [class*="expect"] [class*="salary"], [class*="salary"]',
    company: '.geek-company, .last-company, [class*="company"]',
    city: '.geek-city, .city, [class*="city"], [class*="location"]',
    tags: '.tags .tag, .geek-tags .tag, [class*="tag-list"] [class*="tag"], .base-info span',
    link: 'a[href*="geek"], a[href*="candidate"], a[href]',
  },
  detail: {
    name: '.geek-name, .name, [class*="geek-name"], [class*="resume-name"]',
    position: '.geek-position, .expect-position, .position, .title',
    company: '.geek-company, .current-company, .sider-company .name, [class*="company"] .name',
    city: '.geek-city, .location, [class*="city"]',
    salary: '.geek-salary, .expect-salary, [class*="salary"]',
    degree: '.geek-edu, .edu, .degree, [class*="edu"]',
    exp: '.geek-work-year, .work-year, .experience, [class*="work-year"]',
    companyInfo: '.current-company, .company-info, [class*="company-info"]',
    companyBio: '.company-intro, .company-bio, [class*="company-desc"]',
    work: '.geek-work-exp .item, .work-exp-box .item, [class*="work-exp"] .item, [class*="workExp"] li',
    workCompany: '.company, .company-name, h3, strong',
    workIndustry: '.industry, .job-title, .position',
    skills: '.geek-skills .tag, .skills .tag, [class*="skill"] [class*="tag"], .tag-list .tag',
  },
  pagerNext: '.ui-pager-next:not(.disabled), .next-page:not(.disabled), [class*="pager"] [class*="next"]:not(.disabled), .next:not(.disabled)',
  pagerCur: '.ui-pager .cur, .pager .active, .options-pages .selected, [class*="pager"] .cur',
  favorite: ['[class*="collect"]', '[class*="favorite"]', '[class*="star-btn"]', '[ka*="collect"]', 'button.favorite'],
  chat: ['[class*="start-chat"]', '[class*="btn-chat"]', '[class*="communicate"]', '[class*="greet"]', '[ka*="chat"]', 'button.btn-greet'],
  chatInput: ['div.chat-input textarea', '.chat-container textarea', '#chat-input textarea', 'textarea[placeholder*="输入"]', '.dialog-container textarea', 'div[contenteditable="true"]'],
  send: ['.btn-send', 'button[ka="send-message"]', '.chat-input button.send', '.send-btn'],
  sentMsg: '.message-item, .chat-message, .im-message, .message-content, [class*="message"]',
  cityCodes: {
    北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600',
    杭州: '101210100', 南京: '101190100', 成都: '101270100', 武汉: '101200100',
    西安: '101110100', 苏州: '101190400', 合肥: '101220100', 长沙: '101250100',
    重庆: '101040100', 天津: '101030100', 青岛: '101120200', 厦门: '101230200', 全国: '100010000',
  },
  expCodes: { '应届生': '103', '1年以内': '104', '1-3年': '101', '3-5年': '102', '5-10年': '105', '10年以上': '106', '不限': '' },
  degreeCodes: { '大专': '202', '本科': '203', '硕士': '204', '博士': '205', '不限': '' },
  salaryCodes: { '10K以下': '403', '10-20K': '404', '20-35K': '405', '35-50K': '406', '50K以上': '407' },
};

// 合并用户在 settings 里粘贴的覆盖 JSON，失败则用默认
function getBossConfig(): BossCfg {
  try {
    const raw = getSetting<AppSettings>('app-settings', null as any)?.browser?.bossSelectors;
    if (!raw || typeof raw !== 'string') return DEFAULT_BOSS;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return DEFAULT_BOSS;
    return {
      ...DEFAULT_BOSS, ...o,
      list: { ...DEFAULT_BOSS.list, ...(o.list || {}) },
      detail: { ...DEFAULT_BOSS.detail, ...(o.detail || {}) },
      cityCodes: { ...DEFAULT_BOSS.cityCodes, ...(o.cityCodes || {}) },
      expCodes: { ...DEFAULT_BOSS.expCodes, ...(o.expCodes || {}) },
      degreeCodes: { ...DEFAULT_BOSS.degreeCodes, ...(o.degreeCodes || {}) },
      salaryCodes: { ...DEFAULT_BOSS.salaryCodes, ...(o.salaryCodes || {}) },
    };
  } catch {
    return DEFAULT_BOSS;
  }
}

const BOSS_RECOMMEND_URL = 'https://www.zhipin.com/web/chat/recommend';
const RECOMMEND_FRAME_RE = /\/web\/frame\/recommend\//;

function getRecommendFrame(page: Page): Frame {
  for (const f of page.frames()) {
    if (RECOMMEND_FRAME_RE.test(f.url())) return f;
  }
  return page.mainFrame();
}

export function isFatalPageError(e: any): boolean {
  const msg = String(e?.message || e || '');
  return /Target closed|Session closed|Connection closed|browser has disconnected|Page crashed|detached Frame|frame was detached|Protocol error.*Target closed|Requesting main frame too early|WebSocket is not open/i.test(
    msg,
  );
}

async function evalWithTimeout<T>(
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
    if (isFatalPageError(e)) throw e;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const evalWithTimeout__test = evalWithTimeout;
export function isRiskPage__test(page: any): Promise<boolean> {
  return bossAdapter.isRiskPage(page as Page);
}

let lastDiag = '';
export function getLastLoadMoreDiag(): string { return lastDiag; }

export async function isWindowVisible(page: Page): Promise<boolean | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      page.evaluate(() => document.visibilityState !== 'hidden'),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), 3000); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function recommendFrameRect(
  page: Page,
  budgetMs = 8000,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const cap = <T>(p: Promise<T>, ms: number, fb: T): Promise<T> => {
    let t: NodeJS.Timeout | null = null;
    return Promise.race([
      p.catch(() => fb),
      new Promise<T>((res) => { t = setTimeout(() => res(fb), ms); }),
    ]).finally(() => { if (t) clearTimeout(t); });
  };
  try {
    const frame = getRecommendFrame(page);
    if (frame === page.mainFrame()) return null;
    const el = await cap(frame.frameElement(), budgetMs / 3, null);
    if (!el) return null;
    const box = await cap(el.boundingBox(), budgetMs / 3, null);
    try { await el.dispose(); } catch { /* ignore */ }
    if (!box) return null;
    const vp = await cap(page.evaluate(() => ({
      w: window.innerWidth || 0,
      h: window.innerHeight || 0,
    })), budgetMs / 3, null as { w: number; h: number } | null);
    if (!vp || !vp.w || !vp.h) {
      return box.width >= 50 && box.height >= 50 ? box : null;
    }
    const x1 = Math.max(0, box.x);
    const y1 = Math.max(0, box.y);
    const x2 = Math.min(vp.w, box.x + box.width);
    const y2 = Math.min(vp.h, box.y + box.height);
    const width = x2 - x1;
    const height = y2 - y1;
    if (width < 50 || height < 50) return null;
    return { x: x1, y: y1, width, height };
  } catch {
    return null;
  }
}

const PICK_SCROLLER_SRC = `(function pickScroller() {
  var normalizeDoc = function (el) {
    if (el === document.body || el === document.documentElement) {
      return document.scrollingElement || document.documentElement;
    }
    return el;
  };
  var anchors = [];
  var list = document.querySelector('ul.card-list, [class*="card-list"], [class*="recommend-list"]');
  if (list) anchors.push(list);
  var firstCard = document.querySelector('li.card-item');
  if (firstCard && firstCard.parentElement) anchors.push(firstCard.parentElement);
  var scrollable = null, forced = null;
  for (var a = 0; a < anchors.length; a++) {
    var el = anchors[a];
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 20) {
        var oy = '';
        try { oy = getComputedStyle(el).overflowY || ''; } catch (e) { oy = ''; }
        if (/auto|scroll|overlay/.test(oy)) { scrollable = el; break; }
        if (!forced) forced = el;
      }
      el = el.parentElement;
    }
    if (scrollable) break;
  }
  if (scrollable) return normalizeDoc(scrollable);
  var se = document.scrollingElement || document.documentElement;
  if (se && se.scrollHeight > se.clientHeight + 20) return se;
  return normalizeDoc(forced || se);
})()`;

export function isOnRecommendPage(page: Page): boolean {
  if (/\/web\/chat\/recommend/.test(page.url())) return true;
  return page.frames().some((f) => RECOMMEND_FRAME_RE.test(f.url()));
}

export async function isRateWarning(page: Page): Promise<boolean> {
  const re = /操作速度过快|增大操作间隔|操作太快|降低操作频率|放慢操作/;
  const frames = [page.mainFrame(), getRecommendFrame(page)];
  for (const f of frames) {
    try {
      const txt = await evalWithTimeout(f, () => (document.body ? document.body.innerText : ''), 4000);
      if (txt && re.test(txt)) return true;
    } catch (e) {
      if (isFatalPageError(e)) throw e;
    }
  }
  return false;
}

let aBaseline: boolean | null = null;
let ohpcBaseline: boolean | null = null;
let skeletonSince = 0;
let securitySeen = false;

export async function probeSessionHealth(page: Page): Promise<Array<'cookieMutation' | 'skeletonStuck' | 'securityJsFail'>> {
  const out: Array<'cookieMutation' | 'skeletonStuck' | 'securityJsFail'> = [];
  try {
    const r = await evalWithTimeout(page.mainFrame(), () => {
      const cookie = document.cookie || '';
      const hasA = /(?:^|;\s*)__a=/.test(cookie);
      const hasOHPC = /(?:^|;\s*)isOHPC=/.test(cookie);
      const skeleton = !!document.querySelector('.page-loading, [class*="skeleton"], [class*="loading-wrap"]');
      const bodyTxt = (document.body?.innerText || '').slice(0, 400);
      const loadingText = /加载中，请稍候|加载中\.\.\.|正在加载/.test(bodyTxt);
      const secDefined = typeof (window as any).Security !== 'undefined';
      const onBossApp = /^\/web\/boss\//.test(location.pathname);
      return { hasA, hasOHPC, skeleton, loadingText, secDefined, onBossApp };
    }, 4000);
    if (!r) return out;
    let cards = 0;
    try {
      cards = (await evalWithTimeout(getRecommendFrame(page), () => document.querySelectorAll('li.card-item').length, 3000)) ?? 0;
    } catch { cards = 0; }
    if (aBaseline === null && r.hasA) aBaseline = true;
    if (ohpcBaseline === null && r.hasOHPC) ohpcBaseline = true;
    if ((aBaseline === true && !r.hasA) || (ohpcBaseline === true && !r.hasOHPC)) {
      out.push('cookieMutation');
    }
    const skeletonNow = (r.skeleton || r.loadingText) && cards === 0;
    if (skeletonNow) {
      if (skeletonSince === 0) skeletonSince = Date.now();
      if (Date.now() - skeletonSince > 15000) out.push('skeletonStuck');
    } else {
      skeletonSince = 0;
    }
    if (r.secDefined) securitySeen = true;
    if (securitySeen && !r.secDefined && cards > 0) out.push('securityJsFail');
  } catch { /* 探针不可影响主流程 */ }
  return out;
}

export function resetHealthBaseline(): void {
  aBaseline = null;
  ohpcBaseline = null;
  skeletonSince = 0;
  securitySeen = false;
}

export async function classifyRiskKind(page: Page): Promise<DefenseSignalKind> {
  const agg = {
    verify: false, login: false, escalate: false, yidun: false, geetest: false,
    entryLayer: false, restricted: false, rateText: false,
  };
  for (const frame of [page.mainFrame(), getRecommendFrame(page)]) {
    try {
      const r = await evalWithTimeout(frame, () => {
        const body = document.body?.innerText || '';
        const has = (sel: string) => !!document.querySelector(sel);
        const path = location.pathname.toLowerCase();
        return {
          verify: /verify|passport/.test(path) || location.href.toLowerCase().includes('callbackurl='),
          login: /请先登录|请登录|扫码登录|短信验证|手机号登录|登录后查看/.test(body),
          escalate: /请依次点击|点选验证|图标验证|语音验证|按顺序点击/.test(body) || has('.geetest_item_img'),
          yidun: has('[class*="yidun"], [class*="dun_"], #dun, #captcha_div'),
          geetest: has('[class*="geetest"], #geetest-container'),
          entryLayer: /IP地址存在异常|环境异常|访问被拒绝|访问异常/.test(body),
          restricted: /账号异常|账号已被|账号受限|账号被冻结|账号已封禁|被限制/.test(body),
          rateText: /访问过于频繁|操作过于频繁|请求过于频繁|频率过高|请稍后再试/.test(body),
        };
      }, 5000);
      if (!r) continue;
      agg.verify ||= r.verify; agg.login ||= r.login; agg.escalate ||= r.escalate;
      agg.yidun ||= r.yidun; agg.geetest ||= r.geetest;
      agg.entryLayer ||= r.entryLayer; agg.restricted ||= r.restricted; agg.rateText ||= r.rateText;
    } catch (e) {
      if (isFatalPageError(e)) throw e;
    }
  }
  if (agg.verify) return 'verifyRedirect';
  if (agg.login) return 'loginLost';
  if (agg.restricted) return 'accountRestricted';
  if (agg.escalate) return 'captchaEscalate';
  if (agg.yidun) return 'captchaYidun';
  if (agg.geetest) return 'captchaGeetest';
  if (agg.entryLayer) return 'apiCode35';
  if (agg.rateText) return 'http429';
  return 'riskPageUnknown';
}

async function humanClickSelectorsFn(page: Page, op: HumanOperator, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      try {
        return await op.clickElement(el);
      } catch {
        try { await el.click(); return true; } catch { /* continue */ }
      }
    }
  }
  return false;
}

function riskFrames(page: Page): Frame[] {
  const main = page.mainFrame();
  const rec = getRecommendFrame(page);
  return rec === main ? [main] : [main, rec];
}

const detectRiskInFrameFn = () => {
    const body = (document.body?.innerText || '');
    const url = location.href.toLowerCase();
    const title = (document.title || '').toLowerCase();
    const path = location.pathname.toLowerCase();
    const pathKw = [
      'verify', 'captcha', 'security', 'risk', 'block', 'unusual', 'safe',
      'login', 'signin', 'passport', 'auth',
      'challenge', 'verification', 'validate',
    ];
    const whitelist = ['/chat/', '/web/boss/', '/web/geek/', '/web/frame/', '/gongsi/', '/job_detail/'];
    const inWhitelist = whitelist.some((w) => path.includes(w));
    if (!inWhitelist) {
      if (pathKw.some((k) => path.includes(k))) return true;
      if (url.includes('callbackurl=')) return true;
    } else if (/login|signin|passport|auth/.test(path)) {
      return true;
    }
    const titleKw = ['登录', '验证', '安全', '异常', '风险', '登录Boss', 'Boss直聘登录'];
    if (titleKw.some((k) => title.includes(k)) && /login|signin|passport|auth|verify|safe/.test(path)) {
      return true;
    }
    const textKw = [
      '请完成验证', '滑动验证', '拖动滑块', '拖动下方滑块', '人机验证', '安全验证',
      '点选验证', '请依次点击', '请点击', '图片验证', '验证安全',
      '访问过于频繁', '操作过于频繁', '请求过于频繁', '请稍后再试', '频率过高', '访问异常', '请先完成验证',
      '账号异常', '账号已被', '被限制', '账号受限', '账号被冻结', '账号已封禁',
      '请先登录', '请登录', '登录后查看', '扫码登录', '短信验证', '手机号登录',
      '温馨提示', '风险提示', '安全提示', '异常登录', '异地登录', '设备异常',
      'geetest', 'Geetest', '极验', '易盾', '网易易盾', 'yidun', 'dun',
      'IP地址存在异常', '环境异常', '访问被拒绝',
    ];
    const hit = textKw.some((k) => body.includes(k));
    if (hit && body.length < 2000) return true;
    const strongKw = [
      '拖动滑块', '人机验证', '请依次点击', '点选验证', '滑动验证',
      '账号已被冻结', '账号已封禁', '账号受限',
      '请先登录', '扫码登录', '异常登录',
      'IP地址存在异常', '访问被拒绝', '环境异常',
    ];
    if (strongKw.some((k) => body.includes(k))) return true;
    const sel = [
      '.verify-slider', '.captcha', '.security-check',
      '[class*="verify"]', '[class*="captcha"]', '[class*="slider-verify"]',
      '[class*="geetest"]', '.geetest_radar_tip', '.geetest_panel', '#geetest-container', '.geetest_item_img',
      '.yidun_intelli', '.yidun_slider', '.yidun_popup', '.yidun_classic-container',
      '#dun', '.dun_intellisense', '#captcha_div', '[class*="yidun"]', '[class*="dun_"]',
      'iframe[src*="captcha"]', 'iframe[src*="verify"]', 'iframe[src*="geetest"]',
      'iframe[src*="yidun"]', 'iframe[src*="cstaticdun"]', 'iframe[src*="dun.163"]',
      '.login-modal', '.login-dialog', '.auth-modal',
      '.risk-tip', '.warning-dialog', '.block-dialog',
      '[class*="dialog"] [class*="login"]', '[class*="modal"] [class*="login"]',
    ].join(',');
    if (document.querySelector(sel)) return true;
    return false;
};

function parseYm(s: string, fallbackNow = false): number | null {
  if (!s || /至今|今|present/i.test(s)) return fallbackNow ? new Date().getFullYear() + new Date().getMonth() / 12 : null;
  const m = String(s).match(/(\d{4})(?:[.\-/](\d{1,2}))?/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (!y || y < 1950 || y > 2100) return null;
  return y + (m[2] ? (parseInt(m[2], 10) - 1) / 12 : 0);
}

function mapCardToProfile(r: any): CandidateProfile {
  const edus: any[] = r.edus || [];
  const works: any[] = r.works || [];
  const eduDegree = (edus[0] && edus[0].degree)
    || (r.domBase || []).find((x: string) => /本科|大专|硕士|博士/.test(x)) || '';
  const majors = edus.map((e) => e.major).filter(Boolean);
  const schools = edus.map((e) => e.school).filter(Boolean);
  let expYears: number | undefined;
  if (works.length) {
    let months = 0;
    for (const w of works) {
      if (w.months > 0) { months += w.months; continue; }
      const a = parseYm(w.startDate);
      const b = parseYm(w.endDate, !!w.current);
      if (a != null && b != null && b >= a) months += Math.round((b - a) * 12);
    }
    if (months > 0) expYears = Math.round((months / 12) * 10) / 10;
  }
  if (expYears == null && r.fresh) expYears = 0;
  const gradTs = edus.length ? parseYm(edus[0].endDate) : null;
  const nowTs = new Date().getFullYear() + new Date().getMonth() / 12;
  const graduationYear = gradTs != null ? Math.floor(gradTs) : undefined;
  const currentlyStudying = gradTs != null ? gradTs > nowTs : undefined;
  const emphasis = works.flatMap((w) => w.emphasis || []);
  const skills = [...new Set([
    ...emphasis,
    ...(r.matchWords || []),
    ...(r.highlights || []),
    ...majors,
  ].filter(Boolean))] as string[];
  const p: CandidateProfile = {
    name: r.name || undefined,
    position: r.position || undefined,
    city: r.city || undefined,
    degree: eduDegree || undefined,
    experienceYears: expYears,
    selfIntro: r.selfIntro || undefined,
    freshGraduate: r.fresh,
    active: r.active || undefined,
    matchWords: r.matchWords,
    platformHighlights: r.highlights,
    skills,
    education: edus.map((e) => ({
      school: e.school, degree: e.degree, major: e.major,
      startDate: e.startDate, endDate: e.endDate,
    })),
    workHistory: works.map((w) => ({
      company: w.company, industry: w.industry, position: w.position,
      description: w.description, performance: w.performance, emphasis: w.emphasis,
      startDate: w.startDate, endDate: w.endDate, months: w.months, current: w.current,
    })),
    graduationYear,
    currentlyStudying,
    contacted: !!r.contacted,
    seen: !!r.seen,
    url: r.encryptGeekId ? `boss:geek:${r.encryptGeekId}` : undefined,
    bossMeta: {
      encryptGeekId: r.encryptGeekId, geekId: r.geekId, securityId: r.securityId,
      lid: r.lid, expectId: r.expectId, jobId: r.jobId, encryptJobId: r.encryptJobId,
    },
  };
  const cur = works.find((w) => w.current) || works[0];
  if (cur) {
    if (cur.company) p.company = cur.company;
    if (cur.industry) p.companyTag = cur.industry;
  }
  if (schools.length) p.companyBio = undefined;
  const ageM = String(r.ageDesc || '').match(/(\d{2})\s*岁/);
  if (ageM) p.age = parseInt(ageM[1], 10);
  if (r.lowSalary > 0 && r.highSalary > 0) p.salary = `${r.lowSalary}-${r.highSalary}K`;
  else {
    const parsed = parseBossSalary(r.salary);
    if (parsed) p.salary = `${parsed.min}-${parsed.max}K`;
    else if (r.salary) p.salary = r.salary;
  }
  return p;
}

// ── 网络层风控规则（注入给 BOSS 平台的 ChromeManager）──
const BOSS_RISK_NET: RiskNetRules = {
  apiUrl: /\/wapi\/(zpgeek|zprelation|zpchat|zpjob|zpuser|zpsecureflow)/,
  excludeUrl: /dapCommon|actionLog|logapi|shink|z\.zhipin/,
  classifyBody(body: any) {
    if (!body || typeof body !== 'object') return null;
    const c = body.code;
    const msg = (body.message || '') as string;
    if (c === 35) {
      return { code: 35, message: msg || 'IP地址存在异常行为', kind: 'apiCode35' as DefenseSignalKind };
    }
    if (typeof c === 'number' && c !== 0 && /异常|频繁|风控|拒绝|受限|限制|验证|封禁|block/i.test(msg)) {
      const kind: DefenseSignalKind = /登录|重新登录|未登录|token/i.test(msg)
        ? 'loginLost'
        : /频繁/.test(msg) ? 'http429' : 'apiCode35';
      return { code: c, message: msg.slice(0, 200), kind };
    }
    return null;
  },
  secReportUrl: /\/wapi\/zpApm\/actionLog\//,
  parseSecReport(probe: string) {
    if (!/device-action-report/.test(probe)) return null;
    const m = probe.match(/p2["']?\s*[:=]\s*["']?(100\d{2}|51\d{3})/);
    if (!m) return null;
    const p2 = parseInt(m[1], 10);
    const codeMap: Record<number, string> = {
      10007: '检测到lk-docker（WebDriver注入DOM）',
      10009: '检测到glue-toolbar（自动化工具栏）',
      10010: '检测到WebView环境',
      10013: '检测到beisenkeepcore（北森内核）',
      10014: '检测到WebView(hasWebview)',
      10017: '检测到自动化全局变量（CDP/WebDriver/Selenium/Playwright/Phantom等）',
      10018: '检测到WebView（二次确认）',
      10019: 'UA异常模式',
      10021: '检测到React DevTools扩展',
      10027: 'webdriver属性被JS层hook（反检测对抗痕迹）',
      51002: '来源异常（localStorage含飞书系token）',
      51003: 'referrer来源异常',
      51004: '非常态入口（非zhipin来源直接进入）',
    };
    return { code: String(p2), desc: codeMap[p2] || `Boss端环境检测码p2=${p2}` };
  },
};

export const bossAdapter: PlatformAdapter = {
  id: 'boss',
  name: 'BOSS 直聘',
  // ── 身份与环境 ──
  hostPattern: /(^|\.)zhipin\.com$/i,
  internalReferer: 'https://www.zhipin.com/',
  defaultCdpPort: 9222,
  profileDirName: 'chrome-profile',
  loginStartUrl: 'https://www.zhipin.com/web/boss/recommend',
  loginOrVerifyPattern: /passport|\/login|signin|\/user\/|verify|captcha|callbackUrl=/i,
  riskNet: BOSS_RISK_NET,
  secReportSignalKind: 'bossSecReport' as DefenseSignalKind,
  describeSecReport(code: number): string {
    const map: Record<number, string> = {
      10007: '检测到lk-docker（WebDriver注入DOM）',
      10009: '检测到glue-toolbar（自动化工具栏）',
      10010: '检测到WebView环境',
      10013: '检测到beisenkeepcore（北森内核）',
      10014: '检测到WebView(hasWebview)',
      10017: '检测到自动化全局变量（CDP/WebDriver/Selenium/Playwright/Phantom等）',
      10018: '检测到WebView（二次确认）',
      10019: 'UA异常模式',
      10021: '检测到React DevTools扩展',
      10027: 'webdriver属性被JS层hook（反检测对抗痕迹）',
      51002: '来源异常（localStorage含飞书系token）',
      51003: 'referrer来源异常',
      51004: '非常态入口（非站内来源直接进入）',
    };
    return map[code] || `Boss端环境检测码p2=${code}`;
  },

  // ── 配额与阶段 ──
  resolveDailyLimits(mode: SpeedMode, _settings: AppSettings): DailyLimits {
    return { ...getDefaultLimits(mode, 'boss') };
  },
  stageBEnabled(_settings: AppSettings): boolean {
    return !!(_settings?.rpa?.deepScrape);
  },

  // ── 列表形态 ──
  infiniteScroll: true,
  maxPagesPerQuery(_mode: SpeedMode): number {
    return Infinity;
  },
  // 推荐流没有搜索参数 → 单个空组合，引擎照常跑统一循环
  buildQueries(_search: SearchConfig, _mode: SpeedMode): SearchQuery[] {
    return [{ label: '推荐牛人' }];
  },
  isAttachedToWorkSurface(page: Page): boolean {
    if (/\/web\/chat\/recommend/.test(page.url())) return true;
    return page.frames().some((f) => RECOMMEND_FRAME_RE.test(f.url()));
  },

  buildSearchUrl(_search: SearchConfig): string {
    const C = getBossConfig();
    return C.searchBase && /recommend/.test(C.searchBase) ? C.searchBase : BOSS_RECOMMEND_URL;
  },

  async isRiskPage(page: Page): Promise<boolean> {
    const frames = riskFrames(page);
    let evaluated = 0;
    for (const frame of frames) {
      try {
        const hit = await evalWithTimeout(frame, detectRiskInFrameFn as any, 5000);
        if (hit === null) continue;
        evaluated++;
        if (hit) return true;
      } catch (e) {
        if (isFatalPageError(e)) throw e;
      }
    }
    if (evaluated === 0) {
      let alive = true;
      try { alive = !page.isClosed() && page.browser().isConnected(); } catch { alive = false; }
      if (!alive) {
        throw new Error('Target closed：浏览器/页面已断开，风控检测无法进行（这是环境故障，不是平台风控）');
      }
      console.warn('[isRiskPage] 页面仍在但所有帧都未能求值，按存在风险处理');
      return true;
    }
    return false;
  },

  async extractCards(page: Page): Promise<CandidateProfile[]> {
    try {
      const frame = getRecommendFrame(page);
      const raw = await evalWithTimeout(frame, () => {
        const scan = (o: any, d = 0): any => {
          if (!o || typeof o !== 'object' || d > 3) return null;
          const ks = Object.keys(o);
          if ((ks.includes('securityId') || ks.includes('encryptGeekId'))
            && (ks.includes('geekName') || ks.includes('geekEdus') || ks.includes('expectPositionName'))) return o;
          for (const k of ks) { if (/geek|card|item|data|info/i.test(k)) { const r = scan(o[k], d + 1); if (r) return r; } }
          return null;
        };
        const getGeek = (li: Element): any => {
          for (const n of [li, ...Array.from(li.querySelectorAll('*'))]) {
            const v = (n as any).__vue__;
            if (!v) continue;
            const g = scan(v.$data) || scan(v.$props);
            if (g) return g;
          }
          return null;
        };
        const cards = Array.from(document.querySelectorAll('li.card-item'))
          .filter((li) => li.querySelector('.card-inner[data-geekid]'));
        return cards.map((li) => {
          const inner = li.querySelector('.card-inner');
          const g = getGeek(li);
          if (g) {
            const edus = (g.geekEdus && g.geekEdus.length ? g.geekEdus : (g.showEdus || [])).map((e: any) => ({
              school: e.school || '', major: e.major || '', degree: e.degreeName || '',
              startDate: e.startDate || '', endDate: e.endDate || '',
            }));
            const works = (g.showWorks && g.showWorks.length ? g.showWorks : (g.geekWorks || [])).map((w: any) => ({
              company: w.company || '',
              industry: w.industry || w.industryCategory || '',
              position: w.positionName || w.positionCategory || '',
              description: w.responsibility || w.workDesc || '',
              performance: w.workPerformance || '',
              emphasis: Array.isArray(w.workEmphasisList)
                ? w.workEmphasisList.map((x: any) => (x && x.content) || x).filter(Boolean)
                : [],
              startDate: w.startDate || '', endDate: w.endDate || '',
              workTime: w.workTime || '', months: Number(w.workMonths) || 0,
              current: !!w.current,
            }));
            return {
              encryptGeekId: g.encryptGeekId || g.encGeekId || inner?.getAttribute('data-geekid') || '',
              geekId: String(g.geekId || ''), securityId: g.securityId || '', lid: g.lid || '',
              expectId: String(g.expectId || ''), jobId: String(g.jobId || ''), encryptJobId: g.encryptJobId || '',
              name: g.geekName || '', ageDesc: g.ageDesc || '', fresh: !!g.freshGraduate,
              selfIntro: (g.geekDesc && g.geekDesc.content) || '',
              position: g.expectPositionName || '', city: g.expectLocationName || '', salary: g.salary || '',
              lowSalary: Number(g.lowSalary) || 0, highSalary: Number(g.highSalary) || 0,
              edus, works,
              matchWords: (g.markWords || []).map((m: any) => (m && m.content) || m).filter(Boolean),
              highlights: (g.hlmatches || []).map((m: any) => (m && m.content) || m).filter(Boolean),
              active: g.activeTimeDesc || g.actionDateDesc || '',
              contacted: !!(g.haveChatted || g.isFriend),
              seen: !!g.viewed,
            };
          }
          const t = (s: string) => { const e = li.querySelector(s); return e ? (e.textContent || '').trim() : ''; };
          const base = Array.from(li.querySelectorAll('.base-info span')).map((e) => (e.textContent || '').trim()).filter(Boolean);
          return {
            encryptGeekId: inner?.getAttribute('data-geekid') || '', geekId: '', securityId: '', lid: '',
            expectId: '', jobId: '', encryptJobId: '', name: t('.name'), ageDesc: base[0] || '', fresh: /应届/.test(base.join('')),
            selfIntro: '', position: t('.expect-wrap .content'), city: '', salary: t('.salary-wrap'),
            lowSalary: 0, highSalary: 0,
            edus: [] as any[], works: [] as any[], matchWords: [] as string[], highlights: [] as string[],
            active: '', contacted: false, seen: false, domBase: base,
          };
        });
      }, 8000);
      if (raw === null) return null as any;
      return (raw || []).filter((r) => r.encryptGeekId && r.name).map((r: any) => mapCardToProfile(r));
    } catch (e) {
      if (isFatalPageError(e)) throw e;
      console.warn('[extractCards] 解析失败：', (e as any)?.message || e);
      return null as any;
    }
  },

  async findCardElement(page: Page, card: CandidateProfile): Promise<ElementHandle | null> {
    const frame = getRecommendFrame(page);
    const gid = card.bossMeta?.encryptGeekId;
    if (gid) {
      const el = await frame.$(`li.card-item .card-inner[data-geekid="${gid}"]`).catch(() => null);
      if (el) {
        const li = await el.evaluateHandle((n) => n.closest('li.card-item') || n).catch(() => el);
        return li as ElementHandle;
      }
    }
    if (card.name) {
      const cards = await frame.$$('li.card-item');
      for (const c of cards) {
        const t = await c.evaluate((el) => (el.textContent || '').slice(0, 120)).catch(() => '');
        if (t.includes(card.name)) return c;
      }
    }
    return null;
  },

  async extractDetail(page: Page): Promise<Partial<CandidateProfile>> {
    const C = getBossConfig();
    try {
      const evalIn = async (target: Page | Frame) => target.evaluate((D: BossCfg['detail']) => {
        const getText = (sel: string) => {
          const el = document.querySelector(sel);
          return el ? (el.textContent || '').trim() : '';
        };
        const name = getText(D.name);
        const position = getText(D.position);
        const company = getText(D.company);
        const city = getText(D.city);
        const salary = getText(D.salary);
        const degree = getText(D.degree);
        const exp = getText(D.exp);
        const companyInfoText = getText(D.companyInfo);
        let companySize = '';
        let companyStage = '';
        const sizeMatch = companyInfoText.match(/(\d{2,5}\s*[-–—]\s*\d{2,5}\s*人|\d{4,6}\s*人以上|少于\s*\d+\s*人)/);
        if (sizeMatch) companySize = sizeMatch[0];
        const stageMatch = companyInfoText.match(/(未融资|天使轮|[A-G]轮|Pre-IPO|D轮及以上|上市公司|已上市|国企|央企|外资|外企|合资|民营)/);
        if (stageMatch) companyStage = stageMatch[0];
        const companyBio = getText(D.companyBio);
        const workHistory = Array.from(document.querySelectorAll(D.work)).map((el) => ({
          company: el.querySelector(D.workCompany)?.textContent?.trim() || '',
          industry: el.querySelector(D.workIndustry)?.textContent?.trim() || '',
        }));
        const skills = Array.from(document.querySelectorAll(D.skills))
          .map((el) => (el.textContent || '').trim()).filter(Boolean);
        return { name, position, company, city, salary, degree, exp, workHistory, skills, companySize, companyStage, companyBio };
      }, C.detail);
      const isEmpty = (x: any) =>
        !x || (!x.name && !x.position && !(x.workHistory && x.workHistory.length) && !(x.skills && x.skills.length));
      const fr = getRecommendFrame(page);
      let info = fr !== page.mainFrame() ? await evalIn(fr).catch(() => null) : null;
      if (isEmpty(info)) info = await evalIn(page);
      if (isEmpty(info)) return {};
      const p: Partial<CandidateProfile> = {
        name: info.name,
        position: info.position || undefined,
        company: info.company || undefined,
        companySize: info.companySize || undefined,
        companyStage: info.companyStage || undefined,
        companyBio: info.companyBio || undefined,
        city: info.city,
        degree: info.degree || undefined,
        skills: info.skills,
        workHistory: info.workHistory,
      };
      const parsed = parseBossSalary(info.salary);
      p.salary = parsed ? `${parsed.min}-${parsed.max}K` : info.salary;
      const years = info.exp?.match(/(\d+)/);
      if (years) p.experienceYears = parseInt(years[1], 10);
      return p;
    } catch {
      return {};
    }
  },

  async tryFavorite(page: Page, op: HumanOperator): Promise<boolean> {
    const frame = getRecommendFrame(page);
    const sels = ['.like-icon-and-text', ...getBossConfig().favorite];
    for (const sel of sels) {
      const el = await frame.$(sel).catch(() => null);
      if (el) { try { return await op.clickElement(el); } catch { try { await el.click(); return true; } catch { /* next */ } } }
    }
    return false;
  },

  async tryGreet(page: Page, op: HumanOperator, message?: string): Promise<boolean> {
    const C = getBossConfig();
    const recFrame = getRecommendFrame(page);
    let clicked = false;
    const greetBtn = await recFrame.$('.btn.btn-greet, .btn-greet').catch(() => null);
    if (greetBtn) {
      try { clicked = await op.clickElement(greetBtn); } catch { try { await (greetBtn as any).click(); clicked = true; } catch { /* fallthrough */ } }
    }
    if (!clicked) clicked = await humanClickSelectorsFn(page, op, C.chat);
    if (!clicked) return false;
    if (!message) return true;
    await op.wait('page');
    const chatSelectors = C.chatInput;
    const findInput = async (): Promise<{ frame: Frame; el: ElementHandle } | null> => {
      for (const sel of chatSelectors) {
        const el = await page.$(sel).catch(() => null);
        if (el) return { frame: page.mainFrame(), el };
      }
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        for (const sel of chatSelectors) {
          const el = await frame.$(sel).catch(() => null);
          if (el) return { frame, el };
        }
      }
      return null;
    };
    const readInput = async (input: ElementHandle): Promise<string | null> => input.evaluate((node: any) => {
      const v = (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT')
        ? (node.value || '') : (node.innerText || node.textContent || '');
      return String(v).trim();
    }).catch(() => null);
    const verifySent = async (frame: Frame, input: ElementHandle, msg: string, typedOk: boolean): Promise<boolean> => {
      const snippet = msg.slice(0, 12);
      const inStream = await frame.evaluate((text: string, msgSel: string) => {
        const nodes = document.querySelectorAll(msgSel);
        for (const n of Array.from(nodes)) if ((n.textContent || '').includes(text)) return true;
        return false;
      }, snippet, C.sentMsg).catch(() => false);
      if (inStream) return true;
      if (!typedOk) return false;
      const after = await readInput(input);
      return after !== null && after.length === 0;
    };
    let hit: { frame: Frame; el: ElementHandle } | null = null;
    for (let attempt = 0; attempt < 5 && !hit; attempt++) {
      await new Promise((r) => setTimeout(r, 800));
      hit = await findInput();
    }
    if (!hit) {
      const hasIframe = page.frames().length > 1;
      console.warn(hasIframe ? '[tryGreet] iframe 内无法定位输入框，判定发送失败' : '[tryGreet] 未找到聊天输入框，判定发送失败');
      return false;
    }
    const { frame, el: inputEl } = hit;
    try {
      await op.clickElement(inputEl);
      await op.wait('click');
      if (!await op.typeChatMessage(inputEl, message)) {
        console.warn('[tryGreet] 消息未能输入到聊天框，放弃发送');
        return false;
      }
      await op.wait('type');
      const typedText = await readInput(inputEl);
      const typedOk = typedText != null && typedText.includes(message.slice(0, 6));
      if (!typedOk) console.warn('[tryGreet] 未能确认消息已进入输入框');
      let sent = false;
      for (const sel of C.send) {
        const btn = await frame.$(sel).catch(() => null);
        if (!btn) continue;
        sent = await op.clickElement(btn).catch(() => false);
        try { await (btn as any).dispose?.(); } catch { /* ignore */ }
        if (sent) break;
      }
      if (!sent) await page.keyboard.press('Enter');
      let confirmed = false;
      for (let attempt = 0; attempt < 7 && !confirmed; attempt++) {
        await new Promise((r) => setTimeout(r, 800));
        confirmed = await verifySent(frame, inputEl, message, typedOk);
      }
      if (!confirmed) {
        console.warn('[tryGreet] 发送后未确认消息进入会话，判定发送失败');
        return false;
      }
      return true;
    } catch {
      return false;
    }
  },

  async goNextPage(page: Page, _op: HumanOperator): Promise<boolean> {
    const frame = getRecommendFrame(page);
    try {
      const before = await frame.evaluate(() => document.querySelectorAll('li.card-item').length);
      await frame.evaluate(async (pickSrc: string) => {
        const sc: any = (() => {
          try { return new Function('return ' + pickSrc)(); } catch { }
          let el: any = document.querySelector('ul.card-list')
            || document.querySelector('li.card-item')?.parentElement;
          while (el && el !== document.documentElement) {
            if (el.scrollHeight > el.clientHeight + 20) {
              return (el === document.body) ? (document.scrollingElement || document.documentElement) : el;
            }
            el = el.parentElement;
          }
          return document.scrollingElement || document.documentElement;
        })();
        const step = Math.max(300, Math.floor((sc.clientHeight || 600) * 0.6));
        let guard = 0;
        while (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 4 && guard++ < 40) {
          sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + step);
          await new Promise((r) => setTimeout(r, 220 + Math.random() * 220));
        }
        const btn = Array.from(document.querySelectorAll('button,[class*="btn"],[class*="more"],[class*="change"]'))
          .find((b) => /加载更多|换一换|查看更多/.test((b.textContent || '').trim()));
        if (btn) (btn as HTMLElement).click();
      }, PICK_SCROLLER_SRC);
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const now = await frame.evaluate(() => document.querySelectorAll('li.card-item').length);
        if (now > before) { await new Promise((r) => setTimeout(r, 900)); return true; }
      }
      return false;
    } catch {
      return false;
    }
  },

  async loadMore(page: Page, op: HumanOperator): Promise<boolean> {
    const t0 = Date.now();
    const OVERALL_MS = 30000;
    const PHASE1_MS = 10000;
    const deadline = t0 + OVERALL_MS;
    const overdue = () => Date.now() > deadline;
    try {
      return await bossLoadMoreInner(page, op, t0, deadline, overdue, PHASE1_MS);
    } finally {
      op.clearDeadline();
    }
  },

  // ── 风控检测（引用已有 standalone export）──
  classifyRiskKind,
  isRateWarning,
  probeSessionHealth: probeSessionHealth as PlatformAdapter['probeSessionHealth'],
  detectQuotaStop: async () => null,

  // ── 抓取辅助 ──
  cardKey(c: CandidateProfile): string {
    return c.bossMeta?.encryptGeekId || c.url || `${c.name || ''}|${c.company || ''}|${c.position || ''}`;
  },
  detailUrl(_c: CandidateProfile): string | null {
    return null; // BOSS 推荐流候选人无永久 URL
  },
  annotateSource(_c: CandidateProfile, _query: SearchQuery, _pageNo: number): void {
    // BOSS 推荐流不标注来源
  },
  mergeDetail(card: CandidateProfile, detail: Partial<CandidateProfile>): CandidateProfile {
    const merged = { ...card, ...detail };
    if (card.bossMeta || detail.bossMeta) {
      merged.bossMeta = { ...card.bossMeta, ...detail.bossMeta };
    }
    return merged;
  },
  scoreText(_c: CandidateProfile): string | undefined {
    return undefined; // BOSS 无补充文本
  },

  // ── 元操作 ──
  selfTest: undefined,
  listMetrics: async () => ({ cards: 0, currentPage: 0, top: 0, height: 0 }),
};

const SETTLE_MIN_MS = 8000;

async function reboundRetrigger(
  page: Page,
  op: HumanOperator,
  rect: { x: number; y: number; width: number; height: number } | null,
  wheelSkipped: boolean,
  deadline: number,
): Promise<void> {
  const frame = getRecommendFrame(page);
  const upPx = await evalWithTimeout(frame, (pickSrc: string) => {
    const sc: any = (() => {
      try { return new Function('return ' + pickSrc)(); } catch { }
      return document.scrollingElement || document.documentElement;
    })();
    return Math.max(800, Math.round((sc.clientHeight || 600) * 1.5));
  }, 2500, PICK_SCROLLER_SRC) ?? 900;
  if (!wheelSkipped && Date.now() < deadline) {
    op.setDeadline(Math.min(deadline, Date.now() + 4000));
    try {
      if (rect) {
        const x = Math.round(rect.x + rect.width * (0.35 + Math.random() * 0.3));
        const y = Math.round(rect.y + rect.height * (0.4 + Math.random() * 0.25));
        await op.scrollFeed(upPx, x, y, -1);
      } else {
        await op.scrollFeed(upPx, undefined, undefined, -1);
      }
    } catch { } finally { op.clearDeadline(); }
  }
  await evalWithTimeout(frame, (pickSrc: string, up: number) => {
    const sc: any = (() => {
      try { return new Function('return ' + pickSrc)(); } catch { }
      return document.scrollingElement || document.documentElement;
    })();
    sc.scrollTop = Math.max(0, (sc.scrollTop || 0) - up);
    try {
      sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -up, deltaMode: 0, bubbles: true, cancelable: true }));
    } catch { }
    return true;
  }, 3000, PICK_SCROLLER_SRC, upPx);
  await new Promise((r) => setTimeout(r, 600 + Math.random() * 400));
  if (!wheelSkipped && Date.now() < deadline) {
    op.setDeadline(Math.min(deadline, Date.now() + 5000));
    try {
      const downPx = Math.round(upPx * 1.4);
      if (rect) {
        const x = Math.round(rect.x + rect.width * (0.35 + Math.random() * 0.3));
        const y = Math.round(rect.y + rect.height * (0.45 + Math.random() * 0.25));
        await op.scrollFeed(downPx, x, y);
      } else {
        await op.scrollFeed(downPx);
      }
    } catch { } finally { op.clearDeadline(); }
  }
  await evalWithTimeout(frame, (pickSrc: string, down: number) => {
    const sc: any = (() => {
      try { return new Function('return ' + pickSrc)(); } catch { }
      return document.scrollingElement || document.documentElement;
    })();
    const items = document.querySelectorAll('li.card-item');
    const last = items[items.length - 1] as HTMLElement | undefined;
    if (last) { try { last.scrollIntoView({ block: 'end' }); } catch { } }
    sc.scrollTop = Math.min(sc.scrollHeight, (sc.scrollTop || 0) + down);
    try {
      sc.dispatchEvent(new WheelEvent('wheel', { deltaY: down, deltaMode: 0, bubbles: true, cancelable: true }));
    } catch { }
    return true;
  }, 3000, PICK_SCROLLER_SRC, Math.round(upPx * 1.4));
}

async function bossLoadMoreInner(
  page: Page,
  op: HumanOperator,
  t0: number,
  deadline: number,
  overdue: () => boolean,
  phase1Ms: number,
): Promise<boolean> {
  const readSig = async () => {
    const frame = getRecommendFrame(page);
    return evalWithTimeout(frame, (pickSrc: string) => {
      const sc: any = (() => {
        try { return new Function('return ' + pickSrc)(); } catch { }
        let el: any = document.querySelector('ul.card-list')
          || document.querySelector('li.card-item')?.parentElement;
        while (el && el !== document.documentElement) {
          if (el.scrollHeight > el.clientHeight + 20) {
            return (el === document.body) ? (document.scrollingElement || document.documentElement) : el;
          }
          el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      })();
      const items = document.querySelectorAll('li.card-item');
      const firstId = items[0]?.querySelector('.card-inner')?.getAttribute('data-geekid') || '';
      const lastId = items[items.length - 1]?.querySelector('.card-inner')?.getAttribute('data-geekid') || '';
      return {
        top: Math.round(sc.scrollTop || 0),
        h: Math.round(sc.scrollHeight || 0),
        ch: Math.round(sc.clientHeight || 0),
        count: items.length,
        firstId,
        lastId,
      };
    }, 3000, PICK_SCROLLER_SRC);
  };
  const before = await readSig();
  if (!before) {
    console.warn('[loadMore] 读取推荐帧状态超时/失败，判本次无法前进');
    return false;
  }
  const visible = await isWindowVisible(page);
  const wheelSkipped = visible === false;
  let rect: { x: number; y: number; width: number; height: number } | null = null;
  if (wheelSkipped) {
    console.warn('[loadMore] 浏览器窗口不可见（最小化/后台），CDP 真实滚轮送不达');
  } else {
    rect = await recommendFrameRect(page, 5000);
    if (!rect) console.warn('[loadMore] 未取到推荐 iframe 矩形，滚轮回退到视口中心');
  }
  const atBottomBefore = before.top + before.ch >= before.h - 8;
  let rebounded = false;
  if (atBottomBefore) {
    rebounded = true;
    console.log('[loadMore] 已在底部，改用回弹重触发');
    await reboundRetrigger(page, op, rect, wheelSkipped, Math.min(deadline, Date.now() + phase1Ms + 6000));
  } else {
    const phase1Deadline = Math.min(deadline, Date.now() + phase1Ms);
    op.setDeadline(phase1Deadline);
    try {
      const rounds = wheelSkipped ? 0 : 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < rounds && Date.now() < phase1Deadline; i++) {
        if (rect) {
          const x = Math.round(rect.x + rect.width * (0.35 + Math.random() * 0.3));
          const y = Math.round(rect.y + rect.height * (0.45 + Math.random() * 0.25));
          await op.scrollFeed(undefined, x, y);
        } else {
          await op.scrollFeed();
        }
        await new Promise((r) => setTimeout(r, 320 + Math.random() * 380));
      }
    } catch {
    } finally {
      op.clearDeadline();
    }
  }
  let topAfterWheel: number | null = null;
  if (!overdue()) {
    const frame = getRecommendFrame(page);
    const r = await evalWithTimeout(frame, (pickSrc: string) => {
      const sc: any = (() => {
        try { return new Function('return ' + pickSrc)(); } catch { }
        let el: any = document.querySelector('ul.card-list')
          || document.querySelector('li.card-item')?.parentElement;
        while (el && el !== document.documentElement) {
          if (el.scrollHeight > el.clientHeight + 20) {
            return (el === document.body) ? (document.scrollingElement || document.documentElement) : el;
          }
          el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      })();
      const topBeforeFallback = Math.round(sc.scrollTop || 0);
      const items = document.querySelectorAll('li.card-item');
      const last = items[items.length - 1] as HTMLElement | undefined;
      if (last) { try { last.scrollIntoView({ block: 'end' }); } catch { } }
      const step = Math.max(600, sc.clientHeight || 600);
      sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + step);
      try {
        sc.dispatchEvent(new WheelEvent('wheel', {
          deltaY: step, deltaMode: 0, bubbles: true, cancelable: true,
        }));
      } catch { }
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 8) {
        const btn = Array.from(
          document.querySelectorAll('button,[class*="btn"],[class*="more"],[class*="change"]'),
        ).find((b) => /加载更多|换一换|查看更多|看看其他|更多牛人/.test((b.textContent || '').trim()));
        if (btn) (btn as HTMLElement).click();
      }
      return topBeforeFallback;
    }, 6000, PICK_SCROLLER_SRC);
    if (typeof r === 'number') topAfterWheel = r;
  }
  const settle = async (untilTs: number): Promise<boolean> => {
    for (let i = 0; i < 12 && Date.now() < untilTs; i++) {
      await new Promise((r) => setTimeout(r, 800));
      const now = await readSig();
      if (!now) continue;
      const grew = now.count > before.count;
      const moved = (!!now.lastId && now.lastId !== before.lastId)
        || (!!now.firstId && now.firstId !== before.firstId);
      if (grew || moved) {
        lastDiag = `已加载下一屏：卡片 ${before.count}→${now.count} 张，滚动位置 ${before.top}→${now.top}/${now.h}，`
          + `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${rebounded ? '（回弹重触发生效）' : ''}`;
        console.log(`[loadMore] ${lastDiag}`);
        return true;
      }
    }
    return false;
  };
  if (await settle(Math.max(deadline, Date.now() + SETTLE_MIN_MS))) return true;
  if (!rebounded && Date.now() - t0 < 25000) {
    const nowSig = await readSig();
    if (nowSig && nowSig.top + nowSig.ch >= nowSig.h - 8) {
      rebounded = true;
      console.log('[loadMore] 下滑后已钉在底部且无新内容，追加一次回弹重触发');
      await reboundRetrigger(page, op, rect, wheelSkipped, Date.now() + 14000);
      if (await settle(Date.now() + 6000)) return true;
    }
  }
  const phase1Cost = ((Date.now() - (overdue() ? deadline : t0)) / 1000).toFixed(1);
  const wheelMoved = wheelSkipped
    ? '已跳过·窗口不可见'
    : (topAfterWheel === null ? `${phase1Cost}s(位置未测到)` : `${phase1Cost}s(位置 ${before.top}→${topAfterWheel})`);
  const fin = await readSig();
  if (fin) {
    lastDiag = `未出新候选人：卡片 ${before.count}→${fin.count}，滚动位置 ${before.top}→${fin.top}(移动 ${fin.top - before.top})，`
      + `内容高度 ${before.h}→${fin.h}(增长 ${fin.h - before.h})，视口 ${fin.ch}，iframe 矩形${rect ? '已取到' : '未取到'}，`
      + `回弹重触发${rebounded ? '已执行仍无新内容' : '未执行'}，真实滚轮${wheelMoved}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  } else {
    lastDiag = `未出新候选人：收尾读取超时，真实滚轮${wheelMoved}`;
  }
  console.warn(`[loadMore] ${lastDiag}`);
  return false;
}

export async function scrollMetrics(page: Page): Promise<{ top: number; height: number; client: number; count: number }> {
  const frame = getRecommendFrame(page);
  try {
    const m = await evalWithTimeout(frame, (pickSrc: string) => {
      const sc: any = (() => {
        try { return new Function('return ' + pickSrc)(); } catch { }
        let el: any = document.querySelector('ul.card-list')
          || document.querySelector('li.card-item')?.parentElement;
        while (el && el !== document.documentElement) {
          if (el.scrollHeight > el.clientHeight + 20) {
            return (el === document.body) ? (document.scrollingElement || document.documentElement) : el;
          }
          el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      })();
      return {
        top: Math.round(sc.scrollTop || 0), height: Math.round(sc.scrollHeight || 0),
        client: Math.round(sc.clientHeight || 0), count: document.querySelectorAll('li.card-item').length,
      };
    }, 4000, PICK_SCROLLER_SRC);
    return m || { top: -1, height: -1, client: -1, count: -1 };
  } catch {
    return { top: -1, height: -1, client: -1, count: -1 };
  }
}
