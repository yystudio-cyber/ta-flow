/**
 * 卡片层四档判定验收 —— 分两组独立报告（绝不合并）。
 *
 * Group R（真实）——语料里带【顶卡】的 13 条记录（4 pos / 9 neg），
 *   剥离【附件预览文本】只留顶卡段，模拟一张真实 BOSS 推荐牛人卡片。
 *   ★ 只有 Group R 的数字可以被当作真实卡片表现引用。
 *
 * Group P（代理）——其余所有非 skip 记录降级成"卡片视图"：
 *   只保留真实 BOSS 推荐牛人卡片会暴露的字段。字段清单从
 *   src/main/services/adapters/boss.ts 的 mapCardToProfile()（g 分支）推导：
 *     · position / city / degree / experienceYears / company / age / selfIntro
 *     · skills（= workEmphasisList + markWords + hlmatches + 专业名，无经历正文）
 *     · workHistory 只留 company / industry / position / emphasis，
 *       【删除 description/performance】——那是详情页才有的正文；
 *     · education 保留（卡片上本来就有学历行）
 *   这与引擎判 tier 的口径无关——本脚本对所有样本显式传 tier:'card'。
 *
 * 每组输出：worth / fair / nomatch / unknown 分布 × pos/neg；
 *   · 落进 nomatch 的正样本（Rule 1 违规，必须点名）；
 *   · 落进 worth 的负样本（假阳性）。
 *
 * 纯测量，不改任何分数。用法：npm run score:eval:card
 * 语料路径同 score-eval-v3plus：--corpus=... 或自动探测 ta-corpus.json
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

function os_tmpdir() { try { return require('node:os').tmpdir(); } catch { return '/tmp'; } }
const args = process.argv.slice(2);
const corpusArg = (args.find((a) => a.startsWith('--corpus=')) || '').split('=')[1];
const corpusPath = corpusArg
  || [path.join(process.env.TEMP || os_tmpdir(), 'ta-corpus.json'), path.join(os_tmpdir(), 'ta-corpus.json')]
    .find((p) => fs.existsSync(p))
  || 'C://Users//you/AppData/Local/Temp/ta-corpus.json';

if (!fs.existsSync(corpusPath)) {
  console.log(`ℹ 未找到语料 ${corpusPath}。请先运行 tools/build-corpus.mjs 生成，或用 --corpus 指定路径。`);
  process.exit(2);
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const records = corpus.records;

// JD 配置（同 score-eval-v3plus 口径）：从 config/jd-config.json 读，不硬编码业务岗位
const { jobs: JDS } = loadJdConfig();
if (!JDS.length) {
  console.log('ℹ config/jd-config.json 里没有岗位。先配好自己的 JD 再来跑标定。');
  process.exit(2);
}
const JOB_ID = {};
for (const j of JDS) {
  for (const k of [j.name, j.title].filter(Boolean)) JOB_ID[k] = j.id;
}

const TH = { high: 75, low: 60 };
function deepClone(o) {
  if (o == null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const out = {};
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = deepClone(o[k]);
  return out;
}

/** 剥离附件预览，只留顶卡段 —— 模拟真实卡片（Group R） */
function stripPreview(rec) {
  const raw = rec.简历正文 || '';
  if (/【顶卡】/.test(raw)) return { ...rec, 简历正文: raw.split('【附件预览文本】')[0] };
  return rec;
}

/** 降级为卡片视图（Group P）：删掉只有详情页才有的正文类字段 */
function toCardView(cand) {
  const c = { ...cand };
  c.workHistory = (c.workHistory || []).map((w) => ({
    company: w.company, industry: w.industry, position: w.position,
    emphasis: w.emphasis, startDate: w.startDate, endDate: w.endDate,
    months: w.months, current: w.current,
  }));
  // 保留 education / skills / position / city / degree / experienceYears / company / age / selfIntro
  return c;
}

function scoreOne(cand, jd) {
  return ENGINE.scoreCandidate(cand, jd, TH, { tier: 'card' });
}

// 每张卡都要有 JD。取不到 JD 的记录跳过（如岗位不在 JOB_ID 表里）。
function jdFor(job) { const j = JDS.find((x) => x.id === JOB_ID[job]); return j ? deepClone(j) : null; }

function reportGroup(title, rows, isReal) {
  console.log('\n' + '═'.repeat(76));
  console.log(`${title}（${isReal ? '★ 真实卡片，可引用的数字' : '代理（proxy），仅供调参参考，不可当真实表现引用'}）`);
  const VERDS = ['worth', 'fair', 'nomatch', 'unknown'];
  const byLabel = {};
  for (const r of rows) {
    byLabel[r.label] = byLabel[r.label] || {};
    byLabel[r.label][r.cardVerdict] = (byLabel[r.label][r.cardVerdict] || 0) + 1;
  }
  console.log('  分布（pos/neg × 四档）：');
  console.log(`              worth    fair   nomatch  unknown`);
  for (const lb of ['pos', 'neg']) {
    const d = byLabel[lb] || {};
    const cells = VERDS.map((v) => String(d[v] || 0).padStart(8));
    console.log(`  ${lb.padEnd(3)}   ${cells.join(' ')}    (n=${rows.filter((r) => r.label === lb).length})`);
  }
  console.log('  ── Rule 1 违规（正样本落进 nomatch，会把人直接丢）──');
  const posNomatch = rows.filter((r) => r.label === 'pos' && r.cardVerdict === 'nomatch');
  if (!posNomatch.length) console.log('    无');
  else for (const r of posNomatch) console.log(`    ✗ ${r.name} / ${r.job} / total=${r.total} / cov=${r.coverage}%`);
  console.log('  ── 假阳性（负样本落进 worth，会给 HR 错误地撑「值得看」）──');
  const negWorth = rows.filter((r) => r.label === 'neg' && r.cardVerdict === 'worth');
  if (!negWorth.length) console.log('    无');
  else for (const r of negWorth) console.log(`    ⚠ ${r.name} / ${r.job} / total=${r.total} / cov=${r.coverage}%`);
  console.log('  全部明细（pos 标 P / neg 标 N，★=unknown）：');
  for (const r of rows) {
    const tag = r.label === 'pos' ? 'P' : 'N';
    const star = r.cardVerdict === 'unknown' ? ' ★' : '';
    console.log(`  ${tag} ${(r.name || '?').padEnd(6)} ${r.job.padEnd(12)} ${r.cardVerdict.padEnd(8)}${r.cardVerdictLabel}  total=${r.total} cov=${r.coverage}%${star}`);
  }
}

// ── 分组 ──
const groupR = [];
const groupP = [];
for (const rec of records) {
  if (rec.标签 === 'skip') continue;
  const jd = jdFor(rec.岗位);
  if (!jd) continue;
  const isRealTop = /【顶卡】/.test(rec.简历正文 || '');
  const cand = isRealTop ? buildCandidate(stripPreview(rec)) : buildCandidate(rec);
  if (isRealTop) {
    const res = scoreOne(cand, jd);
    groupR.push({ name: rec.姓名, label: rec.标签, job: rec.岗位, cardVerdict: res.cardVerdict, cardVerdictLabel: res.cardVerdictLabel, total: res.total, coverage: res.coverage });
  } else {
    const res = scoreOne(toCardView(cand), jd);
    groupP.push({ name: rec.姓名, label: rec.标签, job: rec.岗位, cardVerdict: res.cardVerdict, cardVerdictLabel: res.cardVerdictLabel, total: res.total, coverage: res.coverage });
  }
}

reportGroup('Group R（真实顶卡，附件预览已剥离）', groupR, true);
reportGroup('Group P（其余样本降级为卡片视图）', groupP, false);

const nRPos = groupR.filter((r) => r.label === 'pos').length;
const nRNeg = groupR.filter((r) => r.label === 'neg').length;
console.log('\n' + '#'.repeat(76));
console.log(`Group R 样本量：pos ${nRPos} / neg ${nRNeg}（真实，仅此可引用）`);
console.log(`Group P 样本量：pos ${groupP.filter((r) => r.label === 'pos').length} / neg ${groupP.filter((r) => r.label === 'neg').length}（代理，勿引用为真实表现）`);
console.log('提示：卡片层「值得看」要求岗位专属正向证据；判别维度 <2 会给「信息不足」。');
process.exit(0);
