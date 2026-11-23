  // ---- 配置 ----
  // 卡片选择器按【由准到宽】排列，命中第一个有结果的就用它。
  // 页面适应机制：BOSS 改版时 li.card-item 可能失效，但候选人卡片总归是"带 data-geekid 的块"，
  // 后面几条兜底就是照这个特征写的。全部落空会由 noCardStreak 上报诊断（见 reportAlive）。
  var CARD_SELS = [
    'li.card-item',                          // 推荐牛人（真机验证）
    'li[class*="card-item"]',
    '.card-inner[data-geekid]',              // 卡片内层直接带 geekid
    '[data-geekid]:not([data-geekid=""])',
    'li[class*="geek-item"], li[class*="candidate"]',  // 搜索页可能的形态
  ];
  var CARD_SEL = CARD_SELS[0];               // 当前生效的那条（每轮扫描自适应）
  // 平台「打招呼」按钮（真机已校准：推荐流卡片上是 .btn-greet）。
  // 徽章要贴在它【下方】，这是用户明确要求的位置——评分紧挨着决策按钮才有用。
  var GREET_SEL = '.btn.btn-greet, .btn-greet, [class*="btn-greet"], [class*="start-chat"], [class*="btn-chat"]';
  var JD_MENU_CONF = 0.5;          // 岗位自动识别的最低置信度，低于它不自动切换
  var ROUTE_TICK_MS = 1500;        // 路由巡检间隔（只比较 location.href 字符串，无 DOM 查询）
  var RESCAN_TICK_MS = 5000;       // 兜底重扫间隔
  var ALIVE_TICK_MS = 15000;       // 向平台上报"BOSS 页面还开着"的心跳间隔

  // 每张卡片的三份弱引用：宿主元素 / shadow root / 上次评分用的 cardKey。
  // shadowRoot 必须自己存：宿主是 mode:'closed'，host.shadowRoot 恒为 null，取不回来。
  var hostForCard = new WeakMap();
  var rootForCard = new WeakMap();
  var scoredMap = new WeakMap();

  var jdCache = null;
  var lastHref = location.href;
  var started = false;
  var rescanScheduled = false;
  var jobDetected = null;          // { id, name, conf, auto }
  var observer = null;
  var openMenu = null;             // { root, el } —— 同一时刻只允许一个菜单打开
  var lastCardCount = 0;           // 本帧最近一次扫描到的卡片数（心跳上报用）
  var noCardStreak = 0;            // 连续多少轮一张卡都没选到（页面适应诊断）
  var cardScoreById = {};          // geekid → { c: 卡片级候选人, r: 卡片级评分 }，供第二级评分接力
  // ── 跨帧接力（v3，2026-07-29）────────────────────────────────────────────
  // 真机事故：详情面板可能渲染在【另一个帧】里（列表在 /web/frame/recommend/ 子帧，
  // 详情可能是独立弹层帧/新页）。cardScoreById 是帧内内存，跨帧拿不到 → 深度分
  // 永远没有"卡片级底子"。解法：卡片级结果落 chrome.storage.local，任何帧的
  // 详情逻辑都能读到镜像。写入按 3 秒批量合并，24h/300 条自动淘汰。
  var CARD_CACHE_KEY = 'ta-card-cache';
  var cardCacheMirror = {};        // storage 里的跨帧镜像（gid → { c, t: 卡片总分, at }）
  var cardCacheDirty = {};         // 本帧攒的待写入
  function loadCardCache() {
    try {
      chrome.storage.local.get(CARD_CACHE_KEY, function (r) {
        if (chrome.runtime.lastError) return;
        cardCacheMirror = (r && r[CARD_CACHE_KEY]) || {};
      });
    } catch (e) { /* ignore */ }
  }
  function flushCardCache() {
    var keys = Object.keys(cardCacheDirty);
    if (!keys.length) return;
    var dirty = cardCacheDirty;
    cardCacheDirty = {};
    try {
      chrome.storage.local.get(CARD_CACHE_KEY, function (r) {
        if (chrome.runtime.lastError) return;
        var all = (r && r[CARD_CACHE_KEY]) || {};
        for (var k in dirty) if (Object.prototype.hasOwnProperty.call(dirty, k)) all[k] = dirty[k];
        // 淘汰：先按时间升序，删掉超 24h 的与超出 300 条的最老部分
        var now = Date.now();
        var ids = Object.keys(all).sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
        var excess = ids.length - 300;
        for (var i = 0; i < ids.length; i++) {
          if (i < excess || now - (all[ids[i]].at || 0) > 86400000) delete all[ids[i]];
        }
        var obj = {}; obj[CARD_CACHE_KEY] = all;
        chrome.storage.local.set(obj, function () { if (chrome.runtime.lastError) { /* 满了就丢，下轮再试 */ } });
        cardCacheMirror = all;
      });
    } catch (e) { /* ignore */ }
  }
  var detailHost = null;           // 详情面板上的深度分宿主
  var detailRoot = null;
  var detailKey = '';              // 当前详情面板对应的 geekid+分数指纹，用于防重绘
  var detailOwnerGid = '';         // 当前 .dp 徽章【属于哪个候选人】，用于切换候选人时的归属校验

  // ---- Shadow DOM 样式 ----
  // 宿主是 pointer-events:none（避免挡住 BOSS 自己的点击区），所以每个需要交互的
  // 元素都必须显式写回 pointer-events:auto —— 该属性可继承，漏写就点不动。
  var SHADOW_CSS = [
    ':host{display:block;position:relative}',
    '.b{min-width:34px;height:24px;padding:0 9px;border-radius:12px;color:#fff;font-size:13px;font-weight:700;line-height:24px;text-align:center;font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.18);cursor:pointer;user-select:none;pointer-events:auto;transition:transform .12s ease;position:relative;z-index:2}',
    '.b:hover{transform:scale(1.06)}',
    '.b-verdict{min-width:56px;font-size:12px}' +
    '.ds-verdict{font-size:17px}' +
    '.b-h{background:#12a05c}.b-m{background:#e08b1e}.b-l{background:#9aa4b2}.b-x{background:#d64545;min-width:64px;font-size:12px}.b-i{background:#c9ced6;color:#6b7280}',
    '.auto-dot{position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;background:#4a9eff;border:2px solid #fff;z-index:3}',
    '.dc{display:none;position:absolute;top:0;background:#fff;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.18);padding:14px;font-size:12.5px;line-height:1.55;color:#1f2430;pointer-events:auto;z-index:999;width:320px;max-height:420px;overflow-y:auto;font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.dc::-webkit-scrollbar{width:4px}.dc::-webkit-scrollbar-thumb{background:#ccc;border-radius:2px}',
    '.dh{display:flex;align-items:center;gap:10px;margin-bottom:8px}',
    '.ds{font-size:28px;font-weight:800;line-height:1;font-family:inherit}',
    '.ds.h{color:#12a05c}.ds.m{color:#e08b1e}.ds.l{color:#9aa4b2}.ds.x{color:#d64545}',
    '.dg{font-size:13px;font-weight:600;padding:2px 8px;border-radius:4px;color:#fff}',
    '.dg.h{background:#12a05c}.dg.m{background:#e08b1e}.dg.l{background:#9aa4b2}.dg.x{background:#d64545}',
    '.dt{font-size:12px;color:#6b7280;flex:1;word-break:break-all}',
    '.dsec{margin-top:8px}',
    '.dst{font-size:11px;font-weight:600;color:#9aa4b2;letter-spacing:.5px;margin-bottom:5px}',
    '.dr{display:flex;align-items:center;gap:6px;margin-bottom:3px}',
    '.ddl{width:52px;font-size:11px;color:#6b7280;flex-shrink:0;text-align:right}',
    '.dbg{flex:1;height:6px;background:#f0f1f3;border-radius:3px;overflow:hidden}',
    '.db{height:100%;border-radius:3px}',
    '.db.match{background:#12a05c}.db.partial{background:#e08b1e}.db.miss{background:#d64545}.db.warn{background:#c257e0}',
    '.db.na{background:repeating-linear-gradient(45deg,#e8eaee,#e8eaee 3px,#f5f6f8 3px,#f5f6f8 6px)}',
    '.dr.na .ddl{color:#b6bcc6}',
    '.dds{width:26px;font-size:11px;font-weight:600;color:#1f2430;flex-shrink:0}',
    '.dds.na{width:auto;font-size:10px;font-weight:400;color:#b6bcc6;white-space:nowrap}',
    '.cv{margin-top:8px;padding:5px 8px;border-radius:4px;font-size:11px;line-height:1.5}',
    '.cv-h{background:#e6f7ed;color:#12a05c}.cv-m{background:#fff5e6;color:#b07815}.cv-l{background:#fff2f2;color:#d64545}',
    '.di{font-size:12px;margin-bottom:2px;padding-left:12px;position:relative}',
    '.di::before{content:"";position:absolute;left:0;top:7px;width:6px;height:6px;border-radius:50%}',
    '.di.m::before{background:#12a05c}.di.g::before{background:#d64545}.di.w::before{background:#e08b1e}',
    '.dsk{display:flex;flex-wrap:wrap;gap:3px}',
    '.dsks{font-size:11px;padding:1px 6px;border-radius:3px}',
    '.dsks.ex{background:#e6f7ed;color:#12a05c}.dsks.sm{background:#fff5e6;color:#b07815}.dsks.bn{background:#e9f0ff;color:#3070d8}.dsks.miss{color:#d64545;font-style:italic}',
    '.dx{background:#fff2f2;border-left:3px solid #d64545;padding:7px 9px;border-radius:4px;margin-bottom:7px}',
    '.dxt{font-size:13px;font-weight:700;color:#d64545;margin-bottom:3px}',
    '.dxr{font-size:12px;color:#d64545}',
    '.menu{position:absolute;top:0;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);padding:6px 0;z-index:1000;width:200px;max-height:280px;overflow-y:auto;font-size:12px;pointer-events:auto}',
    '.menu::-webkit-scrollbar{width:4px}.menu::-webkit-scrollbar-thumb{background:#ccc;border-radius:2px}',
    '.mi{padding:6px 12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:auto}',
    '.mi:hover{background:#f5f6f8}',
    '.mi.active{background:#e6f7ed;color:#12a05c;font-weight:600}',
    '.mi.auto::after{content:"自动";float:right;font-size:10px;color:#4a9eff;font-weight:400}',
    '.msep{height:1px;background:#eee;margin:4px 0}',
    '.mfoot{padding:6px 12px;color:#6b7280;font-size:11px;pointer-events:auto}',
  ].join('');

  // ---- DOM 工具 ----
  function textOf(root, sel) { var el = root.querySelector(sel); return el ? (el.textContent || '').trim() : ''; }
  function parseYrs(t) {
    if (!t) return undefined;
    if (/应届|在校|无经验|应届生/.test(t)) return 0;
    var m = t.match(/(\d+)\s*年/);
    if (!m) return undefined;
    var y = parseInt(m[1], 10);
    // 范围护栏（parseAge 早就有，这里漏了）：base-info 里出现「2026年毕业」这类文案时，
    // 没护栏会解析成 2026 年工作经验，展示成「2026年，超出要求较多」。
    return y >= 0 && y <= 50 ? y : undefined;
  }
  // 卡片 base-info 里通常有"25岁"。引擎的年龄维度拿不到 c.age 就会整个弃权，
  // 而这个数就摆在卡片上，白白丢掉可惜。
  function parseAge(t) {
    if (!t) return undefined;
    var m = t.match(/(\d{2})\s*岁/);
    if (!m) return undefined;
    var a = parseInt(m[1], 10);
    return a >= 16 && a <= 70 ? a : undefined;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // 把宿主摆到「打招呼」按钮正下方（坐标相对卡片计算）。
  // 找不到按钮（搜索页形态不同 / BOSS 改版）就保持右上角，绝不因此丢徽章。
  // 纯读 + 只改我们自己那个 span 的 style，不碰 BOSS 的任何节点。
  function placeHost(li, host) {
    var greet = null;
    try { greet = li.querySelector(GREET_SEL); } catch (e) { greet = null; }
    if (!greet) return;
    try {
      var lr = li.getBoundingClientRect();
      var gr = greet.getBoundingClientRect();
      if (!gr.width && !gr.height) return;          // 按钮不可见（折叠/未渲染）→ 维持默认位置
      host.style.left = Math.round(gr.left - lr.left + gr.width / 2) + 'px';
      host.style.top = Math.round(gr.bottom - lr.top + 6) + 'px';
      host.style.right = 'auto';
      host.style.transform = 'translateX(-50%)';    // 与按钮居中对齐
    } catch (e) { /* 量不到就维持默认位置 */ }
  }

  // 卡片布局可能变化（展开标签、窗口缩放、虚拟列表回收后复用）→ 周期性校一次坐标。
  // 只对当前在册的卡片做几次 getBoundingClientRect，开销可忽略。
  function repositionAll() {
    try {
      var cards = findCards();
      for (var i = 0; i < cards.length; i++) {
        var h = hostForCard.get(cards[i]);
        if (h && cards[i].contains(h)) placeHost(cards[i], h);
      }
    } catch (e) { /* ignore */ }
  }

  // ---- 卡片宿主管理 ----
  function ensureHost(li) {
    var host = hostForCard.get(li);
    var root = rootForCard.get(li);
    // 宿主还在这张卡的子树里、shadow root 也还在 → 直接复用。
    // 判据必须是 li.contains(host) 而不是 host.parentNode === li：
    // 徽章现在挂在「打招呼」按钮的容器里，父节点不是 li 本身了。
    if (host && root && li.contains(host)) return host;
    if (host) {
      try { if (host.parentNode) host.parentNode.removeChild(host); } catch (e) { /* ignore */ }
      hostForCard.delete(li); rootForCard.delete(li);
    }
    host = document.createElement('span');

    // ── 徽章位置：视觉上落在「打招呼」按钮正下方，但【不插进 BOSS 的组件树】 ──────
    //
    // 用户要求分数贴着决策按钮（看人时视线本来就在打招呼上），但实现方式很关键：
    // 上一版把宿主 insertBefore 到打招呼按钮的兄弟位置，也就是插进了 BOSS 自己
    // Vue 管理的子节点序列中间。那是两个隐患：
    //   · 稳定性——Vue 重渲染按 vnode 列表 patch，插在中间的陌生节点最容易被清掉/错位，
    //     表现为徽章一会儿在一会儿没；
    //   · 风险——在别人的组件树内部动结构，是最有可能干扰到页面自身行为的做法。
    // 现在改为：宿主永远【追加为卡片的最后一个子节点】（最安全的位置，Vue 的 patch
    // 不会去动它后面的尾巴），再用绝对定位把它摆到打招呼按钮下方的坐标上。
    // 视觉效果完全一致，但对 BOSS 的 DOM 只做"末尾追加"这一件最轻的事。
    host.style.cssText = 'position:absolute;z-index:20;pointer-events:none;display:block;top:8px;right:8px;';
    try { var cs = window.getComputedStyle(li); if (cs.position === 'static') li.style.position = 'relative'; } catch (e) { /* ignore */ }
    li.appendChild(host);
    placeHost(li, host);

    var sr;
    try { sr = host.attachShadow({ mode: 'closed' }); } catch (e) {
      try { sr = host.attachShadow({ mode: 'open' }); } catch (e2) {
        try { li.removeChild(host); } catch (e3) { /* ignore */ }
        return null;
      }
    }
    try { var sheet = new CSSStyleSheet(); sheet.replaceSync(SHADOW_CSS); sr.adoptedStyleSheets = [sheet]; } catch (e) {
      var st = document.createElement('style'); st.textContent = SHADOW_CSS; sr.appendChild(st);
    }
    var wrap = document.createElement('div');
    wrap.className = 'hw'; wrap.style.position = 'relative'; wrap.style.display = 'inline-block';
    sr.appendChild(wrap);

    // C(hover): 延迟隐藏 + 详情窗接管 hover。
    // 根因：详情窗 .dc 定位在 right: calc(100% + 10px)，和徽章之间有 10px 物理间隙，
    // 鼠标穿过间隙时离开 wrap → 原 mouseleave 立即隐藏，移不到详情窗上。
    // 修法：mouseleave 起 250ms 定时器；鼠标进入详情窗时取消；离开详情窗时重新计时；
    // 不改定位/布局（C 明确要求），也不做"点击钉住"。
    // 监听只在 buildHost 里挂 wrap 这一对（renderBadge 不挂 wrap 监听，避免累加）。
    // 详情窗本身的 enter/leave 监听在 renderBadge 创建 dc 后挂在【新 dc】上——
    // 因为每次 renderBadge 先 wrap.innerHTML='' 清掉旧 dc，新 dc 是全新节点，挂一次不会累加。
    function showDc() {
      if (sr.__taHideTimer) { clearTimeout(sr.__taHideTimer); sr.__taHideTimer = null; }
      if (openMenu && openMenu.root === sr) return;   // 菜单开着时不弹详情，避免叠一起
      var dc = sr.querySelector('.dc'); var b = sr.querySelector('.b');
      if (!dc || !b) return;
      dc.style.display = 'block';
      positionCard(b, dc);
    }
    function scheduleHide() {
      if (sr.__taHideTimer) clearTimeout(sr.__taHideTimer);
      sr.__taHideTimer = setTimeout(function () {
        sr.__taHideTimer = null;
        var dc = sr.querySelector('.dc');
        if (dc) dc.style.display = 'none';
      }, 250);
    }
    wrap.addEventListener('mouseenter', showDc);
    wrap.addEventListener('mouseleave', function (e) {
      // 如果鼠标去的是本 shadow 内的 .dc（即从徽章移入详情窗），不隐藏。
      // relatedTarget 在 shadow DOM 里可能被 retarget 到 host，双重判定稳妥些：
      // 1) relatedTarget 是 .dc 本身或其子孙（影子 DOM 内场景）；
      // 2) 若 retarget 成了 host（shadow 边界），保守起见不立刻隐藏——依赖 dc 的
      //    mouseenter 会取消定时器；若 250ms 内没进入 dc，定时器到期自然隐藏。
      var rt = e && e.relatedTarget;
      if (rt) {
        var dc = sr.querySelector('.dc');
        if (dc && (rt === dc || (dc.contains && dc.contains(rt)))) return;
      }
      scheduleHide();
    });
    // 导出给 renderBadge 用（仅在文件内可见）
    sr.__taShowDc = showDc;
    sr.__taScheduleHide = scheduleHide;

    hostForCard.set(li, host);
    rootForCard.set(li, sr);
    return host;
  }

  function rootOf(li) { return rootForCard.get(li) || null; }

  function cardKey(li) {
    var inner = li.querySelector('.card-inner[data-geekid]');
    var gid = inner && inner.getAttribute('data-geekid');
    if (gid) return gid;
    var n = textOf(li, '.name,[class*="geek-name"]');
    var p = textOf(li, '.expect-wrap .content,[class*="expect"] [class*="content"]');
    var c = textOf(li, '[class*="company"]');
    return (n + '|' + p + '|' + c).trim();
  }

  // ---- 候选人提取（只读卡片上已经渲染出来的文本）----
  function extractCand(li) {
    var chips = Array.prototype.slice.call(li.querySelectorAll('.base-info span,.base-info em,[class*="base-info"] span')).map(function (e) { return (e.textContent || '').trim(); }).filter(Boolean);
    var joined = chips.join(' ');
    var degree = '', dm = joined.match(/(博士|硕士|本科|大专|中专|高中)/); if (dm) degree = dm[1];
    var years; for (var i = 0; i < chips.length; i++) { var y = parseYrs(chips[i]); if (y != null) { years = y; break; } }
    var age; for (var ai = 0; ai < chips.length; ai++) { var a = parseAge(chips[ai]); if (a != null) { age = a; break; } }
    if (age == null) age = parseAge(joined);
    var cityEl = li.querySelector('[class*="city"],[class*="location"]'); var city = cityEl ? (cityEl.textContent || '').trim() : '';
    var skills = Array.prototype.slice.call(li.querySelectorAll('.tag-list .tag,[class*="tag-list"] [class*="tag"],[class*="mark-word"],[class*="markWord"]')).map(function (e) { return (e.textContent || '').trim(); }).filter(Boolean);
    var company = textOf(li, '[class*="company"]') || undefined;
    return {
      name: textOf(li, '.name,[class*="geek-name"],[class*="candidate-name"]'),
      position: textOf(li, '.expect-wrap .content,[class*="expect"] [class*="content"],.job-name,[class*="expect-position"]'),
      city: city, degree: degree || undefined, experienceYears: years, age: age,
      salary: textOf(li, '.salary-wrap,[class*="salary"]') || undefined,
      skills: skills, selfIntro: textOf(li, '[class*="geek-desc"],[class*="self-intro"]') || undefined,
      company: company, education: [], workHistory: company ? [{ company: company }] : [], projects: [],
    };
  }

  // ---- JD / 岗位识别 ----
  // 引擎只认 jd.weights，所以给没配权重的 JD 补一层回落，保证「设置页改默认权重」在插件里立刻生效。
  // ⚠️ 只能回落 payload.defaultWeights（纯默认权重），不能用 payload.weights——
  // 后者是「激活 JD 的私有权重 || 默认权重」，拿它去回填别的 JD，会让用户在菜单里
  // 切到岗位 B 时用上岗位 A 的权重，与平台侧算出的分对不上。
  // payload.weights 的回落只为兼容不带 defaultWeights 的旧平台版本。
  function withWeights(jd) {
    if (!jd) return jd;
    if (!jdCache) return jd;
    var dw = jdCache.defaultWeights || (jdCache.defaultWeights === null ? null : jdCache.weights);
    if (jd.weights || !dw) return jd;
    var clone = {};
    for (var k in jd) if (Object.prototype.hasOwnProperty.call(jd, k)) clone[k] = jd[k];
    clone.weights = dw;
    return clone;
  }

  // 一个连 basic 和 keywords 都没有的 JD 是没法评分的：引擎会给所有人打出同一个默认分，
  // 看着正常其实是假分。这种情况必须显式暴露，不能糊过去。
  function isScorable(jd) {
    return !!(jd && (jd.basic || jd.keywords));
  }

  function getActive() {
    if (!jdCache) return null;
    // 选中的就是平台激活的那个 → 用 jdCache.jd（它一定是完整体），不走列表项
    if (jobDetected && jdCache.jd && jobDetected.id === jdCache.jd.id) {
      return { jd: withWeights(jdCache.jd), th: jdCache.thresholds };
    }
    if (jobDetected && jdCache.jdList) {
      for (var i = 0; i < jdCache.jdList.length; i++) {
        if (jdCache.jdList[i].id === jobDetected.id) return { jd: withWeights(jdCache.jdList[i]), th: jdCache.thresholds };
      }
    }
    return jdCache.jd ? { jd: withWeights(jdCache.jd), th: jdCache.thresholds } : null;
  }

  function extractBossJob() {
    var info = { url: location.href, title: document.title || '', jobId: null, kw: '' };
    try {
      var u = new URL(location.href);
      info.jobId = u.searchParams.get('jobId') || u.searchParams.get('encryptJobId') || null;
      info.kw = u.searchParams.get('query') || '';
      var jn = document.querySelector('[class*="job-name"],[class*="position-name"],[class*="job-title"]');
      if (jn) info.domName = (jn.textContent || '').trim();
    } catch (e) { /* ignore */ }
    return info;
  }

  // 平台可能一个岗位都没激活（jd 为 null）却仍有岗位列表——所有取 jdCache.jd.id 的地方都要防空，
  // 否则这里一抛 TypeError，整条「拉 JD → 识别 → 重扫」链路就断了。
  function fallbackJob() {
    var j = jdCache && jdCache.jd;
    return j ? { id: j.id, name: j.name || j.title, conf: 1, auto: false } : null;
  }

  function detectJob() {
    if (!jdCache) { jobDetected = null; return; }
    if (!jdCache.jdList || !jdCache.jdList.length) { jobDetected = fallbackJob(); return; }

    var info = extractBossJob();
    var q = [info.kw, info.domName, info.title].filter(Boolean).join(' ');

    // URL 上带 jobId 且能对上 → 最高优先级，直接命中，不看文本相似度
    if (info.jobId) {
      for (var k = 0; k < jdCache.jdList.length; k++) {
        if (jdCache.jdList[k].bossJobId && jdCache.jdList[k].bossJobId === info.jobId) {
          jobDetected = { id: jdCache.jdList[k].id, name: jdCache.jdList[k].name || jdCache.jdList[k].title, conf: 1, auto: true };
          return;
        }
      }
    }

    if (!q) { jobDetected = fallbackJob(); return; }

    var best = null;
    for (var i = 0; i < jdCache.jdList.length; i++) {
      var jj = jdCache.jdList[i];
      var lbl = ((jj.name || '') + ' ' + (jj.title || '')).trim();
      if (!lbl) continue;
      var sim = _similarity(q, lbl);
      if (!best || sim > best.conf) best = { id: jj.id, name: jj.name || jj.title, conf: sim, auto: true };
    }
    // 置信度不够就不自动切，保持平台激活的那个岗位
    if (!best || best.conf < JD_MENU_CONF) { jobDetected = fallbackJob(); return; }
    jobDetected = best;
  }

  function jdSignature(o) {
    if (!o) return '';
    try {
      return [o.jd ? o.jd.id : '', o.jd ? (o.jd.updatedAt || '') : '', JSON.stringify(o.jdList || null), JSON.stringify(o.weights || null), JSON.stringify(o.thresholds || null)].join('|');
    } catch (e) { return o.jd ? String(o.jd.id) : ''; }
  }

  function applyJd(next) {
    var sig = jdSignature(next);
    var old = jdCache ? jdCache._sig : '';
    jdCache = next;
    if (jdCache) jdCache._sig = sig;
    if (sig === old) return;
    jobDetected = null;
    detectJob();
    scheduleRescan(true);
  }

  function loadJd() {
    try {
      chrome.runtime.sendMessage({ type: 'ta-get-jd' }, function (resp) {
        if (chrome.runtime.lastError) return;
        if (!resp) return;
        try { applyJd(resp); } catch (e) { /* 单次刷新失败不影响后续 */ }
      });
    } catch (e) { /* 扩展上下文失效（重载/更新）时静默 */ }
  }

  // ---- 向平台上报"BOSS 页面开着、这页有多少张卡在评分" ----
  // 平台据此把工具库里的按钮分成两种状态（BOSS 开着 / 没开着）。只发给 background，
  // 由它随本机回环那一次拉取捎带上去——不产生任何新的 zhipin 请求。
  // first=true 表示"这个页面刚开 / 刚切回来"，background 见到它才会立刻去拉一次岗位。
  // 普通心跳不触发拉取——否则 15 秒一次的心跳会把本机同步频率放大好几倍，纯属浪费。
  function reportAlive(first) {
    if (document.hidden) return;   // 后台标签页不算"正在用"
    try {
      chrome.runtime.sendMessage({
        type: 'ta-boss-alive',
        first: !!first,
        // v2.1：用最近一次扫描的真实结果，而不是当场再查一次 CARD_SEL。
        // 脚本现在跑在多个帧里（顶层 + 推荐 iframe），顶层查出来恒为 0，
        // 当场查会让顶层帧不停地把计数覆盖成 0（背景侧另有一道保护，见 background.js）。
        cards: lastCardCount,
        // 页面适应诊断：连续多轮一张卡都选不到，说明 BOSS 的 DOM 变了，
        // 该让用户知道"不是没分，是选择器失效了"，而不是干瞪着空页面猜。
        noCardStreak: noCardStreak,
        sel: CARD_SEL,
        scored: !!(jdCache && jdCache.jd),
      }, function () { if (chrome.runtime.lastError) { /* 忽略无接收方 */ } });
    } catch (e) { /* ignore */ }
  }

  // ---- 详情卡片定位 ----
  // 必须在卡片可见之后再量：display:none 时 offsetWidth/offsetHeight 恒为 0，
  // 之前在渲染时就量，翻转逻辑等于没写。
  function positionCard(badge, dc) {
    dc.style.left = ''; dc.style.right = ''; dc.style.bottom = ''; dc.style.maxHeight = '';
    dc.style.right = 'calc(100% + 10px)';
    dc.style.left = 'auto';
    dc.style.top = '0';
    var br = badge.getBoundingClientRect();
    var cw = dc.offsetWidth || 320;
    var ch = dc.offsetHeight || 0;
    var vh = window.innerHeight;
    if (br.left - cw - 10 < 5) { dc.style.right = 'auto'; dc.style.left = 'calc(100% + 10px)'; }
    if (ch && br.top + ch > vh - 10) {
      var over = br.top + ch - vh + 10;
      if (br.top - over - 5 < 5) { dc.style.top = (5 - br.top) + 'px'; dc.style.maxHeight = (vh - 20) + 'px'; }
      else { dc.style.top = (-over - 5) + 'px'; }
    }
  }

  // ---- 徽章渲染 ----
  var ALLOWED_LEVELS = { high: 1, medium: 1, low: 1, mismatch: 1 };
  var ALLOWED_STATUS = { match: 1, partial: 1, miss: 1, warn: 1 };
  function lvClass(lv) { return lv === 'high' ? 'h' : lv === 'medium' ? 'm' : lv === 'mismatch' ? 'x' : 'l'; }

  function renderBadge(li, r, act) {
    var sr = rootOf(li); if (!sr) return;
    var wrap = sr.querySelector('.hw'); if (!wrap) return;
    // 只关「本卡自己」的菜单。原来无条件 closeMenu()，无限滚动加载新卡触发重渲染时，
    // 会把用户正开在别的卡上的岗位菜单一起关掉。
    if (openMenu && openMenu.root === sr) closeMenu();
    wrap.innerHTML = '';

    var lv = ALLOWED_LEVELS[r.level] ? r.level : 'low';
    var cls = lvClass(lv);

    // 卡片层显示三档判定而非数字分（2026-08-11）：
    // 推荐牛人卡片上只有职位名/公司/学历/年限/技能标签，权重最大的 taskCoverage + domainFit
    // 在这一层双双退出，剩下的全是人人都拿高分的通用维 —— 真机实测一屏全是 85，
    // 「理想候选人」和「空卡片」同分。数字的精确感是假的，改显示 值得看/一般/不匹配。
    // 数字分保留在详情面板（那时是 detail 层，有完整履历，分数才有意义）。
    // 判不出来（unknown=信息不足）也用中性灰样式；badge 上既显示信息不足、又显示数字分，
    // 明确告诉用户"这不是匹配分"，避免把 60 读成通过。detail 层证据不足时 cardVerdict 也置 unknown。
    var isUnknown = r.cardVerdict === 'unknown';
    var isCard = r.tier === 'card' && r.cardVerdictLabel;
    var badge = document.createElement('div');
    badge.className = 'b b-' + (isUnknown ? 'l' : cls) + (isCard ? ' b-verdict' : '');
    badge.textContent = r.mismatch ? '岗位不符'
      : (r.cardVerdictLabel ? r.cardVerdictLabel : String(r.total));
    var badgTitle = [];
    if (isUnknown) {
      badgTitle.push('信息不足：可判的岗位专属维度太少，无法下结论');
      if (r.tier === 'card') badgTitle.push('打开详情后可补全信息重判');
    }
    var tt = badgTitle.slice();
    if (isCard) tt.push('卡片信息有限，只给三档判断；打开详情后出具体分数');
    if (isCard) tt.push('信息覆盖度 ' + r.coverage + '%');
    if (act) tt.push('评分岗位：' + (act.jd.name || act.jd.title || ''));
    tt.push(jobDetected && jobDetected.auto ? '（自动识别，点击切换）' : '（点击切换岗位）');
    badge.title = tt.join('\n');
    wrap.appendChild(badge);

    var isAuto = !!(jobDetected && jobDetected.auto && act && act.jd.id === jobDetected.id);
    if (isAuto) {
      var dot = document.createElement('div');
      dot.className = 'auto-dot';
      dot.title = '自动识别 · 置信度 ' + Math.round((jobDetected.conf || 0) * 100) + '%';
      badge.appendChild(dot);
    }

    var dc = document.createElement('div');
    dc.className = 'dc';
    var h = '';
    h += '<div class="dh">';
    // 同上：卡片层展开的详情卡也不给数字，改三档 + 覆盖度说明。
    // 判不出来（unknown=信息不足）时 ds 用中性灰样式、dg 显示「待核」。
    h += '<div class="ds ' + (isUnknown ? 'l' : cls) + (isCard ? " ds-verdict" : "") + '">'
      + (r.mismatch ? '!' : (r.cardVerdictLabel ? esc(r.cardVerdictLabel) : r.total)) + '</div>';
    h += '<div class="dg ' + (isUnknown ? 'l' : cls) + '">'
      + (r.mismatch ? '不符' : isUnknown ? '待核' : isCard ? ('覆盖 ' + r.coverage + '%') : (lv === 'high' ? 'A' : lv === 'medium' ? 'B' : 'C')) + '</div>';
    var jn = act ? esc(act.jd.name || act.jd.title || '') : '';
    var autoMark = isAuto ? ' <span style="color:#4a9eff;font-size:10px">自动 ' + Math.round((jobDetected.conf || 0) * 100) + '%</span>' : '';
    h += '<div class="dt">' + jn + autoMark + '</div>';
    h += '</div>';

    if (r.mismatch && r.mismatchReasons && r.mismatchReasons.length) {
      h += '<div class="dx"><div class="dxt">⚠ 岗位不符</div>';
      for (var ri = 0; ri < r.mismatchReasons.length; ri++) {
        h += '<div class="dxr">· ' + esc(r.mismatchReasons[ri].label) + '：' + esc(r.mismatchReasons[ri].detail) + '</div>';
      }
      h += '</div>';
    }

    // 岗位数据是否已经陈旧。插件在平台关闭时会拿上次缓存继续打分——这本身是对的
    // （否则平台一关就全线不出分），但页面上此前【没有任何提示】：用户以为看的是最新
    // 岗位要求，实际可能是几天前的。改过 JD 却没开平台时，分是错的而人不知道。
    // 只在明确超过阈值时提示，不打扰正常使用。
    var staleMs = jdCache && jdCache.fetchedAt ? (Date.now() - jdCache.fetchedAt) : 0;
    var offline = !!(jdCache && jdCache.online === false);
    if (offline && staleMs > 30 * 60 * 1000) {
      var hrs = Math.floor(staleMs / 3600000);
      var ago = hrs >= 24 ? (Math.floor(hrs / 24) + ' 天前') : (hrs >= 1 ? (hrs + ' 小时前') : '30 分钟前');
      h += '<div class="cv cv-l">⚠ 岗位数据来自 ' + ago + '（TA 平台未运行）'
        + '<br/>若期间改过岗位要求，这个分不准，请打开平台后刷新页面</div>';
    }

    // 覆盖度：这个分到底基于多少信息。插件只读卡片上已渲染的文本，很多维度天然判不了，
    // 不告诉用户的话，"覆盖度 30% 的 79 分"和"90% 的 79 分"在界面上长得一模一样。
    if (typeof r.coverage === 'number') {
      var cvCls = r.coverage >= 70 ? 'cv-h' : r.coverage >= 40 ? 'cv-m' : 'cv-l';
      h += '<div class="cv ' + cvCls + '">数据覆盖度 ' + r.coverage + '%'
        + (r.coverage < 40 ? '（信息太少，这个分只能当粗筛参考）' : '')
        + '</div>';
    }

    h += '<div class="dsec"><div class="dst">维度分析</div>';
    for (var i = 0; i < r.details.length; i++) {
      var d = r.details[i];
      var sc = Math.max(0, Math.min(100, Math.round(d.score)));
      var st = ALLOWED_STATUS[d.status] ? d.status : 'partial';
      // available:false 的维度已被引擎踢出加权，它压根没算进总分——
      // 照常画成一根正常的条会让人以为它参与了计分，必须标出来。
      var na = d.available === false;
      // 两种「退出加权」含义完全不同，不能都写「无数据」：
      //   notApplicable = JD 压根没提这个要求（没设年龄区间、没配行业偏好、没写职责）
      //   仅 available:false = 候选人侧确实没采集到数据
      // 混为一谈会让人以为是候选人资料不全，实际是岗位没提要求——引擎特意区分了，UI 要接住。
      var naText = d.notApplicable ? 'JD未设' : '无数据';
      h += '<div class="dr' + (na ? ' na' : '') + '"><div class="ddl">' + esc(d.label) + '</div>';
      if (na) {
        h += '<div class="dbg"><div class="db na" style="width:100%"></div></div><div class="dds na">' + naText + '</div>';
      } else {
        h += '<div class="dbg"><div class="db ' + st + '" style="width:' + sc + '%"></div></div><div class="dds">' + sc + '</div>';
      }
      h += '</div>';
    }
    h += '</div>';

    if (r.highlights && r.highlights.length) {
      h += '<div class="dsec"><div class="dst">✓ 匹配亮点</div>';
      for (var hi = 0; hi < r.highlights.length; hi++) h += '<div class="di m">' + esc(r.highlights[hi].label) + '：' + esc(r.highlights[hi].note) + '</div>';
      h += '</div>';
    }
    if (r.gaps && r.gaps.length) {
      h += '<div class="dsec"><div class="dst">✗ 差距提示</div>';
      for (var gi = 0; gi < r.gaps.length; gi++) h += '<div class="di g">' + esc(r.gaps[gi].label) + '：' + esc(r.gaps[gi].note) + '</div>';
      h += '</div>';
    }
    if (r.skills) {
      var sk = r.skills;
      h += '<div class="dsec"><div class="dst">技能</div><div class="dsk">';
      for (var e = 0; e < (sk.exact || []).length; e++) h += '<span class="dsks ex">✓ ' + esc(sk.exact[e]) + '</span>';
      for (var sm = 0; sm < (sk.semantic || []).length; sm++) h += '<span class="dsks sm">≈ ' + esc(sk.semantic[sm]) + '</span>';
      for (var bn = 0; bn < (sk.bonus || []).length; bn++) h += '<span class="dsks bn">★ ' + esc(sk.bonus[bn]) + '</span>';
      if (sk.missingCount > 0) h += '<span class="dsks miss">缺 ' + sk.missingCount + ' 项</span>';
      h += '</div></div>';
    }
    dc.innerHTML = h;
    wrap.appendChild(dc);

    // hover：详情窗自身的 enter/leave 监听。
    // 注意：这里挂在 dc 上而非 wrap 上，所以和 ensureHost 里的 wrap 监听不重复。
    // 每次 renderBadge 都先 wrap.innerHTML='' 清掉旧 dc，新 dc 是全新节点，
    // 这两个监听器只绑一次，不会累加（wrap 上的才会有累加问题）。
    dc.addEventListener('mouseenter', function () {
      if (sr.__taShowDc) sr.__taShowDc();
    });
    dc.addEventListener('mouseleave', function () {
      if (sr.__taScheduleHide) sr.__taScheduleHide();
    });
    badge.addEventListener('click', function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      dc.style.display = 'none';
      toggleJdMenu(sr, wrap, badge);
    });
  }

  function renderIdle(li, why) {
    var sr = rootOf(li); if (!sr) return;
    var wrap = sr.querySelector('.hw'); if (!wrap) return;
    closeMenu();
    wrap.innerHTML = '';
    var b = document.createElement('div');
    b.className = 'b b-i'; b.textContent = '—'; b.title = why || '';
    wrap.appendChild(b);
  }

  // ---- JD 切换菜单 ----
  // 同一时刻只允许一个菜单存在，用一个模块级引用记住它。
  // （不能靠扫 DOM 找：宿主是 closed shadow，外部拿不到它的 shadowRoot。）
  function closeMenu() {
    if (!openMenu) return;
    try { if (openMenu.el && openMenu.el.parentNode) openMenu.el.parentNode.removeChild(openMenu.el); } catch (e) { /* ignore */ }
    openMenu = null;
  }

  // 真实点击是 composed 事件：从 closed shadow 里穿出来时 target 会被重定向成宿主 span。
  // 点在开着菜单那张卡的宿主上（徽章、菜单项都算）必须放行——这个捕获监听在 document 上，
  // 先于 shadow 内部的监听执行，这里若直接关菜单，徽章的 toggle 就会看到"没菜单"又开一个，
  // 结果是菜单永远关不上。放行后由内部各自处理：徽章负责开关、菜单项负责选完即关。
  function onDocClickCloseMenu(ev) {
    if (openMenu && ev && ev.target === openMenu.host) return;
    closeMenu();
    document.removeEventListener('click', onDocClickCloseMenu, true);
  }

  function toggleJdMenu(sr, wrap, anchor) {
    if (openMenu && openMenu.root === sr) { closeMenu(); return; }
    closeMenu();
    if (!jdCache || !jdCache.jdList || !jdCache.jdList.length) return;

    var menu = document.createElement('div');
    menu.className = 'menu';
    var curId = jobDetected ? jobDetected.id : (jdCache.jd ? jdCache.jd.id : null);
    for (var i = 0; i < jdCache.jdList.length; i++) {
      var jj = jdCache.jdList[i];
      var mi = document.createElement('div');
      mi.className = 'mi' + (jj.id === curId ? ' active' : '') + ((jobDetected && jobDetected.id === jj.id && jobDetected.auto) ? ' auto' : '');
      mi.textContent = jj.name || jj.title || '(未命名)';
      mi.title = jj.title || '';
      (function (jid) {
        mi.addEventListener('click', function (ev) {
          ev.stopPropagation(); ev.preventDefault();
          for (var k = 0; k < jdCache.jdList.length; k++) {
            if (jdCache.jdList[k].id === jid) {
              jobDetected = { id: jid, name: jdCache.jdList[k].name || jdCache.jdList[k].title, conf: 1, auto: false };
              break;
            }
          }
          closeMenu();
          scheduleRescan(true);
        });
      })(jj.id);
      menu.appendChild(mi);
    }
    var sep = document.createElement('div'); sep.className = 'msep'; menu.appendChild(sep);
    var foot = document.createElement('div'); foot.className = 'mfoot';
    foot.textContent = '岗位在 TA 平台「岗位库」里管理';
    menu.appendChild(foot);

    wrap.appendChild(menu);
    openMenu = { root: sr, el: menu, host: sr.host };

    menu.style.right = 'calc(100% + 10px)';
    menu.style.left = 'auto';
    var br = anchor.getBoundingClientRect();
    var mw = menu.offsetWidth || 200;
    var mh = menu.offsetHeight || 0;
    if (br.left - mw - 10 < 5) { menu.style.right = 'auto'; menu.style.left = 'calc(100% + 10px)'; }
    if (mh && br.top + mh > window.innerHeight - 10) {
      var over = br.top + mh - window.innerHeight + 10;
      menu.style.top = (-over - 5) + 'px';
    }

    // 下一轮事件循环再挂全局监听，否则本次 click 冒泡上去会立刻把菜单关掉
    setTimeout(function () { document.addEventListener('click', onDocClickCloseMenu, true); }, 0);
  }

  // ---- 评分 ----
  function scoreCard(li, force) {
    var key = cardKey(li);
    if (!key) return;
    if (!force && scoredMap.get(li) === key) return;
    if (!ensureHost(li)) return;

    var act = getActive();
    if (!act || !act.jd) {
      renderIdle(li, '尚未激活岗位：请打开 TA 平台，在「岗位库」里激活一个岗位');
      scoredMap.set(li, key);
      return;
    }
    if (!isScorable(act.jd)) {
      renderIdle(li, '岗位「' + (act.jd.name || act.jd.title || '') + '」没填要求（学历/年限/关键词），无法评分');
      scoredMap.set(li, key);
      return;
    }
    var c;
    try { c = extractCand(li); } catch (e) { return; }
    if (!c.name && !c.position) return;   // 卡片还没渲染完，下一轮再来
    try {
      // P1-24：透传 act.jd.weightTemplate，避免只有 weightTemplate 没有 weights 时回落到 default
      var cardOpts = { tier: 'card' };
      if (act.jd && act.jd.weightTemplate && !act.jd.weights) cardOpts.weightTemplate = act.jd.weightTemplate;
      var r = TA_ENGINE.scoreCandidate(c, act.jd, act.th || {}, cardOpts);
      renderBadge(li, r, act);
      // 记下卡片级结果：用户点开详情后，第二级评分要在这个分的基础上接力，
      // 而不是抛开卡片信息重算一遍（详情页未必重复列出卡片上的期望薪资/城市等）。
      cardScoreById[key] = { c: c, r: r };
      // 同步进跨帧缓存：详情面板若渲染在别的帧，靠它接力（见 CARD_CACHE_KEY 说明）
      cardCacheDirty[key] = { c: c, t: r.total, at: Date.now() };
      scoredMap.set(li, key);
    } catch (e) {
      // 单卡评分失败：标记为 idle 并记住 key，避免每轮重复炸同一张卡
      try { renderIdle(li, '评分失败'); } catch (e2) { /* ignore */ }
      scoredMap.set(li, key);
    }
  }

  // ==========================================================================
  // 第二级评分：用户点开详情页之后的实时增强
  // ==========================================================================
  // 设计口径（用户明确要求的两套机制）：
  //   第一套 = 只看卡片上那点信息（期望职位/城市/学历/年限/薪资/技能标签）出分，
  //            零点击、零请求，用来快速筛掉明显不合适的人；
  //   第二套 = 用户【自己点开】详情页之后，把简历里多出来的信息（工作经历正文、项目、
  //            自我描述、完整技能）叠加到第一套的候选人档案上重算，给出"深度分"。
  //
  // 三条硬约束：
  //   1) 接力而非重来——详情页未必重复列出期望薪资/城市，抛开卡片信息重算会平白丢维度；
  //   2) 信息没真的变多就【不出深度分】——否则"深度分"只是同一个数换个名字，是假精度；
  //   3) 全程只读用户已经打开的页面，不发任何请求、不替用户点任何东西。
  var DETAIL_SELS = [
    '[class*="resume-detail"]', '[class*="geek-detail"]', '[class*="candidate-detail"]',
    '[class*="resume-box"]', '[class*="geek-info-detail"]', '.detail-wrap', '[class*="detail-content"]',
  ];
  // ── 内容签名探测（v3）────────────────────────────────────────────────────
  // 真机核查（2026-07-29）：上面 7 条类名选择器没有一条有真机依据（跨平台复制的猜测），
  // 这正是"点开详情不出深度分"的根因之一。类名会改版，但一份简历详情【必然】带
  // "工作经历/项目经历/教育经历…"这些小节标题——按内容找容器，比按类名猜可靠得多：
  // 找到 ≥2 个【不同】小节标题 → 取它们的共同祖先 → 向上收敛到有实际高度的面板。
  var DETAIL_MARKERS = ['工作经历', '项目经历', '教育经历', '个人优势', '自我描述', '自我评价', '资格证书', '求职期望', '期望职位'];
  function findDetailRootBySignature() {
    var els;
    try { els = document.querySelectorAll('h1,h2,h3,h4,h5,dt,[class*="title"],[class*="Title"],[class*="label"],[class*="header"]'); } catch (e) { return null; }
    var hits = [];
    var seenMarker = {};
    var lim = Math.min(els.length, 500);
    for (var i = 0; i < lim && hits.length < 8; i++) {
      var t = (els[i].textContent || '').trim();
      if (!t || t.length > 8) continue;
      // 列表卡片里的"未填写工作经历"等碎片不算：跳过卡片内部的一切命中
      try { if (els[i].closest && els[i].closest('li.card-item,[class*="card-item"]')) continue; } catch (e2) { /* ignore */ }
      for (var m = 0; m < DETAIL_MARKERS.length; m++) {
        if (t.indexOf(DETAIL_MARKERS[m]) === 0 && !seenMarker[m]) {
          seenMarker[m] = 1;
          hits.push(els[i]);
          break;
        }
      }
    }
    if (hits.length < 2) return null;               // 至少两个不同小节标题才算简历详情
    var root = hits[0];
    for (var h = 1; h < hits.length && root; h++) {
      while (root && !root.contains(hits[h])) root = root.parentElement;
    }
    while (root && root !== document.body && root.offsetHeight < 300) root = root.parentElement;
    if (!root || root === document.documentElement) return null;
    if (root.offsetHeight <= 300) return null;
    // 防呆：收敛到的容器若包着一排候选人卡片，说明找到的是列表页本身，不是详情
    try { if (root.querySelectorAll('li.card-item').length > 1) return null; } catch (e3) { /* ignore */ }
    return root;
  }
  function findDetailRoot() {
    for (var i = 0; i < DETAIL_SELS.length; i++) {
      var el;
      try { el = document.querySelector(DETAIL_SELS[i]); } catch (e) { continue; }
      // 必须是真的展开着的（有高度），否则 BOSS 常驻的空壳容器会被误当成"详情已打开"
      if (el && el.offsetHeight > 120) return el;
    }
    // 类名全部落空 → 按内容签名找（BOSS 改版 / 类名与预设不符时的兜底主力）
    return findDetailRootBySignature();
  }
  function detailGeekId(root) {
    var n = root.querySelector('[data-geekid]');
    var gid = n && n.getAttribute('data-geekid');
    if (gid) return gid;
    if (root.getAttribute && root.getAttribute('data-geekid')) return root.getAttribute('data-geekid');
    // 退而求其次：列表里高亮/选中的那张卡
    var act = document.querySelector('li.card-item.active, li.card-item.selected, li[class*="card-item"][class*="active"]');
    if (act) { var inner = act.querySelector('.card-inner[data-geekid]'); if (inner) return inner.getAttribute('data-geekid'); }
    var m = location.href.match(/geekid=([A-Za-z0-9~_-]+)/i);
    return m ? m[1] : '';
  }
  // 从详情面板里捞卡片上没有的那部分信息。选择器写得宽，捞不到就返回空——
  // 捞不到不是错误，只意味着"这次不出深度分"。
  function extractDetailExtra(root) {
    function pick(sel) {
      var out = [];
      try {
        var els = root.querySelectorAll(sel);
        for (var i = 0; i < els.length; i++) {
          var t = (els[i].textContent || '').trim();
          if (t) out.push(t);
        }
      } catch (e) { /* ignore */ }
      return out;
    }
    var workBlocks = [];
    try {
      var items = root.querySelectorAll('[class*="work-exp"] li, [class*="workExp"] li, [class*="work-exp"] [class*="item"], [class*="experience"] [class*="item"]');
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var company = (el.querySelector('[class*="company"], h3, strong') || {}).textContent || '';
        var pos = (el.querySelector('[class*="position"], [class*="job"], [class*="title"]') || {}).textContent || '';
        var desc = (el.querySelector('[class*="desc"], [class*="content"], p') || {}).textContent || '';
        if (company || pos || desc) {
          workBlocks.push({ company: company.trim(), position: pos.trim(), description: desc.trim() });
        }
      }
    } catch (e) { /* ignore */ }
    var projects = [];
    try {
      var pj = root.querySelectorAll('[class*="project"] li, [class*="project"] [class*="item"]');
      for (var p = 0; p < pj.length; p++) {
        var pe = pj[p];
        var nm = (pe.querySelector('[class*="name"], h3, strong') || {}).textContent || '';
        var pd = (pe.querySelector('[class*="desc"], [class*="content"], p') || {}).textContent || '';
        if (nm || pd) projects.push({ name: nm.trim(), desc: pd.trim() });
      }
    } catch (e) { /* ignore */ }
    var edus = [];
    try {
      var ed = root.querySelectorAll('[class*="edu"] li, [class*="education"] [class*="item"]');
      for (var q = 0; q < ed.length; q++) {
        var ee = ed[q];
        var school = (ee.querySelector('[class*="school"], h3, strong') || {}).textContent || '';
        var major = (ee.querySelector('[class*="major"], [class*="content"]') || {}).textContent || '';
        if (school || major) edus.push({ school: school.trim(), major: major.trim() });
      }
    } catch (e) { /* ignore */ }
    var skills = pick('[class*="skill"] [class*="tag"], [class*="tag-list"] [class*="tag"], [class*="mark-word"]');
    var intro = pick('[class*="self-intro"], [class*="geek-desc"], [class*="advantage"], [class*="resume-desc"]').join(' ');
    // 结构化选择器全部落空（真机类名与预设不符）→ 整块文本兜底：把详情面板的可见
    // 文本直接喂给引擎的关键词/语义维。粒度粗，但"有真实简历文本"远好于"什么都没有"。
    if (!workBlocks.length && !projects.length && !edus.length && !skills.length && !intro) {
      try {
        var blob = (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
        if (blob.length > 200) intro = blob.slice(0, 8000);
      } catch (e) { /* ignore */ }
    }
    return {
      workHistory: workBlocks,
      projects: projects,
      education: edus,
      skills: skills,
      selfIntro: intro,
    };
  }
  // 详情信息是否"真的比卡片多"。不满足就不出深度分——同一个数换个名字叫深度分是假精度。
  function detailAddsInfo(base, extra) {
    if (extra.projects.length) return true;
    if (extra.education.length > (base.education || []).length) return true;
    if ((extra.selfIntro || '').length > 30 && (extra.selfIntro || '').length > (base.selfIntro || '').length) return true;
    if (extra.skills.length > (base.skills || []).length) return true;
    for (var i = 0; i < extra.workHistory.length; i++) {
      if ((extra.workHistory[i].description || '').length > 20) return true;
    }
    return extra.workHistory.length > (base.workHistory || []).length;
  }
  function ensureDetailHost(root) {
    if (detailHost && detailRoot && root.contains(detailHost)) return detailHost;
    if (detailHost) { try { if (detailHost.parentNode) detailHost.parentNode.removeChild(detailHost); } catch (e) { /* ignore */ } }
    // 与卡片徽章同一口径：只做"末尾追加"，再用绝对定位摆到打招呼按钮下方，
    // 绝不插进 BOSS 组件树的兄弟序列中间（理由见 ensureHost 的说明）。
    detailHost = document.createElement('span');
    detailHost.style.cssText = 'position:absolute;top:12px;right:12px;pointer-events:none;z-index:30;display:block;';
    try { if (window.getComputedStyle(root).position === 'static') root.style.position = 'relative'; } catch (e) { /* ignore */ }
    root.appendChild(detailHost);
    placeHost(root, detailHost);
    try { detailRoot = detailHost.attachShadow({ mode: 'closed' }); } catch (e) {
      try { detailRoot = detailHost.attachShadow({ mode: 'open' }); } catch (e2) { detailHost = null; detailRoot = null; return null; }
    }
    var st = document.createElement('style'); st.textContent = SHADOW_CSS + DETAIL_CSS;
    detailRoot.appendChild(st);
    return detailHost;
  }
  var DETAIL_CSS = [
    '.dp{display:inline-block;padding:6px 10px;border-radius:10px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.16);',
    'font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;pointer-events:auto;text-align:left}',
    '.dp .t{font-size:10px;color:#9aa4b2;letter-spacing:.5px;margin-bottom:2px}',
    '.dp .v{font-size:22px;font-weight:800;line-height:1}',
    '.dp .v.h{color:#12a05c}.dp .v.m{color:#e08b1e}.dp .v.l{color:#9aa4b2}.dp .v.x{color:#d64545}',
    '.dp .d{font-size:11px;color:#6b7280;margin-top:3px;white-space:nowrap}',
    '.dp .up{color:#12a05c;font-weight:700}.dp .dn{color:#d64545;font-weight:700}',
  ].join('');

  function scoreDetail() {
    var root = findDetailRoot();
    if (!root) {
      // 详情关掉了 → 收掉深度分徽章，避免它挂在列表上误导
      if (detailHost) {
        try { if (detailHost.parentNode) detailHost.parentNode.removeChild(detailHost); } catch (e) { /* ignore */ }
        detailHost = null; detailRoot = null; detailKey = ''; detailOwnerGid = '';
      }
      return;
    }
    var gid = detailGeekId(root);
    // ⚠️ 归属校验必须排在所有 return 之前（审查 2026-07-29）。
    // scoreDetail 有四处提前 return（没激活岗位 / 岗位没填要求 / 详情信息没变多 / 求值失败），
    // 它们都不动已经渲染出来的 .dp。于是用户从候选人 A 的详情切到 B：
    // 只要 B 命中任一 return，A 的"深度分 88 · 已读详情"就原样悬在 B 的打招呼按钮上方。
    // 这是会直接误导人工写操作的错配——宁可没有分，也不能挂错人的分。
    if (detailHost && detailOwnerGid && gid && detailOwnerGid !== gid) {
      var stale = detailRoot && detailRoot.querySelector('.dp');
      if (stale) { try { stale.parentNode.removeChild(stale); } catch (e) { /* ignore */ } }
      detailKey = '';
    }
    var act = getActive();
    if (!act || !act.jd || !isScorable(act.jd)) return;
    // 卡片级底子：先看本帧内存，再看跨帧镜像（详情渲染在另一个帧时靠它接力）
    var mem = gid && cardScoreById[gid] ? cardScoreById[gid] : null;
    var mirror = !mem && gid && cardCacheMirror[gid] ? cardCacheMirror[gid] : null;
    var base = mem ? mem.c : (mirror ? mirror.c : null);
    // 没有卡片级底子也能算（用户可能直接从别处进详情），只是没得接力
    if (!base) base = { skills: [], workHistory: [], education: [], projects: [] };

    var extra;
    try { extra = extractDetailExtra(root); } catch (e) { return; }
    if (!detailAddsInfo(base, extra)) return;   // 信息没变多 → 不出深度分（不制造假精度）

    // 合并：卡片信息打底，详情信息叠加（数组合并去重，标量只在详情更长时覆盖）
    var merged = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) merged[k] = base[k];
    merged.workHistory = (base.workHistory || []).concat(extra.workHistory);
    merged.projects = (base.projects || []).concat(extra.projects);
    merged.education = (base.education || []).concat(extra.education);
    var sk = (base.skills || []).slice();
    for (var s = 0; s < extra.skills.length; s++) if (sk.indexOf(extra.skills[s]) === -1) sk.push(extra.skills[s]);
    merged.skills = sk;
    if ((extra.selfIntro || '').length > (merged.selfIntro || '').length) merged.selfIntro = extra.selfIntro;

    var deep;
    // P1-24：透传 act.jd.weightTemplate，避免只有 weightTemplate 没有 weights 时回落到 default
    var detailOpts = { tier: 'detail' };
    if (act.jd && act.jd.weightTemplate && !act.jd.weights) detailOpts.weightTemplate = act.jd.weightTemplate;
    try { deep = TA_ENGINE.scoreCandidate(merged, act.jd, act.th || {}, detailOpts); } catch (e) { return; }
    // 卡片分：本帧内存 → 跨帧镜像（另一个帧评的卡也能显示 Δ）
    var cardTotal = mem ? mem.r.total : (mirror ? mirror.t : null);
    var stamp = gid + '|' + deep.total + '|' + merged.skills.length + '|' + merged.workHistory.length;
    if (detailKey === stamp) return;            // 没变化就别重绘（详情页 DOM 抖动很频繁）
    detailKey = stamp;

    if (!ensureDetailHost(root)) return;
    var cls = deep.mismatch ? 'x' : deep.level === 'high' ? 'h' : deep.level === 'medium' ? 'm' : 'l';
    // 详情层证据不足（insufficientEvidence）→ 引擎置 cardVerdict='unknown'，UI 显示「信息不足」，
    // 不显示被托底的数字 60（那会被读成"通过"）。
    var detailUnknown = deep.cardVerdict === 'unknown';
    if (detailUnknown) cls = 'l';
    var delta = cardTotal != null ? deep.total - cardTotal : null;
    var deltaHtml = delta == null ? '仅详情信息'
      : (delta > 0 ? '<span class="up">▲' + delta + '</span>' : delta < 0 ? '<span class="dn">▼' + (-delta) + '</span>' : '持平');
    var html = '<div class="dp"><div class="t">深度分 · 已读详情</div>'
      + '<div class="v ' + cls + '">' + (deep.mismatch ? '岗位不符' : (detailUnknown ? '信息不足' : deep.total)) + '</div>'
      + '<div class="d">' + (cardTotal != null ? '卡片分 ' + cardTotal + ' → ' : '') + deltaHtml
      + '　覆盖度 ' + (deep.coverage == null ? '—' : deep.coverage + '%') + '</div></div>';
    var old = detailRoot.querySelector('.dp');
    if (old) { try { detailRoot.removeChild(old); } catch (e) { /* ignore */ } }
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    detailRoot.appendChild(wrap.firstChild);
    detailOwnerGid = gid || '';   // 记下这枚徽章属于谁
  }

  // 页面适应：按 CARD_SELS 由准到宽依次试，返回第一条真的选到东西的结果，
  // 并把 CARD_SEL 记成当前生效的那条（心跳上报和 observer 都用它）。
  // 一条都选不到时返回空列表，由调用方累计 noCardStreak。
  // 单页最多处理这么多张卡。兜底选择器写得宽（如 [data-geekid]），万一在某个页面上
  // 命中成百上千个节点，就会建出同样多的 shadow root —— 页面会明显变卡，
  // 那既是稳定性问题也是对用户的实际伤害。宁可少贴几个徽章也不能拖垮人家的页面。
  var MAX_CARDS = 80;

  function findCards() {
    for (var i = 0; i < CARD_SELS.length; i++) {
      var els;
      try { els = document.querySelectorAll(CARD_SELS[i]); } catch (e) { continue; }
      if (els && els.length > MAX_CARDS && i > 0) {
        // 宽选择器命中数量异常 → 判为选错了目标，跳过它继续试下一条，别硬着头皮贴
        continue;
      }
      if (els && els.length) {
        // 兜底选择器可能命中卡片【内层】节点，向上找到真正的卡片容器，避免把徽章塞进内层
        if (i >= 2) {
          var out = [];
          for (var j = 0; j < els.length; j++) {
            var n = els[j];
            var li = (n.closest && (n.closest('li') || n.closest('[class*="card"]'))) || n;
            if (out.indexOf(li) === -1) out.push(li);
          }
          CARD_SEL = CARD_SELS[i];
          return out;
        }
        CARD_SEL = CARD_SELS[i];
        return Array.prototype.slice.call(els);
      }
    }
    return [];
  }

  function scheduleRescan(force) {
    if (force) {
      // 强制重扫：清掉"已评分"记忆，让每张卡都重新出分
      scoredMap = new WeakMap();
    }
    if (rescanScheduled) return;
    rescanScheduled = true;
    requestAnimationFrame(function () {
      rescanScheduled = false;
      try {
        var cards = findCards();
        lastCardCount = cards.length;
        if (cards.length) noCardStreak = 0; else noCardStreak++;
        for (var i = 0; i < cards.length && i < MAX_CARDS; i++) {
          // 单张卡出错只跳过这一张，不能连累整轮（BOSS 偶尔会有半渲染的异形卡片）
          try { scoreCard(cards[i], false); } catch (e) { /* ignore */ }
        }
        // 详情面板打开时做第二级评分（见 scoreDetail 的说明）
        scoreDetail();
      } catch (e) { /* 整轮扫描出错也不外溢到页面 */ }
    });
  }

  // ---- Observer：尽量收窄到列表容器 ----
  function setupObserver() {
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } observer = null; }
    var target = document.querySelector('ul.job-list-box, ul.card-list, [class*="recommend-list"], [class*="geek-list"], [class*="job-list"], div.job-list, div.list-wrap');
    if (!target) target = document.querySelector('main, [class*="main-content"], #main') || document.body;
    try {
      observer = new MutationObserver(function (recs) {
        // 整个回调包一层：这是运行在【BOSS 页面自己的 DOM 变更流】上的代码，
        // 我们的任何一次意外抛错都不该出现在人家的控制台里，更不该影响页面。
        try {
          for (var i = 0; i < recs.length; i++) {
            var rn = recs[i].addedNodes;
            if (!rn) continue;
            for (var j = 0; j < rn.length; j++) {
              var n = rn[j];
              if (n.nodeType !== 1) continue;
              if ((n.matches && n.matches(CARD_SEL)) || (n.querySelector && n.querySelector(CARD_SEL))) {
                scheduleRescan(false);
                return;
              }
            }
          }
        } catch (e) { /* 观察器出错绝不能外溢到页面 */ }
      });
      observer.observe(target, { childList: true, subtree: true });
    } catch (e) { observer = null; }
  }

  // ---- 路由变化 ----
  // 注意：content script 跑在 isolated world，改这里的 history.pushState 拦不到页面自己那份，
  // 所以 hook 只是顺带；真正兜底的是 ROUTE_TICK_MS 的 href 巡检（只比字符串，开销可忽略）。
  function onRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    closeMenu();
    jobDetected = null;
    detectJob();
    requestAnimationFrame(function () { setupObserver(); scheduleRescan(true); });
  }

  function hookHistory() {
    try {
      var _ps = history.pushState, _rs = history.replaceState;
      history.pushState = function () { var r = _ps.apply(this, arguments); setTimeout(onRoute, 50); return r; };
      history.replaceState = function () { var r = _rs.apply(this, arguments); setTimeout(onRoute, 50); return r; };
    } catch (e) { /* ignore */ }
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
  }

  // ---- 启动 ----
  // v2.1 起脚本跑在【所有帧】里（这是让它能看见候选人卡片的前提，见 manifest 注释）。
  // 但绝大多数帧是与我们无关的小 iframe（埋点、广告位、空壳），在它们里面挂 observer、
  // 起 4 个定时器纯属浪费，还会把心跳放大好几倍。
  // 判据：顶层文档一定跑（它负责路由巡检与心跳），子帧只在【URL 像招聘业务帧】时才跑。
  var timers = [];
  function teardown() {
    for (var i = 0; i < timers.length; i++) { try { clearInterval(timers[i]); } catch (e) { /* ignore */ } }
    timers = [];
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } observer = null; }
  }

  function frameWorthRunning() {
    try {
      if (window.top === window.self) return true;                 // 顶层永远跑
      return /\/web\/(frame|chat|boss|geek)/i.test(location.pathname); // 业务子帧
    } catch (e) {
      return true; // 跨域读不到就保守地跑（漏跑比多跑更糟）
    }
  }

  function start() {
    if (started) return; started = true;
    hookHistory();
    loadJd();
    loadCardCache();   // 跨帧接力镜像：详情帧启动时先把已评过的卡片级结果拉进来
    setupObserver();
    scheduleRescan(true);

    // JD 更新的唯一通道：background 写 storage → 这里收变更。
    // （不用 chrome.tabs.sendMessage 推送：那需要 tabs 或 zhipin.com 的 host 权限，本扩展两个都不要。）
    // 跨帧卡片缓存同理：别的帧 flush 之后，这里的镜像立即跟上。
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes['ta-jd-cache']) {
          try { applyJd(changes['ta-jd-cache'].newValue || null); } catch (e) { /* ignore */ }
        }
        if (changes[CARD_CACHE_KEY]) {
          cardCacheMirror = changes[CARD_CACHE_KEY].newValue || {};
        }
      });
    } catch (e) { /* ignore */ }

    timers.push(setInterval(onRoute, ROUTE_TICK_MS));
    timers.push(setInterval(flushCardCache, 3000));   // 卡片级结果批量落 storage（跨帧接力用）
    // 重扫 + 校正坐标。连续多轮一张卡都找不到时【自动退避】：
    // 这多半是当前页面本来就没有候选人列表（或 BOSS 改版了），继续每 5 秒全量查一遍
    // 只是白白耗电、给页面添堵。退到 30 秒一次，一旦重新找到卡片立刻恢复常速。
    timers.push(setInterval(function () {
      if (noCardStreak > 6 && (Date.now() % 30000) > RESCAN_TICK_MS) return;
      scheduleRescan(false);
      repositionAll();
    }, RESCAN_TICK_MS));
    reportAlive(true);   // 页面刚起来：让平台立刻知道，并顺带拉一次最新岗位
    timers.push(setInterval(function () { reportAlive(false); }, ALIVE_TICK_MS));

    // 页面卸载：主动收摊。SPA 里长时间不刷新，不清理会把 observer 和定时器越攒越多。
    window.addEventListener('pagehide', teardown);
    window.addEventListener('beforeunload', teardown);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      loadJd();
      reportAlive(true);   // 切回这个标签页 → 立刻让平台知道，并刷新岗位
      // 手动选过岗位（auto:false）就别动它——切个标签页回来不该把人家刚选的岗位冲掉。
      // 只有自动识别的结果才值得重识别（用户可能换了搜索词）。
      var oldId = jobDetected ? jobDetected.id : null;
      if (!jobDetected || jobDetected.auto) { jobDetected = null; detectJob(); }
      var newId = jobDetected ? jobDetected.id : null;
      scheduleRescan(oldId !== newId);
    });
  }

  if (!frameWorthRunning()) {
    // 与招聘业务无关的帧：什么都不做，连监听都不挂。
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
