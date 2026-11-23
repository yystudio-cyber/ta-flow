#!/usr/bin/env node
/**
 * 打包产物断言 —— 防「代码在源码里、却没进产物」这类只在打包版复现的故障回归。
 *
 * 真实事故（2026-07-27 第二轮审查发现）：
 *   platform-adapter 用懒加载 `require('./adapters/boss')` 绕开循环依赖，
 *   rollup 打包主进程时把动态 require 当外部依赖丢弃 → 产物里一行 adapter 代码都没有，
 *   启动即 "Cannot find module"，BOSS 与猎聘同时废掉。
 *   开发态 (vite dev) 完全不复现 —— 只有打包版才炸。typecheck / 隔离断言也都查不到。
 *   => 必须有一条直接检查【产物内容】的断言。
 *
 * 用法：npx vite build && node scripts/check-bundle.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures++; console.error(`  ✗ ${m}`); };

function mustExist(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { bad(`产物缺失：${rel}（先跑 npx vite build）`); return null; }
  return fs.readFileSync(p, 'utf8');
}

console.log('\n[B1] 主进程产物包含各平台 adapter 实现');
{
  const main = mustExist('dist-electron/main/index.js');
  if (main) {
    // 每个平台挑几个"只可能出现在该 adapter 里"的特征串
    const marks = {
      'BOSS 推荐流解析': ['card-item', 'encryptGeekId'],
      'BOSS 网络规则': ['zpApm', 'wapi'],
      '猎聘列表选择器': ['resumeCardWrap', 'nest-resume-personal-name'],
      '猎聘详情深链': ['showresumedetail', 'resIdEncode'],
      '猎聘 WAF 信号': ['acw_sc__v3', 'acw_sc__v2'],
      '猎聘安全 JS 探针': ['__lp_cf'],
      '猎聘配额文案': ['猎聘币不足'],
    };
    for (const [name, keys] of Object.entries(marks)) {
      const missing = keys.filter((k) => !main.includes(k));
      if (missing.length) bad(`${name}：产物中缺少 ${missing.join(' / ')}`);
      else ok(`${name}`);
    }
    // 反向断言：产物里不该残留对 adapters 的运行时动态 require（那就是没被打进来的信号）
    if (/require\(\s*['"][^'"]*adapters\/(boss|liepin)['"]\s*\)/.test(main)) {
      bad('产物里仍有对 adapters 的动态 require —— 说明它们没被静态打包进来');
    } else {
      ok('无残留的 adapters 动态 require');
    }
  }
}

console.log('\n[B2] preload 产物包含平台化 API');
{
  const pre = mustExist('dist-electron/preload/index.js');
  if (pre) {
    for (const k of ['platform:list', 'candidates:open-source', 'rpa:start']) {
      if (pre.includes(k)) ok(`通道 ${k}`);
      else bad(`preload 产物缺少通道 ${k}`);
    }
  }
}

console.log('\n[B3] 渲染层产物包含双平台 UI');
{
  const dir = path.join(ROOT, 'dist/assets');
  if (!fs.existsSync(dir)) {
    bad('dist/assets 缺失（先跑 npx vite build）');
  } else {
    const all = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    for (const [name, key] of [['平台常量', 'liepin'], ['猎聘展示名', '猎聘'], ['配额进度条', '看简历']]) {
      if (all.includes(key)) ok(name);
      else bad(`渲染产物缺少 ${name}（${key}）`);
    }
    // 加强：确保进度条用的不是硬编码假数字（pagesLimit||50 searchesLimit||100 detailsLimit||30）
    // 产物中不应残留旧版 || N 兜底模式
    const fakePatterns = [/\bpagesLimit\s*\|\|\s*50\b/, /\bsearchesLimit\s*\|\|\s*100\b/, /\bdetailsLimit\s*\|\|\s*30\b/];
    for (const p of fakePatterns) {
      if (p.test(all)) { bad(`渲染产物残留假配额兜底值: ${String(p)}`); }
    }
    if (!fakePatterns.some((p) => p.test(all))) ok('配额进度条无硬编码假兜底值');
    // 确保真实字段引用存在（pagesToday / pagesLimit / searchesToday / searchesLimit / detailsToday / detailsLimit）
    const realFields = ['pagesToday', 'searchesToday', 'detailsToday', 'pagesLimit', 'searchesLimit', 'detailsLimit'];
    for (const f of realFields) {
      if (all.includes(f)) ok(`配额字段 ${f}`);
      else bad(`渲染产物缺少配额字段引用: ${f}`);
    }
  }
}

console.log('');
if (failures) { console.error(`❌ 产物断言未通过：${failures} 项\n`); process.exit(1); }
console.log('✅ 打包产物断言全绿\n');
