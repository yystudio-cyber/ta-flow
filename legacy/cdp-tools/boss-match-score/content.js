/**
 * BOSS 直聘匹配评分助手 - Content Script (isolated world)
 *
 * 修复历史：
 *  - H5: 不再把内部 JD 写入 BOSS 域 localStorage（改用模块内变量 + 主进程 postMessage 同步）
 *  - H10: 评分逻辑不再自行实现，直接复用主进程同一套评分引擎（__TA_SCORE__ 已由沙箱注入器
 *         在 isolated world 中内联 scoring-universal.js）。这样列表分/详情分/主进程评分完全一致。
 *
 * 运行在 isolated world，无法访问页面 JS 变量；DOM 可读写。
 */
(function () {
  'use strict';

  var TOOL_ID = 'boss-match-score';
  // CONFIG 由沙箱注入器提供
  var HIGH_THRESHOLD = (typeof CONFIG !== 'undefined' && CONFIG.highThreshold) || 75;
  var LOW_THRESHOLD = (typeof CONFIG !== 'undefined' && CONFIG.lowThreshold) || 60;
  var SHOW_BADGE = (typeof CONFIG !== 'undefined' && CONFIG.showBadge) !== false;
  var SHOW_PANEL = (typeof CONFIG !== 'undefined' && CONFIG.showDetailPanel) !== false;
  var HIGHLIGHT_KW = !!(typeof CONFIG !== 'undefined' && CONFIG.highlightKeywords);

  // H5 修复：JD 只保存在 isolated world 闭包内，不写入 localStorage
  var activeJD = null;
  var PROCESSED_KEY = 'ta-boss-processed-set'; // 仅用 Set 内存缓存，不落盘

  function log() {
    if (typeof TA !== 'undefined' && TA.log) {
      TA.log.apply(null, arguments);
    } else if (CONFIG && CONFIG.debug) {
      var args = Array.prototype.slice.call(arguments);
      console.log.apply(console, ['[' + TOOL_ID + ']'].concat(args));
    }
  }

  // --- 通过主进程 RPC 获取当前活跃 JD ---
  function fetchActiveJD() {
    // 主进程会通过 window.postMessage({__ta:1, action:'push-active-jd', jd}) 下发
    // 这里先尝试读取 preload 暴露的 API（如果有）
    try {
      if (typeof window !== 'undefined' && window.__TA_ACTIVE_JD__) {
        activeJD = window.__TA_ACTIVE_JD__;
      }
    } catch {}
    return activeJD;
  }

  // 监听主进程通过 postMessage 下发的 JD
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.__ta === 1 && e.data.action === 'push-active-jd' && e.data.jd) {
      activeJD = e.data.jd;
      removePanels();
      scheduleRun();
    }
  });

  // --- 统一评分入口 ---
  function scoreProfile(profile) {
    if (!activeJD) return null;
    var scorer = (typeof window !== 'undefined' && window.__TA_SCORE__) || null;
    if (scorer && typeof scorer.scoreCandidate === 'function') {
      try {
        return scorer.scoreCandidate(profile, activeJD);
      } catch (e) {
        log('score error', e);
      }
    }
    return null;
  }

  function highlightKeyword(kw, color) {
    if (!document.body || !HIGHLIGHT_KW) return;
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.textContent || node.textContent.indexOf(kw) === -1) return NodeFilter.FILTER_REJECT;
          var p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest('.ta-boss-badge, .ta-boss-panel')) return NodeFilter.FILTER_REJECT;
          if (p.tagName === 'SCRIPT') return NodeFilter.FILTER_REJECT;
          if (p.classList && p.classList.contains('ta-highlighted')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      var nodes = [];
      var n;
      while ((n = walker.nextNode())) nodes.push(n);
      nodes.forEach(function (node) {
        var text = node.textContent;
        var parent = node.parentNode;
        if (!parent) return;
        var escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var html = text.replace(new RegExp(escaped, 'g'), function (m) {
          return '<span class="ta-highlighted" style="background:' + color + '33;color:' + color + ';padding:0 2px;border-radius:2px">' + m + '</span>';
        });
        var span = document.createElement('span');
        span.innerHTML = html;
        parent.replaceChild(span, node);
      });
    } catch (e) {
      log('highlight error', e);
    }
  }

  function extractCardProfile(cardEl) {
    var getText = function (sel) {
      var n = cardEl.querySelector(sel);
      return n ? (n.textContent || '').trim() : '';
    };
    var title = getText('.job-name, .job-title, .title .job-name');
    var salary = getText('.job-salary, .salary, .title .salary');
    var company = getText('.company-name, .company-title a');
    var tags = Array.prototype.slice.call(cardEl.querySelectorAll('.tag-list .tag, .job-info ul li'))
      .map(function (t) { return (t.textContent || '').trim(); })
      .filter(Boolean);
    var city = getText('.job-area, .job-area-wrapper');
    var p = { position: title, company: company, salary: salary, skills: tags, city: city };
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      var exp1 = t.match(/^(\d+)-(\d+)年$/);
      if (exp1) { p.experienceYears = parseInt(exp1[1], 10); continue; }
      if (/^\d+年以内$|^\d+年以上$/.test(t)) { p.experienceYears = parseInt(t, 10) || 1; continue; }
      if (['本科', '大专', '硕士', '博士'].some(function (d) { return t.indexOf(d) !== -1; })) {
        p.degree = t; continue;
      }
    }
    return p;
  }

  // S7 渐进评分：详情页选择器按"区块"组织，新增区块=加一条配置（BOSS 真实 DOM 需按实际调整）
  var DETAIL_SEL = {
    name: '.name, .geek-name, .resume-name',
    position: '.job-title, .position, .title',
    company: '.company-name, .geek-company',
    city: '.location, .job-area',
    salary: '.salary, .geek-salary',
    degree: '.edu, .degree',
    experience: '.experience, .work-exp',
    skills: '.skills .tag, .skill-list span, .tags .tag, .labels .label',
    workBlocks: '.work-experience .item, .work-exp-box .item, .geek-work-exp li, [class*="work-exp"] .item, [class*="workExp"] li',
    projectBlocks: '.project-experience .item, .project-exp-box .item, .geek-project-exp li, [class*="project-exp"] .item, [class*="projectExp"] li',
    eduBlocks: '.education-experience .item, .edu-exp-box .item, .geek-edu-exp li, [class*="edu-exp"] .item, [class*="eduExp"] li',
  };

  function _txt(el, sel) {
    var n = (el || document).querySelector(sel);
    return n ? (n.textContent || '').trim() : '';
  }
  function _all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  // 只提取"当前可见 DOM"里的信息（随滚动逐步变多）——由 mergeProfile 累积
  function extractDetailProfile() {
    var p = { skills: [], workHistory: [], projects: [], education: [] };
    p.name = _txt(document, DETAIL_SEL.name);
    p.position = _txt(document, DETAIL_SEL.position);
    p.company = _txt(document, DETAIL_SEL.company);
    p.city = _txt(document, DETAIL_SEL.city);
    p.salary = _txt(document, DETAIL_SEL.salary);
    p.degree = _txt(document, DETAIL_SEL.degree);
    var years = _txt(document, DETAIL_SEL.experience).match(/(\d+)/);
    if (years) p.experienceYears = parseInt(years[1], 10);
    p.skills = _all(DETAIL_SEL.skills).map(function (el) { return (el.textContent || '').trim(); }).filter(Boolean);

    // 工作经历区块：公司名 + 时长（用于 industry 维度，此前恒空导致 industry 永远中性）
    p.workHistory = _all(DETAIL_SEL.workBlocks).map(function (b) {
      var t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) return null;
      var comp = _txt(b, '.company, .company-name, .name, h3, strong') || t.split(' ')[0];
      var ym = t.match(/(\d+)\s*年/);
      return { company: comp, industry: '', years: ym ? parseInt(ym[1], 10) : undefined };
    }).filter(Boolean);

    // 项目经历区块：项目名 + 描述（纳入关键词命中）
    p.projects = _all(DETAIL_SEL.projectBlocks).map(function (b) {
      var name = _txt(b, '.name, .title, h3, strong');
      var desc = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!name && !desc) return null;
      return { name: name || desc.slice(0, 20), desc: desc };
    }).filter(Boolean);

    // 教育经历区块
    p.education = _all(DETAIL_SEL.eduBlocks).map(function (b) {
      var school = _txt(b, '.school, .name, h3, strong');
      var deg = _txt(b, '.degree, .edu');
      var major = _txt(b, '.major');
      if (!school && !deg && !major) return null;
      return { school: school, degree: deg, major: major };
    }).filter(Boolean);

    return p;
  }

  // 累积合并（去重 union），使"越向下滚动、信息越全、分越准"，规避虚拟列表滚动卸载导致的信息丢失
  function _unionBy(a, b, keyFn) {
    var out = [], seen = {};
    (a || []).concat(b || []).forEach(function (it) {
      if (it == null) return;
      var k = keyFn(it);
      if (k === '' || seen[k]) return;
      seen[k] = 1; out.push(it);
    });
    return out;
  }
  function mergeProfile(acc, next) {
    acc = acc || { skills: [], workHistory: [], projects: [], education: [] };
    ['name', 'position', 'company', 'city', 'salary', 'degree', 'experienceYears'].forEach(function (k) {
      if ((acc[k] === undefined || acc[k] === '' || acc[k] === null) && next[k]) acc[k] = next[k];
    });
    acc.skills = _unionBy(acc.skills, next.skills, function (x) { return String(x); });
    acc.workHistory = _unionBy(acc.workHistory, next.workHistory, function (x) { return (x.company || '') + '|' + (x.years || ''); });
    acc.projects = _unionBy(acc.projects, next.projects, function (x) { return x.name || ''; });
    acc.education = _unionBy(acc.education, next.education, function (x) { return (x.school || '') + '|' + (x.degree || ''); });
    return acc;
  }

  // 当前详情页标识；变化则重置累积（换了候选人）
  var _acc = null;
  var _accKey = '';
  var _detailExpanded = false; // "查看详细报告"展开状态
  function reportRow(label, items) {
    items = (items || []).filter(Boolean);
    if (!items.length) return '';
    return '<div style="margin:2px 0"><b style="color:#374151">' + label + '：</b>' + items.slice(0, 8).join('、') + '</div>';
  }
  function accumulateAndRender() {
    var key = location.pathname + location.search;
    if (key !== _accKey) { _accKey = key; _acc = null; }
    _acc = mergeProfile(_acc, extractDetailProfile());
    renderDetailPanel(_acc);
  }

  // --- 列表页徽章 ---
  function addCardBadges() {
    if (!SHOW_BADGE) return;
    if (!activeJD) return;
    var cards = document.querySelectorAll('.job-card-wrapper, .job-list-box .job-card, li.job-card-wrapper');
    cards.forEach(function (card) {
      if (card.getAttribute('data-ta-scored')) return;
      card.setAttribute('data-ta-scored', '1');
      var profile = extractCardProfile(card);
      var result = scoreProfile(profile);
      if (!result) return;

      // 关键词高亮（仅第一个必选词作为示例）
      if (HIGHLIGHT_KW && activeJD.keywords && activeJD.keywords.required) {
        for (var i = 0; i < Math.min(activeJD.keywords.required.length, 5); i++) {
          var kw = activeJD.keywords.required[i];
          var color = '#10b981';
          highlightKeyword(kw, color);
        }
        activeJD.keywords.bonus && activeJD.keywords.bonus.slice(0, 3).forEach(function (kw) {
          highlightKeyword(kw, '#3b82f6');
        });
        activeJD.keywords.negative && activeJD.keywords.negative.slice(0, 3).forEach(function (kw) {
          highlightKeyword(kw, '#ef4444');
        });
      }

      var badge = document.createElement('div');
      badge.className = 'ta-boss-badge';
      var color = result.level === 'high' ? '#10b981' : result.level === 'medium' ? '#f59e0b' : '#ef4444';
      badge.style.cssText = 'position:absolute;top:8px;right:8px;z-index:10;background:' + color + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;font-family:system-ui,sans-serif;box-shadow:0 2px 4px rgba(0,0,0,.1);cursor:help;';
      var icon = result.level === 'high' ? '🟢' : result.level === 'medium' ? '🟡' : '🔴';
      badge.textContent = String(result.total) + ' ' + icon;
      var label = result.level === 'high' ? '高度匹配' : result.level === 'medium' ? '中度匹配' : '不太匹配';
      badge.title = icon + ' ' + label;
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.appendChild(badge);
    });
  }

  // --- 详情页浮动面板 ---
  var DETAIL_PANEL_ID = 'ta-boss-detail-panel';
  var detailUpdateTimer = null;

  function renderDetailPanel(profile) {
    var result = scoreProfile(profile);
    if (!result) return;
    var panel = document.getElementById(DETAIL_PANEL_ID);
    var color = result.level === 'high' ? '#10b981' : result.level === 'medium' ? '#f59e0b' : '#ef4444';
    var icon = result.level === 'high' ? '🟢' : result.level === 'medium' ? '🟡' : '🔴';
    var label = result.level === 'high' ? '高度匹配' : result.level === 'medium' ? '中度匹配' : '不太匹配';
    var detailHtml = result.details.map(function (d) {
      var mark = d.status === 'match' ? '✅' : d.status === 'partial' || d.status === 'warn' ? '⚠️' : '❌';
      return '<div style="display:flex;justify-content:space-between;margin:3px 0;font-size:12px"><span style="color:#6b7280">' + mark + ' ' + d.label + '</span><span style="color:#374151">' + (d.note || '') + '</span></div>';
    }).join('');
    // S7: "查看详细报告"展开区（累积到的工作/项目/教育/技能）
    var extraHtml = '';
    if (_detailExpanded) {
      extraHtml = '<div style="margin-top:8px;border-top:1px dashed #e5e7eb;padding-top:8px;font-size:11px;color:#6b7280">' +
        reportRow('工作经历', (profile.workHistory || []).map(function (w) { return (w.company || '') + (w.years ? '·' + w.years + '年' : ''); })) +
        reportRow('项目', (profile.projects || []).map(function (p) { return p.name; })) +
        reportRow('教育', (profile.education || []).map(function (e) { return (e.school || '') + (e.degree ? '·' + e.degree : ''); })) +
        reportRow('技能', profile.skills || []) +
        '</div>';
    }
    var btnLabel = _detailExpanded ? '收起报告 ▲' : '查看详细报告 ▼';
    var html = '<div style="font-weight:600;margin-bottom:8px;color:' + color + '">' + icon + ' 匹配度分析</div>' +
      '<div style="font-size:24px;font-weight:700;color:' + color + ';margin-bottom:8px">' + result.total + ' <span style="font-size:13px;font-weight:normal;color:#6b7280">' + label + '</span></div>' +
      '<div style="height:1px;background:#e5e7eb;margin:8px 0"></div>' + detailHtml + extraHtml +
      '<div id="ta-detail-report-btn" style="margin-top:8px;text-align:center;font-size:11px;color:#3b82f6;cursor:pointer">' + btnLabel + '</div>' +
      '<div style="margin-top:6px;font-size:11px;color:#9ca3af;text-align:center">TA 平台 · 本地评分</div>';
    if (!panel) {
      panel = document.createElement('div');
      panel.id = DETAIL_PANEL_ID;
      panel.className = 'ta-boss-panel';
      panel.style.cssText = 'position:fixed;top:80px;right:20px;z-index:99999;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:14px 16px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;min-width:220px;max-width:280px;border-left:4px solid ' + color;
      document.body.appendChild(panel);
    } else {
      panel.style.borderLeftColor = color;
    }
    panel.innerHTML = html;
    var btn = document.getElementById('ta-detail-report-btn');
    if (btn) btn.addEventListener('click', function () { _detailExpanded = !_detailExpanded; renderDetailPanel(profile); });
  }

  function showDetailPanel() {
    if (!SHOW_PANEL) return;
    if (!activeJD) return;
    var container = document.querySelector('.job-detail, .job-detail-body, .detail-job-card, main');
    if (!container) return;
    accumulateAndRender();
  }

  // 详情页滚动时重新评分（节流）
  function scheduleDetailUpdate() {
    if (location.pathname.indexOf('/job_detail') === -1) return;
    if (!document.getElementById(DETAIL_PANEL_ID)) return;
    if (detailUpdateTimer) return;
    detailUpdateTimer = setTimeout(function () {
      detailUpdateTimer = null;
      try {
        accumulateAndRender(); // S7: 累积增量提取后重评，越滚越准
      } catch (e) { log('detail update error', e); }
    }, 600);
  }

  function removePanels() {
    document.querySelectorAll('.ta-boss-badge').forEach(function (n) { n.remove(); });
    var p = document.getElementById('ta-boss-detail-panel');
    if (p) p.remove();
    // 重置 scored 标记以便重新评分
    document.querySelectorAll('[data-ta-scored]').forEach(function (n) { n.removeAttribute('data-ta-scored'); });
  }

  function run() {
    if (location.pathname.indexOf('/job_detail') !== -1) {
      showDetailPanel();
    } else {
      addCardBadges();
    }
  }

  var runTimer = null;
  function scheduleRun() {
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(run, 300);
  }

  // 路由变化监听（BOSS 是 SPA）
  var lastUrl = location.href;
  var observer = new MutationObserver(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      removePanels();
      scheduleRun();
    }
    addCardBadges();
  });

  // 详情页滚动监听：滚动时重新评分（节流在 scheduleDetailUpdate 内）
  function onScrollForDetail() {
    scheduleDetailUpdate();
  }

  function init() {
    if (location.host.indexOf('zhipin.com') === -1) return;
    fetchActiveJD();
    run();
    observer.observe(document.body, { childList: true, subtree: true });
    // 定期扫描新卡片（滚动加载）
    setInterval(addCardBadges, 1500);
    // 详情页滚动触发重评
    window.addEventListener('scroll', onScrollForDetail, { passive: true });
    // 初次进入详情页时多触发几次（SPA 延迟加载）
    setTimeout(showDetailPanel, 800);
    setTimeout(showDetailPanel, 1800);
    setTimeout(showDetailPanel, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
