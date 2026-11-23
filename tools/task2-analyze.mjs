// 第 2 条：锚点因子分析工具（log-odds 两组 + 负向词安全校验）
// 用法：node tools/task2-analyze.mjs --corpus <corpus.json> [--job 测试工程师]
// 产物：打印两组 log-odds top-30、负向词安全校验（加入前后正样本最低分）
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ENGINE = require(path.join(process.cwd(), 'src/shared/scoring-universal.js'));

const args = process.argv.slice(2);
const corpusPath = (args.find((a) => a.startsWith('--corpus=')) || '').split('=')[1]
  || 'C://Users//you/AppData/Local/Temp/ta-corpus.json';
const onlyJob = (args.find((a) => a.startsWith('--job=')) || '').split('=')[1] || null;

const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const records = corpus.records;

// ── 分词：中文二元组 + 拉丁词 ─────────────────────────────
function tokenize(text) {
  const toks = new Set();
  if (!text) return toks;
  const lower = text.toLowerCase();
  // 拉丁词（含 - . 内部）
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9+#._-]{2,}[a-z0-9]/g)) toks.add(m[0]);
  // 中文：去标点后切 2-gram 与 3-gram
  const cjk = lower.replace(/[^一-龥]/g, '');
  const n = cjk.length;
  for (let i = 0; i < n - 1; i++) toks.add(cjk.slice(i, i + 2));
  for (let i = 0; i < n - 2; i++) toks.add(cjk.slice(i, i + 3));
  return toks;
}

// ── log-odds（带先验，Monroe 2008）────────────────────────
// log-odds = log((c1+a)/(n1+b)) - log((c2+a)/(n2+b))，a=alpha 先验（取 0.5）
function logOdds(targetRecords, baseRecords, alpha = 0.5) {
  const targetCounts = new Map();
  const baseCounts = new Map();
  let targetTotal = 0, baseTotal = 0;
  for (const r of targetRecords) for (const t of tokenize(r.简历正文)) { targetCounts.set(t, (targetCounts.get(t) || 0) + 1); targetTotal++; }
  for (const r of baseRecords) for (const t of tokenize(r.简历正文)) { baseCounts.set(t, (baseCounts.get(t) || 0) + 1); baseTotal++; }
  const all = new Set([...targetCounts.keys(), ...baseCounts.keys()]);
  const out = [];
  for (const t of all) {
    const c1 = targetCounts.get(t) || 0;
    const c2 = baseCounts.get(t) || 0;
    const score = Math.log((c1 + alpha) / (targetTotal + 2 * alpha)) - Math.log((c2 + alpha) / (baseTotal + 2 * alpha));
    out.push({ token: t, score, c1, c2 });
  }
  return out.sort((a, b) => b.score - a.score);
}

const jobs = [...new Set(records.map((r) => r.岗位))];

// ── 负向词安全校验：加入某 negative 词后，本岗位所有正样本最低分 ──
function safetyCheck(job, negWords, jd) {
  const posRecs = records.filter((r) => r.岗位 === job && r.标签 === 'pos');
  if (!posRecs.length) return { n: 0, minBefore: null, minAfter: null, droppedBelow60: null };
  const jdClone = JSON.parse(JSON.stringify(jd));
  // before
  const before = posRecs.map((r) => {
    const cand = buildCandidate(r);
    const res = ENGINE.scoreCandidate(cand, jdClone, { high: 75, low: 60 }, { tier: 'detail', weightTemplate: jdClone.weightTemplate || 'tech', hardFlags: jdClone.hardFlags });
    return res.total;
  });
  // add negative
  jdClone.keywords.negative = [...(jdClone.keywords.negative || []), ...negWords];
  const after = posRecs.map((r) => {
    const cand = buildCandidate(r);
    const res = ENGINE.scoreCandidate(cand, jdClone, { high: 75, low: 60 }, { tier: 'detail', weightTemplate: jdClone.weightTemplate || 'tech', hardFlags: jdClone.hardFlags });
    return res.total;
  });
  const minBefore = Math.min(...before);
  const minAfter = Math.min(...after);
  const droppedBelow60 = posRecs.filter((r, i) => before[i] >= 60 && after[i] < 60).map((r) => r.姓名);
  return { n: posRecs.length, minBefore, minAfter, droppedBelow60 };
}

// 构造候选：整篇正文切 workHistory（每段 ~380 字）
function buildCandidate(rec) {
  const text = rec.简历正文 || '';
  // 按段落切，每段 ~380 字聚合
  const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const segs = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length + p.length > 380 && cur) { segs.push(cur); cur = ''; }
    cur += (cur ? ' ' : '') + p;
  }
  if (cur) segs.push(cur);
  // 姓名/岗位从首段粗提
  const name = rec.姓名 || '';
  const firstLine = paras[0] || '';
  const workHistory = segs.map((s, i) => ({
    company: i === 0 ? name : '',
    position: i === 0 ? firstLine.slice(0, 12) : '',
    description: s,
  }));
  return {
    name,
    position: firstLine.slice(0, 20),
    selfIntro: text.slice(0, 120),
    workHistory,
    education: [{ school: '', major: '' }],
  };
}

console.log('语料岗位：', jobs.join(' / '));
console.log('正样本总数', records.filter((r) => r.标签 === 'pos').length,
  '负样本', records.filter((r) => r.标签 === 'neg').length,
  '跳过', records.filter((r) => r.标签 === 'skip').length, '\n');

for (const job of jobs) {
  if (onlyJob && job !== onlyJob) continue;
  const recs = records.filter((r) => r.岗位 === job);
  const pos = recs.filter((r) => r.标签 === 'pos');
  const neg = recs.filter((r) => r.标签 === 'neg');
  const others = records.filter((r) => r.岗位 !== job);
  console.log('═'.repeat(72));
  console.log(`【${job}】 正 ${pos.length} / 负 ${neg.length} / 跳 ${recs.filter(r=>r.标签==='skip').length}`);

  // (a) 岗位 vs 其余
  console.log('\n── (a) 岗位特征词 log-odds（本岗 vs 其余）top-30 ──');
  const a = logOdds(recs, others).slice(0, 30);
  console.log(a.map((x) => `${x.token}(${x.score.toFixed(2)},${x.c1}/${x.c2})`).join(' '));

  if (pos.length && neg.length) {
    // (b) 正 vs 负
    console.log('\n── (b) 区分词 log-odds（本岗正 vs 负）top-30 正侧 ──');
    const b = logOdds(pos, neg).slice(0, 30);
    console.log(b.map((x) => `${x.token}(${x.score.toFixed(2)},${x.c1}/${x.c2})`).join(' '));
    console.log('── 负侧（负样本更常见）top-20 ──');
    const bn = logOdds(neg, pos).slice(0, 20);
    console.log(bn.map((x) => `${x.token}(${x.score.toFixed(2)},${x.c1}/${x.c2})`).join(' '));
  }
  console.log();
}
