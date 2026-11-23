/**
 * 评分诊断台 —— 用【真实 JD + 贴近 BOSS 推荐卡的候选人档案】跑评分引擎，
 * 把每一维的 分数/权重/是否计入 全部打出来，用来回答一个问题：
 *   "为什么真机上所有人的分都挤在 52~58、没有一个高匹配？"
 *
 * 这不是单元测试，是可复跑的标定工具：改完评分逻辑跑一次，看分布有没有拉开。
 * 用法：node scripts/score-lab.mjs
 *
 * 数据来源说明：JD 取自 2026-07-29 真机那轮的激活岗位（后端开发实习生），
 * 候选人档案按 extractCards 实际能拿到的字段构造（showWorks 可得率约 55~67%，
 * 故特意包含"有工作经历"与"卡片很稀疏"两类样本）。
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const S = require('../src/shared/scoring-universal.js');

// ── 真机激活 JD（原样，未做任何美化）──────────────────────────────────────
const JD = {
  name: '后端开发实习生',
  title: '测试实习生',
  basic: { experienceMin: 0, experienceMax: 1, degree: '大专', city: '杭州', salaryMin: 0, salaryMax: 6 },
  keywords: {
    required: ['测试', '接口'],
    bonus: ['自动化测试', '后端', '接口', '测试用例', '缺陷', 'Python', '理工'],
    negative: ['资深', '高级', '专家', '总监', '负责人', '10年'],
  },
  industry: { preferred: [], excluded: [] },
  companyTier: { prefer: [], avoid: [] },
  weights: { experience: 10, keywords: 40, degree: 10, industry: 15, companyTier: 5, salary: 5, location: 15 },
};

// ── 候选人档案样本 ────────────────────────────────────────────────────────
// 覆盖：理想人选 / 对口但没写"接口测试" / 泛测试 / 完全不相关 / 卡片稀疏（无工作经历）
const CANDIDATES = [
  {
    _label: '理想人选（后端开发在校生，资料齐）',
    name: 'A', position: '后端开发实习生', city: '杭州', degree: '本科', salary: '4-6K',
    experienceYears: 0,
    workHistory: [{ company: '某车企', industry: '汽车', position: '后端开发实习',
      description: '负责订单系统功能测试，编写测试用例，缺陷跟踪', emphasis: ['自动化测试', 'Python', '接口'] }],
    education: [{ school: '某大学', major: '车辆工程' }],
  },
  {
    _label: '强相关但从没写过"分布式"三个字',
    name: 'B', position: '软件测试实习生', city: '杭州', degree: '本科', salary: '4-6K',
    experienceYears: 0,
    workHistory: [{ company: '某供应商', industry: '互联网', position: '接口测试',
      description: '订单系统测试，编写测试用例并跟踪缺陷', emphasis: ['自动化测试', 'Python'] }],
    education: [{ school: '某大学', major: '电子信息' }],
  },
  {
    _label: '泛软件测试实习生（无后端背景）',
    name: 'C', position: '软件测试实习生', city: '杭州', degree: '本科', salary: '4-6K',
    experienceYears: 0,
    workHistory: [{ company: '某互联网', industry: '互联网', position: '测试实习',
      description: '功能测试，编写测试用例', emphasis: ['Python'] }],
    education: [{ school: '某大学', major: '计算机' }],
  },
  {
    _label: '完全不相关（前端开发）',
    name: 'D', position: '前端开发实习生', city: '杭州', degree: '本科', salary: '5-6K',
    experienceYears: 0,
    workHistory: [{ company: '某公司', industry: '互联网', position: '前端', description: '写页面', emphasis: ['Vue'] }],
    education: [{ school: '某大学', major: '软件工程' }],
  },
  {
    _label: '卡片稀疏：只有职位+城市+学历+期望薪资（真机约 45% 是这种）',
    name: 'E', position: '后端开发实习生', city: '杭州', degree: '本科', salary: '4-6K',
  },
  {
    _label: '卡片稀疏 + 岗位只写"测试"',
    name: 'F', position: '测试实习生', city: '杭州', degree: '本科', salary: '4-6K',
  },
  {
    _label: '资深（应被减分词打掉）',
    name: 'G', position: '资深测试专家', city: '杭州', degree: '本科', salary: '30-40K',
    experienceYears: 10,
    workHistory: [{ company: '某大厂', industry: '汽车', position: '资深测试专家',
      description: '负责测试体系建设', emphasis: ['自动化测试', 'Python'] }],
  },
];

// ── 真机候选池复现（2026-07-29 那轮 75 人的真实画像）────────────────────────
// 从库里解密出来的事实：75 人【全部在武汉】、【全部硕士】，职位以「测试/测试工程师」为主，
// 期望薪资从 1-3K 到 18-25K 都有，工作年限约 45% 缺失。用它验证体检能不能自己把问题说出来。
const REAL_POOL_POSITIONS = [
  '测试', '测试工程师', '测试工程师（行业）', '测试', '测试工程师', '测试工程师',
  '测试', '测试工程师', '测试', '测试工程师', '测试工程师', '测试',
  '机器学习', '互联网（行业）', '通信', 'C++', '后端开发', '数据分析师', '汽车研发/制造', '前端开发',
];
const REAL_SALARIES = ['4-6K', '10-15K', '面议', '2-3K', '5-10K', '8-10K', '3-6K', '15-30K', '1-6K', '12-13K'];
function buildRealPool() {
  const pool = [];
  for (let i = 0; i < 75; i++) {
    const c = {
      _label: '真机#' + (i + 1),
      name: 'R' + i,
      position: REAL_POOL_POSITIONS[i % REAL_POOL_POSITIONS.length],
      city: '武汉',            // ← 全部武汉，而 JD 写的是杭州
      degree: '硕士',          // ← 全部硕士
      salary: REAL_SALARIES[i % REAL_SALARIES.length],
    };
    if (i % 100 < 55) c.experienceYears = Math.round((i % 20) / 10 * 10) / 10; // 约 55% 有年限
    pool.push(c);
  }
  return pool;
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

console.log('岗位：' + JD.name + '（' + JD.title + '）');
console.log('必选词：' + JD.keywords.required.join('、') + '　加分词：' + JD.keywords.bonus.join('、'));
console.log('权重：' + JSON.stringify(JD.weights));
console.log('');

const totals = [];
for (const c of CANDIDATES) {
  const r = S.scoreCandidate(c, JD);
  totals.push({ label: c._label, total: r.total, level: r.level, coverage: r.coverage });
  console.log('─'.repeat(96));
  console.log(c._label);
  console.log('  总分 ' + r.total + '（' + r.level + '）　覆盖度 ' + r.coverage + '%'
    + (r.mismatch ? '　❌硬门槛不达标：' + r.mismatchReasons.join('/') : '')
    + (r.lowConfidence ? '　⚠低置信' : ''));
  console.log('  ' + pad('维度', 12) + pad('分数', 6) + pad('权重', 6) + pad('计入加权', 10) + '说明');
  for (const d of r.details) {
    const counted = d.notApplicable ? '否(JD未提)' : (d.available === false ? '否(无数据)' : '是');
    console.log('  ' + pad(d.label, 12) + pad(d.score, 6) + pad(d.weight, 6) + pad(counted, 10) + (d.note || ''));
  }
}

console.log('─'.repeat(96));
console.log('\n=== 分数汇总（按分排序）===');
totals.sort((a, b) => b.total - a.total);
for (const t of totals) console.log('  ' + pad(t.total, 5) + pad(t.level, 10) + pad('覆盖' + t.coverage + '%', 10) + t.label);
const spread = totals[0].total - totals[totals.length - 1].total;
console.log('\n区分度：最高 ' + totals[0].total + ' / 最低 ' + totals[totals.length - 1].total + ' / 极差 ' + spread);
console.log('高匹配(≥75) ' + totals.filter((t) => t.level === 'high').length + ' 人'
  + '　中匹配 ' + totals.filter((t) => t.level === 'medium').length + ' 人'
  + '　低匹配 ' + totals.filter((t) => t.level === 'low').length + ' 人'
  + '　不匹配 ' + totals.filter((t) => t.level === 'mismatch').length + ' 人');

// ── 真机候选池复跑 + 评分体检 ──────────────────────────────────────────────
console.log('\n' + '='.repeat(96));
console.log('真机候选池复现（75 人，全部武汉/硕士，与 2026-07-29 那轮同画像）');
const audit = S.createScoreAudit();
const realScores = [];
for (const c of buildRealPool()) {
  const r = S.scoreCandidate(c, JD);
  audit.add(r, c);
  realScores.push(r.total);
}
realScores.sort((a, b) => a - b);
console.log('  分数：最低 ' + realScores[0] + ' / 中位 ' + realScores[Math.floor(realScores.length / 2)]
  + ' / 最高 ' + realScores[realScores.length - 1] + '（真机实际：32 / 55 / 63）');
console.log('\n  ▼ 评分体检输出（这些话本该在真机那轮就打给用户看）：');
const lines = audit.report(JD);
if (!lines.length) console.log('    （无异常）');
for (const l of lines) console.log('    · ' + l);
