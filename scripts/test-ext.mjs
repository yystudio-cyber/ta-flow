/**
 * 「TA 匹配分助手」渲染冒烟测试 —— 真 Chrome、真 Shadow DOM、真 hover/click。
 *
 * 为什么要有它：上一版翻车的根因（mode:'closed' 之后仍用 host.shadowRoot 取根，
 * 导致徽章一个都渲染不出来）在静态审查里看着完全正常，只有真跑才暴露。
 *
 * 做法：起一个本地假 BOSS 列表页（不联网、不碰 zhipin.com），把 content.bundle.js
 * 当普通脚本注入，用 chrome.* 桩喂 JD，再从被 hook 住的 attachShadow 拿到 closed
 * shadow root 做断言。测试只在页面里加桩，不改被测代码。
 *
 * 用法：npm run ext:test
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'extension', 'boss-match-score', 'content.bundle.js');

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

// ── 假 BOSS 卡片：结构照抄真实推荐牛人列表的选择器约定 ──────────────────
const CARD = (gid, name, expect, years, degree, city, company, tags, salary) => `
<li class="card-item">
  <div class="card-inner" data-geekid="${gid}">
    <div class="name">${name}</div>
    <div class="expect-wrap"><span class="content">${expect}</span></div>
    <div class="base-info"><span>${years}</span><span>${degree}</span><span>${city}</span></div>
    <div class="company-name">${company}</div>
    <div class="tag-list">${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
    <div class="salary-wrap">${salary}</div>
  </div>
</li>`;

const PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>假·推荐牛人</title>
<style>body{margin:0;font-family:sans-serif}ul{list-style:none;padding:0;margin:0}
li.card-item{border:1px solid #eee;padding:12px;margin:8px;min-height:90px}</style></head>
<body><main><ul class="job-list-box">
${CARD('g1', '张三', 'Java开发工程师', '5年', '本科', '杭州', '某某科技有限公司', ['Java', 'Spring Boot', 'MySQL'], '20-30K')}
${CARD('g2', '李四', '前端开发工程师', '2年', '大专', '北京', '某创业公司', ['Vue', 'JavaScript'], '15-20K')}
${CARD('g3', '王五', '嵌入式软件工程师', '8年', '硕士', '上海', '某汽车电子集团', ['C语言', 'RTOS', 'CAN总线'], '35-45K')}
</ul></main></body></html>`;

// ── JD 桩（模拟平台 /jd/active 的返回）─────────────────────────────────
// jdList 必须是【完整 JD】，与 jd-bridge.readJdList() 的返回形状一致——只给
// id/name/title 的话，切岗位后引擎拿不到 basic/keywords，会给所有人打同一个默认分。
const JD_JAVA = {
  id: 'jd-java', name: 'Java 后端开发', title: 'Java 后端开发工程师',
  basic: { degree: '本科', experienceMin: 3, experienceMax: 8, city: '杭州', salaryMax: 35 },
  keywords: { required: ['Java', 'Spring'], bonus: ['MySQL'], negative: [] },
  industry: { preferred: ['互联网'], excluded: [] },
};
const JD_FE = {
  id: 'jd-fe', name: '前端开发', title: '前端开发工程师',
  basic: { degree: '大专', experienceMin: 1, experienceMax: 5, city: '北京', salaryMax: 25 },
  keywords: { required: ['Vue', 'JavaScript'], bonus: ['TypeScript'], negative: [] },
  industry: { preferred: [], excluded: [] },
};
const JD_EMB = {
  id: 'jd-emb', name: '嵌入式软件', title: '嵌入式软件工程师',
  basic: { degree: '本科', experienceMin: 5, experienceMax: 12, city: '上海', salaryMax: 50 },
  keywords: { required: ['C语言', 'RTOS'], bonus: ['CAN总线'], negative: [] },
  industry: { preferred: ['汽车'], excluded: [] },
};
const JD_PAYLOAD = {
  jd: JD_JAVA,
  jdList: [JD_JAVA, JD_FE, JD_EMB],
  weights: { experience: 20, keywords: 30, degree: 10, industry: 10, companyTier: 5, projects: 10, salary: 10, location: 5 },
  thresholds: { high: 75, low: 60 },
};

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra == null ? '' : String(extra) });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra != null ? '  → ' + extra : ''}`);
}

// 引擎有几个维度就该渲染几条——从共享引擎源码里数出来，别在测试里硬编码，
// 否则引擎一加维度（如 2026-07-28 加的「年龄」）这里就会假报失败。
const ENGINE_DIMS = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'scoring-universal.js'), 'utf-8');
  const block = src.match(/var details = \[([\s\S]*?)\];/);
  if (!block) { console.error('✗ 数不出引擎维度数，scoring-universal.js 的 details 数组形态变了'); process.exit(1); }
  return (block[1].match(/score[A-Z]\w*\(/g) || []).length;
})();

// 心跳间隔从产物里读，别在测试里写死——改了常量测试会跟着调整等待时长
const ALIVE_TICK_MS = (() => {
  const m = fs.readFileSync(BUNDLE, 'utf-8').match(/ALIVE_TICK_MS\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 15000;
})();

const exe = findChrome();
if (!exe) { console.error('✗ 找不到 Chrome/Edge，跳过渲染测试'); process.exit(2); }
if (!fs.existsSync(BUNDLE)) { console.error('✗ 产物不存在，请先 npm run ext:build'); process.exit(1); }
const bundleSrc = fs.readFileSync(BUNDLE, 'utf-8');

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text()); });

// 断网兜底：任何非 about:blank 的请求都拦掉，确保测试里不可能真发出网络请求
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (r.url().startsWith('data:') || r.url() === 'about:blank') r.continue();
  else r.abort();
});

await page.setContent(PAGE_HTML, { waitUntil: 'domcontentloaded' });

// 桩：chrome.* + attachShadow 记录（不改被测代码，只在外面挂钩子）
await page.evaluate((jd) => {
  window.__roots = [];
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const r = orig.call(this, init);
    window.__roots.push({ host: this, root: r, mode: init && init.mode });
    return r;
  };
  window.__storageListeners = [];
  window.__sent = [];
  window.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg, cb) => {
        window.__sent.push(msg);
        if (msg && msg.type === 'ta-get-jd' && cb) setTimeout(() => cb(window.__jd), 0);
        else if (cb) setTimeout(() => cb({ ok: true }), 0);
      },
    },
    storage: {
      local: {},
      onChanged: { addListener: (fn) => window.__storageListeners.push(fn) },
    },
  };
  window.__jd = jd;
}, JD_PAYLOAD);

await page.addScriptTag({ content: bundleSrc });
await new Promise((r) => setTimeout(r, 600));

// ── 断言 1：三张卡片都拿到了 closed shadow root，且都渲染出徽章 ──────────
const r1 = await page.evaluate(() => {
  const out = { roots: window.__roots.length, closed: 0, badges: [], hostsInDom: 0 };
  for (const e of window.__roots) {
    if (e.mode === 'closed') out.closed++;
    if (e.host.parentNode) out.hostsInDom++;
    const b = e.root.querySelector('.b');
    out.badges.push(b ? b.textContent : null);
  }
  return out;
});
check('每张卡片建了一个 closed shadow 宿主（3 张）', r1.roots === 3 && r1.closed === 3, `roots=${r1.roots} closed=${r1.closed}`);
check('宿主都还挂在 DOM 上（没有被反复删建）', r1.hostsInDom === 3, `inDom=${r1.hostsInDom}`);
check('三张卡片都渲染出了徽章', r1.badges.every((b) => b && b.length), JSON.stringify(r1.badges));
// 2026-08-11 口径变更：推荐牛人列表是【卡片层】，不再显示数字分，改显示三档判定。
// 原因见 scoring-universal.js 的 cardVerdict 注释——卡片层数字全顶在 CARD_MAX=85，
// 「理想候选人」与「空卡片」同分，精确感是假的。断言随实现更新，不是放宽：
// 仍然要求徽章必须是有意义的结论文案，不许是占位符或空白。
const VERDICT_OK = /^(值得看|一般|不匹配|岗位不符)$/;
check('徽章内容是三档判定或"岗位不符"，不是占位 —', r1.badges.every((b) => VERDICT_OK.test(b)), JSON.stringify(r1.badges));

// ── 断言 2：分数落在合理区间，且硬门槛生效（李四 2年<3年 → 岗位不符）────
const r2 = await page.evaluate(() => {
  const m = {};
  window.__roots.forEach((e, i) => {
    const b = e.root.querySelector('.b');
    m['card' + (i + 1)] = b ? b.textContent : null;
  });
  return m;
});
check('张三(Java/5年/本科) 出三档判定', VERDICT_OK.test(r2.card1 || ''), r2.card1);
check('李四(2年 < 要求3年) 判为岗位不符', r2.card2 === '岗位不符', r2.card2);
// 防回归：三个背景迥异的候选人如果分数全一样，说明引擎根本没吃到 JD 内容（jdList 只给了精简字段）
check('三人分数不是同一个值（说明 JD 真的传到了引擎）',
  new Set([r2.card1, r2.card2, r2.card3]).size >= 2, `${r2.card1} / ${r2.card2} / ${r2.card3}`);

// ── 断言 3：hover 出详情卡片，且定位后不越界 ────────────────────────────
// C(hover): mouseleave 改为 250ms 延迟隐藏（修复 10px gap 鼠标穿越时立即消失的 bug）。
// 测试必须等延迟过去才能验证"移开后收起"，改用 async evaluate + setTimeout 等 300ms。
const r3 = await page.evaluate(async () => {
  const e = window.__roots[0];
  const wrap = e.root.querySelector('.hw');
  const dc = e.root.querySelector('.dc');
  const before = getComputedStyle(dc).display;
  wrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  const after = getComputedStyle(dc).display;
  const rect = dc.getBoundingClientRect();
  const dims = e.root.querySelectorAll('.dr').length;
  const naDims = e.root.querySelectorAll('.dr.na').length;
  const cv = e.root.querySelector('.cv');
  const hasHeader = !!e.root.querySelector('.ds');
  wrap.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
  // 等延迟隐藏触发（250ms），留 50ms 余量
  await new Promise(r => setTimeout(r, 310));
  const closed = getComputedStyle(dc).display;
  return {
    before, after, closed, w: Math.round(rect.width), h: Math.round(rect.height),
    left: Math.round(rect.left), top: Math.round(rect.top), dims, naDims, hasHeader,
    cvText: cv ? cv.textContent : null,
  };
});
check('详情卡片默认隐藏', r3.before === 'none', r3.before);
check('hover 后展开', r3.after === 'block', r3.after);
check('展开后量到真实尺寸（不再是 0×0）', r3.w > 0 && r3.h > 0, `${r3.w}×${r3.h}`);
check('详情卡片不越出视口左边界', r3.left >= 0, `left=${r3.left}`);
// 维度数跟着共享引擎走（引擎加维度时这里不该失败），只要求条数与引擎返回的一致
check('维度条数与评分引擎一致', r3.dims === ENGINE_DIMS, `渲染 ${r3.dims} 条 / 引擎 ${ENGINE_DIMS} 个维度`);
// 判不了的维度已被引擎踢出加权，界面必须标成"无数据"，不能画成一根正常的条
check('判不了的维度标为无数据（不冒充参与计分）', r3.naDims > 0, `${r3.naDims} 个维度无数据`);
check('展示数据覆盖度', !!r3.cvText && /覆盖度\s*\d+%/.test(r3.cvText), r3.cvText);
check('移开后收起', r3.closed === 'none', r3.closed);

// ── 断言 4：菜单可点（pointer-events 继承坑）+ 切岗位后重算 ──────────────
const r4 = await page.evaluate(async () => {
  const e = window.__roots[0];
  const badge = e.root.querySelector('.b');
  badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const menu = e.root.querySelector('.menu');
  const pe = menu ? getComputedStyle(menu).pointerEvents : null;
  const items = menu ? menu.querySelectorAll('.mi').length : 0;
  const scoreBefore = e.root.querySelector('.b').textContent;
  // 切到「嵌入式软件」——张三是 Java，切过去分数应当变化
  const target = menu ? Array.from(menu.querySelectorAll('.mi')).find((x) => x.textContent.includes('嵌入式')) : null;
  if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const e2 = window.__roots[0];
  return {
    menuShown: !!menu, pe, items,
    menuGoneAfterPick: !e2.root.querySelector('.menu'),
    scoreBefore, scoreAfter: e2.root.querySelector('.b') ? e2.root.querySelector('.b').textContent : null,
    jobTitle: e2.root.querySelector('.dt') ? e2.root.querySelector('.dt').textContent : '',
  };
});
check('点徽章弹出岗位菜单', r4.menuShown && r4.items === 3, `items=${r4.items}`);
check('菜单 pointer-events 是 auto（宿主 none 会继承下来）', r4.pe === 'auto', r4.pe);
check('选完岗位菜单自动关闭', r4.menuGoneAfterPick);
check('切岗位后重新评分', r4.scoreAfter && r4.scoreAfter !== r4.scoreBefore, `${r4.scoreBefore} → ${r4.scoreAfter}`);
check('详情卡片头部显示切换后的岗位名', /嵌入式/.test(r4.jobTitle), r4.jobTitle.trim());

// ── 断言 4b：切完岗位后 hover 仍然有效，且监听器没有重复累加 ─────────────
// （回归项：hover 监听若写在 renderBadge 里，每次重渲染都会再挂一遍，
//   旧闭包指向已被清掉的旧 .dc，表现就是"切完岗位详情卡片打不开了"）
const r4b = await page.evaluate(async () => {
  const e = window.__roots[0];
  const wrap = e.root.querySelector('.hw');
  let enterCount = 0;
  const probe = () => { enterCount++; };
  wrap.addEventListener('mouseenter', probe);
  wrap.dispatchEvent(new MouseEvent('mouseenter'));
  const dc = e.root.querySelector('.dc');
  const disp = getComputedStyle(dc).display;
  const rect = dc.getBoundingClientRect();
  wrap.dispatchEvent(new MouseEvent('mouseleave'));
  wrap.removeEventListener('mouseenter', probe);
  return { disp, w: Math.round(rect.width), h: Math.round(rect.height), enterCount, jd: e.root.querySelector('.dt').textContent };
});
check('切岗位后 hover 详情卡片仍能展开', r4b.disp === 'block' && r4b.w > 0 && r4b.h > 0, `${r4b.disp} ${r4b.w}×${r4b.h}`);
check('展开的是切换后岗位的卡片', /嵌入式/.test(r4b.jd), r4b.jd.trim());

// ── 断言 5：只开一个菜单 + 点页面空白处关闭 ─────────────────────────────
const r5 = await page.evaluate(async () => {
  const a = window.__roots[0], b = window.__roots[1];
  a.root.querySelector('.b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  b.root.querySelector('.b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const both = [!!a.root.querySelector('.menu'), !!b.root.querySelector('.menu')];
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  return { both, afterOutside: [!!a.root.querySelector('.menu'), !!b.root.querySelector('.menu')] };
});
check('同一时刻只存在一个菜单', r5.both[0] === false && r5.both[1] === true, JSON.stringify(r5.both));
check('点页面空白处关闭菜单', r5.afterOutside.every((x) => !x), JSON.stringify(r5.afterOutside));

// ── 断言 5b：徽章二次点击能关掉自己的菜单（真实点击是 composed:true，会穿出
//    closed shadow 且 target 重定向为宿主——document 捕获监听若不放行宿主，
//    会先把菜单关掉、随后徽章 toggle 又开一个，菜单永远关不上）──────────────
const r5b = await page.evaluate(async () => {
  const e = window.__roots[0];
  const real = { bubbles: true, composed: true };   // 模拟真实用户点击
  e.root.querySelector('.b').dispatchEvent(new MouseEvent('click', real));
  await new Promise((r) => setTimeout(r, 30));
  const opened = !!e.root.querySelector('.menu');
  e.root.querySelector('.b').dispatchEvent(new MouseEvent('click', real));
  await new Promise((r) => setTimeout(r, 30));
  const closedAgain = !e.root.querySelector('.menu');
  // 再验证 composed 点击下"点外面关闭"仍有效
  e.root.querySelector('.b').dispatchEvent(new MouseEvent('click', real));
  await new Promise((r) => setTimeout(r, 30));
  document.body.dispatchEvent(new MouseEvent('click', real));
  await new Promise((r) => setTimeout(r, 60));
  const closedByOutside = !e.root.querySelector('.menu');
  return { opened, closedAgain, closedByOutside };
});
check('composed 点击下徽章能开菜单', r5b.opened);
check('徽章二次点击关掉自己的菜单（toggle 修复）', r5b.closedAgain);
check('composed 点击下点外面仍能关菜单', r5b.closedByOutside);

// ── 断言 5c：切标签页回来不冲掉手动选的岗位 ─────────────────────────────
const r5c = await page.evaluate(async () => {
  const e = window.__roots[0];
  const before = e.root.querySelector('.b').textContent;   // 手动选的嵌入式 → 54
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 300));
  const after = e.root.querySelector('.b').textContent;
  const jd = e.root.querySelector('.dt') ? e.root.querySelector('.dt').textContent : '';
  return { before, after, jd };
});
check('visibilitychange 后手动选的岗位不被冲掉', r5c.before === r5c.after && /嵌入式/.test(r5c.jd), `${r5c.before} → ${r5c.after} (${r5c.jd.trim()})`);

// ── 断言 6：平台"有岗位库但没激活任何岗位"时不炸 ─────────────────────────
const r6 = await page.evaluate(async () => {
  const before = window.__pageErrors || [];
  window.__jd = { jd: null, jdList: [{ id: 'x', name: '某岗位', title: '' }], weights: null, thresholds: { high: 75, low: 60 } };
  window.__storageListeners.forEach((fn) => fn({ 'ta-jd-cache': { newValue: window.__jd } }, 'local'));
  await new Promise((r) => setTimeout(r, 300));
  const e = window.__roots[0];
  const b = e.root.querySelector('.b');
  return { text: b ? b.textContent : null, cls: b ? b.className : null, before: before.length };
});
check('无激活岗位时降级为占位徽章而非抛错', r6.text === '—' && /b-i/.test(r6.cls || ''), `${r6.text} / ${r6.cls}`);

// ── 断言 6b：向平台上报 BOSS 页面心跳（工具库那两个按钮靠它区分状态）──────
const r6b = await page.evaluate(async () => {
  const alive = window.__sent.filter((m) => m && m.type === 'ta-boss-alive');
  const before = alive.length;
  document.dispatchEvent(new Event('visibilitychange'));   // 切回标签页应补报一次
  await new Promise((r) => setTimeout(r, 200));
  const after = window.__sent.filter((m) => m && m.type === 'ta-boss-alive');
  return { before, after: after.length, cards: after.length ? after[after.length - 1].cards : null };
});
check('启动后向平台上报 BOSS 心跳', r6b.before >= 1, `${r6b.before} 次`);
check('心跳带上当前卡片数', r6b.cards === 3, `cards=${r6b.cards}`);
check('切回标签页补报一次心跳', r6b.after > r6b.before, `${r6b.before} → ${r6b.after}`);

// 回归项：只有"页面刚开/刚切回来"的心跳才带 first——background 靠它决定要不要
// 立刻拉一次岗位。若普通心跳也带 first，15 秒一次的心跳会把同步频率放大好几倍。
//
// 这条必须等到定时心跳真的响过一次才有意义：不等的话 first 全是 true，
// 写成 firsts <= total 就是恒真断言，锁不住任何东西。
console.log(`   （等待定时心跳触发，约 ${Math.round(ALIVE_TICK_MS / 1000)} 秒…）`);
await new Promise((r) => setTimeout(r, ALIVE_TICK_MS + 1500));
const r6c = await page.evaluate(() => {
  const alive = window.__sent.filter((m) => m && m.type === 'ta-boss-alive');
  return {
    total: alive.length,
    firsts: alive.filter((m) => m.first).length,
    plains: alive.filter((m) => !m.first).length,
  };
});
check('首次/切回的心跳带 first 标记', r6c.firsts >= 1, `${r6c.firsts} 条带 first`);
check('定时心跳不带 first（不放大同步频率）', r6c.plains >= 1, `${r6c.plains} 条普通心跳 / 共 ${r6c.total} 条`);

// ── 断言 7：全程零 JS 报错、零网络请求 ──────────────────────────────────
check('页面无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

// ── 断言 8：宿主对页面 JS 不可见（closed 隔离）───────────────────────────
const r8 = await page.evaluate(() => {
  const hosts = document.querySelectorAll('li.card-item > span');
  let leaked = 0;
  hosts.forEach((h) => { if (h.shadowRoot) leaked++; });
  return { hosts: hosts.length, leaked, badgeViaQuery: document.querySelectorAll('.b').length };
});
check('页面 JS 拿不到 shadowRoot（closed 生效）', r8.leaked === 0, `leaked=${r8.leaked}`);
check('全局选择器命中不到徽章', r8.badgeViaQuery === 0, `hits=${r8.badgeViaQuery}`);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✓ 全部通过' : '✗ 失败 ' + failed.length + ' 项'}：${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
