/**
 * 飞书招聘需求提取引擎 —— 单一真源
 *
 * 同时供：
 *   · tools/feishu-req-sheet-sync/  (reqsheet:扩展 content script inline)
 *   · extension/feishu-req2job/     (feishu-ext:build inline)
 *
 * ⚠️ 本文件是 IIFE 独立闭包，不向全局挂任何符号；
 *    构建脚本把它 inline 进更大的 IIFE，所以顶层 var 对调用方可见。
 *    只暴露以下几个符号（其它保持私有）：
 *      KNOWN_REQ_FIELDS   — 字段名白名单数组
 *      norm               — 标准化字符串（去不可见字符 + 去标点空白）
 *      clean              — 压缩空白
 *      detailRoot         — 详情容器定位
 *      itemsFrom          — 可见表单项枚举
 *      extractFrom        — 主提取入口，返回 {字段名: 值} 对象
 *      orderKeys          — 按已知字段排序 keys
 *      autoMatch          — 字段名 → 表格列名的自动映射
 */

// ==================== 工具函数 ====================

function stripInvisible(s) {
  var str = String(s == null ? '' : s), out = '';
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if ((c >= 0x200B && c <= 0x200F) || c === 0xFEFF) continue;
    out += str.charAt(i);
  }
  return out;
}

function norm(s) {
  return stripInvisible(s).replace(/[\s:：*]/g, '').trim();
}

function clean(s) {
  return stripInvisible(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function vis(el) {
  try { return !!el && el.offsetParent !== null && el.getClientRects().length > 0; } catch (e) { return false; }
}

function txt(el) {
  if (!el) return '';
  var t = '';
  try { t = el.innerText; } catch (e) {}
  if (!t) { try { t = el.textContent; } catch (e) {} }
  return clean(t);
}

// ==================== 已知字段白名单 ====================

// 并集：_shared（reqsheet 用）+ req2job（职位填充用）两份分叉的并集。
// 任何一侧新增字段都应加到这里，让两个工具共享同一份白名单。
var KNOWN_REQ_FIELDS = [
  // 核心字段（两侧共有）
  '需求名称', '需求编号', '需求状态', '增补原因', '人员类型', '需求部门', '所属部门', '用人部门',
  '职级', '职位类别', '职位序列', '工作地点', '需求人数', '招聘人数', '需求提出人', '用人经理',
  '招聘负责人', '汇报对象', '开始日期', '期望候选人到岗时间', '职位职责', '岗位职责', '职位描述',
  '职位要求', '任职要求', '业务影响', '关键项目', '学历要求', '经验要求', '薪资范围', '优先级',
  // reqsheet 侧独有（城市/工作经验等在真机详情页上出现过）
  '城市', '工作经验', '最低学历', '招聘数量', '职能类型', '职位性质', '职等', '职类',
  '需求紧急度', '编制类型', '用工形式', '预计到岗时间',
  // 审批相关（reqsheet 需要）
  '审批通过时间', '审批时间', '审批状态', '审批日期',
  // req2job 侧独有（职位填充时用到的附加字段）
  '招聘类型', '需求负责人', '直属上级', '期望到岗时间', '所属成本中心',
  '是否保密岗位', '职务', '职责', '替换人员', '替换人员最后工作日',
];

function isKnownField(k) {
  var n = norm(k);
  for (var i = 0; i < KNOWN_REQ_FIELDS.length; i++) if (norm(KNOWN_REQ_FIELDS[i]) === n) return true;
  return false;
}

var NOISE_KEY = /^(操作|更多|编辑|删除|关闭|取消|确定|保存|提交|全选|序号|新建|导出|筛选|搜索|重置|展开|收起|复制|详情|返回|上一页|下一页|共|第|查看|下载|上传|导入|刷新|设置|帮助|反馈)/;

// ==================== 详情容器定位 ====================

function detailRoot() {
  var cands = [].slice.call(document.querySelectorAll(
    '[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"],[class*="detail"],[class*="Detail"]'
  )).filter(vis);
  var best = null, bs = 0;
  cands.forEach(function (c) {
    var s = 0;
    try { s = c.querySelectorAll('*').length; } catch (e) {}
    var t = txt(c);
    if (t.length < 30) return;
    if (s >= bs) { bs = s; best = c; }
  });
  return best || document.body;
}

// ==================== 表单提取 ====================

var ITEM_SEL = '[class*="formily-item"],[class*="form__item"],[class*="form-item"],.ud-form-item';
var LABEL_SEL = '[class*="formily-item-label"],label,[class*="form__item-label"],[class*="item-label"],[class*="field-label"],[class*="form__label"]';
var CONTROL_SEL = 'input,textarea,[contenteditable="true"],[contenteditable=""],[class*="select__selector"],[class*="tree-select"],[class*="treeSelect"],[class*="cascader"]';

function hasControl(el) { try { return !!el.querySelector(CONTROL_SEL); } catch (e) { return false; } }
function hasLabel(el) {
  try { var le = el.querySelector(LABEL_SEL); return !!(le && txt(le)); } catch (e) { return false; }
}

function itemsFrom(root) {
  var all = [];
  try { all = [].slice.call(root.querySelectorAll(ITEM_SEL)).filter(vis); } catch (e) { return []; }
  var cands = all.filter(hasControl);
  var labeled = [];
  for (var i = 0; i < cands.length; i++) labeled.push(hasLabel(cands[i]));
  return cands.filter(function (a, ai) {
    for (var j = 0; j < cands.length; j++) {
      if (j === ai) continue;
      var b = cands[j];
      try {
        if (labeled[j] && a.contains(b)) return false;
        if (labeled[j] && !labeled[ai] && b.contains(a)) return false;
      } catch (e) {}
    }
    return true;
  });
}

function labelOf(item) {
  var le = null;
  try { le = item.querySelector(LABEL_SEL); } catch (e) {}
  var t = le ? txt(le) : '';
  if (!t) return '';
  return t.replace(/[*\s:：]+$/g, '').replace(/^\s*\*\s*/, '').trim();
}

function detectType(item) {
  try {
    if (item.querySelector('[class*="tree-select"],[class*="treeSelect"],[class*="throne-biz-location"]')) return 'tree';
    if (item.querySelector('[class*="cascader"]')) return 'cascader';
    if (item.querySelector('.ud__select__selector,[class*="select__selector"]')) return 'select';
    if (item.querySelector('textarea')) return 'textarea';
    if (item.querySelector('[contenteditable="true"],[contenteditable=""]')) return 'editor';
    var inp = item.querySelector('input');
    if (inp) {
      if (inp.type === 'number') return 'number';
      if (/YYYY|日期|时间/.test(inp.placeholder || '')) return 'date';
      return 'text';
    }
  } catch (e) {}
  return 'unknown';
}

function readSelectDisplay(item) {
  var sel = null;
  try { sel = item.querySelector('.ud__select__selector,[class*="select__selector"]'); } catch (e) {}
  if (sel) {
    var v = null;
    try { v = sel.querySelector('[class*="selection-item"],[class*="select__value"],[class*="single"],[class*="tag"]'); } catch (e) {}
    var t = txt(v || sel);
    if (!t || /^请选择|^请输入/.test(t)) return '';
    return t;
  }
  var inp = null;
  try { inp = item.querySelector('input'); } catch (e) {}
  return inp ? clean(inp.value) : '';
}

function readItemValue(item, type) {
  var t = type || detectType(item);
  try {
    if (t === 'select' || t === 'tree' || t === 'cascader') return readSelectDisplay(item);
    if (t === 'textarea') { var ta = item.querySelector('textarea'); return ta ? clean(ta.value) : ''; }
    if (t === 'editor') { var ce = item.querySelector('[contenteditable="true"],[contenteditable=""]'); return ce ? txt(ce) : ''; }
    var inp = item.querySelector('input');
    return inp ? clean(inp.value) : '';
  } catch (e) { return ''; }
}

// ==================== 只读详情提取 ====================

function keyConfidence(n, key) {
  if (isKnownField(key)) return 2;
  var t = txt(n);
  if (/[:：]\s*$/.test(t)) return 2;
  var cls = '';
  try { cls = String(n.className || '') + ' ' + String((n.parentElement && n.parentElement.className) || ''); } catch (e) {}
  if (/label|key|title|name|field/i.test(cls) && !/value|content/i.test(String(n.className || ''))) return 2;
  try {
    var p = n.parentElement;
    if (p && p.children && p.children.length === 2 && p.children[0] === n) return 1;
  } catch (e) {}
  return 0;
}

function valueNear(n) {
  var cands = [];
  try { if (n.nextElementSibling) cands.push(n.nextElementSibling); } catch (e) {}
  try {
    var p = n.parentElement;
    if (p) {
      var sibs = [].slice.call(p.children || []);
      for (var i = 0; i < sibs.length; i++) if (sibs[i] !== n && !sibs[i].contains(n)) cands.push(sibs[i]);
      if (p.nextElementSibling) cands.push(p.nextElementSibling);
    }
  } catch (e) {}
  for (var j = 0; j < cands.length; j++) {
    var c = cands[j];
    try { if (c.querySelector(LABEL_SEL) || c.querySelector('[class*="label"],[class*="Label"]')) continue; } catch (e) {}
    var t = txt(c);
    if (t && t.length <= 4000) return { el: c, text: t };
  }
  return null;
}

function isOurs(el) {
  // 占位：调用方需在外层覆盖此函数以过滤自己注入的 UI
  return false;
}

function scanReadonly(root, out) {
  var nodes = [];
  try { nodes = [].slice.call(root.querySelectorAll('div,span,td,li,dt,dd,label,p,h4,h5')); } catch (e) { return; }
  var consumed = [];
  function isConsumed(el) { for (var i = 0; i < consumed.length; i++) if (consumed[i] === el) return true; return false; }
  for (var i = 0; i < nodes.length && Object.keys(out).length < 100; i++) {
    var n = nodes[i];
    if (isConsumed(n) || isOurs(n)) continue;
    var kids = 0;
    try { kids = n.children.length; } catch (e) {}
    if (kids > 0) continue;
    if (!vis(n)) continue;
    var t = txt(n);
    if (!t || t.length > 30) continue;
    var key = t.replace(/[:：*\s]+$/g, '').trim();
    if (!key || key.length < 2 || key.length > 18) continue;
    if (!/[一-龥A-Za-z0-9]/.test(key)) continue;
    if (NOISE_KEY.test(key)) continue;
    if (out[key]) continue;
    try {
      var tg = n.tagName ? String(n.tagName).toLowerCase() : '';
      if (tg === 'th') continue;
      if (n.closest && n.closest('table,thead,[role="table"],[role="columnheader"],[class*="thead"]')) continue;
    } catch (e) {}
    if (!keyConfidence(n, key)) continue;
    var pair = valueNear(n);
    if (!pair || !pair.text || pair.text === key) continue;
    var v = pair.text;
    if (v.length > 5000) v = v.slice(0, 5000);
    if (/^请选择|^请输入|^--$|^-$/.test(v)) continue;
    out[key] = v;
    consumed.push(pair.el);
  }
}

// ==================== 表格行提取 ====================

function extractFromRow(row, out) {
  var cells = [];
  try { cells = [].slice.call(row.querySelectorAll('td,[role="cell"],[class*="cell"]')).filter(function (c) { return vis(c); }); } catch (e) {}
  if (!cells.length) return false;
  cells = cells.filter(function (a) {
    for (var i = 0; i < cells.length; i++) if (cells[i] !== a && a.contains(cells[i])) return false;
    return true;
  });
  var heads = [];
  try {
    var table = row.parentElement ? row.parentElement.closest('table,[role="table"],[class*="table"]') : null;
    if (table) {
      heads = [].slice.call(table.querySelectorAll('th,[role="columnheader"],[class*="header-cell"],[class*="thead"] [class*="cell"]'))
        .filter(function (h) { return vis(h); })
        .map(function (h) { return txt(h).replace(/[:：*\s]+$/g, ''); });
    }
  } catch (e) {}
  var got = false;
  for (var i = 0; i < cells.length; i++) {
    var key = heads[i] || ('列' + (i + 1));
    var val = txt(cells[i]);
    if (!val || NOISE_KEY.test(key)) continue;
    if (!out[key]) { out[key] = val; got = true; }
  }
  return got;
}

function inToolbar(el) {
  var n = el, hops = 0;
  while (n && hops < 6) {
    try {
      var cls = String(n.className || '');
      if (/toolbar|filter|search|topbar|nav|tabs|breadcrumb/i.test(cls)) return true;
    } catch (e) {}
    try { n = n.parentElement; } catch (e) { break; }
    hops++;
  }
  return false;
}

// ==================== 主提取入口 ====================

// 飞书需求【详情页】的结构化字段行。真机确认 2026-08-10：
//
//   <div class="atsxPc_fieldLine">
//     <div class="atsxPc_fieldLine-label">  <span class="bpmBiz_atsx_clamp-label">需求编号</span></div>
//     <div class="atsxPc_fieldLine-content"><span class="bpmBiz_atsx_clamp-label">R00011</span></div>
//   </div>
//
// 为什么必须单独走这条路：飞书用【同一个组件类 bpmBiz_atsx_clamp-label】渲染标签和值，
// 而通用的 valueNear() 有条"候选里含 [class*=label] 就跳过"的护栏（本意是别把邻近的另一个
// 标签误当成值）—— 在这个页面上它把【每一个值】都当成标签跳掉了：页面 27 个 fieldLine，
// 通用路径提取到 0 个真字段，却把「关联职位」卡片名和别的插件面板文字当成了字段。
// 结构化路径同时解决准确率和噪音：只认 fieldLine，天然不碰卡片区和注入 UI。
//
// 类名选择：atsxPc_/bpmBiz_ 前缀的类没有构建期哈希，相对稳定；
// 同层的 baseInfoContainer__1aEj_ / approvalInfoHeader__2MZxI 带 CSS-module 哈希，不可依赖。
var FIELD_LINE_SEL = '.atsxPc_fieldLine';
var FIELD_LABEL_SEL = '.atsxPc_fieldLine-label';
var FIELD_VALUE_SEL = '.atsxPc_fieldLine-content';
// 基本信息区容器：把提取范围收在它里面，避免扫到「关联职位」卡片与页面上别的面板
var FIELD_SCOPE_SEL = '.atsxPc_jrContent';

function extractFieldLines(root) {
  var out = {};
  var scope = root;
  try {
    var scoped = (root.querySelector && root.querySelector(FIELD_SCOPE_SEL))
      || (root.closest && root.closest(FIELD_SCOPE_SEL));
    if (scoped) scope = scoped;
  } catch (e) {}
  var lines = [];
  try { lines = [].slice.call(scope.querySelectorAll(FIELD_LINE_SEL)); } catch (e) { return out; }
  for (var i = 0; i < lines.length; i++) {
    var lab = null, val = null;
    try {
      lab = lines[i].querySelector(FIELD_LABEL_SEL);
      val = lines[i].querySelector(FIELD_VALUE_SEL);
    } catch (e) { continue; }
    if (!lab || !val) continue;
    var key = txt(lab).replace(/[:：*\s]+$/g, '').trim();
    var v = txt(val);
    if (!key || !v) continue;
    // 飞书的空值占位。写进表会得到一列 "--"，比留空更糟（看着像有值）
    if (/^(--|—|-)$/.test(v)) continue;
    if (NOISE_KEY.test(key)) continue;
    if (!out[key]) out[key] = v;
  }
  return out;
}

function extractFrom(root) {
  var out = {};
  // 0) 飞书需求详情页的结构化字段行（最精确，优先）
  var fl = extractFieldLines(root);
  if (Object.keys(fl).length >= 2) return fl;
  // 1) 编辑态表单项
  var items = itemsFrom(root);
  items.forEach(function (it) {
    if (inToolbar(it) || isOurs(it)) return;
    var l = labelOf(it);
    if (!l || NOISE_KEY.test(l)) return;
    var v = readItemValue(it);
    if (v) out[l] = v;
  });
  // 2) 表格行
  if (Object.keys(out).length < 2) {
    var isRow = false;
    try {
      isRow = root.tagName && (String(root.tagName).toLowerCase() === 'tr'
        || (root.getAttribute && root.getAttribute('role') === 'row')
        || /(^|\s|_)row/i.test(String(root.className || '')));
    } catch (e) {}
    if (isRow) extractFromRow(root, out);
  }
  // 3) 只读详情
  if (Object.keys(out).length < 2) scanReadonly(root, out);
  return out;
}

// ==================== 键排序 ====================

function orderKeys(obj) {
  var known = [], rest = [];
  Object.keys(obj).forEach(function (k) { (isKnownField(k) ? known : rest).push(k); });
  known.sort(function (a, b) {
    var ia = -1, ib = -1;
    for (var i = 0; i < KNOWN_REQ_FIELDS.length; i++) {
      if (norm(KNOWN_REQ_FIELDS[i]) === norm(a)) ia = i;
      if (norm(KNOWN_REQ_FIELDS[i]) === norm(b)) ib = i;
    }
    return ia - ib;
  });
  return known.concat(rest);
}

// ==================== 自动映射（字段名 → 表格列名） ====================

function autoMatch(fields, headers) {
  var result = [];
  var usedCols = {};
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    var mapped = null;
    // 1. 精确匹配
    for (var h1 = 0; h1 < headers.length && !mapped; h1++) {
      if (!usedCols[headers[h1].col] && norm(headers[h1].name) === norm(field)) {
        mapped = { col: headers[h1].col, colName: headers[h1].name, type: 'exact' };
      }
    }
    // 2. 前缀匹配
    for (var h2 = 0; h2 < headers.length && !mapped; h2++) {
      if (usedCols[headers[h2].col]) continue;
      var hn2 = norm(headers[h2].name);
      var fn2 = norm(field);
      if (fn2.length < 2 || hn2.length < 2) continue;
      if (hn2.indexOf(fn2) === 0 || fn2.indexOf(hn2) === 0) {
        mapped = { col: headers[h2].col, colName: headers[h2].name, type: 'prefix' };
      }
    }
    // 3. 模糊匹配（≥4字符）
    for (var h3 = 0; h3 < headers.length && !mapped; h3++) {
      if (usedCols[headers[h3].col]) continue;
      var hn3 = norm(headers[h3].name);
      var fn3 = norm(field);
      if (fn3.length < 4 || hn3.length < 3) continue;
      if (hn3.indexOf(fn3) !== -1 || fn3.indexOf(hn3) !== -1) {
        mapped = { col: headers[h3].col, colName: headers[h3].name, type: 'fuzzy' };
      }
    }
    if (mapped) { usedCols[mapped.col] = true; result.push({ fieldName: field, col: mapped.col, colName: mapped.colName, matchType: mapped.type }); }
    else { result.push({ fieldName: field, col: null, colName: null, matchType: 'none' }); }
  }
  return result;
}

// 导出（CommonJS 环境下可用，浏览器 inline 时依赖外层作用域直接访问变量）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KNOWN_REQ_FIELDS: KNOWN_REQ_FIELDS,
    norm: norm,
    clean: clean,
    detailRoot: detailRoot,
    itemsFrom: itemsFrom,
    extractFrom: extractFrom,
    extractFieldLines: extractFieldLines,
    orderKeys: orderKeys,
    autoMatch: autoMatch,
  };
}
