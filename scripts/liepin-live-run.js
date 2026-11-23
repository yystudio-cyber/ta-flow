/**
 * ⚠️ 真跑 —— 不是 dry run！
 * 无界面驱动猎聘 RPA 跑一轮，会消耗真实配额、真写库、真发请求。
 * 走的是与「开始找人」按钮完全相同的通道：initDatabase → applyBrowserSettings
 * → smartConnect(9333) → startTaskById(taskId,'manual','liepin')，然后轮询引擎状态打日志。
 *
 * 用法：npx electron scripts/liepin-live-run.js [跑多少秒，默认180]
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { build } = require('esbuild');

app.setPath('userData', path.join(app.getPath('appData'), 'ta-flow'));

const ROOT = path.resolve(__dirname, '..');
// ★ 必须输出在项目内：external 的原生模块（better-sqlite3 等）靠 require 从
//   bundle 所在目录向上找 node_modules，放临时目录会全部解析失败。
const OUT = path.join(ROOT, '_rpa-harness.cjs');
const RUN_SECONDS = Number(process.argv[2]) || 180;

const ENTRY = `
export { initDatabase, initEncryptionFromSettings, getSetting, getDb } from '${path.join(ROOT, 'src/main/db.ts').replace(/\\/g, '/')}';
export { getRuntime, applyBrowserSettings } from '${path.join(ROOT, 'src/main/services/runtime-registry.ts').replace(/\\/g, '/')}';
export { startTaskById } from '${path.join(ROOT, 'src/main/services/rpa-launcher.ts').replace(/\\/g, '/')}';
`;

async function main() {
  await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', target: 'node20',
    outfile: OUT, logLevel: 'error',
    external: ['electron', 'better-sqlite3', 'puppeteer-core', 'rebrowser-puppeteer-core',
      'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
  });
  const M = require(OUT);

  const dataDir = path.join(app.getPath('userData'), 'data');
  M.initDatabase(dataDir);
  try { M.initEncryptionFromSettings(); } catch (e) { console.log('[warn] 加密初始化:', e.message); }

  const settings = M.getSetting('app-settings', null);
  if (settings) {
    const w = M.applyBrowserSettings(settings);
    if (w && w.warnings && w.warnings.length) console.log('[warn] 浏览器设置:', w.warnings.join('; '));
  }

  const rt = M.getRuntime('liepin');
  console.log('[1] 连接猎聘浏览器 (9333) …');
  const conn = await rt.chrome.smartConnect();
  console.log('    →', JSON.stringify(conn));
  console.log('    isConnected =', rt.chrome.isConnected());

  // 风控闩状态（上次 danger 是否还锁着）
  const rs = rt.riskMonitor.getState();
  console.log('[2] 风控状态:', rs.level, '| 原因:', JSON.stringify(rs.reasons));
  console.log('    hasBlockingAnomaly =', rt.riskMonitor.hasBlockingAnomaly());
  console.log('    isNightNow =', rt.riskMonitor.isNightNow());

  const row = M.getDb().prepare("SELECT id,name FROM rpa_tasks WHERE platform='liepin' LIMIT 1").get();
  if (!row) { console.log('✗ 没有猎聘任务'); app.exit(1); return; }
  console.log('[3] 任务:', row.id, row.name);

  console.log('[4] 启动 …');
  const r = await M.startTaskById(row.id, 'manual', 'liepin');
  console.log('    →', JSON.stringify(r));
  if (!r.ok) { console.log('✗ 启动被拒:', r.reason); app.exit(1); return; }

  // 轮询引擎状态，增量打印日志
  let seen = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    let st;
    try { st = rt.engine.getState(); } catch (e) { console.log('[state err]', e.message); return; }
    const logs = st.logs || [];
    for (let i = seen; i < logs.length; i++) {
      const l = logs[i];
      console.log(`  [${l.level}] ${String(l.message || '').slice(0, 160)}`);
    }
    seen = logs.length;
    const el = Math.round((Date.now() - t0) / 1000);
    if (st.status !== 'running' && st.status !== 'paused' && el > 8) {
      console.log(`\n[5] 引擎已停止（status=${st.status}），用时 ${el}s`);
      console.log('    统计:', JSON.stringify(st.stats));
      finish();
    } else if (el >= RUN_SECONDS) {
      console.log(`\n[5] 到达设定时长 ${RUN_SECONDS}s，主动停止。status=${st.status}`);
      console.log('    统计:', JSON.stringify(st.stats));
      try { rt.engine.stop(); } catch (e) { /* ignore */ }
      finish();
    }
  }, 1500);

  function finish() {
    clearInterval(timer);
    setTimeout(() => {
      try {
        const c = M.getDb().prepare('SELECT COUNT(*) c FROM liepin_talents').get().c;
        const ds = M.getDb().prepare("SELECT * FROM daily_stats WHERE platform='liepin' ORDER BY date DESC LIMIT 1").get();
        console.log('\n=== 落库结果 ===');
        console.log('  liepin_talents 条数:', c);
        console.log('  daily_stats:', JSON.stringify(ds));
      } catch (e) { console.log('[db err]', e.message); }
      app.exit(0);
    }, 2500);
  }
}

app.whenReady().then(() => main().catch((e) => {
  console.error('✗ 驱动异常:', e && e.stack ? e.stack.slice(0, 1200) : e);
  app.exit(1);
}));
