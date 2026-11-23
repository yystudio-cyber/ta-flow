/**
 * 真人行为基线采集器 —— 把「模拟真人」从拍脑袋的通用参数校准到【这个账号真实使用者】的操作特征。
 *
 * 全程只观察、不操作：注入 passive 监听器采集鼠标/滚轮/点击/键盘时间序列，
 * 不点任何东西、不发请求、不消耗搜索配额。对新账号还有"预热"价值（先有真人画像再上自动化）。
 *
 * 用法：node scripts/capture-human-baseline.mjs [端口=9333] [时长秒=600]
 *   在 9333 浏览器里登录猎聘、停在搜索页，然后运行本脚本，像平时一样真人 sourcing。
 *   到时长自动分析落盘；也可提前 Ctrl-C 结束。每 60 秒落一次中间结果，随时可读。
 * 输出：scripts/_baseline-<日期>.json（final）与 scripts/_baseline-partial.json（中间）
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 9333;
const DURATION = Number(process.argv[3]) || 0; // 秒；0 = 等 Ctrl-C

const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null, protocolTimeout: 20000 });
const page = (await b.pages()).find((p) => /lpt\.liepin\.com/.test(p.url())) || (await b.pages())[0];
if (!page) { console.error('✗ 没找到猎聘页面'); process.exit(1); }
console.log('已连上：', (await page.title()), '|', page.url().slice(0, 60));

const INJECT = () => {
  if (window.__hbInstalled) return;
  window.__hbInstalled = true; window.__hb = [];
  let lastMove = 0;
  const push = (e) => { try { window.__hb.push(e); } catch { /* ignore */ } };
  addEventListener('mousemove', (ev) => { const t = performance.now(); if (t - lastMove < 40) return; lastMove = t; push({ ty: 'm', t: Date.now(), x: ev.clientX, y: ev.clientY }); }, { passive: true, capture: true });
  addEventListener('wheel', (ev) => push({ ty: 'w', t: Date.now(), dy: ev.deltaY, x: ev.clientX, y: ev.clientY }), { passive: true, capture: true });
  addEventListener('mousedown', (ev) => push({ ty: 'd', t: Date.now(), x: ev.clientX, y: ev.clientY }), { passive: true, capture: true });
  addEventListener('click', (ev) => push({ ty: 'c', t: Date.now(), x: ev.clientX, y: ev.clientY }), { passive: true, capture: true });
  addEventListener('keydown', (ev) => push({ ty: 'k', t: Date.now() }), { passive: true, capture: true });
};
await page.evaluate(INJECT);

const events = [];
const pull = async () => {
  try {
    await page.evaluate(INJECT);
    const batch = await page.evaluate(() => { const a = window.__hb || []; window.__hb = []; return a; });
    if (batch && batch.length) events.push(...batch);
  } catch { /* 页面忙，下次再拉 */ }
};

function analyze(evs) {
  if (evs.length < 20) return null;
  const e = [...evs].sort((a, c) => a.t - c.t);
  const pctl = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, c) => a - c); return Math.round(s[Math.floor(s.length * p)]); };
  const mean = (arr) => arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : 0;
  const std = (arr) => { if (arr.length < 2) return 0; const m = arr.reduce((s, x) => s + x, 0) / arr.length; return Math.round(Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length)); };
  const moves = e.filter((x) => x.ty === 'm');
  const speeds = [];
  for (let i = 1; i < moves.length; i++) { const dt = moves[i].t - moves[i - 1].t; if (dt <= 0 || dt > 500) continue; speeds.push(Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y) / dt); }
  const stills = [];
  for (let i = 1; i < moves.length; i++) { const g = moves[i].t - moves[i - 1].t; if (g > 400 && g < 60000) stills.push(g); }
  const wheels = e.filter((x) => x.ty === 'w');
  const wheelMag = wheels.map((w) => Math.abs(w.dy));
  const scrollGaps = []; let lastW = 0;
  for (const w of wheels) { if (lastW && w.t - lastW > 800) scrollGaps.push(w.t - lastW); lastW = w.t; }
  const upScrolls = wheels.filter((w) => w.dy < 0).length;
  const clicks = e.filter((x) => x.ty === 'c');
  const clickGaps = [];
  for (let i = 1; i < clicks.length; i++) clickGaps.push(clicks[i].t - clicks[i - 1].t);
  const idleGaps = [];
  for (let i = 1; i < moves.length; i++) { const g = moves[i].t - moves[i - 1].t; if (g > 3000) idleGaps.push(g); }
  return {
    采集时长分钟: Number(((e[e.length - 1].t - e[0].t) / 60000).toFixed(1)),
    事件总数: e.length,
    鼠标速度_px每ms: { p50: pctl(speeds, 0.5), p90: pctl(speeds, 0.9), 均值: mean(speeds) },
    停留_静止段ms: { p50: pctl(stills, 0.5), p90: pctl(stills, 0.9), 均值: mean(stills), 标准差: std(stills), 段数: stills.length },
    滚动: { 次数: wheels.length, 单次幅度px: { p50: pctl(wheelMag, 0.5), p90: pctl(wheelMag, 0.9), 均值: mean(wheelMag) }, 阵间间隔ms: { p50: pctl(scrollGaps, 0.5), 均值: mean(scrollGaps) }, 向上滚占比: wheels.length ? Number((upScrolls / wheels.length).toFixed(2)) : 0 },
    点击: { 次数: clicks.length, 间隔ms: { p50: pctl(clickGaps, 0.5), 均值: mean(clickGaps), 标准差: std(clickGaps) } },
    长空档_走神ms: { 次数: idleGaps.length, p50: pctl(idleGaps, 0.5), 最长: idleGaps.length ? Math.max(...idleGaps) : 0 },
    按键次数: e.filter((x) => x.ty === 'k').length,
  };
}

const stamp = new Date().toISOString().slice(0, 10);
const partialFile = path.join(ROOT, 'scripts/_baseline-partial.json');
const finalFile = path.join(ROOT, `scripts/_baseline-${stamp}.json`);

const ticker = setInterval(async () => {
  await pull();
  const r = analyze(events);
  if (r) { try { fs.writeFileSync(partialFile, JSON.stringify({ report: r }, null, 2)); } catch { /* ignore */ } }
  process.stdout.write(`  …已采 ${events.length} 个事件（中间结果已落盘）\r`);
}, 60000);

let done = false;
async function finish() {
  if (done) return; done = true;
  clearInterval(ticker);
  await pull();
  await b.disconnect().catch(() => {});
  const r = analyze(events);
  if (!r || events.length < 50) { console.log(`\n✗ 只采到 ${events.length} 个事件，太少不足以校准，请重采并多操作一会儿。`); process.exit(1); }
  fs.writeFileSync(finalFile, JSON.stringify({ report: r }, null, 2), 'utf8');
  console.log('\n\n═══ 真人行为基线 ═══');
  console.log(JSON.stringify(r, null, 1));
  console.log('\n已写入:', finalFile);
  process.exit(0);
}

console.log('\n🎬 开始采集。请像平时一样真人操作猎聘：搜索 → 逐个看候选人 → 翻页 → 滚动。');
if (DURATION > 0) { console.log(`   将采集 ${Math.round(DURATION / 60)} 分钟后自动分析（也可提前 Ctrl-C）。\n`); setTimeout(finish, DURATION * 1000); }
else console.log('   操作完按 Ctrl-C 结束。\n');
process.on('SIGINT', finish);
