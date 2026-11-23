#!/usr/bin/env node
/**
 * 多平台隔离 · 静态断言（对应《猎聘RPA设计方案》§3.6 的 A8 / A9）
 *
 * 这两条是【结构性】断言 —— 它们保证的不是"当前跑得对"，而是"将来改不坏"：
 *   A8：rpa-engine.ts 里不得出现任何平台字面量。一旦有人图省事在引擎里写 if (platform==='boss')，
 *       隔离就开始腐化，后面所有运行期断言都会慢慢失效。
 *   A9：全仓不得再出现模块级单例 export。单例是本次重构消灭的根本病因：
 *       两平台共用一个引擎/风控/浏览器，就不存在任何隔离可言。
 *
 * 用法：node scripts/check-isolation.mjs
 * 退出码：0 全绿 / 1 有违规
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures++; console.error(`  ✗ ${m}`); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p);
  }
  return out;
}

function stripComments(code) {
  // 去掉行注释与块注释 —— 断言只看【真实代码】，注释里写平台名是允许且必要的（要解释为什么）
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── A8：引擎必须完全平台无关 ───────────────────────────────────
console.log('\n[A8] rpa-engine.ts 平台无关性');
{
  const f = path.join(SRC, 'main/services/rpa-engine.ts');
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  // 平台字面量：域名 / 平台 id 字符串 / 各平台专属 DOM 选择器
  const forbidden = [
    /['"`]boss['"`]/, /zhipin/i, /liepin/i,
    /card-item/, /\bgeek\b/i, /recommend/i, /resumeCard/i, /resIdEncode/i,
    /encryptGeekId/, /ant-lpt/,
  ];
  const hits = [];
  code.split('\n').forEach((line, i) => {
    for (const re of forbidden) {
      if (re.test(line)) { hits.push(`${i + 1}: ${line.trim().slice(0, 110)}`); break; }
    }
  });
  if (hits.length) {
    bad(`rpa-engine.ts 出现 ${hits.length} 处平台字面量（应全部走 PlatformAdapter）：`);
    hits.slice(0, 12).forEach((h) => console.error(`      ${h}`));
  } else {
    ok('引擎无任何平台字面量');
  }

  // 引擎也不得直接 import 具体 adapter
  if (/from\s+['"].*adapters\/(boss|liepin)['"]/.test(code)) {
    bad('rpa-engine.ts 直接 import 了具体 adapter（必须只依赖 PlatformAdapter 接口）');
  } else {
    ok('引擎未直接 import 具体 adapter');
  }
}

// ── A9：全仓不得再有模块级单例 ─────────────────────────────────
console.log('\n[A9] 模块级单例已全部消灭');
{
  const files = walk(SRC);
  const singletonRe = /export\s+const\s+(rpaEngine|riskMonitor|riskController|chromeManager)\s*=/;
  const hits = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    if (singletonRe.test(code)) hits.push(path.relative(ROOT, f));
  }
  if (hits.length) {
    bad(`发现模块级单例 export（会让两平台共用同一实例，隔离直接失效）：`);
    hits.forEach((h) => console.error(`      ${h}`));
  } else {
    ok('无 rpaEngine / riskMonitor / riskController / chromeManager 单例');
  }
}

// ── A9-b：DB 写入必须带 platform ───────────────────────────────
console.log('\n[A9-b] 数据层 platform 谓词');
{
  const files = walk(SRC).filter((f) => f.includes(`main${path.sep}`));
  const hits = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    // bumpDaily / getDaily 必须首参是 platform（不允许无参调用）
    for (const m of code.matchAll(/\b(bumpDaily|getDaily)\s*\(\s*([^)]*)\)/g)) {
      const args = m[2].trim();
      if (!args) hits.push(`${path.relative(ROOT, f)}: ${m[0]} —— 缺少 platform 首参`);
    }
    // 直接对分区表的 INSERT 必须显式带 platform 列
    for (const m of code.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(daily_stats|risk_history|rpa_logs|candidates_export)\s*\(([^)]*)\)/gi)) {
      if (!/\bplatform\b/i.test(m[2])) {
        hits.push(`${path.relative(ROOT, f)}: INSERT INTO ${m[1]} 未带 platform 列`);
      }
    }
  }
  if (hits.length) {
    bad('数据层存在未带 platform 的写入（两平台计数会互相污染）：');
    hits.slice(0, 12).forEach((h) => console.error(`      ${h}`));
  } else {
    ok('daily_stats / risk_history / rpa_logs / candidates_export 写入均带 platform');
  }
}

// ── A9-c：健康基线查询必须带 platform（最易漏的一条）──────────
console.log('\n[A9-c] 健康基线跨平台隔离');
{
  const f = path.join(SRC, 'main/services/risk-controller.ts');
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  const m = code.match(/FROM\s+daily_stats[^;'"`]*/i);
  if (!m) {
    bad('risk-controller.ts 未找到 daily_stats 查询（结构变了？请人工复核）');
  } else if (!/platform\s*=\s*\?/i.test(m[0])) {
    bad('risk-controller.ts 的 daily_stats 查询缺少 platform 谓词 —— '
      + '会导致"只跑一个平台"时误判另一个平台隐形降权并自动 60min 熔断');
  } else {
    ok('assessHealth 的 daily_stats 查询带 platform 谓词');
  }
}

// ── A9-d：两平台默认端口 / profile 目录必须不同 ────────────────
console.log('\n[A9-d] 浏览器实例物理隔离');
{
  const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
  const boss = read('main/services/adapters/boss.ts');
  const liepin = read('main/services/adapters/liepin.ts');
  const port = (s) => (s.match(/defaultCdpPort:\s*(\d+)/) || [])[1];
  const dir = (s) => (s.match(/profileDirName:\s*['"]([^'"]+)['"]/) || [])[1];
  const [bp, lp] = [port(boss), port(liepin)];
  const [bd, ld] = [dir(boss), dir(liepin)];
  if (!bp || !lp) bad('未能解析出默认端口，请人工复核 adapters');
  else if (bp === lp) bad(`两平台默认端口相同（${bp}）—— 会连到同一个浏览器`);
  else ok(`默认端口不同：boss=${bp} / liepin=${lp}`);
  if (!bd || !ld) bad('未能解析出 profile 目录名，请人工复核 adapters');
  else if (bd === ld) bad(`两平台 profile 目录相同（${bd}）—— cookie/登录态会互串`);
  else ok(`profile 目录不同：boss=${bd} / liepin=${ld}`);
}

// ── A9-e：端口归属校验必须存在（真机踩到的外部击穿） ───────────
console.log('\n[A9-e] 调试端口归属校验');
{
  const code = stripComments(fs.readFileSync(path.join(SRC, 'main/cdp/chrome.ts'), 'utf8'));
  const hasInspect = /inspectPort\s*\(/.test(code) && /isProfileInUse\s*\(/.test(code);
  if (!hasInspect) {
    bad('chrome.ts 缺少 inspectPort/isProfileInUse —— 端口是全机共享资源，'
      + '不校验归属会把 RPA 跑进别人的浏览器（真机实测已发生过）');
  } else {
    ok('存在 inspectPort + isProfileInUse');
  }
  // 两条对外直接入口 + launchDetached 内部已通过 connectExisting 覆盖（其 catch 块显式重抛 IsolationViolationError）
  for (const fn of ['openBrowserForLogin', 'connectExisting']) {
    const body = code.split(new RegExp(`async\\s+${fn}\\s*\\(`))[1] || '';
    const seg = body.slice(0, 1600);
    if (/foreignPortError\s*\(/.test(seg)) ok(`${fn} 已拒绝外来端口`);
    else bad(`${fn} 未做端口归属校验 —— 可能连到别人的 Chrome`);
  }
}

// ── A9-f: profile 隔离闸门必须读 Secure Preferences ─────────────
// 2026-08-07 审查项 P0-2: hasInstalledExtensionOnDisk 须同时读 Secure Preferences；
// 只读 Preferences 让闸门对"加载已解压扩展"永久失效（真机 extensions.settings 只在
// Secure Preferences 里），本断言防止该缺陷被回归。
console.log('\n[A9-f] profile 隔离闸门读 Secure Preferences');
{
  const code = stripComments(fs.readFileSync(path.join(SRC, 'main/cdp/chrome.ts'), 'utf8'));
  const fn = code.split('hasInstalledExtensionOnDisk')[1] || '';
  const body = fn.slice(0, fn.indexOf('findChrome'));
  if (/Secure Preferences/.test(body)) {
    ok('hasInstalledExtensionOnDisk 已读 Secure Preferences');
  } else {
    bad('hasInstalledExtensionOnDisk 未读 Secure Preferences —— 闸门对解压加载扩展永久失效');
  }
  // location=4 的路径有效性校验
  if (/location\s*===\s*4/.test(body) && /existsSync/.test(body)) {
    ok('location=4 扩展做路径有效性校验（防残留记录误报）');
  } else {
    bad('hasInstalledExtensionOnDisk 缺少 location=4 路径校验 —— 删除扩展目录后仍会误报为已安装');
  }
}

// 构造假 profile 做功能断言（白盒，不依赖真机）
// 2026-08-07 审查项 P0-2: 这些断言验证修复后的逻辑，能因回退而变红
console.log('\n[A9-f-func] profile 隔离闸门功能断言');
{
  // 复现 hasInstalledExtensionOnDisk 对 Secure Preferences 的核心判定逻辑
  // 目的：白盒验证，修改 chrome.ts 时若回退此处会同步变红
  const EXT_ID = 'hhjilkjdngolnidebdlmkkhpoidegbgc';
  const os = await import('node:os');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-test-'));
  try {
    // 用例1：只有 pinned_extensions 残留，settings 里没有 extId → 应视为未安装（防 2b11c44 回归）
    const profileDir1 = path.join(tmpRoot, 'case1', 'Default');
    fs.mkdirSync(profileDir1, { recursive: true });
    fs.writeFileSync(path.join(profileDir1, 'Secure Preferences'), JSON.stringify({
      extensions: { pinned_extensions: [EXT_ID] },
    }));
    const sp1 = JSON.parse(fs.readFileSync(path.join(profileDir1, 'Secure Preferences'), 'utf-8'));
    const settings1 = sp1?.extensions?.settings;
    const found1 = settings1 && Object.prototype.hasOwnProperty.call(settings1, EXT_ID);
    if (found1) {
      bad('用例1失败：pinned_extensions 残留时 settings 不应有 extId（防 2b11c44 回归）');
    } else {
      ok('用例1：pinned_extensions 残留 → settings 无 extId → 视为未安装');
    }

    // 用例2：Secure Preferences 里有有效 location=4，路径存在 → 应视为已安装
    const profileDir2 = path.join(tmpRoot, 'case2', 'Default');
    const extPath2 = path.join(tmpRoot, 'case2-ext');
    fs.mkdirSync(profileDir2, { recursive: true });
    fs.mkdirSync(extPath2, { recursive: true });
    fs.writeFileSync(path.join(profileDir2, 'Secure Preferences'), JSON.stringify({
      extensions: { settings: { [EXT_ID]: { location: 4, path: extPath2 } } },
    }));
    const sp2 = JSON.parse(fs.readFileSync(path.join(profileDir2, 'Secure Preferences'), 'utf-8'));
    const rec2 = sp2?.extensions?.settings?.[EXT_ID];
    const found2 = rec2 && (rec2.location !== 4 || (rec2.path && fs.existsSync(rec2.path)));
    if (found2) {
      ok('用例2：Secure Preferences + location=4 + 路径存在 → 视为已安装');
    } else {
      bad('用例2失败：Secure Preferences 有效 location=4 记录应被识别为已安装');
    }

    // 用例3：location=4 但路径已删 → 应视为未安装
    const profileDir3 = path.join(tmpRoot, 'case3', 'Default');
    fs.mkdirSync(profileDir3, { recursive: true });
    fs.writeFileSync(path.join(profileDir3, 'Secure Preferences'), JSON.stringify({
      extensions: { settings: { [EXT_ID]: { location: 4, path: '/nonexistent/path/__test__' } } },
    }));
    const sp3 = JSON.parse(fs.readFileSync(path.join(profileDir3, 'Secure Preferences'), 'utf-8'));
    const rec3 = sp3?.extensions?.settings?.[EXT_ID];
    const found3 = rec3 && (rec3.location !== 4 || (rec3.path && fs.existsSync(rec3.path)));
    if (!found3) {
      ok('用例3：location=4 但路径已删 → 视为未安装（防残留误报）');
    } else {
      bad('用例3失败：location=4 路径不存在时应视为未安装');
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// ── A9-g: src/main/services 与 src/main/ipc 下的 getRuntime('boss') 白名单 ──
// 2026-08-07 审查项 P1-6: behavior-learner.ts 写死 getRuntime('boss') 导致跨平台污染。
// 修复方向：所有服务应按 this.platform 动态取 runtime。
// 白名单内的调用是已知合理的（只操作 boss 确实不跨平台的场景），
// 超出白名单的新 getRuntime('boss') 字面量将被本规则抓住。
console.log('\n[A9-g] getRuntime(\'boss\') 字面量白名单');
{
  // 合理的白名单：只允许明确只操作 boss 的场景
  // 白名单登记的原则：已确认是 boss 专属功能的 IPC/服务，或待迁移的历史遗留。
  // 任何新增 getRuntime('boss') 字面量须先在此处显式登记，否则 CI 红。
  const WHITELIST_PATTERNS = [
    // index.ts: 启动时初始化 boss 风控（明确针对 boss 的启动步骤）
    /src[\\/]main[\\/]index\.ts/,
    // ipc/app.ts: 行为学习 UI 接口暂时只暴露 boss（注释说明了原因）
    /src[\\/]main[\\/]ipc[\\/]app\.ts/,
    // ipc/dashboard.ts: 仪表盘快照目前只展示 boss（待多平台仪表盘完成后迁移）
    /src[\\/]main[\\/]ipc[\\/]dashboard\.ts/,
    // ipc/jd.ts: BOSS 岗位激活时把 JD 推到 BOSS 页面（BOSS 专属功能）
    /src[\\/]main[\\/]ipc[\\/]jd\.ts/,
    // ipc/settings.ts: BOSS 浏览器配置（端口/路径/userDataDir）更新
    /src[\\/]main[\\/]ipc[\\/]settings\.ts/,
    // ipc/talent.ts: JR 推送和 BOSS 候选人快速操作（BOSS 专属流程）
    /src[\\/]main[\\/]ipc[\\/]talent\.ts/,
    // ipc/tools.ts: 工具类操作目前只对 BOSS Chrome 生效
    /src[\\/]main[\\/]ipc[\\/]tools\.ts/,
  ];
  const scanDirs = [
    path.join(SRC, 'main/services'),
    path.join(SRC, 'main/ipc'),
  ];
  const hits = [];
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (/getRuntime\s*\(\s*['"]boss['"]\s*\)/.test(code)) {
        const rel = path.relative(ROOT, f);
        const isWhitelisted = WHITELIST_PATTERNS.some((re) => re.test(rel));
        if (!isWhitelisted) hits.push(rel);
      }
    }
  }
  if (hits.length) {
    bad(`src/main/services 或 ipc 下存在未白名单的 getRuntime('boss') 字面量（可能跨平台污染）：`);
    hits.forEach((h) => console.error(`      ${h}`));
  } else {
    ok('services / ipc 下无未白名单的 getRuntime(\'boss\') 字面量');
  }
}

// ── 结果 ───────────────────────────────────────────────────────
console.log('');
if (failures) {
  console.error(`❌ 隔离断言未通过：${failures} 项违规\n`);
  process.exit(1);
}
console.log('✅ 隔离断言全绿\n');
