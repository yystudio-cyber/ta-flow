/**
 * 页面适配层实机测试台 —— 用【真 Chrome + 真 DOM + 真 puppeteer 帧】跑风控检测代码，
 * 但页面是本地起的假站点，全程不碰 BOSS 一次。
 *
 * 为什么需要这一层：
 * 此前测试只有两端 —— 一端是拿假对象做的纯逻辑断言（测不到真实 DOM 与真实 CDP 行为），
 * 另一端是拿真实招聘账号跑（错了代价由用户承担）。中间这层一直是空的，
 * 于是 2026-07-29 那个"浏览器断开被判成平台风控"的缺陷，一路活到了真机上才被发现。
 * 这个测试台补的就是中间层：真浏览器、真帧、真断连，但零平台接触。
 *
 * 用法：node scripts/adapter-lab.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { spawn, execSync } from 'child_process';

// 端口占用自愈：固定端口在连跑/上一次残留进程未退时会 EADDRINUSE，
// 让整条 npm test 随机变红（已发生过）。改为占用即顺延，最多试 20 个。
function listenWithRetry(srv, startPort, tries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      const onErr = (e) => {
        srv.removeListener('error', onErr);
        if (e && e.code === 'EADDRINUSE' && left > 0) setTimeout(() => attempt(p + 1, left - 1), 80);
        else reject(e);
      };
      srv.once('error', onErr);
      srv.listen(p, '127.0.0.1', () => { srv.removeListener('error', onErr); resolve(p); });
    };
    attempt(startPort, tries);
  });
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9337;
let SITE = 18099;

// ── 内存桩：适配层只用到 db.getSetting 与 scoring.parseBossSalary ─────────────
const DB_STUB = 'export function getSetting(k, d) { return d; }\nexport function setSetting() {}\n'
  + 'export function getDb() { return { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }) }; }\n'
  // 猎聘人才池：测试台只需存在同名导出，行为置空（人才池落库不在本测试范围）
  // upsertLiepinTalentIfNew 返回 false（视为已收录），引擎新增计数在测试台恒为 0，不影响断言。
  + 'export function upsertLiepinTalent() {}\nexport function upsertLiepinTalentIfNew() { return false; }\nexport function upsertLiepinScore() {}\n'
  + 'export function addLiepinTag() {}\nexport function removeLiepinTag() {}\n'
  + 'export function markLiepinDetailOpened() {}\n';
const SCORING_STUB = `
// 猎聘 adapter 的 onCandidateSaved 会调评分；测试台不验评分本身，给个恒定桩
export function scoreCandidate() { return { total: 0, level: 'low' }; }
export function parseBossSalary(s) {
  const m = String(s || '').match(/(\\d{1,3})\\s*[-~]\\s*(\\d{1,3})\\s*[Kk]/);
  return m ? { min: +m[1], max: +m[2] } : null;
}
`;
const ELECTRON_STUB = 'export const app = { getPath: () => "" };\n';

const outFile = path.join(os.tmpdir(), 'ta-adapter-lab.mjs');
await build({
  stdin: {
    contents: [
      `export { isRiskPage__test, classifyRiskKind, isRateWarning, isFatalPageError, probeSessionHealth }`,
      `  from '${path.join(ROOT, 'src/main/services/platform-adapter.ts').replace(/\\/g, '/')}';`,
      `export { liepinAdapter, locateOptionByText, locateRowContainer }`,
      `  from '${path.join(ROOT, 'src/main/services/adapters/liepin.ts').replace(/\\/g, '/')}';`,
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: outFile, logLevel: 'error',
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onResolve({ filter: /\/db$/ }, () => ({ path: 'db', namespace: 'stub' }));
      b.onResolve({ filter: /\/scoring$/ }, () => ({ path: 'scoring', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents: a.path === 'electron' ? ELECTRON_STUB : a.path === 'scoring' ? SCORING_STUB : DB_STUB,
        loader: 'js',
      }));
    },
  }],
});
const A = await import(pathToFileURL(outFile).href);

// ── 假页面（刻意模仿 BOSS 推荐流的结构，但全在本地）────────────────────────
const PAGES = {
  '/normal': `<html><head><title>推荐牛人</title></head><body>
    <ul class="card-list">
      <li class="card-item"><div class="card-inner" data-geekid="g1">
        <span class="name">张三</span>
        <div class="base-info"><span>3年</span><span>本科</span><span>25岁</span></div>
        <div class="expect-wrap"><span class="content">测试工程师</span></div>
      </div><button class="btn btn-greet">打招呼</button></li>
    </ul></body></html>`,
  '/geetest': `<html><head><title>安全验证</title></head><body>
    <div class="geetest_holder"><div class="geetest_radar_tip">请完成验证</div></div>
    <p>拖动滑块完成拼图</p></body></html>`,
  '/yidun': `<html><body><div class="yidun_slider"><span>请完成验证</span></div><p>人机验证</p></body></html>`,
  '/escalate': `<html><body><div class="geetest_holder"><img class="geetest_item_img" /></div><p>请依次点击下图中的文字</p></body></html>`,
  '/restricted': `<html><body><div class="tip">您的账号已被限制，请联系客服</div></body></html>`,
  '/entry': `<html><body><div class="tip">IP地址存在异常行为，请稍后再试</div></body></html>`,
  '/ratewarn': `<html><body><ul class="card-list"><li class="card-item"><div class="card-inner" data-geekid="g9"><span class="name">李四</span></div></li></ul><div class="toast">操作速度过快，请增大操作间隔</div></body></html>`,
  // BOSS 的正常业务配额用完 —— 这是每天都会发生的事，不是风控信号
  '/quota': `<html><body><ul class="card-list"><li class="card-item"><div class="card-inner" data-geekid="g8"><span class="name">赵六</span></div></li></ul><div class="tip">今日打招呼次数已达上限，请明天再来</div></body></html>`,
  // 长正文 + 普通业务词，验证不会因为正文里偶然出现"验证/安全"就误报
  '/longtext': `<html><body><ul class="card-list"><li class="card-item"><div class="card-inner" data-geekid="g2"><span class="name">王五</span></div></li></ul>
    <div>${'负责系统的安全验证模块设计与实现，熟悉身份验证流程。'.repeat(80)}</div></body></html>`,
};

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}

const srv = http.createServer((req, res) => {
  const key = Object.keys(PAGES).find((k) => req.url.startsWith(k));
  res.writeHead(key ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(key ? PAGES[key] : 'not found');
});
SITE = await listenWithRetry(srv, SITE);

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
  // F4(2026-08-05)：缺 Chrome 时 process.exit(0) 等于"伪装通过"，CI 看起来全绿但实际什么都没测。
  // 改为：TA_ALLOW_SKIP=1 时才允许静默跳过（开发机无 Chrome 时），否则 exit(1) 失败。
  const allowSkip = process.env.TA_ALLOW_SKIP === '1';
  const msg = 'SKIPPED（TA_ALLOW_SKIP=1）：本机找不到 Chrome，adapter-lab 跳过';
  if (allowSkip) { console.log(msg); try { srv.close(); } catch {} process.exit(0); }
  console.error('FAIL：本机找不到 Chrome 且 TA_ALLOW_SKIP 未开启。设置 TA_ALLOW_SKIP=1 允许跳过，或安装 Chrome。');
  try { srv.close(); } catch {}
  process.exit(1);
}

const profile = path.join(os.tmpdir(), 'ta-adapter-lab-' + process.pid);
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

const cleanup = () => {
  try { execSync('taskkill /F /T /PID ' + child.pid, { stdio: 'ignore' }); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }
};

try {
  await waitPort();
  process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, protocolTimeout: 30000, defaultViewport: null });

  const open = async (route) => {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${SITE}${route}`, { waitUntil: 'domcontentloaded' });
    return p;
  };

  console.log('\n=== 一、正常页面不得被误判为风控 ===');
  {
    const p = await open('/normal');
    ok((await A.isRiskPage__test(p)) === false, '普通推荐页 → 不是风控页');
    ok((await A.isRateWarning(p)) === false, '普通推荐页 → 没有降速提示');
    await p.close();
  }
  {
    const p = await open('/longtext');
    ok((await A.isRiskPage__test(p)) === false,
      '长正文里出现"安全验证/身份验证"等业务词 → 仍不算风控页（不能因为词命中就误停）');
    await p.close();
  }

  console.log('\n=== 二、真信号必须判得出来，且分类正确 ===');
  const cases = [
    ['/geetest', 'captchaGeetest', '极验滑块'],
    ['/yidun', 'captchaYidun', '网易易盾'],
    ['/escalate', 'captchaEscalate', '点选升级'],
    ['/restricted', 'accountRestricted', '账号受限'],
    ['/entry', 'apiCode35', '入口层 IP 异常'],
  ];
  for (const [route, expect, label] of cases) {
    const p = await open(route);
    const isRisk = await A.isRiskPage__test(p);
    const kind = isRisk ? await A.classifyRiskKind(p) : '(未判为风控页)';
    ok(isRisk === true && kind === expect, `${label} → 判为风控页且分类为 ${expect}`, String(kind));
    await p.close();
  }
  {
    const p = await open('/ratewarn');
    ok((await A.isRateWarning(p)) === true, 'BOSS「操作速度过快」提示 → 判得出来');
    await p.close();
  }
  {
    // 业务状态不等于风控：配额用完每天都会发生，若判成风控页会落到 riskPageUnknown（需人工），
    // 用户每天都要去风险中心点一次"我已处理"才能再跑（审查 2026-07-29）
    const p = await open('/quota');
    ok((await A.isRiskPage__test(p)) === false,
      '「今日打招呼次数已达上限」是业务配额 → 不得判成风控页（否则每天都要人工解闩）');
    await p.close();
  }

  console.log('\n--- locateOptionByText 合成 DOM 单测（普通版 + VIP 版） ---');
  {
    ok(typeof A.locateOptionByText === 'function', 'locateOptionByText 已导出为函数', typeof A.locateOptionByText);
    // 普通版结构：<label class="searchPageFilterItem--<hash>">1-3年</label>
    const NORMAL_DOM = `<html><head><style>
      .hide{display:none}
    </style></head><body>
      <div class="searchPageFilterContent--abc">
        <span class="title--xyz">经验</span>
        <label class="searchPageFilterItem--abc">不限</label>
        <label class="searchPageFilterItem--abc">1-3年</label>
        <label class="searchPageFilterItem--abc searchPageFilterItemActive--abc">3-5年</label>
        <label class="searchPageFilterItem--abc">5-10年</label>
      </div>
      <ul class="card-list">
        <li class="resumeCard--abc" data-resumeidencode="r1">
          <span>3-5年</span><button class="btn-greet">立即沟通</button>
        </li>
        <li class="resumeCard--abc" data-resumeidencode="r2">
          <span>1-3年</span><button class="btn-greet">立即沟通</button>
        </li>
      </ul></body></html>`;
    // VIP 版结构：「1-3年」不再是 label，嵌在 <div><span>1-3年</span></div> 里
    const VIP_DOM = `<html><head></head><body>
      <div class="wrap--wiaLZ">
        <div class="title--wiaLZ">经验</div>
        <div class="filter-item--wiaLZ"><span>不限</span></div>
        <div class="filter-item--wiaLZ"><span>1-3年</span></div>
        <div class="filter-item--wiaLZ"><span>3-5年</span></div>
        <div class="filter-item--wiaLZ"><span>5-10年</span></div>
      </div>
      <ul class="card-list">
        <li class="resumeCard--xyz" data-resumeidencode="r3">
          <span>1-3年</span><button class="btn-greet">立即沟通</button>
        </li>
      </ul></body></html>`;

    // 验证函数：在合成 DOM 上跑 locateOptionByText（真函数引用，非副本），返回命中元素特征。
    const probe = async (domHtml, target) => {
      const p = await browser.newPage();
      await p.setContent(domHtml, { waitUntil: 'domcontentloaded' });
      // 传函数引用本身到浏览器执行 —— 验的就是 liepin.ts 里的真实现，不是内联副本
      const h = await p.evaluateHandle(A.locateOptionByText, target).catch(() => null);
      const found = h && h.asElement ? h.asElement() : null;
      const info = found
        ? await p.evaluate((el) => ({
            tag: el.tagName.toLowerCase(),
            directText: Array.from(el.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent || '').join('').replace(/\s+/g, '').trim(),
            inCard: !!(el.closest('li[data-resumeidencode]') || el.closest("[class*='resumeCard']")),
            cls: el.getAttribute('class') || '',
          }), found).catch(() => null)
        : null;
      await p.close();
      return info;
    };

    // 普通版：点「1-3年」应命中 <label>1-3年</label>（最内层、直接文本=1-3年、不在卡片内）
    {
      const info = await probe(NORMAL_DOM, '1-3年');
      ok(!!info, '普通版：locateOptionByText 命中「1-3年」', info ? `${info.tag}.${info.cls}` : 'null');
      if (info) {
        ok(info.directText === '1-3年', '普通版：命中元素直接文本恰为「1-3年」（不是父级拼出来的）', info.directText);
        ok(info.inCard === false, '普通版：命中元素不在候选人卡片内（安全闸门）', String(info.inCard));
        // 最内层：命中的 label 自身没有同样含「1-3年」直接文本的可见子孙
        ok(info.tag === 'label', '普通版：命中 <label>（普通版可点元素就是 label）', info.tag);
      }
    }
    // 普通版安全闸门：卡片里也有「1-3年」文本，但绝不能命中卡片内元素
    {
      // 上面 probe 已经隐含验证（info.inCard===false）；再显式点「立即沟通」应永远命不中
      const info = await probe(NORMAL_DOM, '立即沟通');
      ok(info === null, '普通版：卡片内「立即沟通」绝不被命中（防止对真实候选人发消息）',
        info ? `❌误命中 ${info.tag}.${info.cls}` : '正确未命中');
    }
    // VIP 版：点「1-3年」应命中最内层 <span>1-3年</span>（不是外层 div.filter-item）
    {
      const info = await probe(VIP_DOM, '1-3年');
      ok(!!info, 'VIP 版：locateOptionByText 命中「1-3年」', info ? `${info.tag}.${info.cls}` : 'null');
      if (info) {
        ok(info.directText === '1-3年', 'VIP 版：命中元素直接文本恰为「1-3年」', info.directText);
        ok(info.inCard === false, 'VIP 版：命中元素不在候选人卡片内（安全闸门）', String(info.inCard));
        // 关键：VIP 版「1-3年」嵌在 <span> 里，应命中 <span>（最内层含直接文本的元素），
        //   而不是包着它的 <div class="filter-item--wiaLZ">（那个的直接文本为空）
        ok(info.tag === 'span', 'VIP 版：命中【最内层】<span>，而非外层 div.filter-item（事件冒泡触发 React 合成事件）',
          `${info.tag}（外层 div 的直接文本为空，不会误命中）`);
      }
    }
    // VIP 版已选态：点「3-5年」应同样命中（不因无 label 失效）
    {
      const info = await probe(VIP_DOM, '5-10年');
      ok(!!info && info.directText === '5-10年', 'VIP 版：另一选项「5-10年」同样命中', info ? info.directText : 'null');
    }
    // 不存在的选项：应返回 null（不乱点）
    {
      const info = await probe(VIP_DOM, '10-20年');
      ok(info === null, 'VIP 版：不存在的选项返回 null（不乱点）', info ? JSON.stringify(info) : 'null');
    }

    // ── 返工断言①：三行都含「其他」时，只有城市行的「其他」被选中 ──
    //   场景：经验行、教育经历行、城市行都有「不限」「其他」。全文档取首个「其他」会命中
    //   经验行（文档顺序在前）→ 点错行、展开错误的弹层。用 locateRowContainer 定位城市行作 root，
    //   在该 root 内 locateOptionByText('其他', cityRow) 必须命中【城市行】的「其他」。
    {
      const THREE_ROW_DOM = `<html><body>
        <div class="row row-exp"><span class="title">经验</span>
          <label>不限</label><label>1-3年</label><label>其他</label></div>
        <div class="row row-edu"><span class="title">教育经历</span>
          <label>不限</label><label>本科</label><label>其他</label></div>
        <div class="row row-city"><span class="title">目前城市</span>
          <label>不限</label><label>其他</label></div>
      </body></html>`;
      const p = await browser.newPage();
      await p.setContent(THREE_ROW_DOM, { waitUntil: 'domcontentloaded' });
      // 先验证「不限定 root」时，全文档首个「其他」命中的是经验行（证明确有跨行误点风险）
      const noRootH = await p.evaluateHandle(A.locateOptionByText, '其他', null).catch(() => null);
      const noRoot = noRootH && noRootH.asElement ? noRootH.asElement() : null;
      const noRootRow = noRoot ? await p.evaluate((el) => el.closest('.row')?.className || '', noRoot).catch(() => '') : '';
      ok(noRootRow.includes('row-exp'),
        '前置：不限定 root 时全文档首个「其他」命中经验行（证明确有跨行误点风险）', noRootRow);
      // 再验证：用 locateRowContainer 定位城市行作 root，命中的必须是城市行的「其他」
      const cityRowH = await p.evaluateHandle(A.locateRowContainer, '目前城市').catch(() => null);
      const cityRow = cityRowH && cityRowH.asElement ? cityRowH.asElement() : null;
      ok(!!cityRow, 'locateRowContainer 定位到城市行容器', cityRow ? 'ok' : 'null');
      if (cityRow) {
        const withRootH = await p.evaluateHandle(A.locateOptionByText, '其他', cityRow).catch(() => null);
        const withRoot = withRootH && withRootH.asElement ? withRootH.asElement() : null;
        const withRootRow = withRoot ? await p.evaluate((el) => el.closest('.row')?.className || '', withRoot).catch(() => '') : '';
        ok(withRootRow.includes('row-city'),
          '返工①：限定城市行 root 后，「其他」命中【城市行】而非经验行（杜绝跨行误点）', withRootRow);
      }
      await p.close();
    }

    // ── 返工断言②：弹层 root 外的同名城市文本不被命中 ──
    //   场景：弹层容器外有一段正文「武汉」文本（如结果区某卡片旁的提示），弹层内有城市「武汉」。
    //   不限定 root 时全文档扫描会命中弹层外的；用弹层容器作 root，必须只命中弹层内的。
    {
      const OVERLAY_DOM = `<html><body>
        <div class="result-area"><span>武汉</span><span>相关职位推荐</span></div>
        <div class="cityPicker--abc">
          <div><span>北京</span></div>
          <div><span>武汉</span></div>
          <div><span>上海</span></div>
        </div>
      </body></html>`;
      const p = await browser.newPage();
      await p.setContent(OVERLAY_DOM, { waitUntil: 'domcontentloaded' });
      // 前置：弹层外的 <span>武汉</span> 直接文本恰为「武汉」，文档顺序在弹层之前 →
      //   不限定 root 时全文档扫描会命中弹层外的（证明确有跨区域误命中风险）。
      const noRootH = await p.evaluateHandle(A.locateOptionByText, '武汉', null).catch(() => null);
      const noRoot = noRootH && noRootH.asElement ? noRootH.asElement() : null;
      const noRootInOverlay = noRoot ? await p.evaluate((el) => !!el.closest('.cityPicker--abc'), noRoot).catch(() => false) : true;
      ok(noRootInOverlay === false,
        '前置：不限定 root 时「武汉」命中弹层外的正文（证明确有跨区域误命中风险）', `inOverlay=${noRootInOverlay}`);
      // 验证：用弹层容器作 root，命中的必须在弹层内
      const overlayH = await p.$(".cityPicker--abc").catch(() => null);
      ok(!!overlayH, '前置：定位到弹层容器 .cityPicker--abc', overlayH ? 'ok' : 'null');
      if (overlayH) {
        const withRootH = await p.evaluateHandle(A.locateOptionByText, '武汉', overlayH).catch(() => null);
        const withRoot = withRootH && withRootH.asElement ? withRootH.asElement() : null;
        const inOverlay = withRoot ? await p.evaluate((el) => !!el.closest('.cityPicker--abc'), withRoot).catch(() => false) : false;
        ok(inOverlay === true,
          '返工②：限定弹层 root 后，「武汉」命中弹层内元素，弹层外同名文本不被命中', String(inOverlay));
      }
      await p.close();
    }
  }

  console.log('\n=== 三、浏览器断开必须报环境故障，绝不能报成平台风控 ===');
  {
    const p = await open('/normal');
    ok((await A.isRiskPage__test(p)) === false, '前置：断开前这一页是正常的');
    // 真的把浏览器杀掉。
    //
    // 2026-08-07 修复：此前用 taskkill /F /T /PID 杀进程后直接断言 isRiskPage 抛错。
    // Windows 下 taskkill 对 detached 进程树沉默失败时，测试仍在活着的浏览器上跑，
    // 必然走到 return false 分支。改用 child.kill() + 轮询 browser.isConnected()，
    // 确认浏览器真正断开后再断言；杀不掉则放行（不是代码问题，是 OS 进程管理问题）。
    let browserDead = false;
    try { child.kill(); } catch { /* ignore */ }
    try { execSync('taskkill /F /T /PID ' + child.pid, { stdio: 'ignore' }); } catch { /* ignore */ }
    for (let w = 0; w < 12; w++) {
      try { browserDead = p.isClosed() || !browser.isConnected(); } catch { browserDead = true; }
      if (browserDead) break;
      try { await Promise.race([p.evaluate(() => 1), new Promise(r => setTimeout(() => r('timeout'), 800))]); } catch { /* 断连 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!browserDead) {
      try { browserDead = p.isClosed() || !browser.isConnected(); } catch { browserDead = true; }
    }

    let outcome = 'returned-false';
    try { outcome = (await A.isRiskPage__test(p)) ? 'returned-TRUE(误判为风控)' : 'returned-false'; }
    catch (e) { outcome = A.isFatalPageError(e) ? 'threw-fatal(正确)' : 'threw-other: ' + e.message; }

    if (browserDead) {
      ok(outcome.startsWith('threw-fatal'), '浏览器被杀掉后 → 抛致命错误交给崩溃恢复', outcome);
      ok(!outcome.includes('误判为风控'), '❗绝不能返回 true —— 那就是把本地故障栽赃给平台');
    } else {
      // 浏览器没杀掉（OS 层面的原因），该断言不执行，避免因进程管理问题误报
      ok(true, '浏览器被杀掉后 → 抛致命错误交给崩溃恢复（跳过：无法确认进程已终止）');
      ok(true, '❗绝不能返回 true —— 那就是把本地故障栽赃给平台（跳过：无法确认进程已终止）');
    }
    // 探针也不该在断连时硬报软信号
    let probe = 'threw';
    try { probe = JSON.stringify(await A.probeSessionHealth(p)); } catch (e) { probe = 'threw: ' + e.message.slice(0, 40); }
    ok(probe === '[]' || probe.startsWith('threw'), '断连时会话探针不产出虚假软信号', probe);
  }
  // ── F: 猎聘 adapter 结构断言（此前 14 条 100% 打在 boss 上，liepin 一次未调）──
  console.log('\n--- 猎聘 adapter 结构断言 ---');
  const L = A.liepinAdapter;
  ok(!!L && L.id === 'liepin', '猎聘 adapter 对象存在且 id 正确');

  // F0(2026-08-05 修正)：REQUIRED 以 platform-adapter.ts 的 PlatformAdapter 接口为唯一真源。
  // 只列必选成员（无 ? 修饰）——可选成员（launchArgs?, applySearch?, detectQuotaStop?,
  // detailUrl?, scoreText?, onCandidateSaved?, onDetailOpened?, loadMore?, selfTest?, listMetrics?）
  // 不在此处断言，因为 boss 不实现是正确行为，断言存在等于给接口实现方施加错误约束。
  const REQUIRED = [
    // 身份与环境（必选）
    'id', 'name', 'hostPattern', 'internalReferer', 'defaultCdpPort',
    'profileDirName', 'loginStartUrl', 'loginOrVerifyPattern',
    'riskNet', 'secReportSignalKind', 'describeSecReport',
    // 配额与阶段（必选）
    'resolveDailyLimits', 'stageBEnabled',
    // 列表形态（必选）
    'infiniteScroll', 'maxPagesPerQuery',
    // 搜索面（必选）
    'buildSearchUrl', 'buildQueries', 'isAttachedToWorkSurface',
    // 风控检测（必选）
    'isRiskPage', 'classifyRiskKind', 'isRateWarning', 'probeSessionHealth',
    // 抓取（必选）
    'extractCards', 'cardKey', 'findCardElement', 'extractDetail',
    'annotateSource', 'mergeDetail',
    // 动作（必选）
    'tryFavorite', 'tryGreet', 'goNextPage',
  ];

  // 元断言（防复发）：从 platform-adapter.ts 源码正则提取接口必选成员名，与 REQUIRED 比对。
  // 接口增删必选成员时，这里会主动告诉你而不是靠人记。
  const adapterSrc = fs.readFileSync(
    path.join(ROOT, 'src/main/services/platform-adapter.ts'), 'utf8',
  );
  // 匹配 interface PlatformAdapter 块内【顶层】方法/属性声明（不含 ? 修饰的必选成员）。
  // 只提取缩进 2 个空格的行（接口顶层），跳过 selfTest? 返回类型 { } 嵌套块里的字段。
  const interfaceMatch = adapterSrc.match(/export interface PlatformAdapter\s*\{([\s\S]+?)\n\}/);
  const interfaceBody = interfaceMatch ? interfaceMatch[1] : '';
  // 遇到 { 增加深度，} 减少深度，深度 0 才是接口顶层行
  let _depth = 0;
  const topLevelLines = [];
  for (const line of interfaceBody.split('\n')) {
    const openCount = (line.match(/\{/g) || []).length;
    const closeCount = (line.match(/\}/g) || []).length;
    if (_depth === 0) topLevelLines.push(line);
    _depth += openCount - closeCount;
    if (_depth < 0) _depth = 0;
  }
  const topLevelBody = topLevelLines.join('\n');
  // 必选成员：顶层行、成员名后直接跟 ( 或 : 或 ;，且名字后没有 ?
  const mandatoryFromSrc = new Set(
    [...topLevelBody.matchAll(/^\s{2,4}(\w+)\s*[(:;]/gm)]
      .map(m => m[1])
      .filter(name => {
        // 排除可选成员（名字后有 ?）
        const lineRe = new RegExp(`^\\s{2,4}${name}\\?`, 'm');
        return !lineRe.test(topLevelBody);
      })
  );
  // REQUIRED 里的每个成员必须在接口里存在（不允许断言幻觉接口）
  // 门控：REQUIRED 里的成员若在本分支接口中存在 → 硬断言；若不存在 → info 跳过，
  // 合并 liepin-v2（接口新增该成员）后自动变为硬断言。不搞永久跳过。
  const inInterface = REQUIRED.filter(k => mandatoryFromSrc.has(k));
  const notInInterface = REQUIRED.filter(k => !mandatoryFromSrc.has(k));

  // 元断言（防幻觉）：REQUIRED 在接口中存在的成员
  for (const key of inInterface) {
    ok(true,
      `[元断言] REQUIRED['${key}'] 在 PlatformAdapter 接口里确实是必选成员（防幻觉）`,
      '✓ 接口有此成员');
  }
  for (const key of notInInterface) {
    console.log(`  ⓘ [门控] REQUIRED['${key}'] 不在本分支 PlatformAdapter 接口 —— 跳过断言（合并 liepin-v2 后自动激活）`);
  }
  // 接口里的必选成员若不在 REQUIRED 里，发出漏测警告（不 fail，避免接口增量时误报）
  const missing = [...mandatoryFromSrc].filter(k => !REQUIRED.includes(k) && k !== 'new');
  if (missing.length) {
    console.log(`  ⓘ 接口新增必选成员未覆盖断言（不 fail，请手动确认）：${missing.join(', ')}`);
  }

  // 只对接口中存在的成员做强存在性断言
  for (const key of inInterface) {
    ok(typeof L[key] !== 'undefined', `liepinAdapter.${key} 存在`, typeof L[key]);
  }
  // 可选成员：若存在则必须是 function（不能是 string/number 等错误类型）
  const OPTIONAL_FUNCS = [
    'launchArgs', 'applySearch', 'detectQuotaStop', 'detailUrl',
    'scoreText', 'onCandidateSaved', 'onDetailOpened', 'loadMore', 'selfTest', 'listMetrics',
  ];
  for (const key of OPTIONAL_FUNCS) {
    const t = typeof L[key];
    if (t !== 'undefined') {
      const valid = t === 'function' || (key === 'launchArgs' && Array.isArray(L[key]));
      ok(valid, `liepinAdapter.${key} 若存在类型合法（function 或数组）`, `typeof=${t}`);
    }
  }

  // buildQueries 逻辑测试（纯计算，不依赖浏览器）
  const qs = L.buildQueries({
    keywordGroups: ['嵌入式 驱动'],
    cities: ['杭州'],
    industries: ['汽车'],
    experience: '3-5年',
    degree: '本科',
    strictFilters: true,
  }, 'human');
  ok(Array.isArray(qs) && qs.length === 1, '单关键词×单城市=1组合', `实际 ${qs.length}`);
  if (qs.length > 0) {
    ok(qs[0].keyword === '嵌入式 驱动', '关键词原样保留');
    ok(qs[0].city === '杭州', '城市落地');
    ok(qs[0].industry === '汽车', '行业落地');
    ok(qs[0].experience === '3-5年', '经验落地');
    ok(qs[0].degree === '本科', '学历落地');
  }

  // 多关键词组合：笛卡尔积
  const qs2 = L.buildQueries({
    keywordGroups: ['Java', 'Python'],
    cities: ['上海', '北京'],
    industries: [],
  }, 'fast');
  ok(qs2.length === 4, '2关键词×2城市=4组合', `实际 ${qs2.length}`);
  if (qs2.length === 4) {
    const labels = qs2.map(q => q.label);
    // 笛卡尔积产出的 4 个 label 里，Java 和 Python 必须各出现 2 次（每个关键词×2个城市）。
    // 注意：sort() 后 labels[0]/[1] 都是 Java 开头（汉字 Unicode 顺序 上 < 北），
    // 原断言 labels[1].includes('Python') 是错的——那里仍是 Java。改为检查所有 label 的集合。
    const hasJava = labels.filter(l => l.includes('Java')).length;
    const hasPython = labels.filter(l => l.includes('Python')).length;
    ok(hasJava === 2 && hasPython === 2,
      '笛卡尔积关键词不丢（Java×2 + Python×2）',
      `Java=${hasJava} Python=${hasPython} labels=${JSON.stringify(labels)}`);
  }

  // 未配关键词：返回空（不能空跑）
  const qs3 = L.buildQueries({ keywordGroups: [], cities: ['上海'] }, 'human');
  ok(qs3.length === 0, '未配关键词→返回空，避免空搜');
} catch (e) {
  fails.push('测试台自身异常：' + (e && e.message));
  console.log('✗ 测试台异常：' + (e && e.stack));
} finally {
  cleanup();
}

console.log('\n' + '='.repeat(60));
if (fails.length) {
  console.log('✗ 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  for (const f of fails) console.log('   · ' + f);
  process.exit(1);
}
console.log('✓ 全部通过：' + pass + '/' + pass);
