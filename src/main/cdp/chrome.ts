// Chrome / CDP 连接管理
//
// 修复历史：
//  - C2: 工具脚本通过 CDP Page.createIsolatedWorld 在独立隔离世界注入，
//        彻底与页面主世界 JS 上下文分离；wrapper 遮蔽 globalThis/self/top/parent/
//        WebSocket/Function/eval 等，防止权限绕过。
//  - Medium: --remote-debugging-address=127.0.0.1 防止局域网/同机其它进程连接
//  - Medium: disconnected/close 时移除 targetcreated 监听器，防止重连泄漏
import { app } from 'electron';
import corePuppeteer, { Browser, Page, Target } from 'puppeteer-core';
import type { CDPSession } from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// P1 隐身：puppeteer-extra + stealth 包裹（已是 rebrowser 补丁版 core），运行期(连接)恢复被自动化
// 抹掉的"真实 Chrome 裸标记"（plugins/chrome.runtime 等）。登录走独立 spawn（不经 puppeteer），
// 故登录期不受影响、保持零附着。
// ⚠️ 合规修正（对照 BOSS 风险调查·明确禁止「伪造指纹」）：移除 WebGL GPU 渲染器【伪造】evasion——
// 它会把真机 GPU 谎报成 Intel，在真机上反而制造不一致指纹、违背「不伪造指纹」原则，且对本项目复用的
// 已存在推荐页本就不生效（stealth 只 hook connect 之后新建的页）。webdriver evasion 在 Chrome89+ 为
// 空操作（真值已由 --disable-blink-features=AutomationControlled 置 false），不产生可被 10027 反 hook 的痕迹。
const puppeteer: any = addExtra(corePuppeteer as any);
const stealth: any = StealthPlugin();
// ⚠️ 2026-07-28 审查实证：stealth 默认打开的一批 evasion 在【connect 模式】下不是"恢复真实 Chrome
// 原样"，而是【伪造指纹】，直接违反登记册的明确禁止项，而且制造的痕迹比它想掩盖的更显眼：
//   · user-agent-override：beforeConnect() 里硬置 _headless=true（node_modules 内实现第 192 行），
//     只要走 puppeteer.connect（本项目唯一路径）就会经 Network.setUserAgentOverride 把
//     acceptLanguage 改成 'en-US,en' —— 真机是中文 Chrome，与 profile/Intl/时区/UI 语言全不一致。
//   · navigator.languages：同样覆盖成 ['en-US','en']。
//   · navigator.hardwareConcurrency：默认硬写 4，与真机 CPU 核数不符。
//   · media.codecs / iframe.contentWindow：会 Proxy 掉 HTMLIFrameElement.prototype.contentWindow，
//     而本项目全靠推荐 iframe 干活，等于在最关键的对象上留 hook 痕迹。
//   · 上述 evasion 为隐藏 Proxy 会把 Function.prototype.toString 整体换成 Proxy——
//     登记册明写 Boss 端有「webdriver toString 反 hook」检测(10027)，这是主动送上门。
//   · 更糟的是 stealth 只 hook connect【之后】新建的页，而 RPA 主战场是复用的那个已存在的推荐页 →
//     同一浏览器里老 tab 真 zh-CN/真核数/原生 toString、新 tab en-US/4核/Proxy toString，
//     跨标签页不一致比单点异常更容易被会话级上报抓到。
// 结论：只保留【自带 headful 自守卫、不伪造任何值】的两项，其余全部关掉。
// 裸标记本身已由 --disable-blink-features=AutomationControlled + rebrowser-puppeteer-core 覆盖。
try {
  // 保留标准：必须自带【headful 真机自守卫】且不伪造任何真实属性值。
  //   chrome.app / chrome.csi / chrome.loadTimes：守卫是 `if ('app' in window.chrome) return` 之类，
  //     而真实 Chrome 本来就有这三个遗留 API → 守卫必然命中 → 空操作，安全。
  //   navigator.plugins：守卫是 `if (hasPlugins) return`，真机有插件 → 空操作，安全。
  //   sourceurl：抹掉注入脚本的 puppeteer sourceURL 痕迹，属"去掉自动化裸标记"，不伪造真实值。
  //
  // ⚠️ chrome.runtime 已从保留集合【移除】。它的守卫是 `'runtime' in window.chrome`，
  // 注释自称"存在即说明是 headful，无需 mock"——但这个前提在普通 https 站点上不成立：
  // 真实 Chrome 只在有 externally_connectable 匹配的扩展时才暴露 chrome.runtime，
  // 而本项目的匹配分插件 manifest 里没有该键。于是守卫失效，evasion 会注入
  // STATIC_DATA + id getter + Proxy 化的 connect/sendMessage —— 这是【伪造】，
  // 正是登记册明确禁止的，而且 stealth 只 hook connect 之后新建的页，
  // RPA 用的是复用页，还会造成跨标签页不一致。
  // 移除它在两种情况下都安全：真机本来没有 → 我们不再凭空造一个；真机本来有 → 它本就是空操作。
  const KEEP = new Set([
    'chrome.app', 'chrome.csi', 'chrome.loadTimes',
    'navigator.plugins', 'sourceurl',
  ]);
  for (const name of Array.from(stealth.enabledEvasions ?? [])) {
    if (!KEEP.has(name as string)) stealth.enabledEvasions.delete(name);
  }
} catch { /* 插件结构变动则退回默认，不影响启动 */ }
puppeteer.use(stealth);
import path from 'path';
import fs from 'fs';
import http from 'http';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { toolManager } from '../tools/manager';
import { getDb } from '../db';
import { isEmptyZpData, isRecommendListApi } from '../../shared/boss-signals';
import { logTime } from '../../shared/utils';
import type { DefenseSignalKind, PlatformId } from '../../shared/types';
// G2/G3: 匹配分插件的固定扩展 ID。从此处导入而非硬编码副本，保证与 jd-bridge 同源。
// contract:check 会跨文件校验此常量在所有位置与 manifest key 一致，漂移会被自动拦住。
import { EXTENSION_ID as MATCH_SCORE_EXTENSION_ID } from '../services/jd-bridge';

// ── 平台化的网络层风控监控规则（L1 隔离的一部分）──────────────────────────────
// 原实现把 BOSS 的 /wapi/zpgeek 路径、code:35、zpApm 上报端点硬编码在 ChromeManager 里。
// 现在改为由平台注入：每个 ChromeManager 实例只认自己平台的规则，且只监控自己浏览器里的页，
// 事件也只在自己这个 EventEmitter 上发 —— 从源头杜绝"BOSS 的信号被猎聘引擎收到"。
export interface RiskNetRules {
  /** 只监控本平台的业务接口 */
  apiUrl: RegExp;
  /** 埋点/日志端点排除（避免把统计请求当业务响应解析） */
  excludeUrl: RegExp;
  /** 从 JSON 响应体判定风控信号；返回 null 表示正常 */
  classifyBody?: (body: any, url: string) => { code: number | string; message: string; kind: DefenseSignalKind } | null;
  /** 从响应头（主要是 Set-Cookie）判定风控信号，如猎聘的 acw_sc__v2/v3 WAF 挑战 */
  classifyHeaders?: (headers: Record<string, string>, url: string) => { code: string; message: string; kind: DefenseSignalKind } | null;
  /** 静默安全上报端点（比验证码更早的信号）：BOSS 的 zpApm / 猎聘的 standardFLog */
  secReportUrl?: RegExp;
  /** 从上报载荷解析出可读描述；返回 null 表示该载荷无异常码 */
  parseSecReport?: (payload: string, url: string) => { code: string; desc: string } | null;
}

/** ChromeManager 构造参数（由 runtime-registry 按平台注入） */
export interface ChromeManagerOptions {
  platform: PlatformId;
  defaultPort: number;
  defaultProfileDirName: string;
  /** 本平台域名判定（找回标签页 / 行为采样 / 登录页探测 / 信号归属校验都用它） */
  hostPattern: RegExp;
  /** 「打开浏览器」默认落地页 */
  loginStartUrl: string;
  /** 登录/验证页 URL 特征（接管前的护栏：这些页面上绝不 attach puppeteer） */
  loginOrVerifyPattern: RegExp;
  /** 网络层风控监控规则 */
  riskNet: RiskNetRules;
}

export type CDPMode = 'dedicated' | 'existing';

/**
 * 安全拒绝错误：connectExisting / launch 前校验命中时抛出，表示"连/启动都没做，
 * 浏览器状态没被改变"。launchDetached 等上层可以据此区分"端口没有 Chrome"（可继续起新的）
 * 和"端口上是被禁目标"（必须把错误抛给用户处理），避免靠文案包含关键字匹配。
 */
export class IsolationViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationViolationError';
  }
  static is(e: unknown): e is IsolationViolationError {
    return !!e && typeof e === 'object' && (e as any).name === 'IsolationViolationError';
  }
}

// 「打开 BOSS 浏览器」的真实结果——必须能区分"新启动 / 本来就开着 / 有没有真的切到前台"，
// 否则界面只能笼统地报"已打开"，出现"点了没反应但显示已打开"的误导。
export interface OpenBrowserResult {
  launched: boolean;    // 本次是否真正启动了一个新的浏览器进程
  alreadyOpen: boolean; // 调试端口原本就在（浏览器已在运行）
  focused: boolean;     // 是否成功把 BOSS 标签页/窗口带到前台
  url?: string;         // 实际被激活的标签页 URL
}

// 隔离世界名称（在每个页面 frame 中创建）
const ISOLATED_WORLD_NAME = '__ta_tools__';
// 隔离世界 ID 缓存（按 page url/frameId 不现实，直接用 page 作为 key 存主 frame 的 executionContextId）
const isolatedWorldCtx = new WeakMap<Page, number>();
// G2: 工具→应用回传 binding 名称 + 每页常驻 CDP 会话（binding 需要保持会话不 detach）
const TOOL_PUSH_BINDING = '__taPushJobs';
// ⚠️ 曾是模块级 Map。双实例化（隔离改造 2026-07-29）后必须归属各自实例：
// 模块级时任一实例 disconnect/close 都会 clear 全表并 detach【另一个实例】的 binding
// 会话——工具浏览器一断，RPA 浏览器上的 JR 推送也会静默死掉。现改为实例属性（见类内）。

// 需要反检测保护的外部招聘平台：这些站点会检测自动化，登录/空闲期一律不注入。
// 飞书招聘等内部办公系统不在此列（注入总开关不约束它们，否则工具库整体失效）。
const ANTI_DETECT_HOSTS = /(^|\.)(zhipin|liepin|zhaopin|51job|lagou|boss)\.com/i;
function isAntiDetectHost(url: string): boolean {
  try {
    const u = new URL(url);
    // ⚠️ about:blank / chrome://newtab 这类 URL【能被 new URL 解析】，只是 hostname 为空或不是域名，
    // 原实现于是走到正则不匹配 → 返回 false(不保护)，与下面 catch 分支的保守意图正好相反。
    // 危害是实打实的：新建标签页一律是 about:blank，被判"不需要保护"后就会建常驻 CDP 会话
    // 并 Runtime.enable + addScriptToEvaluateOnNewDocument——这两者都是 target 级、跨导航持久的，
    // 该 tab 随后 goto 到 zhipin.com 时 Runtime 仍是 enable、脚本照样注入，
    // 「登录/空闲期零注入、不 enable Runtime」的承诺被整条绕过，
    // 也把 rebrowser-puppeteer 规避 Runtime.enable 检测的收益还了回去。
    // 而本项目 ensureBossPage 正是走 newPage()(about:blank) → goto(zhipin) 这条路。
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    if (!u.hostname) return true;
    return ANTI_DETECT_HOSTS.test(u.hostname);
  } catch {
    // 解析不了同样按"需要保护"处理，保守优先
    return true;
  }
}

// ── 安全信标原始抓取（2026-08-19 P2-a）──────────────────────────────────────
// 猎聘 security.min.js 的上报载荷目前 RPA 解析不了（每轮报「猎聘安全上报载荷不可读」），
// 对猎聘是否已把账号标记为可疑是"半瞎"。在能解析之前，先把每一次上报请求的原始
// URL/方法/请求头/请求体落盘，供离线分析。有真机数据后再谈解析规则。
// ⚠️ 纯被动监听：只在 page.on('request') 已触发的回调里读 req 的字段并写盘，
//   不发任何请求、不碰配额、不改动请求、不影响主流程（写盘失败只 catch）。
function securityBeaconLogsDir(): string {
  try {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'package.json'))) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const logs = path.join(dir, 'logs');
    try { fs.mkdirSync(logs, { recursive: true }); } catch { /* ignore */ }
    return logs;
  } catch {
    return path.join(process.cwd(), 'logs');
  }
}

/** ISO 时间戳（文件名安全）：2026-08-19T14-30-05-123Z */
function securityBeaconStamp(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}Z`;
}

/**
 * 把一次安全上报请求的原始字段落盘。被动监听、零网络回传。
 * 文件名 <platform>-security-beacon-<ts>.json（platform 取 ChromeManager 所属平台）。
 * 同一秒内多次上报用 ms 级时间戳 + 序号区分，绝不覆盖。
 */
let _beaconSeq = 0; // 同毫秒去重序号
function dumpSecurityBeacon(
  platform: string | undefined,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  reason: string,
): void {
  try {
    const p = platform || 'platform';
    const file = path.join(securityBeaconLogsDir(), `${p}-security-beacon-${securityBeaconStamp()}-${_beaconSeq++}.json`);
    const rec = {
      kind: 'security-beacon',
      platform: p,
      capturedAt: Date.now(),
      reason, // raw-collected / unreadable（与现有不可读告警并列，多落一份原始抓取）
      request: {
        url: String(url || '').slice(0, 2000),
        method: String(method || ''),
        headers: headers || {},
        body: body || '',
      },
      capturedBy: 'chrome-cdp-request-listener',
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 1), 'utf8');
  } catch { /* 抓取落盘失败绝不影响主流程 */ }
}

// 通用评分引擎源码（在隔离世界内联执行，供 content script 调用）
// 解决 H10：评分逻辑只有一份源码，主进程和 content script 共用
let __UNIVERSAL_SCORING_SRC: string | null = null;
function loadUniversalScoring(): string {
  if (__UNIVERSAL_SCORING_SRC) return __UNIVERSAL_SCORING_SRC;
  try {
    const p = path.join(__dirname, '../../shared/scoring-universal.js');
    const p2 = path.join(process.cwd(), 'src/shared/scoring-universal.js');
    const candidates = [p, p2];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        __UNIVERSAL_SCORING_SRC = fs.readFileSync(c, 'utf-8');
        return __UNIVERSAL_SCORING_SRC;
      }
    }
  } catch {}
  __UNIVERSAL_SCORING_SRC = '';
  return __UNIVERSAL_SCORING_SRC;
}

// 双平台默认配置：端口与 profile 目录各自独立，避免两个招聘平台的浏览器
// 共享 profile / 争用同一个调试端口。新增平台只需在此处加一条。
export type Platform = 'boss' | 'liepin';
const PLATFORM_DEFAULTS: Record<Platform, { cdpPort: number; profileDirName: string }> = {
  boss:   { cdpPort: 9222, profileDirName: 'chrome-profile' },
  liepin: { cdpPort: 9333, profileDirName: 'chrome-profile-liepin' },
};

export class ChromeManager extends EventEmitter {
  // 单条 CDP 命令最长等待（puppeteer 默认 180s，太长；见 connectExisting 注释）
  private static readonly PROTOCOL_TIMEOUT_MS = 60000;
  private browser: Browser | null = null;
  // C5: 在途连接 promise —— 防止并发调用同时过 `if (this.browser) return` 检查
  private connectingPromise: Promise<Browser> | null = null;
  private mode: CDPMode = 'dedicated';
  private platform?: Platform;
  private userDataDir: string;
  private cdpPort: number = 9222;
  private chromePath?: string;
  // 注入总开关：默认关。登录/空闲时不注入、不 enable Runtime，避免 BOSS 检测到自动化把用户弹回登录。
  // RPA 读推荐帧走 puppeteer 自身 evaluate，不依赖此注入，故关闭不影响找人。
  private injectionActive = false;
  private extraArgs: string[] = [];
  private platformLaunchArgs: string[] = []; // per-platform launch args from adapter
  private behaviorSampling = false; // S6: 是否采集用户手动操作节奏（"模仿本人"学习）
  private onTargetCreated: ((t: Target) => void) | null = null;
  private onDisconnected: (() => void) | null = null;
  // 风控响应监控幂等：已挂过 monitor 的页不重复挂（防重复 emit / 泄漏 listener）
  private monitoredPages = new WeakSet<Page>();
  // 页面采纳幂等：已走过 adoptPage（监听器+注入）的页不重复走（防 listener 叠加/工具实例翻倍）
  private adoptedPages = new WeakSet<Page>();
  // JR 推送等 binding 的常驻 CDP 会话（一页一条）。实例私有——见文件顶部说明
  private bindingSessions = new Map<Page, CDPSession>();
  // 新文档注入的常驻 CDP 会话 + 已注册脚本句柄（key → identifier），【按 targetId 索引】。
  //
  // 两点都是实测逼出来的，别改回去：
  //  ① 会话必须常驻：Page.addScriptToEvaluateOnNewDocument 的注册随会话 detach 一起消失
  //     （见 evaluateOnNewDocumentInWorld 顶部的对照实验记录）。
  //  ② 键必须是 targetId 而不是 Page 对象：同一个标签页在 puppeteer(+extra 包装) 下会存在
  //     多个不同身份的 Page 对象。按对象身份存，就会出现"注册用 A 对象存、撤销用 B 对象查"
  //     而查不到——表现是【关掉的工具在页面刷新后又自己回来】，以及改了配置刷新后不生效。
  private newDocSessions = new Map<string, CDPSession>();
  private newDocScripts = new Map<string, Map<string, string>>();
  // Page 对象 → targetId 的缓存，省掉每次注入都问一次 Target.getTargetInfo
  private targetIdCache = new WeakMap<Page, string>();

  // G2/G3: rejectExtensionIds —— 连接到对端浏览器后若发现装着这些扩展，立即 disconnect 并抛错。
  // 用途：RPA 实例必须拒绝匹配分插件（插件线要求零附着，被 puppeteer 连上就破功）；
  //       工具实例默认空（工具浏览器是平台专用 profile，本不该有用户扩展，但目前不硬拒以避免误拦）。
  private rejectExtensionIds: readonly string[];

  /** 平台注入的网络层风控规则；未注入时退回 BOSS legacy 硬编码路径（见 attachRiskResponseMonitor） */
  private riskNet: RiskNetRules | null = null;
  /** 本平台域名判定：403/429 只在自己平台的响应上判，避免收到别站信号 */
  private riskHostPattern: RegExp | null = null;

  constructor(opts?: {
    platform?: Platform;
    cdpPort?: number;
    profileDirName?: string;
    rejectExtensionIds?: readonly string[];
    launchArgs?: string[];
    riskNet?: RiskNetRules;
    hostPattern?: RegExp;
  }) {
    super();
    // 平台默认值：显式传 platform 时，端口/profile 取该平台的默认值；未传 platform
    // 时向后兼容老调用方（cdpPort/profileDirName 直接覆盖默认）。
    const defaults = opts?.platform ? PLATFORM_DEFAULTS[opts.platform] : null;
    this.platform = opts?.platform;
    const port = opts?.cdpPort ?? defaults?.cdpPort ?? 9222;
    const profile = opts?.profileDirName ?? defaults?.profileDirName ?? 'chrome-profile';
    this.userDataDir = path.join(app.getPath('userData'), profile);
    this.cdpPort = port;
    this.rejectExtensionIds = opts?.rejectExtensionIds ?? [];
    this.platformLaunchArgs = opts?.launchArgs ?? [];
    this.riskNet = opts?.riskNet ?? null;
    this.riskHostPattern = opts?.hostPattern ?? null;
  }

  /** 返回本实例所属平台标识（未指定 platform 的历史实例返回 undefined）。 */
  getPlatform(): Platform | undefined { return this.platform; }

  setMode(mode: CDPMode) {
    this.mode = mode;
  }

  setPort(port: number) {
    this.cdpPort = port;
  }

  setChromePath(p: string) {
    // 与 launch() 同口径：只接受浏览器可执行文件，不再是"存在即可"
    if (ChromeManager.isSafeExecutable(p)) {
      this.chromePath = p;
    } else if (p) {
      // 非法值不能静默忽略——用户会以为"设置了但没生效"却查不到原因
      console.warn('[cdp] Chrome 路径未通过校验，已忽略（只接受 chrome/chromium/msedge 可执行文件）：', p);
    }
  }

  setUserDataDir(dir: string) {
    if (dir) this.userDataDir = dir;
  }

  // M-13: 设置额外启动参数
  // H3-2 修复：危险标志黑名单，防止渲染进程被 XSS 后通过 extraArgs 覆盖调试地址/关闭同源策略
  setExtraArgs(argsRaw: string | string[] | undefined) {
    if (!argsRaw) { this.extraArgs = []; return; }
    let list: string[];
    if (Array.isArray(argsRaw)) {
      list = argsRaw.filter(Boolean);
    } else {
      // 按空格拆分，简单处理引号
      list = argsRaw.split(/\s+/).map(s => s.trim()).filter(Boolean);
    }
    this.extraArgs = list.filter((a) => ChromeManager.isSafeExtraArg(a));
  }

  // H3-2：禁止覆盖调试地址/端口、用户数据目录、加载扩展、关闭安全策略等危险标志
  private static readonly DANGEROUS_ARG_PREFIXES = [
    '--remote-debugging-address',
    '--remote-debugging-port',
    '--remote-allow-origins',
    '--user-data-dir',
    '--load-extension',
    '--disable-extensions-except',
    '--disable-web-security',
    '--disable-site-isolation',
    '--disable-features=IsolateOrigins',
    '--allow-running-insecure-content',
    '--proxy-server',
    '--proxy-pac-url',
    '--host-rules',
    '--auto-open-devtools',
    '--headless', // 由 opts.headless 统一控制，禁止外部注入
  ];
  // 可执行文件白名单：只接受存在的、文件名像 chrome/chromium/msedge 的可执行文件。
  // CDP_LAUNCH 的 opts.chromePath 是从渲染层直传进来的，settings 侧的 existsSync 校验绕不到它；
  // 渲染层一旦被 XSS，api.launchBrowser({chromePath:'任意.exe'}) 就是任意程序启动。
  static isSafeExecutable(p: string): boolean {
    if (!p || typeof p !== 'string') return false;
    try {
      if (!fs.existsSync(p)) return false;
      if (!fs.statSync(p).isFile()) return false;
    } catch { return false; }
    const base = path.basename(p).toLowerCase();
    const allowed = ['chrome.exe', 'chromium.exe', 'msedge.exe', 'google chrome', 'chromium', 'chrome'];
    return allowed.includes(base);
  }

  static isSafeExtraArg(arg: string): boolean {
    const lower = arg.toLowerCase();
    if (!lower.startsWith('--')) return false; // 只接受 -- 开头的标志，杜绝任意 token
    return !ChromeManager.DANGEROUS_ARG_PREFIXES.some((p) => lower.startsWith(p));
  }

  // ★ 2026-08-20 P0：防遮挡 / 防后台丢弃的基础启动参数。
  // 病因（c-in-c 真机两轮实证）：RPA 在长暂停（休息 / 可疑度降速插休）之后约 46min 崩，
  // 都发生在 Chrome 把【被遮挡 / 转入后台的窗口】判定为不可见 → 冻结该标签页的渲染、
  // 计时器、乃至丢弃 CDP 通道。interruptibleSleep 的 page.evaluate('1') 保活挡不住这层
  // 「窗口级」冻结（它发生在 evaluate 之下）。根治必须从 Chrome 启动参数下手：
  //   --disable-backgrounding-occluded-windows   窗口被遮挡时不降级（最直接）
  //   --disable-renderer-backgrounding           渲染进程不因后台而限速
  //   --disable-background-timer-throttling      后台标签页计时器不节流（保活探测才不会假超时）
  //   --disable-features=CalculateNativeWinOcclusion  不计算窗口遮挡状态（屏幕方案 B，猎聘已带）
  // 这四项是【app 自己的启动参数】（硬编码、非用户 extraArgs），不属 DANGEROUS_ARG_PREFIXES
  // 用户注入范畴；纯属保持已连接浏览器活跃，不涉及指纹伪造 / 躲检测。
  //
  // ⚠️ Chrome 只认最后一个 --disable-features=…：多个 --disable-features 参数，后者覆盖前者。
  //   猎聘 adapter 的 platformLaunchArgs 带 --disable-features=CalculateNativeWinOcclusion，
  //   若此处再独立加一条 --disable-features=…，只会留下最后一条、把对方的功能开关吃掉。
  //   故用 appendAntiOcclusionArgs 把所有 --disable-features 的值合并成【一条逗号分隔】参数，
  //   并放在其它参数之后（确保是最后一条、且不丢任何功能开关）。
  private static readonly ANTI_OCCLUSION_FLAGS = [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  private static readonly ANTI_OCCLUSION_FEATURES = ['CalculateNativeWinOcclusion'];

  /**
   * 往已构造好的 args 末尾追加防遮挡 / 防后台参数。
   * 把已有的所有 --disable-features=… 合并成一条（含本模块要加的功能），避免 Chrome 末条覆盖。
   * 幂等：重复调用不会重复加同一标志 / 功能（同一字符串多次出现在 args 里 Chrome 也容忍，
   * 但合并 --disable-features 仍只出一条，保持干净）。
   */
  static appendAntiOcclusionArgs(args: string[]): string[] {
    const out = [...args];
    // 收集已有的 --disable-features=… 值，从 out 里移除它们（稍后合并成一条放末尾）。
    const feats = new Set<string>(ChromeManager.ANTI_OCCLUSION_FEATURES);
    const filtered: string[] = [];
    for (const a of out) {
      const m = /^--disable-features=(.*)$/i.exec(a);
      if (m) {
        for (const f of m[1].split(',')) { if (f) feats.add(f); }
      } else {
        filtered.push(a);
      }
    }
    // 三条独立标志：已有同名的就不重复加（幂等）。
    for (const f of ChromeManager.ANTI_OCCLUSION_FLAGS) {
      if (!filtered.some((x) => x.toLowerCase() === f)) filtered.push(f);
    }
    // 合并后的 --disable-features 放最后一条（Chrome 取最后一条，确保生效且不丢开关）。
    filtered.push(`--disable-features=${Array.from(feats).join(',')}`);
    return filtered;
  }

  // G1: 用户【日常浏览器 profile】黑名单（Windows）。
  // 这些目录被设成 RPA userDataDir 时后果是不可接受的：
  //   1) launch/launchDetached/openBrowserForLogin 会 fs.rmSync 删 SingletonLock/SingletonSocket/SingletonCookie，
  //      直接破坏用户正在运行的日常 Chrome，不可逆；
  //   2) 随后 --remote-debugging-port + puppeteer 附着 → 装着匹配分插件的浏览器进入自动化检测射程，
  //      插件线的"零风险"前提（不被附着、不发平台请求）整个失效；
  //   3) 全程无提示，用户不会知道自己把插件线的防护拆了。
  // 规则：路径（大小写不敏感）等于以下任一目录、或为其子目录（Default/Profile 1/...）都命中。
  // ⚠️ 此表是安全闸门，改/缩必须有同等或更严的防护理由；加新条目无需改其它代码。
  private static defaultProfileRoots(): string[] {
    const roots: string[] = [];
    const localAppData = process.env.LOCALAPPDATA;
    if (process.platform === 'win32' && localAppData) {
      roots.push(
        path.join(localAppData, 'Google', 'Chrome', 'User Data'),
        path.join(localAppData, 'Google', 'Chrome Beta', 'User Data'),
        path.join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
        path.join(localAppData, 'Chromium', 'User Data'),
        path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
        path.join(localAppData, 'Microsoft', 'Edge Beta', 'User Data'),
      );
    }
    // macOS / Linux 常见位置（防御性列出，非 Windows 平台同样不能指向日常浏览器）。
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      roots.push(
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
        path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
        path.join(home, 'Library', 'Application Support', 'Chromium'),
        path.join(home, '.config', 'google-chrome'),
        path.join(home, '.config', 'chromium'),
        path.join(home, '.config', 'microsoft-edge'),
      );
    }
    return roots;
  }

  /**
   * 判断给定目录是否指向用户【日常浏览器】的 profile 目录（包括子 profile，如 Default / Profile 1）。
   * 返回命中的那个【根】目录绝对路径（小写），未命中返回 null。
   * 大小写不敏感（Windows 默认），统一 resolve + toLowerCase 比较。
   */
  static isDefaultBrowserProfile(dir: string): string | null {
    if (!dir || typeof dir !== 'string') return null;
    let resolved: string;
    try { resolved = path.resolve(dir).toLowerCase(); } catch { return null; }
    for (const root of ChromeManager.defaultProfileRoots()) {
      const r = root.toLowerCase();
      if (resolved === r || resolved.startsWith(r + path.sep.toLowerCase())) return r;
    }
    return null;
  }

  isConnected(): boolean {
    return !!this.browser;
  }

  // 真实浏览器状态：open=调试端口就绪（浏览器已打开，哪怕登录期零附着），attached=puppeteer 已接管。
  // 修「浏览器已打开并登录，但界面显示未连接」的误导——用户视角"已打开"就是已连接。
  async getBrowserStatus(): Promise<{ open: boolean; attached: boolean }> {
    const attached = !!this.browser;
    // ★ 只有【我们自己的】浏览器才算 open。端口被别人的 Chrome 占着时若报 open=true，
    //   用户会以为浏览器已就绪而去点「开始找人」，然后在更深的地方撞上拒绝连接——
    //   状态就该在这里说实话。
    const open = attached || (await this.inspectPort()).state === 'ours';
    return { open, attached };
  }

  getBrowser(): Browser | null {
    return this.browser;
  }

  /** 供启动自检与错误文案使用：本实例的 profile 目录绝对路径。 */
  getUserDataDir(): string {
    return this.userDataDir;
  }

  /**
   * G3 反向告警：检查【本实例的 profile 目录】下是否装了指定扩展（不连浏览器、只读磁盘，零风险）。
   * Chrome 扩展磁盘布局：<userDataDir>/<profileDir>/Extensions/<extensionId>/<version>/...
   *   其中 profileDir 通常是 "Default"、"Profile 1"、"Profile 2" 等。
   * 已解压加载的扩展（开发模式）不会复制到 Extensions/ 下，而是写在 Preferences JSON 的
   * extensions.settings 里——这里先覆盖常见场景（crx/商店安装/解压后若 Chrome 复制了一份），
   * Preferences 层的扫描作为补充（下面也做了）。
   * 返回 true 表示 profile 下可能存在该扩展；返回 false 表示没找到。
   */
  hasInstalledExtensionOnDisk(extId: string): boolean {
    if (!extId || typeof extId !== 'string') return false;
    const root = this.userDataDir;
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return false;
    // 1) 扫描所有 profile 子目录下 Extensions/<extId>
    // 2026-08-07 审查项 P0-2: 原判定只要 Extensions/<extId> 目录存在就算已装。
    // Chrome 卸载扩展偶发留空目录 → 误报「已安装」→ 回到 2b11c44 之前的「永久打不开」。
    // 修复：至少要有一个含 manifest.json 的版本子目录才算已装。
    const candidates: string[] = [];
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const extDir = path.join(root, entry.name, 'Extensions', extId);
        candidates.push(extDir);
        const directExtDir = path.join(root, 'Extensions', extId);
        if (!candidates.includes(directExtDir)) candidates.push(directExtDir);
      }
    } catch { /* 读目录失败按未找到处理 */ }
    for (const extDir of candidates) {
      try {
        if (!fs.existsSync(extDir) || !fs.statSync(extDir).isDirectory()) continue;
        // 必须有至少一个含 manifest.json 的版本子目录
        const hasMfst = fs.readdirSync(extDir, { withFileTypes: true }).some((e) => {
          if (!e.isDirectory()) return false;
          return fs.existsSync(path.join(extDir, e.name, 'manifest.json'));
        });
        if (hasMfst) return true;
      } catch {}
    }
    // 2) Secure Preferences / Preferences 扫描（覆盖"加载已解压扩展"场景）
    //
    // 2026-08-07 审查项 P0-2: 原实现只读 Preferences，而真实 Chrome 把
    // extensions.settings 写在 "Secure Preferences"（真机验证）。
    // 我们自己的两个插件都是 location=4（加载已解压），永远在 Secure Preferences
    // 里，Preferences 里的 extensions.settings 整个不存在。
    // 修复：同时读两个文件，对 location=4 的记录还要用 fs.existsSync 校验路径
    // 仍然有效——这才是 2b11c44 想解决「pinned 残留」问题的正确方案。
    const prefFiles: string[] = [];
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        prefFiles.push(path.join(root, entry.name, 'Secure Preferences'));
        prefFiles.push(path.join(root, entry.name, 'Preferences'));
      }
      prefFiles.push(path.join(root, 'Secure Preferences'));
      prefFiles.push(path.join(root, 'Preferences'));
    } catch {}
    for (const pref of prefFiles) {
      try {
        if (!fs.existsSync(pref)) continue;
        const raw = fs.readFileSync(pref, 'utf-8');
        if (!raw.includes(extId)) continue;
        let settings: any;
        try {
          settings = JSON.parse(raw)?.extensions?.settings;
        } catch {
          console.warn(`[isolation] ${path.basename(pref)} 解析失败，跳过该文件的扩展判定：${pref}`);
          continue;
        }
        if (!settings || !Object.prototype.hasOwnProperty.call(settings, extId)) continue;
        const rec = settings[extId];
        // location=4 = 加载已解压扩展：path 字段指向磁盘目录，需校验路径仍存在
        // 否则 Chrome 会在数据里留下已删除扩展的残留记录，误报为已安装
        if (rec?.location === 4) {
          if (rec?.path && fs.existsSync(rec.path)) return true;
          // 路径已失效，说明扩展目录已被删 → 视为未安装
          continue;
        }
        return true;
      } catch { /* 单个文件读失败不影响其它候选 */ }
    }
    return false;
  }

  findChrome(): string | null {
    const candidates = [
      this.chromePath,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  }

  async launch(opts?: { headless?: boolean; chromePath?: string; extraArgs?: string[]; startUrl?: string }): Promise<Browser> {
    if (this.browser) return this.browser;
    // C5: 与 connectExisting 同口径串行化
    if (this.connectingPromise) return this.connectingPromise;
    // opts.chromePath 来自 IPC 直传（渲染层可控）→ 必须过白名单，与 extraArgs 同口径。
    // 非法值不静默忽略也不接受，直接拒绝，避免"以为指定了却用了别的浏览器"。
    if (opts?.chromePath && !ChromeManager.isSafeExecutable(opts.chromePath)) {
      throw new Error(`拒绝启动：指定的浏览器路径不在允许范围内（只接受 chrome/chromium/msedge 可执行文件）：${opts.chromePath}`);
    }
    const chromePath = opts?.chromePath || this.chromePath || this.findChrome();
    if (!chromePath) throw new Error('未找到 Chrome 浏览器，请在设置中指定路径');

    // G1 启动层兜底：在任何写文件/删文件动作【之前】再校验一次 userDataDir，
    // 防止 settings 层被绕过（DB 旧值、手工改库）后直接破坏用户日常 Chrome。
    // 校验必须排在 fs.rmSync Singleton* 【前面】——rmSync 是不可逆破坏动作。
    const blockedByDefault = ChromeManager.isDefaultBrowserProfile(this.userDataDir);
    if (blockedByDefault) {
      throw new IsolationViolationError(
        `拒绝启动：userDataDir 指向系统默认浏览器 profile（${this.userDataDir}）。`
        + `把平台 userDataDir 设到日常 Chrome 会导致平台删除该 profile 的 Singleton 锁、`
        + `并 puppeteer 附着装着匹配分插件的日常浏览器——插件线的零风险防护会被彻底破坏。`
        + `请在设置→浏览器→高级里把数据目录改回平台专用目录（默认是平台数据目录下的 chrome-profile）。`,
      );
    }

    // A(P0): 启动前硬阻断——RPA profile 里不得装着匹配分插件。
    // 因果纠正（A4）：受影响的是 RPA 线而不是插件线。用户真人 sourcing 用的是日常 Chrome，
    // 不碰 RPA profile，插件线零风险前提（不被附着、不发 zhipin 请求）不会被破坏。真正的
    // 风险在 RPA 侧：被 puppeteer 附着的会话里多了一个会给每张候选人卡片插 span、改 position
    // 的扩展，DOM 与真实 Chrome 产生额外差异，增加了 RPA 会话被识别的攻击面。
    // 必须在 isDefaultBrowserProfile 之后、rmSync Singleton* 之前检查（不删任何文件）。
    // A2: 绝不能用 --disable-extensions 绕过——那是 puppeteer 默认注入的测试标志，
    // 在 ignoreDefaultArgs 里已被显式清除，加上反而暴露 RPA。
    if (this.rejectExtensionIds.some((id) => this.hasInstalledExtensionOnDisk(id))) {
      const ids = this.rejectExtensionIds.filter((id) => this.hasInstalledExtensionOnDisk(id)).join(', ');
      throw new IsolationViolationError(
        `拒绝启动：在 RPA 专用 profile（${this.userDataDir}）里发现了匹配分插件（扩展 ID：${ids}）。`
        + `若在被 puppeteer 附着的 RPA 会话里启动该扩展，扩展会给每张候选人卡片插入额外 DOM 元素，`
        + `增加 RPA 会话被 BOSS 识别的攻击面（你真人 sourcing 用的日常 Chrome 不受影响）。`
        + `解决办法：打开 RPA 专用 Chrome（平台启动的那个独立 Chrome 窗口），进入 chrome://extensions，`
        + `找到「TA 匹配分助手」点"移除"；匹配分插件应该装在你日常用的 Chrome 里（不是 RPA 这个）。`,
      );
    }

    if (!fs.existsSync(this.userDataDir)) fs.mkdirSync(this.userDataDir, { recursive: true });
    // 清理残留单例锁（上次强杀留下的 SingletonLock 会让新 Chrome 转交后退出）
    for (const n of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.rmSync(path.join(this.userDataDir, n), { force: true }); } catch { /* 忽略 */ }
    }

    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.userDataDir}`,
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ];
    // C-2: 平台专属启动参数（如猎聘 --disable-features=CalculateNativeWinOcclusion）
    if (this.platformLaunchArgs.length) args.push(...this.platformLaunchArgs);
    // ⚠️ 硬禁 headless：BOSS 招聘端有 11 项 Chrome 特性缺失检测（serviceWorker/hid/serial/…），
    // headless 会被直接命中判为自动化 → 弹回登录/封控。BOSS 场景一律有头，忽略调用方 headless。
    if (opts?.headless) console.warn('[cdp] 已忽略 headless 请求：BOSS 场景强制有头，防特性缺失检测');
    // M-13: 合并用户配置的启动参数（来自 settings.browser.extraArgs）
    if (this.extraArgs.length) args.push(...this.extraArgs);
    if (opts?.extraArgs?.length) args.push(...opts.extraArgs);
    // ★ 2026-08-20 P0：防遮挡 / 防后台丢弃（含把已有的 --disable-features 合并成一条放末尾）。
    //   必须在 platformLaunchArgs / extraArgs 都收集完之后调用——否则合并拿不到全部功能开关。
    const anti = ChromeManager.appendAntiOcclusionArgs(args);
    args.length = 0; args.push(...anti);
    if (opts?.startUrl) args.push(opts.startUrl); // 直接打开 BOSS，用户在标准登录页登录一次

    this.browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      protocolTimeout: ChromeManager.PROTOCOL_TIMEOUT_MS,
      userDataDir: this.userDataDir,
      args,
      defaultViewport: null,
      // R2-2026-07-24: 完整清除 puppeteer 默认注入的"测试标志"，
      // 这些标志会让 Chrome 表现出测试环境特征（禁用扩展、禁用后台网络、禁用组件扩展等）。
      // 注意：主路径 openBrowserForLogin 走 spawn 独立Chrome（不经过puppeteer launch），
      // 不受此影响；这里只修专用浏览器模式（备用路径）。
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-component-extensions-with-background-pages',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
      ],
    });

    this.attachListeners();
    await this.adoptExistingPages();
    this.emit('connected');
    return this.browser!;
  }

  // 集成的一键连接核心：spawn 一个【独立存活】的 Chrome（不随 app 关闭而关闭，保住 BOSS 登录态），
  // 带调试端口 + 持久 profile + 打开 BOSS 首页让用户登录一次；然后 CDP 连接它。
  // 与 puppeteer.launch 的区别：detached，app 退出/断开都不会杀 Chrome，会话登录得以保留。
  async launchDetached(startUrl = 'https://www.zhipin.com'): Promise<Browser> {
    if (this.browser) return this.browser;
    // 端口上已有 Chrome（比如上次 detached 的还活着）→ 直接连。
    // 端口归属校验由 connectExisting() 内部完成（IsolationViolationError 会被 catch 块重新抛出）。
    // G2/G3: 不能无条件吞错——connectExisting 可能因为"对端装着被禁扩展（匹配分插件）"
    // 而拒绝附着，这是【安全拒绝】而不是"端口没开"。继续起新的只会让 spawn 与占端口的
    // 日常 Chrome 争端口，行为混乱。区分两种错：
    //   · 连不上（ECONNREFUSED / 没开）→ 继续起新的专用 Chrome；
    //   · 安全拒绝（装了被禁扩展）→ 直接把错误抛给用户，由他们关掉那个 Chrome。
    try { return await this.connectExisting(); }
    catch (e: any) {
      // IsolationViolationError：安全拒绝（对端装着被禁扩展 / 被禁 profile / 端口被外部程序的
      // Chrome 占用），不能吞，必须抛给用户处理。尤其是端口被外部占用这一条：吞掉它去
      // "继续起新的"，要么因端口冲突失败，要么静默连到别人的浏览器上——正是要防的那个漏洞。
      if (IsolationViolationError.is(e)) throw e;
      // 其它错误（端口没开、WebSocket 握手失败等）→ 正常路径：继续起新的专用 Chrome。
    }

    const chromePath = this.chromePath || this.findChrome();
    if (!chromePath) throw new Error('未找到 Chrome 浏览器，请在设置→浏览器→高级里指定路径');

    // G1 启动层兜底：删 Singleton* 之前校验，顺序不可颠倒——rmSync 是不可逆破坏动作。
    const blockedByDefault = ChromeManager.isDefaultBrowserProfile(this.userDataDir);
    if (blockedByDefault) {
      throw new IsolationViolationError(
        `拒绝启动：userDataDir 指向系统默认浏览器 profile（${this.userDataDir}）。`
        + `把平台 userDataDir 设到日常 Chrome 会导致平台删除该 profile 的 Singleton 锁、`
        + `并 puppeteer 附着装着匹配分插件的日常浏览器——插件线的零风险防护会被彻底破坏。`
        + `请在设置→浏览器→高级里把数据目录改回平台专用目录（默认是平台数据目录下的 chrome-profile）。`,
      );
    }

    // A(P0) RPA profile 里不得装着匹配分插件（同 launch()，见 launch 内详细因果说明）。
    if (this.rejectExtensionIds.some((id) => this.hasInstalledExtensionOnDisk(id))) {
      const ids = this.rejectExtensionIds.filter((id) => this.hasInstalledExtensionOnDisk(id)).join(', ');
      throw new IsolationViolationError(
        `拒绝启动：在 RPA 专用 profile（${this.userDataDir}）里发现了匹配分插件（扩展 ID：${ids}）。`
        + `若在被 puppeteer 附着的 RPA 会话里启动该扩展，扩展会给每张候选人卡片插入额外 DOM 元素，`
        + `增加 RPA 会话被 BOSS 识别的攻击面（你真人 sourcing 用的日常 Chrome 不受影响）。`
        + `解决办法：打开 RPA 专用 Chrome（平台启动的那个独立 Chrome 窗口），进入 chrome://extensions，`
        + `找到「TA 匹配分助手」点"移除"；匹配分插件应该装在你日常用的 Chrome 里（不是 RPA 这个）。`,
      );
    }

    if (!fs.existsSync(this.userDataDir)) fs.mkdirSync(this.userDataDir, { recursive: true });

    // 关键：清理残留单例锁。上一次 Chrome 若被强杀会留下 SingletonLock 指向死进程，
    // 新 Chrome 会误以为已有实例 → 打开页面后立刻转交并自我退出（表现为"闪退"）。
    // 此处仅在无已连接浏览器（即将新起）时清理，安全。
    for (const n of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.rmSync(path.join(this.userDataDir, n), { force: true }); } catch { /* 忽略 */ }
    }

    // ★ 2026-08-20 P0：防遮挡 / 防后台丢弃。先收集除 startUrl 外的全部参数，合并其中的
    //   --disable-features（含猎聘 platformLaunchArgs 的 CalculateNativeWinOcclusion）成一条，
    //   再追加 startUrl，保证 startUrl 仍是末位参数且功能开关不被末条覆盖。
    const baseArgs = ChromeManager.appendAntiOcclusionArgs([
      `--remote-debugging-port=${this.cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
      '--disable-blink-features=AutomationControlled', '--start-maximized',
      ...this.platformLaunchArgs,
      ...this.extraArgs,
    ]);
    const args = [...baseArgs, startUrl];
    // Windows：直接 spawn 的 Chrome 会被并入 Electron 主进程的 Job Object，
    // 随 app 的进程管理被一起关掉（表现为"打开即闪退"）。用 cmd 的 start 把 Chrome
    // 彻底从 app 进程组剥离，成为真正独立、随 app 关闭仍存活的进程。
    console.log('[cdp] launchDetached spawn:', chromePath, 'port', this.cdpPort, 'profile', this.userDataDir);
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '', chromePath, ...args], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.on('error', (e) => console.error('[cdp] spawn error:', e.message));
      child.unref();
    } else {
      const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
      child.unref();
    }

    await this.waitForPort(this.cdpPort, 20000);
    console.log('[cdp] 调试端口就绪，开始连接');
    const b = await this.connectExisting();
    const pages = await b.pages().catch(() => []);
    console.log('[cdp] 已连接，标签数:', pages.length, pages.map((p) => p.url().slice(0, 45)));
    // 3 秒后自检浏览器是否还活着（诊断闪退）
    setTimeout(async () => {
      const ok = await this.waitForPort(this.cdpPort, 1500).then(() => true).catch(() => false);
      console.log('[cdp][诊断] 连接后 3 秒，浏览器存活:', ok, '| this.browser:', !!this.browser);
    }, 3000);
    return b;
  }

  // 轮询调试端口就绪
  private waitForPort(port: number, timeoutMs = 20000): Promise<void> {
    const start = Date.now();
    const once = () => new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (r) => { r.resume(); resolve(r.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    return (async () => {
      while (Date.now() - start < timeoutMs) {
        if (await once()) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('Chrome 调试端口未就绪（启动超时）');
    })();
  }

  // M-11：仅允许本地回环 endpoint（防止 XSS 后连接内网/远程 CDP 的 SSRF）
  static isLocalEndpoint(ep: string): boolean {
    try {
      const u = new URL(ep);
      const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      return h === '127.0.0.1' || h === 'localhost' || h === '::1';
    } catch {
      return false;
    }
  }

  async connectExisting(endpoint?: string): Promise<Browser> {
    if (this.browser) return this.browser;
    // C5: 在途 promise 串行化 —— 两次并发各跑完一次 puppeteer.connect 会导致
    // 后者覆盖前者、旧 Browser WebSocket 永不关闭、同一页被注入两遍。
    if (this.connectingPromise) return this.connectingPromise;
    this.connectingPromise = (async () => {
      try {
        return await this._doConnectExisting(endpoint);
      } finally {
        this.connectingPromise = null;
      }
    })();
    return this.connectingPromise;
  }

  /**
   * 断连后重连：先彻底清掉旧 puppeteer 附着状态（断掉的 WebSocket、常驻 CDP 会话、
   * targetcreated 监听器），再走一次 connectExisting 重新连到本实例端口上的 Chrome。
   *
   * 为什么需要它而非直接再调 connectExisting：disconnect 后 onDisconnected 把
   * this.browser 置了 null，但旧 Browser 对象上的 disconnected 监听器、bindingSession、
   * newDocSession 等残留引用若不主动 clearPersistentSessions，重连成功后会出现
   * 「旧会话的 detach 与新会话并存」「同一页被 adopt 两遍」的泄漏。disconnect() 已封装
   * 了 clearPersistentSessions + 摘监听器，所以这里复用它再 connect。
   *
   * Chrome 在长休空闲掉线后通常【进程仍活着】，重连即恢复登录态与标签页；若进程已退出，
   * connectExisting 会因端口连不上而抛 ECONNREFUSED——这是"真不可恢复"，由上层判定停机。
   * 不 launch：launch 会附着全新进程，登录态与用户已打开的工作页全部丢失，且与"绝不新开
   * tab/进程做自动化导航"的反检测铁律冲突。重连只复用已存在的 Chrome。
   */
  async reconnect(): Promise<Browser> {
    // 先彻底卸下旧附着（幂等：browser 为 null 时 disconnect 直接返回）。
    await this.disconnect();
    // connectExisting 内部有 connectingPromise 串行化 + 端口归属校验 + 扩展黑名单校验，
    // 与首次连接走完全相同的安全路径——重连不会绕过任何一道闸。
    return this.connectExisting();
  }

  private async _doConnectExisting(endpoint?: string): Promise<Browser> {
    const ep = endpoint || `http://127.0.0.1:${this.cdpPort}`;
    // M-11 修复：拒绝连接非本地 CDP endpoint
    if (!ChromeManager.isLocalEndpoint(ep)) {
      throw new Error(`拒绝连接非本地 CDP endpoint（仅允许 127.0.0.1/localhost）：${ep}`);
    }
    // ★ 端口归属校验（隔离外部防线）：只连"本应用启动的那个 Chrome"。
    //   端口是全机共享资源，别的程序完全可能先占住——连上去就等于把 RPA 跑进别人的浏览器。
    //   仅当调用方显式传了自定义 endpoint 时跳过（那是人工排障路径，责任在调用方）。
    if (!endpoint) {
      const insp = await this.inspectPort();
      if (insp.state === 'foreign') throw this.foreignPortError();
    }
    // protocolTimeout：单条 CDP 命令的最长等待。puppeteer 默认 180s——真机 07-28 那次
    // 一个 loadMore 卡了 745 秒，就是因为没有任何一层给 CDP 调用设上限，
    // Input.dispatchMouseEvent 在 BOSS 页面主线程繁忙时会一直等渲染进程回执。
    // 收到 60s：仍宽于任何正常操作（goto 自己带 45s 超时），但杜绝分钟级静默挂死。
    // defaultViewport: null —— 必须显式传。puppeteer 的 connect 默认会把每个页面
    // Emulation.setDeviceMetricsOverride 成 800x600（launch 那边早就传了 null，connect 漏了）。
    // 真机实测后果：窗口 1296x768 而 window.innerWidth/Height 被压成 800x600，
    // 与 outerWidth/Height、screen 全对不上——真实 Chrome 最大化时不可能出现这种组合，
    // 属于登记册明令禁止的"不一致指纹"；同时 BOSS 页面会按 800x600 重排，
    // 影响推荐帧布局与懒加载阈值。
    const connOpts = { protocolTimeout: ChromeManager.PROTOCOL_TIMEOUT_MS, defaultViewport: null };
    let connectedBrowser: Browser;
    try {
      connectedBrowser = await puppeteer.connect({ browserWSEndpoint: ep, ...connOpts });
    } catch {
      connectedBrowser = await puppeteer.connect({ browserURL: ep, ...connOpts });
    }

    // G2/G3: 连接成功后【立即】检查对端浏览器是否装着被禁止的扩展（匹配分插件等）。
    // 场景：mode:'existing' 时 connectExisting 连的是端口上【已存在】的浏览器；若用户
    // 自己用 --remote-debugging-port=9222 启动过日常 Chrome（装着匹配分插件），G1 的
    // 设置层校验完全绕过——这里是最后一道闸。
    // 检查方式：service_worker（MV3）/ background_page（MV2）类型的 target 是扩展
    // 后台上下文，其 url 以 chrome-extension://<id>/ 开头。命中即断开、抛错，不挂监听器、
    // 不 adopt 任何页、不 emit connected，保证该浏览器永远处于"未被平台接管"的状态。
    // 为什么在 attachListeners/adoptExistingPages 之前：一旦 adoptPage，就会对页面
    // Runtime.enable + 注入工具脚本，已经在被附着浏览器里留下自动化痕迹——必须在这之前拒绝。
    if (this.rejectExtensionIds.length) {
      const badIds: string[] = [];
      try {
        const targets = connectedBrowser.targets();
        for (const t of targets) {
          // 扫描【所有】类型的 target（不限制为 service_worker/background_page）：
          // MV3 的 service worker 在某些 puppeteer/Chrome 版本里可能暴露为 'other' 或其它类型，
          // 但扩展的任何后台页/options/popup/content-script 配套页其 url 一定以
          // chrome-extension://<id>/ 开头。只看类型会漏；看 URL 前缀是最稳的判定。
          // 普通页面 tab 的 url 是 https://...，不会误命中。
          const url = t.url() || '';
          for (const id of this.rejectExtensionIds) {
            if (url.startsWith(`chrome-extension://${id}/`)) {
              if (!badIds.includes(id)) badIds.push(id);
            }
          }
        }
      } catch (e: any) {
        // 取 target 失败不直接放行：为避免"检查器坏了 → 被静默绕过"，保守处理断开连接后抛错。
        try { connectedBrowser.disconnect(); } catch {}
        throw new IsolationViolationError(
          `连接浏览器后无法检查其已装扩展（${e?.message || e}），为避免误附着日常 Chrome 已断开。请改用平台专用 profile。`,
        );
      }
      if (badIds.length) {
        // 命中：先断开，再抛错——this.browser 全程保持 null，避免上层看到半连接状态。
        try { connectedBrowser.disconnect(); } catch {}
        throw new IsolationViolationError(
          `拒绝附着：端口 ${this.cdpPort} 上的浏览器装着匹配分插件（扩展 ID：${badIds.join(', ')}）。`
          + `附着它会让插件线（日常 Chrome 里负责实时评分的扩展）暴露在 CDP 自动化检测下，`
          + `插件"不被 puppeteer 附着"的零风险前提会被破坏。请关闭该 Chrome 实例，改用平台专用 profile（默认就是），或设置→浏览器里切换到专用模式。`,
        );
      }
    }

    this.browser = connectedBrowser;
    this.attachListeners();
    // 关键修复：连接到【已在运行】的 Chrome 时，其【已存在的页】不会经过 targetcreated，
    // 而 RPA 引擎正是复用这些已存在的页（推荐牛人页）。若不在此补挂风控响应监控，
    // 精密防范模型的网络层信号（code:35 / 403 / 429 / Boss端100xx静默上报）对真正的
    // RPA 目标页永远不触发（静默失效）。此处遍历已存在页逐一补挂（幂等）。
    await this.adoptExistingPages();
    this.emit('connected');
    return this.browser;
  }

  // 连接/启动时对所有【已存在】的页补做完整接管（风控监控+注入，幂等，靠 adoptedPages 去重）。
  // 只补监控不补注入是旧行为，造成「先开页后连接」时工具永远注入不进（见 adoptPage 注释）。
  private async adoptExistingPages(): Promise<void> {
    if (!this.browser) return;
    try {
      const pages = await this.browser.pages();
      for (const p of pages) {
        try { this.adoptPage(p); } catch { /* 单页失败不影响其它 */ }
      }
    } catch { /* 取页失败忽略 */ }
  }

  // 供 RPA 引擎在开始运行前对其复用的目标页确保已挂风控监控（幂等）。
  ensureRiskMonitor(page: Page): void {
    try { this.attachRiskResponseMonitor(page); } catch { /* 忽略 */ }
  }

  // 一键智能连接：优先连已开的调试 Chrome（复用登录态），连不上则自动起一个专用 Chrome，
  // 连上后自动打开 BOSS 推荐牛人页——用户点一下"连接浏览器"就直达 BOSS。
  // 「开始找人」时才用：连接已登录的调试 Chrome（此时才 attach puppeteer）。
  // 不再自己 launch —— launch 会 attach puppeteer 干扰登录。若没开浏览器则报错引导。
  async smartConnect(): Promise<{ mode: 'already' | 'existing' | 'launched' }> {
    if (this.browser) return { mode: 'already' };
    await this.connectExisting(); // 连不上直接抛错，前端提示先"打开浏览器并登录"
    return { mode: 'existing' };
  }

  // 单检端口是否就绪（不 attach）。
  // ⚠️ 端口通 ≠ 那是我们的浏览器。判"能不能连"必须用 inspectPort()，别直接用这个。
  private async isPortUp(): Promise<boolean> {
    return this.waitForPort(this.cdpPort, 800).then(() => true).catch(() => false);
  }

  /**
   * 本实例的 profile 目录是否正被某个 Chrome 占用。
   * Chrome 运行时会独占持有 user-data-dir 下的锁文件（Windows: lockfile；*nix: SingletonLock）。
   * 能以写方式打开 = 没被占用；EBUSY/EPERM/EACCES = 正被占用。
   */
  private isProfileInUse(): boolean {
    for (const n of ['lockfile', 'SingletonLock']) {
      const f = path.join(this.userDataDir, n);
      try {
        if (!fs.existsSync(f)) continue;
        const fd = fs.openSync(f, 'r+'); // 被 Chrome 独占时这里会抛
        fs.closeSync(fd);
      } catch (e: any) {
        const code = String(e?.code || '');
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return true;
        // 其它错误（如符号链接）不足以判定，继续看下一个候选
      }
    }
    return false;
  }

  /**
   * ★ 端口归属判定（隔离的外部防线）。
   *
   * 调试端口是【全机共享资源】，别的程序（另一个 Chrome 实例、别的自动化工具、
   * 另一个会话的测试浏览器）完全可能先占住 9222/9333。原实现只判"端口通不通"，
   * 端口一通就当成"我们的浏览器已在跑"，于是往【别人的 Chrome】里开标签页并 attach
   * 上去跑 RPA —— 隔离被一个与本应用无关的外部进程直接击穿，而且用户毫无感知。
   *
   * 判据：端口通 + 我们自己的 profile 正被占用 → 是我们的；
   *       端口通 + 我们的 profile 没被占用   → 是别人的（此时必须拒绝，不能连）。
   */
  async inspectPort(): Promise<{ state: 'free' | 'ours' | 'foreign'; port: number }> {
    const up = await this.isPortUp();
    if (!up) return { state: 'free', port: this.cdpPort };
    return { state: this.isProfileInUse() ? 'ours' : 'foreign', port: this.cdpPort };
  }

  /**
   * 外部占用的拒绝错误。
   * 必须是 IsolationViolationError —— launchDetached 靠这个类型区分「安全拒绝」与
   * 「端口没开」：普通 Error 会被当成后者而"继续起新的"，等于漏洞照旧。
   */
  private foreignPortError(): IsolationViolationError {
    return new IsolationViolationError(
      `调试端口 ${this.cdpPort} 已被【其它程序的 Chrome】占用（不是本应用启动的浏览器，`
      + `profile: ${path.basename(this.userDataDir)}）。\n`
      + '为避免把自动化跑到别人的浏览器里（那会击穿浏览器隔离），已拒绝连接。\n'
      + '请关掉占用该端口的浏览器，或到「设置 → 浏览器 → 高级设置」改用一个空闲端口后重试。',
    );
  }

  // 通过调试端口只读列出标签页（HTTP /json/list，【不 attach puppeteer】）。
  private listTargets(): Promise<Array<{ id: string; type: string; url: string; title: string }>> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.cdpPort}/json/list`, (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => {
          try {
            const arr = JSON.parse(data);
            resolve(Array.isArray(arr)
              ? arr.map((t: any) => ({ id: String(t.id || ''), type: String(t.type || ''), url: String(t.url || ''), title: String(t.title || '') }))
              : []);
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(1500, () => { req.destroy(); resolve([]); });
    });
  }

  private async listTargetUrls(): Promise<string[]> {
    return (await this.listTargets()).map((t) => t.url);
  }

  // 通用 DevTools HTTP 请求（不经 puppeteer、不 attach，页面侧完全无感）
  private devtoolsHttp(method: 'GET' | 'PUT', pathname: string, timeoutMs = 4000): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.cdpPort, path: pathname, method },
        (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve(r.statusCode && r.statusCode < 400 ? data : null));
        },
      );
      req.on('error', () => resolve(null));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  // 把某个标签页激活并把承载它的浏览器窗口带到前台（DevTools HTTP /json/activate，不 attach）
  private async activateTarget(targetId: string): Promise<boolean> {
    if (!targetId) return false;
    const r = await this.devtoolsHttp('GET', `/json/activate/${encodeURIComponent(targetId)}`);
    return r !== null;
  }

  // 在【已在运行】的浏览器里新开一个标签页（DevTools HTTP /json/new，Chrome 111+ 要求 PUT）
  private async openTabViaHttp(url: string): Promise<{ id: string; url: string } | null> {
    const q = `/json/new?${encodeURIComponent(url)}`;
    let body = await this.devtoolsHttp('PUT', q);
    if (body === null) body = await this.devtoolsHttp('GET', q); // 兼容老版本 Chrome
    if (!body) return null;
    try {
      const t = JSON.parse(body);
      return t && t.id ? { id: String(t.id), url: String(t.url || url) } : null;
    } catch { return null; }
  }

  // 等待出现至少一个真实页面标签（端口就绪 ≠ 有可用窗口：僵尸实例也会让 /json/version 返回 200）
  private async waitForPageTarget(timeoutMs = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pages = (await this.listTargets()).filter((t) => t.type === 'page');
      if (pages.length) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  // 反检测：在【自动接管前】判断浏览器是否正处于登录/验证页——BOSS 招聘端要求登录/验证阶段零 CDP 附着，
  // 此时接管可能打断登录或被判自动化。只读探测，不 attach。
  async isOnLoginOrVerify(): Promise<boolean> {
    const urls = await this.listTargetUrls();
    return urls.some((u) => /passport|zp\/verify|\/web\/user\/|\/login|signin|callbackUrl=/i.test(u));
  }

  // 「打开浏览器」用：spawn 一个开着调试端口的 Chrome 打开 BOSS，但【绝不连 puppeteer】——
  // 登录期间浏览器上没有任何程序附着，BOSS 检测不到自动化，登录才能成功。
  /**
   * 在【调试 Chrome】里打开指定站点并把窗口/标签页提到前台；浏览器没起就先起。
   *
   * 为什么必须是这个浏览器、不能用 shell.openExternal 打开系统默认浏览器：
   * 平台工具库（飞书需求一键复制等）走的是 CDP 注入，只对【已连接的这个浏览器】里的页生效。
   * 用系统默认浏览器打开的话页面确实开了，但工具永远不会出现，用户会以为工具坏了。
   * （BOSS 匹配分插件相反——它是 Chrome 扩展，装在用户日常浏览器里，那条路才用 openExternal。）
   *
   * matchRe 用来判断"是不是已经有这个站点的标签页了"，避免每次点都新开一个。
   */
  async openSiteInDebugBrowser(url: string, matchRe: RegExp): Promise<OpenBrowserResult> {
    // ★ 端口归属校验：端口通 ≠ 那是我们的浏览器。别人的 Chrome 占着时，
    //   往下走会把工具页开进别人的浏览器（工具线同样不能外溢）。
    const inspSite = await this.inspectPort();
    if (inspSite.state === 'foreign') throw this.foreignPortError();
    if (inspSite.state === 'ours') {
      const pages = (await this.listTargets()).filter((t) => t.type === 'page');
      let hit = pages.find((t) => matchRe.test(t.url));
      if (!hit) {
        const t = await this.openTabViaHttp(url);
        if (t) hit = { id: t.id, type: 'page', url: t.url, title: '' };
      }
      const focused = hit ? await this.activateTarget(hit.id) : false;
      return { launched: false, alreadyOpen: true, focused, url: hit?.url };
    }
    // 端口没起 → 复用启动逻辑（它会 spawn 一个带调试端口的 Chrome 并等到真实窗口出现）
    const r = await this.openBrowserForLogin(url);
    // 启动时的 startUrl 就是目标站点，但保险起见再确保一次并前置
    try {
      const pages = (await this.listTargets()).filter((t) => t.type === 'page');
      let hit = pages.find((t) => matchRe.test(t.url));
      if (!hit) {
        const t = await this.openTabViaHttp(url);
        if (t) hit = { id: t.id, type: 'page', url: t.url, title: '' };
      }
      if (hit) {
        const focused = await this.activateTarget(hit.id);
        return { ...r, focused, url: hit.url };
      }
    } catch { /* 已启动，定位失败就返回启动结果 */ }
    return r;
  }

  async openBrowserForLogin(startUrl = 'https://www.zhipin.com'): Promise<OpenBrowserResult> {
    // ── 情况 A：调试端口已就绪（浏览器已在跑）──────────────────────────────
    // 原实现在这里直接 `return { launched:false }` 就完事：既不把窗口提到前台、
    // 也不确保有 BOSS 标签页。用户点了按钮【什么都不会发生】，界面却报"已打开"——
    // 这正是"点击未成功打开却在网页显示打开"的根因（窗口在 app 后面/最小化时尤其明显）。
    // ★ 先判端口归属：端口通 ≠ 那是我们的浏览器。若是别人的 Chrome 占着，
    //   继续走下去会往别人的浏览器里开标签页并激活 —— 必须直接拒绝。
    const inspLogin = await this.inspectPort();
    if (inspLogin.state === 'foreign') throw this.foreignPortError();
    if (inspLogin.state === 'ours') {
      const targets = await this.listTargets();
      const pages = targets.filter((t) => t.type === 'page');
      if (pages.length) {
        // ★ 站点判定必须从 startUrl 推导，不能硬编码 zhipin.com。
        //   原实现写死 BOSS 域名：猎聘浏览器里明明已经开着 lpt.liepin.com 的标签页，
        //   这里也永远匹配不上 → 每点一次「开始找人 / 打开浏览器」就 openTabViaHttp 再开一个新标签，
        //   表现为"一直在打开浏览器"，标签页越堆越多。
        let host = '';
        try { host = new URL(startUrl).hostname.replace(/^www\./i, ''); } catch { /* 用不了就退回不匹配 */ }
        // 取主域（lpt.liepin.com → liepin.com），这样落地页与实际停留页不同子域也算已打开
        const baseDomain = host.split('.').slice(-2).join('.');
        let existing = baseDomain
          ? pages.find((t) => { try { return new URL(t.url).hostname.endsWith(baseDomain); } catch { return false; } })
          : undefined;
        if (!existing) {
          const t = await this.openTabViaHttp(startUrl);
          if (t) existing = { id: t.id, type: 'page', url: t.url, title: '' };
        }
        const focused = existing ? await this.activateTarget(existing.id) : false;
        return { launched: false, alreadyOpen: true, focused, url: existing?.url };
      }
      // 端口在、却没有任何页面标签 → 僵尸/无窗口实例。先试着让它开一个标签页。
      const t = await this.openTabViaHttp(startUrl);
      if (t) {
        const focused = await this.activateTarget(t.id);
        return { launched: false, alreadyOpen: true, focused, url: t.url };
      }
      // 连开标签页都失败：端口被占但浏览器不可用，如实报错（不再假装成功）
      throw new Error(
        `调试端口 ${this.cdpPort} 已被占用，但该浏览器没有可用窗口（可能是残留进程）。`
        + `请在任务管理器结束残留的 Chrome 进程后重试，或在设置里改用其它调试端口。`,
      );
    }

    // ── 情况 B：端口未就绪 → 真正启动一个 ─────────────────────────────────
    const chromePath = this.chromePath || this.findChrome();
    if (!chromePath) throw new Error('未找到 Chrome 浏览器，请在设置→浏览器→高级里指定路径');

    // G1 启动层兜底：删 Singleton* 之前校验，顺序不可颠倒——rmSync 是不可逆破坏动作。
    const blockedByDefault = ChromeManager.isDefaultBrowserProfile(this.userDataDir);
    if (blockedByDefault) {
      throw new IsolationViolationError(
        `拒绝启动：userDataDir 指向系统默认浏览器 profile（${this.userDataDir}）。`
        + `把平台 userDataDir 设到日常 Chrome 会导致平台删除该 profile 的 Singleton 锁、`
        + `并以调试端口启动装着匹配分插件的日常浏览器——插件线的零风险防护会被彻底破坏。`
        + `请在设置→浏览器→高级里把数据目录改回平台专用目录（默认是平台数据目录下的 chrome-profile）。`,
      );
    }

    // A(P0) RPA profile 里不得装着匹配分插件（同 launch()，见 launch 内详细因果说明）。
    if (this.rejectExtensionIds.some((id) => this.hasInstalledExtensionOnDisk(id))) {
      const ids = this.rejectExtensionIds.filter((id) => this.hasInstalledExtensionOnDisk(id)).join(', ');
      throw new IsolationViolationError(
        `拒绝启动：在 RPA 专用 profile（${this.userDataDir}）里发现了匹配分插件（扩展 ID：${ids}）。`
        + `若在被 puppeteer 附着的 RPA 会话里启动该扩展，扩展会给每张候选人卡片插入额外 DOM 元素，`
        + `增加 RPA 会话被 BOSS 识别的攻击面（你真人 sourcing 用的日常 Chrome 不受影响）。`
        + `解决办法：打开 RPA 专用 Chrome（平台启动的那个独立 Chrome 窗口），进入 chrome://extensions，`
        + `找到「TA 匹配分助手」点"移除"；匹配分插件应该装在你日常用的 Chrome 里（不是 RPA 这个）。`,
      );
    }

    if (!fs.existsSync(this.userDataDir)) fs.mkdirSync(this.userDataDir, { recursive: true });
    for (const n of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.rmSync(path.join(this.userDataDir, n), { force: true }); } catch { /* 忽略 */ }
    }
    // ★ 2026-08-20 P0：防遮挡 / 防后台丢弃（根治长暂停后 ~46min 断连）。先收集除 startUrl 外
    //   的全部参数，把其中所有 --disable-features（含猎聘 platformLaunchArgs 的
    //   CalculateNativeWinOcclusion）合并成一条放末尾，再追加 startUrl——避免 Chrome 末条
    //   --disable-features 覆盖、功能开关丢失。这条是用户实际走的路径，必须与 launch/launchDetached
    //   同口径（2026-08-11 修过一次"漏 platformLaunchArgs"，本次再补"漏防遮挡参数"）。
    const baseArgs = ChromeManager.appendAntiOcclusionArgs([
      `--remote-debugging-port=${this.cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.userDataDir}`,
      '--no-default-browser-check', '--no-first-run', '--disable-default-apps',
      '--disable-blink-features=AutomationControlled', '--start-maximized',
      // ⛔⛔ 2026-08-11 真机查出：这里原来【漏了 platformLaunchArgs】，只带了用户自定义的 extraArgs。
      //   后果极重：猎聘 adapter 的 `--disable-features=CalculateNativeWinOcclusion`（屏幕遮挡 B 方案）
      //   只在 launch()/launchDetached() 两条路径生效，而【用户实际走的就是本函数】
      //   （设置→「打开猎聘浏览器」、以及 RPA 启动前的 openBrowserForLogin）。
      //   等于 B 方案在真实路径上从未生效过 —— 窗口一旦被其它窗口盖住，
      //   Chrome 就报 visibilityState=hidden，引擎的可交互闸门直接拒绝启动。
      //   这正是「TA 用 BOSS 找人的同时猎聘在后台跑」这条核心需求一直落不了地的原因。
      //   （真机结论：带上该参数后，被遮挡→仍可交互；最小化→仍不可交互，属预期。）
      ...this.platformLaunchArgs,
      ...this.extraArgs,
    ]);
    const args = [...baseArgs, startUrl];
    console.log('[cdp] openBrowserForLogin spawn（不连 puppeteer）:', chromePath, 'port', this.cdpPort,
      'platformArgs', JSON.stringify(this.platformLaunchArgs));
    // Windows：裸 spawn 出来的 Chrome 会被并入 Electron 主进程的 Job Object，
    // 随 app 的进程管理一起被关掉（表现为"打开即闪退"）。launchDetached 早就改用
    // `cmd /c start` 剥离进程组，但这条【主路径】一直漏掉了同样的修复——补上。
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '', chromePath, ...args], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.on('error', (e) => console.error('[cdp] openBrowserForLogin spawn error:', e.message));
      child.unref();
    } else {
      const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
      child.on('error', (e) => console.error('[cdp] openBrowserForLogin spawn error:', e.message));
      child.unref();
    }
    await this.waitForPort(this.cdpPort, 20000);
    // 端口起来 ≠ 窗口真的在：必须等到出现真实页面标签，否则如实报失败（不再报"已打开"）
    const hasPage = await this.waitForPageTarget(15000);
    if (!hasPage) {
      throw new Error('Chrome 已启动但没有出现可用窗口（可能被安全软件拦截或立即退出），请重试或手动打开 Chrome');
    }
    const pages = (await this.listTargets()).filter((t) => t.type === 'page');
    const boss = pages.find((t) => /zhipin\.com/i.test(t.url)) || pages[0];
    const focused = boss ? await this.activateTarget(boss.id) : false;
    return { launched: true, alreadyOpen: false, focused, url: boss?.url };
  }

  // 确保有一个 BOSS 页并置于最前：已有 zhipin 页则前置；否则复用一个空白标签导航过去
  // （避免多开），最后把浏览器窗口提到前台，用户点一下就能看到 BOSS。
  async ensureBossPage(url = 'https://www.zhipin.com/web/chat/recommend'): Promise<void> {
    if (!this.browser) return;
    const pages = await this.pages().catch(() => [] as Page[]);
    let page = pages.find((p) => /zhipin\.com/.test(p.url())) || null;
    if (!page) {
      // 复用空白/新标签页导航，没有则新建
      page = pages.find((p) => /^about:blank$|chrome:\/\/newtab/i.test(p.url())) || null;
      if (!page) page = await this.browser.newPage().catch(() => null);
      if (page) {
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
        catch (e: any) { console.warn('[cdp] ensureBossPage 打开 BOSS 失败:', e?.message || e); }
      }
    }
    if (page) {
      await page.bringToFront().catch(() => {});
      await this.frontWindow(page).catch(() => {});
    }
  }

  // 把承载该页的浏览器窗口恢复/置前（CDP Browser.setWindowBounds），避免 Chrome 窗口藏在 app 后面。
  private async frontWindow(page: Page): Promise<void> {
    let client: CDPSession | null = null;
    try {
      client = await page.target().createCDPSession();
      const { windowId } = (await client.send('Browser.getWindowForTarget')) as any;
      await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    } catch { /* 忽略 */ } finally {
      if (client) client.detach().catch(() => {});
    }
  }

  private attachListeners() {
    if (!this.browser) return;
    this.onDisconnected = () => {
      this.browser = null;
      this.onTargetCreated = null;
      this.onDisconnected = null;
      // G2: 断连时清理所有常驻会话（binding + 新文档注入），避免跨重连累积无效 CDPSession 引用
      this.clearPersistentSessions();
      this.emit('disconnected');
    };
    this.browser.on('disconnected', this.onDisconnected);

    this.onTargetCreated = (target: Target) => {
      this.handleTarget(target).catch((e) => console.error('[cdp] targetcreated error', e));
    };
    this.browser.on('targetcreated', this.onTargetCreated);
  }

  // 只断开 CDP 附着，【不关闭浏览器进程】——App 退出时必须用这个而不是 close()。
  // 理由：主路径的浏览器是 openBrowserForLogin/launchDetached spawn 出来的【独立进程】，
  // 其全部设计意图就是"随 app 关闭仍存活，保住 BOSS 登录态"。若退出时调 close()，
  // puppeteer 会对 connect 来的浏览器发 Browser.close 把它一并杀掉，登录态每次都要重来，
  // detached 的意义被完全抵消。close() 仅保留给用户显式点「关闭浏览器」的场景。
  async disconnect() {
    const b = this.browser;
    if (!b) return;
    if (this.onTargetCreated) { try { b.off('targetcreated', this.onTargetCreated); } catch {} }
    if (this.onDisconnected) { try { b.off('disconnected', this.onDisconnected); } catch {} }
    this.clearPersistentSessions();
    this.browser = null;
    this.onTargetCreated = null;
    this.onDisconnected = null;
    try { b.disconnect(); } catch {}
  }

  async close() {
    if (this.browser) {
      if (this.onTargetCreated) this.browser.off('targetcreated', this.onTargetCreated);
      if (this.onDisconnected) this.browser.off('disconnected', this.onDisconnected);
      // puppeteer.launch 起的浏览器由 app 拥有，正常关闭即可（登录 cookie 持久在 profile，
      // 下次启动仍是登录态，无需重登）。
      try {
        await this.browser.close();
      } catch {}
      this.clearPersistentSessions();
      this.browser = null;
      this.onTargetCreated = null;
      this.onDisconnected = null;
    }
  }

  /** 清空本实例全部常驻 CDP 会话（binding + 新文档注入）。断连/关闭/重连时统一走这里。 */
  private clearPersistentSessions() {
    for (const s of this.bindingSessions.values()) s.detach().catch(() => {});
    this.bindingSessions.clear();
    for (const s of this.newDocSessions.values()) s.detach().catch(() => {});
    this.newDocSessions.clear();
    this.newDocScripts.clear();
  }

  async newPage(url?: string): Promise<Page> {
    if (!this.browser) throw new Error('浏览器未连接');
    const page = await this.browser.newPage();
    this.attachRiskResponseMonitor(page);
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page;
  }

  /**
   * API响应风控监控：拦截BOSS wapi响应，检测code:35/异常消息等静默风控信号。
   * R2-2026-07-24：BOSS Boss端入口层IP/会话异常会返回 HTTP 200 + {"code":35,"message":"您的IP地址存在异常行为."}，
   * 页面可能没有明显的验证码/跳转（静默降权前兆），必须在response层拦截。
   */
  private attachRiskResponseMonitor(page: Page) {
    if (this.monitoredPages.has(page)) return; // 幂等：已挂过不重复
    this.monitoredPages.add(page);

    // ★ 平台化通道：由 adapter 注入 RiskNetRules 的平台走这里。
    //   BOSS 仍走下面那段硬编码 legacy 路径 —— 它已过多轮真机验证（含登记册第 13 条的
    //   安全 JS 加载失败检测），生产在用，不在本次改动范围内动它。
    //   将来要统一到一条通道，必须先单独做一次等价性验证，不能顺手合并。
    if (this.riskNet && this.platform !== 'boss') {
      this.attachPlatformRiskMonitor(page, this.riskNet);
      return;
    }

    // 登记册早停信号清单第 13 条：warlock / ka.v1 / boss-login / captcha-sdk /
    // boss-vue 的 vendor.js·app.js 加载失败 —— 此前【完全没有检测】。
    // 上面那个 response 监听用 /wapi/…/ 白名单把 static.zhipin.com 的静态资源整个排除了，
    // 而这些安全/风控 JS 恰恰都在那个域上。正常情况它们不会失败，一旦失败说明
    // 网络被阻断或平台在做什么，属于该停下来看一眼的软信号。
    // 登记册第 13 条要求覆盖到 Boss端的 vendor.js / app.js。原正则只认路径段 `zhipin-boss/`，
    // 而登记册记的命名是 `boss-vue`——两者对不上时这半条是零覆盖的（审计 2026-07-29）。
    // 两种命名都收，宁可多认一个也不要漏掉整条。
    const SEC_JS = /warlockdata|ka\.v1|boss-login|captcha-sdk|(zhipin-boss|boss-vue)\/.*\/(vendor|app)\.js/i;
    const onSecJsFail = (req: any) => {
      try {
        const u = String(req.url?.() || '');
        if (!/static\.zhipin\.com|zhipin\.com\/.*\.js/i.test(u)) return;
        if (!SEC_JS.test(u)) return;
        this.emit('api-risk-signal', {
          url: u, code: 0,
          message: `安全/风控 JS 加载失败：${u.split('/').pop()}`,
          kind: 'securityJsFail',
        });
      } catch { /* 监控本身不能影响 RPA */ }
    };
    page.on('requestfailed', onSecJsFail);
    page.on('response', (resp) => {
      try {
        const s = resp.status();
        if (s >= 400 && SEC_JS.test(resp.url())) onSecJsFail({ url: () => resp.url() });
      } catch { /* ignore */ }
    });
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        // 只关注 BOSS wapi 业务接口（排除静态资源/埋点上报）
        if (!/\/wapi\/(zpgeek|zprelation|zpchat|zpjob|zpuser|zpsecureflow)/.test(url)) return;
        // 埋点端点不监控
        if (/dapCommon|actionLog|logapi|shink|z\.zhipin/.test(url)) return;
        const status = resp.status();
        // ⚠️ HTTP 层异常必须【先于】content-type 过滤判定。
        // 原实现把 `if (!/json/i.test(ct)) return` 放在前面，而 BOSS 入口层/ALB 的 403/429
        // 往往返回 HTML 拦截页或空 body（没有 json content-type），于是整条被 return 掉——
        // 登记册早停信号清单第 6、7 条（接口 403 / 429）实际从未触发过。
        // （403=停+冷却30min，429=停+冷却15min+降速50%，kind 交给引擎按精密模型分级处置）
        if (status === 403 || status === 429) {
          this.emit('api-risk-signal', { url, code: status, message: `HTTP ${status}`, kind: status === 403 ? 'http403' : 'http429' });
          return;
        }
        // 到这里才是"要解析 body 找业务错误码"的路径，非 JSON 直接跳过
        const ct = resp.headers()['content-type'] || '';
        if (!/json/i.test(ct)) return;
        let body: any = null;
        try { body = await resp.json(); } catch { return; }
        // code:35 = IP异常；code非0且含异常关键词 = 风控
        if (body && typeof body === 'object') {
          const c = body.code;
          const msg = (body.message || '') as string;
          if (c === 35) {
            this.emit('api-risk-signal', { url, code: 35, message: msg || 'IP地址存在异常行为', kind: 'apiCode35' });
          } else if (typeof c === 'number' && c !== 0 &&
              /异常|频繁|风控|拒绝|受限|限制|验证|封禁|block/i.test(msg)) {
            const kind = /登录|重新登录|未登录|token/i.test(msg) ? 'loginLost'
              : /频繁/.test(msg) ? 'http429' : 'apiCode35';
            this.emit('api-risk-signal', { url, code: c, message: msg.slice(0, 200), kind });
          } else if (c === 0 && isRecommendListApi(url) && isEmptyZpData(body.zpData)) {
            // ⚠️ 单次空【绝不能】直接熔断。"今天这个岗位的推荐流看完了"本来就长这样，
            // 一次就判"疑似降权 + 20 分钟退避"，等于每轮正常收尾都被记一笔假降权：
            // 任务莫名空转 20 分钟、自动调度被拒，更糟的是假记录会稀释真信号的可信度
            //（审查 2026-07-29）。改发 emptyDataOnce，由引擎按与 DOM 路径同一口径
            // 累计到连续 3 次才真正当作 emptyData 处置。
            // 登记册「异常空数据」：接口 200 + code 0，但 zpData 是空对象/空数组。
            // 审计 2026-07-29 之前这条【只有 DOM 层代理】（连续 3 屏解析不出人），
            // 而 DOM 为空还可能是渲染慢/帧重建，需要凑够 3 次才敢报，反应迟钝且会误判。
            // 接口层的空 zpData 是平台亲口说"没有数据给你"，比 DOM 直接得多。
            // 仍走 emptyData（circuit，20min 退避），由引擎的连续计数决定要不要收尾——
            // 单次空可能就是自然翻完了，不该一次就熔断。
            this.emit('api-risk-signal', {
              url, code: 0, message: '推荐列表接口返回空数据', kind: 'emptyDataOnce',
            });
          }
        }
      } catch { /* 监控本身不能影响正常RPA */ }
    });
    // Boss端静默安全上报监控：检测 window.Security 模块 POST 到 /wapi/zpApm/actionLog/fe/ie/common.json
    // 该请求带 p2=100xx 表示JS检测到了自动化/异常特征，是最早的"被盯上"信号——比验证码出现更早。
    page.on('request', (req) => {
      try {
        const url = req.url();
        if (!/\/wapi\/zpApm\/actionLog\//.test(url) || req.method() !== 'POST') return;
        const postData = req.postData() || '';
        if (!postData) {
          // puppeteer 在 body 走独立流/超限时 postData() 返回 undefined——此时正则永远匹配不到，
          // 整条「Boss端 100xx 静默上报」监控会无声失效（而这是比验证码更早的信号）。
          // 不静默：抛一个"载荷不可读"事件，由引擎记一次告警，提示需真机核对该端点载荷格式。
          this.emit('boss-security-report-unreadable', { url });
          return;
        }
        // p2:100xx = 环境/自动化检测码(10017/10007/10021/10027…)；p2:51xxx = 来源/referrer异常
        // (51002飞书token来源 / 51003异常referrer / 51004非常态入口)。两类都要捕获。
        // 兼容 JSON / form-urlencoded / URL 编码三种载荷形态。
        let probe = postData;
        try { if (/%7B|%22|%3A/i.test(postData)) probe = decodeURIComponent(postData); } catch { /* 保持原文 */ }
        // ⚠️ device-action-report 这个串是【登记册没有要求的】额外与门条件。
        // 审计 2026-07-29：登记册只要求"p2=100xx 即立即停"，而这里要求两者同时命中。
        // 一旦 BOSS 换了标识（或本来就不带这个串），整条「比验证码更早的信号」就静默失效，
        // 而失效时没有任何人会知道——这是所有信号里唯一无法自证的一条。
        // 改为：p2 命中即上报（登记册口径），device-action-report 降级为附加说明，
        // 让引擎能在日志里区分"标准载荷"与"载荷形态存疑"，而不是整条丢弃。
        const isDeviceReport = /device-action-report/.test(probe);
        const codeMatch = probe.match(/p2["']?\s*[:=]\s*["']?(100\d{2}|51\d{3})/);
        if (codeMatch) {
          this.emit('boss-security-report', {
            url,
            p2: parseInt(codeMatch[1], 10),
            standardPayload: isDeviceReport, // false = 载荷形态与预期不同，值得真机核对一次
            preview: probe.slice(0, 300),
          });
        }
      } catch { /* 监控不影响业务 */ }
    });
  }

  /**
   * 平台化网络层风控监控（由 adapter 注入 RiskNetRules）。
   *
   * 判定顺序是刻意的，三条都踩过坑：
   *  ① classifyHeaders 在【所有响应】上跑，不受 apiUrl 过滤 —— 阿里云 WAF 的
   *     acw_sc__v2/v3 挑战 cookie 可能挂在任何一个响应上（含静态资源、文档），
   *     只盯业务接口会漏掉这条"最早的入口层信号"。
   *  ② HTTP 403/429 在【apiUrl 过滤之前】判 —— 原实现把 `if (!apiUrl.test(url)) return`
   *     放在 status 判定前面，于是 lpt.liepin.com/search、/cvview/... 这类【主文档】
   *     返回 403/429 时整条被 return 掉。403 尚有 WAF cookie 兜底，429 完全没有兜底。
   *  ③ 只有 body 解析才需要 apiUrl 过滤（要解 JSON，非业务接口解了也没意义）。
   */
  private attachPlatformRiskMonitor(page: Page, R: RiskNetRules) {
    const mine = (url: string) => !this.riskHostPattern || this.riskHostPattern.test(url);

    page.on('response', async (resp) => {
      try {
        const url = resp.url();

        // ① 响应头信号：不做 apiUrl 过滤，但排除埋点/静态资源以免噪声
        if (R.classifyHeaders && !R.excludeUrl.test(url)) {
          const hit = R.classifyHeaders(resp.headers() as Record<string, string>, url);
          if (hit) {
            this.emit('api-risk-signal', { url, code: hit.code, message: hit.message, kind: hit.kind });
            return;
          }
        }

        // ② HTTP 层：本平台域名下的【任何】响应，含 document
        const status = resp.status();
        if ((status === 403 || status === 429) && mine(url)) {
          this.emit('api-risk-signal', {
            url, code: status, message: `HTTP ${status}`,
            kind: status === 403 ? 'http403' : 'http429',
          });
          return;
        }

        // ③ 业务响应体：这一步才需要 apiUrl 过滤
        if (!R.classifyBody) return;
        if (!R.apiUrl.test(url) || R.excludeUrl.test(url)) return;
        const ct = resp.headers()['content-type'] || '';
        if (!/json/i.test(ct)) return;
        let body: any = null;
        try { body = await resp.json(); } catch { return; }
        const hit = R.classifyBody(body, url);
        if (hit) this.emit('api-risk-signal', { url, code: hit.code, message: hit.message, kind: hit.kind });
      } catch { /* 监控本身绝不能影响 RPA */ }
    });

    // 静默安全上报（猎聘 = security.min.js 的 standardFLog）：比验证码更早的信号。
    // 载荷不可读时必须发 unreadable 事件，绝不静默失效 —— 这是所有信号里唯一无法自证的一条。
    if (R.secReportUrl && R.parseSecReport) {
      page.on('request', async (req) => {
        try {
          const url = req.url();
          if (!R.secReportUrl!.test(url)) return;
          // ★ 2026-08-12 真机：猎聘的 security.min.js 走 sendBeacon(Blob) 上报，
          //   puppeteer 的 postData() 对这类载荷恒返回 undefined —— 每一轮都报
          //   「安全上报载荷不可读」，等于【比验证码更早的那条信号从来没生效过】，
          //   而它恰恰是所有风控信号里唯一无法自证的一条（不可读时你不知道自己瞎了）。
          //   fetchPostData() 走 CDP Network.getRequestPostData 主动取，能拿到流式/Blob 载荷。
          //   仍拿不到才发 unreadable，保持"绝不静默失效"的原则。
          let raw = req.postData() || '';
          if (!raw) raw = (await req.fetchPostData().catch(() => '')) || '';
          // ★ 2026-08-13 真机第二轮：加了 fetchPostData 仍报"不可读"——因为猎聘的
          //   statistic.liepin.com/.../standardFLog 是【埋点 GET/beacon，载荷在 URL query 里】，
          //   本来就没有 POST body。此前把"没有 body"一律当成"读不到"，于是这条
          //   「比验证码更早」的信号每轮必报失效，而它其实一直是可读的——只是找错了地方。
          //   处置：无 body 时改用 URL（含 query）作为探测串；URL 里也无从解析才算真不可读。
          //   parseSecReport(probe, url) 本就接收 url 作第二参，适配器侧无需改。
          if (!raw && /[?&]/.test(url)) {
            try { raw = decodeURIComponent(url); } catch { raw = url; }
          }
          // ★ 2026-08-19 P2-a（安全信标原始抓取）：无论可不可读，先把这次上报请求的
          //   原始 URL/方法/请求头/请求体落盘到 logs/<platform>-security-beacon-<ts>.json。
          //   载荷不可读时除现有 unreadable 告警外，多落这份原始抓取——有真机数据后再谈解析。
          //   纯被动落盘：不发请求、不碰配额、不改请求。写盘失败只 catch。
          try { dumpSecurityBeacon(this.platform, url, req.method(), req.headers(), raw, raw ? 'raw-collected' : 'unreadable'); } catch { /* ignore */ }
          if (!raw) { this.emit('security-report-unreadable', { url }); return; }
          let probe = raw;
          try { if (/%7B|%22|%3A/i.test(raw)) probe = decodeURIComponent(raw); } catch { /* 保持原文 */ }
          const hit = R.parseSecReport!(probe, url);
          if (hit) this.emit('security-report', { url, code: hit.code, desc: hit.desc, preview: probe.slice(0, 300) });
        } catch { /* 监控不影响业务 */ }
      });
    }
  }

  private async handleTarget(target: Target) {
    if (target.type() !== 'page') return;
    const page = await target.page().catch(() => null);
    if (!page) return;
    this.adoptPage(page);
  }

  /**
   * 对一个页面完成平台侧接管：风控监控 + 导航清理 + （闸门允许时）binding/工具注入。
   * 两类来源都必须走到这里：
   *  - targetcreated（连接【之后】新开的页）——原 handleTarget 的路径；
   *  - 连接【之时】已存在的页——此前只补挂风控监控、从不补注入，于是
   *    「先开页、后连接」的顺序下（工具库「打开并使用」的冷启动就是这个顺序）
   *    工具永远不会出现，界面却提示"会自动出现"。
   * adoptedPages 保证幂等：同一连接内两条来源撞上同一页也只接管一次。
   */
  private adoptPage(page: Page) {
    if (this.adoptedPages.has(page)) return;
    this.adoptedPages.add(page);

    // R2-2026-07-24: 对所有自动创建的page也挂风控响应监控
    this.attachRiskResponseMonitor(page);

    // 主帧导航 → 隔离世界上下文 id 立即作废。不主动清的话，后续求值会拿着旧 id
    // 报 "Cannot find context with specified id"，只能靠失败重试兜（见 evaluateInIsolatedWorld）。
    page.on('framenavigated', (frame: any) => {
      try { if (frame === page.mainFrame()) isolatedWorldCtx.delete(page); } catch { /* ignore */ }
    });
    page.on('domcontentloaded', () => {
      this.injectForPage(page).catch((e) => console.error('[cdp] inject error', e));
    });
    // ⚠️ puppeteer 会在【页面并没有真的关闭】时也发 close（tab target 交换/目标重挂等），
    // 2026-07-30 实测坐实：close 触发时 page.isClosed() 仍为 false，而这段拆除逻辑里的
    // removeAllListeners('domcontentloaded') 会把"导航后自动重注入"的监听器一并摘掉。
    // 后果是飞书工具页只要跳转/刷新一次，工具就再也回不来——用户必须回平台重点一次
    // 「打开并使用」，而日志里什么都看不到。
    // 又因为 puppeteer 是【emit 之后】才置 #closed，处理器内读 isClosed() 恒为 false，
    // 无法就地区分真假，必须延后一拍再判：真关了才拆，假信号一概不动。
    const onClose = () => {
      setTimeout(() => {
        if (!page.isClosed()) return; // 假信号：监听器与常驻会话全部保留，等真正的 close
        page.off('close', onClose);
        page.removeAllListeners('domcontentloaded');
        page.removeAllListeners('response');
        page.removeAllListeners('request');
        page.removeAllListeners('requestfailed'); // 安全 JS 加载失败监听，别漏掉
        page.removeAllListeners('framenavigated');
        isolatedWorldCtx.delete(page);
        this.monitoredPages.delete(page);         // 允许同一页对象被回收，也避免幂等标记误挡重挂
        this.adoptedPages.delete(page);
        // G2: 断开该页的常驻 binding 会话
        const s = this.bindingSessions.get(page);
        if (s) {
          this.bindingSessions.delete(page);
          s.detach().catch(() => {});
        }
        // 同上：常驻的新文档注入会话与其句柄表一并回收
        this.dropNewDocSession(page);
      }, 0);
    };
    page.on('close', onClose);
    // 注入开关关闭时（登录/空闲）完全不注册 binding、不注入——保持对页面零打扰
    if (this.injectionActive || !isAntiDetectHost(page.url())) {
      this.setupToolBinding(page).catch((e) => console.warn('[cdp] tool binding failed', e));
      this.injectForPage(page).catch((e) => console.error('[cdp] initial inject error', e));
    }
  }

  /**
   * G2: 在隔离世界注册 __taPushJobs binding，供工具（如飞书 JR 快照）把抓到的岗位
   * 推送回应用。安全边界：
   *  - executionContextName 限定为 ISOLATED_WORLD_NAME，页面主世界拿不到该函数；
   *  - 载荷限长 512KB，JSON 解析失败/超限直接丢弃；
   *  - 只透传给主进程事件 'jr-push'，由 IPC 层做字段白名单与入库去重。
   */
  private async setupToolBinding(page: Page) {
    if (this.bindingSessions.has(page)) return;
    const client = await page.target().createCDPSession();
    this.bindingSessions.set(page, client);
    try {
      await client.send('Runtime.enable');
      await client.send('Runtime.addBinding', {
        name: TOOL_PUSH_BINDING,
        executionContextName: ISOLATED_WORLD_NAME,
      } as any);
      client.on('Runtime.bindingCalled', (ev: { name: string; payload: string }) => {
        if (ev.name !== TOOL_PUSH_BINDING) return;
        if (typeof ev.payload !== 'string' || ev.payload.length > 512 * 1024) return;
        try {
          const data = JSON.parse(ev.payload);
          if (data && typeof data === 'object' && Array.isArray(data.items)) {
            this.emit('jr-push', {
              source: typeof data.source === 'string' ? data.source.slice(0, 64) : 'unknown',
              items: data.items.slice(0, 500),
              url: page.url(),
            });
          }
        } catch {
          /* 非法载荷丢弃 */
        }
      });
    } catch (e) {
      this.bindingSessions.delete(page);
      client.detach().catch(() => {});
      throw e;
    }
  }

  /**
   * 为页面主 frame 创建/获取隔离世界的 execution context。
   * 通过 CDP Page.createIsolatedWorld 创建名为 __ta_tools__ 的隔离世界，
   * 保证工具脚本与页面主世界 JS 上下文完全分离。
   */
  private async getIsolatedContextId(page: Page): Promise<number> {
    const cached = isolatedWorldCtx.get(page);
    if (cached) return cached;

    const client = await page.target().createCDPSession();
    try {
      // 通过 CDP 获取主 frame 的 frameId（page.mainFrame()._id 是私有字段，通过 Page.getFrameTree 拿）
      const frameTree = (await client.send('Page.getFrameTree') as any);
      const frameId: string = frameTree.frameTree.frame.id;

      const result = (await client.send('Page.createIsolatedWorld', {
        frameId,
        worldName: ISOLATED_WORLD_NAME,
        grantUniveralAccess: false, // CDP 里字段名就是拼写错的 grantUniveralAccess
      })) as any;
      const ctxId: number | undefined = result.executionContextId;
      if (typeof ctxId === 'number') {
        isolatedWorldCtx.set(page, ctxId);
        return ctxId;
      }
    } catch (e) {
      console.warn('[cdp] createIsolatedWorld failed, falling back to utility realm', e);
    } finally {
      client.detach().catch(() => {});
    }
    // fallback: 用 frame.isolatedRealm() 拿 puppeteer 工具世界（返回 0 表示 evaluate 用 realm 路径）
    try {
      await (page.mainFrame() as any).isolatedRealm();
      // isolatedRealm 没有直接暴露 executionContextId，返回特殊标记 -1 让 evaluateInIsolatedWorld 走 realm
      isolatedWorldCtx.set(page, -1);
      return -1;
    } catch {
      return 0;
    }
  }

  /**
   * 在隔离世界执行 JS 代码。优先用 CDP Runtime.evaluate（保证隔离世界），
   * ctxId=-1 走 frame.isolatedRealm().evaluate，ctxId=0 兜底走 page.evaluate（主世界）。
   */
  private async evaluateInIsolatedWorld(page: Page, expression: string): Promise<any> {
    const ctxId = await this.getIsolatedContextId(page).catch(() => 0);
    if (ctxId > 0) {
      let client: CDPSession | null = null;
      try {
        client = await page.target().createCDPSession();
        const result = (await client.send('Runtime.evaluate', {
          expression,
          contextId: ctxId,
          returnByValue: true,
          awaitPromise: false,
        })) as any;
        if (result.exceptionDetails) {
          console.error('[cdp] isolated world eval error:', result.exceptionDetails.text || result.exceptionDetails);
          return undefined;
        }
        return result.result?.value;
      } catch (e) {
        // ⚠️ 上下文 id 会随【整页导航】失效（"Cannot find context with specified id"）。
        // 原实现既不清缓存也不重试，于是任何整页跳转之后，这个 Page 上的隔离世界求值
        // 会永久失效——工具停止钩子调不到、立即重注入也进不去，而调用方大多 .catch(()=>{})
        // 把失败吞掉，表现就是"重注入照常进行、旧实例没被停掉"，实例叠加的原 bug 复现。
        // 这里：清掉缓存重取一次上下文再试，仍失败才放弃。
        console.warn('[cdp] isolated world eval failed, retrying with fresh context', e);
        isolatedWorldCtx.delete(page);
        try {
          const fresh = await this.getIsolatedContextId(page).catch(() => 0);
          if (fresh > 0) {
            const c2 = await page.target().createCDPSession();
            try {
              const r2 = (await c2.send('Runtime.evaluate', {
                expression, contextId: fresh, returnByValue: true, awaitPromise: false,
              })) as any;
              if (!r2.exceptionDetails) return r2.result?.value;
            } finally { c2.detach().catch(() => {}); }
          }
        } catch { /* 重试仍失败则走下面的兜底 */ }
      } finally {
        if (client) client.detach().catch(() => {});
      }
    } else if (ctxId === -1) {
      // puppeteer isolatedRealm 路径
      try {
        const frame = page.mainFrame() as any;
        const realm = await frame.isolatedRealm();
        return await realm.evaluate(expression);
      } catch (e) {
        console.warn('[cdp] isolatedRealm.evaluate failed, falling back', e);
      }
    }
    // H3-3 修复：隔离世界不可用时【拒绝在主世界执行工具代码】（绝不降级），告警并放弃注入
    console.error('[cdp][security] 隔离世界不可用，已拒绝注入（不回退主世界）:', page.url());
    this.emit('inject-blocked', { url: page.url(), reason: 'isolated-world-unavailable' });
    return undefined;
  }

  // H10/H5：向指定页面推送活跃 JD（在隔离世界写入 window.__TA_ACTIVE_JD__ 并 dispatch message）
  async pushActiveJd(page: Page, jd: any | null) {
    try {
      const src = `(function(jd){
        window.__TA_ACTIVE_JD__ = jd;
        if (window.dispatchEvent) {
          var ev = new MessageEvent('message', { data: {__ta:1, action:'push-active-jd', jd:jd} });
          window.dispatchEvent(ev);
        }
      })(${jd ? JSON.stringify(jd) : 'null'})`;
      await this.evaluateInIsolatedWorld(page, src).catch(() => {});
    } catch {}
  }

  // 从 DB 读当前活跃 JD（供 injectForPage 每次注入时下发；失败返回 null 不阻断）
  private readActiveJdSafe(): any | null {
    try {
      const row = getDb().prepare('SELECT data FROM jds WHERE active = 1 LIMIT 1').get() as any;
      return row ? JSON.parse(row.data) : null;
    } catch {
      return null;
    }
  }

  // 向所有页面推送活跃 JD（JD 切换时调用）
  async pushActiveJdToAllPages(jd: any | null) {
    if (!this.isConnected()) return;
    const pages = await this.pages();
    for (const p of pages) {
      await this.pushActiveJd(p, jd);
    }
  }

  // 对当前 URL 注入匹配的工具脚本
  setInjectionActive(on: boolean) { this.injectionActive = on; }

  async injectForPage(page: Page, onlyToolId?: string) {
    const url = page.url();
    // 注入总开关关闭时，完全不碰招聘平台页面（登录期间的关键反检测保护）。
    // 修复：该开关默认 false 且全项目从无调用方 → 工具库脚本永远注入不进任何页面。
    // 反检测针对的是 BOSS/猎聘/智联这类会检测自动化的招聘站；飞书招聘是内部办公系统，
    // 与 BOSS 检测无关，故非反检测域名不受总开关约束，否则「工具库」整体失效。
    if (!this.injectionActive && isAntiDetectHost(url)) return;

    // ⚠️ 没有任何【已启用工具】匹配这个页面 → 一个字节都不注入，直接返回。
    //
    // 原实现是无条件先注入 ~90KB 评分引擎 + 活跃 JD + 注册回传 binding，之后才去看有没有工具，
    // 于是调试浏览器里【每一个】打开的页面（新标签页、随手查资料的网页…）都被注入一遍，
    // 还各自建了常驻 CDP binding 会话。三重代价：
    //   · 无谓地在与本工具毫不相干的站点上留下痕迹，与"最小必要"直接冲突；
    //   · 每个页面都多几次 CDP 往返，正是新文档注入偶发失败被放大的来源；
    //   · 失败时还会弹窗打扰用户（2026-07-29 用户实际遇到的就是这个）。
    // 现在把工具匹配提到最前面当闸门：只服务真正要用工具的那些页面。
    const scripts = toolManager.getActiveScriptsForUrl(url);
    if (!scripts.length) return;

    // onlyToolId：单工具重注入（见 reinjectTool）。给定时只处理它，其余工具不受触碰。
    const targeted = onlyToolId ? scripts.filter((s) => s.toolId === onlyToolId) : scripts;
    if (!targeted.length) return;

    // 先取齐经哈希复验的脚本，再决定要不要注入通用依赖（下面按真实需要下发）
    const verified: { toolId: string; permissions: any; config: any; code: string }[] = [];
    for (const s of targeted) {
      // M-12 修复：注入前经 manager 复验脚本哈希（防 TOCTOU：加载后文件被替换）
      const code = toolManager.readVerifiedScript(s.toolId);
      if (code == null) {
        console.warn('[cdp][security] 工具脚本哈希校验失败或缺失，跳过注入:', s.toolId);
        continue;
      }
      verified.push({ toolId: s.toolId, permissions: s.permissions, config: s.config, code });
    }
    if (!verified.length) return;

    // G2: 确保回传 binding 已注册（幂等；覆盖连接前已存在的页面）
    this.setupToolBinding(page).catch(() => {});

    // 1) 通用依赖【按需】下发（四线隔离 2026-07-29）：
    // 原来无条件往工具页注入 ~90KB 评分引擎 + 主线的完整活跃 JD。而现存两个飞书工具
    // 都不引用 __TA_SCORE__/__TA_ACTIVE_JD__（BOSS 评分早已改由浏览器扩展承担）——
    // 等于把 RPA 线的岗位数据白送进飞书页的隔离世界，还多 90KB 注入面。
    // 现在按脚本是否真的引用来决定，未来有工具需要时自动恢复下发，无需改这里。
    const needsScoring = verified.some((v) => v.code.includes('__TA_SCORE__'));
    const needsActiveJd = verified.some((v) => v.code.includes('__TA_ACTIVE_JD__'));

    if (needsScoring) {
      const scoringSrc = loadUniversalScoring();
      if (scoringSrc) {
        const scoringBootstrap = `(function(){
          if (window.__TA_SCORE__) return;
          ${scoringSrc}
        })();`;
        // 对新文档也注入——用 CDP Page.addScriptToEvaluateOnNewDocument + worldName
        this.evaluateOnNewDocumentInWorld(page, scoringBootstrap, '__scoring__').catch(() => {});
        // 已加载页面立即注入。⚠️ 必须 await：工具脚本紧接着就要读 __TA_SCORE__，
        // 原来这里是 fire-and-forget，工具有机会跑在引擎就位之前，拿到 undefined 就按"没有引擎"降级。
        await this.evaluateInIsolatedWorld(page, scoringBootstrap).catch(() => {});
      }
    }

    // 修复：活跃 JD 原先只在 JD 切换时推送，smartConnect/新文档/翻页后丢失 → 工具拿不到 JD 不出分。
    // 这里随评分引擎一并注入（immediate + 新文档），保证只要注入开启，页面始终持有最新活跃 JD。
    // 注：注入总开关默认关（反检测：不往 BOSS 页注入脚本），故 BOSS 端在职评分徽章默认不生效——
    // RPA 找人用引擎内部评分(scoreCandidate)出分，不依赖此注入。
    if (needsActiveJd) {
      try {
        const jd = this.readActiveJdSafe();
        const jdSrc = `window.__TA_ACTIVE_JD__ = ${jd ? JSON.stringify(jd) : 'null'};`;
        this.evaluateOnNewDocumentInWorld(page, jdSrc, '__activeJd__').catch(() => {});
        await this.evaluateInIsolatedWorld(page, jdSrc).catch(() => {}); // 同上：工具读 JD 之前必须已就位
      } catch { /* JD 读取失败不阻断注入 */ }
    }

    // S6: 行为采样（"模仿本人"学习）——仅 BOSS 页、开关开启时注入
    if (this.behaviorSampling && /zhipin\.com/i.test(url)) {
      const samp = this.samplerScript(true);
      this.evaluateOnNewDocumentInWorld(page, samp).catch(() => {});
      this.evaluateInIsolatedWorld(page, samp).catch(() => {});
    }

    for (const s of verified) {
      try {
        // C2 安全：沙箱 wrapper（在隔离世界中进一步限制 API）
        const wrapped = buildSandboxedWrapper(s.toolId, s.permissions, s.code, s.config);

        // 新文档自动执行（按 toolId 作 key：重注入时先移除该工具的旧注册，
        // 否则旧配置那份永远排在前面先跑，改配置后刷新页面看不到变化）
        this.evaluateOnNewDocumentInWorld(page, wrapped, `tool:${s.toolId}`).catch(() => {});

        // 已加载页面立即在隔离世界执行
        this.evaluateInIsolatedWorld(page, wrapped).catch(() => {});
      } catch (e) {
        console.error('[cdp] inject script error', s.toolId, e);
      }
    }
  }

  /**
   * M-14/M-15：工具启用/禁用/配置变更后，对所有已打开页面即时重注入。
   * 清除各页隔离世界的去重标记后重新 injectForPage（其内部只注入 enabled 工具，
   * 故被禁用的工具不会再注入）。局限：已执行脚本的既有 DOM 副作用无法完全回收，
   * 这里保证的是"停止再运行 + 以最新启用集/配置重注入"；新打开的页面天然生效。
   */
  async reinjectAllTools(): Promise<void> {
    return this.reinjectTools(undefined);
  }

  /**
   * 单工具重注入（四线隔离 2026-07-29）。
   *
   * 为什么必须有：原来只有"全停全起"一种粒度——改工具 A 的一个配置项，会把同一页上
   * 工具 B 的实例一起停掉再拉起，B 的面板与内存态（正在填的草稿、抓一半的列表）全丢。
   * 两个飞书工具的 matches 在 /hire/job* 上完全重叠，必然同页共存，所以这不是理论问题。
   * 现在按 toolId 只停它自己、只重注它自己，B 全程无感。
   */
  async reinjectTool(toolId: string): Promise<void> {
    return this.reinjectTools(toolId);
  }

  private async reinjectTools(onlyToolId?: string): Promise<void> {
    if (!this.isConnected()) return;
    const pages = await this.pages();
    for (const page of pages) {
      try {
        // 反检测不变量：注入总开关关闭时，完全不碰招聘平台页面（登录/空闲期的关键保护）。
        // 停止片段同样是一次隔离世界求值，必须服从同一条守卫，否则等于在登录期
        // 对 BOSS 页建隔离世界 + evaluate，把 injectForPage 那条约束绕过去了。
        if (!this.injectionActive && isAntiDetectHost(page.url())) continue;
        // ⚠️ 重注入前必须先把【旧实例】停掉，只删去重标记是不够的。
        // 删掉标记后工具 IIFE 会在同一个隔离世界里再跑一遍，而旧实例的 setInterval /
        // popstate 监听 / 面板都还在，没有任何人回收：每次"启用/禁用/保存配置"叠一层，
        // 而且 tools:set-enabled(false) 之后旧实例继续跑、还会把被移除的面板补回来——
        // 表现就是【工具关不掉】。
        const stopSrc = onlyToolId
          ? `try{
               var id = ${JSON.stringify(onlyToolId)};
               var S = window.__TA_TOOL_STOP__;
               if (S && typeof S[id] === 'function') { try { S[id](); } catch(e){} }
               if (S) { try { delete S[id]; } catch(e){} }
             }catch(e){}
             try{ if (window.__TA_TOOL_RAN__) delete window.__TA_TOOL_RAN__[${JSON.stringify(onlyToolId)}]; }catch(e){}`
          : `try{
               var S = window.__TA_TOOL_STOP__;
               if (S) { for (var k in S) { try { typeof S[k] === 'function' && S[k](); } catch(e){} } }
               window.__TA_TOOL_STOP__ = {};
             }catch(e){}
             try{ if (window.__TA_TOOL_RAN__) delete window.__TA_TOOL_RAN__; }catch(e){}`;
        await this.evaluateInIsolatedWorld(page, stopSrc).catch(() => {});
        // 停掉的同时必须撤掉它的新文档注册，否则"关掉的工具"在页面刷新后会自己回来
        // （注册还在，新文档照跑）。injectForPage 只对仍启用的工具重新注册。
        await this.removeNewDocScripts(page, onlyToolId);
        await this.injectForPage(page, onlyToolId);
      } catch (e) {
        console.warn('[cdp] reinject page failed', onlyToolId || '(all)', e);
      }
    }
  }

  /**
   * 注册一个在每次新文档加载时自动在隔离世界执行的脚本。
   * 通过 CDP Page.addScriptToEvaluateOnNewDocument 指定 worldName。
   */
  private async evaluateOnNewDocumentInWorld(page: Page, scriptSource: string, key?: string) {
    // ⚠️ 实测记录（2026-07-30，Chrome for Testing 对照实验，基准组 puppeteer.evaluateOnNewDocument 自证可信）：
    //   隔离世界 + 无 Page.enable + 注册后立刻 detach（本函数的原实现）→ 新文档执行 0 次
    //   隔离世界 + 有 Page.enable + 会话常驻                          → 新文档执行 1 次 ✓
    // 也就是说原实现【从未生效过】：注释写着"新文档自动执行"，实际一次都没跑。
    // 症状是飞书工具在整页刷新/跳转后不会自己回来，用户必须回平台再点一次「打开并使用」，
    // 而日志里什么都看不到（注册调用本身是成功返回的）。
    // 两个必要条件缺一不可：① 会话先 Page.enable ② 会话常驻不 detach。
    try {
      const tid = await this.getTargetId(page);
      const client = await this.getNewDocSession(page, tid);
      // 重注入前先移除同 key 的旧注册：否则旧配置的脚本一直排在前面先跑，
      // 靠 __TA_TOOL_RAN__ 去重把新配置的那份挡掉——表现是"改了配置刷新后没变化"。
      if (key) {
        const map = this.newDocScripts.get(tid);
        const old = map?.get(key);
        if (old) {
          await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: old } as any).catch(() => {});
          map!.delete(key);
        }
      }
      const res = (await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: scriptSource,
        worldName: ISOLATED_WORLD_NAME,
      })) as any;
      if (key && res?.identifier) {
        let map = this.newDocScripts.get(tid);
        if (!map) { map = new Map(); this.newDocScripts.set(tid, map); }
        map.set(key, res.identifier);
      }
    } catch (e) {
      // H3-3：隔离世界失败【绝不回退主世界】，这条不变。
      //
      // ⚠️ 但"失败"分两种，2026-07-29 之前混为一谈，导致把良性竞态报成了安全事件：
      //   · 良性：标签页正好在关闭/导航/崩溃，CDP 会话跟着断。这是并发下的常态——
      //     domcontentloaded 触发注入的同一瞬间用户关掉了这个页，就会命中。
      //     它不代表隔离世界不可用，也不影响【当前已加载页】的注入
      //     （那条走 evaluateInIsolatedWorld，是另一条独立路径）。
      //   · 真问题：浏览器确实建不出隔离世界 → 工具从此不会在新文档上自动出现。
      // 只有后者值得打扰用户。前者连日志都用 debug 级别，免得把控制台刷满。
      const msg = String((e as any)?.message || e);
      const benign = /Target closed|Session closed|Target crashed|detached|Protocol error \(Page\.addScriptToEvaluateOnNewDocument\): Target closed|Connection closed/i.test(msg);
      if (benign) {
        console.debug('[cdp] 新文档注入被跳过（标签页正在关闭/导航，属正常竞态）:', msg);
      } else {
        console.error('[cdp][security] addScriptToEvaluateOnNewDocument 失败，已拒绝主世界回退', e);
        this.emit('inject-blocked', {
          url: (() => { try { return page.url(); } catch { return ''; } })(),
          reason: 'new-document-isolated-world-failed',
          detail: msg,
        });
      }
      // 会话可能已随页面死亡而失效，弃掉缓存让下次重建（不在这里 detach：会话是常驻的）
      this.dropNewDocSession(page);
    }
  }

  /**
   * 取该页的【常驻】新文档注入会话（必要时创建并 Page.enable）。
   * 常驻是硬性要求，不是优化：detach 会连带清掉这条会话注册过的所有新文档脚本。
   */
  private async getNewDocSession(page: Page, targetId: string): Promise<CDPSession> {
    const existing = this.newDocSessions.get(targetId);
    if (existing) return existing;
    const client = await page.target().createCDPSession();
    try {
      await client.send('Page.enable'); // 缺这一步注册静默失效（实测）
    } catch (e) {
      client.detach().catch(() => {});
      throw e;
    }
    this.newDocSessions.set(targetId, client);
    return client;
  }

  /**
   * 取该页所属标签页的稳定标识。用它当键，才不会被"同一标签页多个 Page 对象"坑到。
   * 只在第一次为某个 Page 对象付一次 CDP 往返，之后走缓存。
   */
  private async getTargetId(page: Page): Promise<string> {
    const cached = this.targetIdCache.get(page);
    if (cached) return cached;
    const c = await page.target().createCDPSession();
    try {
      const info = (await c.send('Target.getTargetInfo')) as any;
      const tid = String(info?.targetInfo?.targetId || '');
      if (!tid) throw new Error('拿不到 targetId');
      this.targetIdCache.set(page, tid);
      return tid;
    } finally {
      c.detach().catch(() => {});
    }
  }

  /**
   * 撤销该页已注册的新文档脚本。给 toolId 只撤这一个工具的；不给则撤全部工具的
   * （通用依赖 __scoring__/__activeJd__ 不撤：它们幂等且被下一次注入按需覆盖）。
   */
  private async removeNewDocScripts(page: Page, onlyToolId?: string) {
    const tid = await this.getTargetId(page).catch(() => '');
    if (!tid) return;
    const map = this.newDocScripts.get(tid);
    if (!map || !map.size) return;
    const client = this.newDocSessions.get(tid);
    if (!client) return;
    const keys = onlyToolId
      ? [`tool:${onlyToolId}`]
      : [...map.keys()].filter((k) => k.startsWith('tool:'));
    for (const k of keys) {
      const id = map.get(k);
      if (!id) continue;
      await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id } as any).catch(() => {});
      map.delete(k);
    }
  }

  /** 丢弃该页的常驻新文档会话与句柄表（页面关闭/会话失效时调用）。 */
  private dropNewDocSession(page: Page) {
    const tid = this.targetIdCache.get(page);
    if (!tid) return;
    const s = this.newDocSessions.get(tid);
    if (s) {
      this.newDocSessions.delete(tid);
      s.detach().catch(() => {});
    }
    this.newDocScripts.delete(tid);
  }

  // ============ S6: 行为采样（"模仿本人"学习） ============
  // 采样脚本（我方可信代码，直接在隔离世界运行）：监听用户手动点击/滚动，记录相邻间隔，
  // 批量写入共享 DOM 的 data-ta-samples 属性；主进程按需读取+清空。开关关闭时不记录。
  private samplerScript(on: boolean): string {
    return `(function(){
      var W = window;
      if (W.__TA_SAMPLER__) {
        W.__TA_SAMPLER__.on = ${on};
        if (!${on}) { try { document.documentElement.removeAttribute('data-ta-samples'); } catch(e){} }
        return;
      }
      if (!${on}) return;
      var S = W.__TA_SAMPLER__ = { on: true, buf: [], lastClick: 0, lastScrollTs: 0, lastNav: Date.now(), lastHref: location.href };
      function flush(){ try { document.documentElement.setAttribute('data-ta-samples', JSON.stringify(S.buf)); } catch(e){} }
      function push(kind, dt){ if (dt > 300 && dt < 180000) { S.buf.push([kind, Math.round(dt)]); if (S.buf.length > 300) S.buf.shift(); flush(); } }
      document.addEventListener('click', function(){ if(!S.on) return; var now=Date.now(); if(S.lastClick) push('click', now - S.lastClick); S.lastClick=now; }, true);
      document.addEventListener('scroll', function(){ if(!S.on) return; var now=Date.now(); if(S.lastScrollTs && now - S.lastScrollTs > 250) push('scroll', now - S.lastScrollTs); S.lastScrollTs=now; }, true);
      // P2-2: 独立采样"页面停留"——SPA 路由变化时，记录在上一页(候选人详情/列表)的停留时长
      S.navTimer = setInterval(function(){ if(!S.on) return; try { if (location.href !== S.lastHref) { var now=Date.now(); if(S.lastNav) push('dwell', now - S.lastNav); S.lastNav=now; S.lastHref=location.href; } } catch(e){} }, 1000);
    })();`;
  }

  // 开关采样：对所有 BOSS 页即时生效 + 注册到新文档
  async setBehaviorSampling(on: boolean): Promise<void> {
    this.behaviorSampling = on;
    if (!this.isConnected()) return;
    const pages = await this.pages();
    for (const page of pages) {
      try {
        if (!/zhipin\.com/i.test(page.url())) continue;
        const s = this.samplerScript(on);
        await this.evaluateInIsolatedWorld(page, s).catch(() => {});
        await this.evaluateOnNewDocumentInWorld(page, s).catch(() => {});
      } catch {}
    }
  }

  // 采集并清空各 BOSS 页缓冲的样本：返回 [kind, dtMs] 列表
  async collectBehaviorSamples(): Promise<Array<[string, number]>> {
    if (!this.isConnected()) return [];
    const out: Array<[string, number]> = [];
    const pages = await this.pages();
    for (const page of pages) {
      try {
        if (!/zhipin\.com/i.test(page.url())) continue;
        const raw = await this.evaluateInIsolatedWorld(
          page,
          '(function(){try{var a=document.documentElement.getAttribute("data-ta-samples");document.documentElement.setAttribute("data-ta-samples","[]");if(window.__TA_SAMPLER__)window.__TA_SAMPLER__.buf=[];return a;}catch(e){return null;}})()',
        );
        if (raw && typeof raw === 'string') {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            for (const s of arr) if (Array.isArray(s) && s.length === 2) out.push([String(s[0]), Number(s[1])]);
          }
        }
      } catch {}
    }
    return out;
  }

  // 获取所有打开的页面
  async pages(): Promise<Page[]> {
    if (!this.browser) return [];
    try {
      return await this.browser.pages();
    } catch {
      return [];
    }
  }
}

/**
 * 构造沙箱化包装器：
 * - 代码运行在隔离世界（CDP createIsolatedWorld），JS 上下文与页面主世界完全分离，
 *   DOM 共享但 JS 全局对象各自独立。
 * - 在这里再做一层 defense-in-depth：遮蔽 globalThis/self/top/parent/Function/WebSocket/eval
 *   等全局对象，防止脚本通过各种途径逃逸到真实网络 API。
 * - 通过受控 proxy 对象暴露白名单能力（权限声明决定）。
 */
function buildSandboxedWrapper(
  toolId: string,
  permissions: string[],
  code: string,
  config: Record<string, any>,
): string {
  const perm = new Set(permissions);
  const allowFetch = perm.has('xhr-same-origin');
  const allowStorage = perm.has('local-storage');
  const allowWrite = perm.has('dom-write');
  const allowClipboard = perm.has('clipboard');

  // H-3 沙箱修复：var 声明会被 JS 提升到 IIFE 顶部，所以在 IIFE 内部任何 var 遮蔽的名字
  // 在整个函数作用域都无法访问真实全局。解决方案：两层 IIFE——外层不用严格模式，
  // (function(){return this;})() 能拿到全局对象，作为参数传给内层严格 IIFE。
  return `
(function (__g) {
  'use strict';
  if (!__g || !__g.document) return; // 无法获取全局对象时放弃注入（安全兜底）
  var __realWindow = __g;
  var __realDocument = __g.document;
  // ⚠️ 必须是【实时 getter】而非入口快照。
  // 原实现把 __g.location.* 拍平成 string 常量，safeLocation 的 getter 读的是这份快照，
  // 于是工具代码里的 location.href / location.pathname 永远停留在"首次注入那一刻"。
  // 后果：飞书与 BOSS 都是 SPA，history.pushState 路由切换后
  //   - watchRoute 的 "location.href !== lastUrl" 恒为 false → 面板/徽章永不刷新
  //   - getPageMode()/路径守卫按旧路径判定 → 切到目标页后工具直接不工作
  // 整页导航会重新执行本 wrapper（快照才刷新），所以问题只在 SPA 内部路由，而这正是主用法。
  var __realLocation_ = {
    get href() { return __g.location.href; },
    get origin() { return __g.location.origin; },
    get protocol() { return __g.location.protocol; },
    get hostname() { return __g.location.hostname; },
    get pathname() { return __g.location.pathname; },
    get search() { return __g.location.search; },
    get hash() { return __g.location.hash; },
  };
  var __realNavigator = __g.navigator;
  var __realConsole = {
    log: __g.console.log.bind(__g.console),
    error: __g.console.error.bind(__g.console),
    warn: __g.console.warn.bind(__g.console),
  };
  var __realSetTimeout = __g.setTimeout.bind(__g);
  var __realClearTimeout = __g.clearTimeout.bind(__g);
  var __realSetInterval = __g.setInterval.bind(__g);
  var __realClearInterval = __g.clearInterval.bind(__g);
  var __realRAF = (__g.requestAnimationFrame || function(cb){ return __g.setTimeout(cb, 16); }).bind(__g);
  var __realCAF = (__g.cancelAnimationFrame || function(id){ return __g.clearTimeout(id); }).bind(__g);
  var __realAddEventListener = __g.document.addEventListener.bind(__g.document);
  var __realRemoveEventListener = __g.document.removeEventListener.bind(__g.document);
  var __realQuerySelector = __g.document.querySelector.bind(__g.document);
  var __realQuerySelectorAll = __g.document.querySelectorAll.bind(__g.document);
  var __realCreateElement = __g.document.createElement.bind(__g.document);
  var __realFetch = (typeof __g.fetch !== 'undefined') ? __g.fetch.bind(__g) : null;
  var __realXHR = (typeof __g.XMLHttpRequest !== 'undefined') ? __g.XMLHttpRequest : null;
  var __realLocalStorage = __g.localStorage;
  var __realDate = __g.Date;
  var __realMath = __g.Math;
  var __realJSON = __g.JSON;
  var __realArray = __g.Array;
  var __realObject = __g.Object;
  var __realString = __g.String;
  var __realNumber = __g.Number;
  var __realBoolean = __g.Boolean;
  var __realRegExp = __g.RegExp;
  var __realError = __g.Error;
  var __realPromise = __g.Promise;
  var __realURL = __g.URL;
  // C-2 对象隔离所需的真实构造器（遮蔽前捕获）
  var __realProxy = __g.Proxy;
  var __realWeakMap = __g.WeakMap;
  var __realFunctionCtor = __g.Function; // 真实 Function 构造器：用于把工具代码提升到全局作用域执行，切断 __real* 闭包泄漏

  // 去重标记（放在遮蔽前，确保访问到真实 window）
  try {
    __g.__TA_TOOL_RAN__ = __g.__TA_TOOL_RAN__ || {};
    if (__g.__TA_TOOL_RAN__["${toolId}"]) return;
    __g.__TA_TOOL_RAN__["${toolId}"] = true;
  } catch (e) {}

  // 停止钩子登记处。工具可以调用 __TA_ON_STOP__(fn) 登记自己的清理逻辑
  // （clearInterval / removeEventListener / 移除面板等）。
  // 平台在"禁用工具 / 改配置 / 重注入"之前会统一调用它们，否则旧实例会一直跑下去。
  try {
    __g.__TA_TOOL_STOP__ = __g.__TA_TOOL_STOP__ || {};
  } catch (e) {}
  var __TA_ON_STOP__ = function (fn) {
    try { if (typeof fn === 'function') __g.__TA_TOOL_STOP__["${toolId}"] = fn; } catch (e) {}
  };

  // ============ Step 2: 配置与权限常量 ============
  var CONFIG = ${JSON.stringify(config)};
  var TOOL_ID = ${JSON.stringify(toolId)};
  var ALLOW_FETCH = ${allowFetch};
  var ALLOW_STORAGE = ${allowStorage};
  var ALLOW_CLIPBOARD = ${allowClipboard};
  var ALLOW_WRITE = ${allowWrite};

  // ============ Step 3: 构建受限 API 代理 ============

  // 受限 fetch：默认禁，xhr-same-origin 权限下只允许同源
  var safeFetch = function () {
    return __realPromise.reject(new __realError('[TA sandbox] fetch is disabled (missing xhr-same-origin permission)'));
  };
  if (ALLOW_FETCH && __realFetch) {
    safeFetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        var u = new __realURL(url, __realLocation_.href);
        if (u.origin !== __realLocation_.origin) {
          return __realPromise.reject(new __realError('[TA sandbox] cross-origin fetch is disabled: ' + url));
        }
      } catch (e) {
        return __realPromise.reject(e);
      }
      return __realFetch.call(__realWindow, input, init);
    };
  }

  // 受限 XMLHttpRequest：同源校验
  var SafeXHR = function () {
    throw new __realError('[TA sandbox] XMLHttpRequest is disabled (missing xhr-same-origin permission)');
  };
  if (ALLOW_FETCH && __realXHR) {
    SafeXHR = function () {
      var xhr = new __realXHR();
      var _open = xhr.open.bind(xhr);
      xhr.open = function (method, url) {
        try {
          var u = new __realURL(url, __realLocation_.href);
          if (u.origin !== __realLocation_.origin) throw new __realError('[TA sandbox] cross-origin XHR disabled: ' + url);
        } catch (e) { throw e; }
        return _open.apply(xhr, arguments);
      };
      return xhr;
    };
  }

  // WebSocket / EventSource / Worker：始终禁用
  var SafeWebSocket = function () { throw new __realError('[TA sandbox] WebSocket is disabled'); };

  // localStorage：命名空间隔离
  var storageProxy = {
    getItem: function () { return null; },
    setItem: function () { throw new __realError('[TA sandbox] localStorage disabled (missing local-storage permission)'); },
    removeItem: function () {},
  };
  if (ALLOW_STORAGE && __realLocalStorage) {
    var prefix = 'ta-tool:' + TOOL_ID + ':';
    storageProxy = {
      getItem: function (k) { try { return __realLocalStorage.getItem(prefix + k); } catch(e){ return null; } },
      setItem: function (k, v) { try { __realLocalStorage.setItem(prefix + k, v); } catch(e){} },
      removeItem: function (k) { try { __realLocalStorage.removeItem(prefix + k); } catch(e){} },
    };
  }

  // 剪贴板
  var clipboardProxy = {
    readText: function () { return __realPromise.reject(new __realError('[TA sandbox] clipboard.readText disabled')); },
    writeText: function () { return __realPromise.reject(new __realError('[TA sandbox] clipboard.writeText disabled')); },
  };
  if (ALLOW_CLIPBOARD && __realNavigator.clipboard) {
    try {
      var __cb = __realNavigator.clipboard;
      clipboardProxy = {
        readText: function() { return __cb.readText(); },
        writeText: function(t) { return __cb.writeText(t); },
      };
    } catch (e) {}
  }

  var safeNavigator = __realObject.freeze({
    userAgent: __realNavigator.userAgent,
    clipboard: clipboardProxy,
    language: __realNavigator.language || 'zh-CN',
    languages: __realNavigator.languages || ['zh-CN'],
    platform: __realNavigator.platform || '',
  });

  var safeLocation = __realObject.freeze({
    get href() { return __realLocation_.href; },
    get origin() { return __realLocation_.origin; },
    get protocol() { return __realLocation_.protocol; },
    get hostname() { return __realLocation_.hostname; },
    get pathname() { return __realLocation_.pathname; },
    get search() { return __realLocation_.search; },
    get hash() { return __realLocation_.hash; },
    toString: function() { return __realLocation_.href; },
    assign: function () { throw new __realError('[TA sandbox] location.assign blocked'); },
    replace: function () { throw new __realError('[TA sandbox] location.replace blocked'); },
    reload: function () { throw new __realError('[TA sandbox] location.reload blocked'); },
  });

  // ============ C-2 对象隔离：安全 document 代理 + 元素包装 ============
  // 根因修复：不再把真实 document 直接暴露给工具。用 Proxy 拦截危险能力，切断
  // "元素 → ownerDocument/defaultView/contentWindow → 真实 window" 与 constructor 逃逸链。
  var __SafeCtor = function () { throw new __realError('[TA sandbox] constructor access blocked'); };
  var __DANGER_TAGS = { iframe:1, frame:1, script:1, object:1, embed:1, base:1, link:1, portal:1, meta:1 };
  var __WRITE_METHODS = { appendChild:1, insertBefore:1, replaceChild:1, removeChild:1, remove:1,
    insertAdjacentHTML:1, insertAdjacentElement:1, insertAdjacentText:1, setAttribute:1, setAttributeNS:1,
    setAttributeNode:1, removeAttribute:1, replaceWith:1, before:1, after:1, prepend:1, append:1,
    write:1, writeln:1, execCommand:1, attachShadow:1 };
  var __elCache = (function () { try { return new __realWeakMap(); } catch (e) { return null; } })();
  var __proxyToReal = (function () { try { return new __realWeakMap(); } catch (e) { return null; } })();
  // 把工具传入的"包装元素"还原为真实元素，供真实 DOM API（brand check）使用
  function __unwrap(v) { if (v && typeof v === 'object' && __proxyToReal) { try { var r = __proxyToReal.get(v); if (r) return r; } catch (e) {} } return v; }
  function __unwrapArgs(args) { var out = []; for (var i = 0; i < args.length; i++) out.push(__unwrap(args[i])); return out; }
  function __isNode(v) { try { return !!v && typeof v === 'object' && typeof v.nodeType === 'number'; } catch (e) { return false; } }
  function __isNodeList(v) { try { return !!v && typeof v === 'object' && typeof v.length === 'number' && (v instanceof __g.NodeList || v instanceof __g.HTMLCollection); } catch (e) { return false; } }
  function __wrapVal(v) {
    if (__isNode(v)) return __wrapEl(v);
    if (__isNodeList(v)) { var out = []; for (var i = 0; i < v.length; i++) out.push(__wrapEl(v[i])); return out; }
    return v;
  }
  function __wrapEl(el) {
    if (!el || typeof el !== 'object') return el;
    if (__elCache) { try { var cached = __elCache.get(el); if (cached) return cached; } catch (e) {} }
    var handler = {
      get: function (t, prop) {
        if (prop === 'ownerDocument') return documentProxy;
        if (prop === 'defaultView' || prop === 'contentWindow' || prop === 'contentDocument') return undefined;
        if (prop === 'constructor') return __SafeCtor;
        if (prop === 'addEventListener') return __wrapAddEL(function (ty, l, o) { return t.addEventListener(ty, l, o); });
        if (prop === 'removeEventListener') return __wrapRemoveEL(function (ty, l, o) { return t.removeEventListener(ty, l, o); });
        if (!ALLOW_WRITE && __WRITE_METHODS[prop]) {
          return function () { throw new __realError('[TA sandbox] DOM 写入被拦截（缺少 dom-write 权限）: ' + __realString(prop)); };
        }
        var val = t[prop];
        if (typeof val === 'function') { return function () { return __wrapVal(val.apply(t, __unwrapArgs(arguments))); }; }
        return __wrapVal(val);
      },
      set: function (t, prop, value) {
        if (!ALLOW_WRITE && (prop === 'innerHTML' || prop === 'outerHTML' || prop === 'textContent' || prop === 'innerText' ||
            (typeof prop === 'string' && prop.lastIndexOf('on', 0) === 0))) {
          throw new __realError('[TA sandbox] DOM 写入被拦截（缺少 dom-write 权限）: ' + __realString(prop));
        }
        t[prop] = __unwrap(value); return true;
      },
    };
    var p;
    try { p = new __realProxy(el, handler); } catch (e) { return el; }
    if (__elCache) { try { __elCache.set(el, p); } catch (e) {} }
    if (__proxyToReal) { try { __proxyToReal.set(p, el); } catch (e) {} }
    return p;
  }
  // 事件对象包装：切断 e.source / e.view / e.target→ownerDocument→defaultView 等经事件的 window 逃逸（escape #4）
  function __wrapEvent(ev) {
    if (!ev || typeof ev !== 'object') return ev;
    try {
      return new __realProxy(ev, {
        get: function (t, prop) {
          if (prop === 'view' || prop === 'source') return undefined;
          if (prop === 'ports') return [];
          if (prop === 'constructor') return __SafeCtor;
          if (prop === 'target' || prop === 'currentTarget' || prop === 'srcElement' ||
              prop === 'relatedTarget' || prop === 'toElement' || prop === 'fromElement') return __wrapVal(t[prop]);
          if (prop === 'composedPath' || prop === 'path') return function () { return []; };
          var val = t[prop];
          if (typeof val === 'function') { return function () { return __wrapVal(val.apply(t, __unwrapArgs(arguments))); }; }
          return __wrapVal(val);
        },
      });
    } catch (e) { return ev; }
  }
  var __listenerMap = (function () { try { return new __realWeakMap(); } catch (e) { return null; } })();
  function __wrapAddEL(realAdd) {
    return function (type, listener, opts) {
      if (typeof listener !== 'function') return realAdd(type, listener, opts);
      var w = __listenerMap && __listenerMap.get(listener);
      if (!w) { w = function (ev) { return listener.call(undefined, __wrapEvent(ev)); }; if (__listenerMap) { try { __listenerMap.set(listener, w); } catch (e) {} } }
      return realAdd(type, w, opts);
    };
  }
  function __wrapRemoveEL(realRemove) {
    return function (type, listener, opts) {
      var w = (__listenerMap && typeof listener === 'function') ? __listenerMap.get(listener) : null;
      return realRemove(type, w || listener, opts);
    };
  }
  var documentProxy = new __realProxy(__realDocument, {
    get: function (t, prop) {
      if (prop === 'defaultView') return undefined;
      if (prop === 'ownerDocument') return null;
      if (prop === 'constructor') return __SafeCtor;
      if (prop === 'addEventListener') return __wrapAddEL(__realAddEventListener);
      if (prop === 'removeEventListener') return __wrapRemoveEL(__realRemoveEventListener);
      if (prop === 'createElement' || prop === 'createElementNS') {
        return function () {
          var name = (prop === 'createElementNS') ? arguments[1] : arguments[0];
          var tl = __realString(name || '').toLowerCase();
          if (__DANGER_TAGS[tl]) throw new __realError('[TA sandbox] 禁止创建危险元素: ' + tl);
          return __wrapEl(t[prop].apply(t, __unwrapArgs(arguments)));
        };
      }
      if (!ALLOW_WRITE && (prop === 'write' || prop === 'writeln' || prop === 'execCommand')) {
        return function () { throw new __realError('[TA sandbox] document.' + __realString(prop) + ' 被拦截（缺少 dom-write 权限）'); };
      }
      var val = t[prop];
      if (typeof val === 'function') { return function () { return __wrapVal(val.apply(t, __unwrapArgs(arguments))); }; }
      return __wrapVal(val);
    },
    set: function (t, prop, value) {
      if (!ALLOW_WRITE && prop === 'cookie') throw new __realError('[TA sandbox] document.cookie 写入被拦截');
      t[prop] = value; return true;
    },
  });
  // 安全 window：工具需要 window.__TA_ACTIVE_JD__ / __TA_SCORE__ / addEventListener('message'|'scroll') 等，
  // 但绝不暴露真实 window 的 fetch(跨源)/open/top/parent/postMessage 等逃逸能力。
  var __realWinAddEL = (typeof __g.addEventListener === 'function') ? __g.addEventListener.bind(__g) : function () {};
  var __realWinRemoveEL = (typeof __g.removeEventListener === 'function') ? __g.removeEventListener.bind(__g) : function () {};
  var __realGetComputedStyle = (typeof __g.getComputedStyle === 'function')
    ? function (el, ps) { return __g.getComputedStyle(__unwrap(el), ps); } : undefined;
  var safeWindow = __realObject.freeze({
    get __TA_ACTIVE_JD__() { try { return __g.__TA_ACTIVE_JD__; } catch (e) { return undefined; } },
    get __TA_SCORE__() { try { return __g.__TA_SCORE__; } catch (e) { return undefined; } },
    addEventListener: __wrapAddEL(__realWinAddEL),
    removeEventListener: __wrapRemoveEL(__realWinRemoveEL),
    dispatchEvent: function () { return false; },
    location: safeLocation,
    navigator: safeNavigator,
    document: documentProxy,
    setTimeout: __realSetTimeout, clearTimeout: __realClearTimeout,
    setInterval: __realSetInterval, clearInterval: __realClearInterval,
    requestAnimationFrame: __realRAF, cancelAnimationFrame: __realCAF,
    getComputedStyle: __realGetComputedStyle,
    devicePixelRatio: __g.devicePixelRatio || 1,
    innerWidth: __g.innerWidth, innerHeight: __g.innerHeight,
    scrollX: __g.scrollX, scrollY: __g.scrollY,
    console: __realConsole,
    fetch: safeFetch,
    localStorage: storageProxy,
  });

  // 安全 MutationObserver：观察目标需还原为真实节点（brand check），回调 records 包装以切断经节点的逃逸
  function __wrapRecord(rec) {
    if (!rec || typeof rec !== 'object') return rec;
    try { return new __realProxy(rec, { get: function (t, prop) { if (prop === 'constructor') return __SafeCtor; return __wrapVal(t[prop]); } }); } catch (e) { return rec; }
  }
  var __RealMO = __g.MutationObserver;
  function SafeMutationObserver(cb) {
    if (!__RealMO) throw new __realError('[TA sandbox] MutationObserver unavailable');
    var mo = new __RealMO(function (records) {
      var out = []; try { for (var i = 0; i < records.length; i++) out.push(__wrapRecord(records[i])); } catch (e) {}
      try { cb.call(this, out, this); } catch (e) {}
    });
    this.observe = function (target, opts) { return mo.observe(__unwrap(target), opts); };
    this.disconnect = function () { return mo.disconnect(); };
    this.takeRecords = function () { var r = mo.takeRecords(); var out = []; for (var i = 0; i < r.length; i++) out.push(__wrapRecord(r[i])); return out; };
  }

  // ============ Step 4: 危险全局名的遮蔽已移至 Step 5 ============
  // 工具代码经真实 Function 构造器在隔离世界全局作用域执行，通过具名形参注入受限 API，
  // 故不再需要在 wrapper 作用域用 var 遮蔽（且 strict 模式下 var eval/Function 本身即语法错误）。

  // 工具运行时 API（TA 对象）
  var TA = __realObject.freeze({
    toolId: TOOL_ID,
    config: CONFIG,
    permissions: ${JSON.stringify(permissions)},
    fetch: safeFetch,
    XMLHttpRequest: SafeXHR,
    localStorage: storageProxy,
    clipboard: clipboardProxy,
    location: safeLocation,
    document: documentProxy,
    querySelector: function(sel) { return __wrapEl(__realQuerySelector.call(__realDocument, sel)); },
    querySelectorAll: function(sel) { var r = __realQuerySelectorAll.call(__realDocument, sel); var out = []; for (var i = 0; i < r.length; i++) out.push(__wrapEl(r[i])); return out; },
    createElement: function(tag) { var tl = __realString(tag || '').toLowerCase(); if (__DANGER_TAGS[tl]) throw new __realError('[TA sandbox] 禁止创建危险元素: ' + tl); return __wrapEl(__realCreateElement.call(__realDocument, tag)); },
    log: function () {
      var args = __realArray.prototype.slice.call(arguments);
      __realConsole.log.apply(__realConsole, ['[TA:' + TOOL_ID + ']'].concat(args));
    },
  });

  // ============ Step 5: 执行工具代码 ============
  // F-01 修复：用真实 Function 构造器把工具代码提升到隔离世界【全局作用域】执行——其作用域链
  // 只有 [函数局部, 隔离世界全局]，不含本 wrapper 的 __real* 局部，故工具代码无法闭包访问
  // __realFetch/__realXHR/__realWindow 等。危险能力仅以受限版本通过具名形参注入。
  var __blockedCtor = function () { throw new __realError('[TA sandbox] disabled'); };
  // 步骤 d：封堵 ({}).constructor.constructor / (async|generator fn).constructor 逃逸链（尽力而为，失败不阻断）
  (function () {
    function __poison(ctor) {
      try {
        if (ctor && ctor.prototype) {
          __realObject.defineProperty(ctor.prototype, 'constructor', {
            value: __blockedCtor, writable: false, enumerable: false, configurable: false,
          });
        }
      } catch (e) {}
    }
    try { __poison(__g.Function); } catch (e) {}
    try { __poison((function () {}).constructor); } catch (e) {}
    try { __poison((function * () {}).constructor); } catch (e) {}
    try { __poison((async function () {}).constructor); } catch (e) {}
    try { __poison((async function * () {}).constructor); } catch (e) {}
  })();
  var __argNames = ['TA','document','window','globalThis','self','top','parent','location','navigator',
    'fetch','XMLHttpRequest','WebSocket','localStorage','sessionStorage','eval','Function','console',
    'setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame',
    'EventSource','Worker','SharedWorker','indexedDB','caches','importScripts','postMessage','open','close','frames',
    'addEventListener','removeEventListener','getComputedStyle','MutationObserver',
    // ⚠️ 工具代码是用 Function 构造器执行的，它的作用域是【全局】，看不到本包装里的 var。
    // 所以停止钩子必须作为【显式形参】传进去，否则工具里 typeof __TA_ON_STOP__ 永远是 undefined，
    // 整个停止机制会变成死代码。
    '__TA_ON_STOP__'];
  var __argVals = [TA, documentProxy, safeWindow, safeWindow, safeWindow, undefined, undefined, safeLocation, safeNavigator,
    safeFetch, SafeXHR, SafeWebSocket, storageProxy, storageProxy, __blockedCtor, __blockedCtor, __realConsole,
    __realSetTimeout, __realClearTimeout, __realSetInterval, __realClearInterval, __realRAF, __realCAF,
    __blockedCtor, __blockedCtor, __blockedCtor, undefined, undefined, undefined, __blockedCtor, __blockedCtor, __blockedCtor, undefined,
    safeWindow.addEventListener, safeWindow.removeEventListener, __realGetComputedStyle, SafeMutationObserver,
    __TA_ON_STOP__];
  try {
    var __toolSource = ${JSON.stringify(code)};
    // 外层函数为非严格（允许 eval/Function 作形参遮蔽全局）；工具代码在内层严格 IIFE 内运行
    // （this=undefined，杜绝 (function(){return this})() 逃逸），并经闭包读到被遮蔽的 eval/Function 形参。
    var __body = 'return (function () {\\n"use strict";\\n' + __toolSource + '\\n}).call(undefined);';
    var __toolFn = __realFunctionCtor.apply(null, __argNames.concat([__body]));
    __toolFn.apply(undefined, __argVals);
  } catch (e) {
    try { __realConsole.error('[TA tool ' + TOOL_ID + '] error:', e); } catch (_) {}
  }
// 外层 IIFE 在非严格位置通过 (function(){return this;})() 拿全局对象，作为 __g 参数传入；
// 严格模式只在 IIFE 内部生效，外层参数表达式不受 'use strict' 影响。
})( (function(){ return this; })() );
`;
}

// 行为采集插件的固定扩展 ID。该插件已剥离为独立仓（桌面\招聘行为采集插件），
// 与本平台风险不对称：它是纯只读采集，装在【用户日常 Chrome】里；而 RPA 走 CDP 附着 +
// 调试端口。两条线共用同一个浏览器 profile 是硬红线——一旦 RPA 附着到装了它的 Chrome，
// 这个只读插件就被拖进了自动化检测射程。故把它的 ID 也纳入 RPA 隔离黑名单，与匹配分插件同等对待。
// ⚠️ 此 ID 必须与独立仓 plugin/manifest.json 的 key 派生出的 ID 保持一致（改 key 就要同步改这里）。
export const BEHAVIOR_LOG_EXTENSION_ID = 'pbdfkefdkcbmmmgpiopfomjkdcbkllck';

// G2/G3: RPA 实例必须拒绝匹配分插件与行为采集插件。若用户用 --remote-debugging-port=9222/9333
// 启动了日常 Chrome，connectExisting() 会被吸引过去——此时若该 Chrome 装着这两个插件之一，
// 则插件线被 puppeteer 附着、零风险前提全破。rejectExtensionIds 在 connect 成功后立即检查，
// 命中立即 disconnect 并抛错。
// 注意：MATCH_SCORE_EXTENSION_ID 从 jd-bridge 导入，是 EXTENSION_ID 的唯一真源；
// contract:check 守着这个常量在所有位置的一致性，漂移会被自动拦住。

// 工具实例的保留资源（端口 + profile 目录名）。设置校验（ipc/settings.ts）据此
// 拒绝把 RPA 实例配置到这两个值上——否则 RPA 会连上工具浏览器/两实例互踢
// SingletonLock，四线隔离被一项设置击穿。改这里必须连着改校验提示文案。
// ⚠️ 因猎聘平台占用 9333，工具实例端口改为 9444（profile 名沿用 chrome-profile-tools）。
export const TOOLS_CDP_PORT = 9444;
export const TOOLS_PROFILE_DIR_NAME = 'chrome-profile-tools';

// ── 各平台 ChromeManager 实例统一由 runtime-registry.ts 的 buildRuntime() 创建 ──
// 不再在此处维护模块级单例（export const chromeManager / liepinChromeManager 已删除）。

// 按平台取实例的便捷函数，现已委托给 runtime-registry（避免循环依赖，用动态 import）。
// 外部调用方应优先使用 runtime-registry 的 getRuntime(platform).chrome。
export async function getChromeManager(platform: Platform): Promise<ChromeManager> {
  const { getRuntime } = await import('../services/runtime-registry');
  return getRuntime(platform).chrome;
}

// ── 工具专用浏览器实例（隔离改造 2026-07-29，S4 解耦）──────────────────────────
// 此前飞书工具的「打开并使用」会 connectExisting 到【承载 BOSS 登录态的同一个
// Chrome】（同 profile、同 9222 端口）：给它附着 puppeteer 与 BOSS 反检测铁律冲突，
// 关 RPA 浏览器（CDP_CLOSE）还会连带把工具页一起杀掉。
// 现在工具注入走这个独立实例：独立 profile（chrome-profile-tools）+ 独立端口 9444，
// 与 RPA 浏览器零共享。飞书两个工具共用它（用户明确允许两者共用）；
// BOSS/招聘域仍被 ANTI_DETECT_HOSTS 闸门挡住，本实例永远不该去开招聘站点。
//
// ── rejectExtensionIds 决策（两个飞书扩展 feishu-req2job / feishu-req-sheet-sync）──
// 结论：两个飞书扩展【不加入 rejectExtensionIds】，也不加入 toolsChromeManager 的拒绝清单。
// 理由：
//   · rejectExtensionIds 的作用是：防止 RPA Chrome（被 puppeteer 附着的那个）上装着
//     会改页面 DOM 的扩展，增加被检测的攻击面（BOSS/猎聘都在扫这类信号）。
//   · feishu-req2job 和 feishu-req-sheet-sync 装在【用户日常 Chrome】——
//     它们从来不在 RPA 专用 profile（chrome-profile / chrome-profile-liepin）里，
//     不被 puppeteer 附着，风险面完全为零，加进来只会让 RPA 启动误报。
//   · toolsChromeManager（工具浏览器）connect 的是工具 profile，飞书扩展可以在这里存在；
//     将来若平台策略改变（如飞书工具移出日常 Chrome），再重新评估此决策。
//   · 唯一需要在 rejectExtensionIds 里的是匹配分插件（boss 平台 DOM 改写）和行为采集插件，
//     两者已在 runtime-registry.ts 的 RPA chromeManager 构造里加入，见第 92 行。
export const toolsChromeManager = new ChromeManager({ cdpPort: TOOLS_CDP_PORT, profileDirName: TOOLS_PROFILE_DIR_NAME });
