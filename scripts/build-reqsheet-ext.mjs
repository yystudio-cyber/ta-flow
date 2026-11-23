/**
 * 构建「飞书需求 → 表格汇总」浏览器扩展的单文件 content script。
 *
 * 源码结构：
 *   extension/feishu-req-sheet-sync/src/content.js  —— 主逻辑（含 __REQ_EXTRACT_INLINE__ 占位）
 *   tools/_shared/req-extract.js                    —— 提取引擎（单一真源）
 *
 * 产物：extension/feishu-req-sheet-sync/content.bundle.js
 *
 * 用法：
 *   npm run reqsheet-ext:build         构建
 *   npm run reqsheet-ext:check         只校验产物是否与源同步
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension', 'feishu-req-sheet-sync');
const SRC = path.join(EXT_DIR, 'src', 'content.js');
const EXTRACT_SRC = path.join(ROOT, 'tools', '_shared', 'req-extract.js');
const OUT_FILE = path.join(EXT_DIR, 'content.bundle.js');
const MANIFEST = path.join(EXT_DIR, 'manifest.json');

const CHECK_ONLY = process.argv.includes('--check');
const read = (p) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
const fail = (msg) => { console.error('✗ [build-reqsheet-ext] ' + msg); process.exit(1); };

for (const p of [SRC, EXTRACT_SRC, MANIFEST]) {
  if (!fs.existsSync(p)) fail('源缺失：' + path.relative(ROOT, p));
}

const contentSrc = read(SRC);
const extractSrc = read(EXTRACT_SRC);
const version = JSON.parse(read(MANIFEST)).version;

// 源必须是自包含 IIFE
if (!/^\(function\s*\(\s*\)\s*\{/m.test(contentSrc.trimStart())) {
  fail('src/content.js 开头形态变了（不再是 IIFE），请同步更新本构建脚本');
}
// 源必须包含占位符
if (!contentSrc.includes('// __REQ_EXTRACT_INLINE__')) {
  fail('src/content.js 缺少 // __REQ_EXTRACT_INLINE__ 占位，无法内联提取引擎');
}

// 将提取引擎 inline（去掉 CommonJS module.exports 尾部）
const extractBody = extractSrc
  .replace(/\/\/ 导出[\s\S]*?module\.exports[\s\S]*?;?\s*$/, '')
  .trim();

const inlinedContent = contentSrc.replace(
  '  // __REQ_EXTRACT_INLINE__',
  '  // ——— req-extract.js (inlined, single source of truth) ———\n' + extractBody + '\n  // ——— end req-extract ———'
);

const banner = `/**
 * 飞书需求 → 表格汇总  v${version} — 扩展打包版
 *
 * ⚠ 本文件由 scripts/build-reqsheet-ext.mjs 自动生成，不要手改。
 *   改源：extension/feishu-req-sheet-sync/src/content.js（主逻辑）
 *         tools/_shared/req-extract.js（提取引擎，单一真源）
 *   重建：npm run reqsheet-ext:build
 *
 * 行为边界：
 *   · 只读飞书招聘，绝不提交/修改任何内容
 *   · 只与 127.0.0.1:17386 通信（本地桥）
 *   · 不存储任何 PII
 */
`;

const bundle = banner + inlinedContent + '\n';

// 校验 / 写盘
const prev = fs.existsSync(OUT_FILE) ? read(OUT_FILE) : null;
if (CHECK_ONLY) {
  if (prev === null) fail('产物不存在，请先跑 npm run reqsheet-ext:build');
  if (prev !== bundle) {
    fail('产物与源不同步 —— 改了源码没重建。跑：npm run reqsheet-ext:build');
  }
  console.log(`✓ [build-reqsheet-ext] 产物与源同步（v${version}，${bundle.length} 字节）`);
  process.exit(0);
}

fs.mkdirSync(EXT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, bundle, 'utf-8');
console.log(`✓ [build-reqsheet-ext] 已生成 ${path.relative(ROOT, OUT_FILE)}（v${version}，${bundle.length} 字节）`);
