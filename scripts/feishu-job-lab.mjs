/**
 * 「飞书需求 → 新建职位」插件的<b>逻辑层</b>测试台。
 *
 * 两条测试线的分工（与 BOSS 插件的 ext:test / ext:e2e 同一套路数）：
 *   feishu:lab      逻辑层 —— headless、快、断言多，把【构建产物】直接注进假飞书页跑完整流程
 *   feishu-ext:e2e  清单层 —— 真 Chrome 装真扩展，验 manifest/matches/权限/隔离世界那一层
 *
 * ⚠️ 2026-08-04 改造：本测试台原来是把源码塞进 TA 沙箱（chrome.ts 的 buildSandboxedScript）跑的。
 * 那条路已经不存在了 —— 平台注入版按用户要求整个删掉，这个工具只以浏览器插件形式交付。
 * 继续测一个不再发布的运行环境没有意义，还把测试和 chrome.ts 绑死（那个文件被别的改动
 * 弄成中间态时，本测试台会跟着一起挂，实测卡过两次）。
 * 现在直接注入 extension/feishu-req2job/content.bundle.js —— 被测的就是 TA 手里那份字节。
 *
 * 站点是本地起的假飞书（scripts/fixtures/feishu-hire-fixture.html），全程不碰真飞书。
 *
 * 覆盖（每条都对应一个曾经真实存在或高风险的缺陷）：
 *   ① 整页路由识别      —— v3.6.0 的 formOpened() 要求必须有可见弹层，而新建职位是整页路由，
 *                          导致真机上 100% 报「没检测到职位表单」，功能从来没跑起来过。
 *   ② 审批门禁          —— 审批中/驳回的需求不该被复制成真实职位；读不到状态要保守拒绝。
 *   ③ 一键编排          —— 自动点「新建职位」并进入向导。
 *   ④ 三步推进 + 不提交 —— 走完第 3 步停在「保存并完成更多设置」之前，绝不代点。
 *   ⑤ 新控件            —— 单选(职位类型)/开关(虚拟职位)/双下拉区间(职级范围)/三段月薪。
 *   ⑥ 已有值不覆盖      —— 飞书自带的 招聘数量/部门/招聘负责人 不许被改写。
 *   ⑦ 多选树重复点保护  —— 已选中的地点不能因为"再点一次"被取消（真机上这是数据丢失）。
 *   ⑧ 被必填拦住要如实报—— 卡住时报告里必须带页面红字原话，不许静默成功。
 *   ⑨ 多源拼接          —— 职位职责 + 职位要求 → 同一个「职位描述」，不许丢掉后者。
 *
 * 用法：node scripts/feishu-job-lab.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { spawn, execFileSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9347;
const SITE = 18107;
const BUNDLE = path.join(ROOT, 'extension', 'feishu-req2job', 'content.bundle.js');
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'feishu-hire-fixture.html');

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(actual, expected, name) {
  ok(String(actual) === String(expected), name, `期望「${expected}」实际「${actual}」`);
}

// ── 假飞书站点：任何 /hire/job/* 路径都回同一份夹具（SPA fallback）─────────
const FIXTURE_HTML = fs.readFileSync(FIXTURE, 'utf-8');
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => srv.listen(SITE, '127.0.0.1', r));
// 真机的需求详情是 /hire/job/requirement/<id>（整页路由，无 /detail 段），这里保持同构
const reqUrl = (scn) => `http://127.0.0.1:${SITE}/hire/job/requirement/7553536895138908459?scn=${scn}`;

function findChrome() {
  const cft = path.join(ROOT, 'node_modules', '.cache', 'ta-e2e-browsers');
  const stack = [cft];
  while (stack.length) {
    const d = stack.pop();
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (it.name === 'chrome.exe') return p;
    }
  }
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
  // F4(2026-08-05)
  const allowSkip = process.env.TA_ALLOW_SKIP === '1';
  if (allowSkip) { console.log('SKIPPED（TA_ALLOW_SKIP=1）：本机找不到 Chrome，feishu-job-lab 跳过'); try { srv.close(); } catch {} process.exit(0); }
  console.error('FAIL：本机找不到 Chrome 且 TA_ALLOW_SKIP 未开启');
  try { srv.close(); } catch {}
  process.exit(1);
}

const profile = path.join(os.tmpdir(), 'ta-feishu-lab-profile-' + process.pid);
const child = spawn(chromePath, [
  `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--headless=new', '--window-size=1440,1000', 'about:blank',
], { detached: true, stdio: 'ignore' });
child.unref();

const waitPort = () => new Promise((res, rej) => {
  const t0 = Date.now();
  (function tick() {
    const r = http.get(`http://127.0.0.1:${PORT}/json/version`, (x) => { x.resume(); res(); });
    r.on('error', () => (Date.now() - t0 > 20000 ? rej(new Error('CDP 端口未就绪')) : setTimeout(tick, 200)));
  })();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch { /* 页面导航中，重试 */ }
    await sleep(300);
  }
  console.log('  … 等待超时：' + label);
  return false;
}

const STATUS_DONE = ['已停在', '审批门禁', '没能从当前页面提取到', '找不到「新建职位」', '填充出错', '没检测到职位表单'];
// node scripts/feishu-job-lab.mjs --only=A  → 只跑某几个场景（调试时省时间）
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toUpperCase();
const want = (s) => !ONLY || ONLY.includes(s);
const VERBOSE = process.argv.includes('--verbose');

// 被测对象＝【构建产物本身】。产物过期就等于在测上一版，先卡住。
const buildCheck = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build-feishu-ext.mjs'), '--check'], { stdio: 'pipe' });
const buildOut = await new Promise((res) => {
  let s = '';
  buildCheck.stdout.on('data', (d) => (s += d));
  buildCheck.stderr.on('data', (d) => (s += d));
  buildCheck.on('close', (code) => res({ code, s }));
});
if (buildOut.code !== 0) {
  console.log('✗ 插件产物与源不同步，先跑 npm run feishu-ext:build\n' + buildOut.s);
  srv.close(); try { process.kill(-child.pid); } catch { /* ignore */ }
  process.exit(1);
}
console.log(buildOut.s.trim());
const BUNDLE_SRC = fs.readFileSync(BUNDLE, 'utf-8');

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch {
  // F4(2026-08-05)
  const allowSkip = process.env.TA_ALLOW_SKIP === '1';
  if (allowSkip) { console.log('SKIPPED（TA_ALLOW_SKIP=1）：puppeteer-core 不可用，feishu-job-lab 跳过'); try { srv.close(); process.kill(-child.pid); } catch {} process.exit(0); }
  console.error('FAIL：puppeteer-core 不可用且 TA_ALLOW_SKIP 未开启');
  try { srv.close(); process.kill(-child.pid); } catch {}
  process.exit(1);
}

const cdpGet = (p) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (r) => {
    let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

let browser;
try {
  await waitPort();
  const ver = await cdpGet('/json/version');
  browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });

  /**
   * 跑一个场景：开页 → （可选）预置填充模式 → 注入产物 → 点「一键」→ 等报告 → 读表单真值
   */
  async function runScenario(scn, { mode } = {}) {
    const page = await browser.newPage();
    // ⚠️ 顺序要紧：先清库、再注产物。
    // evaluateOnNewDocument 按注册顺序执行，产物一上来就会读「已粘贴」，
    // 清库晚一步就等于让上一个场景的残留流进这一个（实测串味过：E 场景多出 A 场景写的两行）。
    await page.evaluateOnNewDocument((m) => {
      try {
        localStorage.clear();
        if (m) localStorage.setItem('ta-platform:req-gen:fillmode', m);
      } catch (e) { /* ignore */ }
    }, mode || '');
    // 在【文档加载前】注入，和扩展的 document_idle 时机对齐；
    // 页面是 SPA，加载后再注入会错过工具自己的初始化时序。
    await page.evaluateOnNewDocument(BUNDLE_SRC);
    await page.goto(reqUrl(scn), { waitUntil: 'load' });

    const panelUp = await waitFor(
      () => page.evaluate(() => !!document.getElementById('ta-req-oneclick')),
      15000, `${scn}: 面板注入`,
    );
    if (!panelUp) return { page, panelUp, status: '', form: null };

    await page.evaluate(() => document.getElementById('ta-req-oneclick').click());
    // 每 10 秒把状态栏与当前 URL 打一行出来。卡住时这是唯一能看出"卡在哪一步"的信息，
    // 否则只能看到测试超时，无从判断是页面没动还是工具没动。
    let lastTick = 0;
    await waitFor(async () => {
      const snap = await page.evaluate(() => ({
        s: (document.getElementById('ta-req-status') || {}).innerText || '',
        u: location.pathname,
      }));
      const now = Date.now();
      if (now - lastTick > 10000) {
        lastTick = now;
        console.log(`   [${scn}] ${snap.u} | ${snap.s.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
      return STATUS_DONE.some((k) => snap.s.includes(k));
    }, 180000, `${scn}: 一键跑完`);
    await sleep(800);

    const status = await page.evaluate(() => {
      const el = document.getElementById('ta-req-status');
      return el ? el.innerText : '';
    });
    const form = await page.evaluate(() => window.__FIXTURE__.read());
    // 「已粘贴」＝ 工具的唯一真源（2026-08-04 起不再有「待填充需求」那层中转）。
    // 用它断言提取层，而不是只看最终表单。
    const clip = await page.evaluate(() => {
      let text = '';
      try { text = localStorage.getItem('ta-platform:req-gen:extract-draft') || ''; } catch { /* ignore */ }
      if (!text) return null;
      // 与工具里的 parseSource 同构的最小实现：单行「字段：值」+ <<< >>> 多行块
      const fields = {};
      const lines = text.replace(/\r/g, '').split('\n');
      let key = null, inBlock = false, buf = [];
      for (const line of lines) {
        if (inBlock) {
          if (/^\s*>>>\s*$/.test(line)) { fields[key] = buf.join('\n'); inBlock = false; buf = []; key = null; }
          else buf.push(line);
          continue;
        }
        const mb = line.match(/^\s*([^：:\n]{1,60}?)[：:]\s*<<<\s*$/);
        if (mb) { key = mb[1].trim(); inBlock = true; buf = []; continue; }
        const m = line.match(/^\s*([^：:\n]{1,60}?)[：:]\s?(.*)$/);
        if (m) { key = m[1].trim(); fields[key] = m[2]; }
        else if (key != null) fields[key] += '\n' + line;
      }
      const name = fields['需求名称'] || fields['职位名称'] || null;
      return { name, fields };
    });
    if (VERBOSE) {
      console.log(`\n─── [${scn}] 完整报告 ───\n${status}\n───────────────`);
      console.log(`[${scn}] clip.name=${clip && clip.name} fields=${clip ? Object.keys(clip.fields).join(',') : '(none)'}\n`);
    }
    return { page, panelUp, status, form, clip };
  }

  // ══════════════ 场景 A：审批通过，一键应当走完三步 ══════════════
  if (want('A')) {
  console.log('\n── 场景 A：审批通过 · 一键跑完三步 ──');
  const A = await runScenario('A');
  ok(A.panelUp, 'A 面板注入：需求详情页出现「一键」按钮');
  if (A.form) {
    // ① 整页路由被识别（旧版这里必然是"没检测到职位表单"）
    ok(!A.status.includes('没检测到职位表单'),
      'A① 整页路由：不再误报「没检测到职位表单」（v3.6.0 在真机上恒发生的致命 bug）',
      A.status.slice(0, 60).replace(/\n/g, ' '));
    // ③④ 一键进入向导并走到最后一步，且没有代提交
    eq(A.form.step, 2, 'A③④ 三步推进：一键后停在第 3 步（负责人）');
    ok(A.form.submitted === false, 'A④ 绝不代提交：「保存并完成更多设置」没有被点击');

    // ⑤⑥⑨ 逐字段核对
    const s0 = A.form.s0, req = await A.page.evaluate(() => window.__FIXTURE__.req);
    eq(s0.职位名称, req['需求名称'], 'A 第1步 职位名称 ← 需求名称');
    eq(s0.职位类型, '社招', 'A⑤ 单选控件：职位类型 ← 招聘类型（旧版把 radio 当 select，必失败）');
    eq(s0.雇佣类型, '全职', 'A 值映射：人员类型「正式」→ 雇佣类型「全职」');
    eq(s0.职位类别, '软件研发', 'A 树选择：职位类别');
    eq(s0.部门, 'ACME', 'A⑥ 飞书已带值的「部门」保持不变');
    ok(Array.isArray(s0.工作地点) && s0.工作地点.indexOf('北京') !== -1,
      'A 多选树：工作地点选中「北京」', JSON.stringify(s0.工作地点));
    eq(s0.职能分类, '前端开发', 'A 下拉：职能分类 ← 职能类型');
    eq(s0.职级起, 'P6', 'A⑤ 双下拉区间：职级范围起点（P6~P8 → 起 P6）');
    eq(s0.职级止, 'P8', 'A⑤ 双下拉区间：职级范围终点（P6~P8 → 止 P8）');
    eq(s0.学历要求, '本科', 'A 下拉：学历要求');
    eq(s0.工作年限, '3-5年', 'A 下拉：工作年限 ← 经验要求');
    eq(s0.招聘数量, '100', 'A⑥ 飞书已带值的「招聘数量」不被需求人数(2)覆盖');
    eq(s0.月薪下限, '20', 'A⑤ 三段月薪：下限');
    eq(s0.月薪上限, '35', 'A⑤ 三段月薪：上限');
    eq(s0.币种, 'CNY-人民币', 'A⑤ 三段月薪：币种（缺它就会被「月薪为必填」卡住）');
    eq(s0.虚拟职位, 'false', 'A 未映射的开关（设置为虚拟职位）保持原样，工具不乱动');
    ok(s0.职位描述 && s0.职位描述.includes('前端架构设计') && s0.职位描述.includes('精通 TypeScript'),
      'A⑨ 多源拼接：职位职责 + 职位要求 都进了同一个「职位描述」',
      JSON.stringify((s0.职位描述 || '').slice(0, 40)));

    eq(A.form.s1.招聘流程, '默认社招流程', 'A 第2步 固定值映射：招聘流程');
    eq(A.form.s2.用人经理, '张三', 'A 第3步 用人经理 ← 需求用人经理');
    eq(A.form.s2.招聘负责人, '杨承鹏', 'A⑥ 第3步 飞书已预填的招聘负责人不被改写');
    ok(A.form.errors.length === 0, 'A 走完三步时页面没有遗留必填报错', JSON.stringify(A.form.errors));

    // ⑩⑪ 提取层：两条只在真机上才暴露出来的缺陷（2026-08-04 R00057 实测）
    const keys = A.clip ? Object.keys(A.clip.fields) : [];
    eq(A.clip && A.clip.name, req['需求名称'],
      'A⑩ 整页详情路由下靠页面标题拿到「需求名称」（真机上它不在基本信息块里，拿不到＝职位名称必填卡死）');
    ok(!keys.some((k) => /产品经理|LXD-内部招聘|校招- CY/.test(k)),
      'A⑪ 「关联职位」区块里的职位不被当成需求字段抓走', JSON.stringify(keys.filter((k) => /产品经理|LXD|校招/.test(k))));
    ok(!keys.includes('招聘进展'), 'A⑪ 「招聘进展」区块不被当成需求字段抓走');

    // ⑫ 面板收敛（2026-08-04 用户反馈）：老功能必须真的没了，且不能误伤主链路
    const panel = await A.page.evaluate(() => {
      const t = (document.getElementById('ta-req-gen-panel') || {}).innerHTML || '';
      const has = (id) => !!document.getElementById(id);
      return {
        legacyTemplate: /模板填充/.test(t),
        saveClipBtn: has('ta-req-save-clip'),
        presetSel: has('ta-req-preset'),
        mapBox: has('ta-req-map') || /字段映射/.test(t),
        // ⚠️ 这里已经在【向导页】了（一键把页面带过来了），所以只断言向导页该有的东西。
        // 需求页那几个按钮（一键/复制/点选）在场景 E 里断言 —— 那个场景全程停在需求页。
        pasted: has('ta-req-clip-edit'),
        fillJob: has('ta-req-fill-job'),
        scan: has('ta-req-scan'),
        resetLog: has('ta-req-reset-log'),
      };
    });
    ok(!panel.legacyTemplate, 'A⑫ 老功能「模板填充新建需求」已从面板移除');
    ok(!panel.presetSel, 'A⑫ 老功能的预设管理已移除');
    ok(!panel.saveClipBtn, 'A⑫ 「存为待填充需求」已移除（一次性完成，不再有中转步骤）');
    ok(!panel.mapBox, 'A⑫ 面板上不再出现「字段映射」这种实现概念');
    ok(panel.fillJob && panel.scan && panel.resetLog && panel.pasted,
      'A⑫ 向导页：填充/扫描/重置三个功能键 + 已粘贴 仍在（删老功能没有误伤）', JSON.stringify(panel));

    // ⑬ 「已粘贴」是唯一真源：改了文本框（不点任何保存）就应当直接影响下一次填充
    const liveEdit = await A.page.evaluate(() => {
      const ta = document.getElementById('ta-req-clip-edit');
      if (!ta) return null;
      ta.value = '需求名称：改这里就算数\n人员类型：正式';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const KEY = 'ta-platform:req-gen:extract-draft';
      return localStorage.getItem(KEY);
    });
    ok(liveEdit && liveEdit.includes('改这里就算数'),
      'A⑬ 「已粘贴」边打字边存，不需要点保存（少一个必点按钮＝少一次"改了忘点"的事故）',
      JSON.stringify((liveEdit || '').slice(0, 30)));
  }
  await A.page.close();
  }

  // ══════════════ 场景 E：逐项点选（2026-08-04 重做）══════════════
  // 老实现是"往上找一个大容器整块抓"，一框就是大半个详情页 —— 用户反馈"范围太大且没有用"。
  // 现在要验的是：对准某一个字段，只取那一条；且能连点多个。
  if (want('E')) {
  console.log('\n── 场景 E：逐项点选 ──');
  const E = await (async () => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
    await page.evaluateOnNewDocument(BUNDLE_SRC);
    await page.goto(reqUrl('A'), { waitUntil: 'load' });
    await waitFor(() => page.evaluate(() => !!document.getElementById('ta-req-pick')), 15000, 'E: 面板注入');

    // 需求页的面板构成（场景 A 结束时人已经在向导页了，那边断言不到这几个）
    const reqPanel = await page.evaluate(() => {
      const t = (document.getElementById('ta-req-gen-panel') || {}).innerHTML || '';
      const has = (id) => !!document.getElementById(id);
      return {
        oneclick: has('ta-req-oneclick'), copy: has('ta-req-copy'), pick: has('ta-req-pick'),
        pasted: has('ta-req-clip-edit'), fillJob: has('ta-req-fill-job'),
        legacyTemplate: /模板填充/.test(t), presetSel: has('ta-req-preset'),
        saveClipBtn: has('ta-req-save-clip'), mapBox: has('ta-req-map') || /字段映射/.test(t),
      };
    });

    // 进入点选模式
    await page.evaluate(() => document.getElementById('ta-req-pick').click());
    await sleep(400);

    // 对准「职级」这一行的标签，模拟 hover + click
    const step = async (labelText) => {
      return page.evaluate((lt) => {
        const labs = [...document.querySelectorAll('.label__f8a')].filter((n) => n.textContent.trim() === lt);
        if (!labs.length) return { ok: false, why: 'label not found: ' + lt };
        const el = labs[0];
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 };
        el.dispatchEvent(new MouseEvent('mousemove', opts));
        const box = document.getElementById('ta-req-gen-pick');
        const tip = document.getElementById('ta-req-gen-pick-tip');
        const boxH = box ? parseFloat(box.style.height) || 0 : 0;
        el.dispatchEvent(new MouseEvent('click', opts));
        return { ok: true, boxH, tip: tip ? tip.textContent : '' };
      }, labelText);
    };
    const s1 = await step('职级');
    await sleep(200);
    const s2 = await step('学历要求');
    await sleep(200);
    // Esc 结束
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await sleep(300);
    const text = await page.evaluate(() => localStorage.getItem('ta-platform:req-gen:extract-draft') || '');
    // 拿「基本信息」整块的高度做对照：老实现框的就是这种块
    const blockH = await page.evaluate(() => {
      const b = document.querySelector('.basicInfo__z9m');
      return b ? b.getBoundingClientRect().height : 0;
    });
    return { page, s1, s2, text, blockH, reqPanel };
  })();

  ok(E.reqPanel.oneclick && E.reqPanel.copy && E.reqPanel.pick && E.reqPanel.pasted && E.reqPanel.fillJob,
    'E⓪ 需求页主链路仍在：一键 / 复制当前需求 / 逐项点选 / 已粘贴 / 填充', JSON.stringify(E.reqPanel));
  ok(!E.reqPanel.legacyTemplate && !E.reqPanel.presetSel && !E.reqPanel.saveClipBtn && !E.reqPanel.mapBox,
    'E⓪ 需求页老功能已清干净：模板填充 / 预设 / 存为待填充 / 字段映射', JSON.stringify(E.reqPanel));
  ok(E.s1.ok && E.s2.ok, 'E 两次点选都命中了字段标签', JSON.stringify([E.s1.why, E.s2.why]));
  ok(/职级[：:]\s*P6~P8/.test(E.text), 'E① 点「职级」只取到职级这一条', JSON.stringify(E.text.slice(0, 60)));
  ok(/学历要求[：:]\s*本科/.test(E.text), 'E② 可以连着点第二个字段（点完不退出）', JSON.stringify(E.text));
  const lines = E.text.split('\n').filter((l) => l.trim());
  ok(lines.length === 2, 'E③ 只取了点中的那两条，没有把整块内容一起抓进来', `实际 ${lines.length} 行：${JSON.stringify(lines)}`);
  // ⚠️ 用【高度】而不是宽度判别：详情行里的值节点通常是 flex:1 通栏的，宽度本来就接近整页；
  // 真正能区分"一个字段" vs "一整块"的是高度——一行 vs 十几行。
  ok(E.s1.boxH > 0 && E.blockH > 0 && E.s1.boxH < E.blockH / 3,
    'E④ 高亮框只有一行高（＝一个字段），不是整块容器（老实现框的是整个基本信息块）',
    `高亮高 ${Math.round(E.s1.boxH)}px / 基本信息块高 ${Math.round(E.blockH)}px`);
  ok(/职级/.test(E.s1.tip || ''), 'E⑤ 悬停时提示条直说"这一下会取走什么"', JSON.stringify(E.s1.tip));
  await E.page.close();
  }

  // ══════════════ 场景 B：审批中 → 门禁必须拦下 ══════════════
  if (want('B')) {
  console.log('\n── 场景 B：审批中 · 门禁拦截 ──');
  const B = await runScenario('B');
  ok(B.status.includes('审批门禁'), 'B② 审批门禁：审批中的需求被拦下并说明原因',
    B.status.slice(0, 70).replace(/\n/g, ' '));
  ok(B.status.includes('审批中'), 'B② 报告里带出真实审批状态原文');
  if (B.form) {
    eq(B.form.step, -1, 'B② 被拦下时【没有】进入新建职位向导');
    ok(B.form.submitted === false, 'B② 被拦下时当然也没有提交');
  }
  await B.page.close();
  }

  // ══════════════ 场景 C：force 模式 + 已选两个地点 → 不许被点掉 ══════════════
  if (want('C')) {
  console.log('\n── 场景 C：全部覆盖模式 · 多选树重复点保护 ──');
  const C = await runScenario('C', { mode: 'force' });
  if (C.form) {
    const loc = C.form.s0.工作地点 || [];
    ok(loc.indexOf('北京') !== -1 && loc.indexOf('上海') !== -1 && loc.length === 2,
      'C⑦ 多选树：目标「北京」已在已选里 → 不再点击，两个 tag 都还在（没有被"再点一次"取消掉）',
      JSON.stringify(loc));
  }
  await C.page.close();
  }

  // ══════════════ 场景 D：薪资「面议」→ 第1步必被拦住，且要如实上报 ══════════════
  if (want('D')) {
  console.log('\n── 场景 D：薪资面议 · 被必填拦住要如实上报 ──');
  const D = await runScenario('D');
  if (D.form) {
    eq(D.form.step, 0, 'D⑧ 月薪填不上时，向导【没有】被推进到第 2 步');
    ok(D.form.submitted === false, 'D⑧ 卡住时没有代提交');
    ok(D.status.includes('月薪为必填'),
      'D⑧ 报告里带出页面红字原话「月薪为必填」（而不是静默报成功）',
      D.status.slice(0, 90).replace(/\n/g, ' '));
    ok(D.status.includes('卡在第1步') || D.status.includes('向导没走完'),
      'D⑧ 报告明确指出卡在第几步');
    ok(/salary-unparsable|面议/.test(D.status),
      'D⑧ 报告指出薪资原值解析不了，需人工填', D.status.includes('面议') ? '(带出原值)' : '(未带原值)');
  }
  await D.page.close();
  }
} catch (e) {
  fails.push('测试台异常：' + (e?.stack || e));
  console.log('✗ 测试台异常：', e?.stack || e);
} finally {
  try { if (browser) await browser.disconnect(); } catch {}
  try { process.kill(-child.pid); } catch { try { child.kill(); } catch {} }
  srv.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log('');
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log(`✓ 全部通过：${pass}/${pass}`);
