/**
 * 构建「TA 匹配分助手」浏览器扩展的单文件 content script。
 *
 * 为什么要有这个脚本：content.bundle.js 之前是手写维护的，而评分引擎在
 * src/shared/scoring-universal.js 里还有一份——两份实现必然漂移（改了平台侧
 * 的评分逻辑，插件里那份不会跟着变）。现在引擎在构建时【原样内联】，只有一个源。
 *
 * 产物：extension/boss-match-score/content.bundle.js（需提交，Chrome 直接加载）
 * 源：  extension/boss-match-score/parts/*.js + src/shared/scoring-universal.js
 *
 * 用法：npm run ext:build        构建并校验
 *       npm run ext:build -- --check   只校验产物是否与源同步（CI/提交前用，不写盘）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension', 'boss-match-score');
const PARTS_DIR = path.join(EXT_DIR, 'parts');
const ENGINE_SRC = path.join(ROOT, 'src', 'shared', 'scoring-universal.js');
const SEMANTIC_SRC = path.join(ROOT, 'src', 'shared', 'semantic-provider.js');
const OUT_FILE = path.join(EXT_DIR, 'content.bundle.js');

const CHECK_ONLY = process.argv.includes('--check');

const read = (p) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
const fail = (msg) => { console.error('✗ [build-ext] ' + msg); process.exit(1); };

// ── 1. 读源 ─────────────────────────────────────────────────────────────
//   10-tinyseg.js 与 20-semantic.js 的真实内容已于 2026-07-31 迁移到
//   src/shared/semantic-provider.js（与主进程共用，单一真源）。
//   parts 下这两个文件保留为占位（仅含说明注释），不参与内联——真实代码直接读共享源。
for (const p of [PARTS_DIR, ENGINE_SRC, SEMANTIC_SRC]) {
  if (!fs.existsSync(p)) fail(`源缺失：${path.relative(ROOT, p)}`);
}
const partFiles = fs.readdirSync(PARTS_DIR).filter((f) => f.endsWith('.js')).sort();
const EXPECTED_PARTS = ['10-tinyseg.js', '20-semantic.js', '30-content.js', '40-structure.js'];
if (EXPECTED_PARTS.some((f) => !partFiles.includes(f))) {
  fail(`parts/ 缺文件，期望 ${EXPECTED_PARTS.join(', ')}，实际 ${partFiles.join(', ')}`);
}
// 占位文件必须确实是占位（不允许偷偷往里面塞代码，否则会出现"两份语义实现"漂移）
for (const ph of ['10-tinyseg.js', '20-semantic.js']) {
  const body = read(path.join(PARTS_DIR, ph)).trim();
  if (!/^\/\/\s*(占位|已迁移|migrated|deprecated)/i.test(body)) {
    fail(`${ph} 必须是仅含注释的占位文件（真实内容在 src/shared/semantic-provider.js，禁止在这里塞代码）`);
  }
}

// ⚠️ 语义 provider 默认开关——必须与 src/main/services/scoring.ts 里的 SEMANTIC_ENABLED 保持一致。
// 任务 B 决策期（2026-07-31）：默认关（false，方案乙=纯字面匹配），避免把插件现有"涨过头"的语义
// 带进平台；等用户根据 score:eval 三组对照数据拍板后，再同步切换两边。
// contract-check 会断言两边取值一致，改一处忘改另一处会直接在 npm test 失败。
const SEMANTIC_ENABLED_IN_BUNDLE = false;

// ── 2. 内联共享模块（评分引擎 + 语义 provider）───────────────────────────────
// 两个共享模块结尾都是 })(typeof window !== 'undefined' ? window : ...)，直接内联会往
// isolated world 的 window 上挂 __TA_SCORE__ / __TA_SEMANTIC__。改成挂在局部对象上：零全局变量。
const engineRaw = read(ENGINE_SRC);
const TAIL_RE = /\}\)\(\s*typeof window[^;]*\);?\s*$/;
if (!TAIL_RE.test(engineRaw.trimEnd())) {
  fail('scoring-universal.js 的结尾形态变了，内联替换失效——请同步更新本脚本的 TAIL_RE');
}
const engineInlined = engineRaw.trimEnd().replace(TAIL_RE, '})(__engineRoot);');

const semRaw = read(SEMANTIC_SRC);
if (!TAIL_RE.test(semRaw.trimEnd())) {
  fail('semantic-provider.js 的结尾形态变了，内联替换失效——请同步更新本脚本的 TAIL_RE');
}
const semInlined = semRaw.trimEnd().replace(TAIL_RE, '})(__semRoot);');

// ── 3. 拼装 ─────────────────────────────────────────────────────────────
const banner = `/**
 * TA 匹配分助手 v2 — 单文件打包版
 *
 * ⚠ 本文件由 scripts/build-ext.mjs 自动生成，不要手改。
 *   改源：
 *     · 评分引擎：src/shared/scoring-universal.js
 *     · 语义/分词：src/shared/semantic-provider.js（与主进程 scoring.ts 共用，单一真源）
 *     · content 主逻辑：extension/boss-match-score/parts/30-content.js / 40-structure.js
 *   重建：npm run ext:build
 *
 * 风险边界（勿改）：
 *   · 零平台请求：不向 zhipin.com 发任何 fetch/XHR/WebSocket，只读页面【已渲染】的 DOM 文本
 *   · 只读不写：不点击、不打招呼、不收藏、不改页面数据、不碰 localStorage/IndexedDB
 *   · Shadow DOM (mode:'closed') 隔离展示，宿主元素内联样式，不注入全局 CSS 规则
 *   · 单一 IIFE 闭包，零全局变量（评分引擎/语义模块内联到局部对象，不挂 window）
 *   · WeakMap 跟踪已评分卡片，不在 BOSS 的 DOM 上写 data-* 属性
 *   · 只在顶层 frame 运行
 *
 * 已知痕迹（据实说明，不粉饰）：每张候选人卡片会被插入一个 <span> 宿主元素；
 * 卡片 position:static 时会被补成 relative。这是贴徽章的最小代价，无法为零。
 *
 * 定时器：路由巡检 1.5s（只比 location.href 字符串）+ 兜底重扫 5s。
 * 内嵌顺序：分词+语义（内联自 src/shared/semantic-provider.js）→ 评分引擎（内联自 src/shared/scoring-universal.js）→ content 主逻辑
 */
(function () {
  'use strict';

  // ⚠️ 这里【绝不能】再加"在子帧里直接 return"的早退语句。
  // 2026-07-29：manifest 的 all_frames 已由 false 改为 true，因为 BOSS 招聘端的候选人卡片
  // 全部渲染在 /web/frame/recommend/ 子帧里，顶层文档上一张卡都没有。
  // 而这条 banner 早退语句在打包产物的最外层 IIFE 第一句，会让脚本在【每一个子帧】里
  // 立刻返回 —— 它把 all_frames 的修复整个抵消掉了，扩展在真正有卡片的帧上一行都不执行，
  // 表现仍然是"装好了却什么都不显示"，而构建校验还是绿的。
  // 帧过滤由 content 主逻辑的 frameWorthRunning() 承担（它只跑招聘业务帧，且顶层永远跑）。
`;

// 语义模块内联总是做（工厂代码必须在产物里）；是否 _调用_ setSemanticProvider 由开关决定。
// 关：只挂 _sem 到局部，不注入引擎（方案乙，纯字面），但 _sem 对象保留供将来开关切换。
//    注意：这里的 return 语句不能把整个 content 退出——不注入语义不等于不跑插件。
const semInjectLine = SEMANTIC_ENABLED_IN_BUNDLE
  ? '  TA_ENGINE.setSemanticProvider(_sem);'
  : '  // 语义 provider 已内联但未注入（SEMANTIC_ENABLED_IN_BUNDLE=false，方案乙·纯字面匹配）。决策后切换 build-ext.mjs 与 scoring.ts 的开关即可。';

const sections = [
  ['模块 1+2: 分词 + 语义 provider（构建时原样内联自 src/shared/semantic-provider.js，主进程共用此源）',
    `  var __semRoot = {};\n${semInlined}\n  var _sem = __semRoot.__TA_SEMANTIC__.createSemanticProvider();\n` +
    `  // 暴露 _similarity / _kwSim / _tokenize / _cut 到外层 IIFE 作用域——30-content.js 里\n` +
    `  // 的岗位自动识别走 _similarity(q, lbl)，这些名字是旧 parts/20-semantic.js 在闭包\n` +
    `  // 顶层 var 声明的，工厂化后它们变成局部变量，必须显式别名给 content 主逻辑用。\n` +
    `  var _similarity = _sem.similarity;\n` +
    `  var _kwSim = _sem.kwSim;\n` +
    `  var _tokenize = _sem.tokenize;\n` +
    `  var _cut = _sem.tokenize;   // 旧 10-tinyseg.js 顶层的 _cut，新工厂用 tokenize 替代（底层同一实现）`],
  ['模块 3: 评分引擎（构建时原样内联自 src/shared/scoring-universal.js）',
    `  var __engineRoot = {};\n${engineInlined}\n  var TA_ENGINE = __engineRoot.__TA_SCORE__;\n  if (!TA_ENGINE) return;\n${semInjectLine}`],
  ['模块 4: content 主逻辑', read(path.join(PARTS_DIR, '30-content.js'))],
  ['模块 5: 页面结构采样器（仅在用户点选项页按钮时触发，零常驻开销）', read(path.join(PARTS_DIR, '40-structure.js'))],
];

let out = banner;
for (const [title, body] of sections) {
  out += `\n  // ================================================================\n`;
  out += `  // ${title}\n`;
  out += `  // ================================================================\n`;
  out += body.replace(/\s+$/, '') + '\n';
}
out += '})();\n';

// ── 4. 校验（这些断言就是上一版翻车的那几条，固化成防回归闸门）────────────
function assert(cond, msg) { if (!cond) fail('产物校验未过：' + msg); }

// 4.1 语法必须合法
try { new vm.Script(out, { filename: 'content.bundle.js' }); }
catch (e) { fail('产物语法错误：' + e.message); }

// 注释里会正常提到 fetch / zhipin.com 这些词（风险边界说明），所以下面的扫描针对剥掉
// 注释后的代码正文。剥离是朴素实现：先去块注释，再去行注释（避开 http:// 里的双斜杠）。
const codeOnly = out
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// 4.2 零平台请求：不得出现任何网络 API
const NET_RE = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts)/;
assert(!NET_RE.test(codeOnly), '出现了网络 API（本扩展必须零平台请求）');
assert(!/zhipin\.com/.test(codeOnly), '代码正文出现 zhipin.com 字面量');

// 4.3 不得模拟用户行为
assert(!/\.click\s*\(\s*\)|dispatchEvent\s*\(/.test(codeOnly), '出现了模拟点击 / dispatchEvent');

// 4.4 closed shadow 回归闸门：宿主是 mode:'closed'，host.shadowRoot 恒为 null。
//     上一版就是全篇用 host.shadowRoot 取根，导致徽章一个都渲染不出来。
assert(/attachShadow\(\{\s*mode:\s*'closed'/.test(out), 'shadow 不再是 closed 模式（若确要改，请同步改本断言）');
const shadowRootReads = codeOnly.match(/\.shadowRoot/g) || [];
assert(shadowRootReads.length === 0, `代码里还有 ${shadowRootReads.length} 处读 .shadowRoot——closed 模式下它恒为 null，必须改用 rootForCard 缓存`);

// 4.5 引擎确实内联进来了，且没有污染全局
assert(/__engineRoot\s*=\s*\{\}/.test(codeOnly) && /\}\)\(__engineRoot\)/.test(codeOnly), '评分引擎内联失败');
assert(/root\.__TA_SCORE__\s*=\s*api/.test(codeOnly), '引擎导出形态异常');
assert(!/window\.__TA_SCORE__/.test(codeOnly), '引擎仍在往 window 上挂 __TA_SCORE__');

// 4.5.1 语义 provider 必须从 src/shared/semantic-provider.js 内联（B1 同源契约）
assert(/__semRoot\s*=\s*\{\}/.test(codeOnly) && /\}\)\(__semRoot\)/.test(codeOnly),
  'semantic provider 内联失败（未挂到 __semRoot 局部对象）');
assert(/createSemanticProvider/.test(codeOnly) && /__TA_SEMANTIC__/.test(codeOnly),
  'semantic provider 工厂未出现——产物里缺语义模块');
// 注入与否由 SEMANTIC_ENABLED_IN_BUNDLE 开关决定——断言开关与代码一致
if (SEMANTIC_ENABLED_IN_BUNDLE) {
  assert(/TA_ENGINE\.setSemanticProvider\(_sem\)/.test(codeOnly),
    '开关为 true 但产物里没找到 TA_ENGINE.setSemanticProvider(_sem) 注入');
} else {
  assert(!/TA_ENGINE\.setSemanticProvider\(_sem\)/.test(codeOnly),
    '开关为 false 但产物里仍有 TA_ENGINE.setSemanticProvider(_sem) 注入——两边会漂移');
  assert(/SEMANTIC_ENABLED_IN_BUNDLE\s*=\s*false/.test(out) || /语义 provider 已内联但未注入/.test(out),
    '开关为 false 时产物里应留说明注释（决策期留痕）');
}
// 防漂移：产物中【不得】出现第二份手写的 SYNONYMS/HYPERNYMS 表（旧 parts/20-semantic.js 内容），
// 否则说明有两份词表，改了共享源不会反映到插件。
const synonymDecls = (codeOnly.match(/\bvar\s+SYNONYMS\s*=/g) || []).length;
assert(synonymDecls === 1, `语义同义词表声明出现 ${synonymDecls} 次（期望 1）——可能存在双份词表漂移`);
const hyperDecls = (codeOnly.match(/\bvar\s+HYPERNYMS\s*=/g) || []).length;
assert(hyperDecls === 1, `上位词表声明出现 ${hyperDecls} 次（期望 1）——可能存在双份词表漂移`);

// 4.6 引擎字段契约：content 用的是全名字段，别再退回缩写版
for (const f of ['mismatchReasons', 'missingCount', 'dimension']) {
  assert(codeOnly.includes(f), `缺少引擎字段 ${f}，content 与引擎的字段契约对不上`);
}

// 4.6.5 「用户零风险」不变量 —— 这几条是这个插件敢装在真实招聘账号上的全部依据，
// 任何一条被破坏都必须在构建期就拦住，而不是等真机出事。
// 依据：BOSS 风险登记册 §4.5（平台会扫 localStorage、会检测自动化全局、会统计请求频率）。
{
  // ① 绝不向 zhipin 或任何外部地址发请求：唯一允许的网络目标是本机回环桥。
  const netCalls = codeOnly.match(/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/g) || [];
  assert(netCalls.length === 0,
    `content script 里出现了网络调用（${netCalls.join(',')}）——插件必须零平台请求，联网只能由 background 走 127.0.0.1`);
  // ② 绝不碰页面的 localStorage / sessionStorage / cookie。
  //    登记册实测 BOSS 会扫 localStorage 并上报 p2=51002「来源异常」，碰它等于主动送把柄。
  assert(!/\blocalStorage\b|\bsessionStorage\b|document\.cookie/.test(codeOnly),
    'content script 碰了页面存储（localStorage/sessionStorage/cookie）——BOSS 会扫这些，必须改用 chrome.storage');
  // ③ 绝不往主世界注入脚本、绝不 eval：content script 只该待在隔离世界里。
  assert(!/createElement\(['"]script['"]\)|\beval\s*\(|new\s+Function\s*\(/.test(codeOnly),
    'content script 出现了主世界注入或动态执行（script 标签 / eval / new Function）');
  // ④ 绝不替用户点击或填写：插件只读不写，一切外呼动作必须由真人自己点。
  assert(!/\.click\(\)|dispatchEvent\(\s*new\s+(Mouse|Pointer|Keyboard)Event/.test(codeOnly),
    'content script 出现了模拟点击/按键——插件不得替用户做任何对平台的动作');
  // ⑤ 徽章只能"追加到卡片末尾"，不得插进 BOSS 组件树的兄弟序列中间
  //    （insertBefore 到别人的子节点之间，既容易被 Vue 重渲染清掉，也最可能干扰页面本身）。
  assert(!/insertBefore\(/.test(codeOnly),
    '出现了 insertBefore——徽章必须用 appendChild 追加到卡片末尾 + 绝对定位，不得插进 BOSS 的组件树中间');
  // ⑥ 权限最小面：只允许 storage + alarms，网络主机只允许本机回环。
  const mfEarly = JSON.parse(read(path.join(EXT_DIR, 'manifest.json')));
  const perms = (mfEarly.permissions || []).slice().sort().join(',');
  assert(perms === 'alarms,storage', `权限清单变了（${perms}）——只允许 storage + alarms`);
  assert(JSON.stringify(mfEarly.host_permissions || []) === JSON.stringify(['http://127.0.0.1:17385/*']),
    'host_permissions 只允许本机回环 127.0.0.1:17385，绝不能出现 zhipin.com');
}

// 4.7 manifest 与产物对得上
const mf = JSON.parse(read(path.join(EXT_DIR, 'manifest.json')));
const cs = (mf.content_scripts || [])[0] || {};
assert(Array.isArray(cs.js) && cs.js.length === 1 && cs.js[0] === 'content.bundle.js',
  'manifest 的 content_scripts.js 必须只有 content.bundle.js（多文件加载模式已废弃）');
assert(!cs.css, 'manifest 不该再引用 css：样式全部走 Shadow DOM');
// ⚠️ 这条断言 2026-07-29 由 false 反转为 true，是修复"装了却什么都不显示"的根因。
// BOSS 招聘端的候选人卡片全部渲染在 /web/frame/recommend/ 这个 iframe 内，
// 顶层文档 /web/chat/recommend 上 li.card-item 恒为 0（RPA 侧真机验证过多次）。
// all_frames:false 时脚本只跑顶层 → 永远选不到任何一张卡 → 一个徽章都出不来。
// 旧断言只是把这个错误假设写死了，没有任何安全理由；现在反过来锁住正确的口径。
// 帧内的浪费由 content script 的 frameWorthRunning() 兜住（无关帧直接不启动）。
assert(cs.all_frames === true, 'all_frames 必须为 true（候选人卡片在 /web/frame/recommend/ 子帧里，顶层看不到）');
// 与上一条配套：产物里绝不能有"子帧直接 return"的早退，否则 all_frames 等于没改。
// 这两条必须一起看——只断言 manifest 而不查产物，正是 2026-07-29 那次
// "修复被 banner 抵消、构建却全绿"的原因。
assert(!/window\.top\s*!==\s*window\.self\s*\)\s*return/.test(out),
  '产物里出现了"子帧直接 return"，会把 all_frames:true 整个抵消（帧过滤应由 frameWorthRunning 承担）');
// Chrome 的 match pattern 里 "/a/b/*" 匹配不到 "/a/b" 本身，也匹配不到 "/a/b?x=1"。
// BOSS 的推荐页 URL 恰恰是 /web/frame/recommend?jobId=... 这种形态，写成带尾斜杠等于漏掉。
for (const m of cs.matches || []) {
  assert(!/\/\*$/.test(m) || /\/web\/\*$/.test(m),
    `match pattern "${m}" 以 "/*" 结尾，匹配不到不带尾斜杠的同名路径（如 ?query 直挂在后面时）`);
}
assert(!(mf.permissions || []).includes('tabs'), '不该申请 tabs 权限：JD 更新走 storage.onChanged 即可');
assert((mf.host_permissions || []).every((h) => h.includes('127.0.0.1')), 'host_permissions 只允许本机回环');

// ── 5. 落盘 / 校验模式 ──────────────────────────────────────────────────
const prev = fs.existsSync(OUT_FILE) ? read(OUT_FILE) : null;
const same = prev !== null && prev.replace(/\s+$/, '') === out.replace(/\s+$/, '');

if (CHECK_ONLY) {
  if (!same) fail('content.bundle.js 与源不同步，请先跑 npm run ext:build');
  console.log('✓ [build-ext] 产物与源同步，校验全过');
  process.exit(0);
}

if (same) {
  console.log('✓ [build-ext] 产物无变化（校验全过）');
} else {
  fs.writeFileSync(OUT_FILE, out, 'utf-8');
  console.log(`✓ [build-ext] 已生成 ${path.relative(ROOT, OUT_FILE)}（${(Buffer.byteLength(out) / 1024).toFixed(1)} KB，${out.split('\n').length} 行）`);
}
