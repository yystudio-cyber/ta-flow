/**
 * 评分引擎分布体检 —— 针对"真机分数挤在 50-65"的回归防线。
 *
 * 用一个真实形态的 JD + 12 个梯度分明的候选人（从完美匹配到完全不相干），
 * 断言 v3 引擎能把他们【拉开】：
 *   · 极差 ≥ 45 分（旧引擎实测只有 ~15）
 *   · 明显好的人 ≥ 75，明显不相干的人 ≤ 35
 *   · 50-65 区间的堆积 ≤ 1/3（旧引擎全员堆积在此）
 *   · 卡片层 → 详情层接力后分数变化方向合理
 *
 * 用法：npm run score:check
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ENGINE = require('../src/shared/scoring-universal.js');

const JD = {
  id: 'jd-test-engineer', name: '软件测试工程师', title: '软件测试工程师',
  basic: { degree: '本科', experienceMin: 2, experienceMax: 6, city: '武汉', salaryMin: 10, salaryMax: 20 },
  keywords: {
    required: ['测试用例', '接口测试', 'Python'],
    bonus: ['Jmeter', 'Docker', '自动化测试'],
    negative: ['外包驻场'],
  },
  industry: { preferred: ['互联网', '软件'], excluded: ['房地产'] },
  responsibilities: ['负责核心系统测试用例设计与执行', '接口功能测试与链路验证'],
};
const TH = { high: 75, low: 60 };

// 12 个梯度候选人（卡片层形态：无项目/教育/经历正文）
const CARDS = [
  ['A 完美匹配', { position: '软件测试工程师', degree: '本科', city: '武汉', salary: '12-18K', experienceYears: 4, age: 27, skills: ['测试用例', '接口测试', 'Python', '自动化测试', 'Jmeter', '性能测试'], company: '某互联网集团（上市/万人级）', companySize: '10000人以上', workHistory: [{ company: '某互联网科技', industry: '互联网' }] }],
  ['B 强匹配', { position: '测试工程师', degree: '本科', city: '武汉', salary: '13-19K', experienceYears: 3, age: 26, skills: ['测试用例', '接口测试'], company: '某软件公司', workHistory: [{ company: '某房地产公司', industry: '房地产' }] }],
  ['C 良好', { position: '测试工程师', degree: '本科', city: '武汉', salary: '11-16K', experienceYears: 5, age: 28, skills: ['测试用例'], company: '某软件公司', workHistory: [{ company: '某软件公司' }] }],
  ['D 一般-同职能缺硬技能', { position: '测试工程师', degree: '大专', city: '武汉', salary: '9-13K', experienceYears: 2, age: 25, skills: ['功能测试'], workHistory: [] }],
  ['E 一般-跨城', { position: '接口自动化测试', degree: '本科', city: '上海', salary: '18-25K', experienceYears: 4, age: 28, skills: ['测试用例', '接口测试'], workHistory: [{ company: '某互联网公司', industry: '互联网' }] }],
  ['F 弱-开发转测', { position: 'Java开发工程师', degree: '本科', city: '武汉', salary: '15-22K', experienceYears: 4, age: 29, skills: ['Java', 'Spring'], workHistory: [{ company: '互联网公司' }] }],
  ['G 弱-经验不足(硬门槛)', { position: '测试工程师', degree: '本科', city: '武汉', salary: '8-12K', experienceYears: 1, age: 23, skills: ['测试用例'], workHistory: [] }],
  ['H 差-学历不符(硬门槛)', { position: '测试员', degree: '大专', city: '武汉', salary: '7-10K', experienceYears: 3, age: 26, skills: ['功能测试'], workHistory: [] }],
  ['I 差-完全不相干', { position: '销售经理', degree: '本科', city: '北京', salary: '20-30K', experienceYears: 5, age: 30, skills: ['客户开发', '渠道'], workHistory: [{ company: '房地产集团', industry: '房地产' }] }],
  ['J 稀疏卡片', { position: '测试工程师', degree: '本科', city: '武汉', salary: '', experienceYears: null, age: null, skills: [], workHistory: [] }],
  ['K 应届触硬门槛', { position: '后端开发实习生', degree: '硕士', city: '武汉', salary: '4-6K', experienceYears: 0, age: 23, skills: ['测试用例'], workHistory: [] }],
  ['L 超预算超年限', { position: '测试专家', degree: '硕士', city: '武汉', salary: '30-45K', experienceYears: 12, age: 38, skills: ['测试用例', '接口测试', 'Python'], workHistory: [{ company: '万人级互联网企业', industry: '互联网' }], companySize: '10000人以上' }],
];

for (const [, c] of CARDS) { c.education = []; c.projects = []; c.workHistory = c.workHistory || []; }

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra != null ? '  → ' + extra : ''}`);
}

console.log('── 卡片层（tier=card）──');
const rows = CARDS.map(([label, c]) => {
  const r = ENGINE.scoreCandidate(c, JD, TH, { tier: 'card' });
  return { label, total: r.total, level: r.level, mismatch: r.mismatch, r };
});
for (const x of rows) console.log(`  ${String(x.total).padStart(3)}  ${x.level.padEnd(8)} ${x.label}`);

const nums = rows.filter((x) => !x.mismatch).map((x) => x.total);
const spread = Math.max(...nums) - Math.min(...nums);
const in5065 = rows.filter((x) => x.total >= 50 && x.total <= 65).length;
const A = rows[0], B = rows[1], I = rows[8], G = rows[6], H = rows[7], J = rows[9], F = rows[5];

check('非 mismatch 人群极差 ≥ 45', spread >= 45, `spread=${spread}`);
check('完美匹配 A ≥ 80', A.total >= 80, A.total);
check('强匹配 B ≥ 70', B.total >= 70, B.total);
check('完全不相干 I ≤ 35', I.total <= 35, I.total);
check('开发转测 F 明显低于强匹配 B（≥15 分差）', B.total - F.total >= 15, `${B.total} vs ${F.total}`);
check('经验不足 G 触发硬门槛', G.mismatch === true, G.level);
check('学历不符 H 触发硬门槛', H.mismatch === true, H.level);
check('稀疏卡片 J 覆盖度低且不给 high', J.r.coverage < 75 && J.level !== 'high', `cov=${J.r.coverage} level=${J.level}`);
check('50-65 堆积 ≤ 1/3', in5065 <= Math.ceil(rows.length / 3), `${in5065}/${rows.length}`);
check('排序合理：A > B > C > F', A.total > B.total && B.total > rows[2].total && rows[2].total > F.total,
  [A.total, B.total, rows[2].total, F.total].join(' > '));

console.log('\n── 详情层接力（tier=detail）──');
// C（良好）打开详情：正文里出现测试用例/接口/Python → 深评应显著上调
const cDeep = {
  ...CARDS[2][1],
  workHistory: [
    { company: '某软件公司', position: '测试工程师', description: '负责订单系统与支付网关功能测试，编写测试用例 800+，主导接口自动化验证，使用 Python 搭建 Jmeter 压测环境。' },
    { company: '某科技公司', position: '测试助理', description: '参与 App 功能测试与回归。' },
  ],
  projects: [{ name: '分布式订单系统自动化测试平台', desc: '基于 Python 的接口自动化测试框架，覆盖用例生成与结果校验' }],
  education: [{ school: '某大学', major: '计算机科学与技术' }],
};
const cCard = ENGINE.scoreCandidate(CARDS[2][1], JD, TH, { tier: 'card' });
const cDetail = ENGINE.scoreCandidate(cDeep, JD, TH, { tier: 'detail' });
console.log(`  C 卡片 ${cCard.total}（cov ${cCard.coverage}%） → 详情 ${cDetail.total}（cov ${cDetail.coverage}%）`);
check('详情证据充分后分数上调 ≥ 8', cDetail.total - cCard.total >= 8, `Δ=${cDetail.total - cCard.total}`);
check('详情层覆盖度高于卡片层', cDetail.coverage > cCard.coverage, `${cCard.coverage}% → ${cDetail.coverage}%`);
check('详情层 tier 标记正确', cDetail.tier === 'detail' && cCard.tier === 'card');

// I（不相干）打开详情：正文全是销售内容 → 不该被"信息变多"抬分抬进可谈区
const iDeep = {
  ...CARDS[8][1],
  workHistory: [{ company: '房地产集团', position: '销售经理', description: '负责华北区渠道销售与大客户开发，年度回款 3 亿。' }],
  projects: [], education: [{ school: '某大学', major: '市场营销' }],
};
const iDetail = ENGINE.scoreCandidate(iDeep, JD, TH, { tier: 'detail' });
check('不相干候选人深评仍 ≤ 35', iDetail.total <= 35, iDetail.total);

// 必选词零命中闸门：同职能、学历薪资城市全优，但必选词（测试用例/接口测试/Python）一个不沾——
// 不许靠 context 维凑成"看起来还行"的 70+（注意 position 不能含必选词，它参与技能文本）
const gated = ENGINE.scoreCandidate(
  { position: '软件测试工程师', degree: '博士', city: '武汉', salary: '12-15K', experienceYears: 4, age: 28, skills: ['办公软件', '沟通'], workHistory: [], education: [], projects: [] },
  JD, TH, { tier: 'card' });
check('必选词零命中 → 总分 ≤ 55（闸门生效）', gated.total <= 55 && gated.gates.length > 0, `${gated.total} gates=${JSON.stringify(gated.gates)}`);

// P1-17：证据托底不得击穿封顶
// ① 零命中的人（JD 无 title/domain/tasks + 必选词全脱靶）即使触发托底也不得超过 55
const sparseJD = {
  id: 'jd-no-domain', name: '测试工程师', title: '', basic: { degree: '本科', experienceMin: 2 },
  keywords: { required: ['后端开发', '接口测试', 'Python'], bonus: [], negative: [] },
};
const zeroHitLowText = ENGINE.scoreCandidate(
  { position: '操作员', degree: '', city: '', salary: '', experienceYears: null, age: null, skills: [], workHistory: [], education: [], projects: [] },
  sparseJD, TH, { tier: 'card' });
check('P1-17 零命中触发托底也不得超过 55（封顶）', zeroHitLowText.total <= 55,
  `${zeroHitLowText.total} gates=${JSON.stringify(zeroHitLowText.gates)}`);

// ② card 层的人即使触发托底也不得超过 CARD_MAX（85）
const CARD_MAX = 85;
const cardFloor = ENGINE.scoreCandidate(J, JD, { high: 75, low: 90 }, { tier: 'card' });
check('P1-17 card 层触发托底也不得超过 CARD_MAX(85)', cardFloor.total <= CARD_MAX,
  `${cardFloor.total} gates=${JSON.stringify(cardFloor.gates)}`);

// ③ gates 内不得出现互相矛盾的两条（同一候选人既被封顶、又被托底到更高值）
const allGateSets = rows.map((r) => r.r.gates)
  .concat([(gated && gated.gates) || [], zeroHitLowText.gates, cardFloor.gates]);
let contradictory = 0;
for (const gs of allGateSets) {
  const caps = gs.filter((g) => /封顶/.test(g)).map((g) => { const m = g.match(/封顶 (\d+)/); return m ? Number(m[1]) : Infinity; });
  const floors = gs.filter((g) => /托底/.test(g)).map((g) => { const m = g.match(/托底 (\d+)/); return m ? Number(m[1]) : -Infinity; });
  for (const fl of floors) if (caps.some((cp) => fl > cp)) contradictory++;
}
check('P1-17 gates 内无互相矛盾的两条（托底 ≤ 封顶）', contradictory === 0, `矛盾 ${contradictory} 处`);

// ── 第四档「信息不足」(unknown) 回归断言（2026-08-11）──
// 卡片层：判别性维度（keywords/positionFit/domainFit/taskCoverage）评过 <2 个 → 必须 'unknown'，
// 且优先于硬门槛 mismatch（卡片字段稀疏，越界可能只是没采全，不可据此拒人）。
// detail 层：insufficientEvidence === true → 必须 'unknown'（UI 显示「信息不足」而非被托底的 60）。
{
  // ① 卡片层：只有技能标签、无职位/公司/域信号 → 仅 keywords 可判（decisive=1）→ unknown
  const unknownCard = ENGINE.scoreCandidate(
    { skills: ['Python', 'Linux'], workHistory: [], education: [], projects: [] },
    JD, TH, { tier: 'card' });
  check('卡片层判别维度<2 → 判定「信息不足」(unknown)', unknownCard.cardVerdict === 'unknown'
    && unknownCard.cardVerdictLabel === '信息不足',
    `verdict=${unknownCard.cardVerdict}(${unknownCard.cardVerdictLabel})`);
  check('卡片层 unknown 时 insufficientEvidence 为真（是"没看清"不是"不合格"）',
    unknownCard.insufficientEvidence === true, `insuff=${unknownCard.insufficientEvidence}`);

  // ② 可核验的硬门槛优先于 unknown：卡片上学历【明示】且低于要求 → 岗位不符（不是信息不足）。
  // 依据：checkHardFilters 只有在字段真采到（c.degree 非空）时才判 mismatch——字段缺失时硬门槛
  // 根本不会触发。所以 fired 的硬门槛在卡片数据上就是可核验的拒绝依据（A1 例外条款，2026-08-11 决策）。
  const sparseMismatch = ENGINE.scoreCandidate(
    { skills: ['Python'], degree: '大专', workHistory: [], education: [], projects: [] },
    JD, TH, { tier: 'card' });
  check('卡片学历明示且越界（可核验硬门槛）→ 岗位不符(nomatch)，非信息不足',
    sparseMismatch.cardVerdict === 'nomatch' && sparseMismatch.mismatch === true,
    `verdict=${sparseMismatch.cardVerdict} mismatch=${sparseMismatch.mismatch}`);
  // ②b 真正的 Rule 2(b) 场景：卡片没采到学历（c.degree 为空）→ 硬门槛不触发，判别维度<2 → 信息不足
  const noDegreeCard = ENGINE.scoreCandidate(
    { skills: ['Python'], workHistory: [], education: [], projects: [] },
    JD, TH, { tier: 'card' });
  check('卡片未采到学历（无可核验硬门槛）→ 信息不足(unknown)，不误判为不匹配',
    noDegreeCard.cardVerdict === 'unknown' && noDegreeCard.mismatch === false,
    `verdict=${noDegreeCard.cardVerdict} mismatch=${noDegreeCard.mismatch}`);

  // ③ detail 层证据不足（文本<350字且无结构化字段）→ cardVerdict 也置 unknown（不显示误导性 60）
  const unknownDetail = ENGINE.scoreCandidate(
    { skills: [], workHistory: [{ company: '', position: '', description: '做测试相关工作' }], education: [], projects: [] },
    JD, TH, { tier: 'detail' });
  check('detail 层证据不足 → 判定「信息不足」(unknown) 而非数字 60',
    unknownDetail.cardVerdict === 'unknown' && unknownDetail.cardVerdictLabel === '信息不足',
    `verdict=${unknownDetail.cardVerdict}(${unknownDetail.cardVerdictLabel}) total=${unknownDetail.total}`);

  // ④ detail 层证据充分 → cardVerdict 为 null（用数字分）
  const fullDetail = ENGINE.scoreCandidate(
    { position: '测试工程师', skills: ['后端开发', 'Python', '测试用例'],
      workHistory: [{ company: '某车企', position: '测试工程师', description: '负责订单系统接口测试与链路验证，编写测试用例 800 条并自动化。'.repeat(3) }],
      education: [{ school: '某大学', major: '计算机科学与技术' }], projects: [] },
    JD, TH, { tier: 'detail' });
  check('detail 层证据充分 → cardVerdict 为 null（用数字分）',
    fullDetail.cardVerdict === null && fullDetail.cardVerdictLabel === null,
    `verdict=${fullDetail.cardVerdict} total=${fullDetail.total}`);
}

// P1-24：只有 weightTemplate、没有 weights 的 JD，其生效权重必须等于该模板
{
  const WTL = ENGINE.WEIGHT_TEMPLATES;
  for (const tplName of ['tech', 'functional', 'management']) {
    const tplWeights = WTL[tplName];
    if (!tplWeights) continue;
    // 模拟主进程侧和插件侧行为：把 opts.weightTemplate 透传给引擎
    const jdTplOnly = { basic: {}, keywords: { required: [], bonus: [], negative: [] }, industry: { preferred: [], excluded: [] }, weightTemplate: tplName };
    const c0 = { skills: [], workHistory: [], education: [], projects: [] };
    const r = ENGINE.scoreCandidate(c0, jdTplOnly, TH, { tier: 'card', weightTemplate: tplName });
    const kwDim = r.details.find((d) => d.dimension === 'keywords');
    const ok24 = kwDim && kwDim.weight === tplWeights.keywords;
    check('P1-24 weightTemplate=' + tplName + ' 生效权重等于模板（keywords=' + (kwDim && kwDim.weight) + '）',
      !!ok24, `期望 keywords=${tplWeights.keywords} 实际 ${kwDim && kwDim.weight}`);
  }
}

// P1-22：传入 Object.freeze 的 jd 与 c 不得抛异常、不得改写入参
try {
  const fJd = Object.freeze({
    basic: Object.freeze({ degree: '本科', experienceMin: 2 }),
    keywords: Object.freeze({ required: ['测试'], bonus: [], negative: [] }),
    industry: Object.freeze({ preferred: [], excluded: [] }),
  });
  const fC = Object.freeze({ degree: '本科', experienceYears: 4, skills: ['测试'], workHistory: [], education: [], projects: [] });
  const fr = ENGINE.scoreCandidate(fC, fJd, TH, {});
  check('P1-22 Object.freeze 的 jd/c 不抛异常', Number.isFinite(fr.total), `total=${fr.total}`);
} catch (e) {
  check('P1-22 Object.freeze 的 jd/c 不抛异常', false, e.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✓ 全部通过' : '✗ 失败 ' + failed.length + ' 项'}：${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
