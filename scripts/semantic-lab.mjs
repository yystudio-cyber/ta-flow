/**
 * 语义 provider 回归闸门 —— 守一件事：**相似度不许静默归零**。
 *
 * 为什么需要这道闸门（2026-08-03 审查实录）：
 *   分词器（_fmm/_bmm）对词典里没有的中文串会逐字切开，"订单风控引擎" → 订/单/风/控/引/擎。
 *   老版 _canon 把长度 <2 的非拉丁 token 整个丢掉，于是任何以未登录词为主的文本
 *   分词后 token 全空 → tf 为空 → cosine 的 n1===0 → similarity 恒等于 0。
 *
 *   词典是按汽车/感知领域手工建的（96 个同义词组），所以这个 bug 的实际表现是：
 *   **非汽车领域的 JD，语义相似度永远是 0**。不报错、不告警，只是这个模块整体失效。
 *
 *   更糟的是它的下游：scoreProjects 的语义分支算的是 kwScore*0.5 + semScore*100*0.5。
 *   语义恒 0 意味着一旦把 SEMANTIC_ENABLED 打开，这些岗位的项目经验维会被【腰斩】——
 *   "开了语义反而变差"，而没人能说清为什么。这正是语义开关一直悬而未决的真实原因。
 *
 * 本脚本用一组【梯度用例】把这件事钉死：从"完全相同"到"完全无关"，
 * 相似度必须能分开，且相关文本不许掉到 0。
 *
 * 注意：本闸门只测 provider 本身，不依赖 SEMANTIC_ENABLED 开关的取值——
 * 开关当前是关的（生产走纯字面匹配），但 provider 必须随时可用，
 * 否则"要不要开"这个决策永远缺一个可信的对照基线。
 *
 * 用法：npm run semantic:check
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEM = require(path.join(ROOT, 'src', 'shared', 'semantic-provider.js'));

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}

for (const [providerName, opts] of [['默认词表', undefined], ['领域扩充词表', SEM.DOMAIN_COMMON]]) {
  console.log(`\n=== provider：${providerName} ===`);
  const p = SEM.createSemanticProvider(opts);

  // ── 一、未登录词不许把相似度打成 0 ────────────────────────────────────
  // 这几组文本的词汇【故意都不在汽车词表里】——风控、支付、人力资源。
  // 这正是老 bug 的触发条件：词典覆盖不到 → 逐字切 → 全丢 → 0。
  const outOfVocab = [
    ['订单风控引擎，实时反欺诈规则引擎，日均千万级订单风控决策',
     '负责订单风控引擎的规则编排，实时反欺诈决策链路建设'],
    ['支付清算系统的账务对账与资金流水核对',
     '负责支付清算与账务对账系统的设计开发'],
    ['负责招聘全流程，简历筛选、面试安排、offer 沟通',
     '统筹招聘全流程：简历初筛、面试组织与 offer 谈判'],
  ];
  for (let i = 0; i < outOfVocab.length; i++) {
    const s = p.similarity(outOfVocab[i][0], outOfVocab[i][1]);
    ok(s > 0.3, `未登录词文本对 #${i + 1} 相似度不为 0（老实现恒 0）`, s.toFixed(3));
  }

  // ── 二、不许把无关文本判成相关（防止上面的修法用力过猛）────────────────
  const unrelated = [
    ['天气很好今天出去玩了一趟', '支付风控算法实时反欺诈引擎'],
    ['负责招聘全流程，简历筛选、面试安排', '分布式订单系统高并发架构'],
  ];
  for (let i = 0; i < unrelated.length; i++) {
    const s = p.similarity(unrelated[i][0], unrelated[i][1]);
    ok(s < 0.25, `无关文本对 #${i + 1} 相似度足够低（无误报）`, s.toFixed(3));
  }

  // ── 三、梯度可分：同域 > 异域 ─────────────────────────────────────────
  // 这条直接对应评分引擎最核心的判断（金融风控 vs 电商推荐）。
  const same = p.similarity(
    '支付风控引擎，实时反欺诈，规则编排',
    '负责支付风控规则引擎与实时反欺诈链路');
  const cross = p.similarity(
    '电商推荐排序，特征工程，AB实验平台',
    '负责支付风控规则引擎与实时反欺诈链路');
  ok(same > cross, '同域相似度 > 异域相似度（区分度没被兜底策略抹平）',
    `同域 ${same.toFixed(3)} vs 异域 ${cross.toFixed(3)}`);
  ok(same >= 0.6, '同域相似度足够高', same.toFixed(3));

  // ── 四、自反性与对称性（基本性质，坏了说明分词/归一化出了问题）─────────
  const t = '负责支付风控规则引擎与实时反欺诈链路';
  ok(p.similarity(t, t) >= 0.99, '自反：sim(x,x) ≈ 1', p.similarity(t, t).toFixed(3));
  const a = '订单风控引擎的规则编排', b = '实时反欺诈决策链路建设';
  ok(Math.abs(p.similarity(a, b) - p.similarity(b, a)) < 1e-9, '对称：sim(a,b) === sim(b,a)');

  // ── 五、空/异常输入不抛 ───────────────────────────────────────────────
  let threw = false;
  try {
    p.similarity('', '');
    p.similarity(null, undefined);
    p.similarity('   ', '，。！');
    p.tokenize(null);
    p.kwSim('', '');
  } catch (e) { threw = true; }
  ok(!threw, '空/异常输入不抛异常');

  // ── 六、分词后不许出现"全空"（老 bug 的直接特征）───────────────────────
  // 只要中文文本分词+归一化后一个 token 都不剩，相似度必然恒 0。
  // 这条比相似度阈值更直接地锁住根因。
  const cjkTexts = [
    '订单风控引擎的规则编排',
    '统筹招聘全流程与面试组织',
    '负责账务对账与资金流水核对',
  ];
  for (const txt of cjkTexts) {
    const toks = p.tokenize(txt);
    ok(toks.length > 0, `分词非空：「${txt.slice(0, 12)}…」`, `${toks.length} 个 token`);
    // similarity 内部还会过一层 _canon，这里用 sim(x,x) 间接验证 canon 后也非空
    ok(p.similarity(txt, txt) > 0, `归一化后非空（sim(x,x) > 0）：「${txt.slice(0, 12)}…」`,
      p.similarity(txt, txt).toFixed(3));
  }
}

console.log('');
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log(`✓ 全部通过：${pass}/${pass}`);
