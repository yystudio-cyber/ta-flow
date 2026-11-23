/**
 * JD 桥离线测试台 —— 用 esbuild 打真源码 import，固化 purgeSampleDir / Origin 校验相关断言。
 *
 * 为什么不写复刻逻辑：复刻版测的是"测试作者的理解"，不是真源码——a1-origin-test.mjs
 * 就是反面教材（当时 jd-bridge 是 TS 不好直接 require，只能复刻，源码改了测试不跟）。
 * 本脚本照 risk-lab.mjs 的模式，用 esbuild 出一个临时 mjs 后真 import。
 *
 * 覆盖：
 *   1) purgeSampleDir 按文件数清理（250→200，删最旧 50 份）
 *   2) purgeSampleDir 按总大小清理（30 大文件 >50MB，删到阈值内）
 *   3) purgeSampleDir 只清 page-structure-<digits>.json，不碰其它文件
 *   4) purgeSampleDir 失败静默（目录不存在/权限错误不抛）
 *
 * 用法：node scripts/jd-bridge-lab.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 桩：jd-bridge.ts 依赖的 ../db（getDb/getSetting）和 ../../shared/constants ─
// purgeSampleDir 本身不碰 db，但整个 jd-bridge.ts 模块 import 了它们，必须能加载。
//
// 六、链路断言要真的读一行"库里的 JD"，所以 DB 桩做成可注入的：
// 测试先 __setJdRows([...])，再调真 buildPayload()，验证 domain/tasks 一路不丢。
const DB_STUB = `
let ROWS = [];
export function __setJdRows(rows) { ROWS = rows; }
export function getDb() {
  return {
    prepare: (sql) => ({
      all: () => (/FROM jds/i.test(sql) ? ROWS : []),
      get: () => (/FROM jds/i.test(sql) ? ROWS.find((r) => r.active === 1) : undefined),
      run: () => ({ changes: 0 }),
    }),
  };
}
export function getSetting(_k, d) { return d; }
`;
const CONSTANTS_STUB = `
export const DEFAULT_SETTINGS = { matchScore: { defaultWeights: null, highThreshold: 75, lowThreshold: 60 } };
`;
const TYPES_STUB = `// types only — esbuild strips type imports`;

const stubPlugin = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /\/db$/ }, () => ({ path: 'db', namespace: 'stub' }));
    b.onResolve({ filter: /\/constants$/ }, () => ({ path: 'constants', namespace: 'stub' }));
    b.onResolve({ filter: /\/types$/ }, () => ({ path: 'types', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: a.path === 'db' ? DB_STUB : a.path === 'constants' ? CONSTANTS_STUB : TYPES_STUB,
      loader: 'ts',
    }));
  },
};

const outFile = path.join(os.tmpdir(), `ta-jd-bridge-lab-${Date.now()}.mjs`);
await build({
  stdin: {
    contents: `
      export { purgeSampleDir, buildPayload, MAX_SAMPLE_FILES, MAX_SAMPLE_DIR_MB } from '${path.join(ROOT, 'src/main/services/jd-bridge.ts').replace(/\\/g, '/')}';
      export { __setJdRows } from '../db';
    `,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: outFile, plugins: [stubPlugin], logLevel: 'error',
});

const M = await import(pathToFileURL(outFile).href);

// ── 断言框架（同 risk-lab.mjs）────────────────────────────────────────────
let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, `${a} vs 期望 ${b}`); }

// ── 工具：造临时目录、造文件、列文件 ───────────────────────────────────────
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ta-jd-bridge-lab-'));
}
function listSamples(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^page-structure-\d+\.json$/.test(f))
    .map((f) => {
      const ts = parseInt(f.replace('page-structure-', '').replace('.json', ''), 10);
      const size = fs.statSync(path.join(dir, f)).size;
      return { f, ts, size };
    })
    .sort((a, b) => a.ts - b.ts);
}
function writeSample(dir, ts, body) {
  fs.writeFileSync(path.join(dir, `page-structure-${ts}.json`), body);
}

try {

  console.log(`\n=== 一、purgeSampleDir 按文件数清理（上限 ${M.MAX_SAMPLE_FILES} 份）===`);
  {
    const dir = makeTmpDir();
    // 造 250 个文件，每个 100 字节（远小于 50MB）
    const body = JSON.stringify({ test: 'x'.repeat(80) });
    const startTs = 1_700_000_000_000;
    for (let i = 0; i < 250; i++) writeSample(dir, startTs + i * 1000, body);
    eq(listSamples(dir).length, 250, '造 250 份文件');

    M.purgeSampleDir(dir);

    const after = listSamples(dir);
    eq(after.length, M.MAX_SAMPLE_FILES, `清理后剩 ${M.MAX_SAMPLE_FILES} 份（200）`);
    // 被删的是时间戳最小的 50 份
    const deletedStart = startTs;
    const deletedEnd = startTs + 49 * 1000;
    const remainStart = startTs + 50 * 1000;
    for (const { ts } of after) {
      ok(ts >= remainStart, '剩余文件时间戳都 ≥ 第 51 份（最旧的 50 份被删）',
        `最小 ts=${ts}, 期望 ≥${remainStart}`);
      break; // 只检最小值即可
    }
    const minAfter = after[0].ts;
    ok(minAfter === remainStart, `剩余最早一份 ts = ${remainStart}（即第 51 份）`, `实际 ${minAfter}`);
    const maxAfter = after[after.length - 1].ts;
    ok(maxAfter === startTs + 249 * 1000, `剩余最新一份仍是最后一份`, `实际 ${maxAfter}`);
    // 被删文件确实不在
    for (let i = 0; i < 50; i++) {
      const p = path.join(dir, `page-structure-${startTs + i * 1000}.json`);
      ok(!fs.existsSync(p), `第 ${i + 1} 旧文件已删除`, `ts=${startTs + i * 1000}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n=== 二、purgeSampleDir 按总大小清理（上限 ${M.MAX_SAMPLE_DIR_MB}MB，文件数未超 200）==='.replace('${M.MAX_SAMPLE_DIR_MB}', M.MAX_SAMPLE_DIR_MB));
  {
    const dir = makeTmpDir();
    // 造 30 个大文件，每个约 3MB（共 90MB，超 50MB；文件数 30 远未达 200）
    // 注意：时间戳递增，最旧的先被删
    const bigBody = 'x'.repeat(3 * 1024 * 1024); // 3MB
    const startTs = 1_700_001_000_000;
    for (let i = 0; i < 30; i++) writeSample(dir, startTs + i * 1000, bigBody);
    const before = listSamples(dir);
    eq(before.length, 30, '造 30 份大文件（约 90MB，超 50MB 上限）');
    const beforeBytes = before.reduce((s, f) => s + f.size, 0);
    ok(beforeBytes > 50 * 1024 * 1024, '清理前总大小 > 50MB', `${(beforeBytes / 1024 / 1024).toFixed(1)}MB`);

    M.purgeSampleDir(dir);

    const after = listSamples(dir);
    const afterBytes = after.reduce((s, f) => s + f.size, 0);
    ok(afterBytes <= 50 * 1024 * 1024, '清理后总大小 ≤ 50MB', `${(afterBytes / 1024 / 1024).toFixed(1)}MB`);
    ok(after.length < 30, `至少删了一部分文件（剩余 ${after.length} 份，原本 30 份）`);
    // 删的是最旧的
    const minAfterTs = after[0].ts;
    ok(minAfterTs > startTs, '最旧的文件被优先删掉', `剩余最早 ts=${minAfterTs}, 最旧 ts=${startTs}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n=== 三、purgeSampleDir 只清 page-structure-<digits>.json，不碰其它文件 ===');
  {
    const dir = makeTmpDir();
    const body = JSON.stringify({ test: 'y'.repeat(80) });
    // 造 210 份合法采样文件（触发清理）
    const startTs = 1_700_002_000_000;
    for (let i = 0; i < 210; i++) writeSample(dir, startTs + i * 1000, body);
    // 造几个干扰文件
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ note: 'i am other' }));
    fs.writeFileSync(path.join(dir, 'page-structure-abc.json'), JSON.stringify({ bad: 'ts not digits' }));
    fs.writeFileSync(path.join(dir, 'page-structure-123.json.bak'), 'backup');
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'hi');
    const otherBefore = fs.readdirSync(dir).filter((f) => !/^page-structure-\d+\.json$/.test(f)).sort();
    eq(otherBefore.length, 5, '干扰文件 5 个（other.json / page-structure-abc.json / .bak / .DS_Store / readme.txt）');

    M.purgeSampleDir(dir);

    const after = listSamples(dir);
    eq(after.length, M.MAX_SAMPLE_FILES, `采样文件清理到 ${M.MAX_SAMPLE_FILES} 份`);
    // 干扰文件全部保留
    const otherAfter = fs.readdirSync(dir).filter((f) => !/^page-structure-\d+\.json$/.test(f)).sort();
    eq(otherAfter.length, otherBefore.length, `干扰文件数量不变（${otherBefore.length}）`);
    for (const f of otherBefore) {
      ok(fs.existsSync(path.join(dir, f)), `干扰文件保留：${f}`);
    }
    // page-structure-abc.json（非纯数字）不该被删
    ok(fs.existsSync(path.join(dir, 'page-structure-abc.json')),
      'page-structure-abc.json（ts 非数字）保留');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n=== 四、purgeSampleDir 失败静默（目录不存在/权限错误不抛）===');
  {
    let threw = false;
    try { M.purgeSampleDir(path.join(os.tmpdir(), 'definitely-not-exist-xyz-12345')); }
    catch (e) { threw = true; }
    ok(!threw, '不存在的目录不抛异常');

    // 传 null / undefined 也不能抛（源码里 try/catch 兜住）
    for (const bad of [null, undefined, '']) {
      let threw2 = false;
      try { M.purgeSampleDir(bad); } catch (e) { threw2 = true; }
      ok(!threw2, `参数 ${JSON.stringify(bad)} 不抛异常`);
    }
  }

  console.log('\n=== 五、容量常量 contract 校验（从源码 import 的就是真实值）===');
  eq(M.MAX_SAMPLE_FILES, 200, 'MAX_SAMPLE_FILES = 200');
  eq(M.MAX_SAMPLE_DIR_MB, 50, 'MAX_SAMPLE_DIR_MB = 50');

  // ────────────────────────────────────────────────────────────────────────
  // 六、评分链路承载断言（2026-08-03 起替代 score-eval 的 KNOWN-RED 白名单）
  //
  // 背景：v4 引擎的 domainFit(20%) + taskCoverage(20%) 消费 jd.domain / jd.tasks。
  // 这两个字段以前在【类型/UI/落库/下桥】四处都不存在，于是生产环境这 40% 权重恒为
  // "JD未设"，实测把人工 80 的人排在 60 的人后面。当时用 KNOWN-RED 白名单标红。
  //
  // 现在链路已打通，红账的正确替代品不是"把 PROD 态设成硬门槛"（那道题的难点在引擎，
  // 不在链路），而是这一条：**只要 JD 里配了域与任务点，它就必须原样到达插件**。
  // 这一条守住，"平台算得到、插件算不到"这类静默分叉才不会重现。
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n=== 六、JD 域/任务点必须完整下桥（链路承载断言）===');
  {
    const richJd = {
      id: 'jd-chain-1', name: '支付风控', title: '支付风控算法工程师', active: true,
      basic: { experienceMin: 3, experienceMax: 8, degree: '本科', city: '杭州', ageMin: 25, ageMax: 40, responsibilities: ['职责一', '职责二'] },
      keywords: { required: ['BEV'], bonus: [], negative: [] },
      industry: { preferred: [], excluded: [] },
      domain: {
        industry: '互联网金融', platform: '服务端', viewpoint: '自车',
        scenes: ['在线交易', '核心链路'], sensors: ['实时数据', '风控规则'],
        adjacent: ['支付风控'], distant: ['推荐排序', '安防监控'],
      },
      tasks: [
        { key: 'risk-engine', label: '支付风控规则引擎', weight: 3, domainSensitive: true, keywords: ['风控', '规则引擎'] },
        { key: 'embedded', label: '嵌入式部署', weight: 2, domainSensitive: false, keywords: ['TensorRT', '量化'] },
      ],
      hardFlags: { degree: true, age: false },
      weights: { positionFit: 12, domainFit: 20, taskCoverage: 20, keywords: 16 },
    };
    // 模拟真实落库形态：data 列是整份 JD 的 JSON 字符串
    M.__setJdRows([{ id: richJd.id, name: richJd.name, data: JSON.stringify(richJd), active: 1 }]);

    const payload = M.buildPayload();

    ok(!!payload.jd, 'buildPayload 取到了激活 JD');
    // 激活 JD 分支
    ok(!!payload.jd.domain, '激活 JD 带 domain');
    eq(payload.jd.domain.platform, '服务端', 'domain.platform 原样下发');
    eq(payload.jd.domain.viewpoint, '自车', 'domain.viewpoint 原样下发');
    eq((payload.jd.domain.scenes || []).join(','), '在线交易,核心链路', 'domain.scenes 原样下发');
    eq((payload.jd.domain.sensors || []).join(','), '实时数据,风控规则', 'domain.sensors 原样下发');
    eq((payload.jd.domain.adjacent || []).join(','), '支付风控', 'domain.adjacent 原样下发');
    eq((payload.jd.domain.distant || []).join(','), '推荐排序,安防监控', 'domain.distant 原样下发');
    eq((payload.jd.tasks || []).length, 2, 'tasks 条数一致');
    eq(payload.jd.tasks[0].label, '支付风控规则引擎', 'task.label 原样下发');
    eq(payload.jd.tasks[0].domainSensitive, true, 'task.domainSensitive=true 原样下发');
    eq(payload.jd.tasks[1].domainSensitive, false, 'task.domainSensitive=false 原样下发（不能被真值化）');
    eq((payload.jd.tasks[0].keywords || []).join(','), '风控,规则引擎', 'task.keywords 原样下发');
    eq(payload.jd.tasks[0].weight, 3, 'task.weight 原样下发');
    // 硬门槛与年龄区间同样要过桥（插件侧硬门槛判定依赖它们）
    ok(!!payload.jd.hardFlags, 'hardFlags 下发');
    eq(payload.jd.hardFlags.degree, true, 'hardFlags.degree 原样下发');
    eq(payload.jd.basic.ageMin, 25, 'basic.ageMin 下发');
    eq(payload.jd.basic.ageMax, 40, 'basic.ageMax 下发');
    eq((payload.jd.basic.responsibilities || []).join('|'), '职责一|职责二', 'basic.responsibilities 下发（引擎归一化后参与项目经验维）');

    // jdList 分支：插件切岗位后直接拿列表项当 JD 打分，缺字段就是"照样出分但分是假的"
    const inList = (payload.jdList || []).find((j) => j.id === 'jd-chain-1');
    ok(!!inList, 'jdList 里能找到该岗位');
    ok(!!inList.domain, 'jdList 项带 domain（切岗位后仍能算域匹配）');
    eq((inList.tasks || []).length, 2, 'jdList 项带完整 tasks');
    eq(inList.domain.industry, '互联网金融', 'jdList 项 domain.industry 原样');

    // 未配域/任务点的 JD：必须如实为空，不能被桥"补"成空壳对象假装配过
    const leanJd = { id: 'jd-lean', name: '精简岗', title: '精简岗', active: false,
      basic: { experienceMin: 1, experienceMax: 3, degree: '本科', city: '杭州' },
      keywords: { required: [], bonus: [], negative: [] }, industry: { preferred: [], excluded: [] } };
    M.__setJdRows([
      { id: richJd.id, name: richJd.name, data: JSON.stringify(richJd), active: 1 },
      { id: leanJd.id, name: leanJd.name, data: JSON.stringify(leanJd), active: 0 },
    ]);
    const p2 = M.buildPayload();
    const leanInList = (p2.jdList || []).find((j) => j.id === 'jd-lean');
    ok(!!leanInList, 'jdList 里能找到未配域的岗位');
    ok(!leanInList.domain, '未配域的 JD 下发时 domain 仍为空（引擎据此走 notApplicable 退出加权）');
    ok(!leanInList.tasks || !leanInList.tasks.length, '未配任务点的 JD 下发时 tasks 仍为空');

    M.__setJdRows([]);
  }

} finally {
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }
}

console.log('');
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log(`✓ 全部通过：${pass}/${pass}`);
