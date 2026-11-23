// ---- 页面结构采样器 ----
// 用途：拿到真实 BOSS 页面的 DOM 骨架，用于适配新的卡片形态（搜索页等）。
// 触发方式：插件弹窗「采样当前页面结构」按钮 → background → content script 采样 →
//           background POST 到本机平台 → 落盘为 JSON 文件。
//
// PII 硬边界（严禁突破）：
//   · 只采 DOM 结构（tag / class / id / data-* 属性名 / 层级），不采任何文本内容；
//   · 唯一例外是交互元素（button / a）且 visible text 长度 ≤ 6 时保留——这是定位
//     徽章锚点的关键信号（"打招呼""联系Ta"），6 个字符以内不可能包含姓名/公司/学校等 PII；
//   · data-* 只记属性名（data-geekid），不记值（geekId 是候选人标识，属于 PII）；
//   · iframe 只记 URL（用于判断是哪个页面），不递归进跨域 iframe。
//
// 验收：陌生人拿到这份采样，不该能还原出任何一个候选人是谁、在哪个公司、什么职位。
//
// 铁律：采样代码只在用户点按钮时执行一次，不点不动；不发任何 zhipin 请求。

var MAX_DEPTH = 12;
var MAX_CHILDREN = 200;     // 同一层级最多看 200 个子节点，防止超长列表爆输出
var MAX_OUTPUT_KB = 512;    // 单次上报 ≤ 512KB，超了截断
var MAX_TEXT_LEN = 6;       // 交互元素文本最多 6 字（"打招呼"=3，"联系Ta"=4）

function isVisible(el) {
  try {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    return true;
  } catch (e) { return true; }
}

function shortTextOf(el) {
  try {
    // 只取直接文本 + 一层内联子元素的文本，避免把整个卡片内容都算进来
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) t += n.textContent || '';
      else if (n.nodeType === 1 && n.nodeName.match(/^(SPAN|EM|STRONG|B|I)$/)) t += (n.textContent || '');
    }
    t = t.trim().replace(/\s+/g, ' ');
    if (t.length > MAX_TEXT_LEN) return null;
    return t || null;
  } catch (e) { return null; }
}

function dataAttrNames(el) {
  var names = [];
  try {
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (/^data-/.test(a.name)) names.push(a.name);
    }
  } catch (e) {}
  return names.sort();
}

function sampleNode(el, depth) {
  if (!el || el.nodeType !== 1) return null;
  if (depth > MAX_DEPTH) return { tag: el.tagName.toLowerCase(), _truncated: 'max-depth' };
  var tag = el.tagName.toLowerCase();
  var obj = { t: tag };
  var cls = [];
  try {
    if (el.className && typeof el.className === 'string') {
      cls = el.className.split(/\s+/).filter(Boolean);
    } else if (el.classList && el.classList.length) {
      for (var ci = 0; ci < el.classList.length; ci++) cls.push(el.classList[ci]);
    }
  } catch (e) {}
  if (cls.length) obj.c = cls;
  if (el.id) obj.i = el.id;
  var da = dataAttrNames(el);
  if (da.length) obj.d = da;
  // 交互元素短文本（长度 ≤ MAX_TEXT_LEN 才留）
  if (tag === 'button' || tag === 'a') {
    var txt = shortTextOf(el);
    if (txt) obj.txt = txt;
  }
  // 子节点
  var children = [];
  var childCount = 0;
  // 优先选有 class 或 id 或 data-* 的"有结构意义"的节点，纯文本/空 span 跳过。
  for (var i = 0; i < el.children.length; i++) {
    var c = el.children[i];
    if (c.nodeType !== 1) continue;
    // 跳过 script/style/link/meta 等无 DOM 意义的元素
    var ct = c.tagName.toLowerCase();
    if (ct === 'script' || ct === 'style' || ct === 'link' || ct === 'meta' ||
        ct === 'noscript' || ct === 'template' || ct === 'iframe' || ct === 'svg') continue;
    childCount++;
    if (childCount > MAX_CHILDREN) {
      children.push({ _note: 'more-children-truncated', count: el.children.length });
      break;
    }
    var cs = sampleNode(c, depth + 1);
    if (cs) children.push(cs);
  }
  if (children.length) obj.ch = children;
  return obj;
}

// 候选卡片猜测：哪些节点可能是候选人卡片。
// 依据（任一命中即猜）：
//   · tag 是 li 且有 card 类名
//   · 有 data-geekid 属性
//   · 包含文本为 "打招呼"/"联系Ta"/"沟通"/"面试"/"立即沟通" 的 button/a（精确匹配已知按钮文案）
var CARD_BUTTON_TEXTS = {
  '打招呼': 1, '联系': 1, '联系Ta': 1, '沟通': 1, '面试': 1, '立即沟通': 1,
  '收藏': 1, '牛人': 0, // 收藏按钮也常见，低置信度
};

function guessCards(root, list) {
  list = list || [];
  if (!root || root.nodeType !== 1) return list;
  // 自身是否像卡片
  var isCard = false;
  var reason = [];
  var clsList = [];
  try {
    if (root.className && typeof root.className === 'string') {
      clsList = root.className.split(/\s+/).filter(Boolean);
    } else if (root.classList) {
      for (var i = 0; i < root.classList.length; i++) clsList.push(root.classList[i]);
    }
  } catch (e) {}
  var hasCardClass = clsList.some(function (c) { return /card|candidate|geek|item/i.test(c); });
  if (root.tagName.toLowerCase() === 'li' && hasCardClass) { isCard = true; reason.push('li+card类'); }
  try {
    if (root.hasAttribute && root.hasAttribute('data-geekid')) { isCard = true; reason.push('data-geekid'); }
  } catch (e) {}
  // 找按钮
  var btns = [];
  try {
    var ba = root.querySelectorAll('button,a');
    for (var j = 0; j < ba.length; j++) {
      var bt = ba[j];
      var btText = shortTextOf(bt);
      if (btText && CARD_BUTTON_TEXTS.hasOwnProperty(btText)) {
        btns.push({ tag: bt.tagName.toLowerCase(), txt: btText });
      }
    }
  } catch (e) {}
  if (btns.length >= 2) { isCard = true; reason.push('含≥2个招聘按钮：' + btns.map(function(b){return b.txt;}).join('/')); }
  else if (btns.length === 1 && hasCardClass) { isCard = true; reason.push('card类+1按钮：' + btns[0].txt); }
  // 如果是卡片，记录精简结构（不递归子节点，只看直接子层，防输出爆炸）
  if (isCard && list.length < 10) {
    var direct = [];
    for (var k = 0; k < root.children.length && direct.length < 20; k++) {
      var c2 = root.children[k];
      if (c2.nodeType !== 1) continue;
      var c2t = c2.tagName.toLowerCase();
      if (c2t === 'script' || c2t === 'style' || c2t === 'link') continue;
      var c2c = [];
      try {
        if (c2.className && typeof c2.className === 'string') {
          c2c = c2.className.split(/\s+/).filter(Boolean);
        }
      } catch (e) {}
      direct.push({ t: c2t, c: c2c });
    }
    list.push({
      reason: reason.join('；'),
      tag: root.tagName.toLowerCase(),
      classes: clsList.slice(0, 15),
      dataAttrs: dataAttrNames(root).slice(0, 10),
      buttons: btns,
      directChildren: direct,
    });
  }
  // 递归子元素（广度优先式，避免太深）
  if (list.length < 10) {
    for (var m = 0; m < root.children.length && list.length < 10; m++) {
      var cc = root.children[m];
      if (cc.nodeType !== 1) continue;
      var cct = cc.tagName.toLowerCase();
      if (cct === 'script' || cct === 'style' || cct === 'iframe') continue;
      guessCards(cc, list);
    }
  }
  return list;
}

// 递归同源 iframe：推荐列表在 /web/frame/recommend/ iframe 里，和顶层同源，
// content script 可以直接通过 iframe.contentDocument 访问其 DOM（跨域 iframe 跳过）。
function sampleIframes(root, result, depth) {
  if (depth > 2) return;
  try {
    var ifs = root.querySelectorAll('iframe');
    result.frames = result.frames || [];
    for (var i = 0; i < ifs.length && result.frames.length < 5; i++) {
      var ifr = ifs[i];
      var finfo = { src: ifr.src || '(no-src)' };
      try {
        var idoc = ifr.contentDocument;
        if (!idoc) { finfo.crossOrigin = true; result.frames.push(finfo); continue; }
        finfo.url = idoc.location ? idoc.location.href : finfo.src;
        try { finfo.dom = sampleNode(idoc.body, 0); } catch (e) { finfo.error = String(e && e.message || e); }
        try { finfo.candidateCards = guessCards(idoc.body); } catch (e) { finfo.cardErr = String(e && e.message || e); }
        result.frames.push(finfo);
        // 不递归嵌套 iframe（depth + 1 防死循环，当前 BOSS 结构没有）
      } catch (e2) {
        finfo.crossOrigin = true;
        finfo.err = String(e2 && e2.message || e2);
        result.frames.push(finfo);
      }
    }
  } catch (e) { /* 拿不到 iframe 列表就算了 */ }
}

// 顶层采样入口
function samplePageStructure() {
  var result = {
    _v: 1,
    url: location.href,
    title: document.title ? document.title.replace(/\d{3,}/g, '***') : '', // 标题里的数字可能含职位数，打码
    timestamp: Date.now(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    frameUrl: location.href,
    // 顶层 DOM 结构树（从 body 开始）
    dom: null,
    // 候选卡片猜测
    candidateCards: [],
  };
  try { result.dom = sampleNode(document.body, 0); } catch (e) { result.dom = { error: String(e && e.message || e) }; }
  try { result.candidateCards = guessCards(document.body); } catch (e) { result.candidateCards = [{ error: String(e && e.message || e) }]; }
  // 同源 iframe 递归
  try { sampleIframes(document, result, 0); } catch (e) { result.iframeErr = String(e && e.message || e); }
  // 如果顶层没卡但 iframe 里有，把 iframe 的 candidateCards 提升到顶层字段方便阅读
  if ((!result.candidateCards || result.candidateCards.length === 0) && result.frames) {
    for (var fi = 0; fi < result.frames.length; fi++) {
      var fr = result.frames[fi];
      if (fr.candidateCards && fr.candidateCards.length > 0 && !fr.crossOrigin) {
        result.candidateCards = fr.candidateCards.map(function (c) { return Object.assign({ fromIframe: fr.url || fr.src }, c); });
        break;
      }
    }
  }
  // 大小限制
  var json = JSON.stringify(result);
  if (json.length > MAX_OUTPUT_KB * 1024) {
    // 先压深度再试
    try {
      var light = {
        _v: 1, url: location.href, timestamp: Date.now(),
        viewport: result.viewport,
        candidateCards: result.candidateCards,
        _note: 'dom 已截断，原始结构 > ' + MAX_OUTPUT_KB + 'KB，只保留候选卡片猜测',
      };
      json = JSON.stringify(light);
      if (json.length > MAX_OUTPUT_KB * 1024) {
        json = JSON.stringify({ _v: 1, url: location.href, _note: 'output too large, truncated to just url' });
      }
      return { truncated: true, data: JSON.parse(json), sizeKb: Math.round(json.length / 1024) };
    } catch (e2) {
      return { truncated: true, data: { error: 'output too large' }, sizeKb: Math.round(json.length / 1024) };
    }
  }
  return { truncated: false, data: result, sizeKb: Math.round(json.length / 1024) };
}

// 暴露给 content script 的消息入口（调试用，对外不依赖）
window.__taSampleStructure = samplePageStructure;

// 响应 background 的采样请求（options 页按钮触发 → background → content → 采样 → 回传）。
// 只有顶层帧响应——samplePageStructure 里已经递归同源 iframe（推荐列表所在的
// /web/frame/recommend/ iframe 是同源的，顶层可直接访问其 contentDocument）。
// 非顶层帧收到消息直接返回 ignored:true，避免重复响应（但因为顶层也在，第一个响应者就是顶层）。
chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || msg.type !== 'ta-sample-page') return false;
  if (window.top !== window.self) { sendResponse({ ignored: true }); return false; }
  try {
    var r = samplePageStructure();
    sendResponse(r);
  } catch (e) {
    sendResponse({ error: String(e && e.message || e) });
  }
  return false;
});
