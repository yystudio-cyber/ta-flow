// 运行时注册表 —— 多平台隔离的【单一来源】
//
// 每个平台拿到一整套彼此独立的运行时对象：
//   PlatformAdapter（平台知识）
//   ChromeManager  （独立浏览器：不同端口 + 不同 profile → cookie/指纹/会话完全不共享）
//   RiskMonitor    （独立风险状态：计数/闩/冷却互不影响）
//   RiskController （独立闭环控制：AIMD 速率/熔断/健康基线互不影响）
//   RPAEngine      （独立引擎：可与另一平台并行运行）
//
// 隔离铁律（对齐猎聘分支设计，master 按渐进方案落地）：
//   ① 新代码按平台取对象一律走 getRuntime(platform).xxx，不要再依赖各模块内的模块级单例；
//   ② 任何跨平台联动都是 bug —— 前端可以并排展示，但一个平台的动作绝不触发另一个平台的动作；
//   ③ 事件只在各自实例的 EventEmitter 上发，引擎后续补 ownsUrl/平台归属二次校验（纵深防御）。
//
// 向后兼容策略（BOSS）：
//   BOSS 平台的 runtime 复用历史上在 chrome.ts / risk-monitor.ts / risk-controller.ts / rpa-engine.ts
//   里模块级 new 的那几个单例——保证 getRuntime('boss').xxx 与老代码 `import { chromeManager } from '../cdp/chrome'`
//   拿到的是【同一个对象】，不会出现两个 ChromeManager 抢同一个 9222 端口的灾难。
//   其它平台（liepin 及以后）一律在这里 new 独立实例。
//   等所有调用方都迁移到 getRuntime(platform) 后，再把原文件里的模块级单例删掉，彻底收口到注册表。
//
// 与猎聘分支差异（master 现状适配）：
//   - master 的 ChromeManager 构造签名是 { cdpPort?, profileDirName?, rejectExtensionIds? }，
//     没有 hostPattern/loginStartUrl/loginOrVerifyPattern/riskNet 这些 adapter 字段；
//     待 PlatformAdapter 接口扩展后，改 buildRuntime 一处即可接入。
//   - master 的 RiskMonitor 构造只吃 thresholds、RiskController 无参、RPAEngine 无参；
//     按现状签名 new。等 RiskMonitor 加 attachController(controller) 时，同步在此处补
//     riskMonitor.attachController(riskController) 接线，打破构造期循环依赖。
import type { PlatformId, AppSettings } from '../../shared/types';
import { PLATFORMS } from '../../shared/types';
import { DEFAULT_SETTINGS, getRiskThresholdsForMode, normalizeSpeedMode } from '../../shared/constants';
import { ChromeManager, BEHAVIOR_LOG_EXTENSION_ID } from '../cdp/chrome';
import { RiskMonitor } from './risk-monitor';
import { RiskController } from './risk-controller';
import { RPAEngine } from './rpa-engine';
import { getPlatformAdapter, type PlatformAdapter } from './platform-adapter';
import { getSetting } from '../db';
import { EXTENSION_ID as MATCH_SCORE_EXTENSION_ID } from './jd-bridge';
import { BehaviorLearner } from './behavior-learner';

export interface PlatformRuntime {
  platform: PlatformId;
  adapter: PlatformAdapter;
  chrome: ChromeManager;
  riskMonitor: RiskMonitor;
  riskController: RiskController;
  engine: RPAEngine;
  // 2026-08-07 P1-6: 按平台实例化，不再全平台共用一个 boss-only 的采样器
  behaviorLearner: BehaviorLearner;
}

const runtimes = new Map<PlatformId, PlatformRuntime>();

/** 该平台默认 CDP 端口（硬编码兜底；后续迁入 adapter.defaultCdpPort 时改这里一处） */
function defaultPortFor(platform: PlatformId): number {
  if (platform === 'liepin') return 9333;
  return 9222; // boss
}

/** 该平台默认 profile 目录名（硬编码兜底；后续迁入 adapter.profileDirName 时改这里一处） */
function defaultProfileDirNameFor(platform: PlatformId): string {
  if (platform === 'liepin') return 'chrome-profile-liepin';
  return 'chrome-profile'; // boss
}

/** 从设置里取该平台的浏览器配置（端口/profile 目录） */
function browserConfigFor(platform: PlatformId) {
  const s = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
  const b = s?.browser || DEFAULT_SETTINGS.browser;
  if (platform === 'liepin') {
    return {
      port: Number(b.liepinCdpPort) || defaultPortFor(platform),
      profileDir: b.liepinUserDataDir || '',
    };
  }
  return {
    port: Number(b.cdpPort) || defaultPortFor(platform),
    profileDir: b.userDataDir || '',
  };
}

function buildRuntime(platform: PlatformId): PlatformRuntime {
  const adapter = getPlatformAdapter(platform);

  const s = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
  const defaultMode = normalizeSpeedMode(s?.rpa?.defaultSpeed || 'human');
  const bc = browserConfigFor(platform);

  // 所有平台一律自建独立实例（不再区分 boss/liepin）。
  // 每个平台独立端口 + 独立 profile + 独立引擎/风控实例，L2 运行时隔离。
  const chrome = new ChromeManager({
    platform,
    cdpPort: bc.port,
    profileDirName: defaultProfileDirNameFor(platform),
    rejectExtensionIds: [MATCH_SCORE_EXTENSION_ID, BEHAVIOR_LOG_EXTENSION_ID],
    launchArgs: adapter.launchArgs ?? [],
    // ★ 网络层风控规则按平台注入。此前 RiskNetRules 只被声明、从未接进来，
    //   响应监控整段是 BOSS 硬编码 —— 等于猎聘的 WAF 挑战(acw_sc__v2/v3)、
    //   403/429、security.min.js 静默上报三类网络层信号【全部零覆盖】。
    riskNet: adapter.riskNet,
    hostPattern: adapter.hostPattern,
  });
  if (bc.profileDir) chrome.setUserDataDir(bc.profileDir);

  const riskMonitor = new RiskMonitor({
    thresholds: getRiskThresholdsForMode(defaultMode, undefined, platform),
    platform,
  });
  const riskController = new RiskController(platform);
  riskMonitor.attachController(riskController);

  // 跨重启恢复（熔断冷却窗口 + 需人工确认的异常闩）
  try { riskController.restoreFromDisk(); } catch { /* 忽略 */ }
  try { riskMonitor.restoreFromDisk(); } catch { /* 忽略 */ }
  try { riskMonitor.loadFromDb(); } catch { /* 忽略 */ }

  // L8(阶段1)：构造时把平台传给引擎锁定（构造签名见 rpa-engine.ts）。
  const engine = new RPAEngine(platform);
  const behaviorLearner = new BehaviorLearner(platform);

  return { platform, adapter, chrome, riskMonitor, riskController, engine, behaviorLearner };
}

/** 取某平台的运行时（懒建，进程内单实例） */
export function getRuntime(platform: PlatformId): PlatformRuntime {
  let rt = runtimes.get(platform);
  if (!rt) {
    rt = buildRuntime(platform);
    runtimes.set(platform, rt);
  }
  return rt;
}

/** 所有平台的运行时（仪表盘/设置/退出清理等需要遍历时用） */
export function allRuntimes(): PlatformRuntime[] {
  return PLATFORMS.map((p) => getRuntime(p));
}

/** 已构造出来的运行时（不触发懒建，用于退出清理避免"为了关而先建"） */
export function builtRuntimes(): PlatformRuntime[] {
  return Array.from(runtimes.values());
}

/**
 * 注册/替换某平台的运行时（主要给测试/特殊装配用；正常流程走 getRuntime 懒建）。
 * 覆盖一个已在跑的 runtime 不会自动停掉旧引擎/关闭旧浏览器——调用方负责先清理。
 */
export function registerRuntime(platform: PlatformId, rt: PlatformRuntime): void {
  runtimes.set(platform, rt);
}

/**
 * 应用设置变更后同步各平台浏览器配置。
 * 两平台端口必须不同——相同会导致两个 ChromeManager 连到同一个 Chrome 实例，
 * L1 隔离直接失效（同 profile 同 cookie 同指纹）。此处强制校验并回落到默认值。
 */
export function applyBrowserSettings(settings: AppSettings): { warnings: string[] } {
  const warnings: string[] = [];
  const usedPorts = new Map<number, PlatformId>();
  for (const p of PLATFORMS) {
    const rt = getRuntime(p);
    const c = browserConfigFor(p);
    let port = c.port;
    const owner = usedPorts.get(port);
    if (owner && owner !== p) {
      warnings.push(
        `【隔离保护】${p} 与 ${owner} 配置了相同的调试端口 ${port}，会导致两平台共用同一个浏览器实例；`
        + `已强制回落到默认端口 ${defaultPortFor(p)}。请在设置里改为不同端口。`,
      );
      port = defaultPortFor(p);
    }
    usedPorts.set(port, p);
    rt.chrome.setPort(port);
    if (settings.browser?.chromePath) rt.chrome.setChromePath(settings.browser.chromePath);
    if (c.profileDir) rt.chrome.setUserDataDir(c.profileDir);
    rt.chrome.setExtraArgs(settings.browser?.extraArgs);
  }
  // profile 目录也不能相同（同目录 = 同 cookie 池）
  const dirs = new Map<string, PlatformId>();
  for (const p of PLATFORMS) {
    const rt = getRuntime(p);
    // master ChromeManager 未暴露 getProfileDir()，走私有字段兜底访问；后续补 getter 后替换。
    const d = String((rt.chrome as any).userDataDir || '').toLowerCase();
    if (!d) continue;
    const owner = dirs.get(d);
    if (owner && owner !== p) {
      warnings.push(
        `【隔离保护】${p} 与 ${owner} 配置了相同的浏览器数据目录，cookie/登录态会互串；请改为不同目录。`,
      );
    }
    dirs.set(d, p);
  }
  return { warnings };
}

/** 退出时关闭已建的浏览器连接（只处理已构造的，避免懒建副作用） */
export async function closeAllBrowsers(): Promise<void> {
  await Promise.all(builtRuntimes().map((rt) => rt.chrome.close().catch(() => {})));
}

// ── 向后兼容说明 ──────────────────────────────────────────────────
// chromeManager / riskMonitor / riskController / rpaEngine 等模块级单例已删除。
// 所有代码通过 getRuntime(platform) 获取对应平台实例。
//   旧: import { chromeManager } from '../cdp/chrome'
//   新: import { getRuntime } from '../services/runtime-registry'
//       getRuntime('boss').chrome.doSomething()
// 向后兼容 re-export（供仍在使用老名字的调用方过渡）：
export { ChromeManager, BEHAVIOR_LOG_EXTENSION_ID } from '../cdp/chrome';
