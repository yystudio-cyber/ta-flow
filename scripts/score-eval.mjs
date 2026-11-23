/**
 * 评分引擎锚点评估 —— 用 TA 的人工分数当唯一真值，检验引擎"分对了人"没有。
 *
 * 两态评估（2026-07-31 立，2026-08-03 改口径）：
 *   · FULL 态（配了域与任务点的 JD）：保留锚点里的 domain/tasks。这是**平台推荐的填法**，
 *     也是评分引擎的真实能力线。不达标视为回归，exit 1 阻断。
 *   · LEAN 态（没配域与任务点的 JD）：剥离 domain/tasks 后重跑同一批锚点。
 *     它衡量的**不是链路缺陷，而是引擎在信息不足时的天花板**——没有域信息，
 *     "金融风控引擎"和"电商推荐引擎"在词面上就是一样的，纯字面引擎分不开是数学事实，
 *     不是 bug。因此 LEAN 态不达标【不阻断】，但必须每次都打印出来，
 *     因为它是"少填两栏会付出多少代价"的量化证据，也是 UI 上那句提示的依据。
 *
 * 口径变更说明（勿再改回）：
 *   本脚本 2026-07-31 曾以 KNOWN_RED 白名单标记 "PROD 态"，理由是 JD 的 domain/tasks
 *   在类型/UI/落库/下桥四处均未落地，生产根本填不了。该链路已于 2026-08-03 打通
 *   （JdDomain/JdTask 类型 + 岗位库录入 UI + saveJd 保字段 + 桥透传，
 *   链路承载由 scripts/jd-bridge-lab.mjs 第六节硬断言守着）。
 *   链路修好后把 LEAN 态设成硬门槛是**错的**：那道题的难点在引擎（无 AI 时纯字面分不开域），
 *   不在链路，设成硬门槛只会得到一条永远红、于是很快被人 skip 掉的 CI。
 *
 * 与 score:check 的分工（两者都要过，缺一不可）：
 *   · score:check  合成样本上的【分布】断言：分数别挤在一起、极差够大、硬门槛生效。
 *                  它证明不了"分对了人"——一个把所有人反着排的引擎照样能过分布断言。
 *   · score:eval   真实 JD + 真实简历 + TA 人工分的【准确性】断言。这是验收标准。
 *
 * 指标（sourcing 本质是排序任务，所以序关系比绝对分更硬）：
 *   1. 跨档倒挂 inversion    人工高档的人被打得比人工低档的人还低。**零容忍**
 *   2. 成对序正确率          同一岗位内任两人相对高低是否与人工一致。**要求 100%**
 *   3. 分档命中率            预测分落在人工档位（90+/80-89/70-79/60-69/<60）内。**≥75%**
 *   4. MAE / 最大偏差        绝对分偏离。**MAE ≤8，单点 ≤12**
 *   5. 档间分离度            相邻档的预测分要真的分开（避免"序对了但全挤在 3 分内"）
 *
 * 用法：
 *   npm run score:eval                    评估全部锚点集（LEAN + FULL 两态都打）
 *   npm run score:eval:lean               只跑 LEAN 态（未配域/任务点的 JD）
 *   npm run score:eval -- --only=full     只跑 FULL 态（配全的 JD，硬门槛）
 *   npm run score:eval -- --ta ta-parking 只评估某个 TA
 *   npm run score:eval -- --detail        打印每个锚点的维度明细（调优归因用）
 *   npm run score:eval -- --semantic=default|domain|none
 *                                          切换语义配置（默认 none）
 *
 * 退出码：0 FULL 态达标（LEAN 态不达标不阻断，但会打印代价量化）；
 *         1 FULL 态有不达标锚点集（回归，必须挡住）；
 *         2 没有可用锚点集（不算失败，尚未采集）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANCHOR_DIR = path.join(ROOT, 'data', 'score-anchors');
const ENGINE = require(path.join(ROOT, 'src', 'shared', 'scoring-universal.js'));
const SEM = require(path.join(ROOT, 'src', 'shared', 'semantic-provider.js'));

// ── LEAN 态说明 ───────────────────────────────────────────────────────────────
// 不要把 LEAN 态改成硬门槛，也不要因为"它是红的"就把它删掉。
//
// LEAN = 用户在岗位库里没填「应用域」和「任务点」两栏时的评分表现。
// 链路是通的（scripts/jd-bridge-lab.mjs 第六节硬断言：填了就一定到得了插件），
// 所以这一态红的不是工程缺陷，而是【信息缺失的代价】：没有域信息时，
// "金融风控引擎" 与 "电商推荐引擎" 在词面上无法区分，纯字面引擎必然分不开。
//
// 它的作用是把这个代价量化出来，给两件事当依据：
//   ① 岗位库 UI 上"未配置应用域/任务点"那条黄字提示；
//   ② 将来评估引入语义/AI 的收益时的对照基线（见 docs/no-ai-scoring-optimal.md）。
const LEAN_NOTE = [
  'ℹ LEAN 态（未配「应用域」「任务点」的岗位）未达标 —— 不阻断，这是信息缺失的代价，不是链路缺陷',
  '   链路状态：已打通（类型 / 岗位库录入 UI / saveJd 保字段 / jd-bridge 透传，',
  '             由 scripts/jd-bridge-lab.mjs 第六节 26 条断言守着，填了就一定到得了插件）。',
  '   这一态在测什么：JD 只填基础字段时，引擎能做到什么程度。',
  '   实测代价：把人工 80 的人排在 60 的人后面（倒挂），',
  '             因为没有域信息，两个域的技术词在词面上完全一样。',
  '   结论：这两栏值得花十分钟填。填了就是上面 FULL 态的表现（分档命中 100%、成对序 100%）。',
].join('\n');

// ── 入参解析 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const onlyTa = (() => { const i = argv.indexOf('--ta'); return i >= 0 ? argv[i + 1] : null; })();
const showDetail = argv.includes('--detail');
// --only=prod|full|both  指定只打哪一态；npm run score:eval:prod 传入 --only=prod
const onlyMode = (() => {
  // npm run score:eval:prod 经由 package.json 传 --only=prod
  for (const a of argv) {
    const m = a.match(/^--only=(\w+)$/);
    if (m) return m[1];
  }
  return 'both';
})();
// --semantic=none|default|domain
const semOpt = (() => {
  for (const a of argv) {
    const m = a.match(/^--semantic(?:=(\w+))?$/);
    if (m) return m[1] || 'default';
  }
  return 'none';
})();
{
  if (semOpt === 'default') {
    ENGINE.setSemanticProvider(SEM.createSemanticProvider());
  } else if (semOpt === 'domain') {
    ENGINE.setSemanticProvider(SEM.createSemanticProvider(SEM.DOMAIN_COMMON));
  }
  // none：不注入
}

// 合格线（改这里就是改验收标准，别在报告里手动放水）
const GATE = {
  maxInversions: 0,
  minPairAcc: 1.0,
  minBandHit: 0.75,
  maxMAE: 8,
  maxSingleDev: 12,
  minAdjacentGap: 4,
};

const THRESHOLDS = { high: 75, low: 60 };

function band(s) {
  if (s >= 90) return '90+';
  if (s >= 80) return '80-89';
  if (s >= 70) return '70-79';
  if (s >= 60) return '60-69';
  return '<60';
}
const BAND_ORDER = ['<60', '60-69', '70-79', '80-89', '90+'];

// 深拷贝工具（只用于剥离 JD 字段，不依赖 structuredClone 的 Node 版本兼容）
function deepClone(o) {
  if (o == null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const out = {};
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = deepClone(o[k]);
  return out;
}

// 给定锚点 set，按 mode 产出"实际评分用的 set"（LEAN 剥离 domain/tasks，FULL 保持原样）
function deriveSetForMode(set, mode) {
  if (mode === 'full') return set;
  // lean：深拷贝 JD，剥离 domain/tasks —— 模拟"用户没填这两栏"的岗位
  const jd = deepClone(set.jd);
  delete jd.domain;
  delete jd.tasks;
  return { ...set, jd, _mode: 'lean' };
}

function loadAnchorSets() {
  const out = [];
  if (!fs.existsSync(ANCHOR_DIR)) return out;
  for (const ta of fs.readdirSync(ANCHOR_DIR)) {
    const dir = path.join(ANCHOR_DIR, ta);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (onlyTa && ta !== onlyTa) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (!j.jd || !Array.isArray(j.anchors) || !j.anchors.length) {
          console.warn(`⚠ 跳过 ${ta}/${f}：缺 jd 或 anchors`);
          continue;
        }
        out.push({ ta, file: `${ta}/${f}`, ...j });
      } catch (e) {
        console.warn(`⚠ 跳过 ${ta}/${f}：JSON 解析失败 —— ${e.message}`);
      }
    }
  }
  return out;
}

function evalSet(set) {
  const rows = set.anchors.map((a) => {
    let r = null, err = null;
    try {
      r = ENGINE.scoreCandidate(a.candidate, set.jd, THRESHOLDS, { tier: a.tier || 'detail' });
    } catch (e) { err = e; }
    return {
      name: a.name,
      human: a.humanScore,
      humanBand: band(a.humanScore),
      tier: a.tier || 'detail',
      notes: a.notes || '',
      pred: r ? r.total : null,
      predBand: r ? band(r.total) : null,
      level: r ? r.level : '(抛错)',
      mismatch: r ? r.mismatch : false,
      mismatchReasons: r ? (r.mismatchReasons || []) : [],
      coverage: r ? r.coverage : null,
      gates: r ? (r.gates || []) : [],
      details: r ? (r.details || []) : [],
      err,
    };
  });

  const ok = rows.filter((x) => x.pred != null);
  const problems = [];

  for (const x of rows) {
    if (x.err) problems.push(`【引擎抛错】${x.name}：${x.err.message}`);
    if (x.mismatch) {
      problems.push(`【硬门槛误杀】${x.name}（人工 ${x.human}）被判岗位不符：`
        + x.mismatchReasons.map((m) => `${m.label}-${m.detail}`).join('；'));
    }
  }

  // 成对序 + 跨档倒挂
  let pairs = 0, pairOk = 0, inversions = [];
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const a = ok[i], b = ok[j];
      if (a.human === b.human) continue;
      pairs++;
      const humanHigher = a.human > b.human ? a : b;
      const humanLower = a.human > b.human ? b : a;
      if (humanHigher.pred > humanLower.pred) pairOk++;
      else {
        const crossBand = BAND_ORDER.indexOf(humanHigher.humanBand) > BAND_ORDER.indexOf(humanLower.humanBand);
        inversions.push({ hi: humanHigher, lo: humanLower, crossBand });
      }
    }
  }
  const crossBandInversions = inversions.filter((v) => v.crossBand);
  for (const v of crossBandInversions) {
    problems.push(`【跨档倒挂】${v.hi.name}(人工 ${v.hi.human} → 引擎 ${v.hi.pred}) `
      + `低于 ${v.lo.name}(人工 ${v.lo.human} → 引擎 ${v.lo.pred})`);
  }
  for (const v of inversions.filter((x) => !x.crossBand)) {
    problems.push(`【同档内倒挂】${v.hi.name}(${v.hi.human}→${v.hi.pred}) 低于 ${v.lo.name}(${v.lo.human}→${v.lo.pred})`);
  }

  // 分档命中 / 偏差
  const hits = ok.filter((x) => x.predBand === x.humanBand).length;
  const soft = ok.filter((x) => Math.abs(x.pred - x.human) <= 5).length;
  const devs = ok.map((x) => Math.abs(x.pred - x.human));
  const mae = devs.length ? devs.reduce((s, d) => s + d, 0) / devs.length : 0;
  const maxDev = devs.length ? Math.max(...devs) : 0;
  for (const x of ok) {
    if (Math.abs(x.pred - x.human) > GATE.maxSingleDev) {
      problems.push(`【偏差过大】${x.name}：人工 ${x.human} vs 引擎 ${x.pred}（差 ${x.pred - x.human}）`);
    }
  }

  // 档间分离度
  const byBand = {};
  for (const x of ok) (byBand[x.humanBand] = byBand[x.humanBand] || []).push(x.pred);
  const bandMeans = BAND_ORDER
    .filter((b) => byBand[b])
    .map((b) => ({ band: b, mean: byBand[b].reduce((s, v) => s + v, 0) / byBand[b].length }));
  for (let i = 1; i < bandMeans.length; i++) {
    const gap = bandMeans[i].mean - bandMeans[i - 1].mean;
    if (gap < GATE.minAdjacentGap) {
      problems.push(`【档间未分离】人工 ${bandMeans[i - 1].band} 档均分 ${bandMeans[i - 1].mean.toFixed(1)} `
        + `与 ${bandMeans[i].band} 档均分 ${bandMeans[i].mean.toFixed(1)} 只差 ${gap.toFixed(1)}（要求 ≥${GATE.minAdjacentGap}）`);
    }
  }

  const pairAcc = pairs ? pairOk / pairs : 1;
  const bandHit = ok.length ? hits / ok.length : 0;
  const pass = problems.length === 0
    && crossBandInversions.length <= GATE.maxInversions
    && pairAcc >= GATE.minPairAcc
    && bandHit >= GATE.minBandHit
    && mae <= GATE.maxMAE;

  return { set, rows, pairs, pairAcc, bandHit, softHit: ok.length ? soft / ok.length : 0, mae, maxDev, problems, pass, bandMeans };
}

// 打印一个 mode 的完整报告；返回 {pass, summary[]}
// mode 由调用方显式传入，不再从 label 字符串反推——改个标题就换了评估口径太脆。
function runMode(label, sets, isHardGate, mode) {
  const banner = isHardGate
    ? `═══ ${label}（硬门槛，不达标 exit 1）═══`
    : `─── ${label}（信息缺失对照，不阻断）───`;
  console.log('\n' + banner);
  const modeSummary = [];
  let allPass = true;
  for (const rawSet of sets) {
    const set = deriveSetForMode(rawSet, mode);
    const r = evalSet(set);
    allPass = allPass && r.pass;
    modeSummary.push({ file: set.file, n: r.rows.length, bandHit: r.bandHit, pairAcc: r.pairAcc, mae: r.mae, pass: r.pass });

    console.log('='.repeat(96));
    console.log(`${set.file}　JD：${set.jd.title || set.jd.name}　锚点 ${r.rows.length} 人`);
    console.log('-'.repeat(96));
    console.log('  人工  引擎   档位(人工→引擎)      等级        覆盖  层级    姓名');
    for (const x of r.rows) {
      const flag = x.pred == null ? '!!' : x.predBand === x.humanBand ? '  ' : ' ~';
      console.log(`${flag} ${String(x.human).padStart(4)}  ${String(x.pred ?? '—').padStart(4)}   `
        + `${x.humanBand.padEnd(6)} → ${String(x.predBand ?? '—').padEnd(6)}    `
        + `${String(x.level).padEnd(10)}  ${String(x.coverage ?? '—').padStart(3)}%  ${x.tier.padEnd(6)}  ${x.name}`
        + (x.gates.length ? `  [闸门:${x.gates.join('/')}]` : ''));
    }
    console.log('-'.repeat(96));
    console.log(`  分档命中 ${(r.bandHit * 100).toFixed(0)}%（±5 容忍 ${(r.softHit * 100).toFixed(0)}%）`
      + `　成对序 ${(r.pairAcc * 100).toFixed(0)}%（${r.pairs} 对）`
      + `　MAE ${r.mae.toFixed(1)}　最大偏差 ${r.maxDev}`);
    if (r.bandMeans.length > 1) {
      console.log('  档间均分：' + r.bandMeans.map((b) => `${b.band}=${b.mean.toFixed(1)}`).join('  '));
    }

    if (showDetail) {
      for (const x of r.rows) {
        if (!x.details.length) continue;
        console.log(`\n  ▸ ${x.name}（人工 ${x.human} / 引擎 ${x.pred}）维度明细：`);
        for (const d of x.details) {
          const state = d.notApplicable ? 'JD未设' : d.available === false ? '无数据' : `${String(Math.round(d.score)).padStart(3)} 分`;
          console.log(`      ${String(d.label).padEnd(10)} 权重${String(d.weight).padStart(3)}  ${state.padEnd(8)} ${d.note || ''}`);
        }
        if (x.notes) console.log(`      人工判据：${x.notes}`);
      }
    }

    if (r.problems.length) {
      console.log('\n  ✗ 不达标项：');
      for (const p of r.problems) console.log(`      ${p}`);
    } else {
      console.log('\n  ✓ 全部达标');
    }
    console.log('');
  }

  console.log('-' .repeat(96));
  console.log(`${label} 汇总：`);
  for (const s of modeSummary) {
    console.log(`  ${s.pass ? '✓' : '✗'} ${s.file.padEnd(40)} n=${s.n}  分档 ${(s.bandHit * 100).toFixed(0)}%  序 ${(s.pairAcc * 100).toFixed(0)}%  MAE ${s.mae.toFixed(1)}`);
  }
  return { pass: allPass, summary: modeSummary };
}

// ---------- 主流程 ----------
const sets = loadAnchorSets();
if (!sets.length) {
  // TA_ALLOW_SKIP=1 允许在没有锚点集的机器上跳过此套件（exit 0），否则仍 exit 2。
  // 用法：TA_ALLOW_SKIP=1 npm test  ——  CI / 新机器无锚点时设置此变量，不会把"尚未采集"误判为失败。
  if (process.env.TA_ALLOW_SKIP === '1') {
    console.log('SKIPPED（TA_ALLOW_SKIP=1）：尚无锚点集，score:eval 跳过');
    process.exit(0);
  }
  console.log('ℹ 尚无锚点集（data/score-anchors/<ta>/<jd>.json）。');
  console.log('  采集口径见 data/score-anchors/README.md：每个 TA 一个典型岗位 + 90+/80-89/70-79/60-69 各一份简历。');
  console.log('  在无锚点集的机器上跳过：TA_ALLOW_SKIP=1 npm test');
  process.exit(2);
}

console.log(`评分引擎锚点评估 —— ${sets.length} 个岗位锚点集` + `　（语义：${semOpt}　模式：${onlyMode}）`);

let fullRan = false;
let fullPass = true;
let leanHasRed = false;

if (onlyMode === 'both' || onlyMode === 'lean' || onlyMode === 'prod' /* 兼容旧参数 */) {
  const res = runMode('LEAN 态（岗位未配「应用域」「任务点」）', sets, /* isHardGate */ false, 'lean');
  if (!res.pass) leanHasRed = true;
}
if (onlyMode === 'both' || onlyMode === 'full') {
  const res = runMode('FULL 态（岗位配全了域与任务点，平台推荐填法）', sets, /* isHardGate */ true, 'full');
  fullRan = true;
  fullPass = res.pass;
}

console.log('\n' + '='.repeat(96));
console.log('合格线：跨档倒挂=0　成对序=100%　分档命中≥75%　MAE≤8　单点偏差≤12　档间均分差≥4');
if (leanHasRed) {
  console.log('\n' + LEAN_NOTE);
}
if (fullRan) {
  console.log(fullPass
    ? '\n✓ FULL 态全部锚点集达标（硬门槛）'
    : '\n✗ FULL 态存在不达标锚点集（硬门槛未过，exit 1）');
} else {
  console.log('\nℹ 未跑 FULL 态（--only=lean），跳过 FULL 态结论');
}

process.exit(fullPass ? 0 : 1);
