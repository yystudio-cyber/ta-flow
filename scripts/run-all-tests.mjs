/**
 * 全跑型测试 runner。
 *
 * 每个套件都跑完，最后汇总。支持三种结果：
 *   ✓ PASS   — exit=0
 *   SKIP     — exit=0 且环境变量条件满足（无 Chrome、无锚点集等）
 *   KNOWN-RED — 已知的环境相关失败（端口被占、外部进程残留等），不阻断 CI
 *   ✗ FAIL   — 真正的代码问题，阻断 CI
 *
 * 硬闸 typecheck / build:smoke（2026-08-07 第三轮修复）：
 *   放在 SUITES 最前面，永远不进 KNOWN_RED 和 SKIP_EXIT_CODES，且有 contract:check
 *   静态断言锁死。加这两条的原因：上一轮 4 个悬空 import 导致编译不过，但 npm test 17
 *   个套件全显示"通过"——因为没有任何套件跑类型检查或构建冒烟。悬空 import 就是这么漏掉的。
 *   这两条硬闸保证"编译不过 = npm test 红"，不再需要"人想起来才跑一次 typecheck"。
 *
 * 合并说明（2026-08-14 阶段0）：以 req-sheet-desktop 版（含 typecheck/build:smoke 硬闸
 * + KNOWN_RED + SKIP_EXIT_CODES）为基，补入 liepin-v2 独有的 score:eval:v3（锚点缺失
 * 时 exit=2，与 score:eval 同语义，纳入 SKIP）与 score:fuzz 两个套件。两线套件全量保留。
 *
 * oplog:test 说明：
 *   oplog.ts 已从 feat/liepin-v2 移植（零 DB 依赖，纯 JSONL），oplog-lab.mjs 接回 SUITES。
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TA_ALLOW_SKIP = process.env.TA_ALLOW_SKIP || '';

// KNOWN-RED：已知环境相关失败，不阻断 CI，汇总末尾单独列出。
// 2026-08-07 第三轮修复收尾：KNOWN_RED 已清空。
//   · tools:test   — 此前误判为端口冲突，实际 8/8 全绿（lab 自带端口自愈），移除。
//   · adapter:test — describeSecReport 门控已加（接口不存在时跳过，合并 liepin-v2 自动激活），90/90 全绿，移除。
//   · feishu-ext:e2e — 此前误判为"双扩展互扰"。实测诊断：扩展在 Chrome 150 中根本不加载（0 次注入），
//     不是双扩展问题。改为基础设施不兼容时 exit=3 → SKIP_EXIT_CODES 承接。
const KNOWN_RED = new Set([]);

// SKIP_EXIT_CODES：这些套件以特定非零码退出时表示"环境条件不满足，跳过"而非真正失败
// score:eval exit=2 = 尚无锚点集（未采集，不是代码问题）
// score:eval:v3 exit=2 = 同上（score-eval-v3plus.mjs 在锚点缺失时同样 process.exit(2)）
// feishu-ext:e2e exit=3 = Chrome --load-extension 在当前版本不兼容（基础设施问题）
const SKIP_EXIT_CODES = new Map([
  ['score:eval', 2],
  ['score:eval:v3', 2],
  ['feishu-ext:e2e', 3],
]);

const SUITES = [
  // ── 硬闸：编译不过 = npm test 红，永远不许赦免 ──
  { name: 'typecheck',          cmd: 'npx', args: ['vue-tsc', '--noEmit'] },
  { name: 'build:smoke',        cmd: 'npx', args: ['vite', 'build'] },
  // ── 契约 / 日志 ──
  { name: 'contract:check',     cmd: 'node', args: ['scripts/contract-check.mjs'] },
  { name: 'oplog:test',         cmd: 'node', args: ['scripts/oplog-lab.mjs'] },
  // buildSearchFromJd 纯函数映射（搜的岗位=评的岗位）：确定性断言，零运行时依赖
  { name: 'jd-search:lab',      cmd: 'node', args: ['scripts/jd-search-lab.mjs'] },
  // ── 功能套件 ──
  { name: 'jd-bridge:lab',      cmd: 'node', args: ['scripts/jd-bridge-lab.mjs'] },
  { name: 'risk:test',          cmd: 'node', args: ['scripts/risk-lab.mjs'] },
  { name: 'adapter:test',       cmd: 'node', args: ['scripts/adapter-lab.mjs'] },
  { name: 'tools:test',         cmd: 'node', args: ['scripts/tools-lab.mjs'] },
  { name: 'feishu:lab',         cmd: 'node', args: ['scripts/feishu-job-lab.mjs'] },
  { name: 'feishu-ext:check',   cmd: 'node', args: ['scripts/build-feishu-ext.mjs', '--check'] },
  { name: 'feishu-ext:e2e',     cmd: 'node', args: ['scripts/feishu-ext-e2e.mjs'] },
  { name: 'reqsheet:lab',       cmd: 'node', args: ['scripts/reqsheet-lab.mjs'] },
  { name: 'reqsheet-ext:check', cmd: 'node', args: ['scripts/build-reqsheet-ext.mjs', '--check'] },
  { name: 'scheduler:lab',      cmd: 'node', args: ['scripts/scheduler-lab.mjs'] },
  { name: 'reqsheet:e2e',       cmd: 'node', args: ['scripts/reqsheet-e2e-real.mjs'] },
  { name: 'score:check',        cmd: 'node', args: ['scripts/score-dist-check.mjs'] },
  { name: 'score:fuzz',         cmd: 'node', args: ['scripts/score-fuzz.mjs'] },
  { name: 'semantic:check',     cmd: 'node', args: ['scripts/semantic-lab.mjs'] },
  { name: 'score:eval',         cmd: 'node', args: ['scripts/score-eval.mjs'] },
  { name: 'score:eval:v3',      cmd: 'node', args: ['scripts/score-eval-v3plus.mjs'] },
  { name: 'ext:check',          cmd: 'node', args: ['scripts/build-ext.mjs', '--check'] },
  { name: 'ext:test',           cmd: 'node', args: ['scripts/test-ext.mjs'] },
];

// ══════════════════════════════════════════════════════════════════════════════
// 硬闸契约：typecheck 和 build:smoke 永远不许进 KNOWN_RED 或 SKIP_EXIT_CODES。
// 这是编译不过漏检事故（2026-08-07）的直接教训。这里用启动时断言锁死，
// 谁改了就会当场炸在 runner 启动阶段，而不是等跑完一套绿才发现"其实没编过"。
// ══════════════════════════════════════════════════════════════════════════════
{
  const HARD_GATES = ['typecheck', 'build:smoke'];
  const suiteNames = new Set(SUITES.map(s => s.name));
  for (const g of HARD_GATES) {
    if (!suiteNames.has(g)) {
      console.error(`✗ 硬闸契约违反：${g} 不在 SUITES 里！跑不了 typecheck/build 的 npm test 不可信。`);
      process.exit(1);
    }
    if (KNOWN_RED.has(g)) {
      console.error(`✗ 硬闸契约违反：${g} 被列入 KNOWN_RED！编译不过不能赦免。`);
      process.exit(1);
    }
    if (SKIP_EXIT_CODES.has(g)) {
      console.error(`✗ 硬闸契约违反：${g} 被列入 SKIP_EXIT_CODES！编译不过不能跳过。`);
      process.exit(1);
    }
  }
}

const results = [];
for (const suite of SUITES) {
  process.stdout.write(`\n${'='.repeat(60)}\n> ${suite.name}\n`);
  // Windows 上 npx 是 .cmd 脚本，需要 shell 才能被 spawnSync 启动
  const needsShell = process.platform === 'win32' && (suite.cmd === 'npx' || suite.cmd === 'npx.cmd');
  const r = spawnSync(suite.cmd, suite.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: needsShell,
    env: { ...process.env, TA_ALLOW_SKIP },
  });
  const code = r.status ?? 1;
  const isSkip = code === 0 || (SKIP_EXIT_CODES.get(suite.name) === code);
  const isKnownRed = !isSkip && KNOWN_RED.has(suite.name);
  results.push({ name: suite.name, code, skip: isSkip && code !== 0, knownRed: isKnownRed });
  const label = code === 0 ? '✓' : (isSkip ? 'SKIP' : isKnownRed ? 'KNOWN-RED' : '✗');
  process.stdout.write(`[${label}] ${suite.name} exit=${code}\n`);
}

console.log('\n' + '='.repeat(60));
console.log('结果汇总：');

const trueFailures = [];
const knownReds = [];
const skippedSuites = [];

for (const r of results) {
  if (r.code === 0) {
    console.log(`  ✓ ${r.name} (exit=0)`);
  } else if (r.skip) {
    console.log(`  SKIP ${r.name} (exit=${r.code}，环境条件不满足，不阻断)`);
    skippedSuites.push(r.name);
  } else if (r.knownRed) {
    console.log(`  KNOWN-RED ${r.name} (exit=${r.code}，环境相关，不阻断)`);
    knownReds.push(r.name);
  } else {
    console.log(`  ✗ ${r.name} (exit=${r.code})`);
    trueFailures.push(r.name);
  }
}

if (skippedSuites.length) {
  console.log(`\n⚪ SKIP（环境条件不满足，不计入失败）：${skippedSuites.join(', ')}`);
  if (skippedSuites.includes('score:eval') || skippedSuites.includes('score:eval:v3')) {
    console.log('  score:eval / score:eval:v3 exit=2 — 尚无锚点集（data/score-anchors/），采集后即自动参评');
    console.log('  如需在有锚点集的机器跳过，改设 TA_ALLOW_SKIP=1');
  }
}

if (knownReds.length) {
  console.log(`\n⚠ KNOWN-RED（环境问题，不阻断，需人工确认）：${knownReds.join(', ')}`);
}

if (trueFailures.length) {
  console.error(`\n✗ 真实失败（必须修）：${trueFailures.join(', ')}`);
  process.exit(1);
} else {
  const total = results.filter(r => !r.skip && !r.knownRed).length;
  const extras = [...skippedSuites.map(n => `SKIP:${n}`), ...knownReds.map(n => `KNOWN-RED:${n}`)].join(', ');
  console.log(`\n✓ ${total} 个正式套件通过${extras ? `，附注：${extras}` : ''}`);
}
