/**
 * 猎聘产能分析 —— 一键出产能报告，服务生产级验收。
 * 用法：npx electron scripts/analyze-liepin-run.js [jdId]
 *   jdId 省略时分析库里分数最多的那个岗位。
 * 只读，可在 RPA 运行中跑（WAL + busy_timeout，不干扰）。
 */
const { app } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
app.setPath('userData', path.join(app.getPath('appData'), 'ta-flow'));
const JD = process.argv[2] || null;

app.whenReady().then(() => {
  const out = {};
  try {
    const db = new Database(path.join(app.getPath('userData'), 'data', 'ta-platform.db'), { readonly: true });
    db.pragma('busy_timeout=8000');
    const today = new Date().toISOString().slice(0, 10);
    out.今日 = db.prepare("SELECT date,viewed,pages,searches,details,risk_events,mid_match,low_match FROM daily_stats WHERE platform='liepin' ORDER BY date DESC LIMIT 1").get();
    out.人才库总数 = db.prepare('SELECT COUNT(*) c FROM liepin_talents').get().c;
    out.今日新增 = db.prepare('SELECT COUNT(*) c FROM liepin_talents WHERE first_seen=?').get(today).c;
    // 各来源关键词贡献（哪些关键词池深）
    out.关键词产出Top = db.prepare('SELECT source_keyword k, COUNT(*) n FROM liepin_talents GROUP BY source_keyword ORDER BY n DESC LIMIT 12').all();
    // 目标 JD 的评分分布（未指定时取分数记录最多的岗位）
    const jd = JD
      || (db.prepare('SELECT jd_id FROM liepin_talent_scores GROUP BY jd_id ORDER BY COUNT(*) DESC LIMIT 1').get() || {}).jd_id
      || null;
    out.JD = jd;
    if (!jd) {
      out.该JD = '（库里还没有评分记录，先跑一轮 RPA）';
    } else {
      out.该JD_60plus = db.prepare('SELECT COUNT(DISTINCT res_id) c FROM liepin_talent_scores WHERE jd_id=? AND score>=60').get(jd).c;
      out.该JD_75plus = db.prepare('SELECT COUNT(DISTINCT res_id) c FROM liepin_talent_scores WHERE jd_id=? AND score>=75').get(jd).c;
      out.该JD_分数段 = db.prepare("SELECT CASE WHEN score>=85 THEN '85+' WHEN score>=75 THEN '75-84' WHEN score>=60 THEN '60-74' ELSE '<60' END g, COUNT(*) n FROM liepin_talent_scores WHERE jd_id=? GROUP BY g ORDER BY g DESC").all(jd);
    }
    // 近3天风控事件明细计数
    out.近24h风控 = db.prepare("SELECT level, COUNT(*) c FROM risk_history WHERE platform='liepin' AND time>? GROUP BY level").all(Date.now() - 86400000);
    db.close();
  } catch (e) { out.error = String(e.message || e); }
  process.stdout.write('\n__REPORT__\n' + JSON.stringify(out, null, 1) + '\n');
  app.exit(0);
});
