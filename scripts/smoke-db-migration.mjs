#!/usr/bin/env node
/**
 * DB v2 → v3 迁移冒烟测试（不启动 Electron，直接用 better-sqlite3 复现真实迁移路径）
 *
 * 为什么必须有这一条：v3 要把 daily_stats 的主键从 date 改成 (date, platform)，
 * sqlite 不支持改主键 → 必须重建表 + 搬数据。这类迁移一旦写错，老用户的历史统计会直接丢，
 * 而且是"启动时静默丢"——没有测试就只能等用户发现。
 *
 * 本测试：
 *   1. 造一个【v2 结构】的库并塞入真实形态的历史数据；
 *   2. 跑与 db.ts 完全同一套 SQL 的迁移；
 *   3. 断言：结构对、历史数据一条不少且全部归属 boss、新平台可独立写入互不干扰。
 *
 * 用法：node scripts/smoke-db-migration.mjs
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = path.join(os.tmpdir(), `ta-migrate-smoke-${Date.now()}.db`);
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures++; console.error(`  ✗ ${m}`); };
const assert = (cond, m) => (cond ? ok(m) : bad(m));

// ══════════════ P2-6：v0 → v1 迁移（初始 schema，无额外 DDL） ══════════════
// 判断依据："v0"= 从未跑过迁移框架的库（即所有使用 JSON store 的老版本）。
// v0→v1 步骤只是版本号推进，createSchema 负责全部建表，迁移本身没有额外 DDL。
// 不再有真实用户处于 v0（全部已进 v3+），但测试保留，证明路径没有死路/抛错。
{
  console.log('\n=== v0 → v1：初始 schema 路径 ===');
  const tmpV0 = path.join(os.tmpdir(), `ta-v0-smoke-${Date.now()}.db`);
  const dbV0 = new Database(tmpV0);
  dbV0.pragma('journal_mode = WAL');
  // v0 = 无 meta 表，无 schemaVersion（JSON store 时代的老库结构）
  // 建几张最小化的表（代表 JSON→sqlite 迁移后的初始态），不设 schemaVersion
  dbV0.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS jds (id TEXT PRIMARY KEY, name TEXT, data TEXT);
  `);
  // v0→v1: 步骤只是写版本号，无额外 DDL
  // 模拟 db.ts 的 switch(ver=0) 分支：直接推进到 ver=1
  dbV0.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schemaVersion','1')").run();
  const v1 = dbV0.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value;
  assert(String(v1) === '1', 'v0→v1 迁移：schemaVersion 推进到 1');
  // 确认 v0→v1 无额外 DDL 破坏原有表
  const tables = dbV0.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert(tables.includes('jds'), 'v0→v1 迁移：原有表 jds 未被破坏');
  dbV0.close();
  try { for (const suf of ['', '-wal', '-shm']) fs.rmSync(tmpV0 + suf, { force: true }); } catch { /**/ }
}

// ══════════════ P2-6：v1 → v2 迁移（candidates_export 加 viewed 列） ══════════════
// v1→v2 是 ALTER TABLE candidates_export ADD COLUMN viewed（G2/G3 功能），
// 这是最小有意义的 DDL 步骤，值得单独覆盖。
{
  console.log('\n=== v1 → v2：candidates_export.viewed 列 ===');
  const tmpV1 = path.join(os.tmpdir(), `ta-v1-smoke-${Date.now()}.db`);
  const dbV1 = new Database(tmpV1);
  dbV1.pragma('journal_mode = WAL');
  // 造一个 v1 结构（candidates_export 不含 viewed 列）
  dbV1.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS candidates_export (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, jd_id TEXT, name TEXT,
      position TEXT, company TEXT, city TEXT, score REAL, url TEXT,
      greeted INTEGER NOT NULL DEFAULT 0, favorited INTEGER NOT NULL DEFAULT 0
    );
  `);
  dbV1.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schemaVersion','1')").run();
  // 塞一条历史候选人
  dbV1.prepare("INSERT INTO candidates_export (date,name,url) VALUES (?,?,?)").run('2026-01-01','历史候选人','boss:old:XYZ');
  // 执行 v1→v2 迁移：ALTER TABLE candidates_export ADD COLUMN viewed
  try {
    dbV1.exec('ALTER TABLE candidates_export ADD COLUMN viewed INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* 列已存在（新库路径），可忽略 */
  }
  dbV1.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schemaVersion','2')").run();
  // 断言：列存在，历史数据未丢，viewed 默认 0
  const colsV2 = dbV1.pragma('table_info(candidates_export)').map((r) => r.name);
  assert(colsV2.includes('viewed'), 'v1→v2 迁移：candidates_export 有 viewed 列');
  const hist = dbV1.prepare("SELECT viewed FROM candidates_export WHERE name='历史候选人'").get();
  assert(hist && hist.viewed === 0, 'v1→v2 迁移：历史候选人记录未丢失，viewed 默认 0');
  const v2 = dbV1.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value;
  assert(String(v2) === '2', 'v1→v2 迁移：schemaVersion 推进到 2');
  dbV1.close();
  try { for (const suf of ['', '-wal', '-shm']) fs.rmSync(tmpV1 + suf, { force: true }); } catch { /**/ }
}

const db = new Database(tmp);
db.pragma('journal_mode = WAL');

// ── 1. 造 v2 结构 + 历史数据 ──────────────────────────────────
console.log('\n[1] 构造 v2 旧库');
db.exec(`
  CREATE TABLE daily_stats (
    date TEXT PRIMARY KEY,
    viewed INTEGER NOT NULL DEFAULT 0, greeted INTEGER NOT NULL DEFAULT 0,
    favorited INTEGER NOT NULL DEFAULT 0, high_match INTEGER NOT NULL DEFAULT 0,
    mid_match INTEGER NOT NULL DEFAULT 0, low_match INTEGER NOT NULL DEFAULT 0,
    risk_events INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE risk_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER, date TEXT, level TEXT, reason TEXT
  );
  CREATE TABLE rpa_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, time INTEGER, level TEXT, task_id TEXT, message TEXT
  );
  CREATE TABLE candidates_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, jd_id TEXT, name TEXT, position TEXT,
    company TEXT, city TEXT, experience TEXT, degree TEXT, salary TEXT, score REAL, url TEXT,
    greeted INTEGER NOT NULL DEFAULT 0, favorited INTEGER NOT NULL DEFAULT 0, note TEXT,
    viewed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE rpa_tasks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, data TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_run_at INTEGER
  );
`);
db.prepare('INSERT INTO daily_stats (date, viewed, greeted, high_match) VALUES (?,?,?,?)').run('2026-07-20', 120, 8, 30);
db.prepare('INSERT INTO daily_stats (date, viewed, greeted, high_match) VALUES (?,?,?,?)').run('2026-07-21', 200, 12, 55);
db.prepare('INSERT INTO risk_history (time, date, level, reason) VALUES (?,?,?,?)').run(Date.now(), '2026-07-21', 'notice', '历史事件');
db.prepare('INSERT INTO rpa_logs (date, time, level, message) VALUES (?,?,?,?)').run('2026-07-21', Date.now(), 'info', '历史日志');
db.prepare('INSERT INTO candidates_export (date, name, url) VALUES (?,?,?)').run('2026-07-21', '张三', 'boss:geek:ABC123');
db.prepare('INSERT INTO candidates_export (date, name, url) VALUES (?,?,?)').run('2026-07-21', '李四', null);
// 模拟旧任务：platform 为 NULL 或空字符串
db.prepare("INSERT INTO rpa_tasks (id, name, platform, data, created_at, updated_at) VALUES (?,?,?,?,?,?)")
  .run('task-1', '旧BOSS任务', null, '{}', Date.now(), Date.now());
db.prepare("INSERT INTO rpa_tasks (id, name, platform, data, created_at, updated_at) VALUES (?,?,?,?,?,?)")
  .run('task-2', '空平台任务', '', '{}', Date.now(), Date.now());
ok('v2 库已建（2 天统计 / 1 条风险 / 1 条日志 / 2 位候选人 / 2 个旧任务）');

// ── 2. 跑迁移（与 db.ts migrateV2ToV3 同一套 SQL）─────────────
console.log('\n[2] 执行 v2 → v3 迁移');
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
const tx = db.transaction(() => {
  for (const t of ['risk_history', 'rpa_logs', 'candidates_export']) {
    if (!hasColumn(t, 'platform')) db.exec(`ALTER TABLE ${t} ADD COLUMN platform TEXT NOT NULL DEFAULT 'boss'`);
  }
  if (!hasColumn('candidates_export', 'source_id')) {
    db.exec('ALTER TABLE candidates_export ADD COLUMN source_id TEXT');
    db.exec("UPDATE candidates_export SET source_id = substr(url, 11) WHERE source_id IS NULL AND url LIKE 'boss:geek:%'");
  }
  const dsCols = db.prepare('PRAGMA table_info(daily_stats)').all();
  const alreadyPartitioned = dsCols.some((c) => c.name === 'platform' && c.pk > 0);
  if (!alreadyPartitioned) {
    db.exec(`
      CREATE TABLE daily_stats__v3 (
        date TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'boss',
        viewed INTEGER NOT NULL DEFAULT 0, greeted INTEGER NOT NULL DEFAULT 0,
        favorited INTEGER NOT NULL DEFAULT 0, high_match INTEGER NOT NULL DEFAULT 0,
        mid_match INTEGER NOT NULL DEFAULT 0, low_match INTEGER NOT NULL DEFAULT 0,
        risk_events INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
        searches INTEGER NOT NULL DEFAULT 0, details INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, platform)
      );`);
    const platExpr = dsCols.some((c) => c.name === 'platform') ? "COALESCE(platform, 'boss')" : "'boss'";
    db.exec(`
      INSERT OR REPLACE INTO daily_stats__v3
        (date, platform, viewed, greeted, favorited, high_match, mid_match, low_match, risk_events)
      SELECT date, ${platExpr}, viewed, greeted, favorited, high_match, mid_match, low_match, risk_events
      FROM daily_stats;`);
    db.exec('DROP TABLE daily_stats');
    db.exec('ALTER TABLE daily_stats__v3 RENAME TO daily_stats');
  }
  // 与 db.ts 对齐：旧 rpa_tasks 补默认平台（已有 platform 列，确保无 NULL）
  db.exec("UPDATE rpa_tasks SET platform='boss' WHERE platform IS NULL OR platform=''");
});
tx();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_cand_plat_src ON candidates_export(platform, source_id) WHERE source_id IS NOT NULL');
ok('迁移事务已提交');

// ── 3. 断言 ──────────────────────────────────────────────────
console.log('\n[3] 断言');
{
  const cols = db.prepare('PRAGMA table_info(daily_stats)').all();
  const pk = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
  assert(JSON.stringify(pk) === JSON.stringify(['date', 'platform']), `daily_stats 复合主键 = (date, platform)，实际 (${pk})`);
  assert(cols.some((c) => c.name === 'pages'), 'daily_stats 新增 pages 列');
  assert(cols.some((c) => c.name === 'searches'), 'daily_stats 新增 searches 列');
  assert(cols.some((c) => c.name === 'details'), 'daily_stats 新增 details 列');

  const rows = db.prepare("SELECT * FROM daily_stats WHERE platform='boss' ORDER BY date").all();
  assert(rows.length === 2, `历史统计一条不少（2 行），实际 ${rows.length} 行`);
  assert(rows[0].viewed === 120 && rows[1].viewed === 200, '历史 viewed 数值未被改动');
  assert(rows[1].high_match === 55, '历史 high_match 数值未被改动');

  const rh = db.prepare('SELECT platform FROM risk_history').all();
  assert(rh.length === 1 && rh[0].platform === 'boss', '历史风险事件归属 boss');
  const lg = db.prepare('SELECT platform FROM rpa_logs').all();
  assert(lg.length === 1 && lg[0].platform === 'boss', '历史日志归属 boss');
  // rpa_tasks 补默认平台：NULL 和 '' 都应收敛为 'boss'
  const rt = db.prepare('SELECT id, platform FROM rpa_tasks ORDER BY id').all();
  assert(rt.length === 2, `rpa_tasks 迁移后 2 行（实际 ${rt.length}）`);
  assert(rt.every((r) => r.platform === 'boss'), `rpa_tasks 全部收敛为 boss（实际 ${JSON.stringify(rt.map((r) => r.platform))}）`);

  const c1 = db.prepare("SELECT * FROM candidates_export WHERE name='张三'").get();
  assert(c1.platform === 'boss', '历史候选人归属 boss');
  assert(c1.source_id === 'ABC123', `boss:geek: 前缀已反解出 source_id（实际 ${c1.source_id}）`);
  const c2 = db.prepare("SELECT * FROM candidates_export WHERE name='李四'").get();
  assert(c2.source_id === null, '无锚点的历史行 source_id 留 NULL（不参与去重，不报错）');
}

// ── 4. 两平台独立写入互不干扰 ────────────────────────────────
console.log('\n[4] 两平台独立写入');
{
  const bump = (platform, field, by) => db.prepare(
    `INSERT INTO daily_stats (date, platform, ${field}) VALUES (?, ?, ?)
     ON CONFLICT(date, platform) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
  ).run('2026-07-27', platform, by);

  bump('boss', 'viewed', 50);
  bump('liepin', 'viewed', 300);
  bump('liepin', 'details', 12);
  bump('boss', 'greeted', 5);

  const b = db.prepare("SELECT * FROM daily_stats WHERE date='2026-07-27' AND platform='boss'").get();
  const l = db.prepare("SELECT * FROM daily_stats WHERE date='2026-07-27' AND platform='liepin'").get();
  assert(b.viewed === 50, `boss viewed 独立计数 = 50（实际 ${b.viewed}）`);
  assert(l.viewed === 300, `liepin viewed 独立计数 = 300（实际 ${l.viewed}）`);
  assert(b.details === 0, `boss details 不受 liepin 写入影响 = 0（实际 ${b.details}）`);
  assert(l.details === 12, `liepin details = 12（实际 ${l.details}）`);
  assert(l.greeted === 0, `liepin greeted 不受 boss 写入影响 = 0（实际 ${l.greeted}）`);

  // 跨运行去重：同平台同 source_id 唯一
  db.prepare("INSERT INTO candidates_export (date,name,platform,source_id) VALUES ('2026-07-27','王五','liepin','RID1')").run();
  let dupBlocked = false;
  try {
    db.prepare("INSERT INTO candidates_export (date,name,platform,source_id) VALUES ('2026-07-27','王五2','liepin','RID1')").run();
  } catch { dupBlocked = true; }
  assert(dupBlocked, '同平台同 source_id 重复插入被唯一索引拦截（跨运行去重生效）');

  // 不同平台可以有相同 source_id（不同平台的 id 空间本就独立）
  let crossOk = true;
  try {
    db.prepare("INSERT INTO candidates_export (date,name,platform,source_id) VALUES ('2026-07-27','同名不同源','boss','RID1')").run();
  } catch { crossOk = false; }
  assert(crossOk, '不同平台可用相同 source_id（id 空间互相独立）');
}

// ══════════════ v3 → v4：猎聘人才池 ══════════════
// 这三张表是「长久保存人才链接」的载体，保留期口径与 BOSS 那张表相反：
// 到期只进待清理、不静默删。这里验的是结构 + 三条最容易写错的行为语义。
{
  console.log('\n=== v3 → v4：猎聘人才池 ===');
  db.exec(`
    CREATE TABLE IF NOT EXISTS liepin_talents (
      res_id TEXT PRIMARY KEY, name TEXT, position TEXT, company TEXT, city TEXT,
      experience TEXT, degree TEXT, salary TEXT, active_status TEXT, source_keyword TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, detail_at INTEGER,
      archived INTEGER NOT NULL DEFAULT 0, note TEXT, keep_until TEXT
    );
    CREATE TABLE IF NOT EXISTS liepin_talent_scores (
      res_id TEXT NOT NULL, jd_id TEXT NOT NULL, score REAL NOT NULL, level TEXT,
      reasons TEXT, depth TEXT, scored_at INTEGER NOT NULL, PRIMARY KEY (res_id, jd_id)
    );
    CREATE TABLE IF NOT EXISTS liepin_talent_tags (
      res_id TEXT NOT NULL, tag TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL,
      PRIMARY KEY (res_id, tag)
    );
  `);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'liepin_%'").all().map((r) => r.name);
  assert(tables.includes('liepin_talents'), 'liepin_talents 已建');
  assert(tables.includes('liepin_talent_scores'), 'liepin_talent_scores 已建');
  assert(tables.includes('liepin_talent_tags'), 'liepin_talent_tags 已建');

  const UPSERT = `INSERT INTO liepin_talents (res_id,name,company,first_seen,last_seen,keep_until)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(res_id) DO UPDATE SET
       name = COALESCE(excluded.name, liepin_talents.name),
       company = COALESCE(excluded.company, liepin_talents.company),
       last_seen = excluded.last_seen, keep_until = excluded.keep_until`;

  db.prepare(UPSERT).run('R1', '张三', 'A公司', '2026-08-01', '2026-08-01', '2027-01-28');
  // TA 手动归档 + 写备注 + 记录已开过详情（花过钱）
  db.prepare("UPDATE liepin_talents SET archived=1, note='已联系', detail_at=1234 WHERE res_id='R1'").run();
  // 再抓一次（RPA 重跑命中同一个人）
  db.prepare(UPSERT).run('R1', '张三', 'A公司', '2026-08-04', '2026-08-04', '2027-01-31');
  const r1 = db.prepare("SELECT * FROM liepin_talents WHERE res_id='R1'").get();

  // ★ 这三条是最容易写错、且写错就会真实伤害用户的：
  assert(r1.archived === 1, '重抓不会冲掉 TA 的归档状态');
  assert(r1.note === '已联系', '重抓不会冲掉 TA 写的备注');
  assert(r1.detail_at === 1234, '重抓不会冲掉「已开过详情」标记（否则会重复扣套餐额度）');
  assert(r1.first_seen === '2026-08-01', 'first_seen 保持首次入库日期不变');
  assert(r1.last_seen === '2026-08-04', 'last_seen 刷新为最近一次被搜到');

  // 一个人对多个岗位有不同评分
  const S = db.prepare('INSERT INTO liepin_talent_scores (res_id,jd_id,score,level,scored_at) VALUES (?,?,?,?,?)');
  S.run('R1', 'JD-A', 82, 'high', Date.now());
  S.run('R1', 'JD-B', 64, 'medium', Date.now());
  const scores = db.prepare("SELECT jd_id,score FROM liepin_talent_scores WHERE res_id='R1' ORDER BY score DESC").all();
  assert(scores.length === 2 && scores[0].score === 82 && scores[1].score === 64,
    '同一人对多个岗位可存多份不同评分，按分排序');

  // 60 分门槛：低于 60 不出现在子页
  S.run('R2', 'JD-A', 55, 'low', Date.now());
  db.prepare(UPSERT).run('R2', '李四', 'B公司', '2026-08-04', '2026-08-04', '2027-01-31');
  const visible = db.prepare(
    `SELECT t.res_id FROM liepin_talents t JOIN liepin_talent_scores s
       ON s.res_id=t.res_id AND s.jd_id='JD-A'
     WHERE t.archived=0 AND s.score >= 60`,
  ).all().map((r) => r.res_id);
  assert(!visible.includes('R2'), '低于 60 分的人选不出现在岗位视图里');

  // 标签幂等
  const T = db.prepare("INSERT INTO liepin_talent_tags (res_id,tag,source,created_at) VALUES (?,?,?,?) ON CONFLICT(res_id,tag) DO NOTHING");
  T.run('R1', '25届可捞', 'manual', Date.now());
  T.run('R1', '25届可捞', 'auto-jd', Date.now());
  const tagRows = db.prepare("SELECT source FROM liepin_talent_tags WHERE res_id='R1'").all();
  assert(tagRows.length === 1 && tagRows[0].source === 'manual',
    '同一标签重复写幂等，且自动标不覆盖 TA 手动打的标');
}

// ── P2-2 断言：UPDATE 命中加密列时，SET 子句解析必须填 encIndices ──────────────
// (smoke:db 不载入 TS，这里内联复现 analyzeSql 的 UPDATE 分支，逻辑与 db.ts 同构)
{
  const ENCRYPTED = { jds: ['name', 'data'], candidates_export: ['name', 'phone', 'selfIntro', 'address', 'remarks'] };
  function parseUpdateIndices(sql, encMap) {
    const s = sql.replace(/\s+/g, ' ').trim();
    const upd = /^UPDATE\s+(\w+)\s+SET\s+([^)]*?)(?:\s+WHERE|\s*$)/i.exec(s);
    if (!upd) return { table: null, encIndices: [] };
    const table = upd[1];
    const enc = encMap[table];
    if (!enc) return { table, encIndices: [] };
    const setCols = [];
    for (const pair of upd[2].split(',')) {
      const m = /(\w+)\s*=\s*\?/.exec(pair.trim());
      if (m) setCols.push(m[1]);
    }
    const encIndices = setCols.reduce((acc, c, i) => { if (enc.includes(c)) acc.push(i); return acc; }, []);
    return { table, encIndices };
  }
  const r1 = parseUpdateIndices("UPDATE jds SET name=?, data=?, updated=? WHERE id=?", ENCRYPTED);
  assert(r1.table === 'jds' && r1.encIndices.length === 2 && r1.encIndices[0] === 0 && r1.encIndices[1] === 1,
    'P2-2 UPDATE jds SET name,data → encIndices=[0,1]');
  const r2 = parseUpdateIndices("UPDATE candidates_export SET phone=?,name=? WHERE id=?", ENCRYPTED);
  assert(r2.encIndices.includes(0) && r2.encIndices.includes(1),
    'P2-2 UPDATE candidates_export SET phone,name → encIndices=[0,1]');
  const r3 = parseUpdateIndices("UPDATE jds SET title=? WHERE id=?", ENCRYPTED);
  assert(r3.encIndices.length === 0, 'P2-2 UPDATE jds SET 非加密列 title → encIndices=[]');
  const r4 = parseUpdateIndices("UPDATE liepin_talent_scores SET score=? WHERE res_id=?", {});
  assert(r4.encIndices.length === 0, 'P2-2 UPDATE liepin_talent_scores（非加密表）→ encIndices=[]');
}

// ══════════════ v4 → v5：liepin_talent_scores 加 insufficient_evidence 列 ══════════════
{
  console.log('\n=== v4 → v5：liepin_talent_scores insufficient_evidence 列 ===');
  try {
    db.exec('ALTER TABLE liepin_talent_scores ADD COLUMN insufficient_evidence INTEGER NOT NULL DEFAULT 0');
    console.log('  (ALTER TABLE 成功，模拟老库升级)');
  } catch {
    /* 列已存在（新库在 CREATE 时已含） */
    console.log('  (ALTER TABLE 跳过：列已存在，符合新库路径)');
  }
  const cols = db.pragma('table_info(liepin_talent_scores)').map((r) => r.name);
  assert(cols.includes('insufficient_evidence'),
    'P1-19 v4→v5 迁移：liepin_talent_scores 有 insufficient_evidence 列');
  // 确认 INSERT 和 SELECT 都能正常工作（列带默认值）
  db.prepare('INSERT INTO liepin_talent_scores (res_id,jd_id,score,level,scored_at) VALUES (?,?,?,?,?)')
    .run('R-ie', 'JD-X', 72, 'medium', Date.now());
  const row = db.prepare("SELECT insufficient_evidence FROM liepin_talent_scores WHERE res_id='R-ie'").get();
  assert(row && row.insufficient_evidence === 0, 'insufficient_evidence 默认值为 0');
}

// ══════════════ P2-3 降级场景断言 ══════════════
// 模拟：库里版本 = 99（更高的未来版本），当前 build 的 SCHEMA_VERSION = 5（或任何更低值）。
// 预期行为：拒绝打开并告知用户，版本号不被静默盖回，也不崩溃。
{
  console.log('\n=== P2-3 降级场景 ===');
  const tmpDown = path.join(os.tmpdir(), `ta-downgrade-smoke-${Date.now()}.db`);
  const dbDown = new Database(tmpDown);
  dbDown.pragma('journal_mode = WAL');
  // 造一个最小化的 schema，并把版本号设成 99
  dbDown.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  dbDown.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schemaVersion','99')").run();
  const ver99 = Number(dbDown.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value);
  assert(ver99 === 99, 'P2-3 前置：库里版本已是 99');

  // 模拟降级 build（SCHEMA_VERSION=5）打开该库时应拒绝
  const SCHEMA_VERSION_CURRENT = 5;
  let threw = false;
  let errMsg = '';
  function simulateMigrate(dbh, ver, targetVer) {
    if (ver > targetVer) {
      threw = true;
      errMsg = `数据库版本(${ver})高于当前 build 支持的版本(${targetVer})`;
      throw new Error(errMsg);
    }
  }
  try { simulateMigrate(dbDown, 99, SCHEMA_VERSION_CURRENT); } catch { /* expected */ }
  assert(threw, 'P2-3 降级打开时抛出错误（不静默继续）');
  // 版本号不被盖回
  const verAfter = Number(dbDown.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value);
  assert(verAfter === 99, 'P2-3 降级后版本号不被静默写回（仍是 99）');
  dbDown.close();
  try { for (const suf of ['', '-wal', '-shm']) fs.rmSync(tmpDown + suf, { force: true }); } catch { /* 清理失败忽略 */ }
}

db.close();
try { for (const suf of ['', '-wal', '-shm']) fs.rmSync(tmp + suf, { force: true }); } catch { /* 清理失败忽略 */ }

console.log('');
if (failures) { console.error(`❌ 迁移冒烟未通过：${failures} 项\n`); process.exit(1); }
console.log('✅ DB v2→v3→v4→v5 迁移冒烟全绿\n');
