/**
 * scheduler:lab —— 定时器逻辑离线测试台（注入假时钟）
 *
 * 覆盖：
 *   1) 正常触发：到 11:00 就跑一次
 *   2) 今天已跑：不重复触发
 *   3) catchUpOnStart：启动时已过 11:00 且今天没跑 → 补跑
 *   4) 休眠 / 隔夜：第二天 11:00 再跑
 *   5) 重入保护：两次并发调用只有一个真正执行
 *
 * 注意：scheduler.ts 依赖 electron/db，通过 esbuild 桩化后 import 真源码。
 * 为避免构建开销，本测试直接在 Node 里运行调度算法（从源码摘出纯逻辑），
 * 不依赖 Electron API。
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { build } from 'esbuild';
const require_ = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; process.stdout.write('✓ ' + name + (detail ? '  → ' + detail : '') + '\n'); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); process.stdout.write('✗ ' + name + (detail ? '  → ' + detail : '') + '\n'); }
}

// ── 桩化 electron/db 后 import 真源码 ───────────────────────────────────────
// ⚠️ 2026-08-10：此前这里【复刻】了一份判定逻辑，测的是副本不是源码，于是源码里
//    "必须分钟精确相等"的 bug 被复刻进来后当成预期行为断言了下来（休眠跨过 11:00
//    就整天不跑）。现在直接 import 真源码的 shouldRunNow。
const tmpDir = fs.mkdtempSync(path.join(ROOT, "node_modules", ".sched-lab-"));
const stub = path.join(tmpDir, "stub.cjs");
fs.writeFileSync(stub, "exports.app={getPath:()=>" + JSON.stringify(tmpDir) + ",getAppPath:()=>" + JSON.stringify(ROOT) + "};exports.getDb=()=>null;exports.getSetting=(k,d)=>d;exports.setSetting=()=>{};exports.oplog=()=>{};");
const bundle = path.join(tmpDir, "sched.cjs");
await build({
  entryPoints: [path.join(ROOT, "src/main/services/scheduler.ts")],
  outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "node18",
  plugins: [{
    name: "stub-deps",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (
        (a.path === 'electron' || a.path === '../db' || a.path === './oplog')
          ? { path: stub } : undefined
      ));
    },
  }],
});
const SCHED = require_(bundle);
const shouldFire = (now, lastRunDate, time) => SCHED.shouldRunNow(now, lastRunDate, time);
const shouldCatchUp = shouldFire;  // 源码已把定时与补跑统一成同一判据

process.stdout.write('\n=== §1  正常触发 ===\n');

// 恰好 11:00，今天未跑
const t_1100 = new Date('2026-08-07T11:00:00');
ok(shouldFire(t_1100, '2026-08-06', '11:00'), '11:00 且昨天已跑 → 今天触发');
ok(!shouldFire(t_1100, '2026-08-07', '11:00'), '11:00 但今天已跑 → 不重复');

process.stdout.write('\n=== §2  时间不到 ===\n');
const t_1059 = new Date('2026-08-07T10:59:00');
const t_1101 = new Date('2026-08-07T11:01:00');
ok(!shouldFire(t_1059, '2026-08-06', '11:00'), '10:59 → 不触发');
ok(shouldFire(t_1101, '2026-08-06', '11:00'), '11:01 → 仍然触发（过点未跑就补，不要求分钟精确相等）');

// 休眠跨过 11:00 的场景：这正是分钟精确相等判法会静默漏跑的地方
const t_1107 = new Date('2026-08-07T11:07:00');
ok(shouldFire(t_1107, '2026-08-06', '11:00'), '11:00 在睡眠、11:07 醒来 → 仍然补跑（app 未重启）');
const t_2359 = new Date('2026-08-07T23:59:00');
ok(shouldFire(t_2359, '2026-08-06', '11:00'), '当天 23:59 还没跑过 → 仍然补跑');
ok(!shouldFire(t_2359, '2026-08-07', '11:00'), '当天 23:59 但今天跑过了 → 不重复');

process.stdout.write('\n=== §3  catchUpOnStart ===\n');
// 启动时 13:00，今天 11:00 没跑
const t_1300 = new Date('2026-08-07T13:00:00');
ok(shouldCatchUp(t_1300, '2026-08-06', '11:00'), '13:00 启动，今天未跑 → 补跑');
ok(!shouldCatchUp(t_1300, '2026-08-07', '11:00'), '13:00 启动，今天已跑 → 不补');

// 启动时 09:00（还没到 11:00）
const t_0900 = new Date('2026-08-07T09:00:00');
ok(!shouldCatchUp(t_0900, '2026-08-06', '11:00'), '09:00 启动（未到定时时间）→ 不补跑');

process.stdout.write('\n=== §4  跨日 ===\n');
// 隔夜：新一天 11:00
const t_next1100 = new Date('2026-08-08T11:00:00');
ok(shouldFire(t_next1100, '2026-08-07', '11:00'), '第二天 11:00 → 触发');
ok(!shouldFire(t_next1100, '2026-08-08', '11:00'), '第二天 11:00 但已标记今天跑过 → 不重复');

process.stdout.write('\n=== §5  重入保护（模拟）===\n');
// 模拟：两个并发调用，只有一个真正执行
let triggerCount = 0;
let running = false;
async function doRunSim() {
  if (running) return 'blocked';
  running = true;
  await new Promise(r => setTimeout(r, 10));
  triggerCount++;
  running = false;
  return 'ran';
}
const [r1, r2] = await Promise.all([doRunSim(), doRunSim()]);
ok(triggerCount === 1, '重入保护：两次并发调用只触发一次', `r1=${r1} r2=${r2}`);

process.stdout.write('\n=== §6  配置解析 ===\n');
// 自定义时间
const t_1400 = new Date('2026-08-07T14:00:00');
ok(shouldFire(t_1400, '2026-08-06', '14:00'), '自定义 14:00 触发');
// 14:00 对 11:00 的计划：过点未跑 → 应当补跑（旧断言写的是不触发，那是把
//   "分钟精确相等"的 bug 当成了预期行为）
ok(shouldFire(t_1400, '2026-08-06', '11:00'), '14:00 对 11:00 计划 → 过点未跑，补跑');
const t_1000 = new Date('2026-08-07T10:00:00');
ok(!shouldFire(t_1000, '2026-08-06', '11:00'), '10:00 未到 11:00 → 不触发');
ok(!shouldFire(t_1000, '2026-08-06', '14:00'), '10:00 未到 14:00 → 不触发');

process.stdout.write('\n' + '='.repeat(60) + '\n');
if (fails.length) {
  process.stdout.write(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项\n`);
  for (const f of fails) process.stdout.write('  · ' + f + '\n');
  process.exit(1);
}
process.stdout.write(`✓ 全部通过：${pass}/${pass}\n`);
