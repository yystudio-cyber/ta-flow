/**
 * 跨线契约自检 —— 纯静态比对，不依赖平台在跑、不依赖 Chrome，可无条件进 npm test。
 *
 * 为什么需要它：
 * 匹配分插件（线2）与平台（线1）之间靠三个"约定值"连着——扩展 ID、桥端口、以及
 * 插件包必须与平台侧评分引擎同源。这三个值此前在【四个文件里各写各的】，没有任何
 * 一处引用另一处：
 *   · jd-bridge.ts 的 EXTENSION_ID / JD_BRIDGE_PORT
 *   · manifest.json 的 key（决定真实扩展 ID）与 host_permissions 里的端口
 *   · background.js 的 BRIDGE_BASE
 *   · check-bridge.mjs / test-ext-e2e.mjs 里的硬编码副本
 * 改任一处而漏改其它处，后果不是"报错"，而是【CORS 403 → 插件退回旧缓存 → 用过期 JD
 * 静默打分】，而所有测试照样全绿。这正是最难自查的一类故障，所以必须有一道静态闸门。
 *
 * 用法：node scripts/contract-check.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}

// ── 1) 平台侧的两个常量（唯一真源）──────────────────────────────────────────
const bridgeSrc = read('src/main/services/jd-bridge.ts');
const platExtId = (bridgeSrc.match(/EXTENSION_ID\s*=\s*'([a-z]+)'/) || [])[1];
const platPort = (bridgeSrc.match(/JD_BRIDGE_PORT\s*=\s*(\d+)/) || [])[1];
ok(!!platExtId, '平台侧读到 EXTENSION_ID', platExtId);
ok(!!platPort, '平台侧读到 JD_BRIDGE_PORT', platPort);

// ── 2) 扩展后台请求的地址必须指向同一个端口 ────────────────────────────────
const bgSrc = read('extension/boss-match-score/background.js');
const bgPort = (bgSrc.match(/BRIDGE_BASE\s*=\s*['"`]http:\/\/127\.0\.0\.1:(\d+)/) || [])[1];
ok(bgPort === platPort, '插件 background 的桥端口 == 平台的 JD_BRIDGE_PORT',
  `插件 ${bgPort} / 平台 ${platPort}`);

// ── 3) manifest 的 host_permissions 必须放行同一个端口 ─────────────────────
const manifest = JSON.parse(read('extension/boss-match-score/manifest.json'));
const hosts = (manifest.host_permissions || []).join(' ');
ok(hosts.includes(`127.0.0.1:${platPort}`), 'manifest host_permissions 放行了桥端口',
  hosts || '(空)');

// ── 4) manifest 必须 pin 住 key（扩展 ID 恒定，CORS 白名单才有意义）────────
// 没有 key 的话每次「加载已解压」都会分配一个新 ID，平台的 CORS 白名单必然对不上，
// 表现就是装好了但一条数据也拿不到。
ok(typeof manifest.key === 'string' && manifest.key.length > 50,
  'manifest 钉住了 key（扩展 ID 恒定）', manifest.key ? `key 长度 ${manifest.key.length}` : '(缺失)');

// ── 5) 测试脚本里的硬编码副本不得与真源漂移 ────────────────────────────────
for (const f of ['scripts/check-bridge.mjs', 'scripts/test-ext-e2e.mjs']) {
  const s = read(f);
  const ids = [...s.matchAll(/['"]([a-p]{32})['"]/g)].map((m) => m[1]);
  const badId = ids.find((x) => x !== platExtId);
  ok(!badId, `${f} 里的扩展 ID 与平台一致`, badId ? `发现 ${badId}` : (ids[0] || '(未硬编码)'));
  const ports = [...s.matchAll(/\b(17\d{3})\b/g)].map((m) => m[1]);
  const badPort = ports.find((x) => x !== platPort);
  ok(!badPort, `${f} 里的桥端口与平台一致`, badPort ? `发现 ${badPort}` : (ports[0] || '(未硬编码)'));
}

// ── 6) 插件包必须与平台侧评分引擎同源（内联的那份不能过期）────────────────
// ext:check 已经在比对整包，这里只做一条独立的粗校验：引擎里最具标识性的函数名，
// 在平台源码里有、在插件产物里也必须有。防的是"引擎改了、包没重建"这种漂移。
const engine = read('src/shared/scoring-universal.js');
const bundle = read('extension/boss-match-score/content.bundle.js');
const marker = (engine.match(/function\s+(score[A-Za-z]\w*)/) || [])[1];
ok(!!marker && bundle.includes(marker), '插件包里内联的评分引擎与平台同源（标识函数存在）',
  marker ? `标识函数 ${marker}` : '(未找到标识函数)');

// ── 7) 工具浏览器的保留资源不得与 RPA 默认端口相撞 ────────────────────────
const chromeSrc = read('src/main/cdp/chrome.ts');
const toolsPort = (chromeSrc.match(/TOOLS_CDP_PORT\s*=\s*(\d+)/) || [])[1];
const rpaDefaultPort = (chromeSrc.match(/cdpPort:\s*number\s*=\s*(\d+)/) || [])[1];
ok(!!toolsPort && toolsPort !== rpaDefaultPort, '工具浏览器端口与 RPA 默认端口不相撞',
  `工具 ${toolsPort} / RPA ${rpaDefaultPort}`);
const settingsSrc = read('src/main/ipc/settings.ts');
ok(settingsSrc.includes('TOOLS_CDP_PORT'), '设置校验引用了工具端口常量（拒绝把 RPA 配成 9333）');
ok(settingsSrc.includes('TOOLS_PROFILE_DIR_NAME'), '设置校验引用了工具 profile 常量（拒绝两实例同 profile）');

// ── 8) 四线隔离·插件线与 RPA 线的隔离闸门（2026-07-30 新增）───────────────
// 背景：匹配分插件装在用户日常 Chrome（零风险前提：不被 puppeteer 附着、不发平台请求）；
// RPA 专用 Chrome 必须被 puppeteer 附着（接受一定风险）。两条线浏览器/profile 必须彻底隔离，
// 任何一道闸门被静默删掉都会把插件线暴露在 CDP 自动化检测下。
// 下列断言保证代码里这些检查点真实存在、且常量引用自真源，不会静默失效。
// 8a) 必须存在默认浏览器 profile 黑名单方法（R1 设置层 + R2 启动层共用）
ok(chromeSrc.includes('isDefaultBrowserProfile'),
  'chrome.ts 定义了 isDefaultBrowserProfile 默认 profile 黑名单方法');
const defaultProfileSample = ['Google', 'Chrome', 'User Data', 'Microsoft', 'Edge'];
for (const token of defaultProfileSample) {
  ok(chromeSrc.includes(`'${token}'`) || chromeSrc.includes(`"${token}"`),
    `默认浏览器 profile 黑名单包含 "${token}" 目录段`);
}
// 8b) 设置层必须调用 isDefaultBrowserProfile（R1 软闸门：命中丢弃并 warn）
ok(settingsSrc.includes('isDefaultBrowserProfile'),
  '设置校验（settings.ts）调用了 isDefaultBrowserProfile（R1 黑名单）');
// 8c) 三处启动路径（launch / launchDetached / openBrowserForLogin）都必须在删 Singleton* 前做硬校验（R2 兜底）。
// 判定方式：每个方法里在首次 fs.rmSync Singleton* 之前必须出现 'isDefaultBrowserProfile'。
// 这里用粗粒度计数：isDefaultBrowserProfile 在 chrome.ts 至少出现 4 次
//   （1 次定义 + 3 处启动路径调用），低于 4 次就是少了某处启动检查。
const occurrences = (chromeSrc.match(/isDefaultBrowserProfile/g) || []).length;
ok(occurrences >= 4,
  `R2 启动层兜底覆盖三处启动路径（isDefaultBrowserProfile 出现 ${occurrences} 次，期望 ≥4：1 处定义 + 3 处调用）`);
// 额外：fs.rmSync 删 SingletonLock 之前必须先出现 isDefaultBrowserProfile 校验（防止有人把校验挪到 rmSync 之后）。
// 锚点用真正的删除动作："['SingletonLock'"（for 循环数组里），单纯注释里提到 SingletonLock 不算。
const rmSyncRegex = /\['SingletonLock',\s*'SingletonSocket',\s*'SingletonCookie'\]/g;
const rmSyncIdxs = [];
{
  let m;
  while ((m = rmSyncRegex.exec(chromeSrc)) !== null) rmSyncIdxs.push(m.index);
}
ok(rmSyncIdxs.length === 3,
  `Singleton 锁清理循环恰好 3 处（三启动路径各一，实际 ${rmSyncIdxs.length} 处；多于 3 表示多了启动路径未加校验，少于 3 表示有路径漏了清理）`);
// 每处 fs.rmSync 清理循环前面 1500 字符内必须有 isDefaultBrowserProfile 校验
for (let i = 0; i < rmSyncIdxs.length; i++) {
  const pos = rmSyncIdxs[i];
  const window = chromeSrc.slice(Math.max(0, pos - 1500), pos);
  ok(window.includes('isDefaultBrowserProfile'),
    `第 ${i + 1} 处 Singleton 锁 rmSync 之前 1500 字符内有 isDefaultBrowserProfile 校验（防止不可逆删除发生在校验前）`);
}
// 8d) connectExisting 必须有"拒绝附着"的插件扫描（R3 连接层拦截 G2）
ok(chromeSrc.includes('rejectExtensionIds'),
  'ChromeManager 支持 rejectExtensionIds 配置（R3 拒附着插件清单）');
ok(chromeSrc.includes('拒绝附着'),
  'connectExisting 在命中被禁扩展时抛出以「拒绝附着」开头的错误（R3 抛错锚点）');
ok(chromeSrc.includes('service_worker'),
  'connectExisting 通过 service_worker / background_page target 识别已装扩展（R3 识别手段）');
// chromeManager 实例必须传 rejectExtensionIds 且 ID 来自 jd-bridge 导入
ok(chromeSrc.includes('MATCH_SCORE_EXTENSION_ID'),
  'chromeManager 构造时引用 MATCH_SCORE_EXTENSION_ID（R3 拒匹配分插件，非硬编码副本）');
// 8e) import 必须从 jd-bridge 导入 EXTENSION_ID（单一真源契约）
ok(chromeSrc.includes("from '../services/jd-bridge'") && chromeSrc.includes('EXTENSION_ID'),
  'chrome.ts 从 jd-bridge 导入 EXTENSION_ID（唯一真源，不漂移）');
// 8f) R4 反向告警：启动时检查 RPA profile 是否装了插件
ok(chromeSrc.includes('hasInstalledExtensionOnDisk'),
  'ChromeManager 提供 hasInstalledExtensionOnDisk 方法（R4 反向告警·磁盘扫描）');
const indexSrc = read('src/main/index.ts');
ok(indexSrc.includes('hasInstalledExtensionOnDisk') && indexSrc.includes('MATCH_SCORE_EXTENSION_ID'),
  '主进程启动时调用 hasInstalledExtensionOnDisk(MATCH_SCORE_EXTENSION_ID)（R4 启动时自检）');
ok(indexSrc.includes('插件线隔离自检') || indexSrc.includes('插件线隔离'),
  '主进程启动包含插件线隔离自检 bootStep（R4 留痕 + 通知）');
// 8g) R6 端口归属校验（隔离的外部防线）
// 背景：调试端口是全机共享资源。原实现只判"端口通不通"，端口一通就当成我们的浏览器，
// 于是往【别人的 Chrome】里开标签页并 attach 跑 RPA——隔离被无关的外部进程击穿且用户无感。
// 这几条守着修复不被改回去。
ok(chromeSrc.includes('async inspectPort('),
  'ChromeManager 提供 inspectPort（R6 端口归属判定：free / ours / foreign）');
ok(chromeSrc.includes('isProfileInUse'),
  'inspectPort 以 profile 锁文件占用判定端口归属（R6 判据：端口通 + 自己 profile 被占 = 我们的）');
ok(/foreignPortError\(\)\s*:\s*IsolationViolationError/.test(chromeSrc),
  'foreignPortError 返回 IsolationViolationError（R6 关键：普通 Error 会被 launchDetached 当成"端口没开"而继续起新的，漏洞照旧）');
{
  // 所有"端口通就往下走"的路径都必须先判归属。裸用 isPortUp() 的地方只允许两处：
  // 它自己的定义，以及 inspectPort 内部的那一次调用。
  const bareIsPortUp = (chromeSrc.match(/this\.isPortUp\(\)/g) || []).length;
  ok(bareIsPortUp === 1,
    `isPortUp 仅在 inspectPort 内部被调用一次（实际 ${bareIsPortUp} 处；多出来的就是绕过归属校验的路径）`);
  const foreignThrows = (chromeSrc.match(/state === 'foreign'\)\s*throw this\.foreignPortError\(\)/g) || []).length;
  ok(foreignThrows === 3,
    `三条对外路径（connectExisting / openSiteInDebugBrowser / openBrowserForLogin）各有一处 foreign 拒绝（实际 ${foreignThrows} 处）`);
}

// ── 9) 语义 provider 同源契约（任务 B 硬约束：插件与平台必须用同一份实现，开关一致）
// 背景：v1 时插件 content.bundle.js 里内联了自己的同义词/TF-IDF 并调 setSemanticProvider，
// 平台 scoring.ts 完全没接——两边算法路径不同，导致同一份简历同一份 JD 分数不一致，而且
// 插件侧的 IT 通用词表在技术密集岗位上会"涨过头"（人工 80 → 93）。
// 修复后：唯一真源是 src/shared/semantic-provider.js，两边都从它加载；开关 SEMANTIC_ENABLED
// 在两边必须取相同布尔值，否则会重蹈漂移覆辙。
const semSharedSrc = read('src/shared/semantic-provider.js');
ok(semSharedSrc.includes('createSemanticProvider') && semSharedSrc.includes('DOMAIN_COMMON'),
  'src/shared/semantic-provider.js 存在并导出 createSemanticProvider / DOMAIN_COMMON（单一真源）');

// 9a) 平台 scoring.ts 必须引用共享语义模块、有开关常量
const scoringSrc = read('src/main/services/scoring.ts');
ok(scoringSrc.includes('semantic-provider.js'),
  'scoring.ts 引用了 semantic-provider.js（不另写一份）');
const platSemOn = (scoringSrc.match(/SEMANTIC_ENABLED\s*=\s*(true|false)/) || [])[1];
ok(platSemOn === 'true' || platSemOn === 'false',
  `scoring.ts 定义了 SEMANTIC_ENABLED 布尔开关（当前 ${platSemOn}）`);
// 当开关 true 时必须调 setSemanticProvider；false 时绝不能偷偷调
if (platSemOn === 'true') {
  ok(scoringSrc.includes('setSemanticProvider') && scoringSrc.includes('createSemanticProvider'),
    'SEMANTIC_ENABLED=true 时 scoring.ts 必须调 setSemanticProvider(createSemanticProvider())');
} else {
  // 允许存在 if (SEMANTIC_ENABLED) 块里的调用，但不允许在 if 块外裸调
  const naked = scoringSrc.replace(/if\s*\(\s*SEMANTIC_ENABLED\s*\)\s*\{[\s\S]*?\}\s*/g, '');
  ok(!naked.includes('setSemanticProvider'),
    'SEMANTIC_ENABLED=false 时 scoring.ts 不得在 if 块外裸调 setSemanticProvider');
}

// 9b) build-ext.mjs 必须从共享源内联 semantic-provider，开关与平台一致
const buildExtSrc = read('scripts/build-ext.mjs');
ok(buildExtSrc.includes('SEMANTIC_SRC') && buildExtSrc.includes('semantic-provider.js'),
  'build-ext.mjs 通过 SEMANTIC_SRC 引用 src/shared/semantic-provider.js（不从 parts/ 读旧版）');
ok(buildExtSrc.includes('__semRoot') && buildExtSrc.includes('createSemanticProvider'),
  'build-ext.mjs 把语义模块内联到局部 __semRoot 并通过 createSemanticProvider 构造');
const bundleSemOn = (buildExtSrc.match(/SEMANTIC_ENABLED_IN_BUNDLE\s*=\s*(true|false)/) || [])[1];
ok(bundleSemOn === 'true' || bundleSemOn === 'false',
  `build-ext.mjs 定义了 SEMANTIC_ENABLED_IN_BUNDLE 布尔开关（当前 ${bundleSemOn}）`);
ok(bundleSemOn === platSemOn,
  `插件与平台语义开关必须一致（插件 ${bundleSemOn} / 平台 ${platSemOn}）——漂移会导致两边算法路径又分叉`);

// 9c) 旧 parts/ 下的 10-tinyseg.js / 20-semantic.js 必须是占位注释，不能再藏真实实现
for (const ph of ['10-tinyseg.js', '20-semantic.js']) {
  const body = read(`extension/boss-match-score/parts/${ph}`);
  ok(/(占位|已迁移|migrated|deprecated)/i.test(body) && body.length < 500,
    `parts/${ph} 必须是仅含注释的占位文件（真实内容已迁到 src/shared/semantic-provider.js），当前长度 ${body.length}`);
  ok(!/var\s+SYNONYMS\s*=/.test(body) && !/function\s+_cut\s*\(/.test(body),
    `parts/${ph} 不得包含旧的 SYNONYMS 表 / _cut 分词实现（防双份漂移）`);
}

// 9d) 产物 content.bundle.js 必须与当前开关一致（若产物存在）。ext:check 会做更细粒度校验，
// 这里只做一条粗闸门，防止"改了开关没重建"的漂移进入提交。
const bundlePath = 'extension/boss-match-score/content.bundle.js';
if (fs.existsSync(path.join(ROOT, bundlePath))) {
  const bundleSrc2 = read(bundlePath);
  const bundleInjected = /TA_ENGINE\.setSemanticProvider\(_sem\)/.test(bundleSrc2);
  const expectedInjected = bundleSemOn === 'true';
  ok(bundleInjected === expectedInjected,
    `content.bundle.js 的语义注入状态（${bundleInjected}）与开关（${expectedInjected}）一致——若不一致请跑 npm run ext:build`);
  ok(/__semRoot/.test(bundleSrc2) && /__TA_SEMANTIC__/.test(bundleSrc2),
    'content.bundle.js 内联了共享 semantic 模块到 __semRoot（开关关闭时模块代码也要在产物里，便于将来切换）');
}

// ── 10) POST /structure/sample 写文件端点必须强制校验 Origin（A1 安全要求）──────
// GET 只读时允许空 Origin（DNS rebinding 防护由 Host 白名单兜底），
// 但 POST 写磁盘必须严格——origin 为空或不是扩展 origin 都拒绝，
// 防止本机任意进程（curl/其它应用）往诊断目录塞文件。
// 实现锚点：POST 路由必须有形如 `origin !== ALLOWED_ORIGIN` 的强制比较（不带 `origin &&` 前缀）。
const bridgeSrc2 = read('src/main/services/jd-bridge.ts');
// 断言写文件端点里有 `origin !== ALLOWED_ORIGIN` 且【没有】让空 origin 通过的 `origin &&` 前缀
const sampleRouteIdx = bridgeSrc2.indexOf("url === '/structure/sample'");
ok(sampleRouteIdx > 0, 'jd-bridge.ts 包含 POST /structure/sample 端点');
const sampleBlock = bridgeSrc2.slice(sampleRouteIdx, sampleRouteIdx + 1200);
ok(
  sampleBlock.includes("origin !== ALLOWED_ORIGIN") &&
  !sampleBlock.match(/origin\s*&&\s*origin\s*!==\s*ALLOWED_ORIGIN/),
  "POST /structure/sample 强制校验 Origin（不接受空 Origin），不再带 'origin &&' 宽松前缀",
  sampleBlock.slice(0, 300).replace(/\n/g, '↵')
);

// ── 11) jd-bridge 落盘容量常量必须锁定（A3 防止静默调大）──────────────────
const filesMatch = bridgeSrc2.match(/MAX_SAMPLE_FILES\s*=\s*(\d+)/);
const mbMatch = bridgeSrc2.match(/MAX_SAMPLE_DIR_MB\s*=\s*(\d+)/);
ok(filesMatch && filesMatch[1] === '200', `MAX_SAMPLE_FILES 为 200（当前 ${filesMatch ? filesMatch[1] : '未定义'}）`);
ok(mbMatch && mbMatch[1] === '50', `MAX_SAMPLE_DIR_MB 为 50（当前 ${mbMatch ? mbMatch[1] : '未定义'}）`);
// purgeSampleDir 必须存在且被调用（防止有人把清理函数删了）
ok(/function\s+purgeSampleDir/.test(bridgeSrc2), 'jd-bridge.ts 定义了 purgeSampleDir 清理函数');
ok(bridgeSrc2.includes('purgeSampleDir('), '写盘后调用了 purgeSampleDir（否则常量不生效）');

// ── 12) score-eval.mjs 必须同时跑 LEAN / FULL 两态 ─────────────────────────
// 口径变更（2026-08-03）：原先的 "PROD 态 + KNOWN_RED 白名单" 记的是
// 「JD 的 domain/tasks 全链路未落地」这笔账。链路已打通（见下面第 13 节的硬断言），
// 该态改名 LEAN，语义变成「用户没填这两栏时的引擎天花板」——不阻断，但必须一直打印。
// 防回归：
//   · 不得删掉 LEAN 态（它是"少填两栏付多少代价"的唯一量化证据）
//   · FULL 态必须是硬门槛（不达标 exit 1），LEAN 态不阻断
//   · KNOWN_RED 白名单必须已经消失（红账不能以任何形式复活）
const evalSrc = read('scripts/score-eval.mjs');
ok(!/const\s+KNOWN_RED_REASON/.test(evalSrc),
  'score-eval.mjs 不再有 KNOWN_RED_REASON 白名单（链路已打通，红账已结清）');
ok(evalSrc.includes('LEAN_NOTE'), 'score-eval.mjs 维护 LEAN_NOTE（信息缺失代价说明，不得删除）');
ok(evalSrc.includes('delete jd.domain') && evalSrc.includes('delete jd.tasks'),
  'score-eval.mjs LEAN 态剥离了 jd.domain / jd.tasks（delete 两个字段）');
ok(/deriveSetForMode[\s\S]{0,400}lean/.test(evalSrc),
  'score-eval.mjs 存在 deriveSetForMode 的 LEAN 态剥离逻辑');
ok(evalSrc.includes('--only=lean') && evalSrc.includes('--only=full'),
  'score-eval.mjs 支持 --only=lean / --only=full 选择器');
ok(/isHardGate/.test(evalSrc) && /FULL.*硬门槛/.test(evalSrc) && /LEAN[\s\S]{0,80}不阻断/.test(evalSrc),
  'score-eval.mjs 明确标注 FULL 为硬门槛、LEAN 不阻断');
ok(evalSrc.includes('exit(fullPass ? 0 : 1)') || evalSrc.includes('process.exit(fullPass ? 0 : 1)'),
  'score-eval.mjs 退出码只跟 FULL 态绑定（LEAN 态红不阻断）');

// ── 13) JD 评分字段全链路承载（替代原 KNOWN-RED 的真正门槛）────────────────
// v4 引擎 40% 权重的 domainFit/taskCoverage 消费 jd.domain / jd.tasks。
// 只要这条链上任何一环丢字段，生产就会退回"两维恒为 JD未设"的旧状态，
// 而且【不报错、照样出分】——这正是它当初能潜伏这么久的原因。
// 这里逐环静态断言；运行期承载由 scripts/jd-bridge-lab.mjs 第六节真源码断言。
const typesSrc = read('src/shared/types/index.ts');
ok(/export interface JdDomain/.test(typesSrc), '① 类型层：定义了 JdDomain');
ok(/export interface JdTask/.test(typesSrc), '① 类型层：定义了 JdTask');
ok(/domain\?:\s*JdDomain/.test(typesSrc) && /tasks\?:\s*JdTask\[\]/.test(typesSrc),
  '① 类型层：JD 上挂了 domain / tasks');

const matchSrc = read('src/renderer/src/pages/match/MatchPage.vue');
ok(/jdForm\.domain\.industry/.test(matchSrc) && /jdForm\.domain\.adjacentText/.test(matchSrc)
  && /jdForm\.domain\.distantText/.test(matchSrc),
  '② UI 层：岗位库编辑弹窗有应用域录入（含相邻域/远域）');
ok(/jdForm\.tasks/.test(matchSrc) && /domainSensitive/.test(matchSrc),
  '② UI 层：岗位库编辑弹窗有任务点录入（含域敏感开关）');
ok(/jdForm\.hardFlags/.test(matchSrc) && /jdForm\.basic\.ageMin/.test(matchSrc),
  '② UI 层：硬门槛开关与年龄区间有入口');
// saveJd 必须以原 JD 打底再覆盖：否则每次保存都会静默抹掉表单没覆盖到的字段
ok(/\.\.\.\(editingJd\.value\s*\|\|\s*\{\}/.test(matchSrc),
  '③ 保存层：saveJd 以原 JD spread 打底（防止编辑一次丢一批字段）');
ok(/domain:\s*domainEmpty\s*\?\s*null\s*:\s*domainObj/.test(matchSrc),
  '③ 保存层：域整块为空时存 null（让引擎明确走 notApplicable，而不是空壳对象）');

ok(/export function buildPayload/.test(bridgeSrc2),
  '④ 下桥层：buildPayload 已导出（供 jd-bridge-lab 直接测真源码）');
ok(/const list: any\[\] = \[\];[\s\S]{0,400}\.\.\.d,/.test(bridgeSrc2) || /\{\s*\n\s*\.\.\.d,/.test(bridgeSrc2),
  '④ 下桥层：jdList 整份 JD 透传（...d），不挑字段下发');

// 引擎侧：岗位职责归一化必须在（UI 存 basic.responsibilities，引擎读顶层 jd.responsibilities）
const engineSrc2 = read('src/shared/scoring-universal.js');
ok(/jd\.responsibilities\s*=\s*jd\.basic\.responsibilities/.test(engineSrc2),
  '⑤ 引擎层：把 basic.responsibilities 归一化到顶层（否则用户填的岗位职责一个字都进不了评分）');

// ── 14) 权重表单一真源：constants.ts 必须与引擎 WEIGHT_TEMPLATES 逐键数值相等 ──
// 两张表分头维护过一次，结果 constants 停在 8 维 v2、引擎是 14 维 v4，
// UI 上的"合计 100%"是假的（实际参与加权的是 8 个用户值 + 6 个引擎默认值）。
{
  const constSrc = read('src/shared/constants.ts');
  const engTplBlock = engineSrc2.slice(engineSrc2.indexOf('var WEIGHT_TEMPLATES'));
  const parseTpl = (src, name, endTok) => {
    const i = src.indexOf(name);
    if (i < 0) return null;
    const seg = src.slice(i, i + 700);
    const stop = seg.indexOf(endTok, name.length);
    const body = stop > 0 ? seg.slice(0, stop) : seg;
    const out = {};
    for (const m of body.matchAll(/(\w+):\s*(\d+)\s*[,}]/g)) out[m[1]] = Number(m[2]);
    return out;
  };
  const dims = ['positionFit', 'domainFit', 'taskCoverage', 'keywords', 'experience', 'degree',
    'industry', 'companyTier', 'projects', 'salary', 'location', 'age', 'stability'];
  for (const tplName of ['tech', 'functional', 'management']) {
    const eng = parseTpl(engTplBlock, `${tplName}: {`, '}');
    const uiIdx = constSrc.indexOf(`  ${tplName}: {`);
    const ui = uiIdx < 0 ? null : parseTpl(constSrc.slice(uiIdx), 'weights: {', '}');
    let same = !!(eng && ui);
    const diff = [];
    if (same) for (const d of dims) { if (eng[d] !== ui[d]) { same = false; diff.push(`${d}: 引擎${eng[d]} vs 常量${ui[d]}`); } }
    ok(same, `WEIGHT_TEMPLATES.${tplName} 与引擎逐键相等（13 维）`, diff.join('; ') || undefined);
  }
  // default 模板：常量侧用的是 DEFAULT_WEIGHTS
  {
    const eng = parseTpl(engTplBlock, 'default: {', '}');
    const ui = parseTpl(constSrc, 'export const DEFAULT_WEIGHTS: ScoreWeights = {', '}');
    let same = !!(eng && ui);
    const diff = [];
    if (same) for (const d of dims) { if (eng[d] !== ui[d]) { same = false; diff.push(`${d}: 引擎${eng[d]} vs 常量${ui[d]}`); } }
    ok(same, 'DEFAULT_WEIGHTS 与引擎 default 模板逐键相等（13 维）', diff.join('; ') || undefined);
    if (ui) {
      // 不断言"合计=100"：引擎按 totalWeight 归一化，合计多少不影响结果，只有【比例】有意义
      // （default 实际 107）。这里只守住"每一维都填了且非负"，避免某维漏成 undefined 后
      // 被引擎回落到模板值、用户却以为自己关掉了它。
      // P1-23：researchOutput（科研产出）维已移除——该维无任何写入点，恒 notApplicable 退出加权，
      // 3% 权重从不参与，保留会让「14 维」口径失真。故 dims 为 13 维，与 types/engine/constants 三处一致。
      const missing = dims.filter((d) => typeof ui[d] !== 'number');
      ok(missing.length === 0, 'DEFAULT_WEIGHTS 覆盖全部 13 维（缺任何一维都会被引擎悄悄用模板值补上）',
        missing.length ? '缺：' + missing.join(',') : `合计 ${dims.reduce((s, d) => s + ui[d], 0)}（归一化后按比例生效）`);
    }
  }
  // 维度清单的真源是 constants.ts 的 WEIGHT_FIELDS，UI 不许各写各的副本。
  ok(/export const WEIGHT_FIELDS/.test(constSrc), 'constants.ts 导出 WEIGHT_FIELDS（权重维度展示的唯一真源）');
  ok(/WEIGHT_FIELDS/.test(matchSrc), '岗位库权重编辑器从 WEIGHT_FIELDS 渲染（不再手抄 8 维）');
  // 设置页的匹配评分 tab 已前端隐藏（参数后端 DEFAULT_SETTINGS 定死），不再渲染权重编辑器。
  // 这里的约束反转为"禁止出现手抄维度副本"：万一有人把 tab 加回来，必须从 WEIGHT_FIELDS 渲染，
  // 不许贴一份硬编码的维度数组。手抄副本的判定 = 出现连续的 {k:'xxx',label:'...'} 形态。
  ok(!/\{\s*k:\s*['"][a-z_]+['"]\s*,\s*label:\s*['"]/.test(read('src/renderer/src/pages/settings/SettingsPage.vue')),
    '设置页不许出现手抄的权重维度副本（若恢复权重编辑器，必须从 WEIGHT_FIELDS 渲染）');
  ok(/Object\.keys\(DEFAULT_WEIGHTS\)/.test(read('src/main/ipc/settings.ts')),
    '设置写入白名单 WEIGHT_KEYS 由 DEFAULT_WEIGHTS 派生（不再手抄，避免新维度被静默丢弃）');
}

// ── 15) 工具库的扩展分发白名单必须自洽 ────────────────────────────────────
// 平台是 TA 拿到插件的唯一入口。这里三样东西必须对得上，少一样就是一种"看不见的坏"：
//   · extension/ 下的目录        —— 实际存在的插件
//   · ALLOWED_EXTENSION_DIRS     —— 工具库愿意展示的白名单（漏了 = 卡片不出现，TA 无从下载）
//   · EXTENSION_META             —— 装好后去哪儿用、怎么装（漏了 = 卡片出现但没有站点按钮和教程）
{
  const toolsIpc = read('src/main/ipc/tools.ts');
  const listed = (toolsIpc.match(/const ALLOWED_EXTENSION_DIRS\s*=\s*\[([^\]]*)\]/) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const onDisk = fs.readdirSync(path.join(ROOT, 'extension'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'extension', d.name, 'manifest.json')))
    .map((d) => d.name);

  ok(listed.length > 0, '工具库白名单 ALLOWED_EXTENSION_DIRS 解析得到（形态没变）', listed.join(', '));
  const missingFromWhitelist = onDisk.filter((d) => !listed.includes(d));
  ok(missingFromWhitelist.length === 0,
    'extension/ 下每个插件都在工具库白名单里（否则 TA 在平台上根本看不到、下载不了）',
    missingFromWhitelist.length ? '缺：' + missingFromWhitelist.join(',') : `${onDisk.length} 个都在`);
  const ghost = listed.filter((d) => !onDisk.includes(d));
  ok(ghost.length === 0, '白名单里没有已经不存在的目录（否则工具库会渲染出空卡片）',
    ghost.length ? '多余：' + ghost.join(',') : '无');
  for (const d of listed) {
    ok(new RegExp(`['"]${d}['"]\\s*:\\s*\\{`).test(toolsIpc),
      `EXTENSION_META 覆盖「${d}」（装好后去哪儿用 + 安装步骤，缺了卡片上就没有站点按钮和教程）`);
  }
  // 飞书插件的零权限承诺写在 README 与对外说明里，manifest 一旦悄悄加权限就必须被拦住
  const fmf = JSON.parse(read('extension/feishu-req2job/manifest.json'));
  ok(!fmf.permissions && !fmf.host_permissions,
    '飞书插件保持零 Chrome 权限（README/工具库都是这么向 TA 承诺的，加权限必须先改承诺）',
    JSON.stringify({ permissions: fmf.permissions, host_permissions: fmf.host_permissions }));
  ok((fmf.content_scripts?.[0]?.matches || []).every((m) => /feishu\.cn|larksuite\.com/.test(m)),
    '飞书插件只匹配飞书/Lark 域名（绝不能扩到招聘站点——那会把插件线拖进 BOSS 的检测射程）',
    (fmf.content_scripts?.[0]?.matches || []).join(' '));
  // ⚠️ matches 必须覆盖 /hire/*（而不是"更精确"的 /hire/job*）。
  // 2026-08-04 真机事故：飞书招聘的入口首页是 /hire/home，用户从工作台进来先落在那里，
  // 再【SPA 路由】进 /hire/job/...——写成 /hire/job* 时首页上根本不注入 content script，
  // 后续页内导航又没有整页加载，面板永远不出现，用户看到的就是"装了、点了没任何反应"。
  // 谁要把它收紧回去，先想清楚 SPA 这一层。
  ok((fmf.content_scripts?.[0]?.matches || []).some((m) => m.endsWith('/hire/*')),
    '飞书插件 matches 覆盖 /hire/*（入口首页 /hire/home 必须注入，SPA 内部路由才接得住）',
    (fmf.content_scripts?.[0]?.matches || []).join(' '));
  ok(!!(fmf.action && fmf.action.default_popup),
    '飞书插件有 action popup（用户装完第一反应就是点图标——没 popup 就是"点了没反应"）');
}

// ── 16) reqsheet 桥安全约束 ──────────────────────────────────────────────────
{
  const bridgeSrc = read('src/main/services/reqsheet-bridge.ts');
  // 只绑 127.0.0.1
  ok(bridgeSrc.includes("'127.0.0.1'") || bridgeSrc.includes('"127.0.0.1"'),
    'reqsheet-bridge 只绑定 127.0.0.1（不对外暴露）');
  // CORS 锁定扩展 ID
  ok(bridgeSrc.includes('REQSHEET_EXTENSION_ID'),
    'reqsheet-bridge CORS 引用 REQSHEET_EXTENSION_ID 常量（单一真源，不散硬编码）');
  // 端口常量
  const reqPort = (bridgeSrc.match(/REQSHEET_BRIDGE_PORT\s*=\s*(\d+)/) || [])[1];
  ok(reqPort && reqPort !== '17385',
    `reqsheet 桥端口 ${reqPort} 与 jd-bridge 端口不相撞（两个独立服务）`);
  // POST 端点强制校验 Origin（不带 origin && 宽松前缀）
  const rowsIdx = bridgeSrc.indexOf("url === '/reqsheet/rows'");
  ok(rowsIdx > 0, 'reqsheet-bridge 包含 POST /reqsheet/rows 端点');
  const stateIdx = bridgeSrc.indexOf("url === '/reqsheet/state'");
  ok(stateIdx > 0, 'reqsheet-bridge 包含 POST /reqsheet/state 端点');
  // 任意写端点必须强制 origin 校验
  const postBlock = bridgeSrc.slice(Math.max(rowsIdx, stateIdx) - 200, Math.max(rowsIdx, stateIdx) + 800);
  ok(
    postBlock.includes("origin !== ALLOWED_ORIGIN") &&
    !postBlock.match(/origin\s*&&\s*origin\s*!==\s*ALLOWED_ORIGIN/),
    'POST 端点强制校验 Origin（不允许空 Origin）',
    postBlock.slice(0, 200).replace(/\n/g, '↵')
  );
}

// ── 17) req-sheet-writer.ts 关键约束 ────────────────────────────────────────
{
  const writerSrc = read('src/main/services/req-sheet-writer.ts');
  // header guard 存在
  ok(writerSrc.includes('checkHeaders') && writerSrc.includes('EXPECTED_HEADERS'),
    'req-sheet-writer 定义了 checkHeaders + EXPECTED_HEADERS（header guard 存在）');
  // 写入前备份
  ok(writerSrc.includes('makeBackup'),
    'req-sheet-writer 写入前调用 makeBackup');
  ok(writerSrc.includes('BACKUP_MAX'),
    'req-sheet-writer 限制备份份数（BACKUP_MAX）');
  // 原子写
  ok(writerSrc.includes('.tmp') && writerSrc.includes('renameSync'),
    'req-sheet-writer 原子写（.tmp → renameSync）');
  // EBUSY → pending queue
  ok(writerSrc.includes('EBUSY') && writerSrc.includes('queuePending'),
    'req-sheet-writer 文件锁时落 pending queue（不丢数据）');
  // header mismatch 时不写
  ok(writerSrc.includes('header_mismatch') && writerSrc.includes('return result'),
    'req-sheet-writer header 不匹配时直接返回（拒绝写入）');
  // 15 列断言
  ok(writerSrc.includes('COL_REQ_ID') || writerSrc.includes('15'),
    'req-sheet-writer 引用了第 15 列（需求编号 O 列）常量');
}

// ── 18) reqsheet 扩展 manifest 约束 ─────────────────────────────────────────
{
  const rsmf = JSON.parse(read('extension/feishu-req-sheet-sync/manifest.json'));
  ok(rsmf.manifest_version === 3, 'feishu-req-sheet-sync manifest_version = 3');
  ok(typeof rsmf.key === 'string' && rsmf.key.length > 50,
    'feishu-req-sheet-sync manifest key 已 pin（ID 恒定）',
    rsmf.key ? `key 长度 ${rsmf.key.length}` : '(缺失)');
  ok((rsmf.content_scripts?.[0]?.matches || []).every((m) => /feishu\.cn|larksuite\.com/.test(m)),
    'feishu-req-sheet-sync 只匹配飞书/Lark 域名');
  ok((rsmf.content_scripts?.[0]?.matches || []).some((m) => m.endsWith('/hire/*')),
    'feishu-req-sheet-sync matches 覆盖 /hire/*（SPA 路由必须）');
  ok(!!(rsmf.action && rsmf.action.default_popup),
    'feishu-req-sheet-sync 有 action popup');
  // reqsheet 扩展只访问本地桥，不需要任何宽泛 host_permissions
  ok(!rsmf.host_permissions || !rsmf.host_permissions.some(h => !/127\.0\.0\.1/.test(h) && !/localhost/.test(h)),
    'feishu-req-sheet-sync 的 host_permissions 仅限 127.0.0.1/localhost（不申请外网权限）');
  // reqsheet-ext:check 同步
  const bundleExists = fs.existsSync(path.join(ROOT, 'extension', 'feishu-req-sheet-sync', 'content.bundle.js'));
  ok(bundleExists, 'feishu-req-sheet-sync content.bundle.js 已构建（reqsheet-ext:build 已跑）');
}

// ── 19) 两个飞书扩展 rejectExtensionIds 决策 ────────────────────────────────
// 飞书两个扩展都装在用户日常 Chrome，与 BOSS RPA 浏览器完全隔离，不会被 attach。
// 因此不需要加入 rejectExtensionIds（它是"防止 RPA Chrome 被 attach 到带插件的浏览器"的闸门）。
// 这里断言两飞书扩展 ID 都【不在】rejectExtensionIds，防止误加导致 TA 的插件被平台拒绝。
{
  const chromeSrc = read('src/main/cdp/chrome.ts');
  const reqsheetBridgeSrc = read('src/main/services/reqsheet-bridge.ts');
  const reqsheetExtId = (reqsheetBridgeSrc.match(/REQSHEET_EXTENSION_ID\s*=\s*['"]([a-p]{32})['"]/) || [])[1];
  ok(!!reqsheetExtId, 'reqsheet-bridge.ts 定义了 REQSHEET_EXTENSION_ID', reqsheetExtId);
  // reqsheet 扩展 ID 不应出现在 rejectExtensionIds（它在用户日常 Chrome，不会被 RPA 浏览器 attach）
  if (reqsheetExtId) {
    ok(!chromeSrc.includes(reqsheetExtId),
      `reqsheet 扩展 ID (${reqsheetExtId.slice(0,8)}…) 不在 chrome.ts 的 rejectExtensionIds`);
  }
}

// ── 20) 共享引擎单一真源：req2job 与 reqsheet bundle 都来自同一个 _shared/req-extract.js ─
{
  const reqExtractSrc = read('tools/_shared/req-extract.js');
  const marker = (reqExtractSrc.match(/var\s+(KNOWN_REQ_FIELDS)\s*=/) || [])[1];
  ok(!!marker, 'tools/_shared/req-extract.js 存在并定义 KNOWN_REQ_FIELDS（单一真源）');

  const rsBundle = fs.existsSync(path.join(ROOT, 'extension/feishu-req-sheet-sync/content.bundle.js'))
    ? read('extension/feishu-req-sheet-sync/content.bundle.js') : null;
  if (rsBundle) {
    ok(rsBundle.includes('KNOWN_REQ_FIELDS'),
      'feishu-req-sheet-sync bundle 内含 KNOWN_REQ_FIELDS（_shared/req-extract.js 已 inline）');
  }
  // reqsheet-ext:check 脚本存在
  ok(fs.existsSync(path.join(ROOT, 'scripts/build-reqsheet-ext.mjs')),
    'scripts/build-reqsheet-ext.mjs 存在（reqsheet-ext:check 可运行）');
}

// ── 21) npm test 硬闸：typecheck / build:smoke 必须在 SUITES 且不在赦免名单 ──
// 2026-08-07 事故：4 个悬空 import 导致编译不过，但 17 套件全绿——
// 因为没有任何套件跑 typecheck 或 build。这两条硬闸及其赦免豁免由 contract-check
// 和 run-all-tests.mjs 启动时断言双层把守。
{
  const runAllSrc = read('scripts/run-all-tests.mjs');
  ok(runAllSrc.includes("name: 'typecheck'") && runAllSrc.includes('vue-tsc'),
    'SUITES 包含 typecheck（vue-tsc --noEmit）');
  ok(runAllSrc.includes("name: 'build:smoke'") && runAllSrc.includes("'vite'"),
    'SUITES 包含 build:smoke（vite build）');
  const knownRedSet = (runAllSrc.match(/const KNOWN_RED\s*=\s*new Set\(\[([^\]]*)\]\)/) || [, ''])[1];
  ok(!knownRedSet.includes('typecheck'),
    'typecheck 不在 KNOWN_RED 集合（编译不过不能赦免）');
  ok(!knownRedSet.includes('build:smoke'),
    'build:smoke 不在 KNOWN_RED 集合（构建不过不能赦免）');
  const skipCodes = (runAllSrc.match(/const SKIP_EXIT_CODES\s*=\s*new Map\(\[([^\]]*)\]\)/) || [, ''])[1];
  ok(!skipCodes.includes('typecheck'),
    'typecheck 不在 SKIP_EXIT_CODES（编译不过不能跳过）');
  ok(!skipCodes.includes('build:smoke'),
    'build:smoke 不在 SKIP_EXIT_CODES（构建不过不能跳过）');
  ok(runAllSrc.includes('HARD_GATES'),
    'run-all-tests.mjs 包含 HARD_GATES 启动时自检（防有人删掉契约断言）');
}

console.log('');
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log(`✓ 全部通过：${pass}/${pass}`);
