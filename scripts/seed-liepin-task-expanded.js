/**
 * 把猎聘搜索任务扩到【旧 RPA 的产量口径】。
 *
 * 来源：Work.zip 里的 _项目资料库/02_Liepin_RPA_Sourcing_猎聘/configs/
 *       config_<岗位>_expanded_<日期>.yaml —— 那一版实测单岗位能扒出
 *       2000+ 合适候选人，几乎把猎聘能查的查完。
 *
 * 拆解下来它的产量模型只有三条，代码侧我们【已经全有】，差的只是配置：
 *   ① 关键词是 18 条【多角度长短语】（"后端 分布式 高并发 架构师"），
 *      不是 6 个单词。每条短语打的是同一岗位的不同切面，覆盖面靠角度数量堆出来。
 *   ② locations / industries / experience / education 【全部留空】= 全国不限，
 *      让每个关键词都能吃满 max_pages。我们原来配了武汉+上海，组合数翻倍但每个更窄，
 *      而且猎聘的城市筛选本来就点不上（不在行内选项里），配了等于白配。
 *      按用户口径：匹配看的是候选人【期望城市】，已在卡片抽取 + 本地评分里判定。
 *   ③ target_companies 24 家：旧代码 _extract_company_term 把关键词里出现的公司名
 *      摘出来填进「搜索公司」框做定向。我们的 buildQueries 有等价实现，直接复用。
 *
 * 用法：npx electron scripts/seed-liepin-task-expanded.js
 * ⚠️ 会改变组合指纹 → 游标自动作废（引擎按 fingerprint 判定），从第 1 个组合重新跑。
 *    所以【不要在 RPA 运行中执行】。
 */
const { app } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');

app.setPath('userData', path.join(app.getPath('appData'), 'ta-flow'));

// 18 条多角度长短语，对标旧配置的写法：技术切面 ×12 + 公司定向 ×6
// ⛔⛔ 2026-08-13 真机实测推翻了「多角度长短语」策略（那是从旧版 RPA 原样搬来的）。
//   猎聘搜索框默认是【包含全部关键词】= AND：词越多，池子越小。实测同一组词：
//       「SLAM 视觉惯性 VIO 里程计」+ AND  →  共有    52 份简历
//       「SLAM 视觉惯性 VIO 里程计」+ OR   →  共有 3000+ 份简历   （58 倍）
//   而单个短词在 AND 下没有这个问题：「定位算法」单独搜 = 共有 3000+ 份简历。
//   这解释了此前所有的 0 产出：我们在 52 人的池子里做 9 路切分，当然全是重复。
//
//   ⚠️ 模式下拉（包含全部/任意/复合）实测【自动化切不动】——坐标点击、程序化点击、
//      键盘方向键+回车全部无效（ant-select + React 受控组件），且刷新后不持久化。
//      所以不能依赖 OR 模式，只能用【短词】在默认 AND 下拿到大池子。
//
//   正确形态：短词扩召回（每个词都是一个大池子）+ 经验/学历等切分轴挖深度。
//
// ⚠️ 下面的关键词与目标公司是【占位示例】，请换成你自己岗位的词。
//    最好的做法不是改这个文件，而是先在自己的任务里把关键词配好，
//    本脚本只负责演示"把任务参数批量写回 + 重算组合指纹"这套机械动作。
const KEYWORD_GROUPS = [
  '后端开发',
  'Java 后端',
  '分布式系统',
  '微服务架构',
  '高并发',
  '数据平台',
  '云原生',
  'Python 后端',
];

// 目标公司：同行/竞对池。关键词里出现哪家，就把哪家填进「搜索公司」定向。
// ⚠️ 占位示例，换成你自己的目标公司清单。
const TARGET_COMPANIES = [
  '示例科技',
  '示例科技（上海）',
  '另一家示例公司',
];

app.whenReady().then(() => {
  let out = {};
  try {
    const db = new Database(path.join(app.getPath('userData'), 'data', 'ta-platform.db'));
    db.pragma('busy_timeout = 8000');
    const row = db.prepare("SELECT id, data FROM rpa_tasks WHERE platform='liepin' LIMIT 1").get();
    if (!row) throw new Error('没有猎聘任务');
    const d = JSON.parse(row.data || '{}');
    const before = {
      关键词数: (d.search?.keywordGroups || []).length,
      城市: d.search?.cities || [],
      目标公司数: (d.search?.targetCompanies || []).length,
    };

    d.search = d.search || {};
    d.search.keywordGroups = KEYWORD_GROUPS;
    d.search.cities = [];          // ★ 全国不限：城市筛选点不上，且匹配按期望城市在本地判
    d.search.industries = [];
    d.search.targetCompanies = TARGET_COMPANIES;
    // ★★ 切分轴（2026-08-13 真机实测得出的核心结论）：
    //   猎聘按相关度排序，单个查询实际只吃得到前 ~100 人，而不同关键词的前 100 名
    //   【高度重合】——实测「组合导航」跟在「定位算法」之后 0 新人，6 关键词 5 组合
    //   只出 100 个新人。堆关键词提不了产量。
    //   能提产量的是把人群【切开】：同一关键词 + 不同经验档 = 不同的一批人。
    //   城市不能当切分轴（点不上，两个城市 = 跑两遍完全相同的搜索，实测 72 秒 0 新人）；
    //   经验/学历是行内可点的，是唯一真正有效的切分轴。
    d.search.experienceBands = ['1-3年', '3-5年', '5-10年'];
    d.search.degrees = ['本科', '硕士', '博士/博士后'];

    db.prepare('UPDATE rpa_tasks SET data = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(d), Date.now(), row.id);

    // 游标作废：指纹变了引擎会自己丢弃，这里顺手删干净避免困惑
    db.prepare('DELETE FROM settings WHERE key = ?').run(`rpa-cursor:liepin:${row.id}`);

    const back = JSON.parse(db.prepare('SELECT data FROM rpa_tasks WHERE id = ?').get(row.id).data);
    out = {
      ok: true,
      改前: before,
      改后: {
        关键词数: back.search.keywordGroups.length,
        城市: back.search.cities,
        目标公司数: back.search.targetCompanies.length,
        经验档: back.search.experienceBands,
        学历档: back.search.degrees,
        组合数: back.search.keywordGroups.length
          * Math.max(1, (back.search.experienceBands || []).length)
          * Math.max(1, (back.search.degrees || []).length),
      },
      理论产量: (() => {
        const n = back.search.keywordGroups.length
          * Math.max(1, (back.search.experienceBands || []).length)
          * Math.max(1, (back.search.degrees || []).length);
        return `${n} 组合 × 实测约 5 页 × 20 人 ≈ ${n * 5 * 20} 人（去重前）`;
      })(),
      游标: '已清空，从第 1 个组合重新跑',
    };
    db.close();
  } catch (e) { out = { ok: false, error: String(e.message || e) }; }
  process.stdout.write('\n__R__' + JSON.stringify(out, null, 1) + '\n');
  app.exit(out.ok ? 0 : 1);
});
