#!/usr/bin/env node
/**
 * 猎聘真机首搜 + 校准（用【真实 applySearch】跑，不是另写一套）。
 *
 * 这一步会真的点搜索按钮 —— 消耗 1 次搜索配额（不消耗任何"看简历"额度）。
 * 跑完立刻用同一份 adapter 的 selfTest 校准列表选择器。
 *
 * 用法：node scripts/run-electron-node.mjs scripts/search-liepin.mjs "<关键词>" [--dry] [port]
 *   --dry  只做输入框定位预检，不点搜索（零配额消耗）
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const KEYWORD = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || '';
const PORT = Number(argv.find((a) => /^\d+$/.test(a))) || 9333;

if (!KEYWORD) { console.error('用法：search-liepin.mjs "<关键词>" [--dry] [port]'); process.exit(2); }

// ── 打包真实实现 ───────────────────────────────────────────────
const outFile = path.join(ROOT, 'scripts', '.probe-bundle.cjs');
require('esbuild').buildSync({
  entryPoints: [path.join(ROOT, 'scripts/_probe-entry.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: outFile,
  external: ['better-sqlite3', 'electron', 'puppeteer-core'],
  logLevel: 'warning',
});
const { liepinAdapter, DEFAULT_LIEPIN, HumanOperator, resolveBehaviorProfile } = require(outFile);

const puppeteer = require('puppeteer-core');
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` }).catch((e) => {
  console.error(`连不上 127.0.0.1:${PORT}：${e.message}`); process.exit(1);
});
const pages = await browser.pages();
const page = pages.find((p) => /lpt\.liepin\.com\/search/i.test(p.url()));
if (!page) { console.error('未找到 lpt.liepin.com/search 标签页'); await browser.disconnect(); process.exit(1); }

// ── 预检：确认关键词框到底是哪个（打错框会搜出完全无关的人）──────
// ★ 直接读 adapter 的真实配置 —— 脚本里绝不再抄一份选择器（抄了就会像刚才那样
//   改了代码、预检却还在报旧结果，把人引向错误结论）。
const KW_SEL = DEFAULT_LIEPIN.kwInput;
const preflight = await page.evaluate((sel) => {
  const out = [];
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = el.getBoundingClientRect();
    out.push({
      id: el.id || '(无)',
      placeholder: el.getAttribute('placeholder') || '(无)',
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
      visible: r.width > 0 && r.height > 0,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
      // 往上找最近的带文字的标签，判断这个框到底属于哪个筛选项
      near: (() => {
        let n = el.parentElement, hops = 0;
        while (n && hops++ < 6) {
          const t = (n.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
          if (t) return t;
          n = n.parentElement;
        }
        return '(无)';
      })(),
    });
  }
  return out;
}, KW_SEL);

console.log('\n【关键词输入框预检】');
preflight.forEach((p, i) => {
  console.log(`  #${i}  id=${p.id}  placeholder=${p.placeholder}  可见=${p.visible}  位置(${p.x},${p.y}) 宽${p.w}`);
  console.log(`      上下文: ${p.near}`);
  console.log(`      class : ${p.cls}`);
});
const first = preflight[0];
if (!first) { console.error('\n❌ 关键词输入框一个都没匹配到，无法搜索。'); await browser.disconnect(); process.exit(1); }
console.log(`\n  → applySearch 会用 #0（${first.id} / ${first.placeholder}），上下文「${first.near}」`);

if (DRY) {
  console.log('\n--dry：仅预检，未点击搜索，零配额消耗。\n');
  await browser.disconnect();
  try { fs.rmSync(outFile, { force: true }); } catch {}
  process.exit(0);
}

// ── 真实 applySearch（human 档拟人节奏）─────────────────────────
// ★ 2026-08-20 P2：唯一 human 档（旧 safe 经 normalizeSpeedMode 归 human）。
const profile = resolveBehaviorProfile('liepin', { mode: 'human', dailyGreetLimit: 0, dailyBrowseLimit: 0 });
const op = new HumanOperator(page, profile);
const query = { label: KEYWORD, keyword: KEYWORD, strict: false };

console.log(`\n【执行真实 applySearch】关键词「${KEYWORD}」（human 档拟人节奏，会消耗 1 次搜索配额）`);
const t0 = Date.now();
const res = await liepinAdapter.applySearch(page, op, query);
console.log(`  结果: ${res}   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 给列表一点渲染时间（≥3s，让平台安全 JS 自然跑完）
await new Promise((r) => setTimeout(r, 3500));

// ── 用同一份 adapter 校准 ──────────────────────────────────────
const r = await liepinAdapter.selfTest(page);
console.log(`\n【状态】 ${r.ok ? '✅ 具备开跑条件' : '⚠️ 尚不具备开跑条件'}`);
console.log(`  工作面:${r.onWorkSurface ? '是' : '否'}  风控页:${r.riskPage ? r.riskKind : '否'}  频率提示:${r.rateWarning ? '有' : '无'}${r.quotaStop ? '  配额:' + r.quotaStop : ''}`);
if (r.health?.length) console.log(`  会话软信号: ${r.health.join('、')}`);

console.log('\n【选择器命中】');
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
for (const s of r.selectors) {
  console.log(`  ${pad(s.count > 0 ? '✓' : (s.critical ? '✗关键' : '·'), 6)} ${pad(s.name, 26)} ${String(s.count).padStart(5)}`);
}
console.log(`\n【解析结果】候选人 ${r.cards.parsed} / DOM ${r.cards.domCount} · 稳定锚 ${r.cards.withSourceId} · 姓名 ${r.cards.withName}`);
for (const c of r.cards.samples) {
  console.log(`  ${pad(c.name, 8)} ${pad(c.company + ' / ' + c.position, 42)} 锚:${pad(c.sourceIdPreview, 20)} ${c.years} ${c.degree} ${c.city} 全文${c.textLen}字`);
}
console.log('\n【结论】');
for (const v of r.verdict) console.log(`  ${v}`);
console.log('');

await browser.disconnect();
try { fs.rmSync(outFile, { force: true }); } catch {}
process.exit(r.ok ? 0 : 2);
