/**
 * 飞书需求 → 表格汇总  v1.0.0 — 扩展打包版
 *
 * ⚠ 本文件由 scripts/build-reqsheet-ext.mjs 自动生成，不要手改。
 *   改源：extension/feishu-req-sheet-sync/src/content.js（主逻辑）
 *         tools/_shared/req-extract.js（提取引擎，单一真源）
 *   重建：npm run reqsheet-ext:build
 *
 * 行为边界：
 *   · 只读飞书招聘，绝不提交/修改任何内容
 *   · 只与 127.0.0.1:17386 通信（本地桥）
 *   · 不存储任何 PII
 */
/**
 * feishu-req-sheet-sync  content script  v1.0.0
 *
 * 流程：
 *   1. 接收 background 的 REQSHEET_START 消息
 *   2. 检测页面状态（logged-in / need-login / gateway-blocked）
 *   3. logged-in → 枚举需求列表（虚拟化滚动）
 *   4. 过滤：审批通过 + 不在 knownReqIds 里
 *   5. 逐条打开详情提取字段
 *   6. 批量上报 rows 到 background → 主进程写 Excel
 *
 * 租户：固定 acme（生产），demo 是测试租户，不要写死
 * 行为边界：只读飞书，绝不提交/修改任何内容
 */
(function () {
  'use strict';

  var EXT_ID = 'feishu-req-sheet-sync';
  var BANNER_ID = 'ta-rss-banner';
  var MAX_SCROLL_ROUNDS = 60;   // 虚拟化列表最多滚动 60 轮（防无限）
  var LOGIN_TIMEOUT_MANUAL = 15 * 60 * 1000;
  var LOGIN_TIMEOUT_SCHEDULED = 5 * 60 * 1000;
  var DETAIL_DELAY_MIN = 1500;
  var DETAIL_DELAY_MAX = 4000;
  var DEFAULT_MAX_PER_RUN = 50;

  // ——— 沙箱垫片（仅扩展环境）———
  var CONFIG = { debug: false };
  // 开启调试日志：先在控制台运行 localStorage.setItem('ta-rss:debug','1')，然后刷新页面；
  // 关闭：localStorage.removeItem('ta-rss:debug') 后刷新。
  try { CONFIG.debug = localStorage.getItem('ta-rss:debug') === '1'; } catch (e) {}

  function log() {
    if (!CONFIG.debug) return;
    try { console.log.apply(console, ['[' + EXT_ID + ']'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function rand(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

  // ==================== 页面状态检测 ====================

  function detectPageState() {
    var host = location.hostname || '';
    var path = location.pathname || '';
    var href = location.href || '';

    // 网关拦截（企业安全浏览器）
    if (/office-sec\.alibaba-inc\.com/i.test(host)
        || /procTags=software::250/.test(href)
        || /secure-browser|安全访问|安全浏览器/i.test(document.title || '')) {
      return 'gateway-blocked';
    }

    // 登录/验证页
    if (/\/accounts\//i.test(path)
        || /passport/i.test(host)
        || /login\.feishu\.cn/i.test(host)
        || (/feishu\.cn/i.test(host) && /\/login/i.test(path))
        || document.querySelector('[class*="login"],[class*="Login"],[id*="login"]')) {
      return 'need-login';
    }

    // 需求列表页已加载（有列表容器）
    if (/\/hire\//i.test(path)) {
      var listContainer = document.querySelector(
        '[class*="requirement"],[class*="reqList"],[class*="req-list"],[class*="listContent"],[class*="list-content"]'
      );
      var rows = document.querySelectorAll('[class*="list-item"],[class*="listItem"],[role="row"],[class*="table-row"]');
      if (listContainer || rows.length > 0) return 'logged-in';
      // 页面存在但列表未加载完，返回 loading
      return 'loading';
    }

    return 'unknown';
  }

  // ==================== 登录等待 ====================

  function showBanner(html) {
    removeBanner();
    var div = document.createElement('div');
    div.id = BANNER_ID;
    div.style.cssText = [
      'position:fixed;top:12px;right:12px;z-index:2147483647',
      'background:#1a1a2e;color:#e8e8e8;border-radius:8px;padding:12px 16px',
      'font-size:13px;line-height:1.6;max-width:320px',
      'box-shadow:0 4px 16px rgba(0,0,0,.4);font-family:system-ui,sans-serif',
    ].join(';');
    div.innerHTML = html;
    document.body.appendChild(div);
  }

  function removeBanner() {
    var b = document.getElementById(BANNER_ID);
    if (b) b.remove();
  }

  async function waitForLogin(timeoutMs, scheduled) {
    var deadline = Date.now() + timeoutMs;
    var dotCount = 0;
    while (Date.now() < deadline) {
      var state = detectPageState();
      if (state === 'logged-in' || state === 'loading') return true;
      if (state === 'gateway-blocked') return false;
      dotCount = (dotCount + 1) % 4;
      var dots = '.'.repeat(dotCount + 1);
      showBanner('⏳ 等待登录中' + dots + '<br><small>登录后自动继续</small>');
      await sleep(3000);
    }
    if (scheduled) {
      showBanner('⏱ 定时任务等待登录超时（5分钟），已自动取消。<br>请手动运行。');
    }
    return false;
  }

  // ==================== 需求列表枚举（虚拟化滚动） ====================

  /**
   * 从一行 DOM 提取 需求编号 + 需求状态
   * UNVERIFIED: 选择器需真机验证
   */
  /**
   * 从列表行读需求编号与审批状态。
   *
   * ⚠️ 真机格式（2026-08-10 实测）：编号是 **R00011** 这种，渲染成
   * 「需求编号 R00011」贴在名称下面，不是独立单元格。
   * 此前只认 /^REQ-?\d+/（REQ-123 那种臆想格式），结果 id 恒为空 →
   * enumerateRequirements 里 `if (d.id && ...)` 永不成立 → 每次都报
   * 「无新增审批通过需求」。整个功能是哑的，且哑得很像"正常无更新"。
   *
   * ⚠️ 不要用 tr[data-row-key]：实测它不是详情页 ID，导航过去是一条空白草稿。
   */
  var REQ_NO_RE = /需求编号[\s:：]*([A-Za-z][A-Za-z0-9\-_]*\d[A-Za-z0-9\-_]*)/;

  function extractRowData(row) {
    var result = { id: '', reqNo: '', status: '', name: '', el: row };
    var rowText = '';
    try { rowText = row.innerText || row.textContent || ''; } catch (e) {}

    // 需求名称：行内第一个 clamp span（实测就是名称列）。
    // 详情页的「基本信息」里【没有】需求名称字段——标题只在页面 H1 上，
    // 所以 C 列（职位名称）的值必须从列表行带过去。
    try {
      var nameEl = row.querySelector('span.throne-biz-clamp-content')
        || row.querySelector('[class*="clamp-content"]');
      if (nameEl) result.name = (nameEl.innerText || '').trim();
    } catch (e) {}

    var m = rowText.match(REQ_NO_RE);
    if (m) result.reqNo = m[1].trim();
    if (!result.reqNo) {
      // 兜底：某些租户可能把编号放进独立单元格
      var cells = [];
      try {
        cells = [].slice.call(row.querySelectorAll('td,[role="cell"],[class*="cell"]'))
          .filter(function (c) { return !!c && c.offsetParent !== null; });
      } catch (e) {}
      for (var i = 0; i < cells.length; i++) {
        var t = (cells[i].innerText || cells[i].textContent || '').trim();
        if (/^(REQ[-—]?\d+|[A-Za-z]\d{3,})$/i.test(t)) { result.reqNo = t; break; }
      }
    }
    // id 用作枚举去重键；就用需求编号，它在本页面上是唯一的业务主键
    result.id = result.reqNo;

    if (/审批通过|已通过/.test(rowText)) result.status = '审批通过';
    else {
      var sm = rowText.match(/(待审批|审批中|驳回|未通过|撤回|已撤回|未发起|草稿)/);
      if (sm) result.status = sm[1];
    }
    return result;
  }

  function getListRows() {
    return [].slice.call(document.querySelectorAll(
      '[class*="requirement-list"] tr,[class*="reqList"] tr,[class*="list-item"],[role="row"]'
    )).filter(function (r) {
      // 排除表头
      try { if (r.querySelector('th,[role="columnheader"]')) return false; } catch (e) {}
      return r.offsetParent !== null;
    });
  }

  async function enumerateRequirements() {
    // 等待列表容器出现
    for (var w = 0; w < 30; w++) {
      if (getListRows().length > 0) break;
      await sleep(500);
    }

    var seen = new Set();
    var allRows = [];
    var prevCount = -1;
    var stableRounds = 0;

    for (var round = 0; round < MAX_SCROLL_ROUNDS; round++) {
      var rows = getListRows();
      var newItems = 0;
      for (var i = 0; i < rows.length; i++) {
        var d = extractRowData(rows[i]);
        if (d.id && !seen.has(d.id)) {
          seen.add(d.id);
          allRows.push(d);
          newItems++;
        }
      }
      if (rows.length === prevCount) {
        stableRounds++;
        if (stableRounds >= 3) break;  // 连续 3 轮没变化 = 到底了
      } else {
        stableRounds = 0;
        prevCount = rows.length;
      }
      // 滚动到底
      var scrollTarget = document.querySelector(
        '[class*="requirement"],[class*="reqList"],[class*="listContent"],[class*="scrollable"]'
      ) || document.documentElement;
      scrollTarget.scrollTop = scrollTarget.scrollHeight;
      await sleep(600);
    }

    if (stableRounds < 3 && allRows.length > 0) {
      // 触发了上限，记录 warn
      log('[WARN] 列表枚举触发滚动上限 ' + MAX_SCROLL_ROUNDS + ' 轮，可能未全量，已枚举 ' + allRows.length + ' 条');
      chrome.runtime.sendMessage({ type: 'REQSHEET_STATE', state: 'scanning-capped', extra: { enumerated: allRows.length } });
    }

    return allRows;
  }

  // ==================== 详情提取 ====================

  // 内联 tools/_shared/req-extract.js（由构建脚本替换此占位）
  // ——— req-extract.js (inlined, single source of truth) ———
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
  // ——— end req-extract ———

  // 详情页路由。真机确认（2026-08-10）：需求详情是【整页路由】，不是抽屉。
  var DETAIL_PATH_RE = /\/hire\/job\/requirement\/(\d{6,})/;

  function currentDetailId() {
    var m = location.pathname.match(DETAIL_PATH_RE);
    return m ? m[1] : null;
  }

  /**
   * 点开一行的详情。
   *
   * 真机确认：需求名称【不是 <a>】，是 span.throne-biz-clamp-content，靠 React 点击处理器
   * 做 SPA 跳转。此前按 'a,[class*="name"],[class*="title"]' 找，一个都命中不了，
   * 会退化成 row.click()（点在单元格空白处，不跳转）——整条链路就卡在这。
   *
   * 另注：行上的 data-row-key 【不是】详情页 ID（实测导航过去是一条空白草稿），
   * 不要拿它拼 URL。真 ID 只能在跳转后从 location.pathname 里读。
   */
  function clickRow(row) {
    try {
      var el = row.querySelector('span.throne-biz-clamp-content')
        || row.querySelector('[class*="clamp-content"]')
        || row.querySelector('a,[class*="name"],[class*="title"]');
      if (el) { el.click(); return true; }
      row.click();
      return true;
    } catch (e) { return false; }
  }

  /**
   * 从页面底部「审批信息」时间线里取审批通过时间。
   *
   * 真机结构（2026-08-10）：每个节点是 人名 / 节点名 / YYYY-MM-DD HH:mm / 状态，
   * 状态取值见过 发起 / 已通过 / 抄送。样本 R00057：
   *   王瑞1 开始 2025-09-24 14:24 发起
   *   王瑞1 Department Leader 2025-09-24 14:25 已通过   ← 取这一类里的最后一个
   *   王瑞1 TA 2025-09-24 14:25 已通过
   *   王瑞1 抄送 1 2025-09-24 14:25 抄送
   * 它【不在基本信息区】，label/value 扫描扫不到，必须单独合成。
   */
  /**
   * 「审批信息」区是否已经渲染出来。
   *
   * SPA 换页时基本信息区先渲染、审批区后到；不等它就读，K 列永远是空
   * （实测：整页直接打开能读到 2025-09-24 14:25，SPA 循环里 10 条全空）。
   */
  function approvalSectionReady() {
    try {
      var text = document.body.innerText || '';
      var idx = text.indexOf('审批信息');
      if (idx < 0) return false;
      var tail = text.slice(idx);
      var opIdx = tail.indexOf('操作记录');
      if (opIdx > 0) tail = tail.slice(0, opIdx);
      // 区块里出现过时间戳才算真的渲染完（只有标题时说明还在加载）
      return /\d{4}-\d{1,2}-\d{1,2}/.test(tail);
    } catch (e) { return false; }
  }

  async function waitApprovalSection(maxMs) {
    var deadline = Date.now() + (maxMs || 4000);
    while (Date.now() < deadline) {
      if (approvalSectionReady()) return true;
      await sleep(250);
    }
    return false;
  }

  function extractApprovalTime(root) {
    try {
      var scope = root || document.body;
      var text = (scope.innerText || '');
      var idx = text.indexOf('审批信息');
      if (idx < 0) return '';
      // 只看「审批信息」之后、「操作记录」之前的那一段，避免把操作记录的时间当成审批时间
      var tail = text.slice(idx);
      var opIdx = tail.indexOf('操作记录');
      if (opIdx > 0) tail = tail.slice(0, opIdx);
      var lines = tail.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var lastPassed = '';
      for (var i = 0; i < lines.length; i++) {
        if (!/^(已通过|通过|同意)$/.test(lines[i])) continue;
        // 状态行往回找最近的一个时间戳
        for (var j = i - 1; j >= 0 && j >= i - 4; j--) {
          var m = lines[j].match(/(\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?)/);
          if (m) { lastPassed = m[1]; break; }
        }
      }
      return lastPassed;
    } catch (e) { return ''; }
  }

  async function extractDetail(row) {
    var beforeId = currentDetailId();
    clickRow(row.el || row);

    // 等 SPA 路由真的切到详情页（而不是等一个根本不存在的抽屉）
    var arrived = false;
    for (var w = 0; w < 40; w++) {
      var id = currentDetailId();
      if (id && id !== beforeId) { arrived = true; break; }
      await sleep(300);
    }
    if (!arrived) {
      log('[WARN] 点开详情后 URL 未变到需求详情路由，跳过该条');
      return null;
    }

    // 到了详情页再等字段渲染出来。
    //
    // ⚠️ 只等"字段数够了"是不够的：SPA 换页时 URL 先变、内容后换，
    // 上一条需求的字段还挂在 DOM 上，一进来就满足"≥3 个字段"，
    // 于是把【上一条的数据】当成这一条抓走（实测 R00053 抓回 R00057 的内容）。
    // 后果最恶劣的一种：写进 Excel 的是错的，而重复的需求编号又会被去重跳过，
    // 等于静默丢一条 + 写错一条，事后完全看不出来。
    //
    // 所以用列表行上的需求编号做交叉校验：详情页提取到的编号必须与它一致，
    // 对不上就继续等；等不到就判失败，绝不写。
    var expectNo = (row && row.reqNo) || '';
    var data = null;
    for (var k = 0; k < 40; k++) {
      var root = detailRoot();
      var candidate = extractFrom(root && root !== document.body ? root : document.body);
      if (Object.keys(candidate).length >= 3) {
        var gotNo = String(candidate['需求编号'] || '').trim();
        if (!expectNo || !gotNo || gotNo === expectNo) { data = candidate; break; }
        // 编号对不上 = 还是上一条的残留，继续等
      }
      await sleep(300);
    }
    if (!data) {
      log('[WARN] 详情页内容与列表行对不上（期望编号 ' + expectNo + '），跳过');
      return null;
    }

    // 合成虚拟字段：审批通过时间（供映射表 K 列使用）。
    // 必须先等审批区渲染完，否则 K 列恒空（见 waitApprovalSection 注释）。
    await waitApprovalSection(4000);
    var appr = extractApprovalTime(document.body);
    if (appr) data['审批通过时间'] = appr;
    // 需求名称只在列表行/页面标题上，详情基本信息区没有；带过来供 C 列用
    if (!data['需求名称'] && row && row.name) data['需求名称'] = row.name;
    data['__detailId'] = currentDetailId();
    return data;
  }

  async function closeDetail() {
    // 关闭抽屉：找关闭按钮
    var closeBtn = document.querySelector(
      '[class*="drawer"] [class*="close"],[class*="drawer"] button[aria-label*="关闭"],' +
      '[role="dialog"] [class*="close"]'
    );
    if (closeBtn) { closeBtn.click(); await sleep(400); return; }
    // 按 Esc
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (e) {}
    await sleep(400);
  }

  // ==================== 主流程 ====================

  var currentRunId = null;
  var currentConfig = null;
  var knownIds = new Set();

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'REQSHEET_START') return false;

    currentRunId = msg.runId;
    knownIds = new Set(msg.knownReqIds || []);
    currentConfig = msg.config || {};

    runFlow().then(function () {
      sendResponse({ ok: true });
    }).catch(function (e) {
      chrome.runtime.sendMessage({ type: 'REQSHEET_ERROR', msg: String(e && e.message || e) });
      sendResponse({ ok: false });
    });

    return true;  // async sendResponse
  });

  async function runFlow() {
    var scheduled = !!(currentConfig && currentConfig.scheduled);
    var maxPerRun = (currentConfig && currentConfig.maxPerRun) || DEFAULT_MAX_PER_RUN;

    // 1. 检测页面状态
    var state = detectPageState();

    if (state === 'gateway-blocked') {
      showBanner(
        '🔒 <b>企业网关拦截</b><br>' +
        '当前页面被企业安全浏览器拦截，无法自动访问飞书招聘。<br>' +
        '<small>请点击页面上的「跳转安全浏览器立即访问」按钮。</small>'
      );
      chrome.runtime.sendMessage({ type: 'REQSHEET_STATE', state: 'gateway-blocked' });
      return;
    }

    if (state === 'need-login') {
      var loginTimeout = scheduled ? LOGIN_TIMEOUT_SCHEDULED : LOGIN_TIMEOUT_MANUAL;
      chrome.runtime.sendMessage({ type: 'REQSHEET_STATE', state: 'waiting-login' });
      var loggedIn = await waitForLogin(loginTimeout, scheduled);
      if (!loggedIn) {
        chrome.runtime.sendMessage({ type: 'REQSHEET_STATE', state: 'login-timeout' });
        removeBanner();
        return;
      }
    }

    // 等待列表页加载
    if (state === 'loading' || state === 'need-login') {
      for (var w = 0; w < 30; w++) {
        if (detectPageState() === 'logged-in') break;
        await sleep(500);
      }
    }

    removeBanner();
    chrome.runtime.sendMessage({ type: 'REQSHEET_STATE', state: 'scanning' });
    showBanner('🔍 正在扫描需求列表…');

    // 2. 枚举列表
    var allRows = await enumerateRequirements();
    log('枚举到', allRows.length, '条需求');

    // 3. 过滤：审批通过 + 不在 knownIds
    var newRows = allRows.filter(function (r) {
      if (knownIds.has(r.id)) return false;
      // 只取审批通过
      return /^(审批通过|已通过)/.test(r.status || '');
    });

    log('新增需求', newRows.length, '条');

    if (newRows.length === 0) {
      showBanner('✅ 无新增审批通过需求');
      chrome.runtime.sendMessage({ type: 'REQSHEET_DONE', report: { written: 0, skipped: 0, total: 0 } });
      await sleep(3000);
      removeBanner();
      return;
    }

    // 4. 逐条提取详情
    var deferred = [];
    if (newRows.length > maxPerRun) {
      deferred = newRows.slice(maxPerRun);
      newRows = newRows.slice(0, maxPerRun);
      log('[WARN] 本轮上限 ' + maxPerRun + ' 条，延后 ' + deferred.length + ' 条');
    }

    showBanner('📋 提取详情 0 / ' + newRows.length + '…');
    var rows = [];
    var failed = [];
    for (var i = 0; i < newRows.length; i++) {
      showBanner('📋 提取详情 ' + (i + 1) + ' / ' + newRows.length + '…');
      var data = await extractDetail(newRows[i]);
      if (!data) {
        // 提取失败（没跳转 / 字段没渲染出来）。跳过并计入报告——
        // 决不能推一个空对象进去，那会在 Excel 里落一整行空白，看起来像"同步过了"。
        failed.push(newRows[i].reqNo || newRows[i].id);
        await closeDetail();
        await sleep(rand(DETAIL_DELAY_MIN, DETAIL_DELAY_MAX));
        continue;
      }
      data['__row_id__'] = newRows[i].id;
      rows.push(data);
      await closeDetail();
      await sleep(rand(DETAIL_DELAY_MIN, DETAIL_DELAY_MAX));
    }

    // 5. 上报
    showBanner('📤 正在写入 Excel…');
    var resp = await new Promise(function (resolve) {
      chrome.runtime.sendMessage({
        type: 'REQSHEET_ROWS', rows: rows,
        stats: { deferred: deferred.length, failed: failed.length, failedIds: failed },
      }, resolve);
    });

    var report = (resp && resp.report) || {};
    var written = report.written || 0;
    var skipped = report.skipped || 0;
    var msg = '✅ 完成：写入 ' + written + ' 条' + (skipped ? '，跳过重复 ' + skipped + ' 条' : '');
    if (deferred.length) msg += '<br><small>⚠ 还有 ' + deferred.length + ' 条超过单次上限，下次运行时处理</small>';
    if (failed.length) msg += '<br><small>⚠ ' + failed.length + ' 条详情没打开成功，未写入：' + failed.join('、') + '</small>';
    showBanner(msg);

    chrome.runtime.sendMessage({ type: 'REQSHEET_DONE', report: { written: written, skipped: skipped, deferred: deferred.length } });
    await sleep(5000);
    removeBanner();
  }

})();

