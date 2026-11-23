/**
 * 构建「飞书需求 → 职位 一键复制」浏览器扩展的单文件 content script。
 *
 * 为什么要有这个脚本（而不是把 content.js 复制一份进 extension/）：
 *   源码是一整个自包含 IIFE，要当 content script 跑得在外面套一层沙箱垫片。
 *   一旦复制成两份，改了平台侧的探测/填充逻辑，插件那份不会跟着变 —— 这个仓库里
 *   已经吃过一次这种亏（飞书两工具复制粘贴漂移）。所以这里【构建期原样内联】，只有一个源。
 *   `--check` 模式在 npm test 里跑：产物与源不同步就直接红，改一处忘了重建会被当场抓住。
 *
 * KNOWN_REQ_FIELDS 单一真源策略：
 *   req2job 和 reqsheet 两个工具各自有提取引擎（特化逻辑不同，不能合并），
 *   但 KNOWN_REQ_FIELDS 字段白名单必须保持一致（两个工具都用它判断字段优先级）。
 *   构建时用 tools/_shared/req-extract.js 里的版本替换 src/content.js 里的那份，
 *   保证两边永远是同一个字段列表。
 *
 * 产物：extension/feishu-req2job/content.bundle.js（需提交，Chrome 直接加载）
 * 源：  extension/feishu-req2job/src/content.js（唯一真源，提取引擎特化版）
 *       tools/_shared/req-extract.js（KNOWN_REQ_FIELDS 的真源）
 *
 * 用法：npm run feishu-ext:build          构建
 *       npm run feishu-ext:check          只校验是否与源同步（不写盘）
 *       npm run feishu-ext:build -- --zip 顺便打个 zip 给 TA
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension', 'feishu-req2job');
// req2job 的主逻辑源（填充引擎特化版）
const SRC = path.join(EXT_DIR, 'src', 'content.js');
// KNOWN_REQ_FIELDS 的唯一真源（两个工具共用的字段白名单）
const SHARED_EXTRACT = path.join(ROOT, 'tools', '_shared', 'req-extract.js');
const OUT_FILE = path.join(EXT_DIR, 'content.bundle.js');
const MANIFEST = path.join(EXT_DIR, 'manifest.json');
const DIST_DIR = path.join(ROOT, 'dist-ext');

const CHECK_ONLY = process.argv.includes('--check');
const WANT_ZIP = process.argv.includes('--zip');

const read = (p) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
const fail = (msg) => { console.error('✗ [build-feishu-ext] ' + msg); process.exit(1); };

for (const p of [SRC, MANIFEST, SHARED_EXTRACT]) {
  if (!fs.existsSync(p)) fail(`源缺失：${path.relative(ROOT, p)}`);
}

const toolSrcRaw = read(SRC);
const sharedExtractSrc = read(SHARED_EXTRACT);
const version = JSON.parse(read(MANIFEST)).version;

// ── KNOWN_REQ_FIELDS 同步：用 _shared/req-extract.js 的版本替换 src/content.js 里的 ──
// 只替换这个数组，保留 req2job 的特化提取引擎（isOurs/labelOf/itemsFrom 等有不同实现）
function extractKnownReqFields(src) {
  const m = src.match(/var KNOWN_REQ_FIELDS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  return 'var KNOWN_REQ_FIELDS = [' + m[1] + '];';
}
const sharedFields = extractKnownReqFields(sharedExtractSrc);
if (!sharedFields) fail('_shared/req-extract.js 里找不到 KNOWN_REQ_FIELDS 定义');

// 替换 src/content.js 里的 KNOWN_REQ_FIELDS（可能有注释）
const toolSrc = toolSrcRaw.replace(
  /var KNOWN_REQ_FIELDS\s*=\s*\[([\s\S]*?)\];/,
  sharedFields
);

// ── 源必须仍是那个自包含 IIFE ───────────────────────────────────────────────
// 内联的前提是「工具源自己就是一个闭包，不往全局挂东西」。形态变了就必须重新审这个脚本，
// 而不是让它悄悄产出一个会污染页面全局的 bundle。
if (!/^\(function\s*\(\s*\)\s*\{/m.test(toolSrc.trimStart())) {
  fail('content.js 的开头形态变了（不再是自执行 IIFE），内联前提失效 —— 请同步更新本脚本');
}

/**
 * 沙箱垫片。
 * 平台侧工具跑在 TA 沙箱里，会拿到两个由沙箱注入的东西：
 *   · CONFIG            —— 工具配置（debug / workUrl）
 *   · __TA_ON_STOP__    —— 平台停用工具时的清理钩子
 * 扩展里没有沙箱，但工具源对这两个都是 `typeof` 保护过的，缺了也能跑。
 * 这里仍然把它们补齐：一是让 debug 可以通过页面 localStorage 打开（真机排查用），
 * 二是把停止钩子接到 chrome.runtime 的失效事件上 —— 扩展被禁用/更新时，
 * 旧实例的 1s 轮询与面板必须能自己收摊，否则表现就是"关了还在"。
 */
const shim = `
  // ——— 沙箱垫片（扩展环境）———
  var CONFIG = { debug: false, workUrl: '' };
  try { CONFIG.debug = localStorage.getItem('ta-req2job:debug') === '1'; } catch (e) {}
  var __TA_STOP_FNS__ = [];
  function __TA_ON_STOP__(fn) { if (typeof fn === 'function') __TA_STOP_FNS__.push(fn); }
  function __taStopAll__() {
    while (__TA_STOP_FNS__.length) { try { __TA_STOP_FNS__.pop()(); } catch (e) {} }
  }
  // 扩展被禁用/重载时 chrome.runtime.id 会消失；轮询到就自我了断，避免"关不掉"的旧实例。
  // ⚠️ 只有【启动时确实在扩展里】才武装这个看门狗。否则在没有 chrome.runtime 的环境
  // （逻辑层测试台把本产物直接注进普通页面）第一次轮询就会判成"扩展没了"而把自己停掉，
  // 表现是面板出现 3 秒后凭空消失 —— 那是看门狗自己造成的故障，不是被测对象的问题。
  var __inExtension = false;
  try { __inExtension = !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { __inExtension = false; }
  if (__inExtension) {
    var __alive = setInterval(function () {
      var gone = false;
      try { gone = !(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { gone = true; }
      if (gone) { clearInterval(__alive); __taStopAll__(); }
    }, 3000);
  }
`;

const banner = `/**
 * 飞书需求 → 职位 一键复制  v${version} — 扩展打包版
 *
 * ⚠ 本文件由 scripts/build-feishu-ext.mjs 自动生成，不要手改。
 *   改源：extension/feishu-req2job/src/content.js（主逻辑真源）
 *         tools/_shared/req-extract.js（KNOWN_REQ_FIELDS 真源，构建时替换）
 *   重建：npm run feishu-ext:build
 *
 * 行为边界（勿改）：
 *   · 零平台请求：不向 feishu.cn 发任何 fetch/XHR/WebSocket，只操作页面【已渲染】的 DOM
 *   · 绝不自动提交：走完向导第 3 步就停在「保存并完成更多设置」之前，提交永远由人来点
 *   · 审批门禁：只对「审批通过」的需求放行；读不到审批状态时保守拒绝
 *   · 单一 IIFE 闭包，不往页面 window 挂任何东西
 *   · 只在顶层 frame 运行；不申请任何 Chrome 权限（无 storage / 无 host_permissions）
 */
`;

const bundle = banner + '(function () {\n' + shim + '\n' + toolSrc + '\n})();\n';

// ── 校验 / 写盘 ─────────────────────────────────────────────────────────────
const prev = fs.existsSync(OUT_FILE) ? read(OUT_FILE) : null;
if (CHECK_ONLY) {
  if (prev === null) fail('产物不存在，请先跑 npm run feishu-ext:build');
  if (prev !== bundle) {
    fail('产物与源不同步 —— 改了 src/content.js 却没重建插件。跑：npm run feishu-ext:build');
  }
  console.log(`✓ [build-feishu-ext] 产物与源同步（v${version}，${bundle.length} 字节）`);
  process.exit(0);
}

fs.mkdirSync(EXT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, bundle, 'utf-8');
console.log(`✓ [build-feishu-ext] 已生成 ${path.relative(ROOT, OUT_FILE)}（v${version}，${bundle.length} 字节）`);

if (WANT_ZIP) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const zipPath = path.join(DIST_DIR, `feishu-req2job-v${version}.zip`);
  try { fs.rmSync(zipPath, { force: true }); } catch (e) {}
  // 用 PowerShell 打包，免掉一个 zip 依赖
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${EXT_DIR}\\*' -DestinationPath '${zipPath}' -Force`,
  ], { stdio: 'inherit' });
  console.log(`✓ [build-feishu-ext] 已打包 ${path.relative(ROOT, zipPath)}`);
}
