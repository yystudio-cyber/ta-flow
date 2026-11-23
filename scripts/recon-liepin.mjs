#!/usr/bin/env node
/**
 * 猎聘页面 DOM 侦察（只读，零成本）。
 *
 * 用途：探针报「选择器命中 0」时，区分两种完全不同的原因 ——
 *   (a) 页面根本还没有搜索结果  → 不需要改任何代码，先搜一次即可
 *   (b) 平台改版、类名变了      → 需要按真实类名校准选择器
 * 顺带把「真实类名长什么样」直接打出来，省掉人工 F12 翻 DOM
 *（正式跑 RPA 时禁止开 F12，猎聘会检测 DevTools）。
 *
 * 严格只读：不点击、不导航、不输入、不写库。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = Number(process.argv[2]) || 9333;
void path; void fileURLToPath;

const puppeteer = require('puppeteer-core');
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` }).catch((e) => {
  console.error(`连不上 127.0.0.1:${PORT}：${e.message}`);
  process.exit(1);
});
const pages = await browser.pages();
const host = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const target = pages.find((p) => /lpt\.liepin\.com\/search/i.test(p.url()))
  || pages.find((p) => /liepin\.com$/i.test(host(p.url())));
if (!target) { console.error('未找到猎聘标签页'); await browser.disconnect(); process.exit(1); }

const info = await target.evaluate(() => {
  const body = document.body;
  const text = (body?.innerText || '').replace(/\n{2,}/g, '\n').trim();

  // 类名频次（只看出现 ≥2 次的，卡片类必然重复出现）
  const freq = new Map();
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const cls = typeof el.className === 'string' ? el.className : '';
    for (const c of cls.split(/\s+/)) {
      if (!c || c.length < 3) continue;
      freq.set(c, (freq.get(c) || 0) + 1);
    }
  }
  const repeated = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60);

  // 疑似"候选人条目"的类名（业务语义关键词）
  const kw = /resume|cv|candidate|talent|person|card|item|list|row|user|profile|nest/i;
  const suspects = [...freq.entries()]
    .filter(([c, n]) => kw.test(c) && n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  // data-* 属性名（稳定锚通常藏在这里）
  const dataAttrs = new Map();
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes || [])) {
      if (a.name.startsWith('data-')) dataAttrs.set(a.name, (dataAttrs.get(a.name) || 0) + 1);
    }
  }
  const datas = [...dataAttrs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);

  // 页面上所有含 resIdEncode 的链接（详情深链的直接证据）
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => a.getAttribute('href') || '')
    .filter((h) => /resIdEncode|cvview|showresumedetail/i.test(h))
    .slice(0, 5);

  // 骨架屏/加载态
  const skeleton = Array.from(document.querySelectorAll('[class*="skeleton"],[class*="loading"],[class*="Skeleton"],[class*="Loading"]'))
    .map((e) => (typeof e.className === 'string' ? e.className : '')).slice(0, 8);

  // 分页器候选
  const pagers = Array.from(document.querySelectorAll('[class*="pagination"],[class*="Pagination"],[class*="pager"]'))
    .map((e) => (typeof e.className === 'string' ? e.className : '')).slice(0, 10);

  return {
    url: location.href,
    title: document.title,
    textHead: text.slice(0, 600),
    textLen: text.length,
    repeated, suspects, datas, links, skeleton, pagers,
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || '(无src)').slice(0, 6),
    lpcf: typeof window.__lp_cf !== 'undefined',
  };
});

const L = (t) => console.log(t);
L(`\nURL   : ${info.url}`);
L(`标题  : ${info.title}`);
L(`__lp_cf(安全JS) : ${info.lpcf ? '已加载' : '未加载'}`);
if (info.iframes.length) L(`iframe: ${info.iframes.join(' | ')}`);

L(`\n【页面正文头部（${info.textLen} 字）】`);
L(info.textHead.split('\n').slice(0, 22).map((s) => '  ' + s).join('\n'));

L('\n【疑似候选人条目的类名（含业务语义 + 重复出现）】');
if (!info.suspects.length) L('  （无）');
for (const [c, n] of info.suspects) L(`  ${String(n).padStart(4)} × ${c}`);

L('\n【data-* 属性（稳定锚常藏于此）】');
if (!info.datas.length) L('  （无）');
for (const [c, n] of info.datas) L(`  ${String(n).padStart(4)} × ${c}`);

L('\n【含 resIdEncode / cvview 的链接】');
if (!info.links.length) L('  （无）');
for (const h of info.links) L(`  ${h.slice(0, 130)}`);

L('\n【分页器候选】');
if (!info.pagers.length) L('  （无）');
for (const c of info.pagers) L(`  ${c.slice(0, 110)}`);

L('\n【骨架屏/加载态元素】');
if (!info.skeleton.length) L('  （无）');
for (const c of info.skeleton) L(`  ${c.slice(0, 110)}`);

L('\n【重复出现的类名 Top（用于人工比对）】');
for (const [c, n] of info.repeated.slice(0, 30)) L(`  ${String(n).padStart(4)} × ${c}`);
L('');

await browser.disconnect();
