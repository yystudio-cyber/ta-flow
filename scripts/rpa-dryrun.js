/**
 * 无界面驱动 RPA（猎聘/BOSS），支持单进程内多轮长跑。
 *
 * 用法：npx electron scripts/rpa-dryrun.js [单轮秒数=1800] [平台=liepin] [轮数=1]
 *   例：npx electron scripts/rpa-dryrun.js 5400 liepin 6   （6 轮 × 90 分钟）
 *
 * 走的是与「开始找人」按钮完全相同的通道：
 *   initDatabase → initEncryptionFromSettings → applyBrowserSettings
 *   → smartConnect(平台端口) → startTaskById(taskId,'manual',platform)
 *
 * ⛔⛔ 为什么多轮必须做在【进程内】，而不是用 bash 循环编排（2026-08-13 事故）：
 *   原来用 scripts/liepin-marathon.sh 起 N 轮，每轮 spawn 一个 electron。真机上
 *   出过一次实事故——
 *     · 我以为杀掉 electron 就停了，其实杀的是【叶子】：bash 主循环把它当成
 *       "这轮跑完了"，休息 10 分钟后又起一个新的，等于给它做了个重启器；
 *     · bash 侧的单实例锁用 `kill -0 $PID` 判活，在 Git Bash 里对 Windows 原生 PID
 *       不可靠，第二个 marathon 直接绕过锁；
 *   结果最多 3 个 RPA 同时驱动【同一个浏览器】：一个刚设好筛选另一个就去搜索，
 *   数据全脏；更严重的是请求频率变成 3 倍、行为特征不再像人——
 *   当天猎聘弹出点字验证码（账号级警告），当日搜索 87 次（设计上限 60）。
 *   反风控模型（每人 8~16 秒、每屏 24 秒）是按【单实例】算的，多实例直接废掉它。
 *   单进程内循环从结构上消灭这一整类问题：没有编排层，就没有孤儿重启。
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { build } = require('esbuild');

app.setPath('userData', path.join(app.getPath('appData'), 'ta-flow'));

const ROOT = path.resolve(__dirname, '..');
// ★ 必须输出在项目内：external 的原生模块（better-sqlite3 等）靠 require 从 bundle
//   所在目录向上找 node_modules，放临时目录会全部解析失败。
const OUT = path.join(ROOT, '_rpa-harness.cjs');
const SESSION_SECONDS = Number(process.argv[2]) || 1800;
const PLATFORM = process.argv[3] || 'liepin';
const ROUNDS = Math.max(1, Number(process.argv[4]) || 1);
const REST_MS = 10 * 60 * 1000; // 轮间休息 10 分钟（反风控：避免连续高压）

// ── 单实例锁 ────────────────────────────────────────────────────────────────
// Node 的 process.kill(pid, 0) 在 Windows 上是可靠的（bash 的 kill -0 不是），
// 用它判活才不会出现"锁形同虚设"。
const LOCK = path.join(ROOT, `.rpa-dryrun-${PLATFORM}.lock`);
function acquireLock() {
  try {
    if (fs.existsSync(LOCK)) {
      const old = Number(fs.readFileSync(LOCK, 'utf8').trim());
      if (old && old !== process.pid) {
        let alive = false;
        try { process.kill(old, 0); alive = true; } catch { alive = false; }
        if (alive) {
          console.log(`✗ 已有 ${PLATFORM} 的 RPA 在运行（PID ${old}）。同一浏览器上跑两个实例会`);
          console.log('  互相抢页面、请求频率翻倍并触发平台验证码。先停掉它再起。');
          return false;
        }
      }
    }
    fs.writeFileSync(LOCK, String(process.pid), 'utf8');
    return true;
  } catch (e) { console.log('[warn] 加锁失败（继续跑）：', e.message); return true; }
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch { /* ignore */ } }

const q = (p) => path.join(ROOT, p).replace(/\\/g, '/');
const ENTRY = `
export { initDatabase, initEncryptionFromSettings, getSetting, getDb } from '${q('src/main/db.ts')}';
export { getRuntime, applyBrowserSettings } from '${q('src/main/services/runtime-registry.ts')}';
export { startTaskById } from '${q('src/main/services/rpa-launcher.ts')}';
export { getMonitor } from '${q('src/main/services/skeleton-monitor.ts')}';
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一轮，返回停止原因：'done' | 'quota' | 'env' | 'blocked' | 'timeup' */
async function runOneSession(M, rt, taskId, roundNo, monitor) {
  console.log(`\n──── 第 ${roundNo}/${ROUNDS} 轮开跑（${SESSION_SECONDS}s）────`);

  const rs0 = rt.riskMonitor.getState();
  console.log(`[风控] ${rs0.level} | blockingAnomaly=${rt.riskMonitor.hasBlockingAnomaly()} | night=${rt.riskMonitor.isNightNow()}`);
  if (rt.riskMonitor.hasBlockingAnomaly()) {
    console.log('✗ 存在需人工确认的风控闩，本轮不启动。请在风险中心解除后再跑。');
    return 'blocked';
  }

  // ★ 监控：记录本轮起跑时的搜索配额基线，结束算增量喂给 run-summary。
  const searchBase = (rs0.metrics && rs0.metrics.searchesToday) || 0;

  const r = await M.startTaskById(taskId, 'manual', PLATFORM);
  console.log('[启动]', JSON.stringify(r));
  if (!r.ok) { console.log('✗ 启动被拒:', r.reason); return 'blocked'; }

  let seen = 0;
  let reason = 'timeup';
  let lastStats = { viewed: 0, greeted: 0, favorited: 0, pagesBrowsed: 0 };
  const t0 = Date.now();
  for (;;) {
    await sleep(1500);
    let st;
    try { st = rt.engine.getState(); } catch (e) { console.log('[state err]', e.message); continue; }
    lastStats = st.stats || lastStats;
    const logs = st.logs || [];
    for (let i = seen; i < logs.length; i++) {
      const l = logs[i];
      const msg = String(l.message || '');
      console.log(`  [${l.level}] ${msg.slice(0, 170)}`);
      // 停止原因识别（用于决定要不要继续下一轮）
      if (/配额已用完|超过每日上限/.test(msg)) reason = 'quota';
      else if (/境外 IP 拦截|会话已失效|窗口不可见/.test(msg)) reason = 'env';
      else if (/需人工介入/.test(msg)) reason = 'blocked';
    }
    seen = logs.length;

    const el = Math.round((Date.now() - t0) / 1000);
    if (st.status !== 'running' && st.status !== 'paused' && el > 8) {
      console.log(`[本轮结束] status=${st.status} 用时 ${el}s 统计: ${JSON.stringify(st.stats)}`);
      if (reason === 'timeup') reason = 'done';
      break;
    }
    if (el >= SESSION_SECONDS) {
      console.log(`[本轮到时] ${SESSION_SECONDS}s status=${st.status} 统计: ${JSON.stringify(st.stats)}`);
      try { rt.engine.stop(); } catch { /* ignore */ }
      await sleep(3000);
      break;
    }
  }
  // ★ 监控：把本轮引擎 stats 增量喂给 run-summary（viewed/pages 全量累计，searches 算增量）。
  try {
    if (lastStats.viewed) monitor.recordViewed(lastStats.viewed);
    if (lastStats.pagesBrowsed) monitor.recordPage(lastStats.pagesBrowsed);
    const rs1 = rt.riskMonitor.getState();
    const searchNow = (rs1.metrics && rs1.metrics.searchesToday) || searchBase;
    const searchDelta = Math.max(0, searchNow - searchBase);
    for (let i = 0; i < searchDelta; i++) monitor.recordSearch();
    console.log(`[监控] 本轮喂入: viewed=${lastStats.viewed} pages=${lastStats.pagesBrowsed} searches+${searchDelta}`);
  } catch (e) { console.log('[监控 err]', e.message); }
  return reason;
}

async function main() {
  if (!acquireLock()) { app.exit(2); return; }

  await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', target: 'node20',
    outfile: OUT, logLevel: 'error',
    external: ['electron', 'better-sqlite3', 'puppeteer-core', 'rebrowser-puppeteer-core',
      'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
  });
  const M = require(OUT);

  M.initDatabase(path.join(app.getPath('userData'), 'data'));
  try { M.initEncryptionFromSettings(); } catch (e) { console.log('[warn] 加密初始化:', e.message); }

  const settings = M.getSetting('app-settings', null);
  if (settings) {
    const w = M.applyBrowserSettings(settings);
    if (w && w.warnings && w.warnings.length) console.log('[warn] 浏览器设置:', w.warnings.join('; '));
  }

  const rt = M.getRuntime(PLATFORM);
  console.log(`[1] 连接 ${PLATFORM} 浏览器 …`);
  const conn = await rt.chrome.smartConnect();
  console.log('    →', JSON.stringify(conn), '| isConnected =', rt.chrome.isConnected());

  // ★ 防呆探针（任务C）：连接后立刻验环境——未登录 / 撞 intercept-abroad-ip / 9333无浏览器
  //   任一不就绪立即停、记录现象、不重试不猜。账号近期吃过验证码，绝不带病起跑。
  if (!rt.chrome.isConnected()) {
    const msg = '环境未就绪：9333 调试端口无浏览器连接（smartConnect 返回 ' + JSON.stringify(conn) + '）。请确认 Chrome 已用 --remote-debugging-port=9333 启动并已登录猎聘。';
    console.log('⛔ ' + msg);
    releaseLock(); app.exit(3); return;
  }
  let probe = null;
  try {
    const pages = await rt.chrome.pages();
    probe = pages && pages.length ? pages[0] : null;
  } catch (e) { probe = null; }
  if (probe) {
    let where;
    try {
      where = await probe.evaluate(() => ({
        url: location.href,
        path: location.pathname,
        login: /请先登录|扫码登录|账号登录|手机号登录|密码登录/.test(document.body?.innerText || ''),
        bodyLen: (document.body?.innerText || '').length,
      }));
    } catch (e) { where = { evalErr: e.message }; }
    console.log('[防呆] 当前页:', JSON.stringify(where));
    if (where && /intercept-abroad-ip|\/secure\/intercept/i.test(where.path || where.url || '')) {
      const msg = '环境未就绪：页面停在境外 IP 拦截页（' + where.path + '）。请关闭 VPN（确保境内 IP）后重启 Chrome 再跑。';
      console.log('⛔ ' + msg);
      releaseLock(); app.exit(3); return;
    }
    if (where && (/\/login/i.test(where.path || '') || where.login)) {
      const msg = '环境未就绪：页面停在登录页（' + where.path + '），9333 窗口未登录猎聘。请在 9333 窗口登录后再跑。';
      console.log('⛔ ' + msg);
      releaseLock(); app.exit(3); return;
    }
  } else {
    console.log('[防呆] 连接已建立但暂无可见页面（可能 about:blank）——继续，引擎会自行打开工作页');
  }

  // ★ 监控：启动 run-summary 统计（钩 console.warn 收诊断码/风控事件）。
  const monitor = M.getMonitor(PLATFORM);
  monitor.start();
  console.log('[监控] SkeletonMonitor 已启动，run-summary 将在结束时落盘');

  const row = M.getDb().prepare('SELECT id,name FROM rpa_tasks WHERE platform=? LIMIT 1').get(PLATFORM);
  if (!row) { console.log('✗ 没有该平台的任务'); monitor.end(); releaseLock(); app.exit(1); return; }
  console.log('[2] 任务:', row.id, row.name);
  console.log(`[3] 计划：${ROUNDS} 轮 × ${Math.round(SESSION_SECONDS / 60)} 分钟，轮间休息 ${REST_MS / 60000} 分钟`);

  for (let i = 1; i <= ROUNDS; i++) {
    const why = await runOneSession(M, rt, row.id, i, monitor);
    if (why === 'quota') { console.log('\n⛔ 日配额已耗尽——配额每天 0 点重置，长跑结束。'); break; }
    if (why === 'env') { console.log('\n⛔ 环境异常（VPN/登录/窗口），长跑结束。'); break; }
    if (why === 'blocked') { console.log('\n⛔ 风控需人工介入，长跑结束。'); break; }
    if (i < ROUNDS) {
      console.log(`\n… 休息 ${REST_MS / 60000} 分钟后进入第 ${i + 1} 轮`);
      await sleep(REST_MS);
    }
  }

  let rowsWritten = 0;
  try {
    const c = M.getDb().prepare(`SELECT COUNT(*) c FROM ${PLATFORM === 'liepin' ? 'liepin_talents' : 'candidates_export'}`).get().c;
    rowsWritten = c;
    const ds = M.getDb().prepare('SELECT * FROM daily_stats WHERE platform=? ORDER BY date DESC LIMIT 1').get(PLATFORM);
    console.log('\n═══ 落库结果 ═══');
    console.log('  人才库条数:', c);
    console.log('  daily_stats:', JSON.stringify(ds));
  } catch (e) { console.log('[db err]', e.message); }

  // ★ 监控：落 run-summary.json（含 searches/viewed/pages/风控事件/各诊断码计数/落库行数）。
  try {
    monitor.recordRows(rowsWritten);
    const sumFile = monitor.end({ rowsWritten });
    console.log('\n═══ run-summary ═══');
    console.log('  文件:', sumFile);
    console.log('  内容:', JSON.stringify(monitor.getSummary()));
  } catch (e) { console.log('[监控 end err]', e.message); }

  releaseLock();
  app.exit(0);
}

process.on('exit', releaseLock);
app.whenReady().then(() => main().catch((e) => {
  console.error('✗ 驱动异常:', e && e.stack ? e.stack.slice(0, 1500) : e);
  releaseLock();
  app.exit(1);
}));
