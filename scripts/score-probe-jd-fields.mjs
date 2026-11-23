/**
 * 生产态探针 —— 4 配置 × 3 语义 = 12 组对照矩阵。
 *
 * 用途：调优归因时快速看清"少了哪个字段"和"语义开关"是如何影响分数的，而不用每次改
 * score-eval 的硬门槛。本脚本只打印不 gate（exit 0）。
 *
 * 4 配置（列）：
 *   FULL     保留 domain 和 tasks（= score-eval 的 FULL 态，配置完整态）
 *   -D       删 domain（留 tasks）
 *   -T       删 tasks（留 domain）
 *   PROD     删 domain 和 tasks（= score-eval 的 PROD 态，线上真实配置）
 *
 * 3 语义模式（行）：
 *   none     不注入语义 provider
 *   default  注入 IT 通用词表
 *   domain   注入 IT + 汽车/感知领域词表
 *
 * 每个格打印：A分 B分 A-B分差（倒挂时标 ⚠）。
 *
 * 用法：node scripts/score-probe-jd-fields.mjs
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

const THRESHOLDS = { high: 75, low: 60 };

function deepClone(o) {
  if (o == null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const out = {};
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = deepClone(o[k]);
  return out;
}
function deriveJd(srcJd, mode) {
  const jd = deepClone(srcJd);
  if (mode === '-D' || mode === 'PROD') delete jd.domain;
  if (mode === '-T' || mode === 'PROD') delete jd.tasks;
  return jd;
}

// 加载锚点
function loadSets() {
  const out = [];
  if (!fs.existsSync(ANCHOR_DIR)) return out;
  for (const ta of fs.readdirSync(ANCHOR_DIR)) {
    const dir = path.join(ANCHOR_DIR, ta);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (!j.jd || !Array.isArray(j.anchors) || !j.anchors.length) continue;
        out.push({ ta, file: `${ta}/${f}`, ...j });
      } catch { /* ignore */ }
    }
  }
  return out;
}

const CONFIGS = ['FULL', '-D', '-T', 'PROD'];
const SEM_MODES = ['none', 'default', 'domain'];

function setSemantic(mode) {
  // 清掉之前可能注入的 provider——scoring-universal 里没有 clear 接口，
  // 但 setSemanticProvider(null) 会让 hasSemantic() 返 false（semanticProvider 被赋 null）。
  if (mode === 'default') {
    ENGINE.setSemanticProvider(SEM.createSemanticProvider());
  } else if (mode === 'domain') {
    ENGINE.setSemanticProvider(SEM.createSemanticProvider(SEM.DOMAIN_COMMON));
  } else {
    ENGINE.setSemanticProvider(null);
  }
}

function scoreOne(cand, jd) {
  const r = ENGINE.scoreCandidate(cand, jd, THRESHOLDS, { tier: 'detail' });
  return r ? r.total : null;
}

const sets = loadSets();
if (!sets.length) { console.log('无锚点集'); process.exit(0); }

for (const set of sets) {
  console.log('='.repeat(100));
  console.log(`${set.file}　JD：${set.jd.title || set.jd.name}（人工锚点 ${set.anchors.length} 人）`);
  const anchors = set.anchors;
  // 表头
  const colW = 22;
  const header = '语义模式'.padEnd(10) + '│' + CONFIGS.map((c) => c.padStart(colW)).join('│');
  console.log('-'.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const sem of SEM_MODES) {
    setSemantic(sem);
    const cells = [];
    for (const cfg of CONFIGS) {
      const jd = deriveJd(set.jd, cfg);
      const scores = anchors.map((a) => scoreOne(a.candidate, jd));
      const parts = [];
      for (let i = 0; i < anchors.length; i++) {
        parts.push(`${anchors[i].name.replace(/｜.*/, '')}=${scores[i]}`);
      }
      // 计算 A-B 差异（假设第一个是高分、第二个是低分，按人工分降序）
      const ordered = anchors.map((a, i) => ({ human: a.humanScore, pred: scores[i], name: a.name }))
        .sort((a, b) => b.human - a.human);
      const diff = ordered.length >= 2 ? ordered[0].pred - ordered[1].pred : 0;
      const flag = diff < 0 ? ' ⚠倒' : '';
      cells.push(`${parts.join(' ')} Δ=${diff > 0 ? '+' : ''}${diff}${flag}`.padStart(colW));
    }
    console.log(sem.padEnd(10) + '│' + cells.join('│'));
  }
  console.log('-'.repeat(header.length));
  console.log('列：FULL=domain+tasks齐全 / -D=删domain / -T=删tasks / PROD=两者都删（线上）');
  console.log('Δ = 人工最高分 − 人工最低分 的引擎预测差；⚠倒 表示跨档倒挂。');
  console.log('');
}

console.log('\n注：本脚本只打印不 gate（exit 0）。');
process.exit(0);
