/**
 * 配置自检 —— 新用户接入时先跑这个。
 *
 * 用法：npm run config:check
 *
 * 检查三件事：
 *   1. config/jd-config.json 是否存在、结构是否合法（有没有 id / title / 必填字段）
 *   2. config/workflow.json 是否存在，飞书租户/平台开关是否填了
 *   3. 评分引擎能否吃下你的 JD 且不报错
 *
 * 退出码：0 = 可以去跑 RPA 了；1 = 还有必须修的项。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadJdConfig, loadWorkflowConfig, feishuOrigin, CONFIG_DIR } from './config-loader.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = require(path.join(ROOT, 'src', 'shared', 'scoring-universal.js'));

let errors = 0, warns = 0;
const err = (m) => { errors++; console.log('  ✗ ' + m); };
const warn = (m) => { warns++; console.log('  ! ' + m); };
const good = (m) => console.log('  ✓ ' + m);

console.log('\n═══ TA Flow 配置自检 ═══\n');

// ── 1. 岗位库 ──────────────────────────────────────────────
console.log('[1/3] 岗位库 config/jd-config.json');
let jd;
try {
  jd = loadJdConfig();
} catch (e) {
  err(e.message);
  jd = null;
}

if (jd) {
  if (jd.isExample) warn('当前用的是示例模板（jd-config.example.json），命令能跑通但分数没有业务意义');
  else good('已找到你自己的岗位库：' + path.relative(ROOT, jd.file));

  if (!jd.jobs.length) err('岗位列表是空的');

  const ids = new Set();
  for (const [i, j] of jd.jobs.entries()) {
    const tag = j.id || `#${i}`;
    if (!j.id) err(`第 ${i + 1} 个岗位没有 id`);
    else if (ids.has(j.id)) err(`岗位 id 重复：${j.id}`);
    else ids.add(j.id);
    if (!j.title) err(`岗位 ${tag} 没有 title（岗位名匹配维度要用）`);
    if (!j.keywords || (!j.keywords.required?.length && !j.keywords.bonus?.length)) {
      warn(`岗位 ${tag} 没有配必选/加分关键词，硬技能维会判为无数据`);
    }
    if (!j.domain || !j.domain.label) {
      warn(`岗位 ${tag} 没配 domain（应用域）—— domainFit 会整维退出，占 20% 权重打不出来`);
    }
    if (!j.tasks?.length) {
      warn(`岗位 ${tag} 没配 tasks（任务点）—— taskCoverage 会整维退出`);
    }
    if (!j.responsibilities?.length && !j.jdText) {
      warn(`岗位 ${tag} 没有 responsibilities / jdText，项目经验维会判为无数据`);
    }
  }
  if (jd.jobs.length) good(`共 ${jd.jobs.length} 个岗位`);
}

// ── 2. 工作流 ──────────────────────────────────────────────
console.log('\n[2/3] 工作流 config/workflow.json');
let wf;
try {
  wf = loadWorkflowConfig();
  if (wf.isExample) warn('当前用的是示例模板（workflow.example.json），平台/租户都是占位值');
  else good('已找到你自己的配置');

  const plats = wf.config?.platforms?.enabled;
  if (!Array.isArray(plats) || !plats.length) err('platforms.enabled 为空，至少要开一个平台');
  else good('启用平台：' + plats.join(', '));

  const sub = wf.config?.feishu?.tenantSubdomain;
  if (!sub || sub === 'example') warn(`飞书租户还是占位值 "example"，飞书相关工具需改成你自己的子域`);
  else good('飞书 origin：' + feishuOrigin(wf.config));

  const led = wf.config?.excel?.ledgerPath;
  if (!led) warn('excel.ledgerPath 为空 —— 「飞书需求汇总」没有目标台账可写');
} catch (e) {
  err(e.message);
}

// ── 3. 引擎实跑 ────────────────────────────────────────────
console.log('\n[3/3] 评分引擎实跑');
if (jd && jd.jobs.length) {
  const job = jd.jobs[0];
  const fake = {
    name: '示例候选人',
    basic: {
      degree: job.basic?.degree || '本科',
      experience: job.basic?.experienceMin || 3,
      city: job.basic?.city || '',
    },
    keywords: (job.keywords?.required || []).slice(0, 2),
    workHistory: [{ company: '示例公司', title: job.title, raw: '示例经历描述' }],
  };
  try {
    const r = ENGINE.scoreCandidate(fake, job, { high: 75, low: 60 }, { tier: 'card', weightTemplate: job.weightTemplate });
    if (typeof r?.total !== 'number' || Number.isNaN(r.total)) err('引擎返回了非法分数：' + JSON.stringify(r)?.slice(0, 120));
    else good(`引擎跑通：「${job.title}」示意分数 ${Math.round(r.total)}（覆盖度 ${r.coverage ?? '—'}）`);
  } catch (e) {
    err('引擎跑你的 JD 时抛错：' + e.message);
  }
}

// ── 汇总 ─────────────────────────────────────────────────
console.log('\n' + '─'.repeat(46));
if (errors) {
  console.log(`结果：${errors} 个必须修的问题，${warns} 个提醒`);
  console.log('先修完 ✗ 再来跑 RPA。');
  process.exit(1);
}
console.log(`结果：可以开始用了（${warns} 个提醒）。`);
console.log('下一步：npm run dev → 设置里配浏览器 → 岗位库确认激活岗位 → RPA 控制台');
process.exit(0);
