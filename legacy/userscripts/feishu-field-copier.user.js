// ==UserScript==
// @name         飞书表单字段搬运工 (通用版)
// @namespace    acme-feishu-field-copier
// @version      1.1.0
// @description  通用飞书表单字段搬运:一键把源表单已填字段采集下来,匹配后回填到另一个飞书表单的同类字段。匹配靠字段标签名+别名表,不写死业务。零 LLM / 零后端 / 零外部请求;绝不自动提交;绝不在候选人页面运行。
// @author       you
// @match        https://acme.feishu.cn/hire/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ============================================================================
 *  结构导航
 *  §1 CONFIG        —— 所有选择器 / 启发式 / 页面黑白名单 / 默认别名(可改)
 *  §2 STORE         —— 本地存储抽象(GM_* 优先,退化 localStorage)
 *  §3 UTIL          —— 归一化 / 可见性 / 等待元素 等工具
 *  §4 SCAN          —— 通用采集引擎:扫描当前表单所有字段 {label,value,type}
 *  §5 MATCH         —— 匹配引擎:归一化精确 + 别名表
 *  §6 FILL          —— 回填引擎:文本 / 富文本 / 自绘下拉
 *  §7 UI            —— 悬浮面板 / 结果清单 / 配置面板 / toast / 高亮
 *  §8 ACTIONS       —— 复制 / 带入 / 探测 三个入口动作
 *  §9 GUARD & BOOT  —— 页面守卫(候选人页禁用)+ SPA 路由监听 + 初始化
 * ============================================================================
 */

(function () {
  'use strict';

  /* ==========================================================================
   * §1 CONFIG —— 所有可调项集中在这里,飞书改版时优先在此调整
   * ======================================================================== */

  // 1.1 页面守卫(白名单优先):
  //     - ALLOW:只有命中这些路由才激活脚本(注入 UI + 允许采集/回填)。
  //     - DENY :候选人/隐私相关页面,命中即完全不激活(优先级高于 ALLOW)。
  //     生效条件 = 命中 ALLOW 且不命中 DENY。二者都在真实页面用探针校准后再收紧。
  const ALLOW_PATTERNS = [
    /\/hire\/job\/requirement/i,   // 招聘需求(提需求)列表/表单
    /\/hire\/job\/list/i,          // 职位列表
    /\/hire\/job\/create/i,        // "新建职位"表单(真实路由待校准确认)
    /\/hire\/job\/new/i,           // "新建职位"表单备用形态(待校准确认)
  ];
  const DENY_PATTERNS = [
    /talent/i, /application/i, /candidate/i,
    /resume/i, /interview/i, /offer/i, /people\/detail/i,
  ];

  // 1.2 采集用的候选控件选择器(按优先级分组,靠前的优先作为"字段主控件")
  const CONTROL_GROUPS = [
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]), textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="combobox"], [role="listbox"]',
    '[class*="select" i]',
  ];

  // 1.3 标签定位:在祖先层里用这些选择器找"标签文本元素"
  const LABEL_SELECTORS = [
    'label',
    '[class*="label" i]',
    '[class*="title" i]',
    '[class*="field-name" i]',
    '[class*="form-item" i] [class*="name" i]',
  ];

  // 1.4 表单项根节点选择器:用于把同一字段的多个控件归并去重
  //     实地校准(飞书招聘 UD 组件库, 2026-07 杨承鹏账号):真实表单项根 = ud__form__item(双下划线),
  //     旧的 form-item 匹配不到 → 必须含 form__item。文本控件=input.ud__native-input,
  //     下拉控件=div.ud__select__selector,JD 正文(职位职责/职位要求)=textarea。对话框=createJrModal。
  const FORM_ITEM_SELECTORS = [
    '[class*="form__item" i]',   // ud__form__item —— 飞书招聘真实表单项(实地校准)
    '[class*="form-item" i]',
    '[class*="form_item" i]',
    '[class*="formItem" i]',
    '[class*="field" i]',
  ];

  // 1.5 下拉弹层 & 选项选择器(飞书弹层通常挂在 body 下)
  //     实地校准:飞书招聘顶部导航是 atsx__ud__menu / menu-item;若用 [class*=menu]、menu-item、
  //     裸 li 会误命中导航栏 → 已移除。UD select 弹层/选项按 ud__select__popup / ud__select__option 收窄。
  const POPUP_SELECTORS = [
    '[class*="ud__select__popup" i]',
    '[class*="ud__select__dropdown" i]',
    '[class*="select__popup" i]',
    '[class*="trigger-popup" i]',
    '[class*="dropdown" i]',
    '[class*="popover" i]',
    '[role="listbox"]',
  ];
  const OPTION_SELECTORS = [
    '[role="option"]',
    '[class*="ud__select__option" i]',
    '[class*="select__option" i]',
    '[class*="select-item" i]',
    '[class*="select__item" i]',
  ];

  // 1.6 启发式阈值
  const HEURISTICS = {
    labelMaxUp: 8,        // 向上找标签最多层数
    labelMaxLen: 30,      // 合法标签的最大字符数
    popupTimeout: 1800,   // 等待下拉弹层出现的超时(ms)
    optionTimeout: 1800,  // 等待选项出现的超时(ms)
  };

  // 1.7 占位符/空值词:命中这些的下拉/输入按"空"处理
  const PLACEHOLDER_TOKENS = ['请选择', '请输入', '请填写', '暂无', '无', '-', '—', '--'];

  // 1.8 存储键
  const KEY_SOURCE = 'ffc_source_v1';
  const KEY_CONFIG = 'ffc_config_v1';

  // 1.9 默认业务配置(这些是"数据/示例",不是引擎逻辑;用户可在配置面板随意改)
  //     aliases 方向:{目标表单标签: 源表单标签}
  const DEFAULT_CONFIG = {
    aliases: {
      '职位名称': '需求名称',
      '部门': '需求部门',
    },
    ignore: [],  // 例如:["需求状态","需求负责人"] —— 这些字段不参与带入
    debug: false,
  };

  const UI_ROOT_ID = 'ffc-root';

  /* ==========================================================================
   * §2 STORE —— 本地存储抽象
   * ======================================================================== */

  const store = {
    get(key, def) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          return (v === undefined || v === null) ? def : v;
        }
        const s = localStorage.getItem(key);
        return s == null ? def : JSON.parse(s);
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
        localStorage.setItem(key, JSON.stringify(val));
      } catch (e) { /* 忽略:存储失败不影响使用 */ }
    },
    del(key) {
      try {
        if (typeof GM_deleteValue === 'function') { GM_deleteValue(key); return; }
        localStorage.removeItem(key);
      } catch (e) { /* 忽略 */ }
    },
  };

  function loadConfig() {
    const saved = store.get(KEY_CONFIG, null);
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_CONFIG };
    return {
      aliases: saved.aliases && typeof saved.aliases === 'object' ? saved.aliases : { ...DEFAULT_CONFIG.aliases },
      ignore: Array.isArray(saved.ignore) ? saved.ignore : [],
      debug: !!saved.debug,
    };
  }
  function saveConfig(cfg) { store.set(KEY_CONFIG, cfg); }

  let CONFIG = loadConfig();

  /* ==========================================================================
   * §3 UTIL —— 工具函数
   * ======================================================================== */

  // 值归一化:仅去首尾空白、折叠内部空白(保留 : 等,值里可能有意义)
  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }
  // 标签归一化:在 normText 基础上去掉零宽字符 / * 必填标记 / 结尾冒号
  // (实地校准:飞书部分标签如"职位职责"含零宽字符 ​,不去会导致匹配落空)
  function normLabel(s) {
    return normText(s)
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[*\uFF0A]/g, '')
      .replace(/[:\uFF1A]\s*$/, '')
      .trim();
  }
  // 判断字符串是否等于/仅是占位符(视为空)
  function isPlaceholder(s) {
    const t = normText(s);
    if (!t) return true;
    return PLACEHOLDER_TOKENS.some(p => t === p || t.startsWith(p));
  }
  function stripPlaceholderPrefix(s) {
    let t = normText(s);
    for (const p of PLACEHOLDER_TOKENS) {
      if (t.startsWith(p)) { t = t.slice(p.length).trim(); break; }
    }
    return t;
  }
  // 元素是否可见
  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    if (el.getClientRects().length === 0) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) === 0) return false;
    return true;
  }
  // 是否属于本脚本自己的 UI
  function inOwnUI(el) {
    const root = document.getElementById(UI_ROOT_ID);
    return root && root.contains(el);
  }
  // 是否是我们能"打字"的文本类控件
  function isEditableInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      const okType = ['text', 'search', 'tel', 'url', 'email', 'number', ''].includes(t);
      return okType && !el.readOnly && !el.disabled;
    }
    return false;
  }
  // 等待:pred() 返回真值即 resolve,否则超时 resolve(null)
  function waitFor(pred, timeout) {
    timeout = timeout || 1500;
    return new Promise(resolve => {
      const start = Date.now();
      let done = false;
      const check = () => {
        if (done) return;
        let v = null;
        try { v = pred(); } catch (e) { v = null; }
        if (v) { done = true; cleanup(); resolve(v); }
        else if (Date.now() - start > timeout) { done = true; cleanup(); resolve(null); }
      };
      let mo = null;
      try {
        mo = new MutationObserver(check);
        mo.observe(document.body, { childList: true, subtree: true, attributes: true });
      } catch (e) { /* ignore */ }
      const iv = setInterval(check, 80);
      function cleanup() { if (mo) mo.disconnect(); clearInterval(iv); }
      check();
    });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 真实指针事件序列:UD 等自绘组件对合成 el.click() 常无反应(实地验证下拉打不开),
  // 需派发完整 pointer/mouse 序列才能触发其展开/选中逻辑。
  function realClick(el) {
    if (!el) return;
    const opt = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => {
      try {
        const usePointer = t.startsWith('pointer') && typeof window.PointerEvent === 'function';
        el.dispatchEvent(usePointer ? new PointerEvent(t, opt) : new MouseEvent(t.replace('pointer', 'mouse'), opt));
      } catch (e) { /* ignore 单个事件失败 */ }
    });
  }

  /* ==========================================================================
   * §4 SCAN —— 通用采集引擎
   * ======================================================================== */

  // 找某控件对应的标签文本
  function findLabel(el) {
    let node = el;
    for (let i = 0; i < HEURISTICS.labelMaxUp && node; i++) {
      node = node.parentElement;
      if (!node) break;
      let cands = [];
      try { cands = node.querySelectorAll(LABEL_SELECTORS.join(',')); } catch (e) { cands = []; }
      for (const c of cands) {
        if (c.contains(el)) continue;           // 标签不应包含控件本身
        if (inOwnUI(c)) continue;
        const t = normLabel(c.innerText || c.textContent);
        if (t && t.length <= HEURISTICS.labelMaxLen) return t;
      }
    }
    // 退化:aria-label / placeholder(去掉"请输入/请选择"前缀)
    const aria = normLabel(el.getAttribute && el.getAttribute('aria-label'));
    if (aria && aria.length <= HEURISTICS.labelMaxLen) return aria;
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) {
      const t = normLabel(stripPlaceholderPrefix(ph));
      if (t && t.length <= HEURISTICS.labelMaxLen) return t;
    }
    return '';
  }

  // 找控件所在的"表单项根节点",用于去重
  function findFormItemRoot(el) {
    let node = el;
    for (let i = 0; i < HEURISTICS.labelMaxUp && node; i++) {
      node = node.parentElement;
      if (!node) break;
      for (const sel of FORM_ITEM_SELECTORS) {
        try { if (node.matches(sel)) return node; } catch (e) { /* ignore */ }
      }
    }
    return el.parentElement || el;
  }

  // 判定控件类型
  function classify(el) {
    const tag = el.tagName;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    const editable = el.getAttribute && el.getAttribute('contenteditable') === 'true';
    if (editable || role === 'textbox') return 'richtext';
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'INPUT') {
      // 只读 input 且处于 select 容器里,当作下拉
      if ((el.readOnly || role === 'combobox') && el.closest('[class*="select" i],[role="combobox"]')) return 'dropdown';
      return 'text';
    }
    if (role === 'combobox' || role === 'listbox') return 'dropdown';
    return 'dropdown'; // [class*=select] 容器等
  }

  // 读取控件当前值
  function readValue(el, type, root) {
    if (type === 'text' || type === 'textarea') {
      return isPlaceholder(el.value) ? '' : normText(el.value);
    }
    if (type === 'richtext') {
      return isPlaceholder(el.innerText) ? '' : normText(el.innerText);
    }
    // dropdown:优先 UD 选中项文本 → 内部 input 值 → 控件自身文本
    // (实地校准:不再退化到 root.innerText,否则会把标签"工作地点"与值"上海"读成一串)
    let raw = '';
    const selItem = el.querySelector && el.querySelector('[class*="selection-item" i],[class*="select__selection" i]');
    const inner = el.querySelector && el.querySelector('input');
    if (selItem && normText(selItem.innerText)) raw = selItem.innerText;
    else if (inner && inner.value) raw = inner.value;
    else raw = (el.innerText || '');
    return isPlaceholder(raw) ? '' : normText(raw);
  }

  // 生成一个简短的定位信息(探针用)
  function describeLocator(el) {
    const tag = el.tagName.toLowerCase();
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const role = el.getAttribute && el.getAttribute('role');
    return `${tag}${cls}${role ? `[role=${role}]` : ''}`;
  }

  // 扫描当前表单所有字段,返回 [{label,value,type,el,root,locator}]
  function scanFields() {
    const seenEls = new Set();
    const seenRoots = new Set();
    const fields = [];

    for (const groupSel of CONTROL_GROUPS) {
      let nodes = [];
      try { nodes = document.querySelectorAll(groupSel); } catch (e) { nodes = []; }
      for (const el of nodes) {
        if (seenEls.has(el)) continue;
        seenEls.add(el);
        if (inOwnUI(el) || !isVisible(el)) continue;

        const root = findFormItemRoot(el);
        if (seenRoots.has(root)) continue;   // 同一表单项已收录(靠前分组优先)
        const label = findLabel(el);
        if (!label) continue;                // 没标签的控件跳过
        seenRoots.add(root);

        const type = classify(el);
        const value = readValue(el, type, root);
        fields.push({ label, value, type, el, root, locator: describeLocator(el) });
      }
    }
    return fields;
  }

  /* ==========================================================================
   * §5 MATCH —— 匹配引擎(归一化精确 + 别名)
   * ======================================================================== */

  function isIgnored(label) {
    const n = normLabel(label);
    return (CONFIG.ignore || []).some(x => normLabel(x) === n);
  }

  // 在源字段列表里为目标标签找值,返回 {label,value,via} 或 null
  function matchSource(targetLabel, srcList) {
    const n = normLabel(targetLabel);
    // 1) 归一化精确匹配
    let hit = srcList.find(f => f.label === n);
    if (hit) return { ...hit, via: '同名' };
    // 2) 别名匹配:aliases[目标标签]=源标签
    const aliasMap = CONFIG.aliases || {};
    // 别名 key 也做归一化比较
    for (const k in aliasMap) {
      if (normLabel(k) === n) {
        const srcLabel = normLabel(aliasMap[k]);
        hit = srcList.find(f => f.label === srcLabel);
        if (hit) return { ...hit, via: `别名(${k}→${aliasMap[k]})` };
      }
    }
    return null;
  }

  /* ==========================================================================
   * §6 FILL —— 回填引擎
   * ======================================================================== */

  // 文本 / 文本域:原生 setter + 派发 input/change(React 受控组件必须如此)
  function fillTextLike(el, value) {
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return true;
    } catch (e) { return false; }
  }

  // 富文本 contenteditable:优先 execCommand('insertText'),退化 textContent + input
  function fillRich(el, value) {
    try {
      el.focus();
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
        document.execCommand('insertText', false, value);
      } catch (e) { /* 某些编辑器不支持,走退化 */ }
      if (normText(el.innerText) !== normText(value)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      el.blur();
      return true;
    } catch (e) { return false; }
  }

  function closePopup() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    } catch (e) { /* ignore */ }
  }

  // 找到当前打开的、含选项的可见弹层
  function findOpenPopup() {
    let popups = [];
    try { popups = document.querySelectorAll(POPUP_SELECTORS.join(',')); } catch (e) { popups = []; }
    let best = null;
    for (const p of popups) {
      if (inOwnUI(p) || !isVisible(p)) continue;
      let hasOpt = false;
      try { hasOpt = p.querySelector(OPTION_SELECTORS.join(',')) != null; } catch (e) { hasOpt = false; }
      if (hasOpt) best = p; // 取最后一个(通常最新打开)
    }
    return best;
  }

  // 自绘下拉:开面板 → (有搜索框先过滤) → 精确命中点击;否则不硬填
  // 返回 {status:'ok'|'manual', reason?}
  async function fillDropdown(el, value) {
    try {
      el.scrollIntoView({ block: 'center' });
      const clickTarget = (el.querySelector && (el.querySelector('input,[role=combobox]'))) || el;
      realClick(clickTarget);

      const popup = await waitFor(findOpenPopup, HEURISTICS.popupTimeout);
      if (!popup) { closePopup(); return { status: 'manual', reason: '下拉面板未打开' }; }

      // 若弹层内有搜索框,先输入以过滤长列表
      const searchInput = popup.querySelector('input:not([type=hidden])');
      if (searchInput && isEditableInput(searchInput)) {
        fillTextLike(searchInput, value);
        await sleep(250);
      }

      // 等待并匹配选项(精确文本相等)
      const target = normText(value);
      const findHit = () => {
        let opts = [];
        try { opts = popup.querySelectorAll(OPTION_SELECTORS.join(',')); } catch (e) { opts = []; }
        for (const o of opts) {
          if (!isVisible(o)) continue;
          if (normText(o.innerText) === target) return o;
        }
        return null;
      };
      const hit = await waitFor(findHit, HEURISTICS.optionTimeout);
      if (!hit) { closePopup(); return { status: 'manual', reason: '未找到匹配选项' }; }

      realClick(hit);
      await sleep(120);
      return { status: 'ok' };
    } catch (e) {
      closePopup();
      return { status: 'manual', reason: '异常:' + (e && e.message) };
    }
  }

  /* ==========================================================================
   * §7 UI —— 面板 / 结果 / 配置 / toast / 高亮
   * ======================================================================== */

  const CSS = `
    #${UI_ROOT_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483000;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}
    #${UI_ROOT_ID} *{box-sizing:border-box;}
    .ffc-bar{display:flex;flex-direction:column;gap:8px;align-items:flex-end;}
    .ffc-btn{cursor:pointer;border:none;border-radius:10px;padding:10px 14px;font-size:13px;color:#fff;
      background:#3370ff;box-shadow:0 4px 14px rgba(0,0,0,.18);white-space:nowrap;transition:.15s;}
    .ffc-btn:hover{filter:brightness(1.08);}
    .ffc-btn.sec{background:#f0f3ff;color:#3370ff;}
    .ffc-btn.mini{padding:6px 10px;font-size:12px;}
    .ffc-panel{position:fixed;right:16px;bottom:16px;width:360px;max-height:70vh;overflow:auto;background:#fff;
      border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.22);padding:16px;z-index:2147483001;color:#1f2329;font-size:13px;}
    .ffc-panel h3{margin:0 0 10px;font-size:15px;display:flex;justify-content:space-between;align-items:center;}
    .ffc-x{cursor:pointer;color:#8a919f;font-size:18px;line-height:1;}
    .ffc-sec{margin:10px 0;}
    .ffc-sec b{display:block;margin-bottom:4px;}
    .ffc-row{padding:4px 8px;border-radius:6px;margin:3px 0;background:#f7f8fa;line-height:1.4;word-break:break-all;}
    .ffc-ok{border-left:3px solid #34c724;}
    .ffc-warn{border-left:3px solid #ff8800;}
    .ffc-no{border-left:3px solid #d0d3d6;}
    .ffc-toast{position:fixed;left:50%;top:20px;transform:translateX(-50%);background:rgba(31,35,41,.92);color:#fff;
      padding:10px 18px;border-radius:8px;font-size:13px;z-index:2147483002;box-shadow:0 4px 20px rgba(0,0,0,.25);}
    .ffc-ta{width:100%;height:200px;font-family:monospace;font-size:12px;border:1px solid #dee0e3;border-radius:8px;padding:8px;}
    .ffc-hl{outline:2px solid #34c724 !important;outline-offset:1px;background:rgba(52,199,36,.08) !important;}
    .ffc-hl-warn{outline:2px dashed #ff8800 !important;outline-offset:1px;background:rgba(255,136,0,.08) !important;}
    .ffc-help{color:#8a919f;font-size:12px;margin:6px 0;line-height:1.5;}
  `;

  function injectCSS() {
    if (document.getElementById('ffc-css')) return;
    const s = document.createElement('style');
    s.id = 'ffc-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'ffc-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 2600);
  }

  function highlight(el, warn, srcLabel) {
    if (!el) return;
    el.classList.remove('ffc-hl', 'ffc-hl-warn');
    el.classList.add(warn ? 'ffc-hl-warn' : 'ffc-hl');
    if (srcLabel) el.title = `【搬运工】来源:${srcLabel}`;
  }
  function clearHighlights() {
    document.querySelectorAll('.ffc-hl,.ffc-hl-warn').forEach(el => {
      el.classList.remove('ffc-hl', 'ffc-hl-warn');
    });
  }

  function closePanel() {
    const p = document.getElementById('ffc-panel');
    if (p) p.remove();
  }
  function openPanel(titleHTML, bodyNode) {
    closePanel();
    const p = document.createElement('div');
    p.id = 'ffc-panel';
    p.className = 'ffc-panel';
    const h = document.createElement('h3');
    h.innerHTML = `<span>${titleHTML}</span><span class="ffc-x">×</span>`;
    h.querySelector('.ffc-x').onclick = closePanel;
    p.appendChild(h);
    p.appendChild(bodyNode);
    document.getElementById(UI_ROOT_ID).appendChild(p);
  }

  function renderBar() {
    let root = document.getElementById(UI_ROOT_ID);
    if (root) root.remove();
    root = document.createElement('div');
    root.id = UI_ROOT_ID;
    const bar = document.createElement('div');
    bar.className = 'ffc-bar';

    const bCopy = mkBtn('📋 复制本表单字段', 'ffc-btn', doCopy);
    const bPaste = mkBtn('⬇️ 带入', 'ffc-btn', doPaste);
    const bCfg = mkBtn('⚙️ 配置', 'ffc-btn sec mini', openConfigPanel);
    bar.appendChild(bCopy);
    bar.appendChild(bPaste);
    if (CONFIG.debug) bar.appendChild(mkBtn('🔍 探测字段', 'ffc-btn sec mini', doProbe));
    bar.appendChild(bCfg);

    root.appendChild(bar);
    document.body.appendChild(root);
  }
  function mkBtn(text, cls, onclick) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.onclick = onclick;
    return b;
  }

  function rowsHTML(list, cls, render) {
    if (!list.length) return `<div class="ffc-help">(无)</div>`;
    return list.map(x => `<div class="ffc-row ${cls}">${render(x)}</div>`).join('');
  }

  function showResultPanel(results) {
    const body = document.createElement('div');
    const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    body.innerHTML = `
      <div class="ffc-sec"><b>✅ 已自动填 (${results.ok.length})</b>
        ${rowsHTML(results.ok, 'ffc-ok', x => `${esc(x.label)} ← <i>${esc(x.value)}</i> <span class="ffc-help">${esc(x.via || '')}</span>`)}</div>
      <div class="ffc-sec"><b>⚠️ 需人工确认 · 下拉 (${results.manual.length})</b>
        ${rowsHTML(results.manual, 'ffc-warn', x => `${esc(x.label)}:请手动选 <i>${esc(x.value)}</i> <span class="ffc-help">${esc(x.reason || '')}</span>`)}</div>
      <div class="ffc-sec"><b>❓ 未匹配 (${results.nomatch.length})</b>
        ${rowsHTML(results.nomatch, 'ffc-no', x => `${esc(x.label)} <span class="ffc-help">${esc(x.type)}</span>`)}</div>
      <div class="ffc-help">已高亮页面上被填写的字段。请核对后手动点保存/提交(脚本从不自动提交)。</div>
    `;
    openPanel('带入结果', body);
  }

  function openConfigPanel() {
    const body = document.createElement('div');
    const ta = document.createElement('textarea');
    ta.className = 'ffc-ta';
    ta.value = JSON.stringify(CONFIG, null, 2);
    const help = document.createElement('div');
    help.className = 'ffc-help';
    help.innerHTML = `aliases:{"目标表单标签":"源表单标签"};ignore:不参与带入的字段;debug:开探针。<br>非技术同学不改也能用——同名字段照样搬。`;
    const save = mkBtn('保存配置', 'ffc-btn', () => {
      try {
        const parsed = JSON.parse(ta.value);
        CONFIG = {
          aliases: parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {},
          ignore: Array.isArray(parsed.ignore) ? parsed.ignore : [],
          debug: !!parsed.debug,
        };
        saveConfig(CONFIG);
        toast('配置已保存');
        closePanel();
        renderBar();
      } catch (e) { toast('JSON 格式错误:' + e.message, 3500); }
    });
    body.appendChild(help);
    body.appendChild(ta);
    body.appendChild(document.createElement('br'));
    body.appendChild(save);
    openPanel('配置(可编辑)', body);
  }

  /* ==========================================================================
   * §8 ACTIONS —— 复制 / 带入 / 探测
   * ======================================================================== */

  function doCopy() {
    if (!isActivePage()) { toast('当前页面不在允许范围,已停用'); return; }
    const fields = scanFields();
    if (!fields.length) { toast('未扫描到任何字段(可能不是表单页,或需开 debug 探测校准)', 3500); return; }
    // 只存序列化数据,绝不存 DOM
    const payload = fields
      .filter(f => !isIgnored(f.label))
      .map(f => ({ label: f.label, value: f.value, type: f.type }));
    store.set(KEY_SOURCE, { at: Date.now(), href: location.href, fields: payload });
    const withVal = payload.filter(f => f.value !== '').length;
    toast(`已复制 ${payload.length} 个字段(其中 ${withVal} 个有值)`);
  }

  async function doPaste() {
    if (!isActivePage()) { toast('当前页面不在允许范围,已停用'); return; }
    const src = store.get(KEY_SOURCE, null);
    if (!src || !Array.isArray(src.fields) || !src.fields.length) {
      toast('尚未复制任何源表单字段,请先在源表单点「📋 复制」', 3500);
      return;
    }
    clearHighlights();
    const srcList = src.fields.map(f => ({ label: normLabel(f.label), value: f.value, type: f.type }));
    const targets = scanFields();
    const results = { ok: [], manual: [], nomatch: [] };
    const dropdownJobs = [];

    // 先处理文本/富文本(同步),下拉留到后面顺序处理(避免多个面板同时打开)
    for (const tf of targets) {
      if (isIgnored(tf.label)) continue;
      const m = matchSource(tf.label, srcList);
      if (!m || m.value === '') { results.nomatch.push(tf); continue; }

      if (tf.type === 'dropdown') {
        dropdownJobs.push({ tf, m });
      } else {
        let ok = false;
        if (tf.type === 'richtext') ok = fillRich(tf.el, m.value);
        else ok = fillTextLike(tf.el, m.value);
        if (ok) {
          highlight(tf.el, false, m.label);
          results.ok.push({ label: tf.label, value: m.value, via: m.via });
        } else {
          highlight(tf.el, true, m.label);
          results.manual.push({ label: tf.label, value: m.value, reason: '写入失败,请手动填' });
        }
      }
    }

    // 顺序处理下拉
    for (const job of dropdownJobs) {
      const r = await fillDropdown(job.tf.el, job.m.value);
      if (r.status === 'ok') {
        highlight(job.tf.el, false, job.m.label);
        results.ok.push({ label: job.tf.label, value: job.m.value, via: job.m.via });
      } else {
        highlight(job.tf.el, true, job.m.label);
        results.manual.push({ label: job.tf.label, value: job.m.value, reason: r.reason || '请手动选' });
      }
    }

    // 回填完成后清除本地已复制的源数据,避免字段值长期留存于浏览器存储
    store.del(KEY_SOURCE);

    showResultPanel(results);
  }

  function doProbe() {
    const fields = scanFields();
    const table = fields.map(f => ({ 标签: f.label, 类型: f.type, 当前值: f.value, 定位: f.locator }));
    try { console.table(table); } catch (e) { console.log(table); }
    const body = document.createElement('div');
    const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    body.innerHTML = `<div class="ffc-help">共 ${fields.length} 个字段;完整表格已打到控制台(F12 → Console)。请把控制台输出贴回给开发者以校准选择器。</div>` +
      fields.map(f => `<div class="ffc-row ffc-no"><b>${esc(f.label)}</b> · ${esc(f.type)}<br><span class="ffc-help">值:${esc(f.value) || '(空)'} · ${esc(f.locator)}</span></div>`).join('');
    openPanel('探针:检测到的字段', body);
  }

  /* ==========================================================================
   * §9 GUARD & BOOT —— 页面守卫 + SPA 监听 + 初始化
   * ======================================================================== */

  function isDeniedPage() {
    const href = location.href;
    return DENY_PATTERNS.some(re => re.test(href));
  }
  function isAllowedPage() {
    const href = location.href;
    return ALLOW_PATTERNS.some(re => re.test(href));
  }
  // 生效条件:命中 ALLOW 且不命中 DENY
  function isActivePage() {
    return isAllowedPage() && !isDeniedPage();
  }

  function mount() {
    injectCSS();
    if (!isActivePage()) {
      // 非白名单页面(或命中 DENY):彻底移除 UI,不运行任何采集
      const root = document.getElementById(UI_ROOT_ID);
      if (root) root.remove();
      closePanel();
      return;
    }
    renderBar();
  }

  // 监听 SPA 路由变化,变化后重挂载(去抖)
  let lastHref = location.href;
  let remountTimer = null;
  function onRouteMaybeChanged() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    clearHighlights();
    closePanel();
    clearTimeout(remountTimer);
    remountTimer = setTimeout(mount, 300);
  }
  function hookHistory() {
    ['pushState', 'replaceState'].forEach(fn => {
      const orig = history[fn];
      if (!orig || orig.__ffc) return;
      const wrapped = function () {
        const r = orig.apply(this, arguments);
        onRouteMaybeChanged();
        return r;
      };
      wrapped.__ffc = true;
      history[fn] = wrapped;
    });
    window.addEventListener('popstate', onRouteMaybeChanged);
    // 兜底轮询(飞书内部有时不走标准 history)
    setInterval(onRouteMaybeChanged, 800);
  }

  function boot() {
    if (window.top !== window.self) return; // 只在顶层文档
    hookHistory();
    // 等 body 就绪再挂载
    const start = () => mount();
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  }

  boot();
})();
