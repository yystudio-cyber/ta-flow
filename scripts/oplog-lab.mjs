/**
 * 运行日志测试台 —— 验的只有一件事：**日志绝不影响功能**。
 *
 * 为什么值得单独一个测试台：日志是横切所有功能的东西，一旦它在某种边界情况下抛异常，
 * 会把它包住的那个功能一起带死。而这类故障在正常路径上测不出来 ——
 * 必须主动把日志层弄坏，再看业务是否照常返回。
 *
 * 用法：node scripts/oplog-lab.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpUser = path.join(os.tmpdir(), 'ta-oplog-lab-' + process.pid);

// electron 桩：app.getPath 指向临时目录
const ELECTRON_STUB = `
export const app = {
  getPath: () => ${JSON.stringify(tmpUser)},
  getVersion: () => '0.0.0-test',
};
`;

const outFile = path.join(os.tmpdir(), 'ta-oplog-lab.mjs');
await build({
  stdin: {
    contents: `export * from '${path.join(ROOT, 'src/main/services/oplog.ts').replace(/\\/g, '/')}';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: outFile, logLevel: 'error',
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' }));
    },
  }],
});
const O = await import(pathToFileURL(outFile).href);

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}

console.log('\n=== 一、正常写入与读取 ===');
O.startSession({ test: true });
O.oplog('ipc', 'demo:channel', { argc: 2 }, { ok: true, ms: 12 });
O.oplog('rpa', 'transition', { from: 'idle', to: 'running' }, { platform: 'liepin' });
O.oplog('risk', 'wafChallenge', { detail: 'acw_sc__v2' }, { ok: false, platform: 'liepin' });
O.flush();
const recent = O.recentEntries(50);
ok(recent.length >= 3, '写进去的能读出来', `${recent.length} 条`);
ok(recent.some((e) => e.n === 'wafChallenge' && e.ok === false), '失败事件被如实标记为失败');
ok(recent.some((e) => e.p === 'liepin'), '平台字段落下来了');

console.log('\n=== 二、绝不抛异常（业务安全的底线）===');
// 这些调用形态都是"业务代码可能不小心传进来"的东西，一个都不许抛
const nasty = [
  () => O.oplog(null, null),
  () => O.oplog('a', 'b', { circular: (() => { const o = {}; o.self = o; return o; })() }),
  () => O.oplog('a', 'b', { fn: () => {}, sym: Symbol('x'), big: 10n }),
  () => O.oplog('x'.repeat(9999), 'y'.repeat(9999), { k: 'v'.repeat(99999) }),
  () => O.oplog('a', 'b', undefined, { ok: 'not-a-bool', ms: NaN }),
  () => O.oplogTimed('a', 'b')(true),
  () => O.recentEntries(-1),
  () => O.summarize(-5),
];
let threw = null;
for (const f of nasty) {
  try { f(); } catch (e) { threw = e; break; }
}
ok(!threw, '各种畸形入参都不抛异常', threw ? String(threw.message) : '8 种形态全部安全');

console.log('\n=== 三、PII 不入日志（合规底线）===');
O.oplog('rpa', 'candidate', {
  name: '张三', phone: '13800138000', email: 'a@b.com', 姓名: '李四',
  resume: '一大段简历全文', detailText: '简历详情', cardText: '卡片文本',
  score: 82, resId: 'abc123',
});
O.flush();
const line = JSON.stringify(O.recentEntries(20));
ok(!line.includes('张三') && !line.includes('13800138000') && !line.includes('a@b.com'),
  '姓名/手机/邮箱不会被写进日志');
ok(!line.includes('简历全文') && !line.includes('简历详情'), '简历文本不会被写进日志');
ok(line.includes('82'), '非敏感字段（分数）照常保留 —— 诊断需要它');

console.log('\n=== 四、缓冲上限：日志绝不吃爆内存 ===');
// F1(2026-08-05)：原断言 recentEntries(2000).length <= 2000 是同义反复——函数内部
//   out.length < limit 天然保证返回条数 ≤ limit，等于什么都没测。改成验真东西：
//   连写 5000 条（超过 MAX_BUFFER=2000）→ flush → 文件里出现 buffer-overflow 记录且 dropped>0，
//   这才证明"缓冲满了会丢最旧的并如实记账"。
for (let i = 0; i < 5000; i++) O.oplog('bulk', 'n' + i, { i });
// 先拿到落盘前文件路径
const beforeFiles = fs.existsSync(O.getOplogDir()) ? fs.readdirSync(O.getOplogDir()) : [];
O.flush();
// 从磁盘读文件，找 buffer-overflow 记录
const afterFiles = fs.readdirSync(O.getOplogDir()).filter((f) => f.endsWith('.jsonl') && !beforeFiles.includes(f) || f.startsWith('oplog-'));
let overflowRecord = null;
for (const f of afterFiles) {
  const full = path.join(O.getOplogDir(), f);
  if (!fs.existsSync(full)) continue;
  const content = fs.readFileSync(full, 'utf8');
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.a === 'oplog' && e.n === 'buffer-overflow' && e.d && e.d.dropped > 0) {
        overflowRecord = e; break;
      }
    } catch { /* 半行忽略 */ }
  }
  if (overflowRecord) break;
}
ok(!!overflowRecord, '缓冲满后会写入 buffer-overflow 记录（如实记账）',
  overflowRecord ? `dropped=${overflowRecord.d.dropped}` : '未找到 buffer-overflow 条目');
ok(overflowRecord && overflowRecord.d.dropped >= 2900, '丢弃数量合理（5000 写 - 2000 缓冲 ≈ 3000）',
  overflowRecord ? `dropped=${overflowRecord.d.dropped}` : '');
const afterBulk = O.recentEntries(10);
ok(afterBulk.length > 0, '溢出之后仍能正常读写');

console.log('\n=== 五、汇总统计能指出问题在哪 ===');
const sum = O.summarize(1);
const risky = sum.find((s) => s.action === 'wafChallenge');
ok(!!risky && risky.fail >= 1, '失败事件被计入 fail 列', risky ? `fail=${risky.fail}` : '未找到');
ok(sum.length > 0 && sum[0].fail >= (sum[sum.length - 1].fail || 0), '失败多的排在前面（一眼看出哪坏了）');

// F2(2026-08-05)：原「六、目录不可写」一节已删除——它写了 badDir 同名文件又在测试前 rmSync 删掉，
//   实际根本没测到"目录不可写"场景，等于名字说测了、实际没测，比没有更糟。
//   真正的跨平台不可写模拟（chmod 000 在 Windows 上无效、文件占坑法需另起进程隔离 logDir 来源）
//   复杂度较高，不适合在这个 smoke lab 里做；与其留假断言，不如诚实承认未覆盖。
//   已有 getOplogHealth() 返回 enabled:false 覆盖"日志停用"场景，生产故障时
//   会在运行日志页顶部明确显示「❌ 未在记录」——由 UI 层承担显式责任。

console.log('\n=== 六、导出诊断包 ===');
const ex = O.exportBundle(7);
ok(ex.ok && ex.file && fs.existsSync(ex.file), '能导出成一个文件', ex.file || ex.reason);

O.shutdown();
try { fs.rmSync(tmpUser, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.unlinkSync(outFile); } catch { /* ignore */ }

console.log('');
if (fails.length) { console.error(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`); fails.forEach((f) => console.error('  · ' + f)); process.exit(1); }
console.log(`✓ 全部通过：${pass}/${pass}\n`);
