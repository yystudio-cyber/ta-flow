/**
 * A1 验证：POST /structure/sample 的 Origin 强制校验。
 *
 * 做法：用 esbuild 打真 src/main/services/jd-bridge.ts（db/constants 换成最小桩），
 * 拿到真实的 startJdBridge / stopJdBridge / EXTENSION_ID 与常量，对真 server 发 7 种请求
 * 验证 Origin 校验行为。**不再复刻判断逻辑**——之前复刻版的问题是源码改了测试不跟。
 *
 * 注意：若 127.0.0.1:17385 已被其它进程占用（通常是正在运行的 Electron 平台实例），
 * 真 server 起不来，本脚本会跳过 HTTP 层测试并把跳过原因打清楚（不伪造绿结果）。
 *
 * 用法：node scripts/a1-origin-test.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'url';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 与 jd-bridge-lab 相同的桩 ──────────────────────────────────────────
const DB_STUB = `
export function getDb() { return { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }) }; }
export function getSetting(_k, d) { return d; }
`;
const CONSTANTS_STUB = `
export const DEFAULT_SETTINGS = { matchScore: { defaultWeights: null, highThreshold: 75, lowThreshold: 60 } };
`;
const TYPES_STUB = '// types only';

const stubPlugin = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /\/db$/ }, () => ({ path: 'db', namespace: 'stub' }));
    b.onResolve({ filter: /\/constants$/ }, () => ({ path: 'constants', namespace: 'stub' }));
    b.onResolve({ filter: /\/types$/ }, () => ({ path: 'types', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: a.path === 'db' ? DB_STUB : a.path === 'constants' ? CONSTANTS_STUB : TYPES_STUB,
      loader: 'ts',
    }));
  },
};

const outFile = path.join(os.tmpdir(), `ta-a1-origin-test-${Date.now()}.mjs`);
await build({
  stdin: {
    contents: `
      export { startJdBridge, stopJdBridge, JD_BRIDGE_PORT, EXTENSION_ID } from '${path.join(ROOT, 'src/main/services/jd-bridge.ts').replace(/\\/g, '/')}';
    `,
    resolveDir: ROOT, loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: outFile, plugins: [stubPlugin], logLevel: 'error',
});
const M = await import(pathToFileURL(outFile).href);

// ── 1. 静态层：直接从源码字符串读，确认关键行没被回退 ──────────────────
let pass = 0; const fails = []; const skipped = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function skip(name, reason) { skipped.push({ name, reason }); console.log('⊘ ' + name + '  → SKIPPED: ' + reason); }

console.log('\n── 静态源码验证（无需启动 server）──\n');
const src = fs.readFileSync(path.join(ROOT, 'src/main/services/jd-bridge.ts'), 'utf-8');
const idx = src.indexOf("url === '/structure/sample'");
ok(idx > 0, "POST /structure/sample 路由存在");
const block = src.slice(idx, idx + 1500);
ok(
  block.includes("origin !== ALLOWED_ORIGIN") &&
  !block.match(/origin\s*&&\s*origin\s*!==\s*ALLOWED_ORIGIN/),
  "强制校验 origin !== ALLOWED_ORIGIN（无 'origin &&' 宽松前缀）"
);
ok(/if\s*\(req\.method\s*!==\s*'POST'\)/.test(block), "非 POST 方法 → 405");
ok(/MAX_SAMPLE_FILES\s*=\s*200/.test(src), "MAX_SAMPLE_FILES = 200");
ok(/MAX_SAMPLE_DIR_MB\s*=\s*50/.test(src), "MAX_SAMPLE_DIR_MB = 50");
ok(/function\s+purgeSampleDir/.test(src) && src.includes('purgeSampleDir('),
  "purgeSampleDir 存在且在写盘后被调用");

// ── 2. 行为层（需要真 server 起来，端口空闲时跑）─────────────────────
function portFree(port) {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(() => resolve(true)); });
    s.listen(port, '127.0.0.1');
  });
}
function request(port, { method, path: p, origin, headers }) {
  return new Promise((resolve) => {
    const opts = {
      hostname: '127.0.0.1', port, path: p, method,
      headers: { Host: `127.0.0.1:${port}`, ...(headers || {}) },
    };
    if (origin !== undefined) opts.headers.Origin = origin;
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: -1, error: e.message }));
    const payload = JSON.stringify({ url: 'http://test.example/', candidateCards: [] });
    if (method === 'POST') req.end(payload);
    else req.end();
  });
}

console.log('\n── 行为层（真 server 端到端）──\n');
const port = M.JD_BRIDGE_PORT;
const ALLOWED = `chrome-extension://${M.EXTENSION_ID}`;

const free = await portFree(port);
let serverUp = false;
if (!free) {
  skip('7 条 HTTP 断言', `端口 127.0.0.1:${port} 被占用（可能是 Electron 平台在跑），无法启动真 jd-bridge server。请关掉平台实例后重跑本脚本验证。`);
} else {
  try {
    M.startJdBridge({ diagnosticsDir: path.join(os.tmpdir(), 'ta-a1-test-' + Date.now()) });
    serverUp = true;
    // 等 200ms server 起来
    await new Promise((r) => setTimeout(r, 200));

    const cases = [
      { name: '无 Origin 头 POST /structure/sample → 403（A1 核心）', opts: { method: 'POST', path: '/structure/sample', origin: undefined }, expect: 403 },
      { name: '空 Origin 字符串 POST → 403', opts: { method: 'POST', path: '/structure/sample', origin: '' }, expect: 403 },
      { name: '正确 chrome-extension Origin → 200（扩展采样链路通）', opts: { method: 'POST', path: '/structure/sample', origin: ALLOWED, headers: { 'Content-Type': 'application/json' } }, expect: 200 },
      { name: '错误扩展 ID → 403', opts: { method: 'POST', path: '/structure/sample', origin: 'chrome-extension://deadbeefdeadbeef' }, expect: 403 },
      { name: '网页 Origin（https://example.com）→ 403', opts: { method: 'POST', path: '/structure/sample', origin: 'https://example.com' }, expect: 403 },
      { name: 'GET /structure/sample → 405', opts: { method: 'GET', path: '/structure/sample', origin: ALLOWED }, expect: 405 },
      { name: 'curl 默认（无 Origin 无 Content-Type，短 payload）→ 403', opts: { method: 'POST', path: '/structure/sample', origin: undefined, headers: {} }, expect: 403 },
    ];
    for (const c of cases) {
      const res = await request(port, c.opts);
      ok(res.status === c.expect, c.name, `实际 ${res.status}${res.error ? ' (ERR: ' + res.error + ')' : ''}`);
    }
  } catch (e) {
    fails.push('启动真 jd-bridge server 失败：' + e.message);
    console.log('✗ 启动真 jd-bridge server 失败：' + e.message);
  } finally {
    if (serverUp) {
      try { M.stopJdBridge(); } catch { /* ignore */ }
    }
  }
}

try { fs.unlinkSync(outFile); } catch { /* ignore */ }

console.log('\n── 汇总 ──');
console.log(`通过 ${pass} / 失败 ${fails.length} / 跳过 ${skipped.length}`);
if (skipped.length) {
  console.log('\n跳过项：');
  for (const s of skipped) console.log('  · ' + s.name + ' — ' + s.reason);
}
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log(skipped.length ? '\n⚠ HTTP 层被跳过（端口占用），静态层已验证 A1 规则——请在关掉 Electron 平台后重跑以拿到端到端证据。' : '\n✓ 全部通过');
process.exit(0);
