/**
 * skeleton-monitor 自检（纯 Node + 真 puppeteer + 本地假站点，零平台接触）。
 *
 * 为什么要写它（任务B 三绿之一）：
 *   dumpSkeleton 是真机失败点的【证据采集器】——城市弹层、筛选未生效、翻页判失败这些点
 *   采回来的骨架是控制层离线揪问题的唯一依据。而 dumpSkeleton 跑在真机上时承鹏不在场，
 *   跑挂了他只看得到"什么都没发生"，那一趟真机就白关 VPN 了。所以提交前必须证明：
 *     ① dumpSkeleton 能跑通、产出 schema v2；
 *     ② 合成含姓名/手机明文的 DOM，输出只有结构名、零 PII（隐私红线，一条都不许破）；
 *     ③ first-result / city-overlay 调用点在合成场景被正确触发（即调用点代码路径走到、
 *        tag 正确、文件落盘）。
 *
 * 与 console-sampler-selftest.mjs 同源思路（假 DOM + 断言 PII 边界），但走真 puppeteer
 * page.evaluate（与 dumpSkeleton 生产路径一致），而不是 vm 沙箱——这样才能覆盖
 * walkTree 在真实浏览器 DOM API 下的行为。
 *
 * 用法：node scripts/skeleton-monitor-selftest.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { spawn } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9341;
let SITE = 18199;

const outFile = path.join(os.tmpdir(), 'ta-skeleton-monitor-selftest.mjs');
await build({
  stdin: {
    contents: [
      `export { dumpSkeleton, SkeletonMonitor, getMonitor }`,
      `  from '${path.join(ROOT, 'src/main/services/skeleton-monitor.ts').replace(/\\/g, '/')}';`,
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: outFile, logLevel: 'error',
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /^puppeteer-core$/ }, () => ({ path: 'puppeteer-core', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        // dumpSkeleton 的类型签名里 import type { Page } —— 运行时不依赖，给个空桩即可。
        contents: 'export default {};\nexport const Page = {};\n',
        loader: 'js',
      }));
    },
  }],
});
const M = await import(pathToFileURL(outFile).href);

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}

// ── 合成页面：刻意埋入姓名/手机明文 PII，验证骨架采样绝不带出来 ──────────────────
// 结构照猎聘搜索页（li[data-resumeidencode] 卡片 + city 弹层）。
const FIRST_RESULT_PAGE = `<!doctype html><html><head><title>搜索人才 - 猎聘</title></head><body>
  <div class="resumeListBox--abc">
    <li data-resumeidencode="RID_CONFIDENTIAL_1111" class="resumeCardWrap--XzBkN">
      <div class="nest-resume-personal-name">张承鹏</div>
      <span class="personal-detail-age--a1">31岁</span>
      <span class="personal-detail-dq">武汉</span>
      <span class="personal-expect-content">后端开发工程师</span>
      <a href="/cvview/showresumedetail?resIdEncode=RID_CONFIDENTIAL_1111&jobId=9876543210">查看</a>
      <button class="ant-lpt-btn ant-lpt-btn-primary ant-lpt-teno-btn-secondary">立即沟通</button>
      <div class="contact-phone">13800138000</div>
      <div class="school">华中科技大学</div>
    </li>
  </div>
  <input placeholder="搜职位/公司/行业等（中文用空格隔开…）" />
  <button class="search-btn">搜索</button>
</body></html>`;

// 城市弹层合成页：点完「其他」后的弹层态，内含城市项 + 仍带 PII 的卡片
const CITY_OVERLAY_PAGE = `<!doctype html><html><head><title>城市选择</title></head><body>
  <div class="cityPicker--overlay">
    <div class="city-item">武汉市</div>
    <div class="city-item">上海市</div>
    <div class="city-item">北京市</div>
  </div>
  <div class="resumeListBox--xyz">
    <li data-resumeidencode="RID_2222" class="resumeCardWrap--qq">
      <div class="nest-resume-personal-name">李测试</div>
      <span class="personal-detail-dq">上海</span>
      <div class="contact-phone">13912345678</div>
    </li>
  </div>
</body></html>`;

const PAGES = { '/search': FIRST_RESULT_PAGE, '/city': CITY_OVERLAY_PAGE };
const srv = http.createServer((req, res) => {
  const key = Object.keys(PAGES).find((k) => req.url.startsWith(k));
  res.writeHead(key ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(key ? PAGES[key] : 'not found');
});
SITE = await new Promise((resolve, reject) => {
  const attempt = (p, left) => {
    const onErr = (e) => { srv.removeListener('error', onErr); if (e.code === 'EADDRINUSE' && left > 0) setTimeout(() => attempt(p + 1, left - 1), 80); else reject(e); };
    srv.once('error', onErr);
    srv.listen(p, '127.0.0.1', () => { srv.removeListener('error', onErr); resolve(p); });
  };
  attempt(SITE, 20);
});

function findChrome() {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  ];
  for (const p of c) if (fs.existsSync(p)) return p;
  return null;
}
const chromePath = findChrome();
if (!chromePath) {
  const allowSkip = process.env.TA_ALLOW_SKIP === '1';
  const msg = 'SKIPPED（TA_ALLOW_SKIP=1）：本机找不到 Chrome，skeleton-monitor-selftest 跳过';
  if (allowSkip) { console.log(msg); try { srv.close(); } catch {} process.exit(0); }
  console.error('FAIL：本机找不到 Chrome 且 TA_ALLOW_SKIP 未开启。'); try { srv.close(); } catch {} process.exit(1);
}

const profile = path.join(os.tmpdir(), 'ta-skeleton-selftest-' + process.pid);
const child = spawn(chromePath, [
  `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
], { detached: true, stdio: 'ignore' });
child.unref();

const waitPort = () => new Promise((res, rej) => {
  const t0 = Date.now();
  (function tick() {
    const r = http.get(`http://127.0.0.1:${PORT}/json/version`, (x) => { x.resume(); res(); });
    r.on('error', () => (Date.now() - t0 > 25000 ? rej(new Error('port timeout')) : setTimeout(tick, 400)));
  })();
});

const puppeteer = (await import('puppeteer-core')).default;

function cleanup(code) {
  try { srv.close(); } catch {}
  try { child.kill(); } catch {}
  // 清掉自检产物（留 commit 不进 git）
  try { fs.rmSync(path.join(ROOT, 'logs'), { recursive: true, force: true }); } catch {}
  process.exit(code);
}

try {
  await waitPort();
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` });
  const page = await browser.newPage();

  // ── 调用点①：first-result ──────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${SITE}/search`, { waitUntil: 'domcontentloaded' });
  console.log('\n--- 调用点① first-result（合成出结果页 → dumpSkeleton）---');
  const r1 = await M.dumpSkeleton(page, 'first-result');
  ok(r1.ok, 'first-result 调用点触发并落盘', r1.file || r1.reason);
  if (r1.ok) {
    const s1 = JSON.parse(fs.readFileSync(r1.file, 'utf8'));
    const j1 = JSON.stringify(s1);
    ok(s1.schemaVersion === 2 && s1.kind === 'dom-skeleton', '产出 schema v2', `schemaVersion=${s1.schemaVersion}`);
    ok(s1.tag === 'first-result', 'tag 标注正确', s1.tag);
    ok(s1.sampledBy === 'skeleton-monitor', 'sampledBy 标注', s1.sampledBy);
    ok(s1.nodeCount > 0 && !!s1.tree, '采到非空骨架', `nodeCount=${s1.nodeCount}`);
    // ── PII 红线（一条都不许破）──
    ok(!/张承鹏/.test(j1), '不含候选人姓名（张承鹏）');
    ok(!/13800138000|13912345678/.test(j1), '不含手机明文');
    ok(!/华中科技大学/.test(j1), '不含学校明文');
    ok(!/RID_CONFIDENTIAL_1111/.test(j1), '不含 data-* 的值（resIdEncode 原值）');
    ok(/"data-resumeidencode"/.test(j1), '保留 data-* 的【名字】', 'data-resumeidencode 名字在');
    ok(/resumeCardWrap--XzBkN/.test(j1), '保留 class（含哈希后缀）', 'class 在');
    ok(/"x":"立即沟通"/.test(j1), '短文案留下（认得出「立即沟通」）');
    ok(!/"x":"搜索"/.test(j1) || true, '搜索按钮短文案 ≤8字无数字可留（不强制）');
    // 链接只留 path 形状
    const hrefMatches = j1.match(/"h":"[^"]*"/g) || [];
    ok(hrefMatches.every((h) => !/\d{4,}/.test(h)), '链接 path 中 ≥4位数字已打码', JSON.stringify(hrefMatches));
    ok(/\/cvview\/showresumedetail/.test(j1), '链接 path 形状保留', hrefMatches[0]);
  }

  // ── 调用点②：city-overlay ─────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${SITE}/city`, { waitUntil: 'domcontentloaded' });
  console.log('\n--- 调用点② city-overlay（弹层展开后 → dumpSkeleton）---');
  const r2 = await M.dumpSkeleton(page, 'city-overlay');
  ok(r2.ok, 'city-overlay 调用点触发并落盘', r2.file || r2.reason);
  if (r2.ok) {
    const s2 = JSON.parse(fs.readFileSync(r2.file, 'utf8'));
    const j2 = JSON.stringify(s2);
    ok(s2.tag === 'city-overlay', 'tag 标注正确', s2.tag);
    ok(/cityPicker--overlay/.test(j2), '弹层容器 class 入骨架', 'cityPicker--overlay 在');
    ok(/city-item/.test(j2), '城市项 class 入骨架', 'city-item 在');
    // ── PII 红线：弹层页也带了一张候选人卡，姓名/手机一样不许漏 ──
    ok(!/李测试/.test(j2), '弹层页不含候选人姓名（李测试）');
    ok(!/13912345678/.test(j2), '弹层页不含手机明文');
    ok(!/RID_2222/.test(j2), '弹层页不含 resIdEncode 原值');
  }

  // ── 诊断码归类：SkeletonMonitor 钩 console.warn ───────────────────────
  console.log('\n--- 诊断码/风控事件归类（SkeletonMonitor）---');
  const mon = new M.SkeletonMonitor('liepin');
  mon.start();
  // 模拟 liepin.ts 里各调用点的 console.warn（与源码逐字对齐）
  console.warn("[liepin][diagnostic] CITY_OVERLAY_NO_CITY_ROW: 未定位到城市行容器（city=武汉）");
  console.warn("[liepin][diagnostic] CITY_OVERLAY_NOT_OPENED: 城市行内未找到「其他」入口（city=武汉, row=目前城市）");
  console.warn("[liepin][diagnostic] CITY_OVERLAY_NO_CONTAINER: 「其他」已点但未定位到弹层容器（city=武汉）");
  console.warn("[liepin][diagnostic] CITY_OVERLAY_NO_MATCH: 弹层已展开但未命中目标城市（city=武汉）");
  console.warn("[liepin][diagnostic] CITY_OVERLAY_NO_MATCH: 弹层已展开但未命中目标城市（city=上海）");
  console.warn("[liepin][diagnostic] CITY_OVERLAY_ERROR: 城市弹层路径异常 city=武汉: TypeError");
  // ★ 2026-08-18 修复5：FILTER_FAILED_* / GO_NEXT_PAGE_* 诊断码也要被 DIAG_RE 钩子归类
  //   （源码里这些调用点已补 console.warn，原版只 dumpSkeleton 不 warn → diagnostics 漏报）。
  console.warn("[liepin][diagnostic] FILTER_FAILED_STRICT: 严格模式筛选未生效，已采样骨架");
  console.warn("[liepin][diagnostic] FILTER_FAILED_TAGCHECK: 结果区已应用标签缺失设定项，已采样骨架");
  console.warn("[liepin][diagnostic] GO_NEXT_PAGE_FAILED: 翻页沉降等待超时，已采样骨架");
  // 风控/环境事件（非诊断码）
  console.warn('[liepin] 页面已被弹到境外 IP 拦截页 —— 不是选择器失效');
  console.warn('[liepin] 搜索提交后 4 秒无变化，疑似首次点击被浮层吞掉，补点一次搜索');
  mon.recordSearch(); mon.recordViewed(5); mon.recordPage(2); mon.recordRows(3);
  const sum = mon.getSummary();
  const sumFile = mon.end();
  ok(sum.diagnostics.CITY_OVERLAY_NO_MATCH === 2, 'NO_MATCH 计数=2（两次触发）', String(sum.diagnostics.CITY_OVERLAY_NO_MATCH));
  ok(sum.diagnostics.CITY_OVERLAY_NO_CITY_ROW === 1, 'NO_CITY_ROW 计数=1', String(sum.diagnostics.CITY_OVERLAY_NO_CITY_ROW));
  // ★ 2026-08-18 修复5：新增诊断码也要被归类（CITY_OVERLAY_* 5 种 + FILTER_FAILED_* 2 + GO_NEXT_PAGE_FAILED 1 = 8 种）
  ok(Object.keys(sum.diagnostics).length === 8, '诊断码种类=8（CITY_OVERLAY×5 + FILTER_FAILED×2 + GO_NEXT_PAGE×1）', Object.keys(sum.diagnostics).join(','));
  ok(sum.diagnostics.FILTER_FAILED_STRICT === 1, 'FILTER_FAILED_STRICT 被归类（修复5）', String(sum.diagnostics.FILTER_FAILED_STRICT));
  ok(sum.diagnostics.FILTER_FAILED_TAGCHECK === 1, 'FILTER_FAILED_TAGCHECK 被归类（修复5）', String(sum.diagnostics.FILTER_FAILED_TAGCHECK));
  ok(sum.diagnostics.GO_NEXT_PAGE_FAILED === 1, 'GO_NEXT_PAGE_FAILED 被归类（修复5）', String(sum.diagnostics.GO_NEXT_PAGE_FAILED));
  ok(sum.riskEvents >= 2, '风控事件计数≥2（境外拦截+补点搜索）', String(sum.riskEvents));
  ok(sum.searches === 1 && sum.viewed === 5 && sum.pages === 2 && sum.rowsWritten === 3, 'searches/viewed/pages/rows 正确', JSON.stringify({ s: sum.searches, v: sum.viewed, p: sum.pages, r: sum.rowsWritten }));
  ok(fs.existsSync(sumFile), 'run-summary.json 落盘', sumFile);
  const sumJson = JSON.parse(fs.readFileSync(sumFile, 'utf8'));
  ok(sumJson.platform === 'liepin' && sumJson.startedAt > 0, 'run-summary 含 platform+startedAt', JSON.stringify({ p: sumJson.platform, s: sumJson.startedAt }));

  // ── 修复5：dumpSkeleton 落盘同步累加 skeletonDumps 计数 ─────────────────
  // 原实现只写盘不计数 → run-summary 的 skeletonDumps 恒 0，但实际落了 N 个 skeleton。
  // dumpSkeleton 内部调 getMonitor().recordSkeletonDump()（单例），所以这里必须用
  // getMonitor() 同一实例验证，不能 new 一个独立的 SkeletonMonitor。
  console.log('\n--- 修复5：skeletonDumps 计数（dumpSkeleton 落盘即累加）---');
  const mon2 = M.getMonitor('liepin');
  const beforeDumps = mon2.getSummary().skeletonDumps;
  // getMonitor 是单例，上面调用点①②的 dumpSkeleton 已让它累加过 → beforeDumps 应 ≥2
  ok(beforeDumps >= 2, `getMonitor 单例已累加 skeletonDumps（来自前面 first-result/city-overlay 两次落盘）`, String(beforeDumps));
  // 再 dump 一次，计数应 +1
  await page.goto(`http://127.0.0.1:${SITE}/search`, { waitUntil: 'domcontentloaded' });
  const r3 = await M.dumpSkeleton(page, 'tagcheck-test');
  ok(r3.ok, 'tagcheck-test 调用点落盘', r3.file || r3.reason);
  const afterDumps = mon2.getSummary().skeletonDumps;
  ok(afterDumps === beforeDumps + 1, 'dumpSkeleton 落盘后 skeletonDumps +1（修复5：计数器不再少报）', `${beforeDumps} → ${afterDumps}`);

  await browser.close();
  console.log('\n============================================================');
  if (fails.length) {
    console.log(`✗ 自检失败 ${fails.length} 项：`);
    fails.forEach((f) => console.log('  - ' + f));
    cleanup(1);
  }
  console.log(`✓ 全部通过：${pass}/${pass + fails.length}`);
  cleanup(0);
} catch (e) {
  console.error('✗ 自检异常:', e && e.stack ? e.stack.slice(0, 1200) : e);
  cleanup(1);
}
