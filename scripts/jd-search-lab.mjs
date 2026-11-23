/**
 * buildSearchFromJd 纯函数小测（scope A：JD 结构化字段 → SearchConfig 映射断言）。
 *
 * 验证 RPA 改按激活 JD 自主找人的「搜的岗位 = 评的岗位」核心映射：
 *   必备词 → keywordGroups/keywords、城市 → cities、经验 → experience（反查 EXPERIENCE_RANGES）、
 *   学历 → degree（透传）；空字段一律「不限」，绝不硬塞。
 *   ★ 行业(jd.industry.preferred)【恒不进搜索】：它是岗位领域行业词，非猎聘「当前行业」筛选框
 *     合法选项，带进 strict 筛选会点不到 → FILTER_FAILED_STRICT 整组作废。行业精度交评分引擎
 *     domainFit/industry 维度。故即便 preferred 有值，派生 SearchConfig.industries 也恒为 []。
 *
 * 纯函数、零 DOM/CDP/DB 依赖——确定性断言，不放宽任何风控/评分断言。
 * 用法：node scripts/jd-search-lab.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const outFile = path.join(os.tmpdir(), 'ta-jd-search-lab.mjs');
await build({
  stdin: {
    contents: `export { buildSearchFromJd } from '${path.join(ROOT, 'src/shared/utils.ts').replace(/\\/g, '/')}';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: outFile, logLevel: 'error',
});
const { buildSearchFromJd } = await import(pathToFileURL(outFile).href);

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}
function mkJd(over = {}) {
  return {
    id: 'j1', name: '测试岗位', title: '测试', active: true,
    basic: { experienceMin: 3, experienceMax: 5, degree: '本科', city: '杭州', ...over.basic },
    keywords: { required: ['嵌入式', 'Linux'], bonus: ['RTOS'], negative: [], ...over.keywords },
    industry: { preferred: ['汽车'], excluded: [], ...over.industry },
    createdAt: 0, updatedAt: 0,
    ...over,
  };
}

console.log('\n> buildSearchFromJd 映射断言');

// 1. 完整 JD：全字段正确映射（strictFilters:true 对齐 makeDefaultTask 严格性）
//    ★ industries 恒为 []：JD 虽带 industry.preferred=['汽车']，但不进平台筛选（交评分引擎）
eq(buildSearchFromJd(mkJd()), {
  keywords: '嵌入式 Linux',
  city: '杭州', experience: '3-5年', degree: '本科', salary: '',
  keywordGroups: ['嵌入式', 'Linux'], cities: ['杭州'], industries: [],
  strictFilters: true,
}, '完整 JD：必备词/城市/经验3-5/本科/industries空/strictFilters 全映射');

// 2. 城市「全国」→ 不限
eq(buildSearchFromJd(mkJd({ basic: { city: '全国' } })).cities, [], '城市=全国 → cities 空');
eq(buildSearchFromJd(mkJd({ basic: { city: '全国' } })).city, '不限', '城市=全国 → city 不限');
// 2b. 城市「不限」
eq(buildSearchFromJd(mkJd({ basic: { city: '不限' } })).cities, [], '城市=不限 → cities 空');

// 3. 经验区间不精确(2-6)→ 不硬塞，留空
eq(buildSearchFromJd(mkJd({ basic: { experienceMin: 2, experienceMax: 6 } })).experience, '不限',
  '经验 2-6 无精确档 → 不硬塞，留空');

// 4. 学历空 / 不限 → 不限
eq(buildSearchFromJd(mkJd({ basic: { degree: '' } })).degree, '不限', '学历空 → 不限');
eq(buildSearchFromJd(mkJd({ basic: { degree: '不限' } })).degree, '不限', '学历=不限 → 不限');
// 4b. 学历硕士透传
eq(buildSearchFromJd(mkJd({ basic: { degree: '硕士' } })).degree, '硕士', '学历硕士 → 透传');

// 5. 必备词空 → keywordGroups/keywords 空
const noKw = buildSearchFromJd(mkJd({ keywords: { required: [], bonus: [], negative: [] } }));
eq(noKw.keywordGroups, [], 'required 空 → keywordGroups 空');
eq(noKw.keywords, '', 'required 空 → keywords 空');

// 6. ★ 行业不进搜索：即便 jd.industry.preferred 有值，派生 SearchConfig.industries 也恒为 []。
//    根因：这些是岗位领域行业词(汽车电子/智能网联/汽车)，非猎聘「当前行业」筛选框合法选项，
//    带进 strict 筛选会点不到 → FILTER_FAILED_STRICT 整组作废。行业精度交评分引擎 domainFit 维度。
eq(buildSearchFromJd(mkJd({ industry: { preferred: ['汽车', '互联网', '智能网联'], excluded: [] } })).industries,
  [], 'industry.preferred 有值 → industries 仍恒空（不进平台筛选）');
eq(buildSearchFromJd(mkJd({ industry: { preferred: [], excluded: [] } })).industries, [], 'industry.preferred 空 → industries 空');

// 7. 经验 10年以上([10,50])→ '10年以上'
eq(buildSearchFromJd(mkJd({ basic: { experienceMin: 10, experienceMax: 50 } })).experience, '10年以上',
  '经验 [10,50] → 10年以上');
// 8. 经验 1-3年([1,3])→ '1-3年'
eq(buildSearchFromJd(mkJd({ basic: { experienceMin: 1, experienceMax: 3 } })).experience, '1-3年',
  '经验 [1,3] → 1-3年');
// 8b. 经验 5-10年([5,10])→ '5-10年'
eq(buildSearchFromJd(mkJd({ basic: { experienceMin: 5, experienceMax: 10 } })).experience, '5-10年',
  '经验 [5,10] → 5-10年');

// 9. 多必备词 → keywordGroups 逐词保留
eq(buildSearchFromJd(mkjJdMulti()).keywordGroups, ['嵌入式', '驱动', 'Linux'], '多必备词 → keywordGroups 逐词保留');

// 10. strictFilters 恒为 true（对齐 makeDefaultTask 默认严格性，不被空字段覆盖）
eq(buildSearchFromJd(mkJd()).strictFilters, true, 'strictFilters 恒 true（不放宽筛选）');
eq(buildSearchFromJd(mkJd({ keywords: { required: [], bonus: [], negative: [] } })).strictFilters, true,
  'required 空 → strictFilters 仍 true');
function mkjJdMulti() {
  return mkJd({ keywords: { required: ['嵌入式', '驱动', 'Linux'], bonus: [], negative: [] } });
}

console.log(`\n结果：${pass} 通过, ${fail} 失败`);
if (fail > 0) { console.error('✗ jd-search-lab 失败'); process.exit(1); }
console.log('✓ jd-search-lab 全绿');
