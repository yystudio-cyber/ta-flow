/**
 * 评分引擎 v3+ 验收 —— 用 岗位＋简历 全量语料（第 1 条产物）做三档验收。
 *
 * 三档判据（优先级严格如下，不许为后面的指标牺牲前面的）：
 *   ① 硬门槛：正样本零误杀。全部正样本（进面各档 + 拒因标注「进面级」的）一个都不许 <60。
 *      不达标即失败。分两层报告：进面档（48 人）、进面级（10 人）——对应老验收的两套脚本口径。
 *   ② 主指标：负样本识别率。真负样本（拒因含「不通过|XX不匹配」）判 <60 的比例。
 *      当前基线 9%（5/56），目标 30%+。达不到不算失败，但要如实报告并说明卡在哪。
 *   ③ 软指标：排序方向。一面通过组均分 > 一面挂组均分。n 很小，只看方向。
 *      当前基线：两个岗位各自的 Δ 见报告。
 *
 * 防泄漏：
 *   · 样本集的「面试评价文本字段」绝对不能进评分输入（那是标签泄漏）。
 *   · 候选人构造贴近真实适配器：正文按段落切 workHistory（~380字/条），不整篇塞单段。
 *
 * 用法：node scripts/score-eval-v3plus.mjs --corpus <corpus.json>
 *   --corpus 默认 C://Users//you/AppData/Local/Temp/ta-corpus.json
 *   --job <岗位>   只看某岗位
 *   --ablate      消融模式（分别关掉负向词表 / 关掉新 domain）
 *   --neg-off     关掉负向词
 *   --domain-off  关掉 domain（用 LEAN 对比）
 *
 * 退出码：0 = 硬门槛通过（正样本零误杀）；1 = 有正样本 <60（失败）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = require(path.join(ROOT, 'src', 'shared', 'scoring-universal.js'));
const { buildCandidate } = await import('file:///' + path.join(ROOT, 'tools', 'candidate-builder.mjs').replace(/\\/g, '/'));
const { loadJdConfig } = await import('file:///' + path.join(ROOT, 'scripts', 'config-loader.mjs').replace(/\\/g, '/'));

const args = process.argv.slice(2);
// 产物在系统临时目录（build-corpus.mjs 的默认输出）。显式 --corpus 优先，否则自动探测。
const DEFAULT_CORPUS_CANDIDATES = [
  path.join(process.env.TEMP || os_tmpdir(), 'ta-corpus.json'),
  path.join(os_tmpdir(), 'ta-corpus.json'),
];
function os_tmpdir() {
  try { return require('node:os').tmpdir(); } catch { return '/tmp'; }
}
const corpusArg = (args.find((a) => a.startsWith('--corpus=')) || '').split('=')[1];
const corpusPath = corpusArg || DEFAULT_CORPUS_CANDIDATES.find((p) => fs.existsSync(p))
  || 'C://Users//you/AppData/Local/Temp/ta-corpus.json';
const onlyJob = (args.find((a) => a.startsWith('--job=')) || '').split('=')[1] || null;
const negOff = args.includes('--neg-off');
const domainOff = args.includes('--domain-off');

if (!fs.existsSync(corpusPath)) {
  console.log(`ℹ 未找到语料 ${corpusPath}。\n  请先运行 tools/build-corpus.mjs 生成（第 1 条产物），或用 --corpus 指定路径。`);
  process.exit(2);
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const records = corpus.records;

// 从 config/jd-config.json 读岗位库（用户的业务数据不进代码）
const { jobs: JDS } = loadJdConfig();
if (!JDS.length) {
  console.log('ℹ config/jd-config.json 里没有岗位。先配好自己的 JD 再来跑标定。');
  process.exit(2);
}
// 语料记录的岗位名 → 岗位 id。按 name / title 双向匹配，不再硬编码。
const JOB_ID = {};
for (const j of JDS) {
  for (const k of [j.name, j.title].filter(Boolean)) JOB_ID[k] = j.id;
}

function deepClone(o) {
  if (o == null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const out = {};
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = deepClone(o[k]);
  return out;
}

// 按配置形态打分一个候选人
function scoreOne(cand, jd, opts) {
  return ENGINE.scoreCandidate(cand, jd, { high: 75, low: 60 }, opts);
}

// 主流程：对每个岗位跑全部正/负样本
function evalJob(job, jdRaw, negOffFlag, domainOffFlag) {
  const jd = deepClone(jdRaw);
  if (negOffFlag) jd.keywords.negative = [];
  if (domainOffFlag) { delete jd.domain; delete jd.tasks; }
  const rows = [];
  for (const r of records) {
    if (r.岗位 !== job) continue;
    if (r.标签 === 'skip') continue;
    // 只取正负样本（skip 不计入判据）
    const cand = buildCandidate(r);
    const res = scoreOne(cand, jd, {
      tier: 'detail', weightTemplate: jd.weightTemplate, hardFlags: jd.hardFlags,
    });
    rows.push({
      name: r.姓名, label: r.标签, 档位: r.档位原文, 字数: r.字数,
      total: res.total, coverage: res.coverage, level: res.level,
      gates: res.gates || [], mismatch: res.mismatch,
      insufficient: !!((res.gates || []).find((g) => g.includes('托底'))),
      rejection: r.拒因 || '',
      src: r.来源文件.split(/[\\/]/).pop(),
    });
  }
  return rows;
}

// 判断是否「一面通过」/「一面挂」组（软指标用）
function isPass1(档位) { return /一面通过/.test(档位); }
function isFail1(档位) { return /一面挂|一面不通过|一面未通过/.test(档位); }

const jobs = onlyJob ? [onlyJob] : Object.keys(JOB_ID);

let hardFail = false;
const summary = [];

for (const job of jobs) {
  const jdRaw = JDS.find((j) => j.id === JOB_ID[job]);
  if (!jdRaw) { console.log(`【${job}】无对应 JD，跳过`); continue; }
  const rows = evalJob(job, jdRaw, negOff, domainOff);

  const pos = rows.filter((r) => r.label === 'pos');
  const neg = rows.filter((r) => r.label === 'neg');
  const posBelow = pos.filter((r) => r.total < 60);
  const negBelow = neg.filter((r) => r.total < 60);

  // 进面档 vs 进面级（对应老验收 0/48 + 0/10）
  const isJinMianJi = (r) => /进面级/.test(r.档位);
  const posMian = pos.filter((r) => !isJinMianJi(r));
  const posJi = pos.filter((r) => isJinMianJi(r));
  const posMianBelow = posMian.filter((r) => r.total < 60);
  const posJiBelow = posJi.filter((r) => r.total < 60);

  // 软指标：一面通过 vs 一面挂
  const pass1 = pos.filter((r) => isPass1(r.档位) && r.total != null);
  const fail1 = pos.filter((r) => isFail1(r.档位) && r.total != null);
  const meanPass = pass1.length ? pass1.reduce((s, r) => s + r.total, 0) / pass1.length : null;
  const meanFail = fail1.length ? fail1.reduce((s, r) => s + r.total, 0) / fail1.length : null;
  const delta = meanPass != null && meanFail != null ? meanPass - meanFail : null;

  const jobSummary = {
    job, nPos: pos.length, nNeg: neg.length,
    posBelow: posBelow.length, negBelow: negBelow.length,
    negRecall: neg.length ? negBelow.length / neg.length : null,
    posMianBelow: posMianBelow.length, posJiBelow: posJiBelow.length,
    pass1: pass1.length, fail1: fail1.length, delta,
  };
  summary.push(jobSummary);

  if (posBelow.length) hardFail = true;

  console.log('═'.repeat(76));
  console.log(`【${job}】 正样本 ${pos.length}（进面档 ${posMian.length} / 进面级 ${posJi.length}）  负样本 ${neg.length}`);
  console.log(`  硬门槛：正样本 <60 误杀 ${posBelow.length}/${pos.length}`
    + `（进面档 ${posMianBelow.length}/${posMian.length}，进面级 ${posJiBelow.length}/${posJi.length}）`);
  console.log(`  主指标：负样本识别率 ${neg.length ? (negBelow.length / neg.length * 100).toFixed(0) + '%' : '—'}（${negBelow.length}/${neg.length} <60）`);
  if (delta != null) {
    console.log(`  软指标：一面通过均分 ${meanPass.toFixed(1)} vs 一面挂均分 ${meanFail.toFixed(1)}  Δ=${delta > 0 ? '+' : ''}${delta.toFixed(1)}`);
  }

  console.log('-'.repeat(76));
  console.log('  分数  覆盖  档位        姓名       标签  来源');
  const allRows = [...pos, ...neg].sort((a, b) => a.total - b.total);
  for (const r of allRows) {
    const flag = r.label === 'pos' && r.total < 60 ? ' 误杀!' : r.label === 'neg' && r.total >= 60 ? ' 漏放!' : '';
    const insuf = r.insufficient ? '(托底)' : '';
    console.log(`  ${String(r.total).padStart(3)}  ${String(r.coverage).padStart(3)}%  ${r.档位.slice(0, 12).padEnd(12)}  ${(r.name || '(无)').padEnd(6)}  ${r.label.padEnd(3)}  ${r.src}${insuf}${flag}`);
  }
  console.log('');
}

// 汇总
console.log('#'.repeat(76));
console.log('汇总：');
let Tpos = 0, TposBelow = 0, Tneg = 0, TnegBelow = 0;
let TmianBelow = 0, TjiBelow = 0;
for (const s of summary) {
  Tpos += s.nPos; TposBelow += s.posBelow;
  Tneg += s.nNeg; TnegBelow += s.negBelow;
  TmianBelow += s.posMianBelow; TjiBelow += s.posJiBelow;
  const recall = s.negRecall == null ? '—' : (s.negRecall * 100).toFixed(0) + '%';
  const delta = s.delta == null ? '—' : (s.delta > 0 ? '+' : '') + s.delta.toFixed(1);
  console.log(`  ${s.job.padEnd(8)} 正${String(s.nPos).padStart(3)} 误杀${String(s.posBelow).padStart(2)}  负${String(s.nNeg).padStart(3)} 识别${recall.padStart(4)}  Δ排序${delta}`);
}
const TRecall = Tneg ? TnegBelow / Tneg : 0;
console.log('-'.repeat(76));
console.log(`  正样本误杀 ${TposBelow}/${Tpos}（进面档 ${TmianBelow}/48，进面级 ${TjiBelow}/10）`);
console.log(`  负样本识别率 ${(TRecall * 100).toFixed(0)}%（${TnegBelow}/${Tneg}）  [基线 9%（5/56）]`);
console.log(`  硬门槛 ${hardFail ? '✗ 未通过（有正样本 <60）' : '✓ 通过（正样本零误杀）'}`);

// 列出全部误杀/漏放明细（供报告）
console.log('\n明细（误杀=正样本<60，漏放=负样本≥60）：');
for (const s of summary) {
  const jobRecs = records.filter((r) => r.岗位 === s.job && r.标签 !== 'skip');
  for (const r of jobRecs) {
    const cand = buildCandidate(r);
    const jdRaw = JDS.find((j) => j.id === JOB_ID[s.job]);
    const jd = deepClone(jdRaw);
    if (negOff) jd.keywords.negative = [];
    if (domainOff) { delete jd.domain; delete jd.tasks; }
    const res = scoreOne(cand, jd, { tier: 'detail', weightTemplate: jd.weightTemplate, hardFlags: jd.hardFlags });
    if (r.标签 === 'pos' && res.total < 60) {
      console.log(`  误杀  ${s.job} ${r.姓名 || '(无)'} 分=${res.total} 覆=${res.coverage}% 字数=${r.字数} 档位=${r.档位原文 || ''} src=${r.来源文件.split(/[\\/]/).pop()}`);
    } else if (r.标签 === 'neg' && res.total >= 60) {
      console.log(`  漏放  ${s.job} ${r.姓名 || '(无)'} 分=${res.total} 覆=${res.coverage}% 字数=${r.字数} 拒因=${(r.拒因 || '').slice(0, 30)} src=${r.来源文件.split(/[\\/]/).pop()}`);
    }
  }
}

process.exit(hardFail ? 1 : 0);
