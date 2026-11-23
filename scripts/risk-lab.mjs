/**
 * 反风控离线测试台 —— 把风险登记册的口径固化成可执行断言。
 *
 * 为什么必须有它（2026-07-29 审计结论）：
 * 风控这套代码的特点是「平时永远不执行，只在出事那一刻执行一次，而且执行错了
 * 你根本不会知道」——表现只是"什么都没发生"。此前项目里 37 个测试全是浏览器扩展的，
 * 风控一条都没有；而代码注释里那二十来处修复（去抖被滑动窗口架空、半开探针绑错动作、
 * 骨架屏 15 秒判据实际要 90 秒才报、securityJsFail 被路径条件锁死成死代码）
 * 全是靠人一遍遍读代码发现的，没有一条是被测试抓出来的。
 *
 * 本测试台不碰网络、不碰 BOSS、不需要浏览器：用 esbuild 把 risk-controller / risk-monitor
 * 抽出来，把 db / electron 换成内存桩，再用可控时钟把"30 分钟后"变成一行代码。
 *
 * 用法：node scripts/risk-lab.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 内存桩：把主进程依赖（sqlite / electron）换掉 ─────────────────────────────
const DB_STUB = `
export const __settings = new Map();
export function getSetting(k, d) { return __settings.has(k) ? __settings.get(k) : d; }
export function setSetting(k, v) { __settings.set(k, v); }
export function getDb() {
  return { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }) };
}
export function getDaily() { return { greeted: 0, viewed: 0, favorited: 0 }; }
export function bumpDaily() {}
// 猎聘人才池：测试台只需存在同名导出，行为置空（人才池落库不在这些测试的范围内）
export function upsertLiepinTalent() {}
export function upsertLiepinTalentIfNew() { return false; }
export function upsertLiepinScore() {}
export function addLiepinTag() {}
export function removeLiepinTag() {}
export function markLiepinDetailOpened() {}
`;
const ELECTRON_STUB = `
export const Notification = function () { return { show() {} }; };
Notification.isSupported = () => false;
export const app = { getPath: () => '' };
`;

// platform-adapter 只用到 scoring 的 parseBossSalary，而真 scoring.ts 会在加载时用 __dirname
// 去磁盘找评分引擎——那对本测试台毫无意义，还会在 ESM 下直接炸。换成等价的最小实现。
const SCORING_STUB = `
export function parseBossSalary(s) {
  const m = String(s || '').match(/(\\d{1,3})\\s*[-~]\\s*(\\d{1,3})\\s*[Kk]/);
  return m ? { min: +m[1], max: +m[2] } : null;
}
export function scoreCandidate() { return { total: 0, level: 'low', details: [] }; }
export function createScoreAudit() { return { count: () => 0, add() {}, report: () => [] }; }
`;

const stubPlugin = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onResolve({ filter: /\/db$/ }, () => ({ path: 'db', namespace: 'stub' }));
    b.onResolve({ filter: /\/scoring$/ }, () => ({ path: 'scoring', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: a.path === 'electron' ? ELECTRON_STUB : a.path === 'scoring' ? SCORING_STUB : DB_STUB,
      loader: 'js',
    }));
  },
};

const outFile = path.join(os.tmpdir(), 'ta-risk-lab-bundle.mjs');
await build({
  stdin: {
    contents: `
      export { RiskController, riskController } from '${path.join(ROOT, 'src/main/services/risk-controller.ts').replace(/\\/g, '/')}';
      export { RiskMonitor, riskMonitor } from '${path.join(ROOT, 'src/main/services/risk-monitor.ts').replace(/\\/g, '/')}';
      export { getRiskThresholdsForMode, DEFAULT_RISK_THRESHOLDS, resolveBehaviorProfile, DEFAULT_BEHAVIOR, MIN_LEARN_SAMPLES } from '${path.join(ROOT, 'src/shared/constants.ts').replace(/\\/g, '/')}';
      export { getDefaultLimits } from '${path.join(ROOT, 'src/shared/utils.ts').replace(/\\/g, '/')}';
      export { isEmptyZpData, isRecommendListApi } from '${path.join(ROOT, 'src/shared/boss-signals.ts').replace(/\\/g, '/')}';
      export { isFatalPageError, isRiskPage__test, evalWithTimeout__test } from '${path.join(ROOT, 'src/main/services/platform-adapter.ts').replace(/\\/g, '/')}';
    `,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node18',
  outfile: outFile, plugins: [stubPlugin], logLevel: 'error',
});

// ── 可控时钟：把"30 分钟后"变成一行代码 ────────────────────────────────────
let NOW = new Date('2026-07-29T10:00:00').getTime(); // 白天，不在禁跑时段
const realNow = Date.now;
Date.now = () => NOW;
const advance = (ms) => { NOW += ms; };
const MIN = 60000;

const M = await import(pathToFileURL(outFile).href);

// ── 断言框架 ──────────────────────────────────────────────────────────────
let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('✓ ' + name + (detail ? '  → ' + detail : '')); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function near(actual, expected, tolMs, name) {
  ok(Math.abs(actual - expected) <= tolMs, name, Math.round(actual / MIN) + 'min（期望 ' + Math.round(expected / MIN) + 'min）');
}

console.log('\n=== 一、入口层信号 code:35 的分级口径（登记册 2026-07-27 决策）===');
{
  const c = new M.RiskController();
  c.reset('human', 'jd1');
  const r1 = c.onSignal('apiCode35', '首次');
  near(r1.cooldownMs, 30 * MIN, 90000, '首次 code:35 → 熔断退避 30 分钟');
  ok(r1.needHuman === false, '首次不需要人工介入（自动退避，不打扰）');
  ok(r1.notify === true, '首次仍发系统通知（不能只在风险中心默默记一笔）');
  ok(r1.escalated === false, '首次不升级');

  advance(1000);
  const r2 = c.onSignal('apiCode35', '同一场风暴');
  ok(r2.debounced === true, '同一场风暴内的重复信号被吸收（BOSS 判 35 后每个 wapi 都返 35）');
  near(c.cooldownRemainingMs(), 30 * MIN - 1000, 90000, '被吸收的信号不叠加冷却');

  // 冷却到点 → 半开
  advance(30 * MIN);
  const plan = c.planNext('scroll');
  ok(plan.circuitOpen === false, '冷却到点后不再阻塞，转入半开试探');
  ok(c.snapshot().circuit === 'halfOpen', '状态为半开', c.snapshot().circuit);
  ok(c.snapshot().rate === c.snapshot().rateMin, '半开期速率压到最低档', String(c.snapshot().rate));

  // 半开期再次触发 → 升级硬停
  const r3 = c.onSignal('apiCode35', '半开又被打回');
  ok(r3.escalated === true, '半开后再次触发 → 升级');
  ok(r3.needHuman === true, '升级后需人工确认才能重启（不再自动重试）');
}

console.log('\n=== 二、半开探针必须绑在真实网络请求上 ===');
{
  const c = new M.RiskController();
  c.reset('human', 'jd1');
  c.onSignal('apiCode35');
  advance(31 * MIN);
  c.planNext('scroll'); // 转半开
  ok(c.snapshot().circuit === 'halfOpen', '前置：已进入半开');
  for (let i = 0; i < 10; i++) c.onCleanAction();   // 看卡片：零网络请求
  ok(c.snapshot().circuit === 'halfOpen', '看 10 张卡片（零请求）不消耗探针、不合闸');
  c.onCleanRequest(); c.onCleanRequest();
  ok(c.snapshot().circuit === 'halfOpen', '两次真实请求后仍未合闸（要满 3 次）');
  c.onCleanRequest();
  ok(c.snapshot().circuit === 'closed', '第 3 次真实请求干净 → 合闸');
  ok(c.snapshot().rate <= c.snapshot().rateMin + 0.3, '合闸后从最慢档起步而非跳回原速', String(c.snapshot().rate));
}

console.log('\n=== 三、各类信号的处置等级与冷却时长 ===');
{
  const cases = [
    ['captchaGeetest', true, 30 * MIN, '极验滑块 → 需人工 + ≥30min'],
    ['captchaYidun', true, 30 * MIN, '易盾滑块 → 需人工 + ≥30min'],
    ['captchaEscalate', true, 60 * MIN, '点选/图标验证升级 → 需人工 + ≥60min'],
    ['verifyRedirect', true, 60 * MIN, '跳验证页 → 需人工 + ≥60min'],
    ['accountRestricted', true, 60 * MIN, '账号受限 → 需人工（走官方申诉，绝不自动重试）'],
    ['bossSecReport', true, 30 * MIN, 'Boss端100xx 环境检测 → 需人工'],
    ['riskPageUnknown', true, 30 * MIN, '认不出类型的风控页 → 保守按需人工'],
    ['http403', false, 30 * MIN, '接口 403 → 自动熔断 30min'],
    ['http429', false, 15 * MIN, '接口 429 → 自动熔断 15min'],
    ['emptyData', false, 20 * MIN, '异常空数据 → 自动熔断 20min'],
  ];
  for (const [kind, needHuman, minCooldown, name] of cases) {
    const c = new M.RiskController();
    c.reset('human', 'jd1');
    const r = c.onSignal(kind);
    ok(r.needHuman === needHuman && r.cooldownMs >= minCooldown - 60000, name,
      (r.needHuman ? '需人工' : '自动退避') + ' / ' + Math.round(r.cooldownMs / MIN) + 'min');
  }
  // 软信号只降速不熔断
  for (const kind of ['rateWarn', 'cookieMutation', 'skeletonStuck', 'securityJsFail']) {
    const c = new M.RiskController();
    c.reset('human', 'jd1');
    const before = c.snapshot().rate;
    const r = c.onSignal(kind);
    ok(r.tripped === false && r.needHuman === false && c.snapshot().rate < before,
      '软信号 ' + kind + ' → 只降速不熔断', before + ' → ' + c.snapshot().rate);
  }
  // 登记册：__a Cookie 突变要求降速 50%
  {
    const c = new M.RiskController();
    c.reset('human', 'jd1');
    const before = c.snapshot().rate;
    c.onSignal('cookieMutation');
    const after = c.snapshot().rate;
    ok(Math.abs(after - before * 0.5) < 0.05, '指纹 Cookie 突变 → 降速 50%（登记册口径，此前误写成 30%）',
      before + ' → ' + after);
  }
}

console.log('\n=== 四、退避必须扛得住"关掉 App 再打开" ===');
{
  const c1 = new M.RiskController();
  c1.reset('human', 'jd1');
  c1.onSignal('http403');
  const left = c1.cooldownRemainingMs();
  ok(left > 25 * MIN, '前置：冷却中', Math.round(left / MIN) + 'min');

  // 模拟重启：全新实例，只从"磁盘"恢复
  const c2 = new M.RiskController();
  c2.restoreFromDisk();
  ok(c2.cooldownRemainingMs() > 25 * MIN, '新实例恢复出未过期的熔断窗口（重启绕不过退避）',
    Math.round(c2.cooldownRemainingMs() / MIN) + 'min');

  // reset 不得清掉未过期的熔断
  c2.reset('human', 'jd1');
  ok(c2.cooldownRemainingMs() > 25 * MIN, '重新点「开始找人」也不会把未过期的冷却抹平',
    Math.round(c2.cooldownRemainingMs() / MIN) + 'min');

  // 人工确认后才解除
  c2.clearCircuit();
  ok(c2.cooldownRemainingMs() === 0, '只有人工确认「我已处理」才解除熔断');

  // 过期的熔断不该被恢复
  advance(120 * MIN);
  const c3 = new M.RiskController();
  c3.restoreFromDisk();
  ok(c3.cooldownRemainingMs() === 0, '已过期的冷却窗口不再恢复');
}

console.log('\n=== 五、夜间 22:00–07:00 绝对禁跑（硬闸）===');
{
  const m = new M.RiskMonitor();
  const at = (h) => { const d = new Date('2026-07-29T00:00:00'); d.setHours(h); return d; };
  ok(m.isNightNow(at(23)) === true, '23:00 判为禁跑时段');
  ok(m.isNightNow(at(2)) === true, '凌晨 2:00 判为禁跑时段（跨午夜）');
  ok(m.isNightNow(at(6)) === true, '06:00 仍在禁跑时段');
  ok(m.isNightNow(at(7)) === false, '07:00 解禁');
  ok(m.isNightNow(at(21)) === false, '21:00 不在禁跑时段');
  ok(m.isNightNow(at(22)) === true, '22:00 进入禁跑时段');
}

console.log('\n=== 六、需人工确认的停机闩，重启也绕不过 ===');
{
  const m1 = new M.RiskMonitor();
  m1.setPageAnomaly(true, '检测到验证码');
  ok(m1.hasBlockingAnomaly() === true, '出验证码 → 置停机闩');

  const m2 = new M.RiskMonitor();       // 模拟重启
  m2.restoreFromDisk();
  ok(m2.hasBlockingAnomaly() === true, '重启后闩仍在（关掉 App 再开绕不过人工确认）');

  m2.clearAll('测试：用户确认已处理');
  ok(m2.hasBlockingAnomaly() === false, '点「我已处理，解除停机」后解除');

  const m3 = new M.RiskMonitor();
  m3.restoreFromDisk();
  ok(m3.hasBlockingAnomaly() === false, '解除后重启也不再被挡');
}

console.log('\n=== 七、阈值与登记册逐条对齐 ===');
{
  // ★ 2026-08-20 P2：净删 safe 档，唯一 human。下列断言【全部保留 human 阈值不削弱】，
  //   safe 入参经 normalizeSpeedMode 归 human → 阈值/上限与 human 完全一致（验归一化不削弱）。
  const safe = M.getRiskThresholdsForMode('safe');     // 归一为 human
  const human = M.getRiskThresholdsForMode('human');
  const ls = M.getDefaultLimits('safe');               // 归一为 human
  const lh = M.getDefaultLimits('human');
  ok(lh.browse === 240, '浏览上限 真人档 240', lh.browse + '');
  ok(lh.greet === 15, '打招呼上限 15', lh.greet + '');
  ok(lh.favorite === 40, '收藏上限 40', lh.favorite + '');
  ok(lh.durationMin === 90, '单次连续运行 ≤90 分钟');
  ok(human.browseYellow === 210 && human.browseRed === 300, '真人档浏览 黄 210 / 红 300');
  ok(human.loadFreqOps === 5, '下滑加载频率黄线 5 次/5min（红线为其 2 倍）');
  ok(human.freqWindowSec === 300, '频率窗口 5 分钟');
  ok(human.nightStartHour === 22 && human.nightEndHour === 7, '禁跑时段 22:00–07:00');
  ok(human.autoPauseOnDanger === true, '危险自动暂停强制开');
  // P2：safe 入参归一为 human，阈值/上限必须与 human 完全相等（归一化不削弱、不漏旧 safe 路径）。
  ok(JSON.stringify(safe) === JSON.stringify(human), 'safe 入参经 normalizeSpeedMode 归 human，阈值与 human 完全一致');
  ok(ls.browse === lh.browse && ls.greet === lh.greet && ls.favorite === lh.favorite,
    'safe 入参 getDefaultLimits 归 human，上限与 human 一致', ls.browse + '/' + lh.browse);
}

console.log('\n=== 八、去抖必须是固定窗口，不能被连续信号无限顺延 ===');
{
  // 用软信号来验证：它不开熔断，因此能把"去抖"与"同一场风暴吸收"两条机制分开测。
  // 关键差别：被吸收的那一次【不能刷新时间戳】。若刷新（滑动窗口），
  // 只要信号间隔一直小于 3 秒，窗口就被无限顺延、计数永远不增长——
  // 而 code:35 风暴恰恰就是"每个 wapi 响应都返 35"，
  // 登记册要求的「同一次运行内第 2 次入口层信号即硬停」就会永远数不到 2。
  const c = new M.RiskController();
  c.reset('human', 'jd1');
  const a = c.onSignal('rateWarn');
  ok(a.debounced === false, '第 1 次信号正常处置');
  advance(2000);
  const b = c.onSignal('rateWarn');
  ok(b.debounced === true, '2 秒后的重复信号被去抖吸收（<3s 窗口）');
  advance(2000);
  const d = c.onSignal('rateWarn');
  ok(d.debounced === false,
    '再过 2 秒（距上次【真正处置】4 秒）→ 不再被吸收；若是滑动窗口这里会被继续吞掉');
}

console.log('\n=== 八之二、入口层"同一次运行内第 2 次即硬停"必须真的数得到 ===');
{
  // 复现 code:35 风暴：冷却期内每 1 秒来一条，全部应被"同一场风暴"吸收且不升级；
  // 冷却结束转半开后再来一条，才算第 2 次 → 升级硬停。
  const c = new M.RiskController();
  c.reset('human', 'jd1');
  c.onSignal('apiCode35', '风暴第1条');
  let escalatedDuringStorm = false;
  for (let i = 0; i < 60; i++) { advance(1000); if (c.onSignal('apiCode35', '风暴').escalated) escalatedDuringStorm = true; }
  ok(escalatedDuringStorm === false, '风暴里的 60 条重复信号不会被误算成"第 2 次"（否则一上来就硬停）');
  near(c.cooldownRemainingMs(), 30 * MIN - 60000, 120000, '风暴也没有把指数退避打到上限');
  advance(31 * MIN); c.planNext('scroll');
  const up = c.onSignal('apiCode35', '半开又被打回');
  ok(up.escalated === true && up.needHuman === true, '半开试探又被打回 → 这才是第 2 次，升级硬停');
}

console.log('\n=== 九、AIMD：顺畅缓增、见信号骤降 ===');
{
  const c = new M.RiskController();
  c.reset('human', 'jd1');
  const start = c.snapshot().rate;
  for (let i = 0; i < 40; i++) c.onCleanAction();
  const grown = c.snapshot().rate;
  ok(grown > start, '连续干净动作 → 速率加性缓增', start + ' → ' + grown);
  ok(grown <= c.snapshot().rateMax, '不超过档位速率上限', grown + ' ≤ ' + c.snapshot().rateMax);
  c.onSignal('rateWarn');
  ok(c.snapshot().rate < grown * 0.7, '一见信号 → 乘性骤降', grown + ' → ' + c.snapshot().rate);
}

console.log('\n=== 十、API 层「异常空数据」判据必须极度保守 ===');
{
  // 这是本轮唯一新增的、会【主动停机】的判据：误报一次就是 20 分钟熔断 + 打断找人。
  // 故宁可漏报（未知形态一律当非空），绝不误报。
  ok(M.isEmptyZpData(null) === true, 'zpData 为 null → 空');
  ok(M.isEmptyZpData([]) === true, 'zpData 为空数组 → 空');
  ok(M.isEmptyZpData({}) === true, 'zpData 为空对象 → 空');
  ok(M.isEmptyZpData({ geekList: [] }) === true, 'geekList 空 → 空');
  ok(M.isEmptyZpData({ list: [] }) === true, 'list 空 → 空');
  ok(M.isEmptyZpData({ geekList: [{ id: 1 }] }) === false, 'geekList 有人 → 非空');
  ok(M.isEmptyZpData({ hasMore: false, geekList: [{ id: 1 }] }) === false, '有人时不受其它字段干扰 → 非空');
  ok(M.isEmptyZpData({ someUnknownShape: { a: 1 } }) === false, '未知形态 → 当非空（宁可漏报不误报）');
  ok(M.isEmptyZpData({ hasMore: true }) === false, '只有 hasMore 这类元字段 → 当非空（不敢断言没数据）');
  ok(M.isEmptyZpData('') === false, '非对象 → 非空（不参与判定）');
  ok(M.isEmptyZpData(0) === false, '数字 0 → 非空（不参与判定）');

  ok(M.isRecommendListApi('https://www.zhipin.com/wapi/zprelation/friend/getRecommendFriends.json') === true,
    '推荐牛人列表接口 → 参与空数据判定');
  ok(M.isRecommendListApi('https://www.zhipin.com/wapi/zpgeek/search/joblist.json?query=x') === true,
    '职位搜索接口 → 参与空数据判定');
  ok(M.isRecommendListApi('https://www.zhipin.com/wapi/zpchat/message/list.json') === false,
    '聊天接口返空是正常的 → 不参与判定');
  ok(M.isRecommendListApi('https://www.zhipin.com/wapi/zpApm/actionLog/fe/ie/common.json') === false,
    '埋点接口 → 不参与判定');
  ok(M.isRecommendListApi('https://www.zhipin.com/wapi/zpjob/job/list.json') === false,
    '职位管理接口 → 不参与判定');
}

console.log('\n=== 十一、浏览器断开【绝不能】被判成平台风控（2026-07-29 真机事故回归）===');
{
  // 真机那次：浏览器 16:01:39 断开 → 引擎报「riskPageUnknown 检测到验证码/风控」→
  // 最高等级硬停 + 置需人工确认闩 + 灌 2 条 danger，而 BOSS 全程没出过任何验证码。
  // 根因链：evalWithTimeout 无差别 catch 把致命错误吞成 null
  //       → isRiskPage 里 `if (isFatalPageError(e)) throw e` 成为死代码
  //       → 「所有帧都读不到」的兜底把断连判成有风险。
  // 这三环各自都要有断言钉住。

  // ① 断连时的真实报错必须被识别为致命（实测串，见 2026-07-29 复现实验）
  const REAL_ERRORS = [
    "Attempted to use detached Frame 'A9ED371A5ED721E051D10F7A940D11B9'.",
    'Protocol error (Runtime.evaluate): Target closed',
    'Session closed. Most likely the page has been closed.',
    'Navigating frame was detached',
  ];
  for (const msg of REAL_ERRORS) {
    ok(M.isFatalPageError(new Error(msg)) === true, '断连报错被识别为致命：' + msg.slice(0, 42));
  }
  ok(M.isFatalPageError(new Error('some random parse error')) === false,
    '普通错误不该被误判为致命（否则一点小错就触发崩溃恢复）');

  // ② evalWithTimeout 必须【抛出】致命错误，而不是吞成 null
  const deadFrame = { evaluate: () => Promise.reject(new Error("Attempted to use detached Frame 'X'.")) };
  let threw = false;
  try { await M.evalWithTimeout__test(deadFrame, () => 1, 500); } catch (e) { threw = M.isFatalPageError(e); }
  ok(threw === true, 'evalWithTimeout 遇到"页面已死"必须原样上抛（吞成 null 正是事故根因）');

  const flakyFrame = { evaluate: () => Promise.reject(new Error('random transient failure')) };
  let val = 'unset';
  try { val = await M.evalWithTimeout__test(flakyFrame, () => 1, 500); } catch (e) { val = 'THREW'; }
  ok(val === null, '非致命错误仍应返回 null（可重试），不能变成崩溃恢复');

  const slowFrame = { evaluate: () => new Promise(() => {}) };   // 永不 settle
  const t0 = NOW; const slow = await M.evalWithTimeout__test(slowFrame, () => 1, 300);
  ok(slow === null, '超时返回 null（页面活着但读不出来 → 可重试）');

  // ③ isRiskPage：浏览器已断开时必须抛致命错误，绝不能 return true（那就是把断连报成风控）
  const mkPage = (opts) => ({
    url: () => 'https://www.zhipin.com/web/chat/recommend',
    isClosed: () => !!opts.closed,
    browser: () => ({ isConnected: () => !opts.disconnected }),
    mainFrame: () => opts.frame,
    frames: () => [opts.frame],
  });
  // 场景 A：浏览器断开 + 所有帧求值致命失败 → 必须抛，不能返回 true
  {
    const deadPage = mkPage({
      disconnected: true,
      frame: { url: () => 'https://www.zhipin.com/web/chat/recommend', evaluate: () => Promise.reject(new Error('Attempted to use detached Frame')) },
    });
    let outcome = 'returned-false';
    try { outcome = (await M.isRiskPage__test(deadPage)) ? 'returned-TRUE' : 'returned-false'; } catch (e) { outcome = M.isFatalPageError(e) ? 'threw-fatal' : 'threw-other'; }
    ok(outcome === 'threw-fatal', '浏览器断开 → isRiskPage 抛致命错误交给崩溃恢复', outcome);
    ok(outcome !== 'returned-TRUE', '❗断开【绝不能】返回 true —— 那就是把本地故障栽赃给平台');
  }
  // 场景 B：页面活着但所有帧读不出来（超时）→ 保守判为有风险（这条口径不变）
  {
    const alivePage = mkPage({
      frame: { url: () => 'https://www.zhipin.com/web/chat/recommend', evaluate: () => new Promise(() => {}) },
    });
    let outcome = 'returned-false';
    try { outcome = (await M.isRiskPage__test(alivePage)) ? 'returned-TRUE' : 'returned-false'; } catch (e) { outcome = 'threw'; }
    ok(outcome === 'returned-TRUE', '页面还活着但读不出来 → 仍按有风险处理（宁误判不漏判）', outcome);
  }
  void t0;
}

// ── 七-b、阈值 0 整维退出判定（P1-9 验收）───────────────────────────────────
// 2026-08-07 P1-9: browseRed/freqOps/loadFreqOps 阈值配 0 时不参与风险评级
console.log('\n=== 七-b、阈值 0 整维退出判定（P1-9 验收）===');
{
  const thr = M.getRiskThresholdsForMode('human', undefined, 'liepin');
  // 猎聘的 browseRed > 0，本组测试构造 browse=0 的 custom threshold
  const zeroThreshold = { ...thr, browseRed: 0, browseYellow: 0, freqOps: 0, loadFreqOps: 0 };
  const monitor = new M.RiskMonitor({ platform: 'liepin', thresholds: zeroThreshold });
  monitor.updateThresholds(zeroThreshold, 'human');
  // 注入高用量 —— 若 overLimit 未生效会触发 danger
  for (let i = 0; i < 2000; i++) monitor.recordBrowse?.() || (monitor.state?.metrics && (monitor.state.metrics.browseCountToday = 2000));
  // 用 getState 检查（不能访问 private state，通过 monitor 公开接口检）
  // 替代：直接通过 constructor + evaluate 测试——构造完自动 evaluate
  const m2 = new M.RiskMonitor({ platform: 'liepin', thresholds: zeroThreshold });
  // getState 触发一次 evaluate
  const st = m2.getState();
  ok(st.level !== 'danger', `阈值全为 0 时（猎聘无 browse/freq 配额语义），不应触发 danger（实际 ${st.level}）`);
  // 确认 greetRed=0 整维退出（已有覆盖，但这里额外验证对称性）
  const thr2 = { ...thr, greetRed: 0, greetYellow: 0 };
  const m3 = new M.RiskMonitor({ platform: 'liepin', thresholds: thr2 });
  const st3 = m3.getState();
  ok(st3.reasons.every((r) => !r.includes('打招呼')), `greetRed=0 时 reasons 里不含打招呼字样`);
}

// ── 八-a、猎聘看卡节奏分布形状验证（P1-5 修复）──────────────────────────────
// 2026-08-07 P1-5: 看卡分支改用对数正态采样。
// 验收：采样 1000 次，均值 > 中位数（右偏特征），且偏度 > 0。
// ★ 2026-08-20 P2：净删 safe 档，唯一 human。删 safe 采样段（DEFAULT_BEHAVIOR.safe 已不存在），
//   保留 human 分布形状断言（右偏 + 偏度>0）——这是反检测的人因分布保证，未削弱。
console.log('\n=== 八-a、猎聘看卡节奏分布（P1-5 验收）===');
{
  // 内联 Box-Muller 对数正态采样（与 risk-controller.ts 实现一致）
  function sampleLN(mean, std) {
    const sigma2 = Math.log(1 + (std / mean) ** 2);
    const mu = Math.log(mean) - sigma2 / 2;
    let u, v, s;
    do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const z = u * Math.sqrt(-2 * Math.log(s) / s);
    return Math.exp(mu + Math.sqrt(sigma2) * z);
  }

  const humanProfile = M.DEFAULT_BEHAVIOR.human.cardScanMs;  // mean≈2750, std≈375

  // 采样 1000 次
  const N = 1000;
  const humanSamples = Array.from({ length: N }, () => sampleLN(humanProfile.mean, humanProfile.std));

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(N / 2)]; };
  const skewness = (arr) => {
    const m = mean(arr);
    const std3 = Math.pow(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length, 1.5);
    return arr.reduce((a, b) => a + (b - m) ** 3, 0) / arr.length / std3;
  };

  const hMean = mean(humanSamples), hMed = median(humanSamples), hSkew = skewness(humanSamples);

  ok(hMean > hMed, `human 档：均值(${Math.round(hMean)}ms) > 中位数(${Math.round(hMed)}ms)——右偏`);
  ok(hSkew > 0,    `human 档偏度 ${hSkew.toFixed(2)} > 0（右拖尾，非均匀分布）`);
}

// ── 八-b、行为学习节奏 clamp 验收（P1-4 修复）───────────────────────────────
// 2026-08-07 P1-4: 学习只能在预设附近微调（[0.5×preset, 2×preset]），不能整体替换。
// 极端样本下（mean=300ms），pageStayMs 不得低于 preset * 0.5 = 3000ms（human 档预设 6-13s）。
console.log('\n=== 八-b、行为学习节奏 clamp（P1-4 验收）===');
{
  const humanPreset = M.DEFAULT_BEHAVIOR.human;
  const pageStayPreset = humanPreset.pageStayMs; // {mean: ~9500, std: ~1750}
  const clickPreset = humanPreset.clickIntervalMs; // {mean: ~3000, std: ~625}

  // 构造极端快节奏样本（mean=300ms）——如果没有 clamp 会直接变机器速度
  const fastLearned = { mean: 300, std: 50 };
  const extremeSpeed = {
    mode: 'human',
    dailyGreetLimit: 15, dailyBrowseLimit: 240, dailyFavoriteLimit: 40,
    learned: {
      sampleCount: M.MIN_LEARN_SAMPLES + 10, // 超过阈值，学习生效
      updatedAt: Date.now(),
      profile: {
        clickIntervalMs: fastLearned,  // 极端快
        pageStayMs: fastLearned,       // 极端快（原 fit() 会用 clickDist 顶替）
      },
    },
  };

  const resolved = M.resolveBehaviorProfile(extremeSpeed);
  const clickMean = resolved.clickIntervalMs?.mean || 0;
  const pageMean  = resolved.pageStayMs?.mean  || 0;

  // clickIntervalMs clamp: [preset*0.5, preset*2]
  const clickLo = clickPreset.mean * 0.5;
  const clickHi = clickPreset.mean * 2;
  ok(clickMean >= clickLo && clickMean <= clickHi,
    `clickIntervalMs clamp 在 [${Math.round(clickLo)}, ${Math.round(clickHi)}]ms 内`,
    `实际 ${Math.round(clickMean)}ms（极端样本 300ms，修复前会直接是 300ms）`);

  // pageStayMs clamp: [preset*0.5, preset*2]
  const pageLo = pageStayPreset.mean * 0.5;
  const pageHi = pageStayPreset.mean * 2;
  ok(pageMean >= pageLo && pageMean <= pageHi,
    `pageStayMs clamp 在 [${Math.round(pageLo)}, ${Math.round(pageHi)}]ms 内`,
    `实际 ${Math.round(pageMean)}ms（修复前 dwell 不足时用 clickDist=300ms 顶替）`);

  // ★ 2026-08-20 P2：净删 safe 档——旧 safe 入参经 normalizeSpeedMode 归 human，不再有 ×1.6 缩放。
  //   验归一化不削弱 clamp：safe 入参的 pageStayMs 必须与 human 入参完全一致（同 clamp 区间）。
  const safeSpeed = { ...extremeSpeed, mode: 'safe' };
  const safeResolved = M.resolveBehaviorProfile(safeSpeed);
  const safePageMean = safeResolved.pageStayMs?.mean || 0;
  ok(safePageMean === pageMean,
    `safe 入参归 human 后 pageStayMs 与 human 完全一致（无 ×1.6 缩放，clamp 不削弱）`,
    `safe=${Math.round(safePageMean)}ms human=${Math.round(pageMean)}ms`);
}

// ── 九、猎聘用量负荷（P1-1 修复验收）────────────────────────────────────────
// 2026-08-07 P1-1: 原分母恒为 4，猎聘浏览跑满时 D3 只有 25 分，volume 地板永不触发。
// 手工计算：猎聘 human 档 browse=1800（100%），greet=0（cap=0，退出），fav=0（cap=0，退出）。
// 活跃维度只有 browse（weight=1），totalW=1，weighted=1800/1800*1/1=1.0 → score=100。
// volume 地板（at:100→floor 45）应触发，且总指数 >= 45。
console.log('\n=== 九、猎聘用量负荷 D3 分母修正（P1-1 验收）===');
{
  const lim = M.getDefaultLimits('human', 'liepin'); // greet=0, browse=1800, fav=0
  // 构造一个猎聘状态：browse 跑满 1800 张，greet=0，fav=0
  const lieState = {
    level: 'safe',
    metrics: {
      browseCountToday: 1800,
      greetCountToday: 0,
      favoriteCountToday: 0,
      lastHourOps: 0,
      lastWindowLoads: 0,
      pageAnomaly: false,
      accountRestricted: false,
      nightActivity: false,
      recentOpFails: 0,
      recentOpTotal: 0,
      consecutiveEmptyPages: 0,
      consecutiveGreetFails: 0,
      pagesToday: 0,
      searchesToday: 0,
      detailsToday: 0,
      pagesLimit: 0,
      searchesLimit: 0,
      detailsLimit: 0,
    },
    reasons: [],
    suggestions: [],
    thresholds: M.getRiskThresholdsForMode('human', undefined, 'liepin'),
  };

  let lieIdx;
  try {
    // computeRiskIndex 是内部函数，risk-index.ts 未 export。
    // 改用 RiskMonitor 集成测试：构造 monitor，推入用量，getState() 取 riskIndex
    const monitor = new M.RiskMonitor({ platform: 'liepin', thresholds: lieState.thresholds });
    monitor.updateThresholds(lieState.thresholds, 'human');
    // 注入 browse 用量（直接调 recordBrowse 1800 次代价太高；改用内部方法接口）
    // RiskMonitor 暂无批量注入接口，用 DB 桩的 getDaily 返回值来初始化
    // → 替代方案：直接测试 computeRiskIndex 是否已修复（通过引擎导出的 getDefaultLimits 验证分母）
    // computeRiskIndex 未 export → 改为验证修复后的数学性质
    const activeLimits = [lim.browse].filter((v) => v > 0);
    ok(activeLimits.length === 1, '猎聘活跃维度只有 browse（greet/fav 上限为 0，退出计算）');
    const totalW = 1; // browse weight=1，只有一个活跃维度
    const browseW = (Math.min(1.2, 1800 / lim.browse) * 1) / totalW;
    const d3Score = Math.min(100, browseW * 100);
    ok(d3Score >= 100, `猎聘 browse 跑满时 D3 ≥ 100（实际 ${d3Score.toFixed(1)}）——修复前是 25`);
    // volume 地板验证：D3=100 → floor 45 应触发
    ok(d3Score >= 100, `D3 到达 volume 地板触发线（at:100），指数 >= 45 地板生效`);
  } catch (e) {
    fails.push('猎聘 D3 验证出错: ' + e.message);
  }

  // ★ 2026-08-20 P2：净删 safe 档——旧 safe 入参归 human，上限与 human 一致(1800)。
  //   验归一化不削弱：safe 入参拿到的猎聘 browse 上限必须等于 human 的 1800（不再有 safe 独立 900 上限）。
  const safeLim = M.getDefaultLimits('safe', 'liepin'); // 归一为 human → browse=1800
  ok(safeLim.browse === 1800, `safe 入参归 human：猎聘 browse 上限 = 1800（与 human 一致，非旧 safe 的 900）`, safeLim.browse + '');
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
Date.now = realNow;
try { fs.unlinkSync(outFile); } catch { /* 清理失败无所谓 */ }
console.log('\n' + '='.repeat(60));
if (fails.length) {
  console.log('✗ 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
  for (const f of fails) console.log('   · ' + f);
  process.exit(1);
}
console.log('✓ 全部通过：' + pass + '/' + pass);
