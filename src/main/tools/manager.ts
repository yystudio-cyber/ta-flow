// 工具加载/管理：扫描 tools/ 目录下的 .tool.json
// C2 修复：工具安装/加载增加权限声明校验 + 沙箱执行（不 new Function 在主世界）
// H2 修复：enabled/config 使用 db 专用字段级 API，避免 INSERT OR REPLACE 互相覆盖
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getDb, setToolEnabled as dbSetEnabled, setToolConfig as dbSetConfig, getSetting } from '../db';
import type { ToolManifest, ToolState, ConfigField } from '../../shared/types';
import crypto from 'crypto';

// C2：工具权限声明 —— 每个工具必须在 manifest 里声明自己需要的权限，
// 运行时由注入器按权限裁剪，防止脚本越权
export type ToolPermission =
  | 'dom-read'      // 读取当前页 DOM
  | 'dom-write'     // 修改 DOM（加 badge/panel）
  | 'local-storage' // 只允许读写自己的命名空间（ta-tool:<id>:*）
  | 'xhr-same-origin' // 允许同源 fetch（默认禁止外发）
  | 'clipboard';    // 读剪贴板（如飞书字段复制器需要）

export interface SecureToolManifest extends ToolManifest {
  // 权限白名单；缺省 = 只读 DOM，不允许写/外发/存储
  permissions?: ToolPermission[];
  // 工具签名：官方内置工具由开发私钥签名，第三方工具必须由用户"信任"一次才能启用
  signature?: string;
  // 内置工具标记（安装在应用 resources 下，不可被第三方覆盖）
  builtin?: boolean;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  tool?: ToolState;
  trustRequired?: boolean;
}

export class ToolManager {
  private tools: Map<string, ToolState> = new Map();
  // 被用户一次性信任的第三方工具 ID → 安装时脚本 SHA-256（用于检测篡改）
  private trustedThirdParty: Map<string, string> = new Map();
  // 内置工具的脚本哈希（首次从只读资源目录加载时写入，用于完整性校验）
  private builtinHashes: Map<string, string> = new Map();
  private scriptsBaseDir: string;
  private builtinToolsDir: string;
  private customToolsDir: string | null = null;
  // M-9: 上次记录的版本号（持久化到 settings 表），用于检测版本变化
  private knownVersions: Map<string, string> = new Map();

  // 持久化 key（settings 表）
  private static readonly TRUST_KEY = 'tools.trusted';
  private static readonly VERSIONS_KEY = 'tools.knownVersions';

  constructor() {
    const { builtinDir, userDir } = this.resolveToolsDirs();
    this.builtinToolsDir = builtinDir;
    this.scriptsBaseDir = userDir;
    // 确保用户目录存在
    if (!fs.existsSync(this.scriptsBaseDir)) {
      try {
        fs.mkdirSync(this.scriptsBaseDir, { recursive: true });
      } catch {}
    }
  }

  private resolveToolsDirs(): { builtinDir: string; userDir: string } {
    // 内置工具：开发期在 cwd/tools，打包后在 resources/tools
    const builtinCandidates = [
      path.resolve(process.cwd(), 'tools'),
      path.join(app.getAppPath(), 'tools'),
      path.join(process.resourcesPath || '', 'tools'),
    ];
    let builtinDir = builtinCandidates[0];
    for (const p of builtinCandidates) {
      try {
        if (fs.existsSync(p)) {
          builtinDir = p;
          break;
        }
      } catch {}
    }
    // 用户自定义工具：始终在 userData/tools
    const userDir = path.join(app.getPath('userData'), 'tools');
    return { builtinDir, userDir };
  }

  setCustomToolsDir(dir: string) {
    if (fs.existsSync(dir)) {
      this.customToolsDir = dir;
      this.scriptsBaseDir = dir;
    }
  }

  getToolsDir(): string {
    return this.scriptsBaseDir;
  }

  getBuiltinToolsDir(): string {
    return this.builtinToolsDir;
  }

  // 扫描目录（内置+用户），加载全部工具
  loadAll(): ToolState[] {
    this.tools.clear();
    this.builtinHashes.clear();
    // 从 DB 读取已信任的第三方工具哈希、历史版本号
    this.loadTrustedFromDb();
    this.loadKnownVersionsFromDb();
    // 先加载内置，再加载用户（用户覆盖同名工具时以用户版为准）
    this.loadFromDir(this.builtinToolsDir, true);
    this.loadFromDir(this.scriptsBaseDir, false);
    if (this.customToolsDir && this.customToolsDir !== this.scriptsBaseDir) {
      this.loadFromDir(this.customToolsDir, false);
    }
    // 加载完成后把当前版本写回 knownVersions（下次启动就不会再有"更新"提示，除非版本又变）
    this.saveKnownVersionsToDb();
    return Array.from(this.tools.values());
  }

  private loadKnownVersionsFromDb() {
    try {
      const row = getDb()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(ToolManager.VERSIONS_KEY) as { value: string } | undefined;
      if (row?.value) {
        const parsed = JSON.parse(row.value) as Record<string, string>;
        this.knownVersions.clear();
        for (const [id, v] of Object.entries(parsed)) {
          if (typeof v === 'string') this.knownVersions.set(id, v);
        }
      }
    } catch { /* 首次启动忽略 */ }
  }

  private saveKnownVersionsToDb() {
    // 裸 DB 写必须兜错（隔离改造 2026-07-29）：loadAll 在启动链和 TOOLS_LIST 里都会调，
    // 这里一抛曾能让「打开工具库页面」失败、甚至截断整条启动链。版本号写不进去的
    // 唯一后果是下次多显示一回"已更新"标签——绝不值得拿可用性去换。
    try {
      const obj: Record<string, string> = {};
      for (const [id, t] of this.tools) obj[id] = t.version;
      getDb()
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(ToolManager.VERSIONS_KEY, JSON.stringify(obj));
    } catch (e: any) {
      console.warn('[tools] 版本号落库失败（不影响工具使用）：', e?.message || e);
    }
  }

  private loadTrustedFromDb() {
    try {
      const row = getDb()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(ToolManager.TRUST_KEY) as { value: string } | undefined;
      if (row?.value) {
        const parsed = JSON.parse(row.value) as Record<string, string>;
        this.trustedThirdParty.clear();
        for (const [id, hash] of Object.entries(parsed)) {
          if (typeof hash === 'string') this.trustedThirdParty.set(id, hash);
        }
      }
    } catch {
      /* 首次启动无记录，忽略 */
    }
  }

  private saveTrustedToDb() {
    const obj: Record<string, string> = {};
    for (const [id, hash] of this.trustedThirdParty) obj[id] = hash;
    getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(ToolManager.TRUST_KEY, JSON.stringify(obj));
  }

  private loadFromDir(baseDir: string, builtin: boolean) {
    if (!fs.existsSync(baseDir)) return;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(baseDir);
    } catch {
      return;
    }
    for (const dir of dirs) {
      const toolDir = path.join(baseDir, dir);
      let stat;
      try {
        stat = fs.statSync(toolDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const manifestPath = path.join(toolDir, `${dir}.tool.json`);
      const altPath = path.join(toolDir, 'tool.json');
      const mp = fs.existsSync(manifestPath)
        ? manifestPath
        : fs.existsSync(altPath)
          ? altPath
          : null;
      if (!mp) continue;
      try {
        const raw = fs.readFileSync(mp, 'utf-8');
        const manifest = JSON.parse(raw) as SecureToolManifest;
        // C2 安全校验：manifest 必须有 id/name/matches/entry
        if (!manifest.id || !manifest.name || !manifest.matches || !manifest.entry) {
          console.error('[tools] invalid manifest (missing required fields):', dir);
          continue;
        }
        // 确保入口脚本存在
        const entryPath = path.join(toolDir, manifest.entry);
        if (!fs.existsSync(entryPath)) {
          console.error('[tools] entry script not found:', entryPath);
          continue;
        }
        // 默认权限
        if (!manifest.permissions) manifest.permissions = ['dom-read'];
        if (builtin) manifest.builtin = true;

        // 读取脚本内容并计算 SHA-256 哈希（用于完整性校验/防篡改）
        const code = fs.readFileSync(entryPath, 'utf-8');
        const codeHash = this.sha256(code);

        // 内置工具：记录首次哈希；后续加载若哈希变化则告警（仅 dev 模式拦截）
        if (builtin) {
          const expected = this.builtinHashes.get(manifest.id);
          if (expected && expected !== codeHash && process.env.NODE_ENV !== 'development') {
            console.error('[tools] 内置工具哈希不匹配，可能被篡改，跳过加载:', manifest.id);
            continue;
          }
          this.builtinHashes.set(manifest.id, codeHash);
        }

        // 第三方工具：若曾经信任过，比对哈希；哈希变化说明脚本被替换，需重新信任
        let trusted = builtin;
        if (!builtin) {
          const trustedHash = this.trustedThirdParty.get(manifest.id);
          if (trustedHash === codeHash) {
            trusted = true; // 哈希一致，信任保持
          } else if (trustedHash && trustedHash !== codeHash) {
            console.warn('[tools] 第三方工具脚本发生变化，需重新信任:', manifest.id);
            this.trustedThirdParty.delete(manifest.id);
          }
        }

        // 读取 DB 状态
        const dbRow = getDb()
          .prepare('SELECT enabled, config FROM tools WHERE id = ?')
          .get(manifest.id) as { enabled: number; config: string } | undefined;
        // M-9: 版本变化检测：有历史记录且历史版本 != 当前版本 => 更新提示
        const prevVersion = this.knownVersions.get(manifest.id);
        const updateAvailable = !!prevVersion && prevVersion !== manifest.version;
        const state: ToolState & { permissions?: ToolPermission[]; builtin?: boolean; trusted?: boolean; updateAvailable?: boolean; installedVersion?: string } = {
          ...manifest,
          enabled: false, // 即使 DB 里 enabled=1，未信任也不启用
          config: {
            ...(manifest.defaultConfig || {}),
            ...(dbRow ? safeJson(dbRow.config) : {}),
          },
          permissions: manifest.permissions,
          builtin,
          trusted,
          updateAvailable,
          installedVersion: prevVersion || manifest.version,
        };
        // 内置工具或已信任的第三方工具，按 DB 启用
        if (trusted && dbRow) {
          state.enabled = !!dbRow.enabled;
        }
        this.tools.set(manifest.id, state as ToolState);
      } catch (e) {
        console.error('[tools] Failed to load', dir, e);
      }
    }
  }

  list(): ToolState[] {
    if (this.tools.size === 0) this.loadAll();
    return Array.from(this.tools.values());
  }

  get(id: string): ToolState | undefined {
    return this.tools.get(id);
  }

  getScriptPath(id: string): string | null {
    const t = this.tools.get(id);
    if (!t) return null;
    // 优先从用户目录，再从内置目录
    const user = path.join(this.scriptsBaseDir, id, t.entry);
    if (fs.existsSync(user)) return user;
    const builtin = path.join(this.builtinToolsDir, id, t.entry);
    if (fs.existsSync(builtin)) return builtin;
    if (this.customToolsDir) {
      const custom = path.join(this.customToolsDir, id, t.entry);
      if (fs.existsSync(custom)) return custom;
    }
    return null;
  }

  /**
   * M-12：TOCTOU 防护 —— 读取工具入口脚本内容并校验哈希后返回。
   * 注入方（chrome.ts）改用本方法而非直接 readFileSync，确保“校验时的字节”与“注入的字节”是同一份，
   * 消除“校验后、注入前脚本被替换”的时间窗。
   * builtin 工具比对 builtinHashes；第三方工具比对 trustedThirdParty 记录的哈希。
   * 一致返回脚本内容；工具不存在/脚本缺失/读取失败/缺可信哈希/哈希不一致，一律返回 null 并 console.warn。
   */
  readVerifiedScript(toolId: string): string | null {
    const t = this.tools.get(toolId);
    if (!t) {
      console.warn('[tools] readVerifiedScript: 工具不存在:', toolId);
      return null;
    }
    const scriptPath = this.getScriptPath(toolId);
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      console.warn('[tools] readVerifiedScript: 入口脚本不存在:', toolId);
      return null;
    }
    let code: string;
    try {
      code = fs.readFileSync(scriptPath, 'utf-8');
    } catch (e) {
      console.warn('[tools] readVerifiedScript: 读取脚本失败:', toolId, e);
      return null;
    }
    const codeHash = this.sha256(code);
    const isBuiltin = !!(t as any).builtin;
    // builtin 比对首次加载写入的哈希；第三方比对用户信任时记录的哈希
    const expected = isBuiltin
      ? this.builtinHashes.get(toolId)
      : this.trustedThirdParty.get(toolId);
    if (!expected) {
      console.warn('[tools] readVerifiedScript: 缺少可信哈希，拒绝注入:', toolId);
      return null;
    }
    if (expected !== codeHash) {
      console.warn('[tools] readVerifiedScript: 脚本哈希与可信哈希不一致，拒绝注入:', toolId);
      return null;
    }
    return code;
  }

  // H2 修复：启用/关闭只更新 enabled 字段
  setEnabled(id: string, enabled: boolean): ToolState | null {
    const t = this.tools.get(id);
    if (!t) return null;
    // C2：第三方工具必须先信任（且脚本哈希匹配）
    const sec = t as any;
    if (!sec.builtin && !this.trustedThirdParty.has(id)) {
      throw new Error(`第三方工具 "${t.name}" 必须先获得用户信任才能启用`);
    }
    (t as any).enabled = enabled;
    dbSetEnabled(id, enabled);
    return t;
  }

  // H2 修复：保存配置只更新 config 字段，不碰 enabled
  saveConfig(id: string, config: Record<string, any>): ToolState | null {
    const t = this.tools.get(id);
    if (!t) return null;
    t.config = { ...(t.defaultConfig || {}), ...config };
    dbSetConfig(id, t.config);
    return t;
  }

  /**
   * C2：安装工具 —— 从用户选择的目录拷贝到用户 tools 目录。
   * 第三方工具不会自动启用；返回 trustRequired=true 让 UI 弹信任确认。
   */
  async installFromDir(src: string): Promise<InstallResult> {
    if (!fs.existsSync(src)) return { ok: false, reason: '目录不存在' };
    const basename = path.basename(src);
    const manifestCandidates = [
      path.join(src, `${basename}.tool.json`),
      path.join(src, 'tool.json'),
    ];
    const mp = manifestCandidates.find((p) => fs.existsSync(p));
    if (!mp) {
      return { ok: false, reason: '未找到 tool.json 清单文件' };
    }
    let manifest: SecureToolManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    } catch (e) {
      return { ok: false, reason: `清单文件解析失败: ${(e as Error).message}` };
    }
    if (!manifest.id || !manifest.name || !manifest.entry || !manifest.matches) {
      return { ok: false, reason: '清单字段缺失（需要 id/name/entry/matches）' };
    }
    // H3-1: 路径穿越防护 —— 以下所有校验都在任何 copyDir(落盘)之前完成；
    // 任一非法立即 return {ok:false}，绝不拷贝，杜绝把文件写进开机启动目录等任意位置。
    // 1) id 必须是安全标识符：禁止 ../、路径分隔符等，否则 dest 可被引导到任意目录
    if (!/^[a-zA-Z0-9_-]+$/.test(manifest.id)) {
      return { ok: false, reason: `工具 id 非法（仅允许字母/数字/下划线/连字符）：${manifest.id}` };
    }
    // 2) entry 规范化后必须仍在源目录内，禁止用 ../ 逃逸源目录读取任意文件
    const srcResolved = path.resolve(src);
    const entryPath = path.resolve(src, manifest.entry);
    if (entryPath !== srcResolved && !entryPath.startsWith(srcResolved + path.sep)) {
      return { ok: false, reason: `入口脚本路径越界（entry 不能超出工具目录）：${manifest.entry}` };
    }
    // 3) 目标安装目录规范化后必须仍在用户工具根目录内（双保险）
    const baseResolved = path.resolve(this.scriptsBaseDir);
    const dest = path.resolve(this.scriptsBaseDir, manifest.id);
    if (dest !== baseResolved && !dest.startsWith(baseResolved + path.sep)) {
      return { ok: false, reason: `目标安装路径越界：${manifest.id}` };
    }

    if (!fs.existsSync(entryPath)) {
      return { ok: false, reason: `入口脚本 ${manifest.entry} 不存在` };
    }
    // 危险权限检测
    const dangerous: ToolPermission[] = ['xhr-same-origin', 'clipboard'];
    const needsDangerous = (manifest.permissions || []).filter((p) => dangerous.includes(p));
    // 禁止无权限声明却在脚本里出现 fetch/XMLHttpRequest 字样（简单扫描）
    const code = fs.readFileSync(entryPath, 'utf-8');
    const codeHints: string[] = [];
    if (needsDangerous.includes('xhr-same-origin') === false && /\b(fetch|XMLHttpRequest|axios)\s*\(/.test(code)) {
      codeHints.push('脚本疑似使用网络请求但未声明 xhr-same-origin 权限');
    }

    // 拷贝（此时 id/entry/dest 路径均已校验合法）
    try {
      copyDir(src, dest);
    } catch (e) {
      return { ok: false, reason: `拷贝失败: ${(e as Error).message}` };
    }
    // 重新加载
    this.loadAll();
    const installed = this.tools.get(manifest.id);
    if (!installed) return { ok: false, reason: '安装后加载失败' };
    // 非内置工具需要信任确认
    return {
      ok: true,
      tool: installed,
      trustRequired: true,
      reason: codeHints.length ? codeHints.join('；') : undefined,
    };
  }

  trustThirdParty(id: string): boolean {
    const t = this.tools.get(id);
    if (!t) return false;
    // 计算当前脚本哈希并记录，用于后续检测篡改
    const scriptPath = this.getScriptPath(id);
    if (scriptPath && fs.existsSync(scriptPath)) {
      const code = fs.readFileSync(scriptPath, 'utf-8');
      const hash = this.sha256(code);
      this.trustedThirdParty.set(id, hash);
    } else {
      // 找不到脚本也允许信任，但不记哈希（下次加载时校验不通过会重置）
      this.trustedThirdParty.set(id, '');
    }
    (t as any).trusted = true;
    this.saveTrustedToDb();
    return true;
  }

  /**
   * 返回工具的"安全执行配置"：注入器根据这个在 content script 外构造沙箱包装
   */
  getSandboxPolicy(id: string): { permissions: ToolPermission[]; toolId: string } {
    const t = this.tools.get(id);
    return {
      toolId: id,
      permissions: (t as any)?.permissions || ['dom-read'],
    };
  }

  /**
   * 返回当前激活且匹配 URL 的工具；每个返回项包含沙箱策略
   */
  getActiveScriptsForUrl(url: string): {
    toolId: string;
    scriptPath: string;
    config: Record<string, any>;
    permissions: ToolPermission[];
  }[] {
    const result: {
      toolId: string;
      scriptPath: string;
      config: Record<string, any>;
      permissions: ToolPermission[];
    }[] = [];
    // 战略降级：第三方工具默认不注入。仅当“允许第三方注入”开关显式打开时才放行，
    // 从根上消除“恶意第三方工具窃取页面数据”这一核心攻击面；builtin 工具不受影响。
    const allowThirdParty = getSetting<boolean>('tools.allowThirdPartyInjection', false);
    let warnedThirdParty = false; // 第三方被拦时只 warn 一次，避免刷屏
    for (const t of this.tools.values()) {
      // 单工具隔离（隔离改造 2026-07-29）：循环体整个包住。一个工具清单里畸形的
      // matches / 损坏的脚本路径若在这里抛出，原来会让整个函数抛 → 该页面上
      // 【所有】工具都注入不了——工具 A 的脏数据连坐工具 B。现在坏的只跳过它自己。
      try {
        if (!t.enabled) continue;
        if (!t.matches?.length) continue;
        const hit = t.matches.some((p) => matchPattern(url, p));
        if (!hit) continue;
        // 命中 URL 的非 builtin（第三方）工具：默认拦截，除非开关打开
        if (!(t as any).builtin && !allowThirdParty) {
          if (!warnedThirdParty) {
            console.warn('[tools] 第三方工具默认不注入（tools.allowThirdPartyInjection=false），已拦截:', t.id);
            warnedThirdParty = true;
          }
          continue;
        }
        const p = this.getScriptPath(t.id);
        if (p) {
          result.push({
            toolId: t.id,
            scriptPath: p,
            config: t.config,
            permissions: (t as any).permissions || ['dom-read'],
          });
        }
      } catch (e: any) {
        console.warn(`[tools] 工具「${t?.id || '?'}」匹配/取脚本失败（已隔离，其余工具照常注入）：`, e?.message || e);
      }
    }
    return result;
  }

  /** 计算脚本内容的 SHA-256 十六进制 */
  private sha256(code: string): string {
    return crypto.createHash('sha256').update(code, 'utf-8').digest('hex');
  }
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function copyDir(src: string, dest: string) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const destResolved = path.resolve(dest);
  for (const entry of fs.readdirSync(src)) {
    // H3-1: 逐项名基本校验，防止 '.'/'..'/含分隔符的目录项穿越到 dest 之外
    if (entry === '.' || entry === '..' || entry.includes('/') || entry.includes('\\')) {
      console.warn('[tools] copyDir 跳过非法目录项:', entry);
      continue;
    }
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    // 兜底：规范化后的目标路径必须仍在 dest 目录内
    if (!path.resolve(d).startsWith(destResolved + path.sep)) {
      console.warn('[tools] copyDir 跳过越界目录项:', entry);
      continue;
    }
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 简单的 URL 通配符匹配：* 表示任意字符
// URL 匹配（Chrome extension match-pattern 风格）：<scheme>://<host><path>
//
// ⚠️ 原实现把整条 pattern 编译成一条大正则（* → .*）后对整个 URL 做 test，`^.*://.*\.zhipin\.com/...`
// 里的前导 .* 可被任意前缀吃掉，导致 query/path/hash 夹带即可绕过。实测确认：
//   pattern `*://*.zhipin.com/web/geek/job*`
//   会命中 `https://evil.com/?x=https://www.zhipin.com/web/geek/job`
// 隔离世界 + 沙箱已封死 fetch/XHR/cookie/postMessage，不至于泄露数据，但"只在白名单站点运行"
// 这条边界被破坏了。改为按 scheme / host / path 三段分别匹配，host 必须整段相等或是合法子域。
export function matchPattern(url: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const pm = /^([^:]+):\/\/([^/]+)(\/.*)?$/.exec(pattern);
  if (!pm) return false;
  const [, pScheme, pHost, pPathRaw] = pm;
  const pPath = pPathRaw || '/*';

  let u: URL;
  try { u = new URL(url); } catch { return false; }

  // 1) scheme：只允许 http/https（禁 file:/chrome-extension: 等），'*' 表示两者皆可
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return false;
  if (pScheme !== '*' && pScheme.toLowerCase() !== scheme) return false;

  // 2) host：整段比较。'*.example.com' 命中 example.com 及其任意子域；其余必须完全相等。
  const host = u.hostname.toLowerCase();
  const ph = pHost.toLowerCase();
  if (ph === '*') {
    /* 任意 host */
  } else if (ph.startsWith('*.')) {
    const base = ph.slice(2);
    if (host !== base && !host.endsWith('.' + base)) return false;
  } else if (host !== ph) {
    return false;
  }

  // 3) path：只在 pathname + search 上做 glob（不含 host，杜绝前缀夹带）
  const target = u.pathname + u.search;
  let re = '^';
  for (const c of pPath) {
    if (c === '*') re += '.*';
    else if ('.+?^${}()|[]\\/'.includes(c)) re += '\\' + c;
    else re += c;
  }
  re += '$';
  try { return new RegExp(re, 'i').test(target); } catch { return false; }
}

export const toolManager = new ToolManager();
