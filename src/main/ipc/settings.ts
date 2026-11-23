// Settings handlers（含 SETTINGS_SAVE 字段错配修复：chromePath 使用 setChromePath）
import { BrowserWindow, dialog, app } from 'electron';
import path from 'path';
import { handle } from './wrap';
import { IPC, AppSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, DEFAULT_WEIGHTS } from '../../shared/constants';
import { getSetting, setSetting, setEncryptionEnabled, getEncryptionEnabled, isEncryptionAvailable, applyRetention } from '../db';
import { toolsChromeManager, ChromeManager, TOOLS_CDP_PORT, TOOLS_PROFILE_DIR_NAME } from '../cdp/chrome';
import { getRuntime } from '../services/runtime-registry';
import { setupAutoLaunch } from '../services/auto-launch';

function deepMerge<T>(base: any, override: any): T {
  if (!override) return base;
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const k in override) {
    const v = override[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(base?.[k] || {}, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// M-13: 设置字段白名单——只允许已知设置键落库，未知键丢弃并 console.warn，
// 防止渲染进程被 XSS 后通过 SETTINGS_SAVE 写入任意设置键（如注入 tools.* 安全开关）。
// 注意：AppSettings 无 tools 分区，故 tools.allowThirdPartyInjection 等键会作为“未知分区”被拒绝，
// 这正是期望的安全行为——渲染进程无法经由设置保存开启第三方注入。
const SETTINGS_WHITELIST: Record<string, readonly string[]> = {
  general: ['autoLaunch', 'trayOnClose', 'theme', 'language'],
  // ★ 猎聘的五个键此前不在白名单里 —— 界面有输入框、主进程真实读取，但保存时被
  //   静默丢弃后仍返回 true，界面照弹"设置已保存"。用户改完回读还是旧值，
  //   而设置页另一处还在提示"请先配置猎聘端口"，那个配置永远存不进去。
  browser: ['mode', 'chromePath', 'cdpPort', 'userDataDir', 'extraArgs', 'bossSelectors',
    'liepinCdpPort', 'liepinUserDataDir', 'liepinSelectors'],
  rpa: ['defaultSpeed', 'logRetentionDays', 'enableScheduler', 'enableIdleStart', 'learnBehavior', 'enableAutoGreet',
    'liepinPackageTier', 'liepinEnableStageB'],
  // ⚠️ risk 分区整体【只读】。反风控参数一律由速度档位派生（getRiskThresholdsForMode），
  // 运行时不读 settings.risk，UI 上也没有任何可编辑入口——留着可写只会制造两处口径。
  // 尤其 autoPauseOnDanger：它是【唯一】仍被读取的一项（ipc/risk.ts getAutoPauseSetting），
  // 一旦被写成 false，高风险决策框的 Esc/关闭就等于选了"继续使用"，
  // 与 constants.ts 里"危险自动暂停：强制开，人工不可关"的声明直接矛盾。
  // 置空数组 = 该分区所有键都会被丢弃并 console.warn（保留旧值）。
  risk: [],
  matchScore: ['highThreshold', 'lowThreshold', 'defaultWeights'],
  data: ['dataDir', 'exportDir', 'encryptionEnabled'],
};

// matchScore.defaultWeights 的深层白名单（ScoreWeights 已知维度）。
// 从 DEFAULT_WEIGHTS 派生，不再手抄一份：手抄版曾停在 8 维，而引擎是 14 维，
// 结果设置页即便加上新维度也会在这里被静默丢弃（保存后回读还是旧值，无任何提示）。
const WEIGHT_KEYS: readonly string[] = Object.keys(DEFAULT_WEIGHTS);

// M-13: 关键安全项值校验——防止渲染进程写入危险的 cdp endpoint / 启动参数
function validateBrowserSecurity(browser: any) {
  // cdp endpoint：端口必须为合法非特权整数端口，非法则丢弃（保留旧值）。
  // 四线隔离：9333 是工具浏览器实例的保留端口——RPA 配到 9333 会直接连上
  // 工具浏览器（飞书 profile 里找 BOSS 页），登录态与反检测约束整体失效。
  if ('cdpPort' in browser) {
    const p = Number(browser.cdpPort);
    if (!Number.isInteger(p) || p < 1024 || p > 65535 || p === TOOLS_CDP_PORT) {
      console.warn(`[settings] 非法/保留 cdpPort 已丢弃: ${String(browser.cdpPort)}`);
      delete browser.cdpPort;
    } else {
      browser.cdpPort = p;
    }
  }
  // userDataDir 不得指向工具浏览器专用 profile：两实例同 profile 会互踢 SingletonLock
  if ('userDataDir' in browser && typeof browser.userDataDir === 'string' && browser.userDataDir) {
    try {
      const resolved = path.resolve(browser.userDataDir);
      const toolsProfile = path.resolve(app.getPath('userData'), TOOLS_PROFILE_DIR_NAME);
      if (resolved === toolsProfile || resolved.startsWith(toolsProfile + path.sep)) {
        console.warn(`[settings] userDataDir 指向工具浏览器专用 profile，已丢弃: ${browser.userDataDir}`);
        delete browser.userDataDir;
      }
      // G1: userDataDir 也不得指向【系统默认浏览器 profile】（日常 Chrome/Edge）。
      // 命中意味着用户把平台指到了装着匹配分插件的日常浏览器——平台会删 Singleton*、
      // 开调试端口、puppeteer 附着，把插件线暴露在 CDP 自动化检测下，插件"零风险"前提全破。
      // 此处命中则丢弃该键、保留旧值，并 warn；启动层（launch/launchDetached/openBrowserForLogin）
      // 还有一层硬兜底，在任何 fs.rmSync 之前再次校验，防止 DB 旧值/手工改库绕过。
      const blockedRoot = ChromeManager.isDefaultBrowserProfile(resolved);
      if (blockedRoot) {
        console.warn(`[settings] userDataDir 指向系统默认浏览器 profile（${resolved}），已丢弃——这会破坏日常 Chrome 并把匹配分插件暴露在自动化检测下。请使用平台专用 profile 目录。`);
        delete browser.userDataDir;
      }
    } catch { /* 路径解析失败按原样放行，launch 时还有一层兜底校验 */ }
  }
  // mode 枚举校验
  if ('mode' in browser && browser.mode !== 'dedicated' && browser.mode !== 'existing') {
    console.warn(`[settings] 非法 browser.mode 已丢弃: ${String(browser.mode)}`);
    delete browser.mode;
  }
  // extraArgs：必须为字符串，且落库前剔除危险参数，防止危险 flag 持久化后被后续启动读取
  if ('extraArgs' in browser) {
    if (typeof browser.extraArgs !== 'string') {
      console.warn('[settings] browser.extraArgs 非字符串，已丢弃');
      delete browser.extraArgs;
    } else {
      const safe = (browser.extraArgs as string)
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((a) => ChromeManager.isSafeExtraArg(a));
      browser.extraArgs = safe.join(' ');
    }
  }
}

// M-13: 按白名单过滤+校验来自渲染进程的设置对象，未知分区/键丢弃并告警
function sanitizeSettings(input: any): Partial<AppSettings> {
  const clean: any = {};
  if (!input || typeof input !== 'object') return clean;
  for (const section in input) {
    const allowed = SETTINGS_WHITELIST[section];
    if (!allowed) {
      console.warn(`[settings] 丢弃未知设置分区: ${section}`);
      continue;
    }
    const src = input[section];
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      console.warn(`[settings] 设置分区结构异常，已忽略: ${section}`);
      continue;
    }
    const dst: any = {};
    for (const key in src) {
      if (!allowed.includes(key)) {
        console.warn(`[settings] 丢弃未知设置键: ${section}.${key}`);
        continue;
      }
      dst[key] = src[key];
    }
    // matchScore.defaultWeights 深层白名单
    if (section === 'matchScore' && dst.defaultWeights && typeof dst.defaultWeights === 'object') {
      const w: any = {};
      for (const k in dst.defaultWeights) {
        if (WEIGHT_KEYS.includes(k)) w[k] = dst.defaultWeights[k];
        else console.warn(`[settings] 丢弃未知权重键: matchScore.defaultWeights.${k}`);
      }
      dst.defaultWeights = w;
    }
    clean[section] = dst;
  }
  // 关键安全项值校验
  if (clean.browser) validateBrowserSecurity(clean.browser);
  return clean;
}

// M-13: 清空/重置数据后必须重置的安全关键项，防止攻击者预先写入的设置在清空后残留。
// 供 data.ts 的 DATA_CLEAR_ALL（clearAllData）在清空后调用（见 crossFileContracts）。
export function resetSecurityCriticalSettings() {
  // 加密引擎回到安全默认（关闭），避免残留的攻击者状态/密钥
  try {
    if (getEncryptionEnabled()) setEncryptionEnabled(false);
  } catch {
    /* 加密不可用则忽略 */
  }
  // 清除受信任第三方工具列表（tools.trusted），避免攻击者预置的信任在清空后仍生效
  setSetting('tools.trusted', {});
  // 显式关闭第三方注入开关（当前无独立键，防御性写入安全默认）
  setSetting('tools.allowThirdPartyInjection', false);
  // app-settings 的安全字段回到默认
  const cur = getSetting<Partial<AppSettings>>('app-settings', {});
  const merged = deepMerge<AppSettings>(DEFAULT_SETTINGS, cur);
  merged.data.encryptionEnabled = false;
  if (merged.browser) merged.browser.extraArgs = '';
  setSetting('app-settings', merged);
}

export function registerSettingsHandlers(winGetter: () => BrowserWindow | null, dataDir: string) {
  handle(IPC.SETTINGS_GET, (): AppSettings => {
    const stored = getSetting<Partial<AppSettings>>('app-settings', {});
    const result = deepMerge<AppSettings>(DEFAULT_SETTINGS, stored);
    // 回填真实数据目录（设置里 dataDir 只读展示，后端从不落库此值 → 之前恒为空）
    if (result.data) result.data.dataDir = dataDir;
    return result;
  });

  handle(IPC.SETTINGS_SAVE, (_e, settings: AppSettings) => {
    // M-13: 先按白名单过滤+校验，未知键丢弃、危险值剔除，再合并落库
    const safe = sanitizeSettings(settings);
    // 合并而不是覆盖，防止缺字段
    const prev = getSetting<Partial<AppSettings>>('app-settings', {});
    const merged = deepMerge<AppSettings>(prev, safe);
    setSetting('app-settings', merged);

    // M-13: 副作用一律基于已校验的 safe，杜绝未过滤的原始值到达 getRuntime('boss').chrome
    if (safe.browser?.cdpPort) getRuntime('boss').chrome.setPort(safe.browser.cdpPort);
    // 用 !== undefined：清空 Chrome 路径/userDataDir（改回空串）也即时生效（空串→回退自动查找），不必重启。
    if (safe.browser?.chromePath !== undefined) { getRuntime('boss').chrome.setChromePath(safe.browser.chromePath); toolsChromeManager.setChromePath(safe.browser.chromePath); }
    if (safe.browser?.userDataDir !== undefined) getRuntime('boss').chrome.setUserDataDir(safe.browser.userDataDir);
    if (safe.browser?.extraArgs !== undefined) getRuntime('boss').chrome.setExtraArgs(safe.browser.extraArgs);
    // 反风控参数系统固定、不可人工调：不再用 settings.risk 覆盖风控阈值（阈值只由档位派生）。
    // 开机自启：保存即时生效（幂等，内部自查当前状态），不必重启 app
    if (safe.general?.autoLaunch !== undefined) void setupAutoLaunch(safe.general.autoLaunch);
    // 日志保留天数：保存即时按新值裁剪一次，不必重启 app
    if (safe.rpa?.logRetentionDays !== undefined) applyRetention();

    // H4：处理加密开关切换
    const wantEncrypt = !!safe.data?.encryptionEnabled;
    if (wantEncrypt !== getEncryptionEnabled()) {
      if (wantEncrypt) {
        if (!isEncryptionAvailable()) {
          dialog.showErrorBox(
            '加密不可用',
            '当前系统不支持系统级加密（可能是 Linux 无 keyring）。数据仍以明文存储。',
          );
          merged.data.encryptionEnabled = false;
          setSetting('app-settings', merged);
        } else {
          const ok = setEncryptionEnabled(true);
          if (!ok) {
            dialog.showErrorBox(
              '加密启用失败',
              '无法启用本地加密，可能是系统密钥环不可用。',
            );
            merged.data.encryptionEnabled = false;
            setSetting('app-settings', merged);
          }
        }
      } else {
        // 关闭加密可能因"解密回写失败"被中止（db.ts 会保留主密钥、保持加密开启）。
        // 返回值必须看：不看就会把设置里的 encryptionEnabled 落成 false，
        // 而引擎其实还开着——界面显示"已关闭"、数据仍是密文，是最难自查的状态不一致。
        if (!setEncryptionEnabled(false)) {
          const cur = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
          const fixed = { ...merged, data: { ...merged.data, encryptionEnabled: true } };
          setSetting('app-settings', fixed);
          void cur;
          return { ok: false, reason: '关闭加密失败：解密回写未成功，已中止以免数据永久不可读。请先导出数据后重试。' };
        }
      }
    }
    return true;
  });

  handle(IPC.SETTINGS_RESET, () => {
    setSetting('app-settings', DEFAULT_SETTINGS);
    // M-13: 同步加密引擎到默认（关闭），避免 app-settings 显示 false 但引擎仍开启的状态不一致
    try {
      if (getEncryptionEnabled() !== DEFAULT_SETTINGS.data.encryptionEnabled) {
        setEncryptionEnabled(DEFAULT_SETTINGS.data.encryptionEnabled);
      }
    } catch {
      /* 加密不可用则忽略 */
    }
    return DEFAULT_SETTINGS;
  });
}
