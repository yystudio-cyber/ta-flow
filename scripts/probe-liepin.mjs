#!/usr/bin/env node
/**
 * 猎聘真机只读探针（命令行版）—— 0-1 校准用。
 *
 * 与 App 里那个「探测」按钮跑的是【同一份 adapter 代码】：
 * 用 esbuild 把 adapters/liepin.ts 现打成一个临时 CJS 包，再直接调它的 selfTest。
 * 好处是校准结果 1:1 迁移到引擎，且改完选择器立刻能重跑，不用重新打包整个 App。
 *
 * 严格只读：不点击、不导航、不滚动、不写库、不打开任何简历详情 —— 不消耗任何套餐额度。
 *
 * 用法：node scripts/run-electron-node.mjs scripts/probe-liepin.mjs [port]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 9333;

// ── 1. 现打 adapter 包 ─────────────────────────────────────────
const outFile = path.join(ROOT, 'scripts', '.probe-adapter.cjs');
{
  const esbuild = require('esbuild');
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/main/services/adapters/liepin.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: outFile,
    // 原生模块与运行时由宿主提供；db 只被用于读 settings（未初始化时自动回落默认值）
    external: ['better-sqlite3', 'electron', 'puppeteer-core'],
    logLevel: 'warning',
  });
}
const { liepinAdapter } = require(outFile);

// ── 2. 连上已登录的猎聘浏览器（只连，不开新页、不导航）──────────
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` })
  .catch(async (e) => {
    console.error(`\n❌ 连不上 127.0.0.1:${PORT}：${e.message}`);
    console.error('   请确认猎聘浏览器已打开（端口 9333）。\n');
    process.exit(1);
  });

const pages = await browser.pages();
const own = pages.filter((p) => /(^|\.)liepin\.com$/i.test(safeHost(p.url())));
function safeHost(u) { try { return new URL(u).hostname; } catch { return ''; } }

console.log('\n猎聘浏览器标签页：');
for (const p of pages) console.log(`  · ${p.url().slice(0, 110)}`);

if (!own.length) {
  console.error('\n❌ 没有找到猎聘的标签页。请在该浏览器里打开 lpt.liepin.com/search 后重跑。\n');
  await browser.disconnect();
  process.exit(1);
}
// 优先取已停在搜索页的那个
const target = own.find((p) => /lpt\.liepin\.com\/search/i.test(p.url())) || own[0];

// ── 3. 跑 selfTest ─────────────────────────────────────────────
console.log(`\n探测目标：${target.url()}\n${'─'.repeat(78)}`);
let r;
try {
  r = await liepinAdapter.selfTest(target);
} catch (e) {
  console.error(`\n❌ 探针异常：${e && e.message}\n${e && e.stack}\n`);
  await browser.disconnect();
  process.exit(1);
}

// ── 4. 输出报告 ────────────────────────────────────────────────
console.log(`\n【状态】 ${r.ok ? '✅ 具备开跑条件' : '⚠️ 尚不具备开跑条件'}`);
console.log(`  工作面: ${r.onWorkSurface ? '是（已在搜索页）' : '否'}   风控页: ${r.riskPage ? `是（${r.riskKind}）` : '否'}   频率提示: ${r.rateWarning ? '有' : '无'}`);
if (r.quotaStop) console.log(`  配额提示: ${r.quotaStop}`);
if (r.health?.length) console.log(`  会话健康软信号: ${r.health.join('、')}`);

console.log(`\n【选择器命中】`);
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
for (const s of r.selectors) {
  const flag = s.count > 0 ? '✓' : (s.critical ? '✗关键' : '·');
  console.log(`  ${pad(flag, 6)} ${pad(s.name, 26)} ${String(s.count).padStart(5)}   ${s.selector.slice(0, 62)}`);
}

console.log(`\n【解析结果】 候选人 ${r.cards.parsed} / DOM 卡片 ${r.cards.domCount} · 稳定锚 ${r.cards.withSourceId} · 姓名 ${r.cards.withName}`);
for (const c of r.cards.samples) {
  console.log(`  ${pad(c.name, 8)} ${pad(c.company + ' / ' + c.position, 40)} 锚:${pad(c.sourceIdPreview, 22)} ${c.years} ${c.degree} ${c.city} 全文${c.textLen}字`);
}

console.log(`\n【结论】`);
for (const v of r.verdict) console.log(`  ${v}`);
console.log('');

await browser.disconnect();
try { fs.rmSync(outFile, { force: true }); } catch { /* 清理失败忽略 */ }
process.exit(r.ok ? 0 : 2);
