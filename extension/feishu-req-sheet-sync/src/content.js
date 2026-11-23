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
  // __REQ_EXTRACT_INLINE__

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
