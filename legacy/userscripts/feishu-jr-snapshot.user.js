// ==UserScript==
// @name         飞书 JR 每日快照 (招聘需求自动导出)
// @namespace    acme-feishu-jr-snapshot
// @version      1.1.0
// @description  每日在飞书招聘需求列表页自动抓取新增 JR,导出 CSV 到 Downloads,供本地 Excel 合并。只读/不回写/无 LLM/无候选人信息。
// @author       you
// @match        https://*.feishu.cn/hire/*
// @match        https://*.larkoffice.com/hire/*
// @match        https://*.feishu-boe.cn/hire/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_info
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ============================================================================
 *  结构导航
 *  §1 CONFIG          —— 运行时间 / 列定义 / 字段别名 / API 候选(可改)
 *  §2 STORE           —— GM 存储:上次运行日期 / 已见 ID 集 / 配置
 *  §3 GUARD           —— 页面守卫 + 登录态检查
 *  §4 API PROBE       —— 探测列表接口:监听 fetch/XHR,记录真实端点/字段
 *  §5 API CLIENT      —— 分页拉取全部 JR 结构化数据
 *  §6 DIFF            —— 新 JR 识别 + 字段映射 + CSV 导出
 *  §7 TIMER           —— 每日定时触发(5 分钟心跳)
 *  §8 UI              —— 悬浮状态条 / 日志面板 / 探测按钮 / 立即运行
 *  §9 BOOT            —— 初始化
 *
 *  用法:
 *    - 首次:打开招聘需求列表页(/hire/job/requirement),点「🔍 探测 API」,
 *      待面板展示字段清单后,可据此校准 §1.4 FIELD_MAP。
 *    - 日常:保持该标签页常驻,脚本每天到点自动跑一次。
 * ============================================================================
 */

(function () {
  'use strict';

  /* ==========================================================================
   * §1 CONFIG —— 所有可调项集中在这里
   * ======================================================================== */

  // 1.1 运行时间 (24 小时制,到点后第一次心跳触发,每天最多一次)
  const CONFIG = {
    dailyHour: 10,           // 时:10
    dailyMinute: 30,         // 分:30 → 每天 10:30
    heartbeatMs: 5 * 60 * 1000, // 心跳间隔:5 分钟
    pageLoadDelayMs: 2000,   // 页面加载后延迟再检查(等接口就绪)
    apiTimeoutMs: 20000,     // 单次接口超时
    pageSleepMs: 300,        // 分页之间间隔(避免触发限流)
  };

  // 1.2 目标列定义 —— 与主表 Excel 列顺序严格一致(15 列,位置对应)
  //     { idx: 1-based 列号, key: 内部标识, zh: 中文名, en: 英文名, source: 填充来源 }
  //     source 取值:
  //       'auto'  = 从 Feishu JR 记录直出 (FIELD_MAP 里找字段)
  //       'derive'= 脚本计算得出
  //       'manual'= 永远留空,TA 手填(管道绝不碰)
  const MASTER_COLUMNS = [
    { idx: 1,  key: 'level0Dept',      zh: '0级部门',             en: 'Level 0 Department',  source: 'derive' },
    { idx: 2,  key: 'level1Dept',      zh: '1级部门',             en: 'Level 1 Department',  source: 'derive' },
    { idx: 3,  key: 'jobTitle',        zh: '职位名称',            en: 'Job Title',           source: 'auto'   },
    { idx: 4,  key: 'criticalPos',     zh: '关键岗位',            en: 'Critical Position',   source: 'auto'   }, // VERIFY
    { idx: 5,  key: 'urgency',         zh: '紧急度',              en: 'Urgency Level',       source: 'auto'   }, // VERIFY
    { idx: 6,  key: 'jobLevel',        zh: '级别',                en: 'Job Level',           source: 'auto'   },
    { idx: 7,  key: 'location',        zh: '工作地',              en: 'Base Location',       source: 'auto'   },
    { idx: 8,  key: 'hiringManager',   zh: '上级',                en: 'Hiring Manager',      source: 'auto'   },
    { idx: 9,  key: 'reason',          zh: '招聘原因',            en: 'Reason',              source: 'auto'   }, // VERIFY
    { idx: 10, key: 'hcType',          zh: 'HC类别',              en: 'HC Type',             source: 'auto'   },
    { idx: 11, key: 'approvalDate',    zh: '审批具体时间',        en: 'Req Approval Date',   source: 'auto'   }, // VERIFY
    { idx: 12, key: 'leadTimeCutoff',  zh: 'Lead Time cutoff 180D', en: 'Lead Time cutoff 180D', source: 'derive' },
    { idx: 13, key: 'kickOffDate',     zh: '招聘启动日期',        en: 'Hiring Kick Off Date',source: 'manual' }, // MANUAL
    { idx: 14, key: 'expectedOnboard', zh: '预期到岗时间',        en: 'Expected Onboard Time', source: 'auto' }, // VERIFY
    { idx: 15, key: 'jrId',            zh: '招聘需求编号',        en: 'Req#',                source: 'auto'   }, // 唯一键
  ];

  // 1.3 候选 API 端点(按探测优先级,第一个命中就用)
  const API_CANDIDATES = [
    // 飞书招聘 ATSX/Throne 内部常见路径
    { method: 'POST', url: '/atsx/api/hire/job/requirement/list',           body: { page: 1, pageSize: 50 } },
    { method: 'POST', url: '/atsx/api/v1/hire/job/requirement/list',        body: { page: 1, pageSize: 50 } },
    { method: 'POST', url: '/atsx/api/job/requirement/list',                body: { page: 1, pageSize: 50 } },
    { method: 'POST', url: '/atsx/api/v1/job/requirement/list',             body: { page: 1, pageSize: 50 } },
    { method: 'POST', url: '/atsx/api/throne/job/requirement/list',         body: { page: 1, pageSize: 50 } },
    { method: 'POST', url: '/atsx/api/hire/requirement/list',               body: { page: 1, pageSize: 50 } },
    { method: 'GET',  url: '/atsx/api/hire/job/requirement/list?page=1&pageSize=50' },
  ];

  // 1.4 字段别名表 —— 把 Feishu JR API 返回的字段名 → MASTER_COLUMNS.key
  //     【重要】首次使用前请先点「🔍 探测 API」按钮,根据真实字段名校准此表。
  //     支持多个源字段名别名(数组),按顺序尝试,第一个非空即采用。
  const FIELD_MAP = {
    // key: master column key → value: 可能的 API 字段名(别名数组,按优先级)
    jrId:            ['job_requirement_id', 'jr_id', 'id', 'requirement_id', 'reqId', 'code', 'jr_code', 'jobRequirementId'],
    jobTitle:        ['name', 'title', 'job_name', 'jobTitle', 'requirement_name', '职位名称', '需求名称'],
    jobLevel:        ['job_level', 'level', 'jobLevel', '职级'],
    location:        ['work_location', 'location', 'base_location', '工作地点', '城市'],
    hiringManager:   ['hiring_manager', 'manager', 'manager_name', '用人经理', '上级', 'requester'],
    hcType:          ['hc_type', 'headcount_type', 'person_type', '人员类型', 'HC类别'],
    criticalPos:     ['is_critical', 'critical_position', 'key_position', '关键岗位'],
    urgency:         ['urgency', 'urgency_level', '紧急程度', '紧急度', 'priority'],
    reason:          ['reason', 'hire_reason', 'recruit_reason', '招聘原因'],
    approvalDate:    ['approval_date', 'approved_at', '审批时间', '审批具体时间', 'approveTime'],
    expectedOnboard: ['expected_onboard_date', 'onboard_date', 'expected_onboard', '预期到岗时间', '期望到岗'],
    // 部门路径(用于拆分 level0 / level1)
    deptPath:        ['department_path', 'department', 'dept_path', 'org_path', '需求部门', '部门路径', 'department_name'],
    deptId:          ['department_id', 'dept_id'],
  };

  // 1.5 VERIFY 列缺失开关 —— 经过 live 校准,若确认 Feishu JR 记录里没有某列对应的字段,
  //     把该列的 key 加入下面数组,CSV 对应列永远输出空白(等 TA 手填)。
  //     同步把 PS1 脚本里 $MANUAL_COLS 加上对应列号,防止后续合并覆盖。
  //     默认所有 VERIFY 列都尝试输出,校准后按需改。
  //     示例(校准后发现 criticalPos 与 reason 不存在):FORCE_MANUAL_KEYS = ['criticalPos','reason']
  const FORCE_MANUAL_KEYS = [];

  // 1.6 部门路径分隔符 —— 校准后若发现 Feishu 部门路径分隔符不是 / 或 >,在这里改(支持正则字符类)
  const DEPT_PATH_SEPARATOR = /[\/>\\|、,，]/;

  // 1.7 页面守卫 —— 只在招聘需求列表页激活(不碰候选人等敏感页面)
  const ALLOW_PATTERNS = [
    /\/hire\/job\/requirement/i,
  ];
  const DENY_PATTERNS = [
    /talent/i, /application/i, /candidate/i,
    /resume/i, /interview/i, /offer/i, /people\/detail/i,
  ];

  // 1.8 存储键
  const KEY_LAST_RUN = 'fjrs_lastRunDate'; // YYYY-MM-DD
  const KEY_SEEN_IDS = 'fjrs_seenIds';     // { "JR123": true }
  const KEY_CONFIG   = 'fjrs_config_v2';   // 覆盖式配置(含 run time 与 FORCE_MANUAL_KEYS 覆盖)
  const KEY_PROBE    = 'fjrs_probeResult_v2'; // 上次探测结果缓存

  const UI_ROOT_ID = 'fjrs-root';

  /* ==========================================================================
   * §2 STORE
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
      } catch (e) { /* ignore */ }
    },
    del(key) {
      try {
        if (typeof GM_deleteValue === 'function') { GM_deleteValue(key); return; }
        localStorage.removeItem(key);
      } catch (e) { /* ignore */ }
    },
  };

  // 加载用户覆盖配置(允许在 UI 里改 run time 等,不必改脚本)
  function loadOverrides() {
    const ov = store.get(KEY_CONFIG, null);
    if (ov && typeof ov === 'object') {
      Object.assign(CONFIG, ov);
    }
  }
  loadOverrides();

  /* ==========================================================================
   * §3 GUARD —— 页面/登录态守卫
   * ======================================================================== */
  function isDeniedPage() {
    return DENY_PATTERNS.some(re => re.test(location.href));
  }
  function isAllowedPage() {
    return ALLOW_PATTERNS.some(re => re.test(location.href));
  }
  function isActivePage() {
    return isAllowedPage() && !isDeniedPage();
  }
  function isLoggedIn() {
    // 粗略判断:没有跳转到 /login/ 路径,且有 body 且没有明显的登录表单特征
    if (/\/login\//i.test(location.href)) return false;
    if (/login_redirect/i.test(location.href)) return false;
    // 如果页面上有明确的登录按钮且没有用户头像,视为未登录(宽松)
    const hasLoginBtn = document.querySelector('[class*="login" i] button, a[href*="/login"]');
    const hasUserAvatar = document.querySelector('[class*="avatar" i], [class*="user" i] img');
    if (hasLoginBtn && !hasUserAvatar) return false;
    return true;
  }

  /* ==========================================================================
   * §4 API PROBE —— 监听 fetch/XHR,并主动试探,找真实列表接口
   * ======================================================================== */
  const probeState = {
    captured: [],     // 捕捉到的候选请求 {url, method, status, sample}
    active: false,
  };

  function hookNetwork() {
    if (hookNetwork.__done) return;
    hookNetwork.__done = true;

    // hook fetch
    const origFetch = window.fetch;
    window.fetch = function () {
      const url = arguments[0];
      const opts = arguments[1] || {};
      return origFetch.apply(this, arguments).then(res => {
        try {
          const u = typeof url === 'string' ? url : (url && url.url);
          if (u && /requirement|jr.*list|job.*list/i.test(u)) {
            res.clone().json().then(json => {
              probeState.captured.push({
                url: u,
                method: (opts.method || 'GET').toUpperCase(),
                status: res.status,
                sample: json,
                via: 'fetch',
              });
            }).catch(() => {});
          }
        } catch (e) {}
        return res;
      });
    };

    // hook XHR
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      this.__url = url;
      this.__method = method;
      return origOpen.apply(this, arguments);
    };
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function () {
      this.addEventListener('load', () => {
        try {
          const u = this.__url;
          if (u && /requirement|jr.*list|job.*list/i.test(u) && this.responseType !== 'blob') {
            let json = null;
            try { json = JSON.parse(this.responseText); } catch (e) {}
            if (json) {
              probeState.captured.push({
                url: u,
                method: (this.__method || 'GET').toUpperCase(),
                status: this.status,
                sample: json,
                via: 'xhr',
              });
            }
          }
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  // 主动试探候选端点
  async function probeCandidates() {
    const results = [];
    for (const cand of API_CANDIDATES) {
      try {
        const opts = {
          method: cand.method,
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        };
        if (cand.method === 'POST' && cand.body) {
          opts.body = JSON.stringify(cand.body);
        }
        // 加 CSRF token(飞书常见:从 cookie 读 csrf_token,放 header X-CSRFToken)
        const csrf = getCsrfToken();
        if (csrf) opts.headers['X-CSRFToken'] = csrf;

        const res = await fetch(cand.url, opts);
        if (!res.ok) { results.push({ url: cand.url, method: cand.method, status: res.status, ok: false }); continue; }
        const json = await res.json();
        const record = findFirstRecord(json);
        results.push({
          url: cand.url,
          method: cand.method,
          status: res.status,
          ok: true,
          total: countTotal(json),
          firstRecord: record,
          fieldNames: record ? Object.keys(record) : [],
          json,
        });
        if (record && record[Object.keys(record)[0]]) {
          // 找到一个有数据的,作为最佳候选
          results[results.length - 1].best = true;
        }
      } catch (e) {
        results.push({ url: cand.url, method: cand.method, status: 'error', error: e.message, ok: false });
      }
    }
    return results;
  }

  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/i);
    if (m) return decodeURIComponent(m[1]);
    const m2 = document.cookie.match(/(?:^|;\s*)LARKID_CSRF_TOKEN=([^;]+)/i);
    if (m2) return decodeURIComponent(m2[1]);
    return '';
  }

  // 在任意深度的 JSON 里找第一条记录(猜测 list/items/data 字段)
  function findFirstRecord(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // 常见列表字段名
    for (const key of ['data', 'items', 'list', 'records', 'rows', 'result']) {
      const arr = obj[key];
      if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
        return arr[0];
      }
      // 可能嵌套: obj.data.list
      if (arr && typeof arr === 'object' && !Array.isArray(arr)) {
        const nested = findFirstRecord(arr);
        if (nested) return nested;
      }
    }
    // 暴力:找第一个数组属性
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object') {
        // 排除分页元数据
        if (typeof v[0].id === 'string' || typeof v[0].name === 'string') return v[0];
        return v[0];
      }
    }
    return null;
  }

  function countTotal(json) {
    if (json && typeof json === 'object') {
      for (const k of ['total', 'totalCount', 'total_count', 'count', 'sum']) {
        if (typeof json[k] === 'number') return json[k];
        if (json.data && typeof json.data[k] === 'number') return json.data[k];
      }
    }
    return null;
  }

  // 获取当前最佳 API 端点信息(优先用 capture 到的,否则用主动试探的)
  async function resolveApiEndpoint() {
    // 先看缓存
    const cached = store.get(KEY_PROBE, null);
    if (cached && cached.best && cached.best.url && cached.best.firstRecord) {
      return cached.best;
    }
    // 主动试探
    const results = await probeCandidates();
    const best = results.find(r => r.best) || results.find(r => r.ok && r.firstRecord);
    if (best) {
      store.set(KEY_PROBE, { best, at: Date.now() });
      return best;
    }
    return null;
  }

  /* ==========================================================================
   * §5 API CLIENT —— 拉取全部 JR
   * ======================================================================== */
  async function fetchAllJR() {
    const api = await resolveApiEndpoint();
    if (!api) {
      throw new Error('未找到可用的 JR 列表接口,请先点「探测 API」或检查登录态');
    }
    const all = [];
    let page = 1;
    const pageSize = 100;

    // 猜测分页字段
    const sampleRecord = api.firstRecord;
    const json = api.json;
    // 推断 list 路径
    const listPath = findListPath(json);
    const totalKey = findTotalKey(json);

    while (true) {
      const body = { page, pageSize };
      const opts = {
        method: api.method,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      };
      const csrf = getCsrfToken();
      if (csrf) opts.headers['X-CSRFToken'] = csrf;
      if (api.method === 'POST') opts.body = JSON.stringify(body);

      let url = api.url;
      if (api.method === 'GET') {
        const sep = url.includes('?') ? '&' : '?';
        url += `${sep}page=${page}&pageSize=${pageSize}`;
      }

      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`接口 ${url} 返回 ${res.status}`);
      const data = await res.json();
      const records = extractList(data, listPath);
      if (!records || !records.length) break;
      all.push(...records);

      const total = extractTotal(data, totalKey);
      if (total && all.length >= total) break;
      if (records.length < pageSize) break;

      page++;
      await sleep(CONFIG.pageSleepMs);
    }
    return all;
  }

  function findListPath(json) {
    // 返回属性路径数组,例如 ['data', 'list']
    function walk(obj, path) {
      if (!obj || typeof obj !== 'object') return null;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && (v[0].id || v[0].name)) {
          return [...path, k];
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const r = walk(v, [...path, k]);
          if (r) return r;
        }
      }
      return null;
    }
    return walk(json, []) || ['data', 'list'];
  }

  function findTotalKey(json) {
    function walk(obj, path) {
      if (!obj || typeof obj !== 'object') return null;
      for (const k of ['total', 'totalCount', 'total_count', 'count']) {
        if (typeof obj[k] === 'number') return [...path, k];
      }
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const r = walk(v, [...path, k]);
          if (r) return r;
        }
      }
      return null;
    }
    return walk(json, []) || ['data', 'total'];
  }

  function extractList(json, path) {
    let cur = json;
    for (const k of path) {
      if (!cur || typeof cur !== 'object') return null;
      cur = cur[k];
    }
    return Array.isArray(cur) ? cur : null;
  }

  function extractTotal(json, path) {
    let cur = json;
    for (const k of path) {
      if (!cur || typeof cur !== 'object') return null;
      cur = cur[k];
    }
    return typeof cur === 'number' ? cur : null;
  }

  /* ==========================================================================
   * §6 DIFF + MAP + CSV 导出
   * ======================================================================== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 从 JR 记录取指定 key 的值(按别名表尝试)
  function getFieldValue(record, masterKey) {
    const aliases = FIELD_MAP[masterKey];
    if (!aliases || !Array.isArray(aliases)) return '';
    for (const alias of aliases) {
      // 支持嵌套路径,用 . 分隔
      const parts = alias.split('.');
      let v = record;
      let ok = true;
      for (const p of parts) {
        if (v == null || typeof v !== 'object') { ok = false; break; }
        // 先尝试精确 key,再尝试大小写不敏感
        if (p in v) v = v[p];
        else {
          const low = p.toLowerCase();
          const hit = Object.keys(v).find(k => k.toLowerCase() === low);
          if (hit) v = v[hit];
          else { ok = false; break; }
        }
      }
      if (ok && v != null && v !== '') {
        // 如果是对象(如部门对象 {id, name, path}),尝试取 name / path
        if (typeof v === 'object') {
          if (v.path) return v.path;
          if (v.name) return v.name;
          if (v.full_name) return v.full_name;
          if (v.text) return v.text;
          // 数组(如多个地点)
          if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : (x.name || x.text || JSON.stringify(x))).join(' / ');
          return JSON.stringify(v);
        }
        return String(v);
      }
    }
    return '';
  }

  // 把单条 JR 记录映射为 15 列数组(按 MASTER_COLUMNS 顺序)
  function mapJRToRow(record) {
    const row = new Array(MASTER_COLUMNS.length).fill('');

    // 合并 built-in manual + FORCE_MANUAL_KEYS(校准后加入缺失字段)
    const forcedManual = new Set(FORCE_MANUAL_KEYS);

    for (let i = 0; i < MASTER_COLUMNS.length; i++) {
      const col = MASTER_COLUMNS[i];

      if (col.source === 'manual' || forcedManual.has(col.key)) {
        row[i] = ''; // 管道永远不写
        continue;
      }

      if (col.source === 'auto') {
        row[i] = getFieldValue(record, col.key);
        continue;
      }

      if (col.source === 'derive') {
        if (col.key === 'level0Dept' || col.key === 'level1Dept') {
          // 留空,下面统一处理
          continue;
        }
        if (col.key === 'leadTimeCutoff') {
          // 若 approvalDate 被强制 manual,此处也留空
          if (forcedManual.has('approvalDate')) { row[i] = ''; continue; }
          const approval = getFieldValue(record, 'approvalDate');
          row[i] = add180Days(approval);
          continue;
        }
      }
    }

    // 部门路径拆分(若 deptPath 被强制 manual,留空)
    if (forcedManual.has('deptPath')) {
      row[0] = '';
      row[1] = '';
    } else {
      const deptPath = getFieldValue(record, 'deptPath');
      if (deptPath) {
        const parts = deptPath.split(DEPT_PATH_SEPARATOR).map(s => s.trim()).filter(Boolean);
        row[0] = parts[0] || ''; // level0
        row[1] = parts[1] || ''; // level1
      } else {
        row[0] = getFieldValue(record, 'deptId') || ''; // 兜底
        row[1] = '';
      }
    }

    return row;
  }

  function add180Days(dateStr) {
    if (!dateStr) return '';
    // 支持 Unix 秒 / 毫秒 时间戳
    const num = Number(dateStr);
    let d = null;
    if (!isNaN(num) && num > 1000000000) {
      d = new Date(num < 1e12 ? num * 1000 : num);
    } else {
      d = new Date(dateStr);
    }
    if (isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + 180);
    return formatDate(d);
  }

  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function todayStr() {
    return formatDate(new Date());
  }

  function nowStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // 生成 CSV 内容(UTF-8 BOM,Excel 能正确识别中文)
  function buildCSV(rows) {
    const esc = v => {
      const s = String(v == null ? '' : v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = MASTER_COLUMNS.map(c => `${c.zh}\n${c.en}`);
    const lines = [header.map(esc).join(',')];
    for (const row of rows) {
      lines.push(row.map(esc).join(','));
    }
    const csv = lines.join('\r\n');
    // UTF-8 BOM
    return '﻿' + csv;
  }

  function downloadCSV(csvContent, filename) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  // 主流程:拉全部 → diff → 有新则导出 CSV → 更新 seenIds
  async function runSnapshot(reason) {
    const log = [];
    const addLog = s => { log.push(s); console.log('[JR-Snapshot]', s); };

    addLog(`开始运行(${reason}),${todayStr()}`);

    if (!isActivePage()) { addLog('当前页不在白名单,中止'); updateStatus('不在需求页', 'warn'); return { ok: false, log }; }
    if (!isLoggedIn()) { addLog('未登录,中止'); updateStatus('未登录', 'err'); return { ok: false, log }; }

    try {
      updateStatus('拉取中…', 'info');
      const allJR = await fetchAllJR();
      addLog(`共拉取 ${allJR.length} 条 JR`);

      const seen = store.get(KEY_SEEN_IDS, {}) || {};
      const newRows = [];
      const newIds = [];
      const unmappedCols = [];
      let unmappedSourceFieldsSet = new Set();

      for (const rec of allJR) {
        const id = getFieldValue(rec, 'jrId');
        if (!id) continue;
        if (seen[id]) continue; // 已见过
        newIds.push(id);
        const row = mapJRToRow(rec);
        newRows.push(row);

        // 统计未在别名表里的 API 字段(仅第一次记录)
        if (unmappedSourceFieldsSet.size < 50) {
          const mappedNames = new Set();
          for (const mk of Object.keys(FIELD_MAP)) {
            for (const alias of FIELD_MAP[mk]) {
              mappedNames.add(alias.toLowerCase());
            }
          }
          for (const k of Object.keys(rec)) {
            if (!mappedNames.has(k.toLowerCase())) unmappedSourceFieldsSet.add(k);
          }
        }
      }

      // 检查哪些目标列没有数据源
      for (const col of MASTER_COLUMNS) {
        if (col.source !== 'auto') continue;
        if (newRows.length > 0) {
          const idx = col.idx - 1;
          const allEmpty = newRows.every(r => r[idx] === '');
          if (allEmpty) unmappedCols.push(`${col.zh} (${col.key})`);
        }
      }

      addLog(`新 JR ${newIds.length} 条`);
      addLog(`未映射源字段(${unmappedSourceFieldsSet.size}):${[...unmappedSourceFieldsSet].slice(0,15).join(', ')}${unmappedSourceFieldsSet.size>15?'...':''}`);
      addLog(`空目标列(${unmappedCols.length}):${unmappedCols.join(', ') || '(无)'} —— 可能是字段不存在或需校准别名`);

      if (newIds.length === 0) {
        store.set(KEY_LAST_RUN, todayStr());
        updateStatus(`今日无新增 (${todayStr()})`, 'ok');
        addLog('今日无新 JR,仅更新 last-run');
        return { ok: true, newCount: 0, log, unmappedCols, unmappedSource: [...unmappedSourceFieldsSet] };
      }

      // 导出 CSV
      const csv = buildCSV(newRows);
      const filename = `jr_new_${nowStamp()}.csv`;
      downloadCSV(csv, filename);
      addLog(`已导出 ${filename},共 ${newRows.length} 行`);

      // 更新 seen 集合
      const newSeen = { ...seen };
      for (const id of newIds) newSeen[id] = true;
      store.set(KEY_SEEN_IDS, newSeen);
      store.set(KEY_LAST_RUN, todayStr());

      updateStatus(`新增 ${newRows.length} 条 → ${filename}`, 'ok');
      return { ok: true, newCount: newRows.length, filename, log, unmappedCols, unmappedSource: [...unmappedSourceFieldsSet] };
    } catch (e) {
      addLog('运行失败:' + e.message);
      updateStatus('运行失败', 'err');
      return { ok: false, error: e.message, log };
    }
  }

  /* ==========================================================================
   * §7 TIMER —— 每日心跳
   * ======================================================================== */
  let heartbeatTimer = null;

  function shouldRunToday() {
    const lastRun = store.get(KEY_LAST_RUN, '');
    const today = todayStr();
    if (lastRun === today) return false;
    const now = new Date();
    const runTime = new Date();
    runTime.setHours(CONFIG.dailyHour, CONFIG.dailyMinute, 0, 0);
    return now >= runTime;
  }

  function heartbeat() {
    if (!isActivePage() || !isLoggedIn()) return;
    if (shouldRunToday()) {
      runSnapshot('每日定时');
    }
  }

  function startTimer() {
    if (heartbeatTimer) return;
    // 页面加载后先延迟检查一次
    setTimeout(heartbeat, CONFIG.pageLoadDelayMs);
    heartbeatTimer = setInterval(heartbeat, CONFIG.heartbeatMs);
  }

  /* ==========================================================================
   * §8 UI
   * ======================================================================== */
  const CSS = `
    #${UI_ROOT_ID}{position:fixed;right:16px;top:16px;z-index:2147482000;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;}
    #${UI_ROOT_ID} *{box-sizing:border-box;}
    .fjrs-pill{background:#fff;border:1px solid #dee0e3;border-radius:20px;padding:6px 12px;box-shadow:0 2px 8px rgba(0,0,0,.08);cursor:pointer;display:inline-flex;align-items:center;gap:6px;color:#1f2329;user-select:none;}
    .fjrs-pill:hover{border-color:#3370ff;color:#3370ff;}
    .fjrs-dot{width:8px;height:8px;border-radius:50%;background:#d0d3d6;flex-shrink:0;}
    .fjrs-dot.ok{background:#34c724;}
    .fjrs-dot.warn{background:#ff8800;}
    .fjrs-dot.err{background:#f24957;}
    .fjrs-dot.info{background:#3370ff;}
    .fjrs-panel{position:fixed;right:16px;top:50px;width:420px;max-height:70vh;overflow:auto;background:#fff;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.22);padding:14px;z-index:2147482001;color:#1f2329;}
    .fjrs-panel h3{margin:0 0 10px;font-size:14px;display:flex;justify-content:space-between;align-items:center;}
    .fjrs-x{cursor:pointer;color:#8a919f;font-size:18px;line-height:1;}
    .fjrs-btn-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}
    .fjrs-btn{cursor:pointer;border:1px solid #dee0e3;background:#f7f8fa;border-radius:6px;padding:6px 10px;font-size:12px;}
    .fjrs-btn:hover{background:#eef2ff;border-color:#3370ff;color:#3370ff;}
    .fjrs-btn.primary{background:#3370ff;color:#fff;border-color:#3370ff;}
    .fjrs-btn.primary:hover{background:#2860e0;}
    .fjrs-sec{margin:10px 0 4px;font-weight:bold;font-size:12px;}
    .fjrs-log{background:#f7f8fa;border-radius:6px;padding:8px;font-family:monospace;font-size:11px;line-height:1.5;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;}
    .fjrs-field-list{display:flex;flex-wrap:wrap;gap:4px;max-height:140px;overflow:auto;}
    .fjrs-field-tag{background:#eef2ff;color:#3370ff;border-radius:4px;padding:2px 6px;font-size:11px;}
    .fjrs-help{color:#8a919f;font-size:11px;margin-top:6px;line-height:1.5;}
    .fjrs-config input{width:50px;padding:3px 5px;border:1px solid #dee0e3;border-radius:4px;font-size:12px;}
    .fjrs-config label{margin-right:8px;font-size:12px;}
  `;

  function injectCSS() {
    if (document.getElementById('fjrs-css')) return;
    const s = document.createElement('style');
    s.id = 'fjrs-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  let statusEl = null;
  let statusLevel = 'ok';

  function updateStatus(text, level) {
    statusLevel = level || 'ok';
    if (!statusEl) return;
    const dot = statusEl.querySelector('.fjrs-dot');
    const txt = statusEl.querySelector('.fjrs-text');
    if (dot) { dot.className = 'fjrs-dot ' + statusLevel; }
    if (txt) txt.textContent = text;
  }

  let panelEl = null;
  function closePanel() { if (panelEl) { panelEl.remove(); panelEl = null; } }

  function openPanel(title, bodyHTML) {
    closePanel();
    const p = document.createElement('div');
    p.className = 'fjrs-panel';
    p.innerHTML = `
      <h3><span>${title}</span><span class="fjrs-x">×</span></h3>
      <div class="fjrs-body"></div>
    `;
    p.querySelector('.fjrs-x').onclick = closePanel;
    p.querySelector('.fjrs-body').innerHTML = bodyHTML;
    document.getElementById(UI_ROOT_ID).appendChild(p);
    panelEl = p;
    return p;
  }

  function renderPill() {
    let root = document.getElementById(UI_ROOT_ID);
    if (root) root.remove();
    root = document.createElement('div');
    root.id = UI_ROOT_ID;

    const pill = document.createElement('div');
    pill.className = 'fjrs-pill';
    pill.innerHTML = `<span class="fjrs-dot ok"></span><span class="fjrs-text">JR 快照 · 就绪</span>`;
    pill.onclick = openMainPanel;
    root.appendChild(pill);
    document.body.appendChild(root);
    statusEl = pill;
    updateStatus('就绪', 'ok');
  }

  function openMainPanel() {
    const lastRun = store.get(KEY_LAST_RUN, '(从未运行)');
    const seen = store.get(KEY_SEEN_IDS, {}) || {};
    const seenCount = Object.keys(seen).length;

    const body = `
      <div class="fjrs-btn-row">
        <button class="fjrs-btn primary" id="fjrs-run-now">▶ 立即运行</button>
        <button class="fjrs-btn" id="fjrs-probe">🔍 探测 API</button>
        <button class="fjrs-btn" id="fjrs-reset-seen">🗑 清空已见 ID</button>
      </div>
      <div class="fjrs-sec">状态</div>
      <div class="fjrs-help">
        每日运行时间:${CONFIG.dailyHour}:${String(CONFIG.dailyMinute).padStart(2,'0')}<br>
        上次运行日期:${lastRun}<br>
        已见 JR 数:${seenCount}<br>
        目标列数:${MASTER_COLUMNS.length} (位置对应主表 Excel 1-15 列)
      </div>
      <div class="fjrs-sec">日志</div>
      <div class="fjrs-log" id="fjrs-log">(暂无运行记录)</div>
      <div class="fjrs-sec">配置</div>
      <div class="fjrs-config">
        <label>时:<input type="number" id="fjrs-cfg-hour" value="${CONFIG.dailyHour}" min="0" max="23"></label>
        <label>分:<input type="number" id="fjrs-cfg-min" value="${CONFIG.dailyMinute}" min="0" max="59"></label>
        <button class="fjrs-btn" id="fjrs-cfg-save">保存</button>
      </div>
      <div class="fjrs-help">
        提示:首次使用请先点「🔍 探测 API」获取真实字段名,
        再根据结果校准脚本顶部 FIELD_MAP 别名表。
        校准后每天到点自动运行,新 JR 会导出 CSV 到 Downloads。
      </div>
    `;
    const panel = openPanel('飞书 JR 每日快照', body);

    panel.querySelector('#fjrs-run-now').onclick = async () => {
      const logEl = panel.querySelector('#fjrs-log');
      logEl.textContent = '运行中…';
      const result = await runSnapshot('手动触发');
      logEl.textContent = result.log.join('\n');
    };
    panel.querySelector('#fjrs-probe').onclick = doProbe;
    panel.querySelector('#fjrs-reset-seen').onclick = () => {
      if (confirm('确定清空已见 ID 集合?下次运行会把所有 JR 都当作新增导出。')) {
        store.del(KEY_SEEN_IDS);
        store.del(KEY_PROBE);
        openMainPanel();
        updateStatus('已清空', 'warn');
      }
    };
    panel.querySelector('#fjrs-cfg-save').onclick = () => {
      const h = parseInt(panel.querySelector('#fjrs-cfg-hour').value, 10);
      const m = parseInt(panel.querySelector('#fjrs-cfg-min').value, 10);
      if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
        alert('时间不合法'); return;
      }
      const ov = { dailyHour: h, dailyMinute: m };
      store.set(KEY_CONFIG, ov);
      CONFIG.dailyHour = h;
      CONFIG.dailyMinute = m;
      alert('已保存,立即生效');
      openMainPanel();
    };
  }

  async function doProbe() {
    const panel = openPanel('API 探测 & 校准报告', '<div class="fjrs-log">正在探测候选端点并拉取样本数据…</div>');
    const $body = panel.querySelector('.fjrs-body');

    hookNetwork();
    await sleep(1500); // 等页面正在发的请求进入 capture

    const results = await probeCandidates();
    const captured = probeState.captured.slice();
    const best = results.find(r => r.best) || results.find(r => r.ok && r.firstRecord);

    const report = {
      tenant: location.hostname,
      at: new Date().toISOString(),
      endpoint: null,
      totalRecords: null,
      recordsSampled: 0,
      allFieldNames: [],
      fieldCoverage: {},   // key → { presentIn: N, sampleValue, sourceField }
      deptField: null,
      deptSeparator: null,
      deptSample: null,
      approvalField: null,
      approvalFormat: null,
      approvalSample: null,
      leadTimeComputeCheck: null,
      missingCols: [],
      verifiedCols: [],
      sampleRecords: [],
    };

    let fieldCoverageHTML = '';
    let extraHTML = '';

    if (best) {
      report.endpoint = { method: best.method, url: best.url };
      report.totalRecords = best.total;

      // 尝试拉取多页样本(最多 3 页或 50 条),用于分析字段覆盖
      let sampleRecords = [];
      try {
        sampleRecords = await fetchSampleRecords(best, 3);
      } catch (e) {
        // fetchSampleRecords 失败就用 best.firstRecord
        if (best.firstRecord) sampleRecords = [best.firstRecord];
      }
      report.recordsSampled = sampleRecords.length;
      report.sampleRecords = sampleRecords.slice(0, 3);

      // 收集所有字段名(跨所有记录的 union)
      const fieldFreq = new Map();   // fieldName → count
      for (const rec of sampleRecords) {
        for (const k of Object.keys(rec)) {
          fieldFreq.set(k, (fieldFreq.get(k) || 0) + 1);
        }
      }
      report.allFieldNames = [...fieldFreq.keys()];

      // 对每个 MASTER_COLUMNS 'auto' 列,检测它在样本中的命中情况
      const flatAliases = {};
      for (const mk of Object.keys(FIELD_MAP)) {
        for (const alias of FIELD_MAP[mk]) { flatAliases[alias.toLowerCase()] = mk; }
      }

      function pickValue(rec, aliases) {
        // 给定别名数组,从 record 里取第一个非空值(支持 . 嵌套)
        for (const alias of aliases) {
          const parts = alias.split('.');
          let v = rec;
          let ok = true;
          for (const p of parts) {
            if (v == null || typeof v !== 'object') { ok = false; break; }
            if (p in v) v = v[p];
            else {
              const low = p.toLowerCase();
              const hit = Object.keys(v).find(k => k.toLowerCase() === low);
              if (hit) v = v[hit]; else { ok = false; break; }
            }
          }
          if (ok && v != null && v !== '' && !(typeof v === 'object' && Object.keys(v).length === 0)) {
            return { value: v, usedAlias: alias };
          }
        }
        return null;
      }

      for (const col of MASTER_COLUMNS) {
        if (col.source !== 'auto') continue;
        if (col.key === 'jrId') continue; // 主键一定有
        const aliases = FIELD_MAP[col.key] || [];
        let hitCount = 0;
        let sampleVal = null;
        let hitField = null;
        for (const rec of sampleRecords) {
          const r = pickValue(rec, aliases);
          if (r) {
            hitCount++;
            if (sampleVal === null) { sampleVal = r.value; hitField = r.usedAlias; }
          }
        }
        // 如果现有别名没命中,尝试在所有字段名里模糊搜索
        if (hitCount === 0) {
          const cnHint = col.zh;
          for (const fname of fieldFreq.keys()) {
            const flow = fname.toLowerCase();
            if (flow.includes(cnHint) || flow.includes(col.key.toLowerCase())) {
              // 找到疑似字段,记录
              for (const rec of sampleRecords) {
                if (rec[fname] != null && rec[fname] !== '') {
                  hitCount++;
                  if (sampleVal === null) { sampleVal = rec[fname]; hitField = fname + '(疑似)'; }
                  break;
                }
              }
              if (hitCount > 0) break;
            }
          }
        }
        report.fieldCoverage[col.key] = {
          zh: col.zh,
          presentIn: hitCount,
          total: sampleRecords.length,
          sampleValue: sampleVal !== null ? describeValue(sampleVal) : '',
          sourceField: hitField,
          exists: hitCount > 0,
        };
      }

      // 部门字段探测
      const deptRes = pickValue(sampleRecords[0] || best.firstRecord, FIELD_MAP.deptPath);
      if (deptRes) {
        report.deptField = deptRes.usedAlias;
        const dv = typeof deptRes.value === 'object'
          ? (deptRes.value.path || deptRes.value.name || deptRes.value.full_name || JSON.stringify(deptRes.value))
          : String(deptRes.value);
        report.deptSample = dv;
        // 猜分隔符
        const seps = ['/', '>', '|', '\\', '、', ',', '，'];
        let bestSep = null; let bestCount = 0;
        for (const sep of seps) {
          try {
            const escaped = sep.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const re = new RegExp(escaped, 'g');
            const c = (dv.match(re) || []).length;
            if (c > bestCount) { bestCount = c; bestSep = sep; }
          } catch (e) { /* ignore bad sep */ }
        }
        report.deptSeparator = bestSep || '(单层/无分隔符)';
      }

      // 审批日期字段探测
      const apRes = pickValue(sampleRecords[0] || best.firstRecord, FIELD_MAP.approvalDate);
      if (apRes) {
        report.approvalField = apRes.usedAlias;
        const av = apRes.value;
        let fmt = null; let computed = null; let raw = av;
        if (typeof av === 'number') {
          if (av > 1e12) { fmt = 'Unix 毫秒'; computed = add180Days(String(av)); }
          else if (av > 1e9) { fmt = 'Unix 秒'; computed = add180Days(String(av)); }
          else { fmt = '数值(非时间戳?)'; }
        } else if (typeof av === 'string') {
          const d = new Date(av);
          if (!isNaN(d.getTime())) { fmt = 'ISO/日期字符串'; computed = add180Days(av); }
          else { fmt = '字符串(无法解析)'; }
        } else {
          fmt = describeValue(av);
        }
        report.approvalFormat = fmt;
        report.approvalSample = describeValue(av);
        report.leadTimeComputeCheck = computed;
      }

      // 缺失 / 已验证列汇总
      for (const k of Object.keys(report.fieldCoverage)) {
        const c = report.fieldCoverage[k];
        if (c.exists) report.verifiedCols.push(`${c.zh}(${k} ← ${c.sourceField})`);
        else report.missingCols.push(`${c.zh}(${k})`);
      }

      // 构建 UI HTML
      fieldCoverageHTML = `<div class="fjrs-sec">🎯 字段覆盖 (采样 ${sampleRecords.length} 条)</div>`;
      fieldCoverageHTML += `<div class="fjrs-help">✅ = 已找到源字段; ❌ = 别名表未命中,需校准</div>`;
      for (const col of MASTER_COLUMNS) {
        if (col.source !== 'auto' && col.source !== 'derive') continue;
        if (col.key === 'leadTimeCutoff') continue; // 派生列单独显示
        if (col.key === 'jrId') {
          const idRes = pickValue(sampleRecords[0] || best.firstRecord, FIELD_MAP.jrId);
          fieldCoverageHTML += `<div class="ffc-row ffc-ok">🔑 ${col.idx} ${col.zh} ← ${idRes ? idRes.usedAlias : '(未命中,严重错误)'} · 例:${idRes ? describeValue(idRes.value) : ''}</div>`;
          continue;
        }
        if (col.source === 'derive') {
          if (col.key === 'level0Dept' || col.key === 'level1Dept') {
            // 部门单独展示
            continue;
          }
        }
        const ci = report.fieldCoverage[col.key];
        if (!ci) continue;
        const cls = ci.exists ? 'ffc-ok' : 'ffc-warn';
        const icon = ci.exists ? '✅' : '❌';
        fieldCoverageHTML += `<div class="ffc-row ${cls}">${icon} ${col.idx} ${col.zh} (${col.key}) ← ${ci.sourceField || '(无)'} · 命中 ${ci.presentIn}/${ci.total} · 例:${ci.sampleValue || '(空)'}</div>`;
      }

      // 部门字段
      fieldCoverageHTML += `<div class="ffc-row ${report.deptField ? 'ffc-ok' : 'ffc-warn'}">${report.deptField ? '✅' : '❌'} 1/2 部门路径 ← ${report.deptField || '(未找到)'} · 分隔符:${report.deptSeparator || '?'} · 例:${report.deptSample || ''}</div>`;

      // 审批日期
      fieldCoverageHTML += `<div class="ffc-row ${report.approvalField ? 'ffc-ok' : 'ffc-warn'}">${report.approvalField ? '✅' : '❌'} 11 审批具体时间 ← ${report.approvalField || '(未找到)'} · 格式:${report.approvalFormat || '?'} · 例:${report.approvalSample || ''}${report.leadTimeComputeCheck ? ` · +180D = ${report.leadTimeComputeCheck}` : ''}</div>`;

      // 主端点信息
      extraHTML += `<div class="fjrs-sec">✅ 接口端点</div>`;
      extraHTML += `<div class="fjrs-help"><b>${best.method}</b> ${best.url}<br>总数:${best.total !== null ? best.total : '(未知)'} · 本次采样:${sampleRecords.length} 条</div>`;
      extraHTML += `<div class="fjrs-sec">全部字段名 (${report.allFieldNames.length} 个)</div>`;
      extraHTML += `<div class="fjrs-field-list">${report.allFieldNames.map(f => `<span class="fjrs-field-tag">${f.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</span>`).join('')}</div>`;
    } else {
      extraHTML += `<div class="fjrs-sec">❌ 未找到有效端点</div>`;
      extraHTML += `<div class="fjrs-help">候选端点全部失败。请确认:1) 当前账号有查看招聘需求的权限(实习生账号看不到);2) 页面已加载出列表;3) 手动翻一页让接口发出请求后再点探测。</div>`;
    }

    if (captured.length > 0) {
      extraHTML += `<div class="fjrs-sec">📡 监听到的网络请求 (${captured.length})</div>`;
      extraHTML += `<div class="fjrs-field-list">${captured.map(c => `<span class="fjrs-field-tag" title="${(c.via||'')}">${(c.method||'?')} ${(c.url||'').substring(0,70)}${(c.url||'').length>70?'...':''}</span>`).join('')}</div>`;
    }

    extraHTML += `<div class="fjrs-sec">候选端点探测结果</div>`;
    extraHTML += `<div class="fjrs-log">${results.map(r => `${r.ok ? '✅' : '❌'} ${r.method} ${r.url} → ${r.status}${r.ok ? ` (${r.total !== null ? r.total+'条' : '?'})` : r.error ? ' '+r.error : ''}`).join('\n')}</div>`;

    // 文本版报告(复制按钮用)
    const textReport = buildTextReport(report);

    // 最终 HTML
    let html = '';
    html += `<div class="fjrs-btn-row">
      <button class="fjrs-btn primary" id="fjrs-copy-report">📋 复制校准报告</button>
      <button class="fjrs-btn" id="fjrs-close">关闭</button>
    </div>`;
    html += `<div class="fjrs-sec">📌 使用方式</div>`;
    html += `<div class="fjrs-help">1) 点「复制校准报告」;2) 把剪贴板内容粘贴回给开发者,用以校准 FIELD_MAP 和 MANUAL_COLS;3) 校准后重新安装脚本再正式使用。</div>`;
    html += fieldCoverageHTML;
    if (report.missingCols.length > 0) {
      html += `<div class="fjrs-sec">⚠️ 需校准/不存在的列</div>`;
      html += `<div class="fjrs-help">以下列在采样数据中未找到源字段,会被加入 MANUAL_COLS/留空由 TA 手填:${report.missingCols.join('; ')}</div>`;
    }
    if (report.verifiedCols.length > 0) {
      html += `<div class="fjrs-sec">✅ 已验证的列</div>`;
      html += `<div class="fjrs-help">${report.verifiedCols.join('; ')}</div>`;
    }
    html += extraHTML;
    if (best && report.sampleRecords.length > 0) {
      html += `<div class="fjrs-sec">样例记录 (前 ${report.sampleRecords.length} 条)</div>`;
      html += `<div class="fjrs-log">${report.sampleRecords.map((r,i)=>`--- record ${i+1} ---\n${JSON.stringify(r, null, 2)}`).join('\n').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>`;
    }

    $body.innerHTML = html;
    panel.querySelector('#fjrs-copy-report').onclick = () => {
      copyToClipboard(textReport).then(ok => {
        toast(ok ? '校准报告已复制到剪贴板' : '复制失败,请手动选取日志区域');
      });
    };
    panel.querySelector('#fjrs-close').onclick = closePanel;

    // 缓存报告
    if (best) store.set(KEY_PROBE, { best, report, at: Date.now() });
  }

  // 拉取多页样本
  async function fetchSampleRecords(best, maxPages) {
    const records = [];
    if (!best) return records;
    const listPath = findListPath(best.json);
    const totalKey = findTotalKey(best.json);
    const firstPage = extractList(best.json, listPath) || [];
    records.push(...firstPage);
    if (!firstPage.length || firstPage.length < 20) return records;

    // 尝试翻第 2、3 页
    for (let page = 2; page <= maxPages; page++) {
      const body = { page, pageSize: 50 };
      const opts = {
        method: best.method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      };
      const csrf = getCsrfToken();
      if (csrf) opts.headers['X-CSRFToken'] = csrf;
      if (best.method === 'POST') opts.body = JSON.stringify(body);
      let url = best.url;
      if (best.method === 'GET') {
        const sep = url.includes('?') ? '&' : '?';
        url += `${sep}page=${page}&pageSize=50`;
      }
      try {
        const res = await fetch(url, opts);
        if (!res.ok) break;
        const data = await res.json();
        const list = extractList(data, listPath);
        if (!list || !list.length) break;
        records.push(...list);
        await sleep(200);
      } catch (e) { break; }
    }
    return records;
  }

  function describeValue(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[Array(${v.length})]` + (v[0] ? ' ' + describeValue(v[0]) : '');
    if (typeof v === 'object') {
      if (v.name) return '{' + describeValue(v.name) + '}';
      if (v.path) return '{' + describeValue(v.path) + '}';
      if (v.text) return '{' + describeValue(v.text) + '}';
      if (v.label) return '{' + describeValue(v.label) + '}';
      const keys = Object.keys(v).slice(0, 3).join(',');
      return `{${keys}${Object.keys(v).length > 3 ? '…' : ''}}`;
    }
    return String(v);
  }

  function buildTextReport(r) {
    const lines = [];
    lines.push('===== JR Snapshot Calibration Report =====');
    lines.push(`At: ${r.at}`);
    lines.push(`Tenant: ${r.tenant}`);
    lines.push('');
    lines.push('--- Endpoint ---');
    if (r.endpoint) {
      lines.push(`Method: ${r.endpoint.method}`);
      lines.push(`URL: ${r.endpoint.url}`);
      lines.push(`Total records (API): ${r.totalRecords}`);
      lines.push(`Sampled: ${r.recordsSampled}`);
    } else {
      lines.push('❌ NO ENDPOINT FOUND');
    }
    lines.push('');
    lines.push('--- Field Coverage ---');
    for (const k of Object.keys(r.fieldCoverage)) {
      const c = r.fieldCoverage[k];
      lines.push(`${c.exists ? '✅' : '❌'} ${c.zh}(${k}) → source=${c.sourceField || '(none)'} hit=${c.presentIn}/${c.total} sample=${c.sampleValue}`);
    }
    lines.push('');
    lines.push('--- Department ---');
    lines.push(`Dept field: ${r.deptField || '(not found)'}`);
    lines.push(`Separator: ${r.deptSeparator || '?'}`);
    lines.push(`Sample: ${r.deptSample || ''}`);
    lines.push('');
    lines.push('--- Approval Date ---');
    lines.push(`Field: ${r.approvalField || '(not found)'}`);
    lines.push(`Format: ${r.approvalFormat || '?'}`);
    lines.push(`Sample: ${r.approvalSample || ''}`);
    lines.push(`+180D check: ${r.leadTimeComputeCheck || '(n/a)'}`);
    lines.push('');
    lines.push('--- Verified Cols ---');
    lines.push(r.verifiedCols.join('; ') || '(none)');
    lines.push('');
    lines.push('--- Missing Cols (→ FORCE_MANUAL) ---');
    lines.push(r.missingCols.join('; ') || '(none)');
    lines.push('');
    lines.push('--- All Field Names ---');
    lines.push(r.allFieldNames.join(', '));
    lines.push('');
    lines.push('--- Sample Records (first 3, abbreviated) ---');
    for (let i = 0; i < r.sampleRecords.length; i++) {
      lines.push(`[${i+1}] ${JSON.stringify(r.sampleRecords[i]).slice(0, 2000)}`);
    }
    lines.push('');
    lines.push('===== END REPORT =====');
    return lines.join('\n');
  }

  function copyToClipboard(text) {
    return new Promise(resolve => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true), () => fallback());
      } else {
        fallback();
      }
      function fallback() {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed'; ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          resolve(ok);
        } catch (e) { resolve(false); }
      }
    });
  }

  /* ==========================================================================
   * §9 BOOT
   * ======================================================================== */
  function mount() {
    injectCSS();
    if (!isActivePage()) {
      const root = document.getElementById(UI_ROOT_ID);
      if (root) root.remove();
      return;
    }
    // 未登录也显示,但标黄
    renderPill();
    if (!isLoggedIn()) updateStatus('未登录', 'warn');
    else updateStatus('就绪', 'ok');
    startTimer();
    hookNetwork(); // 尽早挂网络监听,方便探测
  }

  function boot() {
    if (window.top !== window.self) return;

    // SPA 路由监听(简化版,够用)
    let lastHref = location.href;
    function onRoute() {
      if (location.href === lastHref) return;
      lastHref = location.href;
      closePanel();
      setTimeout(mount, 300);
    }
    ['pushState', 'replaceState'].forEach(fn => {
      const orig = history[fn];
      if (!orig || orig.__fjrs) return;
      const w = function () { const r = orig.apply(this, arguments); onRoute(); return r; };
      w.__fjrs = true;
      history[fn] = w;
    });
    window.addEventListener('popstate', onRoute);
    setInterval(onRoute, 1500);

    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }

  boot();
})();
