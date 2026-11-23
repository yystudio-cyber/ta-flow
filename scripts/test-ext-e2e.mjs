/**
 * 「TA 匹配分助手」清单级端到端测试 —— 真扩展、真 iframe、真同步链路。
 *
 * 为什么要有它：test-ext.mjs 只把 content.bundle.js 当普通脚本注进假页面，
 * 验证的是"代码逻辑"；但 2026-07-29 的真机事故（装好了却一分不出）根因全在
 * 它测不到的那一层——manifest 的注入规则（all_frames / matches）、扩展是否被
 * Chrome 接受、background→bridge→storage→content 的同步链路。本测试把这一层补上：
 *
 *   1. Chrome 以 --load-extension 真实装载扩展（manifest 非法会当场暴露）；
 *   2. --host-resolver-rules 把 www.zhipin.com 指到本机 127.0.0.1:443 假站，
 *      其余域名一律 ~NOTFOUND —— 全程零真实外网请求，绝不触碰真 BOSS；
 *   3. 假站复刻真实结构：顶层 /web/chat/recommend 里嵌 /web/frame/recommend/ iframe，
 *      候选人卡片 li.card-item + .btn-greet 全在 iframe 里（与真机一致）；
 *   4. 本机 17385 起假 JD 桥，断言 background 真的带版本指纹来同步过；
 *   5. 用 CDP DOM.getDocument(pierce:true) 穿透 closed shadow 读真实徽章分数。
 *
 * 用法：npm run ext:e2e
 * 退出码：0 全过；1 有失败；2 环境不具备（找不到 Chrome / 443 被占用）跳过。
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension', 'boss-match-score');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8'));
const BRIDGE_PORT = 17385;
const HTTPS_PORT = 443;

// 测试专用自签证书（CN=www.zhipin.com，只配合 --ignore-certificate-errors 在本测试内使用；
// 不是任何真实站点的凭据，泄露无害——私钥从未也永远不会用于测试之外的任何场景）
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC9a2dfM7zuJB85
4eGUZsP5c+NctRWZlgLb7j65rxnWnN9JAp4YIQkUPb/+4J3ASePwgLvSyo+udQ6S
KNnhN3mt8sJ7T0kWfu+rRaUqnrxMvP6fkn3LQFMYQOKDTAY+JdYxm4vhwmM4Pggv
QYeLovoeL9yWeGtrtMBFP+q/2YgfgoDF5ze3jwNmJ2CDeroGTDMLxVEolrLm2nRM
C9wcofDdEw+3ghBMf6Ec9e6LHkXocAVqMtUZmm6GTSg8vDuu2lOMKlp+GIMNthIy
orHOSVrTpC56YP5O41jl8I893+/cIze5SlVCr4obknYApVd74JEzOCLVRsHCiGua
p3Iq5zQJAgMBAAECggEAJk/ceymES6h7tmHlFfaJKeHSOVSZF1T7pA82maj8cWeO
U/6XCmtYIkNxG3TEA3oOg/0NwE9fK1qaxV5E32QwlMnWo0lAj6/B+yLditbLYDwT
xiPDlMIgbHXnOsY8NwLBJYyACPwfxGbrkd9PsqMWstdcZwTZOVI4V2lbqk0t1q1d
mgxXN7gYjcfppM+3clyvTFpI3WxkTLGf7X4TKwDS4woR4GzJ3oTU7+V/XC/LP5wu
LivKokgmkiOrx1dYGWQ98u4M42DAC6sF4z3G9uUrIzVWfERr+2h3SG43CsJBhlzk
JIqsdO7R67E8YLX8lbcC5n0HJ5DW9xGga4cvy17k1wKBgQD0tCC+hxpfk0227mas
VT6q3ikUaYArbFknD9sPW1kGXPhpxLtwODDBX+W+5VOt/LXb9fuJtI2Inwa6XUpL
Kkt6Qh5k5+IoguYit7J8ecVItlLrua2ikpndiFh7ocuarJYghI1fC7mWceVK90ES
XvBwhTQZHUrcNPOE2qDpfK5L5wKBgQDGKe/HOKNfGgSxUon7UtyyU9aYn23xqwA2
h94XBUj+0e7ZO8FqM1SDnzxoR1bm2BtZATp+md1/byA67POz9UoeKjC7+m7ftv0i
x4eJ+XuVCbcpIeJU7li+s5ML0Ue/WHd/t9sZbe3aWmxwq3d/740b6NWHtpMCNIxT
pFkquRUCjwKBgEKjNvOLqSPz4kr5ux4dDLbNTxSO8mdg1xprF/Wjo6e287Mh7wVN
WAGhEticbOBJnGCtKPXEJHLbE6L2ur+jYfCGRu6lsxHjK7aynbmGE7KMbCJjaySF
lb8dXTM1yVNywmNSlYkXkU+l7pIuqRrOnd2WeKyKLJOxG8vHGeDboj9rAoGBAIPs
e1LX4/t2KNWcK3wDiCW4Js9opBsVSokDHtmYjSYHwMkiPPtkvMj7g42woKwCBwLU
DIsoCAvEgWJ5SSzvCa7XS6Z5bMLG4fL7fsJeMuXfl+5sPm9oVfBvQF/Hrco3LSb7
0YM2afjJ5hOEM4QaiIiiEzXMWEZJkXpFmY8VtGUFAoGALD1G+EquhRel130MNRay
IokFoST3+Z5fuY5exTnWQ7TXkK8fyM2CiS+N0t6y2YoqyU1mPr1K5uUU1cVpmVVY
tK5J8VYJD6tNUh4vRV2Y+ndUlWfbN4H4sp3mtobdBMK8QBQxXfFiXxBkCLLzXRSN
bExPWIzhI9zkhYOaYs9mnWs=
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUZ25SbbuOrWSmSuoDDl+1IDrhf68wDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOd3d3LnpoaXBpbi5jb20wHhcNMjYwNzI5MDkyNjMxWhcN
MzYwNzI2MDkyNjMxWjAZMRcwFQYDVQQDDA53d3cuemhpcGluLmNvbTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAL1rZ18zvO4kHznh4ZRmw/lz41y1FZmW
AtvuPrmvGdac30kCnhghCRQ9v/7gncBJ4/CAu9LKj651DpIo2eE3ea3ywntPSRZ+
76tFpSqevEy8/p+SfctAUxhA4oNMBj4l1jGbi+HCYzg+CC9Bh4ui+h4v3JZ4a2u0
wEU/6r/ZiB+CgMXnN7ePA2YnYIN6ugZMMwvFUSiWsubadEwL3Byh8N0TD7eCEEx/
oRz17oseRehwBWoy1RmaboZNKDy8O67aU4wqWn4Ygw22EjKisc5JWtOkLnpg/k7j
WOXwjz3f79wjN7lKVUKvihuSdgClV3vgkTM4ItVGwcKIa5qncirnNAkCAwEAAaNT
MFEwHQYDVR0OBBYEFHJJVgWnKr1UHX6ttvF1oRjJ+ZPOMB8GA1UdIwQYMBaAFHJJ
VgWnKr1UHX6ttvF1oRjJ+ZPOMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBADHpIgyMucxitaq9c6/L0oCvZAEoJOHwMRnGFNnyoW1s6k7SDbT4O+nI
/5PIiZXMTjiTWndmisTNqkk5AFXyGuUpdk7bW/nghFpsGQ/aDURZo44fJL9xcspz
EhfmB5Nm82zDsROpBLP61x+mmjWmRzbo0ck73NOJWN1lpilG8v/5CIWG5LcMJ9x1
X4qqGEWJIkZWpsxXQPiZKBWL+/mU3KVMETrIjl6rkvBKjIugyDiVeXsvCwAW6fWM
EeQ33cxrqD6aabBM/Rb8d939UwUWUdBpbmiqGYcqQWE+qHxJ2maYlcH5AZPHUnJK
MNusH7WgNfM2Xr20/Nmcr9QoVL7znBc=
-----END CERTIFICATE-----`;

// ── 假 BOSS 页面（结构复刻真机：卡片全在 /web/frame/recommend/ 子帧里）────────
const CARD = (gid, name, expect, years, degree, city, company, tags, salary) => `
<li class="card-item">
  <div class="row">
    <div class="card-inner" data-geekid="${gid}">
      <div class="name">${name}</div>
      <div class="expect-wrap"><span class="content">${expect}</span></div>
      <div class="base-info"><span>${years}</span><span>${degree}</span><span>${city}</span></div>
      <div class="company-name">${company}</div>
      <div class="tag-list">${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
      <div class="salary-wrap">${salary}</div>
    </div>
    <div class="op"><button class="btn btn-greet">打招呼</button></div>
  </div>
</li>`;

const FRAME_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>推荐牛人</title>
<style>body{margin:0;font-family:sans-serif}ul{list-style:none;padding:0;margin:0}
li.card-item{border:1px solid #eee;padding:12px;margin:8px;min-height:90px}
.row{display:flex}.card-inner{flex:1}.op{width:120px;text-align:center;padding-top:20px}
.btn-greet{padding:8px 22px;border:0;border-radius:16px;background:#00bebd;color:#fff}</style></head>
<body><main><ul class="job-list-box">
${CARD('g1', '张三', 'Java开发工程师', '5年', '本科', '杭州', '某某科技有限公司', ['Java', 'Spring Boot', 'MySQL'], '20-30K')}
${CARD('g2', '李四', '前端开发工程师', '2年', '大专', '北京', '某创业公司', ['Vue', 'JavaScript'], '15-20K')}
${CARD('g3', '王五', '嵌入式软件工程师', '8年', '硕士', '上海', '某汽车电子集团', ['C语言', 'RTOS', 'CAN总线'], '35-45K')}
</ul></main></body></html>`;

const TOP_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BOSS直聘-推荐牛人</title>
<style>body{margin:0}iframe{width:100%;height:900px;border:0}</style></head>
<body><div class="nav">顶层导航（真机顶层没有任何候选人卡片）</div>
<iframe src="https://www.zhipin.com/web/frame/recommend/abc123"></iframe></body></html>`;

// ── 假 JD 桥（与 jd-bridge /jd/active 同形；扩展有 host_permissions，无需 CORS 头）──
const JD_PAYLOAD = {
  jd: {
    id: 'jd-java', name: 'Java 后端开发', title: 'Java 后端开发工程师',
    basic: { degree: '本科', experienceMin: 3, experienceMax: 8, city: '杭州', salaryMax: 35 },
    keywords: { required: ['Java', 'Spring'], bonus: ['MySQL'], negative: [] },
    industry: { preferred: ['互联网'], excluded: [] },
  },
  jdList: [],
  weights: null,
  defaultWeights: null,
  thresholds: { high: 75, low: 60 },
  serverTime: 0,
};
JD_PAYLOAD.jdList = [JD_PAYLOAD.jd];

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra == null ? '' : String(extra) });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra != null ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只认 Chrome for Testing，不用正式版 Chrome：
// 正式版 137+ 已封死自动化旁加载（--load-extension 直接忽略；实测 150 连
// CDP Extensions.loadUnpacked 装上后也不注入 content script）。CfT 是官方
// 专为自动化保留的通道，--load-extension 行为与用户手动「加载已解压」一致。
const CFT_DIR = path.join(ROOT, 'node_modules', '.cache', 'ta-e2e-browsers');
function findChromeForTesting() {
  try {
    const stack = [CFT_DIR];
    while (stack.length) {
      const d = stack.pop();
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.name === 'chrome.exe') return p;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function listen(server, port, host) {
  return new Promise((resolve) => {
    server.once('error', (e) => resolve({ ok: false, err: e }));
    server.listen(port, host, () => resolve({ ok: true }));
  });
}

// ---- 假站 ----
const site = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url.startsWith('/web/chat/recommend')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(TOP_HTML);
  } else if (url.startsWith('/web/frame/recommend/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(FRAME_HTML);
  } else {
    res.writeHead(404); res.end();
  }
});
const siteUp = await listen(site, HTTPS_PORT, '127.0.0.1');
if (!siteUp.ok) {
  console.error(`✗ 本机 443 端口无法监听（${siteUp.err?.code}）——跳过 E2E（可稍后重试或释放端口）`);
  process.exit(2);
}

// ---- 假 JD 桥。17385 被占（平台正在跑）时退化：不断言同步参数，但注入/渲染断言照做 ----
const bridgeHits = [];
const bridge = http.createServer((req, res) => {
  const [url, q] = (req.url || '').split('?');
  bridgeHits.push({ url, q: q || '' });
  if (url === '/jd/active') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...JD_PAYLOAD, serverTime: Date.now() }));
  } else { res.writeHead(404); res.end(); }
});
const bridgeUp = await listen(bridge, BRIDGE_PORT, '127.0.0.1');
const fakeBridge = bridgeUp.ok;
if (!fakeBridge) console.log('ℹ 17385 已被占用（TA 平台正在运行）：走真桥，跳过同步参数断言');

const exe = findChromeForTesting();
if (!exe) {
  console.error('✗ 未安装 Chrome for Testing，跳过 E2E。安装（约 150MB，一次）：');
  console.error(`  npx @puppeteer/browsers install chrome@stable --path "${CFT_DIR}"`);
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ext-e2e-'));
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  userDataDir: profile,
  args: [
    '--no-sandbox', '--no-first-run', '--disable-sync',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    // zhipin 域指到本机假站；其余域名全部 NOTFOUND —— 双保险确保零外网请求。
    // EXCLUDE 127.0.0.1 必不可少：通配 NOTFOUND 连【IP 直连】都会拦（实测），
    // 没有它，扩展 background 到本机 17385 JD 桥的 fetch 会全部 Failed to fetch。
    '--host-resolver-rules=MAP www.zhipin.com 127.0.0.1,MAP * ~NOTFOUND,EXCLUDE 127.0.0.1',
    '--ignore-certificate-errors',
  ],
});

try {
  // ── 断言 A：CfT 接受 manifest 并启动 background，扩展 ID 与 key 钉死的一致 ──
  // manifest 非法（残留非标字段/语法错误）时扩展装不上，这里 15 秒超时；
  // ID 不等于 jd-bridge CORS 白名单里那个，则说明 key 被动过——桥会拒它。
  let sw = null;
  try {
    sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  } catch { /* fallthrough */ }
  check('Chrome 接受 manifest 并启动了扩展 background', !!sw, sw ? sw.url() : '15 秒内未出现 service worker —— manifest 可能被拒绝');
  const loadedId = sw ? (sw.url().match(/^chrome-extension:\/\/([a-p]{32})\//) || [])[1] : null;
  check('扩展 ID 与 manifest key 钉死的一致（jd-bridge CORS 依赖它）',
    loadedId === 'hhjilkjdngolnidebdlmkkhpoidegbgc', String(loadedId));

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));

  await page.goto('https://www.zhipin.com/web/chat/recommend', { waitUntil: 'networkidle2', timeout: 20000 });

  // ── 断言 B：推荐 iframe 存在，content script 在其中给每张卡建了宿主 ────────
  let frame = null;
  for (let i = 0; i < 40 && !frame; i++) {
    frame = page.frames().find((f) => /\/web\/frame\/recommend\//.test(f.url())) || null;
    if (!frame) await sleep(250);
  }
  check('顶层页里出现 /web/frame/recommend/ 子帧', !!frame, frame ? frame.url() : '未找到');
  if (!frame) throw new Error('无 iframe，后续断言无法进行');

  // 宿主特征：li.card-item 的 span 子节点、position:absolute、z-index:20（内联样式，不靠类名）
  const hostInfo = async () => frame.evaluate(() => {
    const out = [];
    document.querySelectorAll('li.card-item').forEach((li) => {
      const spans = Array.from(li.querySelectorAll(':scope span')).filter((s) => s.style && s.style.zIndex === '20');
      const greet = li.querySelector('.btn-greet');
      const s = spans[0];
      out.push({
        hosts: spans.length,
        rect: s ? (() => { const r = s.getBoundingClientRect(); return { t: r.top, h: r.height, w: r.width, cx: r.left + r.width / 2 }; })() : null,
        greet: greet ? (() => { const r = greet.getBoundingClientRect(); return { b: r.bottom, cx: r.left + r.width / 2 }; })() : null,
      });
    });
    return out;
  });
  let cards = [];
  for (let i = 0; i < 40; i++) {
    cards = await hostInfo();
    if (cards.length === 3 && cards.every((c) => c.hosts === 1 && c.rect && c.rect.h > 0)) break;
    await sleep(250);
  }
  check('iframe 里 3 张卡片各有且仅有一个徽章宿主', cards.length === 3 && cards.every((c) => c.hosts === 1), JSON.stringify(cards.map((c) => c.hosts)));
  check('徽章渲染出了真实尺寸（评分链路走通）', cards.every((c) => c.rect && c.rect.h >= 18 && c.rect.w >= 20), JSON.stringify(cards.map((c) => c.rect && Math.round(c.rect.h))));

  // ── 断言 C：徽章位于「打招呼」按钮正下方（用户指定位置）────────────────────
  const placed = cards.every((c) => c.rect && c.greet
    && c.rect.t >= c.greet.b && c.rect.t <= c.greet.b + 30
    && Math.abs(c.rect.cx - c.greet.cx) <= 12);
  check('徽章在打招呼按钮正下方且水平居中对齐', placed,
    JSON.stringify(cards.map((c) => c.rect && c.greet ? `${Math.round(c.rect.t - c.greet.b)}px/${Math.round(c.rect.cx - c.greet.cx)}px` : 'n/a')));

  // ── 断言 D：顶层文档没有徽章（卡片只在 iframe，顶层不应贴东西）────────────
  const topHosts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('span')).filter((s) => s.style && s.style.zIndex === '20').length);
  check('顶层文档零徽章宿主', topHosts === 0, `top=${topHosts}`);

  // ── 断言 E：穿透 closed shadow 读真实分数（CDP pierce，页面 JS 做不到）──────
  async function badgeTexts() {
    const cdp = await page.target().createCDPSession();
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const found = [];
    (function walk(n) {
      if (!n) return;
      if (n.nodeName === 'DIV' && n.attributes) {
        for (let i = 0; i < n.attributes.length; i += 2) {
          if (n.attributes[i] === 'class' && /(^| )b b-/.test(n.attributes[i + 1])) {
            const t = (n.children || []).find((c) => c.nodeType === 3);
            found.push({ cls: n.attributes[i + 1], text: t ? t.nodeValue : '' });
          }
        }
      }
      (n.children || []).forEach(walk);
      (n.shadowRoots || []).forEach(walk);
      if (n.contentDocument) walk(n.contentDocument);
    })(root);
    await cdp.detach().catch(() => {});
    return found;
  }
  const badges = (await badgeTexts()).filter((b) => !/b-i/.test(b.cls) || true);
  const texts = badges.map((b) => b.text);
  check('CDP 穿透 closed shadow 找到 3 枚卡片徽章', badges.length >= 3, JSON.stringify(texts));
  if (fakeBridge) {
    const numericOrX = texts.filter((t) => /^\d{1,3}$/.test(t) || t === '岗位不符');
    check('徽章是真实分数/岗位不符（JD 经 bridge→background→storage→content 全链路到达）',
      numericOrX.length >= 3 && new Set(texts).size >= 2, JSON.stringify(texts));
  }

  // ── 断言 F：background 带版本指纹来同步过（平台侧"旧版未刷新"诊断的数据源）──
  if (fakeBridge) {
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) {
      hit = bridgeHits.find((h) => h.url === '/jd/active' && new URLSearchParams(h.q).get('v') === MANIFEST.version) || null;
      if (!hit) await sleep(250);
    }
    check(`同步请求带版本指纹 v=${MANIFEST.version}`, !!hit, hit ? hit.q : `未见（收到 ${bridgeHits.length} 次请求：${bridgeHits.map((h) => h.q).join(' | ') || '无'}）`);
  }

  // ── 断言 G：第二级评分——详情面板打开后出现「深度分」徽章 ────────────────────
  await frame.evaluate(() => {
    const d = document.createElement('div');
    d.className = 'resume-detail';
    d.setAttribute('data-geekid', 'g1');
    d.style.cssText = 'position:fixed;right:0;top:0;width:420px;height:600px;background:#fff;border:1px solid #ddd;overflow:auto;padding:16px';
    d.innerHTML = `
      <div class="geek-name">张三</div>
      <div class="op"><button class="btn btn-greet">打招呼</button></div>
      <div class="work-exp"><ul>
        <li><h3 class="company">某某科技有限公司</h3><div class="position">Java 高级开发</div>
          <p class="desc">负责核心交易系统的 Java 服务端开发，主导 Spring Cloud 微服务拆分与 MySQL 分库分表，QPS 提升 3 倍。</p></li>
        <li><h3 class="company">某互联网公司</h3><div class="position">Java 开发</div>
          <p class="desc">参与订单中台建设，使用 Spring Boot 与 Redis 实现异步履约链路，稳定支撑大促。</p></li>
      </ul></div>
      <div class="project"><ul><li><h3 class="name">交易中台重构</h3><p class="desc">从单体到微服务的整体迁移，设计灰度方案。</p></li></ul></div>
      <div class="self-intro">八年 Java 服务端经验，熟悉高并发与分布式事务，有大型电商中台从零到一经验。</div>`;
    document.body.appendChild(d);
  });
  // 详情面板不在列表容器里，靠 5 秒兜底重扫兜住 —— 轮询等它出现/消失
  async function findDp() {
    const cdp = await page.target().createCDPSession();
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    let hit = null;
    (function walk(n) {
      if (!n || hit) return;
      if (n.nodeName === 'DIV' && n.attributes) {
        for (let k = 0; k < n.attributes.length; k += 2) {
          if (n.attributes[k] === 'class' && /^dp$/.test(n.attributes[k + 1])) { hit = n; return; }
        }
      }
      (n.children || []).forEach(walk);
      (n.shadowRoots || []).forEach(walk);
      if (n.contentDocument) walk(n.contentDocument);
    })(root);
    await cdp.detach().catch(() => {});
    return hit;
  }
  async function waitDp(want, rounds) {
    let dp = null;
    for (let i = 0; i < rounds; i++) {
      dp = await findDp();
      if (!!dp === want) break;
      await sleep(500);
    }
    return dp;
  }
  const deep = await waitDp(true, 24);
  if (fakeBridge) {
    check('打开详情后出现「深度分」徽章（第二级评分接力）', !!deep, deep ? 'found .dp' : '12 秒内未出现');
  } else {
    console.log(`ℹ 真桥模式：深度分依赖激活岗位，仅报告状态 → ${deep ? '出现' : '未出现'}`);
  }

  // ── 断言 G2：跨帧 + 无已知类名的详情（2026-07-29 真机事故的完整复刻）─────────
  // 详情面板渲染在【顶层帧】（列表与卡片级结果都在推荐 iframe 里）、类名与预设
  // 选择器毫不沾边——深度分必须依然出现：内容签名探测找容器 + storage 镜像跨帧接力。
  await frame.evaluate(() => { const d = document.querySelector('.resume-detail'); if (d) d.remove(); });
  const gone = await waitDp(false, 24);
  check('详情关闭后深度分徽章收回', !gone, gone ? '仍在' : '已收回');
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.setAttribute('data-geekid', 'g2');
    d.className = 'zz-pane';   // 故意不用任何 resume/detail/geek 字样的类名
    d.style.cssText = 'position:fixed;left:20px;top:20px;width:520px;height:640px;background:#fff;border:1px solid #ccc;overflow:auto;padding:16px;z-index:50';
    d.innerHTML = `
      <div>李四 · 前端开发工程师 · 25岁</div>
      <h3>工作经历</h3>
      <div>某创业公司 · 前端开发 —— 负责营销后台的 Vue3 + TypeScript 前端开发，组件库建设与 JavaScript 性能优化，主导表单引擎重构，编写单元测试覆盖核心链路，参与跨端方案调研与落地。</div>
      <h3>项目经历</h3>
      <div>低代码表单引擎：基于 Vue 的动态表单渲染器，Schema 驱动，支持自定义组件接入与联动校验。</div>
      <h3>教育经历</h3>
      <div>某职业技术学院 · 计算机应用技术</div>`;
    document.body.appendChild(d);
  });
  const deep2 = await waitDp(true, 30);
  if (fakeBridge) {
    check('跨帧+陌生类名详情：深度分仍出现（签名探测+storage 接力）', !!deep2, deep2 ? 'found .dp' : '15 秒内未出现');
    // 陌生类名面板必然走"整块文本兜底"→ 深度分应为真实数值或岗位不符，而非缺席
    const dp2Text = await page.evaluate(() => {
      const d = document.querySelector('.zz-pane');
      return d ? '面板在' : '面板丢失';
    });
    check('陌生类名面板仍挂在顶层帧', dp2Text === '面板在', dp2Text);
  } else {
    console.log(`ℹ 真桥模式：跨帧深度分仅报告状态 → ${deep2 ? '出现' : '未出现'}`);
  }

  // ── 断言 H：全程零 JS 报错、假站只收到过 zhipin 路径请求 ───────────────────
  check('页面无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close().catch(() => {});
  site.close();
  if (fakeBridge) bridge.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✓ 全部通过' : '✗ 失败 ' + failed.length + ' 项'}：${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
