/**
 * 飞书需求一键生成 - Content Script (isolated world)
 *
 * 能力：
 *   1) 在职位详情/编辑页：点「📥 提取当前职位信息」→ 读表单字段 → localStorage 缓存
 *   2) 在需求列表/详情页点「新建需求」弹出表单后：点「🚀 一键填充新建需求」→ 自动填表单
 *      - input / textarea 直接设值 + 触发 input/change 事件（兼容 React/Vue 受控组件）
 *      - contenteditable 富文本用 execCommand('insertText') 触发编辑器 onChange
 *      - select/cascader/tree-select：点击触发器 → 在弹出面板里按文字点选（渐进式，失败降级为"需手选"提示）
 *
 * CONFIG 由沙箱注入器提供（defaultConfig + 用户配置）
 */
(function () {
  'use strict';

  var TOOL_ID = 'feishu-requirement-generator';
  var STORAGE_KEY = 'ta-platform:req-gen:source';
  var PANEL_ID = 'ta-req-gen-panel';

  var config = (typeof CONFIG !== 'undefined' && CONFIG) || {};
  var debug = !!config.debug;
  function log() {
    if (!debug) return;
    var args = Array.prototype.slice.call(arguments);
    try { console.log.apply(console, ['[' + TOOL_ID + ']'].concat(args)); } catch (e) {}
  }

  // ==================== 页面模式判断 ====================
  function getPageMode() {
    var path = location.pathname;
    if (/\/hire\/job\/requirement/i.test(path)) return 'requirement';
    if (/\/hire\/job\/(new|create|edit)/i.test(path)) return 'job-edit';
    if (/\/hire\/job\/list/i.test(path)) return 'job-list';
    if (/\/hire\/job\/\d+/.test(path)) return 'job-detail';
    if (/\/hire\/job/i.test(path)) return 'job-other';
    return 'unknown';
  }

  // ==================== 选择器（飞书 UD 组件 + 通用兜底） ====================
  var FORM_ITEM = '[class*="form__item"],[class*="form-item"],[class*="FormItem"],[data-field-key],.ud-form-item,.field-group';
  var LABEL_EL = 'label,[class*="form__item-label"],[class*="form-item-label"],[class*="item-label"],[class*="field-label"],[class*="FieldLabel"]';

  var INPUT_SEL = 'input.ud__native-input,input.ud-input,input.ud-textarea__input,input[type="text"],input:not([type])';
  var TEXTAREA_SEL = 'textarea.ud__native-input,textarea.ud-textarea,textarea';
  var SELECT_SEL = '.ud__select__selector,.ud-select__selector,[class*="select__selector"],.ud-selector,[class*="select-selector"],[class*="Select-control"]';
  var CASCADER_SEL = '[class*="cascader__selector"],[class*="cascader-selector"],[class*="cascader"]';
  var TREE_SEL = '[class*="tree-select__selector"],[class*="tree-select"],[class*="treeSelect"]';
  var RICH_SEL = '[contenteditable="true"],.lark-editor,.slate-editor,[data-slate-editor="true"],[class*="rich-text-editor"],[class*="editor-content"]';
  var DATE_SEL = '[class*="date-picker"],[class*="date-picker__input"],input[placeholder*="日期"],input[placeholder*="时间"]';
  var NUMBER_SEL = 'input[type="number"]';

  // ==================== 字段别名映射 ====================
  var FIELD_ALIAS = {
    title: ['职位名称','岗位名称','职位','岗位','招聘职位','需求名称','title','name','position name','job title'],
    department: ['部门','所属部门','需求部门','归属部门','department','dept','部门/团队','团队'],
    city: ['工作地点','工作城市','城市','base','地点','city','location','办公地点','工作地址'],
    headcount: ['招聘人数','需求人数','人数','HC','headcount','招聘数量','招多少人','编制人数'],
    salaryRange: ['薪资范围','薪酬范围','薪资','薪酬','月薪','salary','薪资区间','工资范围'],
    jobType: ['工作性质','雇佣类型','用工形式','用工类型','招聘类型','职位性质','工作类型','雇佣形式'],
    rank: ['职级','级别','等级','岗位级别','rank','level','职级要求','level要求'],
    category: ['职位类别','职位序列','岗位类别','职能','职位分类','岗位序列','category','function','职类'],
    reportTo: ['汇报对象','汇报上级','汇报人','report','上级汇报'],
    duty: ['岗位职责','工作职责','岗位描述','职位描述','工作内容','主要职责','JD','responsibilities','description','岗位职责描述'],
    requirement: ['任职要求','任职资格','岗位要求','能力要求','技能要求','资格要求','qualification','requirements','能力资格','任职条件'],
    priority: ['优先级','紧急程度','priority','优先程度'],
    recruiter: ['招聘负责人','HRBP','招聘HR','对接HR','recruiter','hr负责人','HR对接人'],
    hiringManager: ['用人经理','招聘经理','业务负责人','hiring manager','hm','用人部门负责人','业务经理'],
    reason: ['招聘原因','开放原因','需求原因','补充原因','编制原因','reason','招聘背景','开放背景'],
    remark: ['备注','其他说明','remark','note','其他','补充说明'],
    startDate: ['到岗时间','期望到岗','预计到岗','到岗日期','开始日期','需求到岗'],
    experience: ['工作年限','经验要求','经验','年限','年工作经验','years of experience'],
    education: ['学历要求','学历','degree','education','教育背景'],
    keyword: ['关键词','技能关键词','核心关键词','加分项'],
  };

  // 源字段 → 新建需求表单上的目标 label（中文首选项）
  var TARGET_LABEL = {
    title: '职位名称',
    department: '部门',
    city: '工作地点',
    headcount: '招聘人数',
    salaryRange: '薪资范围',
    jobType: '工作性质',
    rank: '职级',
    category: '职位类别',
    reportTo: '汇报对象',
    duty: '岗位职责',
    requirement: '任职要求',
    priority: '优先级',
    recruiter: '招聘负责人',
    hiringManager: '用人经理',
    reason: '招聘原因',
    remark: '备注',
    startDate: '到岗时间',
    experience: '工作年限',
    education: '学历要求',
    keyword: '关键词',
  };

  function canonicalizeKey(rawLabel) {
    if (!rawLabel) return null;
    var lbl = String(rawLabel).replace(/[\s*:： ]/g, '').trim().toLowerCase();
    if (!lbl) return null;
    for (var key in FIELD_ALIAS) {
      if (!Object.prototype.hasOwnProperty.call(FIELD_ALIAS, key)) continue;
      var aliases = FIELD_ALIAS[key];
      for (var i = 0; i < aliases.length; i++) {
        var a = String(aliases[i]).toLowerCase().replace(/\s/g, '');
        if (lbl === a || lbl.indexOf(a) !== -1 || a.indexOf(lbl) !== -1) return key;
      }
    }
    return null;
  }

  // ==================== 存储 ====================
  function loadSource() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { log('loadSource err', e); return null; }
  }
  function saveSource(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { log('saveSource err', e); }
  }
  function clearSource() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  // ==================== 事件触发 ====================
  function fireEvents(el, types) {
    if (!el) return;
    types = types || ['input', 'change', 'blur'];
    try {
      for (var i = 0; i < types.length; i++) {
        el.dispatchEvent(new Event(types[i], { bubbles: true }));
      }
    } catch (e) {}
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    try {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; }
      return true;
    } catch (e) {
      try { el.value = value; return true; } catch (e2) { return false; }
    }
  }

  // ==================== 提取 ====================
  function getLabelText(itemEl) {
    var lab = itemEl.querySelector(LABEL_EL);
    if (lab) {
      // label 里可能带 必填星号，剥掉
      var t = (lab.textContent || '').replace(/\*/g, '').trim();
      if (t) return t;
    }
    // 兜底：item 内第一个短文本节点（但不是 input 值）
    var cloned = itemEl.cloneNode(true);
    // 移除控件
    cloned.querySelectorAll('input,textarea,select,button,[contenteditable]').forEach(function (n) { n.remove(); });
    var txt = (cloned.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt && txt.length < 40) return txt;
    return '';
  }

  function getReadValueFromItem(itemEl) {
    // 1) input / textarea（只读页面通常有 value 或 textContent）
    var inp = itemEl.querySelector(INPUT_SEL);
    if (inp && inp.value && !/请输入|请选择/.test(inp.value)) return inp.value;
    var ta = itemEl.querySelector(TEXTAREA_SEL);
    if (ta && ta.value) return ta.value;
    // 2) 富文本
    var rich = itemEl.querySelector(RICH_SEL);
    if (rich) {
      var tmp = document.createElement('div');
      tmp.innerHTML = rich.innerHTML;
      var text = (tmp.innerText || tmp.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      if (text && !/请输入/.test(text)) return text;
    }
    // 3) 下拉 / cascader / tree 显示值
    var sel = itemEl.querySelector(SELECT_SEL + ',' + CASCADER_SEL + ',' + TREE_SEL);
    if (sel) {
      var st = (sel.textContent || '').replace(/\s+/g, ' ').trim();
      if (st && !/请选择|请点击/.test(st)) return st;
    }
    // 4) 多标签（如关键词 tag）
    var tags = itemEl.querySelectorAll('[class*="tag"],[class*="chip"],[class*="label-item"]');
    if (tags.length >= 1) {
      var tagTexts = [];
      tags.forEach(function (tg) {
        var x = (tg.textContent || '').trim();
        if (x && x.length < 30) tagTexts.push(x);
      });
      if (tagTexts.length) return tagTexts.join('、');
    }
    // 5) 兜底：item 内纯文本（去 label）
    var labelNode = itemEl.querySelector(LABEL_EL);
    var clone = itemEl.cloneNode(true);
    if (labelNode) {
      var labInClone = clone.querySelector(LABEL_EL);
      if (labInClone && labInClone.parentNode) labInClone.parentNode.removeChild(labInClone);
    }
    clone.querySelectorAll('script,style,button,[class*="btn"],svg').forEach(function (n) { n.remove(); });
    var rest = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (rest && rest.length > 1 && rest.length < 5000 && !/请输入|请选择/.test(rest)) return rest;
    return '';
  }

  function extractFormData(root) {
    root = root || document;
    var data = {};
    var rawLabelMap = {};
    var items = root.querySelectorAll(FORM_ITEM);
    log('extract: found', items.length, 'form items');

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.offsetParent === null && item.getClientRects && item.getClientRects().length === 0) continue; // 不可见
      var label = getLabelText(item);
      if (!label) continue;
      var value = getReadValueFromItem(item);
      if (!value) continue;
      rawLabelMap[label] = value;
      var key = canonicalizeKey(label);
      if (key) {
        // 同一 key 多值时，优先取更长的（内容更详细）；但 headcount 这种短数字优先短的
        if (!data[key]) {
          data[key] = value;
        } else if (key !== 'headcount' && key !== 'rank' && String(value).length > String(data[key]).length) {
          data[key] = value;
        }
      }
    }

    // 兜底 title：详情页一般顶部大标题
    if (!data.title) {
      var hx = document.querySelector('h1,[class*="job-title"],[class*="detail-title"],[class*="header-title"],header [class*="title"]');
      if (hx) {
        var t = (hx.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 80) data.title = t;
      }
    }

    data.__rawLabels = rawLabelMap;
    data.__capturedAt = Date.now();
    data.__url = location.href;
    data.__mode = getPageMode();
    log('extract result keys:', Object.keys(data).filter(function (k) { return k.indexOf('__') !== 0; }));
    return data;
  }

  // ==================== 填充 ====================
  function fillInput(el, value) {
    if (!el) return false;
    setNativeValue(el, String(value));
    fireEvents(el);
    return true;
  }

  function fillRich(el, value) {
    if (!el) return false;
    try {
      el.focus();
      // 先清空已有内容
      try { el.innerHTML = ''; } catch (e) {}
      try {
        var ok = document.execCommand('insertText', false, String(value));
        if (!ok) throw new Error('execCommand failed');
        fireEvents(el, ['input', 'change', 'blur']);
        return true;
      } catch (e1) {
        el.textContent = String(value);
        fireEvents(el, ['input', 'change', 'blur']);
        return true;
      }
    } catch (e) { return false; }
  }

  // 级联/下拉自动点选
  // 返回 {ok: bool, fallback: bool}；fallback=true 表示触发了点击但没成功点到目标项
  function fillSelect(item, value) {
    if (!item || !value) return { ok: false };
    var strVal = String(value).trim();
    // 找触发器（select/cascader/tree-select 触发元素）
    var trigger = item.querySelector(SELECT_SEL) || item.querySelector(CASCADER_SEL) || item.querySelector(TREE_SEL) || item.querySelector('[class*="selector"]');
    if (!trigger) {
      // 可能是 antd 风格的 ant-select-selector
      trigger = item.querySelector('[class*="select"] [class*="control"],[class*="Select-control"]');
    }
    if (!trigger) return { ok: false };
    // 先看是不是 input 类型的可搜索 select（有 input）——直接给 input 设值触发搜索
    var triggerInput = trigger.querySelector('input');
    if (triggerInput) {
      setNativeValue(triggerInput, strVal);
      fireEvents(triggerInput, ['focus', 'input', 'change']);
    } else {
      trigger.click();
    }
    return { ok: false, fallback: true, note: '已点击触发器/输入关键词，请在下拉中选择「' + strVal + '」' };
  }

  // 给一个表单项填值，返回结果
  function fillItem(item, value) {
    if (!item || value === undefined || value === null || value === '') return { ok: false, reason: 'empty' };
    var strVal = String(value);

    // 1) textarea
    var ta = item.querySelector(TEXTAREA_SEL);
    if (ta) return { ok: fillInput(ta, strVal) };

    // 2) contenteditable 富文本
    var rich = item.querySelector(RICH_SEL);
    if (rich) return { ok: fillRich(rich, strVal) };

    // 3) input（含 number / date / 普通文本）
    var inp = item.querySelector(INPUT_SEL);
    if (inp) {
      // number 类型：尝试转数字
      var valToSet = strVal;
      if (inp.type === 'number') {
        var m = strVal.match(/\d+/);
        if (m) valToSet = m[0];
      }
      return { ok: fillInput(inp, valToSet) };
    }

    // 4) select/cascader/tree
    var sel = item.querySelector(SELECT_SEL) || item.querySelector(CASCADER_SEL) || item.querySelector(TREE_SEL);
    if (sel) return fillSelect(item, strVal);

    return { ok: false, reason: 'unknown-control' };
  }

  // 找"新建需求"表单根容器
  function findRequirementFormRoot() {
    var candidates = [
      '[role="dialog"]',
      '[class*="drawer"]',
      '[class*="Drawer"]',
      '[class*="modal"]',
      '[class*="Modal"]',
      '[class*="requirement-form"]',
      '[class*="job-form"]',
      'form',
    ];
    var best = null, bestCount = 0;
    for (var i = 0; i < candidates.length; i++) {
      var nodes = document.querySelectorAll(candidates[i]);
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.offsetParent === null) continue;
        var cnt = n.querySelectorAll(FORM_ITEM).length;
        if (cnt > bestCount) { best = n; bestCount = cnt; }
      }
    }
    if (best) return best;
    return document;
  }

  function fillRequirementForm(source) {
    var root = findRequirementFormRoot();
    var items = root.querySelectorAll(FORM_ITEM);
    var filled = [];
    var needManual = [];
    var notFound = [];
    var failed = [];
    var seenItems = new Set();

    log('fillRequirementForm: items =', items.length);

    for (var key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (key.indexOf('__') === 0) continue;
      var val = source[key];
      if (val === undefined || val === null || val === '') continue;
      var preferredLabel = TARGET_LABEL[key];

      // 1st 优先按 TARGET_LABEL 精确匹配
      var target = null;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var lb = getLabelText(it);
        if (preferredLabel && lb.replace(/[\s*:：]/g, '').trim() === preferredLabel) { target = it; break; }
      }
      // 2nd 用 canonicalizeKey 模糊匹配
      if (!target) {
        for (var k = 0; k < items.length; k++) {
          var it2 = items[k];
          var lb2 = getLabelText(it2);
          if (canonicalizeKey(lb2) === key) { target = it2; break; }
        }
      }

      if (!target) { notFound.push(key + '(' + (preferredLabel || key) + ')'); continue; }
      if (seenItems.has(target)) continue;
      seenItems.add(target);

      var r = fillItem(target, val);
      if (r.ok) {
        filled.push(key + '→' + (preferredLabel || key));
      } else if (r.note) {
        needManual.push(r.note);
      } else {
        failed.push(key + '(' + preferredLabel + ')');
      }
    }

    // 反向列出表单里未被填充的字段（给用户看哪些还要填）
    var formFieldsUnfilled = [];
    for (var m = 0; m < items.length; m++) {
      var itm = items[m];
      var lbm = getLabelText(itm);
      if (!lbm) continue;
      if (seenItems.has(itm)) continue;
      // 简单判断是不是必填（带 * 号或 .required class）
      var required = !!(itm.querySelector('[class*="required"],.ud-form-item__required') || /\*/.test((itm.querySelector(LABEL_EL) && itm.querySelector(LABEL_EL).textContent) || ''));
      formFieldsUnfilled.push({ label: lbm, required: required });
    }

    return {
      filled: filled,
      needManual: needManual,
      notFound: notFound,
      failed: failed,
      formItemCount: items.length,
      unfilled: formFieldsUnfilled,
    };
  }

  // ==================== 浮动面板 UI ====================
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function setStatus(html) {
    var el = document.getElementById('ta-req-status');
    if (el) el.innerHTML = html;
  }

  function panelHtml(mode, source) {
    var hasSource = !!(source && Object.keys(source).some(function (k) { return k.indexOf('__') !== 0 && source[k]; }));
    var srcInfo = '';
    if (hasSource) {
      var title = source.title || '(未识别职位名)';
      var when = source.__capturedAt ? new Date(source.__capturedAt).toLocaleTimeString() : '';
      var fieldList = Object.keys(source).filter(function (k) { return k.indexOf('__') !== 0; });
      srcInfo = '<div style="font-size:12px;color:#059669;margin-top:6px;padding:8px;background:#ecfdf5;border-radius:4px;line-height:1.6">'
        + '<div><b>已缓存：</b>' + escapeHtml(title) + (when ? ' · ' + when : '') + '</div>'
        + '<div style="color:#047857;font-size:11px">字段：' + escapeHtml(fieldList.slice(0, 8).join('、')) + (fieldList.length > 8 ? '…' : '') + '（共 ' + fieldList.length + '）</div>'
        + '</div>';
    }

    var btns = '';
    if (mode === 'job-detail' || mode === 'job-edit' || mode === 'job-other') {
      btns = '<button id="ta-req-extract" class="ta-req-btn ta-req-btn-primary">📥 提取当前职位信息</button>'
        + '<div style="font-size:11.5px;color:#6b7280;margin-top:4px">在职位详情页提取后，切到"需求列表"新建需求即可一键填充</div>';
    } else if (mode === 'job-list') {
      btns = '<div style="font-size:12.5px;color:#6b7280;padding:8px;background:#f9fafb;border-radius:4px">👉 请先打开一个职位详情页，再点击「提取」</div>';
    } else if (mode === 'requirement') {
      btns = '<button id="ta-req-fill" class="ta-req-btn ta-req-btn-primary"' + (hasSource ? '' : ' disabled') + '>🚀 一键填充新建需求</button>';
      if (!hasSource) {
        btns += '<div style="font-size:11.5px;color:#dc2626;margin-top:4px">⚠ 还没有缓存数据，请先去职位详情页提取</div>';
      } else {
        btns += '<div style="font-size:11.5px;color:#6b7280;margin-top:4px">打开「新建需求」弹窗后再点此按钮</div>';
      }
    } else {
      btns = '<div style="font-size:12px;color:#6b7280">请打开飞书招聘的职位或需求页面</div>';
    }

    var common = '<button id="ta-req-clear" class="ta-req-btn ta-req-btn-ghost" style="margin-top:6px">🗑 清除缓存</button>'
      + '<div id="ta-req-status" style="margin-top:8px;font-size:12px;color:#6b7280;line-height:1.5"></div>';

    var modeLabel = { 'job-list': '职位列表', 'job-detail': '职位详情', 'job-edit': '职位编辑', 'job-other': '职位页', 'requirement': '需求页', 'unknown': '?' }[mode] || mode;

    return ''
      + '<div style="font-weight:600;margin-bottom:6px;color:#4f46e5;display:flex;align-items:center;justify-content:space-between">'
      + '<span>🚀 需求一键生成</span>'
      + '<span id="ta-req-mode" style="font-size:11px;font-weight:500;color:#6366f1;background:#eef2ff;padding:2px 8px;border-radius:10px">' + modeLabel + '</span>'
      + '</div>'
      + srcInfo
      + '<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">' + btns + common + '</div>';
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;
    if (!document.body) { setTimeout(injectPanel, 300); return; }
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = 'position:fixed;right:20px;bottom:90px;z-index:2147483646;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.14),0 0 0 1px rgba(79,70,229,0.06);padding:12px 14px;font-size:13px;min-width:260px;max-width:300px;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;border-top:3px solid #4f46e5;line-height:1.4;';
    document.body.appendChild(panel);
    if (!document.getElementById('ta-req-style')) {
      var st = document.createElement('style');
      st.id = 'ta-req-style';
      st.textContent = '.ta-req-btn{padding:8px 10px;border-radius:6px;border:1px solid transparent;font-size:13px;cursor:pointer;width:100%;transition:all .15s;font-family:inherit}.ta-req-btn-primary{background:#4f46e5;color:#fff;border-color:#4f46e5}.ta-req-btn-primary:hover:not(:disabled){background:#4338ca}.ta-req-btn-primary:disabled{background:#c7d2fe;border-color:#c7d2fe;cursor:not-allowed}.ta-req-btn-ghost{background:#fff;color:#4b5563;border-color:#e5e7eb}.ta-req-btn-ghost:hover{background:#f9fafb}';
      document.head.appendChild(st);
    }
    bindPanel();
    renderPanel();
  }
  function removePanel() { var p = document.getElementById(PANEL_ID); if (p) p.remove(); }

  function renderPanel() {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    var mode = getPageMode();
    if (mode === 'unknown') { panel.style.display = 'none'; return; }
    panel.style.display = '';
    panel.innerHTML = panelHtml(mode, loadSource());
    bindPanel();
  }

  function bindPanel() {
    var btnE = document.getElementById('ta-req-extract');
    var btnF = document.getElementById('ta-req-fill');
    var btnC = document.getElementById('ta-req-clear');
    if (btnE && !btnE._bound) { btnE._bound = true; btnE.addEventListener('click', onExtract); }
    if (btnF && !btnF._bound) { btnF._bound = true; btnF.addEventListener('click', onFill); }
    if (btnC && !btnC._bound) { btnC._bound = true; btnC.addEventListener('click', function () { clearSource(); setStatus('已清除缓存'); renderPanel(); }); }
  }

  function onExtract() {
    setStatus('正在提取当前页字段...');
    setTimeout(function () {
      try {
        var data = extractFormData();
        var fieldCount = Object.keys(data).filter(function (k) { return k.indexOf('__') !== 0; }).length;
        if (fieldCount === 0) {
          // 若当前没识别到表单项，可能是列表页，提示用户先进入详情
          setStatus('⚠ 未识别到字段。请确认当前是<b>职位详情/编辑页</b>（包含完整职位表单的页面），然后再点提取');
          return;
        }
        saveSource(data);
        var fieldList = Object.keys(data).filter(function (k) { return k.indexOf('__') !== 0; });
        setStatus('✓ 已提取 <b>' + fieldCount + '</b> 个字段：' + escapeHtml(fieldList.join('、'))
          + '<br><span style="color:#059669">现在切到「需求列表」→ 点「新建需求」→ 点「一键填充」即可</span>');
        log('extract ok', data);
        renderPanel();
      } catch (e) {
        log('extract error', e);
        setStatus('❌ 提取失败：' + escapeHtml((e && e.message) || String(e)));
      }
    }, 400);
  }

  function onFill() {
    setStatus('正在寻找需求表单...');
    var src = loadSource();
    if (!src) { setStatus('⚠ 没有缓存数据，请先在职位详情页提取'); return; }
    setTimeout(function () {
      try {
        var r = fillRequirementForm(src);
        var parts = ['✓ 已填充 <b>' + r.filled.length + '</b> 个字段'];
        if (r.notFound.length) {
          parts.push('<div style="color:#6b7280;margin-top:3px;font-size:11.5px">表单未找到（可能该页无此字段）：' + escapeHtml(r.notFound.join('、')) + '</div>');
        }
        if (r.needManual.length) {
          parts.push('<div style="color:#b45309;margin-top:3px">⚠ 需要手动选择/确认（下拉/级联）：' + escapeHtml(r.needManual.join('；')) + '</div>');
        }
        // 必填但未填的提示
        var reqUnfilled = r.unfilled.filter(function (u) { return u.required; });
        if (reqUnfilled.length) {
          parts.push('<div style="color:#dc2626;margin-top:3px">🔴 必填项仍需手填：' + escapeHtml(reqUnfilled.map(function (u) { return u.label; }).join('、')) + '</div>');
        }
        setStatus(parts.join(''));
        log('fill result', r);
      } catch (e) {
        log('fill error', e);
        setStatus('❌ 填充失败：' + escapeHtml((e && e.message) || String(e)));
      }
    }, 700);
  }

  // ==================== SPA 路由监听 ====================
  var lastUrl = location.href;
  var lastMode = getPageMode();
  var urlObserver = null;
  function watchRoute() {
    if (urlObserver) return;
    urlObserver = new MutationObserver(function () {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        var m = getPageMode();
        if (m !== lastMode) { lastMode = m; log('mode changed ->', m); }
        scheduleRender();
      }
      if (lastMode === 'requirement') scheduleRender(); // 弹窗时重渲染
    });
    urlObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }

  var renderTimer = null;
  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      renderTimer = null;
      var m = getPageMode();
      if (m === 'unknown') { removePanel(); return; }
      injectPanel();
      renderPanel();
      if (m === 'requirement' && config.autoFillOnNew && loadSource()) {
        log('autoFillOnNew: wait for form then fill');
        setTimeout(onFill, 1200);
      }
    }, 400);
  }

  function init() {
    if (!/\/hire\/job/i.test(location.pathname)) return;
    log('init, mode =', getPageMode(), 'url =', location.href);
    // 延迟等 SPA 渲染
    var tries = [800, 1600, 3000];
    tries.forEach(function (d) { setTimeout(injectPanel, d); });
    watchRoute();
    // 定期补渲染（应对飞书局部加载/弹窗）
    setInterval(scheduleRender, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
