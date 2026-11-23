/**
 * 把 config/jd-config.json 里的岗位批量写入本地数据库。
 *
 * 用法：npx electron scripts/seed-jds.mjs [--active=<jobId>]
 * （必须走 Electron：better-sqlite3 按 Electron ABI 编译，纯 Node 加载会 NODE_MODULE_VERSION 报错。）
 *
 * 幂等：id 固定，重复跑覆盖同一条，不产生重复岗位。
 * 默认 active=0 写入 —— 绝不抢走当前正在用的激活岗位。
 * 想顺便激活某个岗位：加 --active=<jobId>。
 *
 * 关于为什么每个岗位都值得配 domain 与 tasks：
 *   domainFit + taskCoverage 合计占 40% 权重。不配不报错，但这两维会「整维退出加权」，
 *   评分退化成只看技术词面 —— 「金融风控引擎」和「电商推荐引擎」会打成同一档。
 */
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadJdConfig } from './config-loader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Electron 拉起时按自己的默认应用名算 userData，
// 这里显式指到平台真正用的目录，否则会把 JD 种到一个根本不存在的库。
app.setPath('userData', path.join(app.getPath('appData'), 'ta-flow'));

const activeArg = process.argv.find((a) => a.startsWith('--active='));
const activeId = activeArg ? activeArg.split('=')[1] : null;

app.whenReady().then(async () => {
  const { jobs, file, isExample } = loadJdConfig();
  console.log(`[seed] 配置来源：${path.relative(process.cwd(), file)}${isExample ? '（示例）' : ''}`);
  console.log(`[seed] 岗位数：${jobs.length}`);

  const dbPath = path.join(app.getPath('userData'), 'data', 'ta-platform.db');
  if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  console.log(`[seed] 目标库：${dbPath}`);

  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch (e) {
    console.error('[seed] better-sqlite3 加载失败。请确认是用 npx electron 运行，且已执行 npm install。');
    throw e;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 表由主进程迁移建立；这里只在缺失时报清楚错误，不擅自建表（schema 以主进程为准）。
  const hasJds = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jds'").get();
  if (!hasJds) {
    console.error('[seed] 库里还没有 jds 表。请先启动一次应用（npm run dev）让它完成迁移，再回来导入。');
    db.close();
    app.exit(1);
    return;
  }

  const cols = db.prepare('PRAGMA table_info(jds)').all().map((c) => c.name);
  const upsert = db.prepare(`
    INSERT INTO jds (id, data, active)
    VALUES (@id, @data, @active)
    ON CONFLICT(id) DO UPDATE SET data = @data, active = @active
  `);

  let n = 0;
  for (const job of jobs) {
    if (!job.id) { console.warn('[seed] 跳过一条没有 id 的岗位'); continue; }
    const active = activeId && job.id === activeId ? 1 : 0;
    upsert.run({ id: job.id, data: JSON.stringify(job), active });
    n++;
    console.log(`  ✓ ${job.id}  ${job.name || job.title || ''}${active ? '  [激活]' : ''}`);
  }

  db.close();
  console.log(`\n[seed] 完成：写入 ${n} 个岗位（字段 ${cols.length} 个）。`);
  console.log('[seed] 到「岗位库」页面刷新即可看到。');
  app.exit(0);
});
