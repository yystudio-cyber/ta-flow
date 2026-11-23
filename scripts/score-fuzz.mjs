/**
 * P1-21：评分引擎畸形输入模糊测试。
 *
 * 引擎归一化必须健壮：任何类型错位（null/标量顶替数组、字符串顶替数组、
 * 数组元素为 null/标量、research 数值字段为字符串）都不得抛异常、不得产出 NaN。
 *
 * 断言：全部组合下 scoreCandidate 返回有限 total。
 * 用法：npm run score:fuzz（已接入 npm test 链，见 run-all-tests.mjs）。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ENGINE = require('../src/shared/scoring-universal.js');

const TH = { high: 75, low: 60 };
const GOOD_JD = {
  basic: { degree: '本科', experienceMin: 2, experienceMax: 6, city: '武汉' },
  keywords: { required: ['测试', 'CAN'], bonus: ['Python'], negative: ['外包'] },
  industry: { preferred: ['汽车'], excluded: ['房地产'] },
  tasks: [{ label: '测试', weight: 1 }],
  domain: { industry: ['互联网'], platform: ['服务端'] },
};

// 畸形候选人的类型错位组合
const BAD_CANDIDATES = [
  null,
  undefined,
  'a-string',
  42,
  {},
  { skills: '测试' },                                    // 字符串顶替数组
  { skills: 5 },
  { workHistory: [null, { company: 'x' }] },             // 数组含 null 元素
  { workHistory: 'text' },
  { projects: [null, { name: 'p' }] },
  { projects: [123, 'x'] },
  { education: [null, 5] },
  { education: { school: 'x' } },
  { research: { papers: 'x', topPapers: 'y', patents: 'z' } },  // 数值字段为字符串
  { research: { papers: 'x' } },
  { research: null },
  { research: 'note' },
  { skills: [], workHistory: [{ company: null, position: null }] },
  { age: 'abc', experienceYears: '3', salary: { min: 'x' } },
  Object.freeze({ degree: '本科', skills: Object.freeze(['测试']), workHistory: Object.freeze([]) }),
];

// 畸形 JD 的类型错位组合
const BAD_JDS = [
  null,
  undefined,
  'a-string',
  42,
  {},
  { keywords: 5 },                                        // 标量顶替 keywords
  { keywords: 'text' },
  { keywords: { required: 5, bonus: 6, negative: 7 } },  // 标量顶替词表数组
  { industry: 3 },
  { industry: { preferred: 1 } },
  { tasks: [null, { label: 't', weight: 1 }] },          // tasks 含 null
  { tasks: 'text' },
  { basic: { degree: 5, experienceMin: 'x' } },
  Object.freeze({ basic: Object.freeze({}), keywords: Object.freeze({ required: ['测试'], bonus: [], negative: [] }), industry: Object.freeze({}), tasks: Object.freeze([]) }),
];

let cases = 0;
let threw = 0;
let nan = 0;
const errors = [];
for (let i = 0; i < BAD_CANDIDATES.length; i++) {
  for (let j = 0; j < BAD_JDS.length; j++) {
    cases++;
    try {
      const r = ENGINE.scoreCandidate(BAD_CANDIDATES[i], BAD_JDS[j], TH, {});
      if (!Number.isFinite(r.total)) {
        nan++;
        errors.push(`NaN: c[${i}] jd[${j}]`);
      }
    } catch (e) {
      threw++;
      errors.push(`THROW: c[${i}] jd[${j}] → ${e && e.message}`);
    }
  }
}

// 交叉：好 JD × 坏候选人、坏 JD × 好候选人 已含在上面；再补好 JD × 好候选人基准
cases++;
const base = ENGINE.scoreCandidate(
  { degree: '本科', experienceYears: 4, skills: ['测试'], workHistory: [{ company: 'x', description: 'y'.repeat(30) }], education: [], projects: [] },
  GOOD_JD, TH, { tier: 'detail' },
);
if (!Number.isFinite(base.total)) { nan++; errors.push('NaN: base case'); }

console.log(`模糊组合 ${cases} 例，抛异常 ${threw}，产出 NaN ${nan}`);
for (const e of errors.slice(0, 20)) console.log('  ✗ ' + e);
const ok = threw === 0 && nan === 0;
console.log(ok ? '✓ 全部畸形输入不抛异常、不产出 NaN' : '✗ 存在缺陷');
process.exit(ok ? 0 : 1);
