// 第 2 条：负向词安全校验 —— 每个候选负向词加入 jd.keywords.negative 后，
// 用真实评分引擎跑本岗位【全部正样本】，任一正样本因此掉到 <60 就丢弃该词。
// 用法：node tools/task2-safety.mjs --corpus <json> [--job <岗位名>]
// 岗位配置读 config/jd-config.json；候选负向词用 --neg 指定 <jobId>=词1,词2
// 或来自 config/negative-words.json（可选，你自己维护的拒因词表）。
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { loadJdConfig } from '../scripts/config-loader.mjs';
const require = createRequire(import.meta.url);
const ENGINE = require(path.join(process.cwd(), 'src/shared/scoring-universal.js'));

const args = process.argv.slice(2);
const corpusPath = (args.find((a) => a.startsWith('--corpus=')) || '').split('=')[1]
  || path.join(process.env.TEMP || '/tmp', 'ta-corpus.json');
const onlyJob = (args.find((a) => a.startsWith('--job=')) || '').split('=')[1] || null;

if (!fs.existsSync(corpusPath)) {
  console.log(`ℹ 未找到语料 ${corpusPath}。先跑 tools/build-corpus.mjs，或用 --corpus 指定。`);
  process.exit(2);
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const records = corpus.records;

// 从 config/jd-config.json 读岗位库（用户的业务数据不进代码）
const { jobs: JDS } = loadJdConfig();

// 候选负向词：你自己的拒因词表，按 jobId 组织。缺省为空——空表即表示"不校验任何词"。
// 来源建议：把 HR 的拒因原话拆成词，逐词过一遍这个校验再入库。
const NEG_FILE = path.join(process.cwd(), 'config', 'negative-words.json');
const CANDIDATE_NEG = fs.existsSync(NEG_FILE)
  ? JSON.parse(fs.readFileSync(NEG_FILE, 'utf8'))
  : {};

import { buildCandidate } from './candidate-builder.mjs';

// 文件名/文件夹名 → 岗位 id（按 name/title 匹配，不再硬编码）
const JOB_ID = {};
for (const j of JDS) {
  for (const k of [j.name, j.title].filter(Boolean)) JOB_ID[k] = j.id;
  JOB_ID[j.id] = j.id;
}
const jdById = {};
for (const jd of JDS) jdById[jd.id] = jd;

const jobs = Object.keys(CANDIDATE_NEG).filter((j) => !onlyJob || j === onlyJob);

console.log('负向词安全校验：加入候选负向词后，正样本最低分不得 <60（否则丢弃该词）\n');
for (const job of jobs) {
  const posRecs = records.filter((r) => r.岗位 === job && r.标签 === 'pos');
  const negRecs = records.filter((r) => r.岗位 === job && r.标签 === 'neg');
  const jd = jdById[JOB_ID[job]];
  if (!jd) { console.log(`【${job}】在 config/jd-config.json 里找不到对应 JD，跳过`); continue; }
  console.log('═'.repeat(70));
  console.log(`【${job}】 正样本 ${posRecs.length} / 负样本 ${negRecs.length}   JD=${jd.name}(${jd.id})`);

  if (!posRecs.length) {
    console.log('  无正样本，无法校验负向词安全性，仅记录候选负向词（由人工复核）：', CANDIDATE_NEG[job].join(', ') || '无');
    continue;
  }

  // 基线（不加任何负向词）
  const jdBase = JSON.parse(JSON.stringify(jd));
  jdBase.keywords.negative = [];
  const baseScores = posRecs.map((r) => ENGINE.scoreCandidate(buildCandidate(r), jdBase, { high: 75, low: 60 }, {
    tier: 'detail', weightTemplate: jdBase.weightTemplate, hardFlags: jdBase.hardFlags,
  }).total);
  const baseMin = Math.min(...baseScores);
  console.log(`  基线（无负向词）：正样本最低分 = ${baseMin}`);

  const candidates = CANDIDATE_NEG[job] || [];
  const accepted = [];
  const rejected = [];

  for (const word of candidates) {
    const jdT = JSON.parse(JSON.stringify(jd));
    jdT.keywords.negative = [word];
    const scores = posRecs.map((r) => ENGINE.scoreCandidate(buildCandidate(r), jdT, { high: 75, low: 60 }, {
      tier: 'detail', weightTemplate: jdT.weightTemplate, hardFlags: jdT.hardFlags,
    }).total);
    const min = Math.min(...scores);
    const below = posRecs.filter((r, i) => scores[i] < 60 && baseScores[i] >= 60).map((r) => r.姓名);
    if (below.length === 0) {
      accepted.push({ word, min, baseMin });
      console.log(`  ✓ "${word}"：加后最低分 ${min}（基线 ${baseMin}），无正样本跌破 60 —— 保留`);
    } else {
      rejected.push({ word, min, below });
      console.log(`  ✗ "${word}"：加后最低分 ${min}，跌破 60 的正样本 ${below.join('、')} —— 丢弃`);
    }
  }
  console.log(`  → 保留：${accepted.map((a) => a.word).join('、') || '无'}`);
  if (rejected.length) console.log(`  → 丢弃：${rejected.map((r) => r.word).join('、')}`);
  console.log();
}
