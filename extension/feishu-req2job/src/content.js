/**
 * 飞书需求 → 职位 一键复制  v4.0.0
 * Content Script（CDP 隔离世界 + TA 沙箱）
 *
 * ═══ v4.0（2026-08-03，按真机侦察重做主链路）═══
 * 真机侦察（租户 demo，实测走通三步）推翻了 v3.x 的核心假设：
 * 「新建职位」不是弹层表单，而是**整页路由三步向导**
 *   /hire/job/create/{step}/{id}   step: 0=基础信息 1=职位设置 2=负责人
 * v3.6.0 的 formOpened() 要求必须有可见 dialog/drawer/modal，因此在真机上
 * 100% 报「没检测到职位表单」——功能从未真正跑通过。本版：
 *
 *   ① 一键编排 runOneClick()：需求详情页一个按钮 →
 *      审批门禁（只放行「审批通过」，读不到保守拒绝）→ 提取需求 →
 *      自动点「关联职位」区的「新建职位」→ 按 URL 步骤号驱动三步填充 →
 *      停在「保存并完成更多设置」之前。提交永远由人点。
 *   ② 向导驱动 runWizard()：每步 填→校验→按文本重新找「下一步」→等 URL 步骤号真变了才继续；
 *      被必填拦住时抓页面红字原话写进报告并停下。
 *   ③ 新控件：radio（职位类型·其 formily label 会被读成「社招」，靠 hasLabel 排除选项标签解决）、
 *      switch（虚拟职位）、双下拉区间（职级范围）、三段月薪（min+max+币种，缺一报「月薪为必填」）、
 *      多选树已选 tag 识别（重复点同一节点=取消选中，点前必查 alreadySelected）。
 *   ④ 映射表按步分组（# 第N步 注释切组）、"字面值" 固定值（招聘流程）、
 *      多源拼接（职位职责+职位要求 → 职位描述）；飞书自动带值（招聘数量/部门/招聘负责人/
 *      关联需求）识别为 prefilled 单列一档，绝不覆盖。
 *   ⑤ 报告带准确率口径：分母含 没找到/需手选/被跳过，不许拿"成功数/成功数"自证。
 *
 * 离线行为测试：scripts/feishu-job-lab.mjs（真 Chrome + 真沙箱 + 高保真夹具，npm run feishu:lab）。
 *
 * ═══ 保留（六轮真机校准的填充引擎，只扩展不重写）═══
 *   typeInto/forceAssign（沙箱 Proxy 元素不能用原型 setter.call）、fillTextLike（每次重查节点）、
 *   fillEditor（焦点未落本编辑器不 selectAll）、pickInDropdown（部分匹配仅允许候选更长且须搜索过）、
 *   fillSelect（只认新出现的弹层）、ensureAllClosed（Escape+body 指针序列）、终检回读、
 *   三档填充模式（仅填空/智能覆盖/全部覆盖）、模板填充「新建需求」、__TA_ON_STOP__ 停止钩子。
 * 沙箱纪律：window=冻结 safeWindow 无 prompt/confirm；MouseEvent 不传 view；
 *   localStorage 只有 get/set/removeItem；location 是实时 getter（SPA 路由靠它）。
 */
(function () {
  'use strict';

  var TOOL_ID = 'feishu-requirement-generator';
  var PANEL_ID = 'ta-req-gen-panel';
  var PICK_ID = 'ta-req-gen-pick';
  // 覆盖确认的暂存结果（沙箱里没有 window.confirm，只能走面板内联确认）

  // 存储键（沙箱会自动加 ta-tool:<id>: 前缀；保留旧键名以便沿用已有预设/草稿）
  // ⚠️ 2026-08-04 收敛：只剩「已粘贴」这一个真源。
  // 原来是两层：提取框(EXTRACT_KEY) → 点「存为待填充需求」→ 待填充需求(CLIP_KEY) → 填充读 CLIP。
  // 中间那一层在真实场景里没有价值：用户从来不会"先存起来、过一会儿再填"，
  // 而它带来的代价是——改了提取框忘了点存，填充用的还是旧内容，且完全看不出来。
  // 现在填充直接读提取框，所见即所填。
  var EXTRACT_KEY = 'ta-platform:req-gen:extract-draft';
  // 上次填充针对的是哪条需求（换需求时要作废"我上次填了什么"的记录，否则智能覆盖会误判）
  var LAST_NAME_KEY = 'ta-platform:req-gen:last-name';
  var MAP_KEY = 'ta-platform:req-gen:fieldmap';
  var LOG_KEY = 'ta-platform:req-gen:filllog';
  var MODE_KEY = 'ta-platform:req-gen:fillmode';

  var config = (typeof CONFIG !== 'undefined' && CONFIG) || {};
  var debug = !!config.debug;
  function log() {
    if (!debug) return;
    try { console.log.apply(console, ['[' + TOOL_ID + ']'].concat([].slice.call(arguments))); } catch (e) {}
  }

  // ==================== 基础工具 ====================
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // 去零宽字符（U+200B~U+200F、U+FEFF）：用码点判断，避免源码里出现不可见字符
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
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  // 存储（沙箱 storageProxy 仅有 getItem/setItem/removeItem）
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function jGet(k, d) { try { var s = lsGet(k); if (!s) return d; var o = JSON.parse(s); return o == null ? d : o; } catch (e) { return d; } }
  function jSet(k, o) { try { lsSet(k, JSON.stringify(o)); } catch (e) {} }
  // lsDel / nowStr 随「待填充需求」那层中转一起删掉了（2026-08-04）：
  // 清空改为 savePending('')，时间戳不再展示（用户要的是"当前需求是哪条"，不是"什么时候存的"）。

  // ==================== 页面模式 ====================
  function getPageMode() {
    var path = location.pathname;
    if (/\/hire\/job\/create\//i.test(path)) return 'wizard';
    if (/\/hire\/job\/requirement/i.test(path)) return 'requirement';
    // 职位列表页（/hire/job/list…）不再单独返回 'job'：那是「需求页复制 / 职位页粘贴」
    // 老流程的残留，面板不应在列表页出现。让它落进 'unknown'（面板隐藏）。
    // wizard(/create/) 与 requirement 在上面已先行匹配，不受影响；职位页面板构建与
    // 共享按钮接线代码保留在 panelHtml()/bindEvents() 里，作为不可达死代码不动它。
    return 'unknown';
  }

  // ==================== 新建职位向导（2026-08-03 真机侦察） ====================
  // 真机事实（租户 demo，实测走通三步）：
  //   · 「新建职位」入口在【需求详情页】的「关联职位」区块，是个文本按钮，不是弹层触发器。
  //   · 点开后是**整页路由**（不是抽屉/弹窗）：
  //       /hire/job/create/{step}/{jobId}?create_job_from=under_associate_hc
  //     step: 0=基础信息  1=职位设置  2=负责人
  //   · 步骤号直接在 URL 里 —— 这比读步骤条 DOM 可靠得多，作为主判据。
  //   · 头部按钮：step0 只有「下一步」；step1 有「上一步」+「下一步」；step2 是「保存并完成更多设置」。
  //   · ⚠️ 按钮节点【每步都要重新按文本找】。缓存住 step0 的「下一步」节点，
  //     到 step1 会点成同位置的「上一步」——侦察时真踩到过，被弹回第 1 步。
  var WIZARD_STEPS = ['基础信息', '职位设置', '负责人'];
  var SUBMIT_TEXTS = ['保存并完成更多设置', '提交', '确定', '完成'];

  /** 当前向导步骤号（0/1/2）；不在向导里返回 -1 */
  function wizardStep() {
    var m = /\/hire\/job\/create\/(\d+)/i.exec(location.pathname || '');
    if (m) return parseInt(m[1], 10);
    return -1;
  }
  function inWizard() { return wizardStep() >= 0; }
  /** 是否停在某条需求的【详情】路由上（而不是需求列表页） */
  function isRequirementDetailRoute() {
    var p = location.pathname || '';
    if (!/\/hire\/job\/requirement\//i.test(p)) return false;
    return !/\/(list|index)\/?$/i.test(p);
  }
  /** 步骤条兜底（URL 判不出来时用，例如租户改了路由形态） */
  function stepFromDom() {
    var nodes = [];
    try { nodes = [].slice.call(document.querySelectorAll('[class*="steps__item"],[class*="step-item"]')).filter(vis); } catch (e) { return -1; }
    for (var i = 0; i < nodes.length; i++) {
      var cls = '';
      try { cls = String(nodes[i].className || ''); } catch (e) {}
      if (!/--active|--process|is-active|active/.test(cls)) continue;
      var t = norm(txt(nodes[i]));
      for (var s = 0; s < WIZARD_STEPS.length; s++) if (t.indexOf(norm(WIZARD_STEPS[s])) !== -1) return s;
    }
    return -1;
  }
  function currentStep() {
    var s = wizardStep();
    return s >= 0 ? s : stepFromDom();
  }
  /** 按【文本】找头部按钮。每次调用都重新查 DOM —— 见上方 ⚠️ */
  function buttonByText(texts) {
    var btns = [];
    try { btns = [].slice.call(document.querySelectorAll('button,[role="button"],a')).filter(vis); } catch (e) { return null; }
    btns = btns.filter(function (b) { return !isOurs(b); });
    var i, j;
    for (j = 0; j < texts.length; j++) {
      var t = norm(texts[j]);
      for (i = 0; i < btns.length; i++) if (norm(txt(btns[i])) === t) return btns[i];
    }
    return null;
  }
  function nextButton() { return buttonByText(['下一步']); }
  function submitButton() { return buttonByText(SUBMIT_TEXTS); }
  function createJobButton() { return buttonByText(['新建职位']); }

  /**
   * 页面上正在报的校验错误（「月薪为必填」这类红字）。
   * 被必填拦住时，报告里必须带上页面原话——否则用户只看到"卡在第 N 步"，无从下手。
   */
  function formErrors() {
    var sel = '[class*="formily-item-help"],[class*="item-help"],[class*="item-error"],[class*="error-message"],[class*="errorText"]';
    var hit = [];
    try { hit = [].slice.call(document.querySelectorAll(sel)).filter(vis).filter(function (n) { return !isOurs(n); }); } catch (e) { return []; }
    // ⚠️ 只取【叶子】报错节点。真机实测外层容器也命中同一选择器，直接收集会得到
    // 「职位名称* 职位名称为必填；职位名称为必填」这种带标签又重复的串，报告里很难读。
    var leaves = hit.filter(function (a) {
      for (var i = 0; i < hit.length; i++) {
        try { if (hit[i] !== a && a.contains(hit[i])) return false; } catch (e) {}
      }
      return true;
    });
    var out = [];
    leaves.forEach(function (n) {
      var t = txt(n);
      if (!t) return;
      t = String(t).split('\n').pop().trim().slice(0, 40);   // 容器里带了标签时只留最后一行
      if (t && out.indexOf(t) === -1) out.push(t);
    });
    return out;
  }

  // ==================== 审批门禁 ====================
  // 真机事实：需求详情页有「审批状态:」标签，其相邻节点是值（实测「审批通过」）；
  // 另有审批流程条 .approvalProgress__* 里的 .progressName__* 也写着同一个状态。
  var APPROVAL_PASS = /^(审批通过|已通过|通过)$/;
  /** 返回 {status, from} ；读不到时 status 为 '' */
  function readApprovalStatus() {
    // ① 「审批状态」标签 → 相邻值
    var nodes = [];
    try { nodes = [].slice.call(document.querySelectorAll('div,span,td,li,dt,dd,label,p')); } catch (e) {}
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      try { if (n.children.length) continue; } catch (e) { continue; }
      if (!vis(n) || isOurs(n)) continue;
      if (norm(txt(n)) !== '审批状态') continue;
      var pair = valueNear(n, '审批状态');
      if (pair && pair.text) return { status: clean(pair.text).slice(0, 20), from: '审批状态字段' };
    }
    // ② 审批流程条
    try {
      var pn = [].slice.call(document.querySelectorAll('[class*="progressName"],[class*="approvalStatus"]')).filter(vis);
      for (var j = 0; j < pn.length; j++) {
        var t = txt(pn[j]);
        if (t && /通过|驳回|拒绝|审批中|待审批|撤回/.test(t)) return { status: clean(t).slice(0, 20), from: '审批流程条' };
      }
    } catch (e) {}
    return { status: '', from: '' };
  }
  /**
   * 门禁：只有「审批通过」放行。
   * ⚠️ 读不到状态时【保守拒绝】。放行的代价是把审批中/被驳回的需求变成真实职位，
   * 不可逆；拒绝的代价只是用户多点一次"仍要继续"。两边不对称，所以默认拒。
   */
  function approvalGate() {
    var r = readApprovalStatus();
    if (!r.status) return { pass: false, reason: '读不到审批状态', status: '', from: '' };
    if (APPROVAL_PASS.test(norm(r.status))) return { pass: true, reason: '', status: r.status, from: r.from };
    return { pass: false, reason: '当前审批状态为「' + r.status + '」', status: r.status, from: r.from };
  }

  // ==================== 表单引擎（v2.1 真机校准，v3.0 加固） ====================
  // 真机校准（2026-07-27，acme 飞书招聘）：
  //   「新建职位」/hire/job/create/0 用的是 Formily —— 表单项根 = div.ud-formily-item，
  //   标签 = div.ud-formily-item-label(-content)，控件 = div.ud-formily-item-control。
  //   「新建需求」等旧表单用 ud__form__item。两套都要覆盖。
  var ITEM_SEL = '[class*="formily-item"],[class*="form__item"],[class*="form-item"],.ud-form-item';
  var LABEL_SEL = '[class*="formily-item-label"],label,[class*="form__item-label"],[class*="item-label"],[class*="field-label"],[class*="form__label"]';
  // 「真正的字段名」候选（不含裸 <label>）。裸 label 必须排在后面单独兜底 ——
  // 单选组的每个选项本身就是 <label>（社招 / 校招），当成字段名会把「职位类型」读成「社招」。
  var LABEL_PRIMARY = '[class*="formily-item-label"],[class*="form__item-label"],[class*="item-label"],[class*="field-label"],[class*="form__label"]';

  function fireMouse(el) {
    if (!el) return;
    var r = el.getBoundingClientRect();
    // 点击点偏右，避免点到左侧展开箭头/复选框/前缀图标
    var cx = r.left + Math.max(r.width - 20, Math.min(r.width / 2, r.width - 10));
    var cy = r.top + r.height / 2;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
      var ev = null;
      var init = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1 };
      // 注意：绝不传 view —— 沙箱里的 window 不是真 Window，传了必抛
      try {
        if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
          ev = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true });
        } else {
          ev = new MouseEvent(type, init);
        }
      } catch (e) {
        try { ev = new MouseEvent(type, init); } catch (e2) { ev = null; }
      }
      if (ev) { try { el.dispatchEvent(ev); } catch (e3) {} }
    });
  }
  function pressEscape() {
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true })); } catch (e) {}
  }
  function readVal(el) { try { return String(el.value == null ? '' : el.value); } catch (e) { return ''; } }
  function fireInput(el, noBlur) {
    var types = noBlur ? ['input', 'change'] : ['input', 'change', 'blur'];
    types.forEach(function (t) {
      try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {}
    });
  }
  /**
   * 往 input/textarea 写值。两条路径，按可靠性排序：
   *  1) focus + select + execCommand('insertText')：浏览器走真实编辑路径，派发 trusted
   *     beforeinput/input，React 一定收得到（等价于人手打字）。
   *  2) 兜底：先摘掉 React 的 _valueTracker（updateValueIfChanged 在 tracker 缺失时恒返回 true，
   *     从而不会把我们的 input 事件当成"值没变"丢弃），再赋值 + 派发事件。
   * 注意：本脚本拿到的元素是 TA 沙箱的 Proxy，`原型 value setter.call(proxy)` 会
   * Illegal invocation，因此不能用常见的 setNativeValue 写法。
   */
  function typeInto(el, value, noBlur) {
    var str = String(value == null ? '' : value);
    try {
      el.focus();
      if (typeof el.select === 'function') el.select();
      if (document.execCommand('insertText', false, str) && norm(readVal(el)) === norm(str)) {
        fireInput(el, true);
        if (!noBlur) { try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch (e) {} }
        return true;
      }
    } catch (e) {}
    forceAssign(el, str, noBlur);
    return readVal(el).length > 0;
  }
  /** 直接赋值兜底：摘掉 React 的 _valueTracker 再写，绕开输入法/合成事件 */
  function forceAssign(el, str, noBlur) {
    try { delete el._valueTracker; } catch (e) { try { el._valueTracker = null; } catch (e2) {} }
    try { el.value = str; } catch (e) {}
    fireInput(el, noBlur);
  }

  /**
   * 表单根。只认「弹层」（抽屉/对话框/模态）——它的作用是：当表单以浮层盖在列表页上时，
   * 把扫描范围收敛到浮层里，别抓到背后的筛选条。
   * 真机教训：不能把 form/.ud__form 也当候选。/hire/job/create 是整页表单，页面里还有另一个
   * 含上百个 formily 节点的表单（职位画像等），一旦被选中就只剩 2 个可见字段，直接判定"没检测到表单"。
   * 打分也必须用「真实字段数」而不是 class 命中数（一个字段会命中 item/label/control 三次）。
   */
  function formRoot() {
    var cands = [].slice.call(document.querySelectorAll(
      '[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]'
    )).filter(vis);
    var best = null, bc = 0;
    cands.forEach(function (c) {
      var n = itemsFrom(c).length;
      if (n >= bc && n > 0) { bc = n; best = c; }
    });
    return (best && bc >= 2) ? best : document;
  }
  /**
   * 表单是否真的打开了。
   * ⚠️ 这里是 v3.6.0 最致命的一条 bug 的修复点。
   * 旧实现：`return formRoot() !== document`，即【必须存在可见弹层】才算表单打开。
   * 而 2026-08-03 真机侦察证实：飞书「新建职位」是**整页路由** /hire/job/create/{step}/{id}，
   * 页面上根本没有 dialog/drawer/modal —— 于是 formOpened() 恒为 false，
   * runFillJob() 每次都在真机上报「⚠ 没检测到职位表单」，功能等于从来没跑起来过。
   * 现在：处在向导路由上就直接认定表单已打开，扫描范围退回整页（向导页没有会串味的筛选条，
   * 且 formItems() 仍会用 inToolbar() 把工具条类节点剔掉）。
   */
  function formOpened() {
    if (inWizard()) return true;
    return formRoot() !== document;
  }
  var CONTROL_SEL = 'input,textarea,[contenteditable="true"],[contenteditable=""],[class*="select__selector"],[class*="tree-select"],[class*="treeSelect"],[class*="cascader"]';
  function hasControl(el) { try { return !!el.querySelector(CONTROL_SEL); } catch (e) { return false; } }
  /**
   * 是否含【真正的字段名】标签。
   * ⚠️ 不能只 querySelector(LABEL_SEL) 看非空 —— 单选组的每个选项本身就是 <label>（社招/校招），
   * 数进去的话「职位类型」的控件容器会被判成"有标签的表单项"，itemsFrom 的去嵌套
   * 随之把外层真表单项丢掉，只留下控件容器，而它的 labelOf 读出来是「社招」——
   * 于是 itemByLabels('职位类型') 永远找不到这个字段（离线夹具第一轮实测踩到）。
   */
  function hasLabel(el) {
    try {
      var les = el.querySelectorAll(LABEL_SEL);
      for (var i = 0; i < les.length; i++) {
        if (isOptionLabel(les[i])) continue;
        if (txt(les[i])) return true;
      }
      return false;
    } catch (e) { return false; }
  }
  /**
   * 找出真正的"表单项"。
   * 注意：UD 的类名是 ud__form__item / ud__form__item-label / ud__form__item-control，
   * 三者都能命中 [class*="form__item"]。所以必须：
   *   - 只保留含控件的候选（label 块被排除）；
   *   - 内部还有"含 label 的候选"的，说明自己是外层包裹容器 → 丢弃；
   *   - 自己没有 label、却被一个有 label 的候选包着的，说明自己只是控件容器 → 丢弃。
   */
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
  // ⚠️ formRoot() 在没有可见弹层时会退回 document，此时 formItems() 扫的是【整页】——
  // 职位列表页的筛选条/搜索框本身就是 form__item，而且标签常常就叫「职位名称/部门/工作地点」，
  // 与映射目标逐字相同。所以 formOpened()（见上）绝不能只看"数得出几个表单项"。
  function formItems() {
    var root = formRoot();
    var items = itemsFrom(root);
    // 退回整页时，至少要把工具条/筛选区的表单项剔掉，别让它们冒充目标字段
    if (root === document) {
      items = items.filter(function (it) { try { return !inToolbar(it); } catch (e) { return true; } });
    }
    return items;
  }

  /** 选项标签（单选/复选的每一项），不是字段名 */
  function isOptionLabel(n) {
    try {
      if (n.querySelector('input[type="radio"],input[type="checkbox"]')) return true;
      if (n.closest && n.closest('[class*="radio"],[class*="checkbox"],[class*="switch"]')) return true;
    } catch (e) {}
    return false;
  }
  /**
   * 字段名。
   * ⚠️ 真机教训（2026-08-03）：不能直接 querySelector(LABEL_SEL) 取第一个 ——
   *   · 第一个命中的往往是【外层包裹】，文本是"职位类型* 社招 校招"整串；
   *   · 而裸 <label> 在单选组里是【选项自己】（社招/校招），取到它字段名就彻底错了。
   * 现在：先在"真正的 label 类"里找**叶子**（自身不再含 label 节点）且不是选项标签的那个，
   * 找不到再退回裸 label（同样排除选项标签），最后才退回第一个命中。
   */
  function labelOf(item) {
    var pick = function (sel) {
      var nodes = [];
      try { nodes = [].slice.call(item.querySelectorAll(sel)); } catch (e) { return null; }
      var fallback = null;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (isOptionLabel(n)) continue;
        if (!txt(n)) continue;
        if (!fallback) fallback = n;
        var hasInner = false;
        try { hasInner = !!n.querySelector(sel); } catch (e) {}
        if (!hasInner) return n;
      }
      return fallback;
    };
    var le = pick(LABEL_PRIMARY) || pick('label');
    if (!le) { try { le = item.querySelector(LABEL_SEL); } catch (e) {} }
    var t = le ? txt(le) : '';
    if (!t) return '';
    // 叶子 label 里可能还挂着说明文案（「开启后，所有评估人均可查看面试记录」），只取第一行
    t = String(t).split('\n')[0];
    return t.replace(/[*\s:：]+$/g, '').replace(/^\s*\*\s*/, '').trim();
  }
  function itemByLabels(labels) {
    var items = formItems();
    var i, j, le, n;
    // 1) 精确
    for (j = 0; j < labels.length; j++) {
      var target = norm(labels[j]);
      if (!target) continue;
      for (i = 0; i < items.length; i++) {
        n = norm(labelOf(items[i]));
        if (n && n === target) return items[i];
      }
    }
    // 2) 前缀
    for (j = 0; j < labels.length; j++) {
      var t2 = norm(labels[j]);
      if (!t2) continue;
      for (i = 0; i < items.length; i++) {
        n = norm(labelOf(items[i]));
        if (n && (n.indexOf(t2) === 0 || t2.indexOf(n) === 0)) return items[i];
      }
    }
    // 3) 包含（仅对长度 >= 3 的候选，避免「要求」这类短词串字段）
    for (j = 0; j < labels.length; j++) {
      var t3 = norm(labels[j]);
      if (t3.length < 3) continue;
      for (i = 0; i < items.length; i++) {
        n = norm(labelOf(items[i]));
        if (n && n.length >= 3 && (n.indexOf(t3) !== -1 || t3.indexOf(n) !== -1)) return items[i];
      }
    }
    return null;
  }

  var SELECTOR_SEL = '.ud__select__selector,[class*="select__selector"]';
  /**
   * 本表单项里的下拉触发器（顺序=DOM 顺序）。
   * ⚠️ UD 的类名是 BEM 前缀式：ud__select__selector__placeholder / __search__input / __selectItem
   * 这些【子节点】同样命中 [class*="select__selector"]。不筛掉的话一个下拉会被数成 3 个，
   * detectType 把普通下拉全误判成「矩阵型」拒填（离线夹具第一轮实测：11 个字段全军覆没）。
   * 只保留最外层命中。
   */
  function selectorsIn(item) {
    var all;
    try { all = [].slice.call(item.querySelectorAll(SELECTOR_SEL)).filter(vis); } catch (e) { return []; }
    return all.filter(function (a) {
      for (var i = 0; i < all.length; i++) {
        try { if (all[i] !== a && all[i].contains(a)) return false; } catch (e) {}
      }
      return true;
    });
  }
  /**
   * 「自己的」输入框——把下拉/树内部的搜索框排掉。
   * 月薪范围是 min输入 + max输入 + 币种下拉，币种下拉里还有个 search input；
   * 不排掉的话会把搜索框当成第三个值输入框。
   */
  function plainInputs(item) {
    var out = [];
    try {
      [].slice.call(item.querySelectorAll('input,textarea')).forEach(function (i) {
        var t = '';
        try { t = String(i.type || '').toLowerCase(); } catch (e) {}
        if (t === 'radio' || t === 'checkbox' || t === 'hidden') return;
        try { if (/search__input|selector__search/.test(String(i.className || ''))) return; } catch (e) {}
        try { if (i.closest && i.closest(SELECTOR_SEL + ',[class*="tree-select"],[class*="treeSelect"]')) return; } catch (e) {}
        if (!vis(i)) return;
        out.push(i);
      });
    } catch (e) {}
    return out;
  }
  function radiosIn(item) {
    try { return [].slice.call(item.querySelectorAll('input[type="radio"]')); } catch (e) { return []; }
  }
  function switchIn(item) {
    try {
      return item.querySelector('[class*="switch"][role="switch"],[role="switch"],[class*="ud__switch"],[class*="switch__"]');
    } catch (e) { return null; }
  }

  function detectType(item) {
    try {
      if (switchIn(item)) return 'switch';
      if (radiosIn(item).length >= 2) return 'radio';
      if (item.querySelector('[class*="tree-select"],[class*="treeSelect"],[class*="throne-biz-location"]')) return 'tree';
      if (item.querySelector('[class*="cascader"]')) return 'cascader';
      var sels = selectorsIn(item);
      var ins = plainInputs(item);
      // 月薪范围：min 输入 + max 输入 + 币种下拉（真机实测三控件，缺币种就报「月薪为必填」）
      if (sels.length === 1 && ins.length >= 2) return 'salary';
      // 职级范围：起 - 止 两个下拉，同一个表单项内
      if (sels.length === 2 && ins.length === 0) return 'range-select';
      // 三个以上下拉（面试轮次表这类矩阵）不在本工具的填充范围内，如实标记而不是硬填
      if (sels.length > 2) return 'multi';
      if (sels.length === 1) return 'select';
      if (item.querySelector('textarea')) return 'textarea';
      if (item.querySelector('[contenteditable="true"],[contenteditable=""]')) return 'editor';
      // 纯输入的区间（少见，但同一项两个裸输入框时按区间处理，避免只填了 min 就报成功）
      if (ins.length >= 2) return 'range-input';
      var inp = ins[0] || item.querySelector('input');
      if (inp) {
        if (inp.type === 'number') return 'number';
        if (/YYYY|日期|时间/.test(inp.placeholder || '')) return 'date';
        return 'text';
      }
    } catch (e) {}
    return 'unknown';
  }

  /**
   * 已选中的值（下拉的单值、树/多选的每个 tag）。
   * ⚠️ 真机实测（2026-08-03）：UD 的选中值节点类名是 `ud__select__selector__selectItem`，
   * 旧实现找的 `selection-item / select__value / single / tag` 四个候选**一个都命中不了**，
   * 全靠 `txt(整个 selector)` 兜底才碰巧能用 —— 多选时会把所有 tag 连成一串没有分隔符的文本，
   * 无法判断"目标是否已在其中"。多选树上这一点很要命：判错就会重复点同一个节点 = 取消选中。
   */
  function selectedTags(scope) {
    var hit = [];
    try {
      hit = [].slice.call(scope.querySelectorAll(
        '[class*="selectItem"],[class*="selection-item"],[class*="selection__item"],[class*="select__value"]'
      )).filter(vis);
    } catch (e) { return []; }
    // 只保留最外层的 tag 节点（内部还嵌着同类节点的话，外层才是完整一项）
    var outer = hit.filter(function (a) {
      for (var i = 0; i < hit.length; i++) {
        try { if (hit[i] !== a && hit[i].contains(a)) return false; } catch (e) {}
      }
      return true;
    });
    var out = [];
    outer.forEach(function (n) {
      var t = txt(n).replace(/[✕×⨯xX]\s*$/, '').trim();
      if (!t || /^请选择|^请输入/.test(t)) return;
      if (out.indexOf(t) === -1) out.push(t);
    });
    return out;
  }
  function readSelectDisplay(item, scope) {
    var sel = scope || null;
    if (!sel) { try { sel = item.querySelector(SELECTOR_SEL); } catch (e) {} }
    if (sel) {
      var tags = selectedTags(sel);
      if (tags.length) return tags.join(' / ');
      // 兜底：租户/版本换了类名时仍能读到值（但读不出多选的分隔）
      var t = txt(sel);
      if (!t || /^请选择|^请输入/.test(t)) return '';
      return t;
    }
    var inp = null;
    try { inp = item.querySelector('input'); } catch (e) {}
    return inp ? clean(inp.value) : '';
  }
  /** 目标值是否已经在已选 tag 里（多选树重复点=取消选中，点之前必须查这个） */
  function alreadySelected(item, value, scope) {
    var tags = selectedTags(scope || item);
    var b = norm(value);
    if (!b) return false;
    for (var i = 0; i < tags.length; i++) {
      var a = norm(tags[i]);
      if (a === b) return true;
      // 选中后显示值常比目标更全（上海 → 上海 · 百色路88号），按真前缀接纳
      if (a.indexOf(b) === 0) {
        var next = a.charAt(b.length);
        var alnum = /[0-9a-z]/i;
        if (next === '' || !(alnum.test(b.charAt(b.length - 1)) && alnum.test(next))) return true;
      }
    }
    return false;
  }
  /** 单选组：读当前选中项的文案 */
  function readRadio(item) {
    var rs = radiosIn(item);
    for (var i = 0; i < rs.length; i++) {
      var checked = false;
      try { checked = !!rs[i].checked; } catch (e) {}
      if (!checked) {
        try {
          var w = rs[i].closest('[class*="radio"]');
          if (w && /--checked|is-checked|checked/.test(String(w.className || ''))) checked = true;
        } catch (e) {}
      }
      if (checked) return radioLabel(rs[i]);
    }
    return '';
  }
  function radioLabel(input) {
    var n = input, hops = 0;
    while (n && hops < 4) {
      var t = txt(n);
      if (t) return t;
      try { n = n.parentElement; } catch (e) { break; }
      hops++;
    }
    return '';
  }
  /** 开关：读开/关 */
  function readSwitch(item) {
    var sw = switchIn(item);
    if (!sw) return '';
    var on = false;
    try {
      var aria = sw.getAttribute && sw.getAttribute('aria-checked');
      if (aria != null) on = (String(aria) === 'true');
      else on = /--checked|is-checked|--open/.test(String(sw.className || ''));
    } catch (e) {}
    return on ? '开' : '关';
  }
  // 读取表单项当前值（用于「保留人工修改」判定与扫描）
  function readItemValue(item, type) {
    var t = type || detectType(item);
    try {
      if (t === 'radio') return readRadio(item);
      if (t === 'switch') return readSwitch(item);
      if (t === 'select' || t === 'tree' || t === 'cascader') return readSelectDisplay(item);
      if (t === 'range-select' || t === 'multi') {
        var parts = selectorsIn(item).map(function (s) { return readSelectDisplay(item, s); });
        return parts.filter(Boolean).join(' - ');
      }
      if (t === 'salary') {
        var ins = plainInputs(item);
        var a = ins[0] ? clean(ins[0].value) : '';
        var b = ins[1] ? clean(ins[1].value) : '';
        var cur = selectorsIn(item).length ? readSelectDisplay(item, selectorsIn(item)[0]) : '';
        if (!a && !b && !cur) return '';
        return (a + '-' + b + (cur ? ' ' + cur : '')).trim();
      }
      if (t === 'range-input') {
        var ii = plainInputs(item);
        var x = ii[0] ? clean(ii[0].value) : '';
        var y = ii[1] ? clean(ii[1].value) : '';
        if (!x && !y) return '';
        return x + '-' + y;
      }
      if (t === 'textarea') { var ta = item.querySelector('textarea'); return ta ? clean(ta.value) : ''; }
      if (t === 'editor') { var ce = item.querySelector('[contenteditable="true"],[contenteditable=""]'); return ce ? txt(ce) : ''; }
      var inp = plainInputs(item)[0] || item.querySelector('input');
      return inp ? clean(inp.value) : '';
    } catch (e) { return ''; }
  }

  /**
   * 文本/数字/日期字段写值。
   * 真机 100 次压测教训：以 execCommand('insertText') 为主路径时，约 3% 的写入会出现
   * 尾部多字/少字（实测「…000o」「…05」「…060-」「…测试）欸」）—— 逐字符编辑会与输入法候选提交、
   * 受控组件重渲染打架，且污染发生在我们比对之后。
   * 因此改为：**直接赋值为主路径**（一次性原子写入，输入法完全不参与，React 靠摘除
   * _valueTracker 收到变更），execCommand 只作兜底，最后再复验一轮，仍不一致就再强制一次。
   */
  // 值比对：必须用原文（只 trim 两端），不能用 norm。
  // norm 会抹掉全部空白、冒号、星号，于是这些【真的写坏了】的情况会被判成"完全一致"：
  //   '第一行\n第二行' vs '第一行第二行'（多行被组件塌成一行）
  //   '北京 上海'      vs '北京上海'
  //   '学历：本科'     vs '学历本科'
  // norm 只适合用来匹配字段名，不适合判断值写对没有。
  function sameValue(a, b) { return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim(); }

  async function fillTextLike(item, value) {
    var str = String(value);
    // ⚠️ 每次都重新从 item 里查元素，不能全程持有开头取到的那一个。
    // forceAssign 会派发 blur，React/Formily 受控组件在 change+blur 后重建 input 节点是常规行为；
    // 继续读旧节点，读到的是我们自己刚写进去的值（旧节点还在内存里），于是报"写入成功"，
    // 而页面上真正的 input 是空的。这正是 v3.3.0 那次 3% 脏字的同一个根因，换主路径没消除它。
    var cur = function () {
      var el = null;
      try { el = item.querySelector('textarea') || item.querySelector('input'); } catch (e) {}
      return el;
    };
    var el = cur();
    if (!el) return { ok: false, reason: 'no-input' };

    try { el.focus(); } catch (e) {}
    forceAssign(el, str);
    await sleep(180);
    var got = readVal(cur() || el);

    if (!sameValue(got, str)) {             // 组件把值改回去了 → 走真实编辑路径
      var e2 = cur(); if (!e2) return { ok: false, reason: 'no-input' };
      typeInto(e2, str);
      await sleep(220);
      got = readVal(cur() || e2);
    }
    if (!sameValue(got, str)) {             // 还不一致 → 再强制一次并复验
      var e3 = cur(); if (!e3) return { ok: false, reason: 'no-input' };
      forceAssign(e3, str);
      await sleep(220);
      got = readVal(cur() || e3);
    }
    if (!got) return { ok: false, reason: 'value-not-committed' };
    return { ok: true, exact: sameValue(got, str), got: got };
  }
  /**
   * 富文本（职位描述 / 任职要求）写值。
   *
   * ⚠️ 两个曾经的坑，改这里前务必先读：
   * 1) 旧实现的兜底是 `ce.textContent = value` 之后 `got = txt(ce)` —— 读的是自己刚写的 DOM，
   *    必然非空，于是这个函数【逻辑上不可能返回失败】，恒报"成功写入"。
   *    而飞书富文本是 Slate/Quill 类编辑器，有独立文档模型：直接改 textContent 不进 model，
   *    组件下次 render 就擦回去，提交时取 model 得到空串 —— 职位描述发出去是空的。
   *    现在改为：兜底写入后等一拍再复读，且必须与目标一致才算成功。
   * 2) selectAll 之前必须确认焦点确实在本编辑器上。若 ce.focus() 因元素在折叠区而无效，
   *    焦点还停在【上一个填过的富文本字段】上，selectAll+insertText 会把上一个字段整体替换掉，
   *    随后 textContent 兜底又把本字段填对 —— 报告两个字段全绿，实际上一个字段被悄悄覆盖。
   */
  async function fillEditor(item, value) {
    var str = String(value);
    var find = function () {
      try { return item.querySelector('[contenteditable="true"],[contenteditable=""]'); } catch (e) { return null; }
    };
    var ce = find();
    if (!ce) return { ok: false, reason: 'no-editor' };

    try { ce.focus(); } catch (e) {}
    await sleep(60);
    // 焦点没落在本编辑器上就绝不能 selectAll —— 会误伤上一个字段
    var focused = false;
    try { focused = document.activeElement === ce || ce.contains(document.activeElement); } catch (e) { focused = false; }
    if (focused) {
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, str);
      } catch (e) {}
      await sleep(220);
    }
    var got = txt(find() || ce);

    if (!sameValue(got, str)) {
      // 兜底：直接改 DOM 文本。它可能不进编辑器的文档模型，所以【必须】等一拍再复读校验，
      // 组件若把内容擦回去，这里就能如实报失败，而不是自证成功。
      try {
        var el2 = find() || ce;
        el2.textContent = str;
        el2.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {}
      await sleep(260);
      got = txt(find() || ce);
    }
    if (!got) return { ok: false, reason: 'editor-not-committed' };
    if (!sameValue(got, str)) return { ok: true, exact: false, got: got };
    return { ok: true, exact: true, got: got };
  }

  function openDropdowns() {
    return [].slice.call(document.querySelectorAll('.ud__select__dropdown,[class*="select__dropdown"],[class*="treeSelect__overlay"]'))
      .filter(vis)
      .filter(function (d) { return !/menu-root|menu-horizontal|navi/.test(String(d.className || '')); });
  }
  function visibleDropdown(nearEl) {
    var dds = openDropdowns();
    if (!dds.length) return null;
    if (!nearEl || dds.length === 1) return dds[dds.length - 1];
    var tr = nearEl.getBoundingClientRect(), best = null, bd = Infinity;
    dds.forEach(function (d) {
      var r = d.getBoundingClientRect();
      var hOverlap = !(r.right < tr.left - 80 || r.left > tr.right + 80);
      if (!hOverlap) return;
      var dist = Math.min(Math.abs(r.top - tr.bottom), Math.abs(r.bottom - tr.top));
      if (dist < bd) { bd = dist; best = d; }
    });
    return best || dds[dds.length - 1];
  }
  /**
   * 关闭残留弹层。
   * 真机教训：UD 的"点外面关闭"监听的是 document 上的 pointerdown/mousedown，只派发 click 根本关不掉。
   * 弹层一旦堆积，下一个字段就会认错弹层 —— 表现为选错值（职能类型被选成上一个列表的项）或匹配不到。
   * 这里直接把整套指针序列派发到 document.body：target 是 body，一定落在弹层外部，
   * 且 body 本身没有点击行为，比 elementFromPoint 猜坐标安全得多。
   */
  function outsideClick() {
    var body = document.body;
    if (!body) return;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      try {
        var C = (t.indexOf('pointer') === 0 && typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
        body.dispatchEvent(new C(t, { bubbles: true, cancelable: true, clientX: 2, clientY: 2, button: 0 }));
      } catch (e) {}
    });
  }
  async function ensureAllClosed() {
    for (var i = 0; i < 4; i++) {
      if (!openDropdowns().length) return;
      pressEscape();
      outsideClick();
      await sleep(250);
    }
  }
  function nodeLabel(node) {
    try {
      var it = node.innerText;
      if (it && String(it).trim()) return norm(String(it));
    } catch (e) {}
    try {
      var c = node.cloneNode(true);
      [].slice.call(c.querySelectorAll(
        'button,svg,i,img,input[type="checkbox"],input[type="radio"],' +
        '[class*="expandButton"],[class*="expandIcon"],[class*="expand-icon"],' +
        '[class*="checkbox"],[class*="__check"],[class*="check-"],' +
        '[class*="switcher"],[class*="arrow"],[class*="caret"],[class*="count"],[class*="badge"]'
      )).forEach(function (n) { n.remove(); });
      return norm(c.textContent);
    } catch (e) { return ''; }
  }
  function nodeClickEl(node) {
    try {
      return node.querySelector('[class*="node__title"],[class*="tree__title"],[class*="node-content"],[class*="node__content"],[class*="node__label"],[class*="title"],[class*="label"]') || node;
    } catch (e) { return node; }
  }
  async function pickInDropdown(dd, value, extraSearchEl) {
    var target = norm(value);
    var isTree = false;
    try { isTree = !!dd.querySelector('.ud__tree,[class*="tree__node"],[class*="treeSelect__overlay"]'); } catch (e) {}
    var searchInput = null;
    try { searchInput = dd.querySelector('input'); } catch (e) {}
    // 真机教训：UD 树选择（工作地点/部门）的搜索框不在弹层里，而在【触发器】内
    // （input.ud__select__selector__search__input）。只找弹层里的 input 会导致永远搜不了，
    // 而树一次只渲染 9 个节点、弹层内也没有可滚动容器 → 必然 tree-no-match。
    if ((!searchInput || !vis(searchInput)) && extraSearchEl && vis(extraSearchEl)) searchInput = extraSearchEl;
    var itemSel = isTree ? '.ud__tree__node,[class*="tree__node"]' : '.ud__select__list__item,[class*="select__list__item"]';
    var searched = false;
    // 先在"原始列表"里找。真机教训：普通下拉的触发器同样有搜索框，一上来就打字会把列表搜空
    // （需求状态/人员类型这类枚举根本不支持搜索），而且会让精确匹配退化成部分匹配（全球研发中心→全球研发中心-ODC）。
    // 所以：匹配不到时才搜索，然后再匹配一轮。
    for (var attempt = 0; attempt < 8; attempt++) {
      var opts = [];
      try { opts = [].slice.call(dd.querySelectorAll(itemSel)).filter(vis); } catch (e) {}
      if (opts.length) {
        var exact = null, partial = null;
        for (var k = 0; k < opts.length; k++) {
          var lbl = isTree ? nodeLabel(opts[k]) : norm(txt(opts[k].querySelector('.ud__select__list__item__content') || opts[k]));
          if (!lbl) continue;
          if (lbl === target) { exact = opts[k]; break; }
          // ⚠️ 部分匹配【只允许候选项比目标长】（选中后显示值更全，如 全球研发中心 → 全球研发中心-ODC）。
          // 绝不能反过来接受"候选项比目标短"：树首屏只渲染 9 个节点，目标"研发中心-软件平台部"
          // 会命中父节点"研发中心"（target.indexOf(lbl)!==-1），于是部门被写成上级部门还报成功。
          if (!partial && lbl.indexOf(target) !== -1) partial = opts[k];
        }
        // 部分匹配必须【搜索过之后】才允许采纳：没搜索前看到的只是首屏那几个节点，
        // 拿它做模糊匹配等于在不完整的候选集上猜。
        var chosen = exact || (searched ? partial : null);
        if (chosen) {
          var clickEl = isTree ? nodeClickEl(chosen) : (chosen.querySelector('.ud__select__list__item__content') || chosen);
          var picked = isTree ? nodeLabel(chosen) : norm(txt(clickEl));
          fireMouse(clickEl);
          await sleep(250);
          pressEscape();
          outsideClick(); // 只按 Escape 关不掉 UD 弹层，必须补一次外部指针序列
          return { ok: true, pickedText: String(picked).slice(0, 20) };
        }
      }
      // 前两轮没匹配上：改用搜索框过滤（树只渲染前 9 个节点，不搜索永远找不到）
      if (!searched && attempt >= 1 && searchInput && vis(searchInput)) {
        searched = true;
        typeInto(searchInput, value, true); // 搜索框不能派发 blur —— 会把弹层关掉
        await sleep(1500);
        continue;
      }
      // 虚拟列表滚动加载：优先 rc-virtual-list，找不到就取弹层内第一个真正可滚动的容器
      var holder = null;
      try {
        holder = dd.querySelector('.rc-virtual-list-holder');
        if (!holder) {
          var all = [].slice.call(dd.querySelectorAll('*'));
          for (var h = 0; h < all.length; h++) {
            if (all[h].scrollHeight > all[h].clientHeight + 20) { holder = all[h]; break; }
          }
          if (!holder && dd.scrollHeight > dd.clientHeight + 20) holder = dd;
        }
      } catch (e) {}
      if (holder) {
        try { holder.scrollTop += 160; holder.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
      }
      await sleep(450);
    }
    // 失败时把"当时看到的候选项"带回报告：真机校准时这是唯一能判断是没渲染、还是文案对不上的信息
    var seen = [];
    try {
      seen = [].slice.call(dd.querySelectorAll(itemSel)).filter(vis).slice(0, 5)
        .map(function (n) { return (isTree ? nodeLabel(n) : norm(txt(n))).slice(0, 12); }).filter(Boolean);
    } catch (e) {}
    log('pick fail', { isTree: isTree, target: target, seen: seen, searched: !!searchInput });
    return {
      ok: false,
      reason: (isTree ? 'tree-no-match' : 'list-no-match')
        + (searched ? ' 已搜索' : (searchInput ? ' 未搜索' : ' 无搜索框'))
        + (seen.length ? ' 看到:' + seen.join('/') : ' 列表为空'),
    };
  }
  /**
   * @param trigOverride 指定用哪个下拉触发器（职级范围这类"一项两下拉"必须指定，否则两次都点到第一个）
   */
  async function fillSelect(item, value, trigOverride) {
    var trig = trigOverride || null;
    if (!trig) {
      try {
        trig = item.querySelector('.ud__select__selector,[class*="select__selector"]')
          || item.querySelector('[class*="tree-select"],[class*="treeSelect"],[class*="throne-biz-location"]')
          || item.querySelector('input');
      } catch (e) {}
    }
    if (!trig) return { ok: false, reason: 'no-trigger' };
    // ⚠️ 多选树（工作地点/部门）上，重复点同一个节点 = 取消选中。
    // 上层的 isSameEnough 判不出"已选多项里含目标"这种情况（当前值是 "北京 / 上海"，目标 "上海"，
    // 前缀判定不成立 → 会再点一次 → 把已经选好的上海取消掉，然后报"写入成功"）。
    // 所以进到这里必须先查一遍已选 tag。
    if (alreadySelected(item, value, trigOverride || item)) {
      return { ok: true, exact: true, committed: readSelectDisplay(item, trigOverride || null).slice(0, 24), noop: true };
    }
    await ensureAllClosed();
    try { trig.scrollIntoView({ block: 'center' }); } catch (e) {}
    await sleep(250);
    // 关键防串台：记下"点开之前"已经存在的弹层，之后只认新出现的那个。
    // 只靠位置相近来猜（visibleDropdown）在真机上会认错，导致把上一个字段的列表当成自己的。
    var before = openDropdowns();
    function isNew(d) { for (var i = 0; i < before.length; i++) if (before[i] === d) return false; return true; }
    fireMouse(trig);
    // 真机教训：工作地点这类树是点开后异步拉数据的，850ms 定长等待时弹层还没挂上 →
    // 误报 no-dropdown / tree-no-match。改为轮询等待，最多 5s。
    var dd = null;
    var OPT_SEL = '.ud__select__list__item,[class*="select__list__item"],.ud__tree__node,[class*="tree__node"]';
    for (var w = 0; w < 25; w++) {
      await sleep(200);
      var fresh = openDropdowns().filter(isNew);
      if (fresh.length) {
        dd = fresh[fresh.length - 1];
        if (dd.querySelector(OPT_SEL)) break;
      }
    }
    if (!dd) {
      var fresh2 = openDropdowns().filter(isNew);
      dd = fresh2.length ? fresh2[fresh2.length - 1] : visibleDropdown(trig);
    }
    if (!dd) return { ok: false, reason: 'no-dropdown' };
    // 触发器内的搜索框（UD 树选择把搜索框放在这里）
    // ⚠️ 优先从【本触发器内部】找：职级范围一项两下拉，从 item 里找会永远拿到第一个的搜索框。
    var trigSearch = null;
    try {
      trigSearch = (trig.querySelector ? trig.querySelector('input') : null)
        || item.querySelector('input[class*="selector__search__input"]')
        || item.querySelector('input');
    } catch (e) {}
    var r = await pickInDropdown(dd, value, trigSearch);
    await sleep(300);
    await ensureAllClosed();
    await sleep(200);
    if (r.ok) {
      var disp = readSelectDisplay(item, trigOverride || null);
      if (!disp) return { ok: false, reason: 'not-committed' };
      r.committed = disp.slice(0, 24);
      // ⚠️ 光看"显示值非空"等于没校验：点中父节点也会让显示值非空。
      // 这里补上与目标的真实比对——不一致时仍算写入成功（值确实进去了），
      // 但标 exact:false，由上层单列一档提示"写入值与来源不一致"，不计入成功数。
      var dn = norm(disp), tn = norm(String(value));
      r.exact = (dn === tn) || (dn.indexOf(tn) !== -1);
    }
    return r;
  }

  // ── 单选组（职位类型：社招/校招）────────────────────────────────────────
  async function fillRadio(item, value) {
    var rs = radiosIn(item);
    if (!rs.length) return { ok: false, reason: 'no-radio' };
    var target = norm(value);
    var chosen = null, seen = [];
    for (var i = 0; i < rs.length; i++) {
      var lbl = norm(radioLabel(rs[i]));
      if (lbl && seen.indexOf(lbl) === -1) seen.push(lbl);
      if (lbl === target) { chosen = rs[i]; break; }
    }
    if (!chosen) {
      for (var j = 0; j < rs.length; j++) {
        var l2 = norm(radioLabel(rs[j]));
        if (l2 && (l2.indexOf(target) === 0 || target.indexOf(l2) === 0)) { chosen = rs[j]; break; }
      }
    }
    if (!chosen) return { ok: false, reason: 'radio-no-match 看到:' + (seen.join('/') || '(空)') };
    var clickEl = chosen;
    try { clickEl = chosen.closest('[class*="radio"]') || chosen; } catch (e) {}
    fireMouse(clickEl);
    await sleep(250);
    var got = readRadio(item);
    if (!got) { try { chosen.click(); } catch (e) {} await sleep(250); got = readRadio(item); }
    if (!got) return { ok: false, reason: 'radio-not-committed' };
    return { ok: true, exact: norm(got) === target, got: got };
  }

  // ── 开关（设置为虚拟职位）──────────────────────────────────────────────
  var SWITCH_ON = /^(开|开启|是|需要|true|1|y|yes|on)$/i;
  async function fillSwitch(item, value) {
    var sw = switchIn(item);
    if (!sw) return { ok: false, reason: 'no-switch' };
    var want = SWITCH_ON.test(String(value == null ? '' : value).trim()) ? '开' : '关';
    if (readSwitch(item) === want) return { ok: true, exact: true, got: want, noop: true };
    fireMouse(sw);
    await sleep(280);
    var got = readSwitch(item);
    if (got !== want) return { ok: false, reason: 'switch-not-committed（现为' + got + '）' };
    return { ok: true, exact: true, got: got };
  }

  // ── 区间（职级范围：起 - 止 两个下拉）──────────────────────────────────
  /**
   * 拆区间。⚠️ 连字符是有歧义的：职级本身就可能带连字符（P5-1）。
   * 所以只有【强分隔符】(~ ～ 至 到 — –) 才敢直接拆；只有连字符时交给上层
   * 「先整串试一次，不成再拆」的策略去消歧 —— 用真实下拉选项来判，比猜规则可靠。
   */
  function splitRange(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return null;
    var m = s.split(/\s*[~～至到—–]\s*/);
    if (m.length === 2 && m[0].trim() && m[1].trim()) return [m[0].trim(), m[1].trim()];
    var h = s.split('-');
    if (h.length === 2 && h[0].trim() && h[1].trim()) return [h[0].trim(), h[1].trim()];
    return null;
  }
  function hasStrongSep(v) { return /[~～至到—–]/.test(String(v == null ? '' : v)); }

  async function fillRangeSelect(item, value) {
    if (selectorsIn(item).length < 2) return { ok: false, reason: 'no-range-selectors' };
    // ① 没有强分隔符时，先把整串当【单个值】试第一个下拉。
    //    命中就说明这本来就是一个职级（P5-1），不是区间 —— 拆开填反而是错的。
    if (!hasStrongSep(value)) {
      var whole = await fillSelect(item, value, selectorsIn(item)[0]);
      if (whole.ok && whole.exact !== false) {
        return { ok: true, exact: true, got: readItemValue(item, 'range-select'), note: '按单值填入起点' };
      }
    }
    var pair = splitRange(value);
    if (!pair) return { ok: false, reason: 'range-unsplittable 原值:' + String(value).slice(0, 20) };
    var ra = await fillSelect(item, pair[0], selectorsIn(item)[0]);
    await sleep(220);
    // 填完第一个后组件可能重建节点，必须重新取第二个触发器
    var sels = selectorsIn(item);
    if (sels.length < 2) return { ok: false, reason: 'range-second-gone' };
    var rb = await fillSelect(item, pair[1], sels[1]);
    await sleep(200);
    var got = readItemValue(item, 'range-select');
    if (ra.ok && rb.ok) return { ok: true, exact: (ra.exact !== false && rb.exact !== false), got: got };
    if (ra.ok || rb.ok) {
      return { ok: true, exact: false, got: got, reason: '区间只填上一端：起' + (ra.ok ? '✓' : '✗' + (ra.reason || '')) + ' 止' + (rb.ok ? '✓' : '✗' + (rb.reason || '')) };
    }
    return { ok: false, reason: '区间两端都没填上：' + (ra.reason || '') + ' / ' + (rb.reason || '') };
  }

  // ── 月薪范围（min 输入 + max 输入 + 币种下拉）──────────────────────────
  // 真机实测：三段缺任一都会报「月薪为必填」，卡在第 1 步过不去。
  var CURRENCY_OPT = {
    CNY: 'CNY-人民币', USD: 'USD-美元', GBP: 'GBP-英镑', HKD: 'HKD-港币',
    TWD: 'TWD-新台币', EUR: 'EUR-欧元', JPY: 'JPY-日元', INR: 'INR-印度卢比',
  };
  function trimNum(n) {
    var s = String(Math.round(n * 100) / 100);
    return s.replace(/\.0+$/, '');
  }
  /** 返回 {min,max,currency,converted} ；解析不出两个数就返回 null（如"面议"） */
  function parseSalary(value) {
    var s = String(value == null ? '' : value);
    var nums = s.match(/\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    var a = parseFloat(nums[0]), b = parseFloat(nums[1]);
    if (!isFinite(a) || !isFinite(b)) return null;
    var cur = 'CNY';
    if (/USD|美元|\$/i.test(s)) cur = 'USD';
    else if (/HKD|港/i.test(s)) cur = 'HKD';
    else if (/EUR|欧元|€/i.test(s)) cur = 'EUR';
    else if (/GBP|英镑|£/i.test(s)) cur = 'GBP';
    else if (/JPY|日元|¥\s*万/i.test(s)) cur = 'JPY';
    // 表单单位固定是 K。需求里的三种写法都要归一：
    //   20-35K → 原样；15000-25000 → ÷1000；2万-3万 → ×10（1万=10K）
    var converted = false;
    if (/万/.test(s) && a < 100 && b < 100) { a = a * 10; b = b * 10; converted = true; }
    else if (a >= 1000 && b >= 1000) { a = a / 1000; b = b / 1000; converted = true; }
    if (a > b) { var t = a; a = b; b = t; }
    return { min: trimNum(a), max: trimNum(b), currency: cur, converted: converted };
  }
  /** 往 item 里第 idx 个「自己的」输入框写值，每次重新查节点（同 fillTextLike 的纪律） */
  async function fillInputAt(item, idx, str) {
    var cur = function () { return plainInputs(item)[idx] || null; };
    var el = cur();
    if (!el) return false;
    try { el.focus(); } catch (e) {}
    forceAssign(el, String(str));
    await sleep(160);
    var got = readVal(cur() || el);
    if (!sameValue(got, str)) {
      var e2 = cur(); if (!e2) return false;
      typeInto(e2, String(str));
      await sleep(200);
      got = readVal(cur() || e2);
    }
    return sameValue(got, str);
  }
  async function fillSalary(item, value) {
    var p = parseSalary(value);
    if (!p) return { ok: false, reason: 'salary-unparsable 原值:' + String(value).slice(0, 20) + '（读不出两个数字，需人工填）' };
    if (plainInputs(item).length < 2) return { ok: false, reason: 'salary-no-inputs' };
    var okMin = await fillInputAt(item, 0, p.min);
    var okMax = await fillInputAt(item, 1, p.max);
    // 币种：飞书默认是空的且必填。已有值就不动（用户可能特意改过）。
    var curOk = true, curNote = '';
    var sels = selectorsIn(item);
    if (sels.length) {
      var already = readSelectDisplay(item, sels[0]);
      if (!already) {
        var want = CURRENCY_OPT[p.currency] || p.currency;
        var rc = await fillSelect(item, want, selectorsIn(item)[0]);
        curOk = !!rc.ok;
        if (!curOk) curNote = '币种未选中(' + (rc.reason || '') + ')';
      }
    }
    var got = readItemValue(item, 'salary');
    if (okMin && okMax && curOk) {
      return { ok: true, exact: true, got: got, note: p.converted ? '按元→K 换算' : '' };
    }
    return {
      ok: (okMin || okMax),
      exact: false,
      got: got,
      reason: '月薪三段未填全：下限' + (okMin ? '✓' : '✗') + ' 上限' + (okMax ? '✓' : '✗') + ' ' + (curOk ? '币种✓' : curNote),
    };
  }

  // 统一填充入口：返回 {ok, how, value, reason}
  async function fillOne(item, value) {
    var type = detectType(item);
    if (type === 'textarea' || type === 'text' || type === 'number' || type === 'date') {
      var rt = await fillTextLike(item, value);
      return { ok: rt.ok, how: 'text', value: rt.got || String(value), reason: rt.reason, exact: rt.exact };
    }
    if (type === 'editor') {
      var re = await fillEditor(item, value);
      return { ok: re.ok, how: 'editor', value: re.got || String(value), reason: re.reason, exact: re.exact };
    }
    if (type === 'radio') {
      var rr = await fillRadio(item, value);
      return { ok: rr.ok, how: 'radio', value: rr.got || '', reason: rr.reason, exact: rr.exact };
    }
    if (type === 'switch') {
      var rw = await fillSwitch(item, value);
      return { ok: rw.ok, how: 'switch', value: rw.got || '', reason: rw.reason, exact: rw.exact };
    }
    if (type === 'range-select') {
      var rg = await fillRangeSelect(item, value);
      return { ok: rg.ok, how: 'range', value: rg.got || '', reason: rg.reason, exact: rg.exact, note: rg.note };
    }
    if (type === 'salary') {
      var rsal = await fillSalary(item, value);
      return { ok: rsal.ok, how: 'range', value: rsal.got || '', reason: rsal.reason, exact: rsal.exact, note: rsal.note };
    }
    if (type === 'range-input') {
      var pr = splitRange(value);
      if (!pr) return { ok: false, how: 'range', reason: 'range-unsplittable 原值:' + String(value).slice(0, 20) };
      var a1 = await fillInputAt(item, 0, pr[0]);
      var b1 = await fillInputAt(item, 1, pr[1]);
      var gv = readItemValue(item, 'range-input');
      return { ok: (a1 || b1), how: 'range', value: gv, exact: (a1 && b1), reason: (a1 && b1) ? '' : '区间未填全' };
    }
    if (type === 'select' || type === 'cascader' || type === 'tree') {
      var rs = await fillSelect(item, value);
      return { ok: rs.ok, how: 'pick', value: rs.committed || rs.pickedText || '', reason: rs.reason, exact: rs.exact };
    }
    if (type === 'multi') {
      return { ok: false, how: 'unknown', reason: '本字段含多个下拉（矩阵型），工具不代填，请人工设置' };
    }
    return { ok: false, how: 'unknown', reason: 'unsupported-control' };
  }

  // ==================== 文本 <-> 字段 序列化 ====================
  // 单行：「字段：值」；多行值用块语法：
  //   职位职责：<<<
  //   1、xxx：yyy
  //   2、zzz
  //   >>>
  function parseSource(text) {
    var src = {};
    if (!text) return src;
    var lines = String(text).replace(/\r/g, '').split('\n');
    var curKey = null, inBlock = false, buf = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (inBlock) {
        if (/^\s*>>>\s*$/.test(line)) { src[curKey] = buf.join('\n'); inBlock = false; buf = []; curKey = null; }
        else buf.push(line);
        continue;
      }
      var mb = line.match(/^\s*([^：:\n]{1,60}?)[：:]\s*<<<\s*$/);
      if (mb) { curKey = mb[1].trim(); inBlock = true; buf = []; continue; }
      var m = line.match(/^\s*([^：:\n]{1,60}?)[：:]\s?(.*)$/);
      if (m) { curKey = m[1].trim(); src[curKey] = m[2]; }
      else if (curKey != null) { src[curKey] += '\n' + line; }
    }
    if (inBlock && curKey) src[curKey] = buf.join('\n');
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) src[k] = String(src[k]).replace(/\s+$/, '');
    return src;
  }
  function serializeSource(obj, order) {
    var keys = order && order.length ? order : Object.keys(obj);
    var out = [];
    keys.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) return;
      var v = String(obj[k] == null ? '' : obj[k]);
      if (v.indexOf('\n') !== -1) out.push(k + '：<<<\n' + v + '\n>>>');
      else out.push(k + '：' + v);
    });
    return out.join('\n');
  }

  // ==================== 需求提取 ====================
  // 真机校准：下面这批是飞书招聘「需求详情」里实际出现过的字段名
  var KNOWN_REQ_FIELDS = [
    // 审批状态/招聘类型是 2026-08-03 真机侦察补上的：前者是门禁判据，后者决定职位类型(社招/校招)
    '审批状态', '招聘类型',
    '需求名称', '需求编号', '需求状态', '增补原因', '人员类型', '需求部门', '所属部门', '用人部门',
    '职级', '职位类别', '职位序列', '工作地点', '需求人数', '招聘人数', '需求提出人', '用人经理',
    '招聘负责人', '需求负责人', '直属上级', '汇报对象', '开始日期', '期望候选人到岗时间', '期望到岗时间',
    '所属成本中心', '是否保密岗位', '职务', '职位职责', '岗位职责', '职责', '职位描述',
    '职位要求', '任职要求', '业务影响', '关键项目', '学历要求', '经验要求', '薪资范围', '优先级',
    '替换人员', '替换人员最后工作日'
  ];
  function isKnownField(k) {
    var n = norm(k);
    for (var i = 0; i < KNOWN_REQ_FIELDS.length; i++) if (norm(KNOWN_REQ_FIELDS[i]) === n) return true;
    return false;
  }
  var NOISE_KEY = /^(操作|更多|编辑|删除|关闭|取消|确定|保存|提交|全选|序号|新建|导出|筛选|搜索|重置|展开|收起|复制|详情|返回|上一页|下一页|共|第)/;

  /**
   * 在多个候选容器上各跑一次提取，挑「命中的已知需求字段最多」的那份结果。
   * 真机教训：需求详情页里同时存在「审批状态/招聘进展」「关联职位」「基本信息」等多个块，
   * 按 DOM 节点数挑容器会挑中关联职位那块，抓出一堆职位名当字段。必须按内容打分。
   */
  function extractBest() {
    var roots = [];
    try {
      roots = [].slice.call(document.querySelectorAll(
        '[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"],' +
        '[class*="detail"],[class*="Detail"],[class*="basic"],[class*="Basic"],[class*="info"],[class*="Info"]'
      )).filter(vis).filter(function (r) { return !isOurs(r); });
    } catch (e) {}
    try { if (document.body) roots.push(document.body); } catch (e) {}
    // ⚠️ 2026-08-04 改为【合并全部区块】而不是"挑得分最高的那一个"。
    // 挑一个的做法在真机上会丢东西：需求详情被拆成「基本信息」「岗位信息」「其它」等多个块，
    // 只取赢家等于只抓到其中一块，用户看到的就是"复制了但少了一半字段"。
    // 之前不敢合并是因为会把「关联职位/招聘进展」的行也吃进来 —— 那个问题已由
    // inExcludedBlock() 按区块标题整块排除掉了，所以现在合并是安全的。
    // 合并规则：先到先得（内层的具体区块排在 body 前面，天然优先），已知字段可以覆盖非已知字段。
    var bestData = {};
    for (var i = 0; i < roots.length && i < 40; i++) {
      var d;
      try { d = extractFrom(roots[i]); } catch (e) { continue; }
      for (var kk2 in d) {
        if (!Object.prototype.hasOwnProperty.call(d, kk2)) continue;
        if (kk2 === '__nameFromTitle') continue;
        var already = Object.prototype.hasOwnProperty.call(bestData, kk2);
        if (!already) { bestData[kk2] = d[kk2]; continue; }
        // 同名字段取更"像样"的那一份：非空优先，其次更长（截断/省略号的那份通常更短）
        var oldV = String(bestData[kk2] || ''), newV = String(d[kk2] || '');
        if (!oldV.trim() && newV.trim()) bestData[kk2] = d[kk2];
      }
    }
    // 需求名称通常在详情页头部、不在「基本信息」块里，用标题兜底补上
    var hasName = false;
    for (var kk in bestData) if (Object.prototype.hasOwnProperty.call(bestData, kk) && /需求名称|职位名称/.test(kk)) hasName = true;
    // ⚠️ title 兜底只在【确实打开了详情抽屉/弹层】时才允许启用。
    // 这个值会经默认映射第一行直接变成新职位的【职位名称】，一旦是垃圾串就会写进真实职位。
    // 实测在需求列表页会采纳「我的工作台」「招聘需求详情」「需求详情-飞书招聘」
    // 「acme招聘 - 需求列表」→「acme招聘」这类标题，而下方的整词排除表挡不住它们。
    var detailOpen = false;
    try {
      detailOpen = [].slice.call(document.querySelectorAll(
        '[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]'
      )).some(vis);
    } catch (e) {}
    // ⚠️ 真机实测（2026-08-04，R00057）：需求详情是【整页路由】/hire/job/requirement/<id>，
    // 页面上没有任何弹层，于是这条 title 兜底恒不生效 —— 而「需求名称」在详情的基本信息块里
    // 根本没有对应的 label-value 行（它在页面头部），结果是 需求名称 永远抓不到，
    // 新职位的「职位名称」永远填不上，第 1 步必被必填拦死。这是一键在真机上跑不通的头号原因。
    // 现在：详情路由本身就算「详情已打开」。列表页 /requirement/list 仍然排除在外。
    if (!hasName && (detailOpen || isRequirementDetailRoute())) {
      var t = '';
      try {
        // 只按「空格-空格」这种分隔符切，不能按裸连字符切 ——
        // 真实需求名里常含连字符（实测「压测需求-900-前端 - 招聘需求」被截成「压测需求」）
        t = String(document.title || '').split(/\s+[-–|｜]\s+/)[0].trim();
      } catch (e) {}
      // 只排除整词的通用标题；不能用"含招聘二字就排除"，真实需求名往往就叫「校园招聘」
      // 另加：明显是页面标题而非需求名的形态（含"详情/列表/工作台"）一律不采纳
      var looksLikePageTitle = /详情|列表|工作台|首页|后台|控制台/.test(t);
      if (t && t.length >= 2 && t.length <= 40 && !looksLikePageTitle
        && !/^(飞书招聘|招聘需求|职位列表|需求列表|职位|需求|飞书)$/.test(t)) {
        bestData['需求名称'] = t;
        bestData.__nameFromTitle = true; // 标记来源，面板里提示"待确认"
      }
    }
    return bestData;
  }

  // 详情容器：优先抽屉/弹窗；否则取正文里 label-value 最密集的可见容器
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

  /**
   * 只读详情提取：叶子节点像 label → 取邻近节点作为 value。
   * 关键约束（否则会产出大量垃圾字段）：
   *   - 被当作 value 用掉的节点记入 consumed，不再反过来充当 key（避免「研发中心 => 需求部门」这种反向对）；
   *   - key 必须"像标签"：已知字段名 / 以冒号结尾 / class 含 label|title|name|field，
   *     或者是「父节点恰好两个子元素且自己排第一」的经典 label-value 行。
   */
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
  function scanReadonly(root, out) {
    var nodes = [];
    try { nodes = [].slice.call(root.querySelectorAll('div,span,td,li,dt,dd,label,p,h4,h5')); } catch (e) { return; }
    var consumed = [];
    function isConsumed(el) { for (var i = 0; i < consumed.length; i++) if (consumed[i] === el) return true; return false; }
    for (var i = 0; i < nodes.length && Object.keys(out).length < 60; i++) {
      var n = nodes[i];
      if (isConsumed(n) || isOurs(n)) continue;
      if (inExcludedBlock(n)) continue;   // 关联职位/招聘进展等区块不是需求字段
      var kids = 0;
      try { kids = n.children.length; } catch (e) {}
      if (kids > 0) continue;
      if (!vis(n)) continue;
      var t = txt(n);
      if (!t || t.length > 18) continue;
      var key = t.replace(/[:：*\s]+$/g, '').trim();
      if (!key || key.length < 2 || key.length > 14) continue;
      if (!/[一-龥A-Za-z]/.test(key)) continue;
      if (NOISE_KEY.test(key)) continue;
      if (out[key]) continue;
      // 表格里的表头/单元格不参与只读详情扫描（表头之间互为兄弟，会配出「需求名称 => 需求部门」这种垃圾）
      try {
        var tg = n.tagName ? String(n.tagName).toLowerCase() : '';
        if (tg === 'th') continue;
        if (n.closest && n.closest('table,thead,[role="table"],[role="columnheader"],[class*="thead"]')) continue;
      } catch (e) {}
      if (!keyConfidence(n, key)) continue;
      var pair = valueNear(n, key);
      if (!pair || !pair.text || pair.text === key) continue;
      var v = pair.text;
      if (v.length > 4000) v = v.slice(0, 4000);
      if (/^请选择|^请输入|^--$|^-$/.test(v)) continue;
      out[key] = v;
      consumed.push(pair.el);
    }
  }
  /**
   * 判断某个候选节点是不是"整行容器"而非"值"。
   * 真机教训：不能靠 class 里有没有 "label" 来判断 —— 飞书需求详情的值节点自己就带
   * class="bpmBiz_atsx_clamp-label"（纯样式类），按 class 判定会把真正的值全部误杀。
   * 改为按语义：值节点里如果还包着【另一个已知字段名】，那它就是容器。
   */
  function containsOtherLabel(c, selfKey) {
    try {
      var kids = c.querySelectorAll('*');
      for (var i = 0; i < kids.length && i < 80; i++) {
        if (kids[i].children.length) continue;
        var t = txt(kids[i]).replace(/[:：*\s]+$/g, '');
        if (t && t !== selfKey && isKnownField(t)) return true;
      }
    } catch (e) {}
    return false;
  }
  function valueNear(n, key) {
    var cands = [];
    // ⚠️ 候选顺序很关键：只往【后】找，不能把父节点下排在前面的兄弟也当候选。
    // 栅格布局里前一个兄弟往往是另一个字段的 label，实测会出现
    //   [需求部门][研发中心][职级][空][工作地点][上海]
    // → 职级的值被取成字符串"需求部门"，这个假值会一路流进真实职位表单。
    try { if (n.nextElementSibling) cands.push(n.nextElementSibling); } catch (e) {}
    try {
      var p = n.parentElement;
      if (p) {
        // 同一行内【排在 label 之后】的兄弟（label 与 value 常是同一父下的两个子节点）
        var sibs = [].slice.call(p.children || []);
        var self = sibs.indexOf(n);
        for (var i = self + 1; i >= 0 && i < sibs.length; i++) {
          if (sibs[i] !== n && !sibs[i].contains(n)) cands.push(sibs[i]);
        }
        if (p.nextElementSibling) cands.push(p.nextElementSibling);
      }
    } catch (e) {}
    for (var j = 0; j < cands.length; j++) {
      var c = cands[j];
      // 值节点里若还包着别的字段名，说明这是个整行容器（如区块标题的下一行是整行 label+value），不是值
      if (containsOtherLabel(c, key)) continue;
      var t = txt(c);
      // 候选本身就是另一个已知字段名 → 已经越过本字段这一格的边界，必须【停止】而不是跳过。
      // 跳过的话会继续往后扫，把【下一个字段的值】当成本字段的值——
      // 实测 [需求部门][研发中心][职级][空][工作地点][上海] 里，
      // 职级的值会被取成"上海"。本字段的值槽是空的，就该如实认定为空。
      // 另注：containsOtherLabel 只查后代，而叶子 label 没有后代，那条防线对它恒为 false，
      // 所以这里必须单独判。
      var bare = (t || '').replace(/[:：*\s]+$/g, '');
      if (bare && bare !== key && isKnownField(bare)) break;
      if (!t) continue;
      // 超长值：截断会静默丢数据，跳过又会误取到下一个兄弟的文本。如实截断并标注。
      if (t.length > 4000) return { el: c, text: t.slice(0, 4000), truncated: true };
      return { el: c, text: t };
    }
    return null;
  }

  // 表格行：表头 ↔ 单元格
  function extractFromRow(row, out) {
    var cells = [];
    try { cells = [].slice.call(row.querySelectorAll('td,[role="cell"],[class*="cell"]')).filter(function (c) { return vis(c); }); } catch (e) {}
    if (!cells.length) return false;
    // 去嵌套
    cells = cells.filter(function (a) {
      for (var i = 0; i < cells.length; i++) if (cells[i] !== a && a.contains(cells[i])) return false;
      return true;
    });
    var heads = [];
    try {
      // 注意：行自身的 class 常含 "table"（如 ud__table__row），closest 会命中自己 → 必须从父节点起找
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

  // 自己的面板不能被自己抓进去
  function isOurs(el) {
    try { return !!(el && el.closest && el.closest('#' + PANEL_ID)); } catch (e) { return false; }
  }
  /**
   * 需求详情里【不属于需求本身】的区块。
   * ⚠️ 真机实测（2026-08-04，R00057）：不排掉的话「关联职位」区块里的 4 条职位会被
   * 当成需求字段抓出来 —— 产品经理（财务方向）=杭州ACME、LXD-内部招聘=北京ACME、
   * 校园招聘=杭州ACME… 它们形态上就是标准的 label-value 行，keyConfidence 拦不住；
   * 而其中「校园招聘」恰好与需求名同名，混进来极具误导性。招聘进展同理（=Offer沟通1 待入职2）。
   * 判据用【区块标题文案】而不是 class（class 带哈希后缀，飞书发版就变）。
   */
  var BLOCK_EXCLUDE = /^(关联职位|关联需求|招聘进展|审批流程|审批记录|操作日志|附件)$/;
  function inExcludedBlock(el) {
    var n = el, hops = 0;
    while (n && hops < 8) {
      try {
        // class 兜底：真机上关联职位区块的类名形如 rrjHeaderButtonsContainer__xxx
        if (/relatedJob|rrj[A-Z]|associateJob/.test(String(n.className || ''))) return true;
        var head = n.querySelector && n.querySelector('h1,h2,h3,h4,h5,[class*="blockTitle"],[class*="cardTitle"],[class*="sectionTitle"]');
        if (head && BLOCK_EXCLUDE.test(norm(txt(head)))) return true;
      } catch (e) {}
      try { n = n.parentElement; } catch (e) { break; }
      hops++;
    }
    return false;
  }
  // 列表页的筛选条/搜索框也是 form__item，绝不能当成需求内容抓走
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
  function extractFrom(root) {
    var out = {};
    // 1) 编辑态表单项
    var items = itemsFrom(root);
    items.forEach(function (it) {
      if (inToolbar(it) || isOurs(it) || inExcludedBlock(it)) return;
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
    // 4) 兜底：整块文本按「字段：值」解析。
    //    仅在"用户明确框选的容器"上做——整页文本会把本面板自己的模板内容也吃进来。
    var isPageRoot = false;
    try { isPageRoot = (root === document || root === document.body); } catch (e) {}
    if (!isPageRoot && Object.keys(out).length < 2) {
      var parsed = parseSource(txt(root));
      for (var k in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
        if (k.length > 14 || NOISE_KEY.test(k)) continue;
        if (!out[k] && parsed[k]) out[k] = parsed[k];
      }
    }
    return out;
  }
  // 已知字段排前面，方便人工核对
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

  // ==================== 点选（逐字段） ====================
  // ⚠️ 2026-08-04 重做。原来是"往上找一个大容器（行/卡片/抽屉）整块抓"——
  // 真机上一框就是大半个详情页，抓回来一堆噪声，用户反馈"范围太大且没有用"。
  // 现在改成【对准哪个字段就取哪个字段】：悬停高亮的是"标签+值"这一对，点一下只加这一条，
  // 且点完不退出，可以连着把缺的几项逐个补齐，按 Esc 才结束。
  var picking = false, pickCleanup = null;

  /** 这个节点像不像"字段标签"（叶子、短、不是纯符号） */
  function looksLikeLabelNode(n) {
    try {
      if (!n || n.children.length) return false;
      var t = txt(n);
      if (!t) return false;
      var k = t.replace(/[:：*\s]+$/g, '').trim();
      return !!(k && k.length >= 2 && k.length <= 14 && /[一-龥A-Za-z]/.test(k) && !NOISE_KEY.test(k));
    } catch (e) { return false; }
  }

  /**
   * 光标下的那一个字段。
   * 两个方向都试，因为用户可能对着标签点，也可能对着值点：
   *   ① 命中的是标签 → 用 valueNear 找它右边/下面的值
   *   ② 命中的是值   → 往前找同排的标签（上一个兄弟，或父节点里排在自己前面的叶子）
   * 找不成对就返回 null（此时不高亮、点了也不加），而不是退化成"框住一大片"。
   */
  function fieldPairAt(el) {
    var n = el, hops = 0;
    while (n && hops < 5) {
      if (!isOurs(n) && !inExcludedBlock(n)) {
        // ① 自己就是标签
        if (looksLikeLabelNode(n)) {
          var key = txt(n).replace(/[:：*\s]+$/g, '').trim();
          var pair = valueNear(n, key);
          if (pair && pair.text && pair.text !== key) return { key: key, value: pair.text, els: [n, pair.el] };
        }
        // ② 自己是值 → 往前找标签
        var isLeaf = false;
        try { isLeaf = !n.children.length && !!txt(n); } catch (e) {}
        if (isLeaf) {
          var lab = prevLabelOf(n);
          if (lab) {
            var k2 = txt(lab).replace(/[:：*\s]+$/g, '').trim();
            var v2 = txt(n);
            if (k2 && v2 && k2 !== v2) return { key: k2, value: v2, els: [lab, n] };
          }
        }
      }
      try { n = n.parentElement; } catch (e) { break; }
      hops++;
    }
    return null;
  }
  /** 值节点往前找它的标签：先看前一个兄弟，再看父节点里排在自己之前的叶子 */
  function prevLabelOf(valueEl) {
    try {
      var p = valueEl.previousElementSibling;
      if (p && looksLikeLabelNode(p)) return p;
      var parent = valueEl.parentElement;
      if (parent) {
        var kids = [].slice.call(parent.children || []);
        var self = kids.indexOf(valueEl);
        for (var i = self - 1; i >= 0; i--) if (looksLikeLabelNode(kids[i])) return kids[i];
        // 栅格布局里标签常在父的父那一层
        var pp = parent.previousElementSibling;
        if (pp && looksLikeLabelNode(pp)) return pp;
      }
    } catch (e) {}
    return null;
  }

  function startPick() {
    if (picking) return;
    picking = true;
    var box = document.createElement('div');
    box.id = PICK_ID;
    box.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #4f46e5;'
      + 'background:rgba(79,70,229,0.10);border-radius:4px;transition:all .05s;';
    var tip = document.createElement('div');
    tip.id = PICK_ID + '-tip';
    tip.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;background:#4f46e5;color:#fff;'
      + 'font:12px/1.6 system-ui,sans-serif;padding:2px 8px;border-radius:4px;max-width:320px;'
      + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none';
    document.body.appendChild(box);
    document.body.appendChild(tip);
    var picked = 0, current = null;
    function hint() {
      setStatus('🎯 <b>逐项点选</b>：鼠标对准某一个字段（标签或值都行），高亮的就是会取走的那一条，点一下加进「已粘贴」。'
        + '可以连着点多个；按 <b>Esc</b> 结束。'
        + (picked ? '<div style="margin-top:4px;color:#059669">已取 <b>' + picked + '</b> 项</div>' : ''));
    }
    hint();

    function place(els) {
      try {
        var l = 1e9, t = 1e9, r = -1e9, b = -1e9;
        els.forEach(function (n) {
          var q = n.getBoundingClientRect();
          if (!q.width && !q.height) return;
          l = Math.min(l, q.left); t = Math.min(t, q.top);
          r = Math.max(r, q.right); b = Math.max(b, q.bottom);
        });
        if (r <= l || b <= t) { box.style.display = 'none'; return; }
        box.style.display = '';
        box.style.left = (l - 2) + 'px'; box.style.top = (t - 2) + 'px';
        box.style.width = (r - l + 4) + 'px'; box.style.height = (b - t + 4) + 'px';
        tip.style.display = '';
        tip.style.left = (l - 2) + 'px';
        tip.style.top = Math.max(0, t - 24) + 'px';
      } catch (e) {}
    }
    function onMove(e) {
      var t = e.target;
      if (!t || t.id === PICK_ID) return;
      try { if (t.closest && t.closest('#' + PANEL_ID)) return; } catch (err) {}
      var f = fieldPairAt(t);
      current = f;
      if (!f) { box.style.display = 'none'; tip.style.display = 'none'; return; }
      tip.textContent = f.key + '：' + String(f.value).replace(/\s+/g, ' ').slice(0, 40);
      place(f.els);
    }
    function onClick(e) {
      var t = e.target;
      try { if (t && t.closest && t.closest('#' + PANEL_ID)) return; } catch (err) {}
      try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
      var f = current || fieldPairAt(t);
      if (!f) { setStatus('这里认不出"标签+值"这一对，换个位置点（对准字段名或它的值）。'); return; }
      // 加进「已粘贴」：同名字段就地更新，不重复堆积
      var fields = pendingFields();
      fields[f.key] = f.value;
      savePending(serializeSource(fields, orderKeys(fields)));
      picked++;
      hint();
    }
    function onKey(e) {
      if (e && (e.key === 'Escape' || e.keyCode === 27)) {
        stop();
        setStatus(picked ? '✓ 点选结束，共取 <b>' + picked + '</b> 项，已加进「已粘贴」。' : '已结束点选（没有取任何字段）。');
      }
    }
    function stop() {
      picking = false;
      try { document.removeEventListener('mousemove', onMove, true); } catch (e) {}
      try { document.removeEventListener('click', onClick, true); } catch (e) {}
      try { document.removeEventListener('keydown', onKey, true); } catch (e) {}
      var b = $(PICK_ID); if (b) b.remove();
      var tp = $(PICK_ID + '-tip'); if (tp) tp.remove();
      pickCleanup = null;
    }
    pickCleanup = stop;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function applyExtracted(data, from) {
    // 内部标记不能混进字段列表（会被当成一个叫 __nameFromTitle 的需求字段序列化出去）
    var nameFromTitle = !!data.__nameFromTitle;
    if (nameFromTitle) { try { delete data.__nameFromTitle; } catch (e) { data.__nameFromTitle = undefined; } }
    var keys = Object.keys(data).filter(function (k) { return k !== '__nameFromTitle'; });
    if (!keys.length) {
      setStatus('⚠ 没提取到字段。请先<b>点开一条需求的详情</b>再复制；或用「🎯 点选复制」框住需求所在区域。');
      return;
    }
    var text = serializeSource(data, orderKeys(data));
    // ⚠️ 2026-08-04：不再弹"要不要覆盖"的二次确认。
    // 那个确认渲染在面板【最底部的状态区】，而面板里内容一多它就在视口外——
    // 用户点了「复制当前需求」什么都没看见，反馈是"这个键点了没反应"（真机反馈）。
    // 现在：直接覆盖 + 留一步【撤销】，并把状态区滚进视野。行为可预期，误覆盖也能退回来。
    var prev = clipText();
    undoExtract = (prev && prev.trim() !== String(text).trim()) ? prev : null;
    savePending(text);
    var knownHits = keys.filter(isKnownField).length;
    log('extracted', data);
    var undoBtn = undoExtract
      ? '<div style="margin-top:6px"><button id="ta-req-undo" class="ta-req-btn ta-req-btn-ghost">↩ 撤销，恢复我改过的内容</button></div>'
      : '';
    // 低置信度：多半是没点开详情，抓到了筛选条/页面碎片 —— 必须显式告警，不能报成功
    if (!knownHits || keys.length < 3) {
      setStatus('⚠ 只从「' + escapeHtml(from) + '」提取到 <b>' + keys.length + '</b> 个字段'
        + (knownHits ? '' : '，且没有一个像需求字段')
        + '。多半是<b>没点开需求详情</b>。请点开详情后重试，或用「🎯 点选」逐项点取；也可直接在上方手工补齐。'
        + undoBtn);
      bindUndo();
      return;
    }
    setStatus('✓ 已复制本页 <b>' + keys.length + '</b> 个字段到「已粘贴」，请核对后直接点「⚡ 一键」。' + undoBtn
      + (nameFromTitle
        ? '<div style="margin-top:4px;color:#b45309">⚠ 其中「需求名称」是从<b>页面标题</b>推断的（详情里没直接找到），'
          + '它会成为新职位的职位名称，<b>请务必先核对</b>。</div>'
        : ''));
    bindUndo();
  }
  /** 「复制当前需求」误覆盖了手改内容时的一步撤销 */
  var undoExtract = null;
  function bindUndo() {
    on('ta-req-undo', 'click', function () {
      if (undoExtract == null) return;
      savePending(undoExtract);
      undoExtract = null;
      setStatus('已恢复你之前的内容。');
    });
  }

  // ==================== 字段映射 ====================
  /**
   * 字段映射（2026-08-03 按真机三步向导重写）。
   *
   * 语法：
   *   需求字段 => 职位字段1|职位字段2 :: 需求值A=职位值A, 需求值B=职位值B
   *   需求字段A+需求字段B => 职位字段      ← 左边用 + 连接＝把多个需求字段拼起来写进同一个目标
   *   "字面值" => 职位字段                 ← 左边加引号＝固定值，不来自需求（如招聘流程）
   *   # ── 第N步 …                        ← 注释里出现「第N步」即切换分组，下面的行只在该步执行
   *
   * ⚠️ 真机侦察结论（不是猜的）：飞书从需求进来时【自己已经带了】招聘数量、关联招聘需求、
   * 招聘负责人；第 2 步除「招聘流程」外全是预置默认值。所以本表只列真正需要工具写的字段，
   * 已有值的一律跳过（默认「仅填空字段」模式），不去覆盖飞书自己带对的东西。
   */
  var DEFAULT_MAP = [
    '# ── 第1步 基础信息 ──────────────────────────────────',
    '需求名称 => 职位名称|岗位名称|职位标题',
    '招聘类型 => 职位类型 :: 校招=校招,校园招聘=校招,校园=校招,社招=社招,社会招聘=社招,社会=社招',
    '人员类型 => 雇佣类型|职位性质 :: 正式员工=全职,正式=全职,正职=全职,全职=全职,实习生=实习,实习=实习,外包员工=外包,外包=外包,劳务派遣=劳务,劳务=劳务,顾问=顾问',
    '职位类别 => 职位类别|职位序列|职类',
    '需求部门 => 部门|所属部门|用人部门',
    '工作地点 => 工作地点|工作城市|办公地点|城市',
    '职能类型 => 职能分类|职能类型|职能',
    '职级 => 职级范围|职级|职位职级|职等',
    '学历要求 => 学历要求|最低学历|学历',
    '经验要求 => 工作年限|经验要求|工作经验',
    '需求人数 => 招聘数量|招聘人数',
    '薪资范围 => 月薪范围|薪资范围|薪资',
    '职位职责+职位要求 => 职位描述|岗位职责|工作职责|工作内容',
    '',
    '# ── 第2步 职位设置 ──────────────────────────────────',
    '# 这一步只有「招聘流程」是空的，其余（面试轮次/Offer申请表/发件邮箱/关联招聘需求）飞书已预置，工具不动。',
    '# 招聘流程的可选项随「职位类型」联动：社招下是 默认社招流程/外包人员招聘流程/（海外）ACME社招流程。',
    '# 换租户或换校招时，把下面这行的固定值改成你要的流程名即可。',
    '"默认社招流程" => 招聘流程',
    '',
    '# ── 第3步 负责人 ────────────────────────────────────',
    '# 招聘负责人飞书已预填当前登录人，不覆盖。用人经理是必填且为空。',
    '用人经理 => 用人经理|直属上级|汇报对象',
    '招聘协助人 => 招聘协助人',
  ].join('\n');

  function getMapText() { var t = lsGet(MAP_KEY); return t == null ? DEFAULT_MAP : t; }
  /**
   * 一行的语法：  需求字段 => 职位字段1|职位字段2 :: 需求值A=职位值A, 需求值B=职位值B
   * 「::」后的值映射可选 —— 真机上两边的枚举常常对不齐（需求写"正式"，职位下拉只有"全职"），
   * 没有值映射时下拉一定点不中，只能退化成人工选。
   */
  function parseMap(text) {
    var rows = [];
    var curStep = null;   // null = 不限步骤（老映射表没有分组，保持原来"每步都试"的语义）
    String(text || '').split('\n').forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      if (s.indexOf('#') === 0) {
        // 注释里出现「第N步」即切换分组
        var ms = /第\s*([0-9１-９一二三])\s*步/.exec(s);
        if (ms) {
          var d = { '１': 1, '２': 2, '３': 3, '一': 1, '二': 2, '三': 3 }[ms[1]] || parseInt(ms[1], 10);
          if (d >= 1 && d <= 3) curStep = d - 1;
        }
        return;
      }
      var valPart = '';
      var vi = s.indexOf('::');
      if (vi >= 0) { valPart = s.slice(vi + 2); s = s.slice(0, vi); }
      var m = s.split(/=>|＝>|->/);
      if (m.length < 2) return;
      var fromRaw = m[0].trim();
      var to = m[1].split(/[|｜,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (!fromRaw || !to.length) return;
      // 左边加引号 = 固定值，不去需求里取
      var literal = null;
      var lm = /^["“”'']([\s\S]+)["“”'']$/.exec(fromRaw);
      if (lm) literal = lm[1].trim();
      // 左边用 + 连接 = 多个需求字段拼成一段写进同一个目标（职位职责+职位要求 → 职位描述）
      var froms = literal == null
        ? fromRaw.split('+').map(function (x) { return x.trim(); }).filter(Boolean)
        : [];
      var vals = null;
      if (valPart) {
        vals = {};
        valPart.split(/[,，;；]/).forEach(function (pair) {
          var kv = pair.split(/=|＝/);
          if (kv.length === 2 && kv[0].trim() && kv[1].trim()) vals[norm(kv[0])] = kv[1].trim();
        });
      }
      rows.push({
        from: literal == null ? froms.join('+') : ('固定值「' + literal + '」'),
        froms: froms, literal: literal, to: to, vals: vals, step: curStep,
      });
    });
    return rows;
  }

  // ==================== 填充职位 ====================
  /** 当前值是否已满足目标值：文本要求相等，下拉/树允许"当前值包含目标值" */
  function isSameEnough(cur, value, type) {
    var a = norm(cur), b = norm(value);
    if (!a || !b) return false;
    if (a === b) return true;
    if (type === 'select' || type === 'tree' || type === 'cascader') {
      // ⚠️ 不能用裸 indexOf：'P5-10'.indexOf('P5-1') === 0 会成立，
      // 于是表单里已有的错值 P5-10 会被判成"与目标 P5-1 已一致，跳过"，
      // 错值原样留在表单里，还被归进灰色的"已一致"分组，用户根本不会去看。
      // 只接受"当前值以目标开头、且边界没有切断同类字符"这种真前缀。
      // 判据：目标末字符与其后一个字符【同为字母数字】才算切断（P5-1 | 0）；
      // 目标以中文等非字母数字结尾时（研发中心 | -ODC、全球研发中心 | ODC）属于合法的更全显示值。
      var i = a.indexOf(b);
      if (i !== 0) return false;
      var next = a.charAt(b.length);
      if (next === '') return true;
      var alnum = /[0-9a-z]/i;
      return !(alnum.test(b.charAt(b.length - 1)) && alnum.test(next));
    }
    return false;
  }

  var FILL_MODES = {
    'empty': '仅填空字段（保留人工修改）',
    'smart': '智能覆盖（只改我上次填的）',
    'force': '全部覆盖'
  };
  function getMode() { var m = lsGet(MODE_KEY); return FILL_MODES[m] ? m : 'empty'; }

  function newReport() {
    return {
      filled: [], picked: [], same: [], kept: [], prefilled: [], manual: [],
      failed: [], notFound: [], inexact: [], reverted: [], notes: [],
      blocked: '', steps: [],
    };
  }

  /**
   * 映射表 + 需求字段 → 待填计划。
   * @param inWiz 是否处在三步向导里。向导里【关掉同名兜底】：
   *   映射表已按真机逐字段核对过，兜底反而会拿「所属部门/需求编号/审批状态」这类字段
   *   去模糊命中职位表单（itemByLabels 的包含匹配会让"所属部门"命中"部门"），
   *   造成同一个表单项被写两次，且第二次读到的"当前值"正是自己刚写的。
   */
  function buildPlan(clipFields, maps, report, inWiz) {
    var plan = [], usedFrom = {};
    maps.forEach(function (m) {
      var val, raw, labels;
      if (m.literal != null) {
        val = m.literal; raw = m.literal; labels = m.to.slice();
      } else {
        // 多源拼接（职位职责 + 职位要求 → 职位描述）：真机上职位表单只有「职位描述」一个富文本，
        // 不拼的话「职位要求」整段内容会被丢掉且报成"表单里没找到"。
        var parts = [];
        m.froms.forEach(function (f) {
          for (var k in clipFields) {
            if (!Object.prototype.hasOwnProperty.call(clipFields, k)) continue;
            if (norm(k) !== norm(f)) continue;
            var v = clipFields[k];
            if (v != null && String(v).trim() !== '') { parts.push(String(v).trim()); usedFrom[k] = true; }
            break;
          }
        });
        if (!parts.length) return;
        raw = parts.join('\n\n');
        val = raw;
        // 值映射只对"单一来源的枚举值"生效；拼接出来的长文本不该被拿去查枚举表
        if (m.vals && parts.length === 1 && m.vals[norm(raw)]) val = m.vals[norm(raw)];
        labels = m.to.concat(m.froms);
      }
      plan.push({ from: m.from, to: m.to, labels: labels, value: val, raw: raw, step: m.step });
    });
    if (!inWiz) {
      Object.keys(clipFields).forEach(function (k) {
        if (usedFrom[k]) return;
        var v = clipFields[k];
        if (v == null || String(v).trim() === '') return;
        plan.push({ from: k, to: [k], labels: [k], value: String(v), raw: String(v), step: null });
      });
    }
    // 计划去重：多条映射可能撞到【同一个目标表单项】。
    // 例如「职位职责 => 职位描述|…」和「职责 => 职位描述|…」都命中同一个富文本 →
    // 第二条读到的"当前值"正是第一条刚写进去的，于是在"仅填空"模式下被报成
    // 🛡「已保留人工内容」——那内容其实是工具自己写的，用户会以为那里有人工填过。
    var seen = {}, out = [], dropped = [];
    for (var i = 0; i < plan.length; i++) {
      var sig = plan[i].to.map(function (x) { return norm(x); }).join('|');
      if (seen[sig]) { dropped.push(plan[i].from + '→' + plan[i].to[0]); continue; }
      seen[sig] = true;
      out.push(plan[i]);
    }
    if (dropped.length && report) {
      report.notFound.push.apply(report.notFound, dropped.map(function (d) { return d + '(目标字段已被前一条映射占用)'; }));
    }
    return out;
  }

  /**
   * 填一批计划项。
   * @param stepIdx null=不限步骤（当前视图能找到就填）；数字=只填标注了该步的项
   * ctx: {mode, logStore, written, report, writtenItems}
   */
  async function fillStep(plan, stepIdx, ctx) {
    var report = ctx.report, mode = ctx.mode;
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      if (p.done) continue;
      if (stepIdx != null && p.step != null && p.step !== stepIdx) continue;
      var item = itemByLabels(p.labels || p.to);
      if (!item) {
        // 标了步骤的项在别的步骤上找不到是正常的，不算"没找到"，留给它自己的那一步
        if (stepIdx == null || p.step == null || p.step === stepIdx) {
          if (!p.missReported) { report.notFound.push(p.from); p.missReported = true; }
        }
        continue;
      }
      // 同一个 DOM 表单项在本轮里只写一次（名字不同但模糊命中到同一项时的最后一道防线）
      var dupe = false;
      for (var d = 0; d < ctx.writtenItems.length; d++) if (ctx.writtenItems[d] === item) { dupe = true; break; }
      if (dupe) { p.done = true; report.notFound.push(p.from + '(与前一条映射命中同一个表单项，已跳过)'); continue; }

      p.done = true;
      var label = labelOf(item) || p.to[0];
      p.label = label;
      var type = detectType(item);
      var cur = readItemValue(item, type);

      // 下拉/树用"包含"判定是否已满足：真机上选中后显示值往往比目标值长
      // （工作地点"上海" → 显示"上海 · 百色路88号…"）。若按相等判定就会再点一次，
      // 而多选树上重复点同一节点 = 取消选中，等于把已填好的字段清空。
      if (cur && isSameEnough(cur, p.value, type)) { report.same.push(label); ctx.written[label] = cur; continue; }
      if (cur) {
        // 飞书从需求进来时自己会带值（招聘数量/部门/招聘负责人…）。
        // 这类"我们没写过、页面本来就有"的值单列一档，不要和"人工填的"混为一谈。
        var isPrefilled = (ctx.logStore[label] == null);
        if (mode === 'empty') { (isPrefilled ? report.prefilled : report.kept).push(label + '（现为「' + String(cur).slice(0, 20) + '」）'); continue; }
        if (mode === 'smart') {
          var prev = ctx.logStore[label];
          if (prev == null || norm(prev) !== norm(cur)) { (isPrefilled ? report.prefilled : report.kept).push(label); continue; }
        }
      }
      try {
        var r = await fillOne(item, p.value);
        // 值映射没选中就用原值再试一次（映射是为了对齐枚举，不该在枚举本来就一致时帮倒忙）
        if (!r.ok && p.raw && p.raw !== p.value && (r.how === 'pick' || r.how === 'radio')) {
          r = await fillOne(item, p.raw);
        }
        if (r.ok) {
          ctx.writtenItems.push(item);
          ctx.written[label] = r.value || p.value;
          p.expect = p.value;
          if (r.note) report.notes.push(label + '：' + r.note);
          // 值写进去了但与来源不一致（被 maxlength 截断、下拉点中了父节点……）→ 这【不算成功】。
          if (r.exact === false) {
            report.inexact.push(label + '：期望「' + String(p.value).slice(0, 30)
              + '」实际「' + String(r.value || '').slice(0, 30) + '」' + (r.reason ? '（' + r.reason + '）' : ''));
          } else if (r.how === 'pick' || r.how === 'radio' || r.how === 'switch' || r.how === 'range') {
            report.picked.push(label + '→' + (r.value || ''));
          } else report.filled.push(label);
        } else if (r.how === 'pick' || r.how === 'unknown' || r.how === 'radio' || r.how === 'range' || r.how === 'switch') {
          report.manual.push(label + (r.reason ? '(' + r.reason + ')' : ''));
        } else {
          report.failed.push(label + (r.reason ? '：' + r.reason : ''));
        }
      } catch (e) {
        report.failed.push(label + '：' + ((e && e.message) || e));
      }
      await sleep(220);
    }
  }

  /**
   * 终检：跨字段联动造成的回滚只有回头再读一遍才看得见。
   * Formily 的父子联动（选部门重置职级、选职位类别重置职能分类）和组件异步回滚，
   * 都发生在我们已经判定"成功"之后。这里只报差异，不再动表单。
   */
  async function verifyPlan(plan, ctx) {
    await sleep(600);
    var reverted = [];
    for (var vi = 0; vi < plan.length; vi++) {
      var vp = plan[vi];
      if (!vp.label) continue;
      try {
        var vitem = itemByLabels(vp.labels || vp.to);
        if (!vitem) continue;
        var vlabel = labelOf(vitem) || vp.to[0];
        if (!Object.prototype.hasOwnProperty.call(ctx.written, vlabel)) continue;
        var vt = detectType(vitem);
        var now = readItemValue(vitem, vt);
        var want = String(ctx.written[vlabel] == null ? '' : ctx.written[vlabel]);
        if (!now) { reverted.push(vlabel + '（已被清空）'); continue; }
        if (!isSameEnough(now, want, vt) && String(now).trim() !== want.trim()) {
          reverted.push(vlabel + '（现为「' + String(now).slice(0, 24) + '」）');
        }
      } catch (e) { /* 单项终检失败不影响其它 */ }
    }
    // ⚠️ 累加而不是覆盖：向导每走一步都会调一次终检，直接赋值的话
    // 第 1 步发现的回滚会被第 2 步的空结果抹掉 —— 那正是最需要报出来的那一类问题。
    if (reverted.length) ctx.report.reverted = (ctx.report.reverted || []).concat(reverted);
  }

  /** 等步骤号变化。⚠️ 必须等 URL 真的变了，不能只等固定时长——被必填拦住时页面是不动的 */
  async function waitStepChange(from, ms) {
    var t = 0;
    while (t < ms) {
      await sleep(200); t += 200;
      var s = currentStep();
      if (s >= 0 && s !== from) return true;
    }
    return false;
  }

  /**
   * 三步向导驱动：填当前步 → 校验 → 点「下一步」→ 等步骤号真的变了 → 继续。
   * ⚠️ 走完第 3 步就停，【不点】「保存并完成更多设置」——提交是对外动作，必须由人做。
   */
  async function runWizard(plan, ctx) {
    var report = ctx.report;
    var guard = 0;
    while (guard++ < 8) {
      var step = currentStep();
      if (step < 0) { report.blocked = '不在新建职位向导里（URL 不是 /hire/job/create/{步骤}/…）'; return; }
      setStatus('正在填第 ' + (step + 1) + ' 步「' + escapeHtml(WIZARD_STEPS[step] || ('第' + (step + 1) + '步')) + '」…'
        + '<div style="margin-top:4px;color:#b45309">⚠ 请保持本标签页在前台，切走会被浏览器节流。</div>');
      await fillStep(plan, step, ctx);
      await verifyPlan(plan, ctx);
      report.steps.push('第' + (step + 1) + '步 ' + (WIZARD_STEPS[step] || ''));
      if (step >= WIZARD_STEPS.length - 1) return;   // 最后一步：停在提交按钮前

      var btn = nextButton();
      if (!btn) { report.blocked = '第' + (step + 1) + '步找不到「下一步」按钮'; return; }
      fireMouse(btn);
      var moved = await waitStepChange(step, 9000);
      if (!moved) {
        var errs = formErrors();
        report.blocked = '卡在第' + (step + 1) + '步（' + (WIZARD_STEPS[step] || '') + '）：'
          + (errs.length ? '页面报「' + errs.join('；') + '」' : '点了「下一步」但页面没有前进，且页面没有给出报错');
        return;
      }
      await sleep(900);   // 等下一步的表单渲染完
    }
    report.blocked = '步骤推进超过 8 轮仍未走完，已停止（防止死循环）';
  }

  // 填充中互斥锁：一键、填充按钮、SPA 重渲染三处都要看它
  var filling = false;
  async function runFillJob() {
    if (filling) return;
    var fields = pendingFields();
    if (!Object.keys(fields).length) {
      setStatus('⚠ 「已粘贴」是空的。请先在需求详情页点「⚡ 一键」或「📋 复制当前需求」。');
      return;
    }
    // 必须确认表单弹层真的打开了，不能只数表单项个数——
    // 列表页的筛选条也是表单项，且标签常与目标字段同名（见 formOpened 注释）
    if (!formOpened() || formItems().length < 3) {
      setStatus('⚠ 没检测到职位表单。请先在<b>本页</b>点「新建职位」把表单打开，再点填充。'
        + '<div style="margin-top:4px;color:#9ca3af;font-size:11.5px">'
        + '如果表单已经开着还是这个提示，点「🔍 扫描表单字段」看看能读到几个字段，把结果发我。</div>');
      return;
    }
    var mode = getMode();
    var report = newReport();
    var plan = buildPlan(fields, parseMap(getMapText()), report, inWizard());
    if (!plan.length) { setStatus('⚠ 待填充需求里没有非空字段。'); return; }
    var logStore = jGet(LOG_KEY, {});
    var written = {};

    filling = true;
    var btn = $('ta-req-fill-job');
    if (btn) { btn.disabled = true; btn.textContent = '填充中…请勿操作页面'; }
    // 真机教训：标签页切到后台后 Chrome 会把 setTimeout 节流到约 1 次/分钟，填充会慢到像卡死
    setStatus('正在按「' + escapeHtml(FILL_MODES[mode]) + '」填充 ' + plan.length + ' 个字段，过程会自动点开下拉/树，请勿手动操作…'
      + '<div style="margin-top:4px;color:#b45309">⚠ 填充期间请保持本标签页在前台，切走会被浏览器节流、变得极慢。</div>');

    var ctx = { mode: mode, logStore: logStore, written: written, report: report, writtenItems: [] };
    try {
      if (inWizard()) {
        // 三步向导：自己推进步骤，走完第 3 步停在提交按钮前
        await runWizard(plan, ctx);
      } else {
        // 单屏表单（旧版抽屉式「新建需求」等）：只填当前视图
        await fillStep(plan, null, ctx);
        await verifyPlan(plan, ctx);
      }

      // 记录本次写入值（供「智能覆盖」判定人工改动）
      var merged = {};
      for (var k1 in logStore) if (Object.prototype.hasOwnProperty.call(logStore, k1)) merged[k1] = logStore[k1];
      for (var k2 in written) if (Object.prototype.hasOwnProperty.call(written, k2)) merged[k2] = written[k2];
      jSet(LOG_KEY, merged);

      renderReport(report, mode);
      log('fill report', report);
    } catch (e) {
      setStatus('❌ 填充出错：' + escapeHtml((e && e.message) || String(e)));
    } finally {
      filling = false;
      if (btn) { btn.disabled = false; btn.textContent = '🚀 填充新建职位'; }
    }
  }

  // ==================== 一键编排（需求详情页一个按钮跑完） ====================
  // 门禁 → 提取 → 自动点「新建职位」→ 三步填充 → 汇总报告。
  // ⚠️ 唯一不做的事：点「保存并完成更多设置」。提交是对外动作，永远由人来点。
  var oneClickBypass = false;   // 用户在面板上显式确认"审批没通过也要继续"后置位，仅本次有效
  var nameFromTitleWarn = false; // 本次的「需求名称」是从页面标题推断的 → 报告里要点名提醒核对

  function runOneClick() {
    // ⚠️ 必须自己兜住异常。异步入口抛出去没人接，表现是"点了一键什么都没发生、状态栏停在上一句"，
    // 用户完全无从判断是卡住了还是在跑 —— 那比报错更糟。
    return oneClickInner().catch(function (e) {
      setStatus('❌ 一键执行出错：' + escapeHtml((e && e.stack ? e.stack : (e && e.message) || String(e))).slice(0, 400));
    });
  }
  async function oneClickInner() {
    if (filling) return;
    // ① 审批门禁
    var gate = approvalGate();
    if (!gate.pass && !oneClickBypass) {
      pendingGate = gate;
      setStatus('<div style="color:#dc2626"><b>⛔ 审批门禁拦下了这条需求</b></div>'
        + '<div style="margin-top:4px;color:#374151">' + escapeHtml(gate.reason)
        + (gate.from ? '<span style="color:#9ca3af">（来源：' + escapeHtml(gate.from) + '）</span>' : '') + '</div>'
        + '<div style="margin-top:4px;color:#6b7280;font-size:11.5px">'
        + '只有「审批通过」的需求才该变成真实职位。读不到状态时工具默认拒绝——'
        + '放行的代价不可逆，拒绝的代价只是你多点一次。</div>'
        + '<div style="margin-top:6px;display:flex;gap:6px">'
        + '<button id="ta-req-gate-go" class="ta-req-btn ta-req-btn-ghost" style="flex:1">我确认，仍要继续</button>'
        + '<button id="ta-req-gate-no" class="ta-req-btn ta-req-btn-ghost" style="flex:1">取消</button>'
        + '</div>');
      on('ta-req-gate-go', 'click', function () {
        oneClickBypass = true;
        setStatus('已确认，继续执行…');
        runOneClick();
      });
      on('ta-req-gate-no', 'click', function () { pendingGate = null; setStatus('已取消。'); });
      return;
    }
    oneClickBypass = false;

    // ② 提取需求
    setStatus('① 审批状态：<b>' + escapeHtml(gate.status || '(未读到，已确认继续)') + '</b> → 正在提取需求字段…');
    var data = extractBest();
    // 真机上「需求名称」几乎总是从<页面标题>推断出来的（详情的基本信息块里没有这一行）。
    // 它会直接变成新职位的【职位名称】——推断错了就是一个名字错的真实职位，必须在报告里点名提醒。
    nameFromTitleWarn = !!data.__nameFromTitle;
    try { delete data.__nameFromTitle; } catch (e) { data.__nameFromTitle = undefined; }
    var keys = Object.keys(data).filter(function (k) { return k !== '__nameFromTitle'; });
    var knownHits = keys.filter(isKnownField).length;
    if (!keys.length || !knownHits) {
      setStatus('⚠ 没能从当前页面提取到需求字段（拿到 ' + keys.length + ' 个，像需求字段的 ' + knownHits + ' 个）。'
        + '<br>请先<b>点开这条需求的详情</b>再点一键；或用「🎯 逐项点选」把需要的字段一个个点进来。');
      return;
    }
    savePending(serializeSource(data, orderKeys(data)));

    // ③ 就地点「新建职位」
    setStatus('② 已提取 <b>' + keys.length + '</b> 个字段 → 正在点开「新建职位」…');
    if (!inWizard()) {
      var cbtn = createJobButton();
      if (!cbtn) {
        setStatus('⚠ 页面上找不到「新建职位」按钮。它在需求详情的<b>「关联职位」</b>区块里，'
          + '请把详情往下滚动让它出现，再点一键；或自己点开后用「🚀 填充新建职位」。');
        return;
      }
      try { cbtn.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(300);
      fireMouse(cbtn);
      var entered = false;
      for (var w = 0; w < 40; w++) { await sleep(250); if (inWizard()) { entered = true; break; } }
      if (!entered) {
        setStatus('⚠ 点了「新建职位」但没进入新建向导（URL 仍不是 /hire/job/create/…）。'
          + '<br>可能是权限不足或页面弹了别的确认框，请手动点开后再用「🚀 填充新建职位」。');
        return;
      }
      await sleep(1200);   // 等第 1 步表单渲染
    }
    // ④ 三步填充
    await runFillJob();
  }
  var pendingGate = null;

  function renderReport(r, mode) {
    var parts = [];
    var okCount = r.filled.length + r.picked.length;
    // 准确率口径（与验收一致）：分母＝映射表规定应写入的字段数（含没找到/需手选/被跳过），
    // 分子＝回读与来源一致的字段数。绝不能只拿"成功数/成功数"自证。
    var denom = okCount + r.inexact.length + r.manual.length + r.failed.length
      + r.notFound.length + r.kept.length + r.prefilled.length + r.same.length + (r.reverted || []).length;
    var numer = okCount + r.same.length - (r.reverted || []).length;
    if (numer < 0) numer = 0;
    var pct = denom ? Math.round(numer * 1000 / denom) / 10 : 0;

    if (r.blocked) {
      parts.push('<div style="color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:6px 8px">'
        + '<b>⛔ 向导没走完</b><br>' + escapeHtml(r.blocked) + '</div>');
    }
    if (r.steps && r.steps.length) {
      parts.push('<div style="margin-top:4px;color:#6b7280;font-size:11.5px">已处理：' + escapeHtml(r.steps.join(' → ')) + '</div>');
    }
    parts.push('<div style="margin-top:4px;color:#059669"><b>✓ 成功写入 ' + okCount + ' 项</b>'
      + '<span style="color:#6b7280;font-weight:400"> · 模式：' + escapeHtml(FILL_MODES[mode] || mode) + '</span></div>');
    parts.push('<div style="margin-top:2px;color:#6b7280;font-size:11.5px">本次口径命中率 <b>' + pct + '%</b>（' + numer + '/' + denom + '，没找到·需手选·被跳过都计入分母）</div>');
    if (r.filled.length) parts.push('<div style="margin-top:3px;color:#374151">文本/日期：' + escapeHtml(r.filled.join('、')) + '</div>');
    if (r.picked.length) parts.push('<div style="margin-top:3px;color:#374151">下拉/单选/区间：' + escapeHtml(r.picked.join('、')) + '</div>');
    if (r.notes && r.notes.length) parts.push('<div style="margin-top:3px;color:#6b7280;font-size:11.5px">说明：' + escapeHtml(r.notes.join('；')) + '</div>');
    if (r.prefilled.length) parts.push('<div style="margin-top:4px;color:#6b7280">📦 飞书已带值，未覆盖：' + escapeHtml(r.prefilled.join('、')) + '</div>');
    if (r.kept.length) parts.push('<div style="margin-top:4px;color:#2563eb">🛡 已保留人工内容（未覆盖）：' + escapeHtml(r.kept.join('、')) + '</div>');
    if (r.same.length) parts.push('<div style="margin-top:3px;color:#6b7280">已一致，跳过：' + escapeHtml(r.same.join('、')) + '</div>');
    if (r.reverted && r.reverted.length) parts.push('<div style="margin-top:4px;color:#dc2626"><b>⚠ 填完后又被页面改掉（表单联动/异步回滚）</b>：' + escapeHtml(r.reverted.join('、')) + '</div>');
    if (r.inexact && r.inexact.length) parts.push('<div style="margin-top:4px;color:#dc2626"><b>⚠ 写入值与来源不一致，务必人工核对</b>：' + escapeHtml(r.inexact.join('；')) + '</div>');
    if (r.manual.length) parts.push('<div style="margin-top:4px;color:#b45309">⚠ 需手选（自动没点中/控件不支持）：' + escapeHtml(r.manual.join('、')) + '</div>');
    if (r.notFound.length) parts.push('<div style="margin-top:3px;color:#6b7280">表单里没有这些字段，已跳过：' + escapeHtml(r.notFound.join('、')) + '</div>');
    if (r.failed.length) parts.push('<div style="margin-top:3px;color:#dc2626">失败：' + escapeHtml(r.failed.join('、')) + '</div>');
    if (nameFromTitleWarn) {
      parts.push('<div style="margin-top:6px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 8px">'
        + '⚠ <b>「职位名称」是从页面标题推断的</b>（需求详情里没有「需求名称」这一行）。'
        + '提交前请务必逐字核对职位名称。</div>');
    }
    parts.push('<div style="margin-top:6px;color:#6b7280;font-size:11.5px">'
      + '已停在<b>「保存并完成更多设置」之前</b>。请逐字核对后自己提交——工具永远不会替你提交。</div>');
    setStatus(parts.join(''));
  }

  // 「模板填充新建需求」（v2.1 遗留功能）已于 2026-08-04 按用户要求整段移除：
  //   它填的是【新建需求】表单，与现在这条「需求 → 新建职位」主链路毫无关系，
  //   却在面板上占着一整个折叠区、还带预设管理，正常用户根本分不清该点哪个。
  //   随之删除的还有：DEFAULT_TEMPLATE / loadPresets / savePresets / runFillRequirement /
  //   PRESET_KEY / DRAFT_KEY 及其面板 UI 与事件绑定。

  // ==================== 面板 UI ====================
  function setStatus(html) { var el = $('ta-req-status'); if (el) el.innerHTML = html; }
  function modeOptionsHtml() {
    var cur = getMode();
    return Object.keys(FILL_MODES).map(function (k) {
      return '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + escapeHtml(FILL_MODES[k]) + '</option>';
    }).join('');
  }

  function clipSummaryHtml() {
    var f = pendingFields();
    var n = Object.keys(f).length;
    if (!n) {
      return '<div style="font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 8px">还没有内容——点「⚡ 一键」或「📋 复制当前需求」</div>';
    }
    return '<div style="font-size:12px;color:#065f46;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;padding:6px 8px">'
      + '📌 当前需求：<b>' + escapeHtml(pendingName(f) || '未命名需求') + '</b>'
      + '<span style="color:#6b7280"> · ' + n + ' 字段</span></div>';
  }

  function panelHtml(mode) {
    // 标题栏兼作拖动把手（cursor:move + id 供 bindDrag 认领）。
    // 面板挡住页面内容时，用户应该能把它挪开，而不是只能收起来看不见。
    var head = ''
      + '<div id="ta-req-head" title="按住标题栏可拖动" style="font-weight:600;margin-bottom:8px;color:#4f46e5;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none">'
      + '<span>🔁 需求 → 职位 一键复制</span>'
      + '<span style="display:flex;gap:6px;align-items:center">'
      + '<span style="font-size:11px;font-weight:500;color:#6366f1;background:#eef2ff;padding:2px 8px;border-radius:10px">'
      + (mode === 'requirement' ? '需求页' : mode === 'wizard'
        ? ('新建职位 · 第' + (currentStep() + 1) + '步') : '职位页') + '</span>'
      + '<span id="ta-req-toggle" title="收起/展开" style="cursor:pointer;color:#9ca3af;font-size:14px;user-select:none">—</span>'
      + '</span></div>';

    if (mode === 'requirement') {
      return head + '<div id="ta-req-body">'
        + clipSummaryHtml()
        // ── 一键：门禁 → 提取 → 自动点「新建职位」→ 三步填充 ──
        // 中间不再有"存为待填充需求"这一步：那四步之间没有任何需要人决策的地方，
        // 唯一需要人的是最后的提交，那一步工具本来就不做。
        + '<button id="ta-req-oneclick" class="ta-req-btn ta-req-btn-primary" style="margin:8px 0 6px">⚡ 一键：需求 → 新建职位</button>'
        + '<div style="display:flex;gap:6px;margin-bottom:6px">'
        + '<button id="ta-req-copy" class="ta-req-btn ta-req-btn-ghost" style="flex:1">📋 复制当前需求</button>'
        + '<button id="ta-req-pick" class="ta-req-btn ta-req-btn-ghost" style="width:auto;padding:8px 10px" title="鼠标对准某一个字段，点一下只取这一条；可连点多个，Esc 结束">🎯 逐项点选</button>'
        + '</div>'
        + pastedBlockHtml(true)
        + '<div style="margin:10px 0 6px;border-top:1px dashed #e5e7eb;padding-top:8px">'
        + '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">'
        + '<span style="font-size:12px;color:#4b5563;white-space:nowrap">填充方式</span>'
        + '<select id="ta-req-mode-job" class="ta-req-inp" style="flex:1">' + modeOptionsHtml() + '</select>'
        + '</div>'
        + '<button id="ta-req-fill-job" class="ta-req-btn ta-req-btn-primary">🚀 填充新建职位</button>'
        + '<div style="display:flex;gap:6px;margin-top:6px">'
        + '<button id="ta-req-scan" class="ta-req-btn ta-req-btn-ghost" style="flex:1">🔍 扫描表单字段</button>'
        + '<button id="ta-req-reset-log" class="ta-req-btn ta-req-btn-ghost" style="flex:1" title="清除“我上次填了什么”的记录">↺ 重置填充记录</button>'
        + '</div>'
        + '</div>'
        + '<div id="ta-req-status" style="margin-top:8px;font-size:12px;color:#6b7280;line-height:1.6;max-height:220px;overflow:auto"></div>'
        + '</div>';
    }

    // 职位页 / 新建职位向导
    // 面板只留：工具名 · 待填充岗位 · 填充方式 · 三个功能键 · 已粘贴 · 结果。
    // 说明性文案全部删掉 —— 用的人是 TA，不是第一次读文档的人，提示语只会挤掉真正要看的报告。
    return head + '<div id="ta-req-body">'
      + clipSummaryHtml()
      + '<div style="display:flex;gap:6px;align-items:center;margin:8px 0 6px">'
      + '<span style="font-size:12px;color:#4b5563;white-space:nowrap">填充方式</span>'
      + '<select id="ta-req-mode" class="ta-req-inp" style="flex:1">' + modeOptionsHtml() + '</select>'
      + '</div>'
      + '<button id="ta-req-fill-job" class="ta-req-btn ta-req-btn-primary">🚀 填充新建职位</button>'
      + '<div style="display:flex;gap:6px;margin-top:6px">'
      + '<button id="ta-req-scan" class="ta-req-btn ta-req-btn-ghost" style="flex:1">🔍 扫描表单字段</button>'
      + '<button id="ta-req-reset-log" class="ta-req-btn ta-req-btn-ghost" style="flex:1" title="清除“我上次填了什么”的记录">↺ 重置填充记录</button>'
      + '</div>'
      + pastedBlockHtml()
      + '<div id="ta-req-status" style="margin-top:8px;font-size:12px;color:#6b7280;line-height:1.6;max-height:240px;overflow:auto"></div>'
      + '</div>';
  }

  /**
   * 「已粘贴」区 —— 唯一真源，所见即所填。
   * 这里原来叫「字段映射（需求字段 => 职位字段）」，那是给我看的实现概念，对 TA 没有意义；
   * 它后来也承担了「待填充需求」的角色 —— 那一层中转已删，现在填充直接读这里。
   * ⚠️ 边打字边存（input 事件），所以【没有】"保存"按钮：多一个必点的按钮，
   * 就多一次"改了忘了点、填的还是旧内容"的事故面。
   * @param onReqPage 需求页上这块不用折叠（那页就它一个主体）；向导页折叠起来给报告让位置
   */
  function pastedBlockHtml(onReqPage) {
    var ta = '<textarea id="ta-req-clip-edit" class="ta-req-inp" spellcheck="false"'
      + ' placeholder="一行一个「字段：值」；多行值用 字段：<<< 换行内容 >>>"'
      + ' style="width:100%;height:150px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;margin-top:6px">'
      + escapeHtml(clipText()) + '</textarea>'
      + '<div style="display:flex;gap:6px;margin-top:6px">'
      + '<button id="ta-req-clear-clip" class="ta-req-btn ta-req-btn-ghost" style="flex:1" title="清空已粘贴内容与填充记录">🗑 清空</button>'
      + '</div>';
    if (onReqPage) {
      return '<div style="font-size:12px;color:#4b5563;margin:8px 0 0">已粘贴（请核对，可直接改；改完即生效）</div>' + ta;
    }
    return '<details style="margin-top:10px" open><summary style="cursor:pointer;font-size:12px;color:#4b5563">已粘贴（请核对，可直接改；改完即生效）</summary>'
      + ta + '</details>';
  }

  // ── 「已粘贴」＝ 唯一真源 ────────────────────────────────────────────────
  /** 面板里那段文本（跨页跨刷新保留） */
  function clipText() { return lsGet(EXTRACT_KEY) || ''; }
  /** 解析成 {字段:值}，只保留非空 */
  function pendingFields() {
    var all = parseSource(clipText()), out = {};
    Object.keys(all).forEach(function (k) {
      if (String(all[k]).trim() !== '') out[k] = all[k];
    });
    return out;
  }
  function pendingName(fields) {
    var f = fields || pendingFields(), name = '';
    ['需求名称', '职位名称', '岗位名称'].forEach(function (k) {
      if (name) return;
      for (var kk in f) if (norm(kk) === norm(k)) name = String(f[kk]).slice(0, 30);
    });
    return name;
  }
  /**
   * 写入「已粘贴」。
   * 换了另一条需求才作废填充记录 —— 同一条需求改个别字段再填，记录必须保留，
   * 否则「智能覆盖」会把工具自己填的内容误判成人工内容而全部跳过（真机实测到过）。
   */
  function savePending(text) {
    lsSet(EXTRACT_KEY, String(text == null ? '' : text));
    var name = pendingName() || '未命名需求';
    if (norm(lsGet(LAST_NAME_KEY) || '') !== norm(name)) {
      jSet(LOG_KEY, {});
      lsSet(LAST_NAME_KEY, name);
    }
    var ta = $('ta-req-clip-edit');
    if (ta && ta.value !== text) ta.value = text;
    renderClipBar();
  }

  function ensureStyle() {
    if ($('ta-req-style')) return;
    var st = document.createElement('style');
    st.id = 'ta-req-style';
    st.textContent = '.ta-req-btn{padding:8px 10px;border-radius:6px;border:1px solid transparent;font-size:13px;cursor:pointer;width:100%;transition:all .15s;font-family:inherit}'
      + '.ta-req-btn-primary{background:#4f46e5;color:#fff;border-color:#4f46e5}.ta-req-btn-primary:hover:not(:disabled){background:#4338ca}.ta-req-btn-primary:disabled{background:#c7d2fe;border-color:#c7d2fe;cursor:not-allowed}'
      + '.ta-req-btn-ghost{background:#fff;color:#4b5563;border-color:#e5e7eb}.ta-req-btn-ghost:hover{background:#f9fafb}'
      + '.ta-req-inp{border:1px solid #e5e7eb;border-radius:6px;padding:6px 8px;font-size:12.5px;box-sizing:border-box;color:#111827;background:#fff}.ta-req-inp:focus{outline:none;border-color:#4f46e5}';
    document.head.appendChild(st);
  }

  function injectPanel() {
    if (stopped) return; // 已被平台停止：不再补面板（否则表现为"关不掉"）
    if ($(PANEL_ID)) return;
    if (!document.body) { setTimeout(injectPanel, 300); return; }
    ensureStyle();
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    // ⚠️ 位置要和同域的另一个工具错开。
    // feishu-req-sheet-sync 的 matches 也覆盖 /hire/job*，它的面板原本是同一坐标
    // （right:20px;bottom:90px;z-index:2147483646），两者在需求页会完全重叠，
    // 后注入的把先注入的整个盖住，用户以为工具没生效。
    // 这里左移一个面板宽度 + 间距（320 + 20），两块并排。
    panel.style.cssText = 'position:fixed;right:360px;bottom:90px;z-index:2147483646;background:#fff;border-radius:10px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,0.14),0 0 0 1px rgba(79,70,229,0.06);padding:12px 14px;font-size:13px;width:320px;'
      + 'max-height:76vh;overflow:auto;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
      + 'border-top:3px solid #4f46e5;line-height:1.4;color:#111827';
    document.body.appendChild(panel);
    restorePanelPos(panel);
    renderPanel();
  }
  function removePanel() { var p = $(PANEL_ID); if (p) p.remove(); }

  // ── 面板拖动 ────────────────────────────────────────────────────────────
  // 面板是 position:fixed 的悬浮层，难免挡住页面上要看的内容。此前只能收起（看不见），
  // 挪不开。这里让标题栏成为拖动把手，位置记进 localStorage 跨页跨刷新保留。
  var POS_KEY = 'ta-req-gen-pos';
  var MIN_VISIBLE = 60;   // 至少留这么多像素在视口内，杜绝拖出屏幕后再也抓不回来

  function clampPos(left, top, w, h) {
    var vw = window.innerWidth || 1200;
    var vh = window.innerHeight || 800;
    return {
      left: Math.max(MIN_VISIBLE - w, Math.min(left, vw - MIN_VISIBLE)),
      top: Math.max(0, Math.min(top, vh - MIN_VISIBLE)),
    };
  }
  function applyPos(panel, left, top) {
    var p = clampPos(left, top, panel.offsetWidth || 320, panel.offsetHeight || 200);
    // 一旦拖过就改用 left/top 定位；原来的 right/bottom 必须清掉，否则两套定位打架
    panel.style.left = p.left + 'px';
    panel.style.top = p.top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    return p;
  }
  function restorePanelPos(panel) {
    var raw = lsGet(POS_KEY);
    if (!raw) return;                       // 没拖过就保持默认的 right/bottom 位置
    try {
      var p = JSON.parse(raw);
      if (typeof p.left === 'number' && typeof p.top === 'number') applyPos(panel, p.left, p.top);
    } catch (e) { /* 位置坏了就当没存过 */ }
  }
  function bindDrag(panel) {
    var head = $('ta-req-head');
    if (!head || head._taDrag) return;
    head._taDrag = true;
    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      // 收起/展开那个「—」是标题栏里的按钮，点它不该被当成拖动
      if (e.target && e.target.id === 'ta-req-toggle') return;
      var r = panel.getBoundingClientRect();
      var dx = e.clientX - r.left;
      var dy = e.clientY - r.top;
      var moved = false;
      function onMove(ev) {
        moved = true;
        applyPos(panel, ev.clientX - dx, ev.clientY - dy);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        if (!moved) return;
        var rr = panel.getBoundingClientRect();
        lsSet(POS_KEY, JSON.stringify({ left: Math.round(rr.left), top: Math.round(rr.top) }));
      }
      // 捕获阶段挂在 document 上：鼠标滑出面板（甚至滑进 iframe 上方）也不会丢事件
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();   // 拖动时不要选中标题文字
    });
  }
  // 窗口变小后，原来的位置可能整个落到视口外 → 重新夹回可见范围
  window.addEventListener('resize', function () {
    var p = $(PANEL_ID);
    if (!p || p.style.left === '' || p.style.left === 'auto') return;
    applyPos(p, parseFloat(p.style.left) || 0, parseFloat(p.style.top) || 0);
  });

  function renderPanel() {
    var panel = $(PANEL_ID);
    if (!panel) return;
    var mode = getPageMode();
    if (mode === 'unknown') { panel.style.display = 'none'; return; }
    panel.style.display = '';
    panel.innerHTML = panelHtml(mode);
    bindPanel(mode);
  }

  function on(id, ev, fn) {
    var el = $(id);
    if (el && !el._taBound) { el._taBound = true; el.addEventListener(ev, fn); }
  }

  function bindPanel(mode) {
    // 标题栏每次 renderPanel 都会被 innerHTML 重建，拖动把手必须跟着重新认领
    var _p = $(PANEL_ID); if (_p) bindDrag(_p);
    on('ta-req-toggle', 'click', function () {
      var b = $('ta-req-body'); if (!b) return;
      var hidden = b.style.display === 'none';
      b.style.display = hidden ? '' : 'none';
      $('ta-req-toggle').textContent = hidden ? '—' : '+';
    });

    bindPastedBox();
    if (mode === 'requirement') {
      on('ta-req-oneclick', 'click', runOneClick);
      on('ta-req-copy', 'click', function () {
        applyExtracted(extractBest(), '当前页面');
      });
      on('ta-req-pick', 'click', function () { startPick(); });
      // ── 需求页上的"填充新建职位"（流程纠偏：不再需要跳到职位页）────────────
      // 与职位页共用同一批处理函数，只是填充方式下拉换了个 id（同一页里两个下拉不能重名）。
      bindJobFillHandlers('ta-req-mode-job');
      return;
    }

    // 职位页 / 向导页
    bindJobFillHandlers('ta-req-mode');
  }

  /**
   * 「已粘贴」文本框：边打字边存，没有"保存"按钮。
   * 多一个必点的按钮就多一次"改了忘了点、填的还是旧内容"的事故面 —— 而这种事故
   * 恰恰完全看不出来（面板显示的是你改后的文本，填进去的是改前的）。
   */
  function bindPastedBox() {
    on('ta-req-clip-edit', 'input', function () {
      var ta = $('ta-req-clip-edit');
      if (ta) savePending(ta.value);
    });
    on('ta-req-clear-clip', 'click', function () {
      savePending('');
      jSet(LOG_KEY, {});
      setStatus('已清空「已粘贴」内容与填充记录。');
    });
  }

  /**
   * 「填充新建职位」那一组按钮的事件绑定。
   * 需求页与职位页共用——真实流程是在需求页就地新建职位，但独立职位页的路径也保留着，
   * 两处必须是同一套行为，否则同一个按钮在两个页面表现不一样，用户没法建立稳定预期。
   * modeSelId：填充方式下拉的 id（同一页里两个下拉不能重名，故做成参数）。
   */
  function bindJobFillHandlers(modeSelId) {
    // 填充方式存在 localStorage（getMode 从那里读），下拉只负责写入，不用把 id 传进 runFillJob
    on(modeSelId, 'change', function () { lsSet(MODE_KEY, $(modeSelId).value); });
    on('ta-req-fill-job', 'click', runFillJob);
    on('ta-req-scan', 'click', function () {
      // 先把"选中了哪个容器"报出来。
      // 需求页上可能【同时】开着两个浮层：需求详情抽屉 + 新建职位抽屉。
      // formRoot() 的策略是"可见浮层里表单项最多的那个"，如果需求详情本身是可编辑表单，
      // 就可能选错。选错时的症状是"字段名对不上、填了没反应"，从结果上很难倒推，
      // 所以这里直接把候选容器和最终选择打出来——一眼看出是不是抓错了。
      var cands = [];
      try {
        cands = [].slice.call(document.querySelectorAll(
          '[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]'
        )).filter(vis);
      } catch (e) {}
      var root = formRoot();
      var candInfo = cands.map(function (c, i) {
        var n = itemsFrom(c).length;
        var mark = (c === root) ? ' ← <b style="color:#4f46e5">本次选中</b>' : '';
        var cls = String(c.className || '').slice(0, 48);
        return '　候选' + (i + 1) + '：' + n + ' 个字段　<span style="color:#9ca3af">' + escapeHtml(cls || '(无 class)') + '</span>' + mark;
      });
      var rootDesc = (root === document)
        ? '<b style="color:#b45309">整页</b>（没找到合适的浮层，已退回全页扫描——通常说明表单没打开，或它不是浮层结构）'
        : '<b>浮层</b> <span style="color:#9ca3af">' + escapeHtml(String(root.className || '').slice(0, 48)) + '</span>';

      var items = formItems();
      var header = '<div style="color:#374151">扫描范围：' + rootDesc + '</div>'
        + (cands.length ? '<div style="margin-top:4px;color:#6b7280;font-size:11.5px">可见浮层 ' + cands.length + ' 个：<br>' + candInfo.join('<br>') + '</div>' : '')
        + '<div style="margin-top:6px;color:#374151">检测到 <b>' + items.length + '</b> 个表单字段' + (items.length ? '：' : '') + '</div>';

      if (!items.length) {
        setStatus(header + '<div style="margin-top:6px;color:#b45309;font-size:11.5px">'
          + '请先在本页点「新建职位」把表单打开再扫描。若表单确实开着仍是 0，'
          + '把上面这段「可见浮层」信息发我，用来校准容器识别。</div>');
        return;
      }
      var rows = items.map(function (it, i) {
        var l = labelOf(it) || '(无标签)';
        var t = detectType(it);
        var v = readItemValue(it, t);
        return (i + 1) + '. <b>' + escapeHtml(l) + '</b> <span style="color:#9ca3af">[' + t + ']</span>'
          + (v ? ' = ' + escapeHtml(v.slice(0, 24)) : '');
      });
      setStatus(header + '<div style="margin-top:4px">' + rows.join('<br>') + '</div>'
        + '<div style="margin-top:6px;color:#6b7280;font-size:11.5px">这是工具在当前页面读到的表单字段，用来排查「没填上」是哪一步出的问题。</div>');
    });
    on('ta-req-reset-log', 'click', function () { jSet(LOG_KEY, {}); setStatus('已重置填充记录（「智能覆盖」将把当前所有内容视为人工内容）。'); });
    // 映射规则不再出现在面板上（对 TA 是无意义的实现概念）。规则仍可改，但走 localStorage，
    // 由维护者按需调整；下面两个绑定保留是为了兼容旧面板，元素不存在时 on() 自动空转。
    on('ta-req-map-save', 'click', function () { lsSet(MAP_KEY, $('ta-req-map').value); setStatus('✓ 已保存'); });
    on('ta-req-map-reset', 'click', function () { lsSet(MAP_KEY, DEFAULT_MAP); var m = $('ta-req-map'); if (m) m.value = DEFAULT_MAP; setStatus('已恢复默认'); });
  }

  function renderClipBar() {
    var panel = $(PANEL_ID);
    if (!panel) return;
    var body = $('ta-req-body');
    if (!body || !body.firstElementChild) return;
    try { body.firstElementChild.outerHTML = clipSummaryHtml(); } catch (e) {}
  }

  // ==================== SPA 路由监听 ====================
  var lastUrl = location.href, lastMode = getPageMode(), lastStep = currentStep();
  var renderTimer = null, watchTimer = null, routeBound = false;
  // 平台调用停止钩子后置为 true，tick/scheduleRender 立即变成空操作
  var stopped = false;
  function scheduleRender() {
    if (stopped) return;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      renderTimer = null;
      var m = getPageMode();
      if (m === 'unknown') { removePanel(); return; }
      injectPanel();
      // 向导内换步时 mode 不变（都是 wizard），但面板要跟着更新"第 N 步"与提示文案，
      // 所以步骤号也要参与判定。⚠️ 填充过程中不重渲染——会把正在刷新的状态区整块换掉。
      var st = currentStep();
      if ((m !== lastMode || st !== lastStep) && !filling) {
        lastMode = m; lastStep = st; renderPanel();
      } else { lastMode = m; lastStep = st; }
    }, 400);
  }
  function tick() {
    if (stopped) return; // 已被平台停止：不再补面板、不再重渲染
    if (location.href !== lastUrl) { lastUrl = location.href; scheduleRender(); return; }
    // 面板被 SPA 重渲染移除时自动补回
    if (getPageMode() !== 'unknown' && !$(PANEL_ID)) injectPanel();
  }
  function watchRoute() {
    if (routeBound) return;
    routeBound = true;
    // content script 在隔离世界，hook 不到主世界 pushState；用事件 + 1s 轮询（字符串比较，开销极低）
    window.addEventListener('popstate', tick);
    window.addEventListener('hashchange', tick);
    watchTimer = setInterval(tick, 1000);

    // 向平台登记停止钩子。没有它的话：平台"禁用工具/改配置"会重注入一份新实例，
    // 而旧实例的 interval 与监听没人回收，每次启停叠一层，且 tick() 还会把
    // 被移除的面板补回来 —— 表现就是工具关不掉。
    try {
      if (typeof __TA_ON_STOP__ === 'function') {
        __TA_ON_STOP__(function () {
          stopped = true;
          try { clearInterval(watchTimer); } catch (e) {}
          try { clearTimeout(renderTimer); } catch (e) {}
          try { window.removeEventListener('popstate', tick); } catch (e) {}
          try { window.removeEventListener('hashchange', tick); } catch (e) {}
          // 拾取模式挂的是 document 捕获期监听，不释放的话停止后还会吞掉用户下一次点击
          try { if (typeof pickCleanup === 'function') pickCleanup(); } catch (e) {}
          try { removePanel(); } catch (e) {}
          routeBound = false;
        });
      }
    } catch (e) { /* 老平台没有这个钩子则跳过 */ }
  }

  function init() {
    // ⚠️ 2026-08-04 真机事故修复：这里原来是 `if (!/\/hire\/job/) return;` —— 直接退出，
    // 连路由监听都不挂。而飞书招聘的入口首页是 /hire/home，用户的真实路径是：
    //   工作台 → 招聘（落在 /hire/home，本脚本刚注入就 return 了）
    //   → 页内点「招聘需求」（SPA pushState 到 /hire/job/...，没有整页加载）
    //   → 没有任何代码还活着，面板永远不出现 —— 用户反馈"安装了、点了没有任何反应"。
    // 配套改动：manifest matches 放宽为 /hire/*（否则 /hire/home 上根本不注入本脚本）。
    // 这里不再按路径提前退出：watchRoute 常驻，面板显隐交给 getPageMode()
    // （unknown → display:none；tick 每秒对比 URL，路由进 /hire/job/* 自动渲染出来）。
    log('init mode=', getPageMode());
    var tries = 0;
    function tryInject() {
      if (stopped) return; // 停止后中断自重试链，否则它还会把面板补回来
      tries++;
      injectPanel();
      if ($(PANEL_ID) || tries >= 10) return;
      setTimeout(tryInject, 1000);
    }
    setTimeout(tryInject, 800);
    watchRoute();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
