/**
 * 飞书招聘需求 → 本地 Excel 列映射
 *
 * 每项：
 *   col       — Excel 列字母（A..O）
 *   header    — 表头（含 \r\n 的双语行）
 *   sources   — 飞书字段候选名（按优先级排）；空数组 = 无已知源，值留空
 *   compute   — 可选：函数 (row) => string，替代 sources 计算值
 *   required  — 为 true 时该列为 dedup key（需求编号），值为空则跳过整行
 *
 * ── 真机校准记录（2026-08-10，测试租户 demo，样本 R00011 / R00057）──
 * 需求详情页「基本信息」区的实际字段全集：
 *   需求编号 / 是否保密岗位 / 需求部门 / 直属上级 / 人员类型 / 需求人数 / 开始日期 /
 *   期望到岗时间 / 所属成本中心 / 增补原因 / 原需求需求审批链接 / 关键项目 / 业务影响 /
 *   替换人员 / 替换人员最后工作日 / 工作地点 / 职责 / 职位要求 / 职级 / 职位序列 /
 *   实习生预计结束时间 / 实习生服务时长（天）/ 实习生预算使用金额 / 需求负责人 /
 *   职务 / 需求类型 / 职位类别
 * 页面顶部另有「审批状态」，底部有「审批信息」时间线与「操作记录」。
 * 空值一律渲染为 "--"，必须当空处理（见 EMPTY_PLACEHOLDER）。
 */

var SHEET_COLUMN_MAP = [
  {
    col: 'A',
    header: '0级部门\r\nLevel 0 Department',
    // 校准结论：飞书「需求部门」只渲染【叶子部门名】（如「ACME中国1」「质量控制组」），
    // DOM 上是 span.bpmBiz_atsx_clamp-label，无 title、无 aria-label、无完整路径，
    // 详情页里【拿不到】0/1 级层级。故不再按分隔符切分（那是臆想出来的格式）。
    // 走法：用 DEPT_LEVEL_LOOKUP 把叶子部门名映射到 0/1 级；查不到就留空并计入 unmapped。
    // 映射表由 HR 维护（组织架构来源：总结\示例 HR组织架构.docx）。
    sources: ['需求部门'],
    transform: function (v) { return deptLevel(v, 0); },
  },
  {
    col: 'B',
    header: '1级部门\r\nLevel 1 Department',
    sources: ['需求部门'],
    transform: function (v) { return deptLevel(v, 1); },
  },
  {
    col: 'C',
    header: '职位名称\r\nJob Title',
    sources: ['需求名称', '职位名称'],
  },
  {
    col: 'D',
    header: '关键岗位\r\nCritical Position',
    // 校准确认：详情页无此字段。近名的两个都不是它——
    // 「是否保密岗位」是保密标记，「关键项目」是项目名。留空，人工填。
    sources: [],
    unmapped: true,
  },
  {
    col: 'E',
    header: '紧急度\r\nUrgency Level',
    // 校准确认：本租户需求详情【没有】紧急度/优先级字段。留空，人工填。
    sources: [],
    unmapped: true,
  },
  {
    col: 'F',
    header: '级别\r\nJob Level',
    // 校准确认：字段名是「职级」（样本值 P5-1），不是「职等」。职等保留作兜底。
    sources: ['职级', '职等'],
  },
  {
    col: 'G',
    header: '工作地\r\nBase Location',
    sources: ['工作地点', '城市'],
  },
  {
    col: 'H',
    header: '上级\r\nHiring Manager',
    // 校准修正：实际字段名是「直属上级」。原写的「汇报对象/用人经理」两个都不存在，
    // 照原样上线这一列会全空。保留作兜底以防租户差异。
    sources: ['直属上级', '汇报对象', '用人经理'],
  },
  {
    col: 'I',
    header: '招聘原因\r\nReason',
    // 校准：详情页有「需求类型」（新增/替换）与「增补原因」（替换/…）两个字段。
    // 需求类型是主口径，增补原因是补充说明；无独立的「招聘原因」字段。
    sources: ['需求类型', '增补原因', '招聘原因'],
  },
  {
    col: 'J',
    header: 'HC类别\r\nHC Type',
    // 校准：实际字段是「人员类型」（正式员工/外包），提到首位。
    sources: ['人员类型', '编制类型', 'HC类别', '用工形式'],
  },
  {
    col: 'K',
    header: '审批具体时间\r\nReq Approval Date',
    // 校准结论：审批时间【不在基本信息区】，而在页面底部「审批信息」时间线里。
    // 时间线每个节点形如：人名 / 节点名 / YYYY-MM-DD HH:mm / 状态(发起|已通过|抄送)。
    // 取【最后一个状态为「已通过」的节点】的时间，样本 R00057 → 2025-09-24 14:25。
    // 提取器负责把它合成为虚拟字段「审批通过时间」再喂给本映射表。
    sources: ['审批通过时间', '审批时间', '审批日期'],
    transform: function (v) { return normalizeDate(v); },
  },
  {
    col: 'L',
    header: 'Lead Time cutoff 180D',
    // 计算列 = K + 180 天；K 空则留空
    sources: [],
    compute: function (row) {
      var kVal = row['K'];
      if (!kVal) return '';
      try {
        var d = parseDate(kVal);
        if (!d) return '';
        d.setDate(d.getDate() + 180);
        return formatDate(d);
      } catch (e) { return ''; }
    },
  },
  {
    col: 'M',
    header: '招聘启动日期\r\nHiring Kick Off Date',
    sources: ['开始日期'],
    transform: function (v) { return normalizeDate(v); },
  },
  {
    col: 'N',
    header: '预期到岗时间\r\nExpected Onboard Time',
    // 校准修正：实际字段名是「期望到岗时间」，且值可能是【月粒度】（样本 R00011 → "2024-07"）。
    // normalizeDate 对 YYYY-MM 原样保留，不许补成 YYYY-MM-01（那是编造精度）。
    sources: ['期望到岗时间', '期望候选人到岗时间', '预计到岗时间'],
    transform: function (v) { return normalizeDate(v); },
  },
  {
    col: 'O',
    header: '招聘需求编号\r\nReq#',
    sources: ['需求编号'],
    required: true,   // dedup key；空则整行跳过
  },
];

// ==================== 辅助函数 ====================

/**
 * 飞书的空值占位符。详情页所有空字段都渲染成 "--"，
 * 直接写进 Excel 会得到一列 "--"，比留空更糟（看起来像有值）。
 */
var EMPTY_PLACEHOLDER = /^(--|—|-{1,2}|\s*)$/;
function cleanValue(v) {
  if (v == null) return '';
  var s = String(v).trim();
  return EMPTY_PLACEHOLDER.test(s) ? '' : s;
}

/**
 * 叶子部门名 → 0级/1级部门。
 *
 * 为什么需要查表：飞书需求详情的「需求部门」只有叶子名（「ACME中国1」「质量控制组」），
 * DOM 里没有任何完整路径信息，层级推不出来。硬猜等于往表里写假数据。
 *
 * 维护方式：HR 按组织架构补全下表；查不到就留空 + 计入 unmapped 报告，
 * 让人一眼看到"哪些部门还没登记"，而不是悄悄写错。
 */
var DEPT_LEVEL_LOOKUP = {
  // 'ACME中国1': { level0: 'ACME', level1: 'ACME中国1' },
};

function deptLevel(v, level) {
  var name = cleanValue(v);
  if (!name) return '';
  var hit = DEPT_LEVEL_LOOKUP[name];
  if (!hit) return '';
  return (level === 0 ? hit.level0 : hit.level1) || '';
}

/**
 * 部门路径分段（"研发部 / 平台组 / AI小组" → 取第 N 段）
 * 保留：其它租户/入口若能给出带分隔符的完整路径，可复用此函数。
 * 本租户需求详情页给不出路径，A/B 列改走 DEPT_LEVEL_LOOKUP。
 */
function splitDeptLevel(v, level) {
  if (!v) return '';
  var parts = String(v).split(/[/＼>／＞,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  return parts[level] || '';
}

/**
 * 日期标准化 → YYYY-MM-DD
 * 支持常见格式：YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日 / MM/DD/YYYY 等
 */
function normalizeDate(v) {
  var s = cleanValue(v);
  if (!s) return '';
  // 已是 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 月粒度（飞书「期望到岗时间」样本 "2024-07"）：原样保留。
  // 补成 2024-07-01 是在编造页面上没有的精度，下游按天算 Lead Time 会算错。
  if (/^\d{4}-\d{1,2}$/.test(s)) return s;
  // 带时分（审批时间线 "2025-09-24 14:25"）：只取日期部分，由下面的 parseDate 处理
  var d = parseDate(s);
  if (!d) return s;   // 无法解析时原样返回，不截断有用信息
  return formatDate(d);
}

function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  var m;
  // YYYY-MM-DD 或 YYYY/MM/DD
  m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  // YYYY年MM月DD日
  m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  // MM/DD/YYYY（美式）
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
  return null;
}

function formatDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// 导出（CommonJS 环境下可用，浏览器 inline 时依赖外层作用域直接访问变量）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SHEET_COLUMN_MAP, splitDeptLevel, normalizeDate, parseDate, formatDate,
    cleanValue, deptLevel, DEPT_LEVEL_LOOKUP, EMPTY_PLACEHOLDER,
  };
}
