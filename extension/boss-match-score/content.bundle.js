/**
 * TA 匹配分助手 v2 — 单文件打包版
 *
 * ⚠ 本文件由 scripts/build-ext.mjs 自动生成，不要手改。
 *   改源：
 *     · 评分引擎：src/shared/scoring-universal.js
 *     · 语义/分词：src/shared/semantic-provider.js（与主进程 scoring.ts 共用，单一真源）
 *     · content 主逻辑：extension/boss-match-score/parts/30-content.js / 40-structure.js
 *   重建：npm run ext:build
 *
 * 风险边界（勿改）：
 *   · 零平台请求：不向 zhipin.com 发任何 fetch/XHR/WebSocket，只读页面【已渲染】的 DOM 文本
 *   · 只读不写：不点击、不打招呼、不收藏、不改页面数据、不碰 localStorage/IndexedDB
 *   · Shadow DOM (mode:'closed') 隔离展示，宿主元素内联样式，不注入全局 CSS 规则
 *   · 单一 IIFE 闭包，零全局变量（评分引擎/语义模块内联到局部对象，不挂 window）
 *   · WeakMap 跟踪已评分卡片，不在 BOSS 的 DOM 上写 data-* 属性
 *   · 只在顶层 frame 运行
 *
 * 已知痕迹（据实说明，不粉饰）：每张候选人卡片会被插入一个 <span> 宿主元素；
 * 卡片 position:static 时会被补成 relative。这是贴徽章的最小代价，无法为零。
 *
 * 定时器：路由巡检 1.5s（只比 location.href 字符串）+ 兜底重扫 5s。
 * 内嵌顺序：分词+语义（内联自 src/shared/semantic-provider.js）→ 评分引擎（内联自 src/shared/scoring-universal.js）→ content 主逻辑
 */
(function () {
  'use strict';

  // ⚠️ 这里【绝不能】再加"在子帧里直接 return"的早退语句。
  // 2026-07-29：manifest 的 all_frames 已由 false 改为 true，因为 BOSS 招聘端的候选人卡片
  // 全部渲染在 /web/frame/recommend/ 子帧里，顶层文档上一张卡都没有。
  // 而这条 banner 早退语句在打包产物的最外层 IIFE 第一句，会让脚本在【每一个子帧】里
  // 立刻返回 —— 它把 all_frames 的修复整个抵消掉了，扩展在真正有卡片的帧上一行都不执行，
  // 表现仍然是"装好了却什么都不显示"，而构建校验还是绿的。
  // 帧过滤由 content 主逻辑的 frameWorthRunning() 承担（它只跑招聘业务帧，且顶层永远跑）。

  // ================================================================
  // 模块 1+2: 分词 + 语义 provider（构建时原样内联自 src/shared/semantic-provider.js，主进程共用此源）
  // ================================================================
  var __semRoot = {};
﻿/**
 * 语义匹配 provider（同义词表 + TF-IDF + 上位词展开 + 轻量中文分词）。
 *
 * 设计原则：
 *   · 纯 JS，零依赖，Node 与浏览器（content script / isolated world）均可运行；
 *   · 单一真源：主进程 scoring.ts 通过 require() 调起；插件 content.bundle.js 由
 *     scripts/build-ext.mjs 在构建时从本文件原样内联——两边永远是同一份代码，不许分叉；
 *   · 导出工厂函数 createSemanticProvider(opts)，返回 { similarity, kwSim, tokenize }，
 *     供 scoring-universal.js 的 setSemanticProvider(provider) 注入；
 *   · opts.extraSynonyms / opts.extraHypernyms 允许按岗位领域扩充词表（不修改默认词表），
 *     opts.segments 允许注入额外分词词（领域词必须先进分词词典，否则会被切成单字）。
 *
 * 为什么不直接 global：工厂模式避免单例污染；eval 脚本可以反复构造不同配置对照测试。
 */
(function (root) {
  'use strict';

  // ──────────────────── 1. 轻量中文分词（tinyseg 内联，零外部依赖）────────────
  var COMMON = (
    '工作,经验,开发,工程师,经理,主管,总监,技术,项目,负责,产品,设计,运营,市场,销售,' +
    '管理,系统,平台,数据,分析,研发,高级,中级,初级,资深,专家,架构,算法,测试,维护,' +
    '公司,企业,有限,集团,科技,信息,网络,软件,互联网,电子,通信,汽车,金融,教育,医疗,' +
    '要求,熟悉,精通,了解,掌握,具备,优先,能力,相关,以上,以下,至少,年及,岗位,职位,职责,' +
    '本科,硕士,博士,大专,学历,专业,毕业,学校,学院,大学,优秀,良好,熟练,独立,团队,' +
    '用户,客户,服务,业务,方案,需求,问题,功能,流程,优化,提升,完成,支持,协助,参与,' +
    '前端,后端,全栈,移动,客户端,服务端,数据库,运维,安全,人工智能,机器学习,深度学习,' +
    '北京,上海,广州,深圳,杭州,成都,武汉,西安,南京,苏州,天津,重庆,长沙,郑州,青岛,' +
    '宁波,合肥,福州,厦门,济南,沈阳,大连,哈尔滨,长春,石家庄,太原,南昌,昆明,贵阳,南宁,' +
    '月薪,年薪,薪资,待遇,福利,五险一金,年终奖,股票,期权,补贴,奖金,绩效,提成,' +
    '招聘,候选人,推荐,简历,面试,入职,离职,在职,培训,发展,晋升,空间,机会,' +
    '核心,重要,主要,关键,基础,扎实,丰富,成功,大型,中型,小型,创业,上市,国企,外企,' +
    '一年,两年,三年,五年,十年,应届,毕业,在校,实习,兼职,全职,' +
    '应用,框架,工具,组件,接口,模块,性能,优化,部署,上线,迭代,敏捷,DevOps,' +
    'Java,Python,Go,C++,C#,PHP,JavaScript,TypeScript,SQL,HTML,CSS,React,Vue,Angular,' +
    'Spring,Boot,Cloud,MyBatis,Docker,Kubernetes,Linux,MySQL,Redis,MongoDB,Oracle,' +
    '分布式,微服务,高并发,高可用,负载均衡,缓存,消息队列,中间件,Nginx,Tomcat,Git,' +
    '嵌入式,驱动,硬件,芯片,单片机,ARM,FPGA,电路,PCB,原理图,RTOS,实时操作系统,CAN,' +
    '智能,自动化,数字化,信息化,转型,治理,合规,风控,审计,预算,预测,归因,增长,转化,' +
    '算法,模型,训练,推理,特征,样本,NLP,CV,视觉,语音,推荐,搜索,图像,识别,检测,' +
    // 领域扩充词：进分词词典以确保不被切成单字。这些都是跨行业通用的专业词，
    // 不绑定任何特定行业 —— 你所在的领域特有的词，请配在自己岗位的 domain.keywords 里。
    '架构,设计,评审,规范,标准,流程,体系,机制,策略,方案,迭代,版本,发布,上线,运维,监控,' +
    '性能,优化,重构,扩展性,可用性,稳定性,容灾,备份,迁移,部署,容器,虚拟化,云原生,' +
    '数据,清洗,建模,指标,报表,看板,埋点,链路,日志,告警,排障,自动化测试,单元测试,' +
    '项目管理,需求分析,跨部门,协作,沟通,推动,落地,交付,闭环,复盘,方法论,最佳实践,' +
    '团队管理,带团队,绩效,培养,搭建从0到1,0到1,从零到一,规模化,标准化,平台化,' +
    '成本,效率,质量,风险,预算,核算,税务,审计,合规,合同,采购,供应链,库存,交付周期,' +
    '产品设计,用户调研,竞品分析,原型,交互,可用性测试,数据驱动,A/B测试,增长策略,' +
    '数据分析,指标体系,看数,归因分析,漏斗,转化率,留存,复购,客单价,LTV,CAC,ROI'
  ).split(',');

  var DICT = {};
  var MAX_WORD_LEN = 8;
  function _addWord(w) { if (!w) return; w = w.trim(); if (!w) return; DICT[w] = true; if (w.length > MAX_WORD_LEN) MAX_WORD_LEN = w.length; }
  for (var _i = 0; _i < COMMON.length; _i++) _addWord(COMMON[_i]);

  function _addWords(words) { if (!words) return; var arr = typeof words === 'string' ? words.split(/[,，\s]+/) : words; for (var i = 0; i < arr.length; i++) _addWord(arr[i]); }

  function _isAlnum(c) { return /[a-zA-Z0-9\+\#\-\.]/.test(c); }

  function _fmm(s) {
    var r = []; var i = 0;
    while (i < s.length) {
      if (_isAlnum(s[i])) { var j = i; while (j < s.length && _isAlnum(s[j])) j++; r.push(s.substring(i, j).toLowerCase()); i = j; continue; }
      var matched = null;
      for (var len = Math.min(MAX_WORD_LEN, s.length - i); len > 1; len--) { var p = s.substring(i, i + len); if (DICT[p]) { matched = p; break; } }
      if (matched) { r.push(matched); i += matched.length; } else { r.push(s[i]); i++; }
    }
    return r;
  }
  function _bmm(s) {
    var r = []; var i = s.length;
    while (i > 0) {
      var st = i; while (st > 0 && _isAlnum(s[st - 1])) st--;
      if (st < i) { r.unshift(s.substring(st, i).toLowerCase()); i = st; continue; }
      var matched = null;
      for (var len = Math.min(MAX_WORD_LEN, i); len > 1; len--) { var p = s.substring(i - len, i); if (DICT[p]) { matched = p; break; } }
      if (matched) { r.unshift(matched); i -= matched.length; } else { r.unshift(s[i - 1]); i--; }
    }
    return r;
  }

  function _cut(text) {
    if (!text) return [];
    text = String(text).replace(/[\s\r\n\t　]+/g, ' ');
    var segs = text.split(/[，。！？；：""''（）()【】\[\]、,./!?;:\-—_…·~`@#$%^&*+=|\\<>《》]/g);
    var all = [];
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s].trim(); if (!seg) continue;
      var f = _fmm(seg), b = _bmm(seg);
      if (f.length === b.length) {
        var fs = 0, bs = 0;
        for (var k = 0; k < f.length; k++) if (f[k].length === 1) fs++;
        for (var k2 = 0; k2 < b.length; k2++) if (b[k2].length === 1) bs++;
        all = all.concat(fs <= bs ? f : b);
      } else { all = all.concat(f.length <= b.length ? f : b); }
    }
    return all.filter(function (w) { return w && w.length > 0; });
  }

  // ──────────────────── 2. 同义词表 / 上位词（默认 IT 通用词）─────────────────
  var SYNONYMS = [
    ['js', 'javascript', 'es6'], ['ts', 'typescript'], ['py', 'python'],
    ['golang', 'go语言', 'go开发'], ['c语言', 'c开发', 'c编程', '纯c'],
    ['c++', 'cpp', 'cplusplus', 'c++开发'], ['c#', 'csharp'],
    ['java', 'java开发', 'j2ee'],
    ['spring', 'springframework', 'spring框架'],
    ['spring boot', 'springboot', 'spring-boot'],
    ['spring cloud', 'springcloud', '微服务框架'],
    ['mybatis', 'mybatis-plus', 'ibatis', 'orm框架'],
    ['vue', 'vue.js', 'vuejs', 'vue2', 'vue3'],
    ['react', 'react.js', 'reactjs'],
    ['angular', 'angular.js', 'angularjs'],
    ['node', 'node.js', 'nodejs'], ['next.js', 'nextjs', 'next'],
    ['jquery', 'jq'],
    ['mysql', 'my-sql', '关系型数据库', 'rdbms'],
    ['postgresql', 'postgres', 'pg'],
    ['mongodb', 'mongo', '文档数据库', 'nosql'],
    ['redis', '缓存数据库', '内存数据库'],
    ['elasticsearch', 'es', 'elastic', '全文检索'],
    ['oracle', 'oracle数据库'], ['sql server', 'sqlserver', 'mssql'],
    ['docker', '容器化', '容器技术', 'docker容器'],
    ['k8s', 'kubernetes', 'k8s集群', '容器编排'],
    ['jenkins', 'ci/cd', '持续集成', '持续部署', '流水线'],
    ['nginx', '反向代理', 'web服务器'],
    ['linux', 'linux系统', 'linux环境'],
    ['html', 'html5'], ['css', 'css3', '样式表'],
    ['sass', 'scss', 'less', 'css预处理器'],
    ['webpack', 'vite', 'rollup', '打包工具', '构建工具'],
    ['小程序', '微信小程序', '支付宝小程序'],
    ['h5', 'html5页面', '移动端页面', 'wap页面'],
    ['响应式', '自适应', '响应式布局'],
    ['嵌入式', '嵌入式开发', '嵌入式软件', '嵌入式系统'],
    ['驱动开发', '驱动程序', '设备驱动', 'driver开发'],
    ['mcu', '单片机', '微控制器'],
    ['arm', 'arm架构', 'arm处理器', 'cortex-m', 'cortex-a'],
    ['fpga', '可编程逻辑', 'fpga开发'],
    ['rtos', '实时操作系统', 'freertos', 'rt-thread', 'ucos', 'vxworks', 'qnx'],
    ['can', 'can总线', 'canopen', 'can-fd', 'can fd'],
    ['lin', 'lin总线'],
    ['管理', '团队管理', '带团队', '人员管理'],
    ['运营', '运营管理', '业务运营', '用户运营'],
    ['项目管理', '项目推进', '项目交付'],
    ['质量管理', '质量体系', '质量控制'],
    ['pcb', '电路板', '印制板', 'pcb设计'],
    ['机器学习', 'ml', 'machine learning'],
    ['深度学习', 'dl', 'deep learning', '神经网络'],
    ['自然语言处理', 'nlp', '文本处理'],
    ['计算机视觉', 'cv', '图像处理', '图像识别', '视觉算法'],
    ['大模型', 'llm', '大语言模型', 'gpt'],
    ['推荐算法', '推荐系统', '个性化推荐'],
    ['pytorch', 'torch'], ['tensorflow', 'tf'],
    ['测试开发', '测试工程师', 'qa', '质量保障', '自动化测试'],
    ['后端开发', '后端工程师', '服务端开发', 'server开发', '后台开发'],
    ['前端开发', '前端工程师', 'web前端', 'h5开发'],
    ['全栈开发', '全栈工程师'],
    ['移动端', '客户端', 'app开发'],
    ['android', '安卓', '安卓开发'], ['ios', '苹果开发'],
    ['算法工程师', '算法', '算法研究员'],
    ['产品经理', 'pm', '产品', '产品策划'],
    ['运维工程师', '运维', 'sre', 'devops', '系统运维'],
    ['测试工程师', '测试', 'qa工程师', '软件测试'],
    ['架构师', '技术架构'],
    ['技术主管', '技术经理', '技术负责人', 'tl'],
    ['hrbp', 'hr bp', '人力资源合作伙伴'],
    ['招聘', 'ta', '人才获取', 'recruiter'],
    ['ui设计师', 'ui设计', '视觉设计', '界面设计'],
    ['数据分析师', '数据分析', 'bi', '数据运营'],
    ['互联网', '互联网行业', 'it行业', '软件行业', '信息技术'],
    ['制造', '制造业', '生产制造', '工厂'],
    ['新能源', '新能源汽车', 'ev', '电动汽车'],
    ['金融', '金融行业', '银行', '证券', '保险', '基金'],
    ['电商', '电子商务', '零售电商', '互联网电商'],
    ['芯片', '半导体', '集成电路', 'ic', '芯片设计'],
    ['通信', '通信行业', '电信', '运营商'],
    ['智能制造', '工业4.0', '工业互联网', '制造业数字化'],
    ['物联网', 'iot', '万物互联', '智能硬件'],
    ['人工智能', 'ai', 'ai行业', '智能科技'],
    ['bat', '大厂', '头部互联网'],
    ['国企', '央企', '国有企业', '国资'],
    ['外企', '外资', '外商独资'],
    ['上市', '上市公司', 'ipo', '已上市'],
    ['本科', '统招本科', '全日制本科', '学士'],
    ['硕士', '研究生', '硕士研究生'],
    ['博士', '博士研究生'],
    ['大专', '专科', '高职'],
    ['985', '985院校', '985高校', 'c9'],
    ['211', '211院校', '211高校', '双一流'],
    ['熟悉', '熟练掌握', '熟练使用', '精通'],
  ];

  var HYPERNYMS = {
    'java': ['spring', 'springboot', 'springcloud', 'mybatis', 'jvm', 'maven'],
    'python': ['django', 'flask', 'fastapi', 'numpy', 'pandas'],
    '前端': ['html', 'css', 'javascript', 'vue', 'react', 'typescript'],
    '后端': ['java', 'spring', 'mysql', 'redis', '微服务', '分布式'],
    '嵌入式': ['c语言', 'c++', 'rtos', '驱动开发', 'mcu', 'arm', 'linux驱动'],
    'ai': ['机器学习', '深度学习', 'nlp', 'cv', 'pytorch', 'tensorflow'],
    '算法': ['机器学习', '深度学习', '推荐算法', '搜索算法'],
    '测试': ['单元测试', '接口测试', '自动化测试', '性能测试'],
    '运维': ['linux', 'docker', 'k8s', 'jenkins', 'nginx', 'shell'],
    '数据库': ['mysql', 'postgresql', 'oracle', 'mongodb', 'redis', 'sql'],
    '微服务': ['springcloud', 'dubbo', 'rpc', '注册中心'],
    '管理': ['团队管理', '项目管理', '跨部门', '流程优化'],
    '大数据': ['hadoop', 'spark', 'hive', 'kafka', 'flink', 'clickhouse'],
  };

  // ──────────────────── 3. 工厂函数 ─────────────────────────────────────────
  function createSemanticProvider(opts) {
    opts = opts || {};
    // 克隆同义词 / 上位词，避免 opts 多次构造时互相污染
    var synGroups = SYNONYMS.map(function (g) { return g.slice(); });
    var hyper = {};
    for (var h in HYPERNYMS) { if (Object.prototype.hasOwnProperty.call(HYPERNYMS, h)) hyper[h] = HYPERNYMS[h].slice(); }

    // 注入领域词（调用方传入的 extraSynonyms / extraHypernyms）
    if (opts.extraSynonyms) {
      for (var ei = 0; ei < opts.extraSynonyms.length; ei++) synGroups.push(opts.extraSynonyms[ei].slice());
    }
    if (opts.extraHypernyms) {
      for (var ek in opts.extraHypernyms) {
        if (Object.prototype.hasOwnProperty.call(opts.extraHypernyms, ek)) {
          hyper[ek] = (hyper[ek] || []).concat(opts.extraHypernyms[ek]);
        }
      }
    }
    if (opts.segments) _addWords(opts.segments);

    // 重新构造 CANONICAL / SYN_MAP（每次 factory 重新来，互不污染）
    var CANONICAL = {};
    var SYN_MAP = {};
    var allWords = [];
    for (var g = 0; g < synGroups.length; g++) {
      var grp = synGroups[g]; var main = grp[0]; SYN_MAP[main] = grp;
      for (var j = 0; j < grp.length; j++) { CANONICAL[grp[j].toLowerCase()] = main; allWords.push(grp[j]); }
    }
    for (var hh in hyper) { if (Object.prototype.hasOwnProperty.call(hyper, hh)) { allWords.push(hh); allWords = allWords.concat(hyper[hh]); } }
    _addWords(allWords);

    function _tokenize(text) {
      if (!text) return [];
      if (_cut) return _cut(text);
      return String(text).toLowerCase().replace(/[^一-龥a-zA-Z0-9\+\#]/g, ' ').split(/\s+/).filter(Boolean);
    }
    /**
     * 归一化 + 未登录词兜底。
     *
     * 【2026-08-03 修的静默归零 bug】
     * 分词器（_fmm/_bmm）对词典里没有的中文串会逐字切开："订单风控引擎" → 订/单/风/控/引/擎。
     * 老实现在这里把长度 <2 的非拉丁 token 【整个丢掉】，于是任何以未登录词为主的文本
     * 分词后 token 全空 → tf 为空 → _cosine 里 n1===0 → similarity 恒等于 0。
     *
     * 后果不是报错，是"语义相似度永远算不出来"：词典是按汽车/感知领域手工建的
     * （96 个同义词组），任何非该领域的 JD（HR、财务、后端…）相似度全是 0。
     * 而 scoreProjects 的语义分支是 kwScore*0.5 + semScore*100*0.5 ——
     * 语义恒 0 意味着一旦打开语义开关，这些岗位的项目经验维会被【腰斩】。
     * 这正是"要不要开语义"这个决策一直悬着的原因：开了会变差，但没人知道为什么。
     *
     * 修法：单字中文不再丢弃，并对连续中文补字符二元组（bigram）。
     * 二元组是无词典中文匹配的标准做法，能让"订单风控引擎"与"订单风控引擎的规则编排"
     * 通过 订单/单风/风控/控引/引擎 产生真实重叠，而不是双双归零。
     */
    function _canon(tokens) {
      var r = [];
      var cjkRun = '';
      function flushRun() {
        // 对连续单字中文补 bigram（"订单风"→订单、单风），长度 1 的孤字也保留
        if (cjkRun.length >= 2) {
          for (var b = 0; b < cjkRun.length - 1; b++) r.push(cjkRun.substr(b, 2));
        }
        cjkRun = '';
      }
      for (var i = 0; i < tokens.length; i++) {
        var t = String(tokens[i]).toLowerCase();
        if (!t || !t.trim()) { flushRun(); continue; }
        var isSingleCjk = t.length === 1 && /[一-龥]/.test(t);
        if (isSingleCjk) {
          cjkRun += t;
          r.push(t);              // 单字本身也保留（老实现在这里直接丢，导致全空）
          continue;
        }
        flushRun();
        if (t.length < 2 && !/[a-z0-9]/i.test(t)) continue;  // 纯符号才丢
        r.push(CANONICAL[t] || t);
      }
      flushRun();
      return r;
    }
    function _tf(tokens) { var tf = {}; for (var i = 0; i < tokens.length; i++) { var t = tokens[i]; tf[t] = (tf[t] || 0) + 1; } return tf; }
    function _idf(t) { if (!t) return 1; if (/^\d+$/.test(t)) return 0.3; if (t.length <= 1) return 0.5; if (t.length >= 4) return 1.5; return 1.0; }
    function _cosine(tf1, tf2) {
      var dot = 0, n1 = 0, n2 = 0;
      for (var k in tf1) { if (Object.prototype.hasOwnProperty.call(tf1, k)) { var w1 = tf1[k] * _idf(k); n1 += w1 * w1; if (tf2[k]) { var w2 = tf2[k] * _idf(k); dot += w1 * w2; } } }
      for (var k2 in tf2) { if (Object.prototype.hasOwnProperty.call(tf2, k2)) { var w3 = tf2[k2] * _idf(k2); n2 += w3 * w3; } }
      for (var h2 in hyper) { if (Object.prototype.hasOwnProperty.call(hyper, h2) && tf1[h2]) { var hy2 = hyper[h2]; for (var hi2 = 0; hi2 < hy2.length; hi2++) { if (tf2[hy2[hi2]]) dot += (tf1[h2] * _idf(h2) * 0.5) * (tf2[hy2[hi2]] * _idf(hy2[hi2])); } } }
      if (n1 === 0 || n2 === 0) return 0;
      return dot / (Math.sqrt(n1) * Math.sqrt(n2));
    }
    function _similarity(a, b) {
      if (!a || !b) return 0;
      var ta = _canon(_tokenize(a)), tb = _canon(_tokenize(b));
      return Math.min(1, _cosine(_tf(ta), _tf(tb)) * 2.5);
    }
    function _kwSim(text, keyword) {
      var toks = _canon(_tokenize(text));
      var kwToks = _canon(_tokenize(keyword));
      if (!kwToks.length) return 0;
      var kwC = kwToks[0] || keyword.toLowerCase();
      for (var i = 0; i < toks.length; i++) {
        if (toks[i] === kwC) return 1.0;
        for (var h in hyper) {
          if (Object.prototype.hasOwnProperty.call(hyper, h)) {
            if (h === kwC && hyper[h].indexOf(toks[i]) !== -1) return 0.85;
          }
        }
      }
      return _similarity(text, keyword);
    }

    return {
      similarity: _similarity,
      kwSim: _kwSim,
      tokenize: _tokenize,
      _synonymCount: synGroups.length,
      _hypernymCount: Object.keys(hyper).length,
    };
  }

  // ──────────────────── 4. 领域扩充词表 ────────────────────────────────────
  // 一份开箱可用的通用专业词包（软件研发 / 财务 / 运营 / 产品 等常见方向）。
  // 它不绑定任何特定行业。你所在领域的专有词，配在自己岗位的
  // domain.keywords 与 tasks[].keywords 里，引擎会按岗位逐条注入。
  //
  // 用法：createSemanticProvider() 或 createSemanticProvider(DOMAIN_COMMON)
  var DOMAIN_COMMON = {
    segments: [
      '分布式', '微服务', '高并发', '高可用', '中间件', '架构设计', '技术选型',
      '性能优化', '容量规划', '稳定性', '容灾', '灰度', '发布', '回滚', '监控告警',
      '数据仓库', '数据湖', '离线计算', '实时计算', '数据治理', '指标体系',
      '自动化测试', '单元测试', '集成测试', '回归测试', '压测', '测试用例',
      '持续集成', '持续交付', '流水线', '容器化', '云原生', '弹性伸缩',
      '总账', '月结', '年结', '对账', '合并报表', '凭证', '科目', '成本核算',
      '税务申报', '预算编制', '预算控制', '费用报销', '审计配合', '内控',
      '采购', '供应商管理', '合同管理', '库存周转', '交付周期', '供应链',
      '用户增长', '转化率', '留存', '漏斗', 'A/B测试', '竞品分析', '需求评审',
      '项目管理', '跨部门协作', '资源协调', '里程碑', '风险管理', '流程优化',
      '团队管理', '人才培养', '绩效考核', '组织发展', '沟通协调', '推动落地',
      '合规', '风控', '数据安全', '权限管理', '审计留痕',
    ],
    extraSynonyms: [
      ['后端', '服务端', 'server', 'backend', '后台开发'],
      ['前端', 'web前端', 'frontend', 'h5', '界面开发'],
      ['微服务', 'springcloud', 'dubbo', 'rpc', '服务拆分', '服务治理'],
      ['高并发', '大流量', '高吞吐', 'qps', '并发量'],
      ['性能优化', '调优', '加速', '降低延迟', '响应优化'],
      ['容器', 'docker', 'k8s', 'kubernetes', '容器化'],
      ['ci', 'cd', '持续集成', '持续交付', '流水线', 'jenkins'],
      ['监控', '告警', '可观测', '监控告警', '日志分析'],
      ['自动化测试', '测试开发', '自动化', 'ui自动化', '接口自动化'],
      ['数据分析', 'bi', '报表分析', '数据洞察', '取数'],
      ['月结', '月度结账', '关账', '结账'],
      ['对账', '核销', '账务核对', '往来核对'],
      ['合并报表', '合并', '报表合并', '集团报表'],
      ['成本核算', '成本', '成本控制', '成本分析'],
      ['预算', '预算管理', '预算编制', 'budget'],
      ['采购', '采购管理', '寻源', '采购流程'],
      ['供应链', '供应计划', '采购交付', '物料计划'],
      ['项目管理', '项目推进', '项目交付', 'pm'],
      ['跨部门', '跨团队', '协同', '协作'],
      ['团队管理', '带团队', '团队负责人', 'leader'],
    ],
    extraHypernyms: {
      '后端': ['java', 'spring', 'mysql', 'redis', '微服务', '分布式', 'mq'],
      '财务': ['总账', '对账', '月结', '成本核算', '税务', '报表', '预算'],
      '运营': ['用户增长', '转化率', '留存', '活动运营', '数据分析'],
      '产品': ['需求分析', '原型', '竞品分析', '用户调研', '产品设计'],
      '管理': ['团队管理', '项目管理', '跨部门', '流程优化', '绩效考核'],
      '数据': ['sql', '数据分析', '数据仓库', '指标体系', 'bi'],
    },
  };

  // ──────────────────── 5. 导出 ─────────────────────────────────────────────
  var api = { createSemanticProvider: createSemanticProvider, DOMAIN_COMMON: DOMAIN_COMMON };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.__TA_SEMANTIC__ = api; }
})(__semRoot);
  var _sem = __semRoot.__TA_SEMANTIC__.createSemanticProvider();
  // 暴露 _similarity / _kwSim / _tokenize / _cut 到外层 IIFE 作用域——30-content.js 里
  // 的岗位自动识别走 _similarity(q, lbl)，这些名字是旧 parts/20-semantic.js 在闭包
  // 顶层 var 声明的，工厂化后它们变成局部变量，必须显式别名给 content 主逻辑用。
  var _similarity = _sem.similarity;
  var _kwSim = _sem.kwSim;
  var _tokenize = _sem.tokenize;
  var _cut = _sem.tokenize;   // 旧 10-tinyseg.js 顶层的 _cut，新工厂用 tokenize 替代（底层同一实现）

  // ================================================================
  // 模块 3: 评分引擎（构建时原样内联自 src/shared/scoring-universal.js）
  // ================================================================
  var __engineRoot = {};
/**
 * 通用评分引擎 v4 —— 纯 JS，无 Node/浏览器依赖，可在主进程与 content script (isolated world) 中共用。
 *
 * 架构：四层漏斗 + 校准
 *   L1  硬门槛过滤（Hard Filter）→ 任一硬门槛不达标 → mismatch 标记 + 原因
 *   L2  分维评分（满幅锚点 0-100，判不了的维度整体退出加权）
 *   L3  语义相似匹配（Semantic Match）→ 可选扩展，通过 setSemanticProvider 注入
 *   L4  加权汇总 → 必选词零命中闸门 → 单调校准拉伸 → 可解释输出
 *
 * v4（2026-07-30，针对"技术词表面命中掩盖域错配"的重造）：
 *   · 新增【应用域匹配 domainFit】：消费 jd.domain（industry/platform/scenes/sensors/adjacent/distant），
 *     判定候选人所在域与 JD 的距离（同域/相邻/远域/无信号）——这是人工 TA 给分差异的首要来源，
 *     v3 里同一堆技术词换个应用场景照样把硬技能维刷满，就是因为完全没看应用域；
 *   · 新增【JD 任务点覆盖 taskCoverage】：消费 jd.tasks（任务点列表 + domainSensitive 标记），
 *     按 direct / transfer / none 三级证据计分——domainSensitive 任务在异域命中必须显著折扣，
 *     非域敏感任务（如嵌入式部署、多目标跟踪）异域也按全额计，不搞一刀切；
 *   · 硬技能维带上域上下文：同域经历里命中的技术词比异域命中的权重高，
 *     进一步压制"相邻域技术词凑满硬技能分"的问题；
 *   · 新增【科研产出 researchOutput】维：顶会/论文/专利，权重小，工程岗不主导排序；
 *   · card / detail 两级 tier 差异化加强：card 层证据不足时不允许给出 ≥85 或 ≤15 的极端分，
 *     这是产品安全底线——卡片层的分会驱动真人决定点不点开，不许草率；
 *   · 权重重排：domainFit(20) + taskCoverage(20) 合计 40% 占主导，硬技能从 24 降到 16，
 *     项目经验从 9 降到 4，industry 降为 3（domainFit 已经消费域信号，industry 退化为纯行业词面匹配）。
 *
 * 主进程通过 src/main/services/scoring.ts 的包装调用此文件；
 * content script 通过 chrome.ts 注入时内联此文件，调用 window.__TA_SCORE__；
 * Chrome 扩展直接加载此文件。
 * 任何评分逻辑修改只在此处进行，避免多份实现分叉。
 */
(function (root) {
  'use strict';

  // ===================== 常量 =====================
  // 学历档位（P1-18 补全）：liepin 适配器会产出「博士后」「硕士研究生」，
  // MBA（工商管理硕士）归入硕士档。所有读档处必须经 degreeRank() 走同一口径。
  var DEGREE_RANK = { 中专: 0, 高中: 0, 大专: 1, 本科: 2, 硕士: 3, 硕士研究生: 3, MBA: 3, 博士: 4, 博士后: 5 };

  // 学历归一化统一函数（P1-18）：统一剥「及以上/以上」后缀、未知学历返回 undefined（不猜档）。
  // 三处（硬门槛学历、经验维抵扣、学历维）共用，杜绝一处剥一处不剥的归一化漂移。
  function degreeRank(s) {
    if (s == null) return undefined;
    var r = DEGREE_RANK[String(s).replace(/及以上|以上/g, '').trim()];
    return r != null ? r : undefined;
  }

  // P1-21：数组清洗。Array.isArray 判定，拒绝 `|| []`（挡不住类型错误的非空标量，
  // 如 skills='foo'、keywords.required=5）。元素逐个滤掉 null/undefined，
  // 避免下游 reading 'company'/'weight' 抛 TypeError。onlyObj 时连标量元素也滤掉。
  function arrOf(x, onlyObj) {
    if (!Array.isArray(x)) return [];
    return x.filter(function (el) {
      if (el == null) return false;
      if (onlyObj) return typeof el === 'object' && !Array.isArray(el);
      return true;
    });
  }

  // P1-21：research 数值字段必须 Number.isFinite 校验，否则 research={papers:'x'}
  // 直接让 total 变 NaN 流到落库与 UI。
  function fin(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  }

  // P1-21：数值字段统一强转。字符串数字（'3'）→ 3；'x'/NaN/Infinity/对象 → null
  // （视为"无信息"而非参与 NaN 运算）。experienceYears/age 等在归一化处过一遍，
  // 杜绝 `gap = 'x' - '3' = NaN` 这类字符串相减污染总分。
  function numOrNull(x) {
    if (x == null || x === '') return null;
    var n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  // 学历超配折算年限（P1-18 抽取为共享 helper）：候选人学历高于 JD 要求一档折 2 年、两档折 4 年。
  // 硬门槛（checkHardFilters）与经验维（scoreExperience）必须用同一份折算，否则一个说
  // 「视同满足」、另一个判 mismatch，同一次评分自相矛盾（P1-18 问题 A）。
  function degreeYearCredit(c, jd) {
    if (!jd.basic || !jd.basic.degree || !c.degree) return 0;
    var reqRank = degreeRank(jd.basic.degree);
    var candRank = degreeRank(c.degree);
    if (reqRank == null || candRank == null) return 0;
    if (candRank > reqRank) return Math.min(2, candRank - reqRank) * 2;
    return 0;
  }

  // 权重模板（14 维）。
  // ⚠️ 合计不是 100（default=107 / tech=105 / functional=106 / management=105），也不需要是：
  // scoreCandidate 最后按【实际参与加权的维度之和】归一化，所以只有维度间的【比例】有意义。
  // 别为了凑整去改数字——改比例就是改评分口径，会动 score:eval 的硬门槛。
  // src/shared/constants.ts 的同名表必须与本表逐键相等（contract-check 第 14 节比数值）。
  // v4 新增 domainFit（应用域匹配）、taskCoverage（JD任务点覆盖）、researchOutput（科研产出）：
  // 老配置里没有这三个键时，引擎用模板默认值补上（scoreCandidate 里逐维 fallback），
  // 无需迁移已保存的权重。同时 v4 调整了 tech 模板下 keywords/projects/industry 的权重，
  // 让 domainFit + taskCoverage 合计 40（default/tech）~36（functional/management）占主导。
  // ⚠️ 不含 researchOutput（P1-23）：该维无任何写入点（src/main、插件 parts 均不采
  // 科研产出），恒 notApplicable 退出加权，3% 权重从不参与——保留会让「14 维」口径
  // 失真。已移除并把权重重新分配进主导维（见各模板备注）。contract-check 逐键比对。
  var WEIGHT_TEMPLATES = {
    default: {
      positionFit: 12, domainFit: 21, taskCoverage: 22, keywords: 16, experience: 9,
      degree: 5, industry: 3, companyTier: 3, projects: 4,
      salary: 3, location: 4, age: 2, stability: 3,
    },
    tech: {
      positionFit: 12, domainFit: 20, taskCoverage: 22, keywords: 19, experience: 8,
      degree: 4, industry: 3, companyTier: 2, projects: 5,
      salary: 2, location: 3, age: 2, stability: 3,
    },
    functional: {
      positionFit: 15, domainFit: 16, taskCoverage: 20, keywords: 12, experience: 10,
      degree: 7, industry: 5, companyTier: 5, projects: 4,
      salary: 4, location: 4, age: 2, stability: 2,
    },
    management: {
      positionFit: 12, domainFit: 16, taskCoverage: 18, keywords: 10, experience: 15,
      degree: 7, industry: 6, companyTier: 7, projects: 4,
      salary: 3, location: 3, age: 2, stability: 2,
    },
  };

  // card 层极端分压制常数（M5）：卡片层信息有限，证据不足时不允许给出太极端的分，
  // 这是产品安全底线——卡片分驱动"点不点开"这个真人决策，草率给 90 或 10 会误事。
  // detail 层不受此限。
  var CARD_MAX = 85;
  var CARD_MIN = 15;

  // ── 校准拉伸（v3）────────────────────────────────────────────────────────
  // 加权平均天然向心（k 个独立维度的均值方差按 1/√k 收缩），即便分维已是满幅，
  // 总分也会往中间挤。这里把聚合分过一条【单调】曲线：S 形（中心 55、斜率 1/11）
  // 与恒等函数按 65/35 混合——排序不变（单调），只把 45-75 的密集区拉开。
  // 对照工业做法：Platt scaling 同样用单调 sigmoid 重整分布而不动排序。
  function calibrate(x) {
    var s = 100 / (1 + Math.exp(-(x - 55) / 11));
    return Math.max(0, Math.min(100, Math.round(0.35 * x + 0.65 * s)));
  }

  // 关键词特异性权重：越长/越专业的词，命中越说明问题（"大型分布式系统性能调优" >> "系统"）。
  // 通用短词人人都有，给同样的权重只会稀释区分度——对照 ATS 实践中的 keyword weighting。
  function kwWeight(k) {
    var s = String(k || '').trim();
    if (!s) return 1;
    var cjk = /[一-龥]/.test(s);
    if (cjk) return s.length >= 4 ? 1.5 : s.length >= 3 ? 1.25 : 1;
    return s.length >= 8 ? 1.5 : s.length >= 5 ? 1.25 : 1;
  }

  // 覆盖度低于此值不给 high 等级（见 scoreCandidate 里的说明）。
  // 2026-07-29 上调 60→75：60 挡不住"资料越少分越高"这个偏置。
  // 实测反例（真机 JD + 推荐卡样本）：只有职位/城市/学历/期望薪资的稀疏卡片，
  // 因为工作年限/公司层级/项目经验三维全部"无数据"被整体免罚，覆盖度 74% 仍评到 89 分 high；
  // 而资料齐全、明显更对口的候选人，项目经验维拿到真实分数 50 反被拖到 74 medium。
  // 缺失即免罚是维度剔除机制的固有副作用，只能靠覆盖度门槛兜住——门槛必须高于
  // "只有卡片基础字段"那一档（约 74%），才能真正要求"证据充分"。
  var MIN_COVERAGE_FOR_HIGH = 75;

  // 「敢不敢下否定结论」的覆盖度下限。低于它，引擎没资格说这个人不合适——
  // 只能说「没看清」。与 MIN_COVERAGE_FOR_HIGH 对称：一个管高分要证据，一个管低分要证据。
  // 取 60 的依据：2026-08-07 用 10 份进面简历 + 20 例跨岗错配实测，
  // 进面样本覆盖度最低 61%，跨岗错配样本 95% 落在 60% 以下——60 这条线正好把两者分开。
  var MIN_COVERAGE_FOR_REJECT = 60;

  // 否定结论的文本体量下限（字符）。低于它 = 简历没抓全，不是人不行。见 scoreCandidate 里第二道托底。
  var MIN_TEXT_FOR_REJECT = 350;

  // 硬门槛（任一不达标即「岗位不符」）
  // degreeHard / experienceHard / salaryHard / cityHard 可通过 JD 或全局设置开关
  var DEFAULT_HARD_FLAGS = {
    degree: true,       // 学历低于要求 → 岗位不符
    experience: true,   // 经验低于下限 → 岗位不符
    salary: false,      // 薪资超预算 → 默认只减分，不算硬门槛（可开）
    city: false,        // 城市不匹配 → 默认只减分，不算硬门槛（可开）
    age: false,         // 年龄超出 JD 声明区间 → 默认只减分；置 true 才作硬门槛
  };

  // ===================== 工具函数 =====================
  // 拉丁技术词的「词内字符集」——这些字符连在一起才算同一个 token。
  // 含 + # . _ - 是因为 C++ / C# / node.js / scikit-learn 都是一个词。
  var TOKEN_CHAR = /[A-Za-z0-9+#._-]/;
  var HAS_CJK = /[一-龥]/;

  // 词边界匹配，强/弱双轨。2026-08-07。
  //
  // 中文没有词边界可言（「感知算法」里找「感知」本就该命中），一律子串。
  // 拉丁词裸 indexOf 会制造假命中：GO 命中 Golang/Google、C 命中 C++。
  // 但**不能因此直接判不命中**——「微服务」出现在「微服务治理」里是真命中，
  // 一刀切的边界匹配会把这类复合技术词判脱靶，进而触发「必选词零命中封顶 55」把合格的人打到 60 以下。
  //
  // 所以分两档，服务于「60 分以下必须极其准确、60 分以上允许模糊」这条非对称要求：
  //   strong = 有词边界的命中 → 参与排序打分，可信
  //   weak   = 只有子串的命中 → **不参与加分，但足以否决「零命中」这道拒绝闸门**
  // 换言之：拿不准的证据只用于「不拒绝」，绝不用于「加分」。宁可少给分，不可错杀。
  function matchOneStrong(lowerText, k) {
    // 空关键词必须先挡住：下面 from = idx + 1 的步进对空串不收敛（indexOf('') 恒被钳到
    // 同一位置），会死循环挂死主进程 / content script。当前调用方都过滤了空值，这里是兜底。
    if (!k || !lowerText) return false;
    if (HAS_CJK.test(k)) return lowerText.indexOf(k) !== -1;
    var from = 0;
    for (;;) {
      var idx = lowerText.indexOf(k, from);
      if (idx === -1) return false;
      var before = idx > 0 ? lowerText.charAt(idx - 1) : '';
      var afterIdx = idx + k.length;
      var after = afterIdx < lowerText.length ? lowerText.charAt(afterIdx) : '';
      if ((!before || !TOKEN_CHAR.test(before)) && (!after || !TOKEN_CHAR.test(after))) return true;
      from = idx + 1;
    }
  }

  function matchKeywords(text, keywords) {
    var hit = [];
    var weak = [];
    if (!text || !keywords || !keywords.length) return { hit: hit, count: 0, weak: weak, weakCount: 0 };
    var lower = String(text).toLowerCase();
    for (var i = 0; i < keywords.length; i++) {
      var k = String(keywords[i]).trim().toLowerCase();
      if (!k) continue;
      if (matchOneStrong(lower, k)) hit.push(keywords[i]);
      else if (lower.indexOf(k) !== -1) weak.push(keywords[i]);
    }
    return { hit: hit, count: hit.length, weak: weak, weakCount: weak.length };
  }

  function arrayToText(arr) {
    if (!arr || !arr.length) return '';
    return arr.join(' ');
  }

  // 构造候选人「全量技能文本」——用于关键词和语义匹配
  function buildSkillText(c) {
    var parts = [];
    if (c.position) parts.push(c.position);
    if (c.skills && c.skills.length) parts.push(c.skills.join(' '));
    if (c.selfIntro) parts.push(c.selfIntro);
    // 工作经历
    if (c.workHistory && c.workHistory.length) {
      for (var i = 0; i < c.workHistory.length; i++) {
        var w = c.workHistory[i];
        if (w.company) parts.push(w.company);
        if (w.industry) parts.push(w.industry);
        if (w.description) parts.push(w.description);
        if (w.position) parts.push(w.position);
        // 2026-07-28：BOSS 卡片的 showWorks 还带业绩与平台抽好的技能标签，
        // 后者是质量最高的关键词来源（如 接口测试开发/Python/Jmeter/Selenium），必须计入
        if (w.performance) parts.push(w.performance);
        if (w.emphasis && w.emphasis.length) parts.push(w.emphasis.join(' '));
      }
    }
    // 注：教育经历（专业/院校）在下方已有统一处理，勿重复累加——重复会放大 TF 权重
    // 项目经历
    if (c.projects && c.projects.length) {
      for (var j = 0; j < c.projects.length; j++) {
        var p = c.projects[j];
        if (p.name) parts.push(p.name);
        if (p.desc) parts.push(p.desc);
        if (p.tech && p.tech.length) parts.push(p.tech.join(' '));
        if (p.role) parts.push(p.role);
      }
    }
    // 科研（v4）：顶会/论文/专利只在文本里轻量计入，由独立维度 researchOutput 主评；
    // 这里仅把 note 的关键词带给硬技能维，避免专利标题与公司/院校名污染 TF。
    if (c.research && c.research.note) parts.push(c.research.note);
    // 教育经历
    if (c.education && c.education.length) {
      for (var k = 0; k < c.education.length; k++) {
        var e = c.education[k];
        if (e.school) parts.push(e.school);
        if (e.major) parts.push(e.major);
      }
    }
    return parts.join(' ');
  }

  // 构造候选人【分段文本数组】——每段 = 一段独立经历（工作/项目/自我介绍/技能），
  // 用于 v4 的域判定与"同域命中关键词 vs 异域命中关键词"区分（M3）。
  // 因为域信息是随经历附着的（两个应用域可能同时出现在一个人的不同工作里），
  // 全量文本拼接会把这些上下文完全洗掉。
  function buildSegmentedText(c) {
    var segs = [];
    if (c.position) segs.push({ kind: 'profile', text: c.position, weight: 0.8 });
    if (c.selfIntro) segs.push({ kind: 'selfIntro', text: c.selfIntro, weight: 0.8 });
    if (c.skills && c.skills.length) segs.push({ kind: 'skills', text: c.skills.join(' '), weight: 0.6 });
    if (c.workHistory && c.workHistory.length) {
      for (var i = 0; i < c.workHistory.length; i++) {
        var w = c.workHistory[i];
        var t = [w.company, w.industry, w.position, w.description, w.performance,
          (w.emphasis && w.emphasis.length) ? w.emphasis.join(' ') : ''].filter(Boolean).join(' ');
        if (t) segs.push({ kind: 'work', text: t, weight: 1.0 });
      }
    }
    if (c.projects && c.projects.length) {
      for (var j = 0; j < c.projects.length; j++) {
        var p = c.projects[j];
        var pt = [p.name, p.desc, p.role, (p.tech && p.tech.length) ? p.tech.join(' ') : ''].filter(Boolean).join(' ');
        if (pt) segs.push({ kind: 'project', text: pt, weight: 0.9 });
      }
    }
    // ⚠️ 教育与科研必须在这里出现。2026-08-07 审查抓到的取材不一致：
    // scoreKeywords 在 JD 配了 domain 时走本函数、没配时走 buildSkillText，而 buildSkillText
    // 含 education（学校/专业）与 research.note，本函数原先两者都没有。后果是给岗位配上
    // 「应用域」（v4 主推配置）反而让技术证据主要在专业和论文里的人被判必选词零命中并封顶 55
    // ——实测同一候选人 total 从 91 掉到 52。两条取材路径必须等价。
    // 低权重：这类文本是背景证据，不该与工作经历同权；classifySegment 也天然把它归 none。
    if (c.education && c.education.length) {
      for (var e = 0; e < c.education.length; e++) {
        var ed = c.education[e];
        if (!ed) continue;
        var et = [ed.school, ed.major, ed.degree].filter(Boolean).join(' ');
        if (et) segs.push({ kind: 'edu', text: et, weight: 0.5 });
      }
    }
    if (c.research && c.research.note) segs.push({ kind: 'research', text: String(c.research.note), weight: 0.5 });
    return segs;
  }

  // 薪资解析
  function parseSalary(salaryStr) {
    if (!salaryStr) return null;
    var s = String(salaryStr);
    s = s.replace(/[·\*].*薪/g, '').replace(/\(.*?薪.*?\)/g, '').replace(/（.*?薪.*?）/g, '');
    var m = s.match(/(\d{1,3})\s*[-~到]\s*(\d{1,3})\s*[Kk千]/);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    var m2 = s.match(/(\d{1,3})\s*[Kk千](?:以上|以內|内)?/);
    if (m2) { var v = parseInt(m2[1], 10); return { min: v, max: v }; }
    var m3 = s.match(/(\d{4,6})\s*[-~到]\s*(\d{4,6})/);
    if (m3) return { min: Math.round(parseInt(m3[1], 10) / 1000), max: Math.round(parseInt(m3[2], 10) / 1000) };
    return null;
  }

  // 语义匹配 provider（可选，P1 注入）
  var semanticProvider = null;
  function setSemanticProvider(p) {
    semanticProvider = p;
  }
  function hasSemantic() {
    return !!(semanticProvider && semanticProvider.similarity);
  }
  // 语义相似度：返回 0-1，不可用时返回 null
  function semanticSim(textA, textB) {
    if (!hasSemantic() || !textA || !textB) return null;
    try {
      var s = semanticProvider.similarity(textA, textB);
      if (s == null || isNaN(s)) return null;
      return Math.max(0, Math.min(1, s));
    } catch (e) { return null; }
  }
  // 长文本 vs 单个关键词的相似度。provider 若提供了针对关键词优化的 kwSim（例如带上位词
  // 展开：命中"spring"也算命中"java"）就用它，没有就退回通用 similarity——老 provider 不受影响。
  function semanticKwSim(text, keyword) {
    if (!hasSemantic() || !text || !keyword) return null;
    if (!semanticProvider.kwSim) return semanticSim(text, keyword);
    try {
      var s = semanticProvider.kwSim(text, keyword);
      if (s == null || isNaN(s)) return null;
      return Math.max(0, Math.min(1, s));
    } catch (e) { return null; }
  }

  // ===================== L1 硬门槛 =====================
  function checkHardFilters(c, jd, hardFlags) {
    var reasons = [];
    // ⚠️ 必须【合并】而不是整体替换：JD 里只写了 {age:true} 时，
    // 整体替换会把默认开启的学历/经验硬门槛静默关掉。
    var flags = {};
    for (var dk in DEFAULT_HARD_FLAGS) { if (Object.prototype.hasOwnProperty.call(DEFAULT_HARD_FLAGS, dk)) flags[dk] = DEFAULT_HARD_FLAGS[dk]; }
    if (hardFlags) { for (var hk in hardFlags) { if (Object.prototype.hasOwnProperty.call(hardFlags, hk) && hardFlags[hk] != null) flags[hk] = hardFlags[hk]; } }

    // 学历
    if (flags.degree && jd.basic && jd.basic.degree && c.degree) {
      // ⚠️ 不能用 ||：中专/高中的 rank 是 0，是 falsy，|| 2 会把它们悄悄当成"本科"。
      // 实测后果：JD 要求中专、候选人大专 → 判 mismatch"大专，低于要求中专"，
      // 而学历维度同时给出"大专，高于要求 98 分"，同一次评分自相矛盾。
      // 与 scoreDegree(下方) 统一口径：认不出的学历要求视为"不设门槛"，不猜成本科。
      var req = degreeRank(jd.basic.degree);
      var got = degreeRank(c.degree);
      if (got != null && req != null && got < req) {
        reasons.push({ field: 'degree', label: '学历', detail: c.degree + '，低于要求' + jd.basic.degree });
      }
    }

    // 经验低于下限。P1-18 问题 A：学历超配折算【同样计入硬门槛】——
    // 否则经验维输出「1年+学历超配折算，视同满足 3年」、硬门槛却判 mismatch
    // 「1年，要求3以上年」，同一次评分自相矛盾。折算生效后达标就不再是 mismatch。
    if (flags.experience && jd.basic && jd.basic.experienceMin != null && c.experienceYears != null) {
      var effMin = c.experienceYears + degreeYearCredit(c, jd);
      if (effMin < jd.basic.experienceMin) {
        reasons.push({
          field: 'experience',
          label: '工作年限',
          detail: c.experienceYears + '年，要求' + jd.basic.experienceMin
            + (jd.basic.experienceMax != null ? '-' + jd.basic.experienceMax : '以上') + '年',
        });
      }
    }

    // 年龄超出 JD 声明区间（默认关）。
    // 只有 JD 明确写了 ageMin/ageMax 才可能触发——没有岗位依据就不该用年龄卡人。
    if (flags.age && jd.basic && (jd.basic.ageMin != null || jd.basic.ageMax != null) && c.age != null) {
      var aMin = jd.basic.ageMin != null ? jd.basic.ageMin : -Infinity;
      var aMax = jd.basic.ageMax != null ? jd.basic.ageMax : Infinity;
      if (c.age < aMin || c.age > aMax) {
        reasons.push({
          field: 'age', label: '年龄',
          detail: c.age + '岁，要求' + (jd.basic.ageMin != null ? jd.basic.ageMin : '不限') + '-' + (jd.basic.ageMax != null ? jd.basic.ageMax : '不限') + '岁',
        });
      }
    }

    // 薪资超预算（默认关）
    if (flags.salary && jd.basic && jd.basic.salaryMax != null && c.salary) {
      var ps = parseSalary(c.salary);
      if (ps && ps.min > jd.basic.salaryMax) {
        reasons.push({ field: 'salary', label: '薪资', detail: c.salary + '，超出预算' + jd.basic.salaryMax + 'K' });
      }
    }

    // 城市不匹配（默认关）
    if (flags.city && jd.basic && jd.basic.city && c.city) {
      if (c.city.indexOf(jd.basic.city) === -1 && jd.basic.city.indexOf(c.city) === -1) {
        reasons.push({ field: 'city', label: '城市', detail: c.city + ' ≠ ' + jd.basic.city });
      }
    }

    return reasons;
  }

  // ===================== L2 各维度评分 =====================

  function scoreExperience(c, jd, w) {
    var emin = jd.basic.experienceMin, emax = jd.basic.experienceMax;
    var years = c.experienceYears;
    if (years == null) {
      return { dimension: 'experience', label: '工作年限', score: 0, weight: w, status: 'partial', available: false, note: '无年限信息' };
    }
    if (emin == null && emax == null) {
      return { dimension: 'experience', label: '工作年限', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未设年限要求' };
    }
    // 学历超配抵扣年限（2026-08-07，只作用于本维的差距计算，不动硬门槛口径）：
    // 候选人学历高于 JD 要求一档折 2 年、两档折 4 年（硕士对本科要求 +2，博士对本科要求 +4）。
    // 依据两处独立事实：① 招聘进展表 575 条需求里，实际录用级别低于需求区间 82 次（31%）——
    // 「年限不足但学历/潜力补上」是真实录用常态；② 进面简历实测：2 年硕士对 5 年要求岗、
    // 1 年硕士对 3 年要求岗都被 TA 筛进了面试。不折算就是引擎替 TA 收紧了口径。
    var effYears = years + degreeYearCredit(c, jd);
    // v3 满幅锚点：差 1 年 50、差 2 年 28、差 3 年及以上贴地——"不够格"必须看得出来。
    // 硬门槛开着时低于下限本就 mismatch，这里的分数服务于硬门槛关掉/仅排序的场景。
    if (emin != null && effYears < emin) {
      var gap = emin - effYears;
      var sc = Math.max(8, 72 - gap * 22);
      return { dimension: 'experience', label: '工作年限', score: sc, weight: w, status: 'miss', note: years + '年，要求' + emin + (emax != null ? '-' + emax : '以上') + '年' };
    }
    if (emin != null && years < emin && effYears >= emin) {
      return { dimension: 'experience', label: '工作年限', score: 80, weight: w, status: 'partial', note: years + '年+学历超配折算，视同满足 ' + emin + '年' };
    }
    if (emax != null && years > emax + 3) {
      var over = years - emax - 3;
      return { dimension: 'experience', label: '工作年限', score: Math.max(45, 78 - over * 6), weight: w, status: 'warn', note: years + '年，超出要求较多（可能过高定级）' };
    }
    if (emax != null && years > emax) {
      return { dimension: 'experience', label: '工作年限', score: 88, weight: w, status: 'partial', note: years + '年，略超要求' };
    }
    return { dimension: 'experience', label: '工作年限', score: 96, weight: w, status: 'match', note: years + '年，完全匹配' };
  }

  // v4 硬技能评分（域上下文加权版本，见 scoreKeywordsV4 设计注释）：
  // 同一个技术词出现在同域经历里权重大、异域经历里权重打折；老 JD 不配 domain 时退化为 v3 行为。
  function scoreKeywords(c, jd, w, tier) {
    var req = jd.keywords.required || [];
    var bonus = jd.keywords.bonus || [];
    var neg = jd.keywords.negative || [];
    var reqTotal = req.length;
    var bonusTotal = bonus.length;
    var negTotal = neg.length;

    // 按段分桶：同域段、相邻段、远域段、其他段（skills/selfIntro/未判域）。
    // 与 scoreDomainFit / scoreTaskCoverage 保持一致的"远域传播"启发式。
    var domSets = jd.domain ? buildDomainKwSets(jd.domain) : null;
    var sameText = '', adjText = '', distText = '', otherText = '';
    var wSameKw = 0, wAdjKw = 0, wDistKw = 0, wOthKw = 0;
    if (domSets) {
      var segs = buildSegmentedText(c);
      for (var si = 0; si < segs.length; si++) {
        var seg = segs[si];
        var cls = classifySegment(seg.text, domSets);
        var len = String(seg.text).length;
        var lenW = len < 10 ? 0.3 : len < 60 ? 0.3 + 0.7 * (len - 10) / 50 : 1.0;
        var sw = (seg.weight || 1) * lenW;
        if (cls === 'same') { sameText += ' ' + seg.text; wSameKw += sw; }
        else if (cls === 'adjacent') { adjText += ' ' + seg.text; wAdjKw += sw; }
        else if (cls === 'distant') { distText += ' ' + seg.text; wDistKw += sw; }
        else { otherText += ' ' + seg.text; wOthKw += sw; }
      }
      // 远域传播：零同域 + 远域段权重占比 ≥30% → 把 other 段并入远域（半信）
      var totalKw = wSameKw + wAdjKw + wDistKw + wOthKw;
      if (wSameKw < 0.01 && totalKw > 0 && wDistKw / totalKw >= 0.3 && wOthKw > 0) {
        distText = distText + ' ' + otherText;
        wDistKw += wOthKw * 0.5;
        wOthKw = 0;
        otherText = '';
      }
    } else {
      otherText = buildSkillText(c);
    }
    var allText = (sameText + ' ' + adjText + ' ' + distText + ' ' + otherText).toLowerCase();
    var sameLow = sameText.toLowerCase(), adjLow = adjText.toLowerCase(), distLow = distText.toLowerCase(), othLow = otherText.toLowerCase();

    // 语义扩展：对未精确命中的必选词，用 provider 做相似度
    var semanticHits = [];
    var semanticHitCount = 0;
    if (hasSemantic() && reqTotal > 0) {
      for (var sm = 0; sm < req.length; sm++) {
        var kwl0 = String(req[sm]).trim().toLowerCase();
        if (allText.indexOf(kwl0) !== -1) continue;
        var sim = semanticKwSim(allText, req[sm]);
        if (sim != null && sim >= 0.7) { semanticHits.push({ keyword: req[sm], sim: sim }); semanticHitCount++; }
      }
    }

    // 弱命中（只有子串、没有词边界）——只用于否决「零命中」这道拒绝闸门，不参与任何加分。
    // 典型场景：必选词「微服务」，候选人写的是「微服务治理 / SpringCloud」。这是真本事，
    // 不能因为拿不到词边界就把人打到 60 以下。
    var weakReqHit = reqTotal > 0 ? matchKeywords(allText, req).weakCount : 0;

    var score;
    var status = 'match';
    var notes = [];
    var sameHit = 0, adjHit = 0, distHit = 0, othHit = 0;

    if (reqTotal === 0) {
      score = 50;
      status = 'partial';
      notes.push('无必选关键词');
    } else {
      var wAll = 0, wHit = 0;
      for (var ki = 0; ki < req.length; ki++) {
        var kwv = kwWeight(req[ki]);
        wAll += kwv;
        var kwls = String(req[ki]).trim().toLowerCase();
        // ⚠️ 必须走 matchOneStrong 而不是裸 indexOf。2026-08-07 审查抓到：那次「强/弱双轨」
        // 改造只把边界匹配接进了 note 与 zeroRequiredHit，算分循环仍是子串匹配 ——
        // 结果必选词 go 命中 Google、AI 命中 detail/maintain，弱命中拿满额分，
        // 与真命中的人同分。双轨的全部意义（弱命中只否决拒绝、不参与加分）当时等于没生效。
        var inSame = matchOneStrong(sameLow, kwls);
        var inAdj = !inSame && matchOneStrong(adjLow, kwls);
        var inDist = !inSame && !inAdj && matchOneStrong(distLow, kwls);
        var inOth = !inSame && !inAdj && !inDist && matchOneStrong(othLow, kwls);
        // 必选词是岗位的"硬技术门槛"（如 Java/分布式/部署），
        // 即便在异域经历里命中，也说明候选人具备该技术能力——这是可迁移的硬技能，折扣要轻；
        // 真正的域错配由 domainFit 维（20%权重）和 taskCoverage 的域敏感折扣（20%权重）承担。
        if (inSame) { wHit += kwv * 1.0; sameHit++; }
        else if (inAdj) { wHit += kwv * 0.92; adjHit++; }
        else if (inDist) { wHit += kwv * 0.75; distHit++; }
        else if (inOth) { wHit += kwv * 1.0; othHit++; }
      }
      for (var sh = 0; sh < semanticHits.length; sh++) wHit += kwWeight(semanticHits[sh].keyword) * 0.6;
      var ratio = wAll > 0 ? Math.min(1, wHit / wAll) : 0;
      score = Math.round(Math.pow(ratio, 1.3) * 100);
      var exactHit = sameHit + adjHit + distHit + othHit;
      if (exactHit + semanticHitCount < reqTotal) {
        status = 'partial';
        var brk = [];
        if (sameHit) brk.push('同域' + sameHit);
        if (adjHit) brk.push('相邻' + adjHit);
        if (distHit) brk.push('远域' + distHit);
        if (othHit) brk.push('其他' + othHit);
        notes.push('必选命中 ' + (exactHit + semanticHitCount) + '/' + reqTotal + (brk.length ? '（' + brk.join('/') + '）' : ''));
        if (semanticHitCount > 0) notes.push('语义近似 ' + semanticHitCount + '项');
      } else {
        notes.push('必选全命中');
      }
      if (exactHit + semanticHitCount === reqTotal) status = 'match';
    }

    // 加分词：同域 1.0 / 相邻 0.85 / 远域 0.6 / 其他 1.0，按有效命中数边际递减
    var BONUS_STEPS = [8, 5, 3, 2];
    var bonusSame = 0, bonusAdj = 0, bonusDist = 0, bonusOth = 0;
    for (var bi = 0; bi < bonus.length; bi++) {
      var bk = String(bonus[bi]).trim().toLowerCase();
      // 同 §必选词：加分词也只认强命中，弱命中一律不加分。
      if (matchOneStrong(sameLow, bk)) bonusSame++;
      else if (matchOneStrong(adjLow, bk)) bonusAdj++;
      else if (matchOneStrong(distLow, bk)) bonusDist++;
      else if (matchOneStrong(othLow, bk)) bonusOth++;
    }
    var bonusEff = bonusSame * 1.0 + bonusAdj * 0.95 + bonusDist * 0.8 + bonusOth * 1.0;
    var bonusEffInt = Math.ceil(bonusEff);
    for (var bs = 0; bs < bonusEffInt; bs++) score += bs < BONUS_STEPS.length ? BONUS_STEPS[bs] : 1;

    // 减分词：不分域
    var negHit = negTotal ? matchKeywords(allText, neg) : { count: 0, hit: [] };
    score -= negHit.count * 18;
    score = Math.max(0, Math.min(100, score));
    if (bonusTotal) notes.push('加分 ' + (bonusSame + bonusAdj + bonusDist + bonusOth) + '项');
    if (negHit.count) { status = 'miss'; notes.push('减分词 ' + negHit.count + '项: ' + negHit.hit.join(',')); }

    // exactHits：合并所有段的命中，保持字段形状（供 extractSkills 使用）
    var allExact = [];
    function pushMatches(text) { if (text) { var m = matchKeywords(text, req); for (var h = 0; h < m.hit.length; h++) allExact.push(m.hit[h]); } }
    pushMatches(sameText); pushMatches(adjText); pushMatches(distText); pushMatches(otherText);
    var allBonus = [];
    function pushBonus(text) { if (text) { var m = matchKeywords(text, bonus); for (var h2 = 0; h2 < m.hit.length; h2++) allBonus.push(m.hit[h2]); } }
    pushBonus(sameText); pushBonus(adjText); pushBonus(distText); pushBonus(otherText);
    var exactHitCount = sameHit + adjHit + distHit + othHit;

    return {
      dimension: 'keywords',
      label: '硬技能',
      score: score,
      weight: w,
      status: status,
      available: (reqTotal > 0 || bonusTotal > 0 || negTotal > 0),
      notApplicable: !(reqTotal > 0 || bonusTotal > 0 || negTotal > 0),
      note: notes.join('；'),
      exactHits: allExact,
      bonusHits: allBonus,
      negativeHits: negHit.hit || [],
      semanticHits: semanticHits,
      missed: Math.max(0, reqTotal - exactHitCount - semanticHitCount),
      reqTotal: reqTotal,
      // 只有「强命中 + 语义命中 + 弱命中」三者皆空，才算真的一个必选词都没沾上。
      // 弱命中在这里的唯一作用就是拦住误判——它不加分，只否决拒绝。
      zeroRequiredHit: reqTotal > 0 && exactHitCount === 0 && semanticHitCount === 0 && weakReqHit === 0,
      weakRequiredHit: weakReqHit,
    };
  }

  function scoreDegree(c, jd, w) {
    // JD 未设学历要求时 req=0（不设门槛），而非默认本科（P2 修复）
    // 与 checkHardFilters 同口径：统一走 degreeRank()（含剥「及以上/以上」、未知不猜档）
    var req = jd.basic.degree ? (degreeRank(jd.basic.degree) != null ? degreeRank(jd.basic.degree) : 0) : 0;
    var got = c.degree ? degreeRank(c.degree) : undefined;
    if (got == null) {
      return { dimension: 'degree', label: '学历', score: 0, weight: w, status: 'partial', available: false, note: '无学历信息' };
    }
    if (got >= req) {
      // v3：达标 88 / 高一档 96 / 高两档以上 90（超配略回落，与"过高定级"同理）
      var sc = got === req ? 88 : got === req + 1 ? 96 : 90;
      var extra = got > req ? '，高于要求' : '，满足要求';
      return { dimension: 'degree', label: '学历', score: sc, weight: w, status: 'match', note: c.degree + extra };
    }
    return { dimension: 'degree', label: '学历', score: 18, weight: w, status: 'miss', note: c.degree + '，低于要求' + jd.basic.degree };
  }

  function scoreIndustry(c, jd, w) {
    var companies = (c.workHistory || []).map(function (x) { return (x.industry || x.company || ''); }).join(' ');
    var pref = matchKeywords(companies, jd.industry.preferred);
    var exc = matchKeywords(companies, jd.industry.excluded);

    // 语义扩展：偏好行业的语义匹配
    var semanticPrefScore = null;
    if (hasSemantic() && jd.industry.preferred && jd.industry.preferred.length) {
      var prefText = jd.industry.preferred.join(' ');
      semanticPrefScore = semanticSim(companies, prefText);
    }

    if ((!jd.industry.preferred || !jd.industry.preferred.length) && (!jd.industry.excluded || !jd.industry.excluded.length)) {
      return { dimension: 'industry', label: '行业背景', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: '无行业偏好' };
    }
    if (exc.count) {
      return { dimension: 'industry', label: '行业背景', score: 8, weight: w, status: 'miss', note: '行业不符: ' + exc.hit.join(',') };
    }
    if (pref.count) {
      return { dimension: 'industry', label: '行业背景', score: 92, weight: w, status: 'match', note: '行业匹配: ' + pref.hit.join(',') };
    }
    // 语义近似命中
    if (semanticPrefScore != null && semanticPrefScore >= 0.55) {
      return {
        dimension: 'industry', label: '行业背景',
        score: Math.round(45 + semanticPrefScore * 45),
        weight: w, status: 'partial',
        note: '行业语义相关（' + Math.round(semanticPrefScore * 100) + '%）',
      };
    }
    if (!companies.trim()) {
      return { dimension: 'industry', label: '行业背景', score: 0, weight: w, status: 'partial', available: false, note: '未采集到公司/行业信息' };
    }
    return { dimension: 'industry', label: '行业背景', score: 38, weight: w, status: 'partial', note: '无明显匹配行业' };
  }

  // 公司层级
  function scoreCompanyTier(c, jd, w) {
    // v3：基线 45，增减幅放大——有信息时把层级差异真拉开（原版 ±5/10 全挤在 55-80）
    var score = 45;
    var notes = [];
    var allText = [c.companySize, c.companyStage, c.company, c.companyTag, c.companyBio].filter(Boolean).join(' ');
    // 一个字都没采集到就别硬给常数——那会让所有人都背上同一个分，把区分度冲掉
    if (!allText.trim()) {
      return { dimension: 'companyTier', label: '公司层级', score: 0, weight: w, status: 'partial', available: false, note: '未采集到公司信息' };
    }

    // 规模分
    if (allText.match(/10000人以上|万人/)) { score += 28; notes.push('万人级'); }
    else if (allText.match(/1000[-–—]9999人|千[人余]/)) { score += 20; notes.push('千人级'); }
    else if (allText.match(/500[-–—]999人/)) { score += 13; notes.push('中大型'); }
    else if (allText.match(/100[-–—]499人/)) { score += 6; notes.push('中型'); }
    else if (allText.match(/\d+[-–—]?\d+人/) && allText.match(/[0-9]+\s*[-–—]\s*[0-9]+人/) && allText.match(/[0-9]+/)[0] < 50) {
      score -= 15; notes.push('小微');
    }

    // 融资/上市阶段
    if (allText.match(/上市|纳斯达克|港股|A股|NYSE|NASDAQ|HKEx/)) { score += 18; notes.push('上市'); }
    else if (allText.match(/D轮|E轮|F轮|Pre-IPO/)) { score += 12; notes.push('成熟期'); }
    else if (allText.match(/C轮|B轮/)) { score += 6; notes.push('成长期'); }
    else if (allText.match(/A轮|天使轮|未融资/)) { score -= 8; notes.push('早期'); }

    // 国企/外企/合资
    if (allText.match(/国企|央企|国有|国资委/)) { score += 10; notes.push('国企'); }
    if (allText.match(/外资|外企|外商独资|合资|500强|世界500/)) { score += 12; notes.push('外资/500强'); }

    // JD 偏好/避开
    var tierConf = jd.companyTier || {};
    if (tierConf.prefer && tierConf.prefer.length && c.company) {
      var m = matchKeywords(c.company, tierConf.prefer);
      if (m.count > 0) { score += 20; notes.push('偏好:' + m.hit.join(',')); }
    }
    if (tierConf.avoid && tierConf.avoid.length && c.company) {
      var a = matchKeywords(c.company, tierConf.avoid);
      if (a.count > 0) { score -= 30; notes.push('避开:' + a.hit.join(',')); }
    }

    score = Math.max(5, Math.min(100, score));
    return { dimension: 'companyTier', label: '公司层级', score: score, weight: w, status: notes.length ? 'match' : 'partial', note: notes.join(' ') || '无足够信息' };
  }

  function scoreSalary(c, jd, w) {
    if (!c.salary) {
      return { dimension: 'salary', label: '薪资', score: 0, weight: w, status: 'partial', available: false, note: '无薪资信息' };
    }
    // JD 压根没设预算 → 维度不适用（原版没有预算也给 90"在预算内"，是人人一样的假高分）
    if (jd.basic.salaryMax == null && jd.basic.salaryMin == null) {
      return { dimension: 'salary', label: '薪资', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未设预算' };
    }
    var parsed = parseSalary(c.salary);
    if (!parsed) {
      return { dimension: 'salary', label: '薪资', score: 0, weight: w, status: 'partial', available: false, note: c.salary + '（无法解析，不计入加权）' };
    }
    var jdMax = jd.basic.salaryMax != null ? jd.basic.salaryMax : Infinity;
    var jdMin = jd.basic.salaryMin != null ? jd.basic.salaryMin : 0;
    if (parsed.min <= jdMax && parsed.max >= jdMin) {
      return { dimension: 'salary', label: '薪资', score: 92, weight: w, status: 'match', note: c.salary + '，在预算内' };
    }
    if (parsed.min > jdMax) {
      var over = parsed.min - jdMax;
      var sc = Math.max(10, 62 - over * 7);
      return { dimension: 'salary', label: '薪资', score: sc, weight: w, status: 'miss', note: c.salary + '，超出预算' + jdMax + 'K' };
    }
    // 期望低于预算下限：便宜但可能级别不够，轻微保留
    return { dimension: 'salary', label: '薪资', score: 76, weight: w, status: 'partial', note: c.salary + '，低于预算下限' };
  }

  // 地理位置：增加同省梯度
  function scoreLocation(c, jd, w) {
    if (!jd.basic.city || jd.basic.city === '全国') {
      return { dimension: 'location', label: '地理位置', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未限城市' };
    }
    if (!c.city) {
      return { dimension: 'location', label: '地理位置', score: 0, weight: w, status: 'partial', available: false, note: '无城市信息' };
    }
    if (c.city.indexOf(jd.basic.city) !== -1 || jd.basic.city.indexOf(c.city) !== -1) {
      return { dimension: 'location', label: '地理位置', score: 98, weight: w, status: 'match', note: c.city };
    }
    // 同省梯度：判断两个城市是否同属一个省（简化启发式）
    var sameProvince = isSameProvince(c.city, jd.basic.city);
    if (sameProvince) {
      return { dimension: 'location', label: '地理位置', score: 52, weight: w, status: 'partial', note: c.city + '（同省）' };
    }
    return { dimension: 'location', label: '地理位置', score: 12, weight: w, status: 'miss', note: c.city + ' ≠ ' + jd.basic.city };
  }

  // 简化的同省判断：用常见省/市名前缀匹配
  function isSameProvince(cityA, cityB) {
    // 直辖市特殊处理
    var directCities = ['北京', '上海', '天津', '重庆', '深圳', '广州'];
    for (var i = 0; i < directCities.length; i++) {
      if (cityA.indexOf(directCities[i]) !== -1 && cityB.indexOf(directCities[i]) !== -1) return true;
    }
    // 提取省名（含「省」字的省）
    var provincePairs = [
      ['广东', '广州', '深圳', '珠海', '东莞', '佛山', '中山', '惠州', '汕头'],
      ['浙江', '杭州', '宁波', '温州', '嘉兴', '绍兴', '金华', '台州'],
      ['江苏', '南京', '苏州', '无锡', '常州', '南通', '扬州', '徐州'],
      ['四川', '成都', '绵阳', '德阳', '宜宾', '泸州'],
      ['湖北', '武汉', '宜昌', '襄阳', '荆州'],
      ['湖南', '长沙', '株洲', '湘潭', '岳阳'],
      ['福建', '福州', '厦门', '泉州', '漳州'],
      ['山东', '济南', '青岛', '烟台', '潍坊', '威海'],
      ['河南', '郑州', '洛阳', '开封', '新乡'],
      ['河北', '石家庄', '唐山', '保定', '廊坊'],
      ['安徽', '合肥', '芜湖', '蚌埠', '马鞍山'],
      ['江西', '南昌', '九江', '赣州', '宜春'],
      ['陕西', '西安', '咸阳', '宝鸡'],
      ['辽宁', '沈阳', '大连', '鞍山'],
      ['黑龙江', '哈尔滨', '大庆', '齐齐哈尔'],
      ['吉林', '长春', '吉林', '延边'],
      ['云南', '昆明', '大理', '丽江'],
      ['贵州', '贵阳', '遵义', '六盘水'],
      ['广西', '南宁', '桂林', '柳州'],
      ['山西', '太原', '大同', '临汾'],
      ['甘肃', '兰州', '天水', '酒泉'],
      ['内蒙', '呼和浩特', '包头', '鄂尔多斯'],
      ['新疆', '乌鲁木齐', '喀什'],
      ['海南', '海口', '三亚'],
      ['宁夏', '银川', '石嘴山'],
      ['青海', '西宁', '海东'],
      ['西藏', '拉萨', '林芝'],
    ];
    for (var p = 0; p < provincePairs.length; p++) {
      var foundA = false, foundB = false;
      for (var c = 0; c < provincePairs[p].length; c++) {
        if (cityA.indexOf(provincePairs[p][c]) !== -1) foundA = true;
        if (cityB.indexOf(provincePairs[p][c]) !== -1) foundB = true;
      }
      if (foundA && foundB) return true;
    }
    // 省名直接匹配
    if (cityA.indexOf('省') !== -1 && cityB.indexOf('省') !== -1) {
      var a = cityA.substring(0, cityA.indexOf('省') + 1);
      var b = cityB.substring(0, cityB.indexOf('省') + 1);
      if (a === b) return true;
    }
    return false;
  }

  // 年龄维度。
  //
  // 设计原则：**只在 JD 明确声明了年龄区间（basic.ageMin/ageMax）时才参与评分**，
  // 没声明就整个维度退出加权（available:false）。理由有两条，一条实务一条合规：
  //   · 实务：没有岗位依据的年龄偏好不是"匹配度"，把它算进分只会污染排序；
  //   · 合规：就业年龄歧视在国内有实际法律风险，把判据绑定到 JD 的明示要求上，
  //     既可审计（每条打分都带 note 说明依据），也把责任落在岗位定义而不是隐式规则里。
  // 命中区间给高分，越界按距离线性衰减而不是一刀切，避免边界上 1 岁之差断崖。
  function scoreAge(c, jd, w) {
    var lo = jd.basic.ageMin;
    var hi = jd.basic.ageMax;
    if (lo == null && hi == null) {
      return { dimension: 'age', label: '年龄', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未设年龄要求' };
    }
    if (c.age == null) {
      return { dimension: 'age', label: '年龄', score: 0, weight: w, status: 'partial', available: false, note: '无年龄信息' };
    }
    var a = c.age;
    var min = lo != null ? lo : -Infinity;
    var max = hi != null ? hi : Infinity;
    if (a >= min && a <= max) {
      return { dimension: 'age', label: '年龄', score: 95, weight: w, status: 'match', note: a + '岁，符合要求' };
    }
    var over = a > max ? a - max : min - a;
    var sc = Math.max(20, 85 - over * 12); // 每超 1 岁扣 12 分，地板 20
    return {
      dimension: 'age', label: '年龄', score: Math.round(sc), weight: w, status: over <= 2 ? 'warn' : 'miss',
      note: a + '岁，要求' + (lo != null ? lo : '不限') + '-' + (hi != null ? hi : '不限') + '岁',
    };
  }

  // 项目经验维度（新增）
  function scoreProjects(c, jd, w) {
    var jdDuty = (jd.responsibilities && jd.responsibilities.length) ? jd.responsibilities.join(' ') : '';
    var jdRequirements = (jd.keywords && jd.keywords.required) ? jd.keywords.required.join(' ') : '';
    var jdText = jdDuty || jdRequirements;

    if (!c.projects || !c.projects.length) {
      // 没有项目经历时，如果有工作经历描述，用工作经历文本代替
      var workText = (c.workHistory || []).map(function (x) { return (x.description || ''); }).join(' ');
      if (!workText && !jdText) {
        return { dimension: 'projects', label: '项目经验', score: 0, weight: w, status: 'partial', available: false, note: '无项目信息' };
      }
      if (!jdText) {
        return { dimension: 'projects', label: '项目经验', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD无职责描述' };
      }
      if (!workText) {
        return { dimension: 'projects', label: '项目经验', score: 0, weight: w, status: 'partial', available: false, note: '未采集到项目/工作经历' };
      }
    }

    var projText = (c.projects || []).map(function (p) {
      return [p.name, p.desc, p.role, (p.tech || []).join(' ')].filter(Boolean).join(' ');
    }).join(' ');
    if (!projText && c.workHistory) {
      projText = (c.workHistory || []).map(function (x) { return (x.description || ''); }).join(' ');
    }

    if (!projText || !jdText) {
      return { dimension: 'projects', label: '项目经验', score: 0, weight: w, status: 'partial', available: false, note: '信息不足' };
    }

    // 关键词命中（基础分）。v3：命中率过 1.2 次幂 ×85——项目正文里出现必选词
    // 是很强的证据，全中应逼近满幅；一半命中 ≈ 37 而不是原来的 30+20=50 中庸值
    var projKeywords = matchKeywords(projText, jd.keywords.required || []);
    var kwTotal = (jd.keywords.required && jd.keywords.required.length) || 0;
    var kwScore = kwTotal > 0 ? Math.pow(projKeywords.count / kwTotal, 1.2) * 85 : 40;

    // 语义匹配（加分）
    var semScore = null;
    if (hasSemantic()) {
      semScore = semanticSim(projText, jdText);
      if (semScore != null) {
        var finalScore = Math.round(kwScore * 0.5 + semScore * 100 * 0.5);
        return {
          dimension: 'projects', label: '项目经验',
          score: Math.max(0, Math.min(100, finalScore)),
          weight: w, status: finalScore >= 70 ? 'match' : finalScore >= 50 ? 'partial' : 'miss',
          note: '关键词命中 ' + projKeywords.count + '项，语义相似度 ' + Math.round(semScore * 100) + '%',
          projectCount: c.projects ? c.projects.length : 0,
        };
      }
    }

    // 无语义时纯关键词 + 项目数量小加成（边际递减，封顶 +12）
    var pc = c.projects ? c.projects.length : 0;
    var final2 = Math.round(Math.min(100, kwScore + Math.min(12, pc * 4)));
    return {
      dimension: 'projects', label: '项目经验',
      score: final2,
      weight: w,
      status: final2 >= 65 ? 'match' : final2 >= 40 ? 'partial' : 'miss',
      note: '关键词命中 ' + projKeywords.count + '/' + kwTotal,
      projectCount: pc,
    };
  }

  // ===================== v3 新维度 =====================

  // bigram Dice 相似度（中文友好、零依赖）。空串/单字回退到包含判断。
  function _bigramSet(s) {
    var out = {}; var n = 0;
    for (var i = 0; i < s.length - 1; i++) { var b = s.substr(i, 2); if (!out[b]) { out[b] = 1; n++; } }
    return { set: out, n: n };
  }
  function diceSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) ? 0.8 : 0;
    var A = _bigramSet(a), B = _bigramSet(b);
    var inter = 0;
    for (var k in A.set) { if (Object.prototype.hasOwnProperty.call(A.set, k) && B.set[k]) inter++; }
    if (!A.n || !B.n) return 0;
    return (2 * inter) / (A.n + B.n);
  }
  // 职位标题归一：去空白/标点/资历前后缀，只留职能与领域词
  function normTitle(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/[\s/\\|·．.。，,()（）\-—_~～【】\[\]]+/g, '')
      .replace(/(高级|资深|中级|初级|见习|助理|实习生|实习|专员|主管|经理|总监|leader|senior|junior|intern)/g, '');
  }
  // 职能族：跨写法的粗粒度对齐（"测试工程师"与"资深测试开发工程师"同族）。
  // 同族托底、异族封顶——职能对不上时不允许字面巧合把分抬高。
  // 2026-08-17 修复（roleFamily 顺序 bug）：原顺序里 ['开发','研发','程序','软件'] 在
  // ['项目','pmo'] 之前，导致「软件项目经理」归一化后含「软件」→ 先命中开发族，而「it项目经理」
  // 含「项目」→ 命中项目族；同是项目经理却被判异族，0.62 同族托底不生效，A 候选人(it项目经理 vs
  // 软件项目经理)只拿 39 分、卡片/详情双双误杀。把项目族提到开发族之前：「软件项目经理」先
  // 命中「项目」→ 项目族，「it项目经理」→ 项目族，同族 → 托底生效。「软件开发工程师」不含
  // 「项目」，仍落开发族，不受影响。
  var ROLE_FAMILIES = [
    ['项目', 'pmo', '项目经理'], ['测试', 'qa', '质量'], ['前端'], ['后端', '服务端'],
    ['算法'], ['数据'], ['嵌入式', '单片机', 'mcu'], ['硬件'],
    ['开发', '研发', '程序', '软件'], ['产品'], ['运营'], ['设计', 'ui', 'ue', '视觉'],
    ['销售', '客户'], ['人力', 'hr', '招聘'], ['财务', '会计', '审计'], ['采购', '供应链'],
  ];
  function roleFamily(t) {
    for (var i = 0; i < ROLE_FAMILIES.length; i++) {
      for (var j = 0; j < ROLE_FAMILIES[i].length; j++) {
        if (t.indexOf(ROLE_FAMILIES[i][j]) !== -1) return i;
      }
    }
    return -1;
  }
  // 领域归一：把职位里的行业领域词归到粗粒度领域标签，用于同族托底的领域感知（见 scorePositionFit）。
  // 同族 + 同领域 = 高置信同义（如 it项目经理 vs 软件项目经理，都是「软件/IT 领域的项目经理」）；
  // 同族但领域明确不同（如 财务项目管理 vs 软件项目经理）= 跨域，不许靠同族托底抬高。
  // 标签只用于「判断两边是不是同一个领域」，不参与打分本身，因此不必穷举行业。
  // 你所在行业的关键词若要参与对齐，配在岗位的 domain.keywords 里（那里才真正影响 domainFit）。
  function canonicalDomain(t) {
    var s = String(t || '').toLowerCase();
    if (/\bit\b|互联网|软件|数字化|信息/.test(s)) return 'sw';
    if (/制造|工厂|产线|供应链|质量/.test(s)) return 'mfg';
    if (/财务|会计|税务|审计|核算/.test(s)) return 'fin';
    if (/销售|商务|渠道|客户/.test(s)) return 'sales';
    if (/人力|招聘|人事|hr/.test(s)) return 'hr';
    return '';
  }

  // 职位匹配（v3 新增）：期望职位 vs JD 标题——卡片层最强的单一信号。
  // ATS 工业实践里 job title 相关性是与技能并列的头部特征；旧版完全没用它，
  // 卡片层只能靠技能标签碰运气，是"人人 50-65"的直接成因之一。
  function scorePositionFit(c, jd, w) {
    var targets = [];
    if (jd.title) targets.push(jd.title);
    if (jd.name && jd.name !== jd.title) targets.push(jd.name);
    if (!targets.length) {
      return { dimension: 'positionFit', label: '职位匹配', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD无标题' };
    }
    var cand = normTitle(c.position);
    if (!cand) {
      return { dimension: 'positionFit', label: '职位匹配', score: 0, weight: w, status: 'partial', available: false, note: '无期望职位' };
    }
    var best = 0, bestT = '';
    for (var i = 0; i < targets.length; i++) {
      var t = normTitle(targets[i]);
      if (!t) continue;
      var s = diceSim(cand, t);
      if (cand.indexOf(t) !== -1 || t.indexOf(cand) !== -1) s = Math.max(s, 0.82);
      var sem = semanticSim(c.position, targets[i]);
      if (sem != null) s = Math.max(s, sem * 0.95);
      // 职能族对齐（2026-08-17 领域感知改造）：
      //   · 同族 + 同领域（两侧领域都明确且相同，或任一侧无领域信号）→ 托底 0.62。
      //     it项目经理 vs 软件项目经理：都是 sw 领域的项目族 → 托底生效（修 roleFamily bug 后两者同族）。
      //   · 同族但两侧领域明确且不同（汽车项目管理 vs 软件项目经理：auto vs sw）→ 不给托底，
      //     让 dice 自然低，挡住跨域同族字面巧合被抬（B 候选人「跨域项目管理」不误升）。
      //   · 两侧职能族都明确但不同 → 封顶 0.35。
      // 任一侧无领域信号时仍按旧行为托底（向后兼容「产品经理」vs「B端产品经理」这类一侧无
      // 领域词的合理部分匹配，不回退到只看负向词的粗判）。
      var fa = roleFamily(cand), fb = roleFamily(t);
      var dc = canonicalDomain(c.position), dt = canonicalDomain(targets[i]);
      var domainConsistent = (dc === dt) || !dc || !dt;
      if (fa !== -1 && fa === fb && domainConsistent) s = Math.max(s, 0.62);
      else if (fa !== -1 && fb !== -1 && fa !== fb) s = Math.min(s, 0.35);
      if (s > best) { best = s; bestT = targets[i]; }
    }
    var score = Math.round(Math.pow(best, 0.85) * 100);
    return {
      dimension: 'positionFit', label: '职位匹配', score: score, weight: w,
      status: score >= 75 ? 'match' : score >= 45 ? 'partial' : 'miss',
      note: (c.position || '') + ' vs ' + bestT + '（相似 ' + Math.round(best * 100) + '%）',
    };
  }

  // 稳定性（v3 新增，详情层）：平均在职时长。跳槽频繁是 sourcing 实操里的一票关注项。
  // 卡片层拿不到完整履历 → 标 notApplicable（不拖累卡片层覆盖度）；
  // 详情层有 ≥2 段经历且有总年限时才计算，否则 available:false 如实进覆盖度。
  function scoreStability(c, jd, w, tier) {
    if (tier === 'card') {
      return { dimension: 'stability', label: '稳定性', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: '卡片层不评估' };
    }
    var n = (c.workHistory || []).length;
    if (n < 2 || c.experienceYears == null || c.experienceYears <= 0) {
      return { dimension: 'stability', label: '稳定性', score: 0, weight: w, status: 'partial', available: false, note: '履历段数/年限不足' };
    }
    var avg = c.experienceYears / n;
    var score, status, desc;
    if (avg >= 3) { score = 95; status = 'match'; desc = '平均在职 ' + avg.toFixed(1) + ' 年，稳定'; }
    else if (avg >= 2) { score = 82; status = 'match'; desc = '平均在职 ' + avg.toFixed(1) + ' 年'; }
    else if (avg >= 1.2) { score = 58; status = 'partial'; desc = '平均在职 ' + avg.toFixed(1) + ' 年，偏短'; }
    else if (avg >= 0.8) { score = 35; status = 'warn'; desc = '平均在职 ' + avg.toFixed(1) + ' 年，跳槽偏频繁'; }
    else { score = 18; status = 'miss'; desc = '平均在职 ' + avg.toFixed(1) + ' 年，跳槽频繁'; }
    return { dimension: 'stability', label: '稳定性', score: score, weight: w, status: status, note: desc };
  }

  // ===================== v4 新维度：domainFit / taskCoverage / researchOutput =====================
  //
  // 【应用域匹配 domainFit】
  // 设计：JD 声明一个核心域 D（platform + viewpoint + scenes + sensors 描述），
  // 候选人的每段经历/项目独立判断"落在哪个域"——用 jd.domain 给出的 adjacent[] 与 distant[]
  // 以及各域的平台/视角/场景关键词做文本匹配。逐段打分，按段长加权取平均，避免"一段异域经历把全
  // 文污染成同域"或"一段同域经历把全文救回来"的问题。
  //
  // 域距离四档：
  //   same      = 同域（平台+场景+视角都对上）→ 全额分
  //   adjacent  = 相邻域（同一大方向下的相邻应用场景）→ 中度分
  //   distant   = 远域（另一个不相干的业务场景）→ 低分
  //   none      = 无域信号 → 不计入
  //
  // 为什么不用语义模型：评分引擎要在插件 isolated world 里跑，没有语义 provider 兜底，
  // 必须纯关键词。JD 的 domain 配置本身就是关键词集合，配置者可以显式决定哪些算相邻/远域。
  //
  // 同域关键词：从 jd.domain 的 platform/viewpoint/scenes/sensors + industry 构造。
  // adjacent 关键词来自 jd.domain.adjacent[]，distant 关键词来自 jd.domain.distant[]。
  // 为了避免平台短词（如 "服务端"）误伤，我们对每段文本同时检查：
  //   · 命中同域词 ≥1 个 → same
  //   · 未命中同域，但命中相邻词 ≥1 → adjacent
  //   · 命中远域词 ≥1 → distant
  //   · 三者都没有 → none
  // 冲突优先级：distant > same > adjacent（一段里同时说"做过金融风控，也做过电商推荐"
  //   我们优先按远域折扣——保守给分，避免"两边都沾"的人被错误推高）。
  //   注：这里实际算法是"段级独立打标 + 段级累计权重"，所以冲突发生在段内时按上述优先级；
  //   跨段不冲突：金融段归金融、电商段归电商，按段长度加权平均。

  // 通用平台近义词：当 JD 写了 platform: "服务端" 时，这些词也视作同域信号。
  // 这里只放最通用的几种写法，避免过宽（比如不把"公司"算作"平台"的同域）。
  // 你所在行业特有的平台/载体会话，请加进 JD 的 domain.keywords —— 那才是本岗位真正生效的域信号。
  var PLATFORM_SYNONYMS = {
    '服务端': ['服务端', '后端', 'server', '云端', '服务集群'],
    '移动端': ['移动端', 'app', '手机', '客户端', '移动终端'],
    'web前端': ['web', '前端', '浏览器', 'h5', '页面端'],
    '桌面端': ['桌面端', '客户端', 'desktop', 'windows', 'mac'],
    '嵌入式': ['嵌入式', '固件', '硬件', '单片机', '设备端'],
    '机器人': ['机器人', 'robot', 'agv', 'amr', '机械臂', '无人车'],
    '云平台': ['云平台', '公有云', '私有云', 'k8s', '云原生'],
  };
  // scenes / viewpoint 的通用近义词：与上面同样的原则——只收最主流写法。
  var SCENE_SYNONYMS = {
    '在线交易': ['在线', '实时', '交易', '下单', '支付'],
    '批量处理': ['批量', '离线', '定时', '跑批', '对账'],
    '核心链路': ['核心', '主链路', '主干', '大促', '峰值'],
    '后台管理': ['后台', '管理端', 'b端', '中后台', '运营平台'],
    '面向用户': ['to c', 'toc', '用户端', '消费者'],
    '面向企业': ['to b', 'tob', '企业端', '商用'],
  };
  var SENSOR_SYNONYMS = {
    '数据采集': ['埋点', '采集', '日志', '上报'],
    '监控告警': ['监控', '告警', '可观测', '看板'],
  };

  // 展开同义词：把一个关键词数组按 PLATFORM/SCENE/SENSOR_SYNONYMS 展开，
  // 返回去重后的扁平数组。大小写已统一在 matchKeywords 里处理，这里保留原大小写即可。
  function expandSynonyms(kws, map) {
    var out = [];
    var seen = {};
    function add(w) {
      var k = String(w || '').trim().toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = 1;
      out.push(w);
    }
    for (var i = 0; i < kws.length; i++) {
      var w = kws[i];
      add(w);
      if (!map) continue;
      for (var key in map) {
        if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
        // 若关键词命中 map 的 key（即这个词是我们认识的领域词），把它的近义词全部加入
        if (w === key || w.indexOf(key) !== -1 || key.indexOf(w) !== -1) {
          for (var j = 0; j < map[key].length; j++) add(map[key][j]);
        }
      }
    }
    return out;
  }

  // 构造 JD 的域关键词集合同域/相邻/远域三套 + 同域锚点词（用来判定"这段是同域"的强信号）。
  //
  // ⚠️ 关键设计：通用能力词（如"监控告警"）虽然是同域特征，但很多域都在用，
  // 仅凭一个"监控"或"报表"出现在技能标签里，不能判定这个候选人
  // 就在做核心交易链路。所以把 same 集合拆成两层：
  //   same         = 全部同域词（锚点+传感器+同义词），用于"段已经判为同域后再做关键词命中计数"
  //   sameAnchor   = 仅平台/视角/场景/行业强锚点，用于"判定这个段属于哪个域"
  // 判定段为 same 时，必须至少命中 1 个 sameAnchor；只命中 sensor 词而没有锚点词，归入 other。
  // adjacent/distant 不拆：这两类词本身就是强域锚点（"支付""风控"一旦出现就是明确的域）。
  function buildDomainKwSets(domain) {
    if (!domain) return null;
    var anchor = [];     // 强域锚点：platform/viewpoint/scenes/industry
    var sensors = [];    // 传感器弱信号
    if (domain.industry) anchor.push(domain.industry);
    if (domain.platform) anchor.push(domain.platform);
    if (domain.viewpoint) anchor.push(domain.viewpoint);
    if (domain.scenes && domain.scenes.length) { for (var s = 0; s < domain.scenes.length; s++) anchor.push(domain.scenes[s]); }
    if (domain.sensors && domain.sensors.length) { for (var sn = 0; sn < domain.sensors.length; sn++) sensors.push(domain.sensors[sn]); }
    var adj = (domain.adjacent || []).slice();
    var dist = (domain.distant || []).slice();
    // 2026-08-07 修：原实现把 adj 并进 anchorAll，下面第 1024 行又用 anchorAll 过滤 adj，
    // 而两者经过同一组同义词展开，adj ⊆ anchorAll 恒成立 → adjClean 恒为空数组，
    // classifySegment 的 adjacent 分支永不可达，相邻域一律按同域走 92 档。
    // 这正是「相邻域排不开」的一半成因：相邻域不该拿满分。
    // 现在 sameAnchor 只由强域锚点（industry/platform/viewpoint/scenes）构成，adjacent 独立成档。
    var anchorAll = expandSynonyms(anchor, PLATFORM_SYNONYMS);
    anchorAll = expandSynonyms(anchorAll, SCENE_SYNONYMS);
    // adjacent 词本身展开后也用作"adjacent 段"判定
    adj = expandSynonyms(adj, PLATFORM_SYNONYMS);
    adj = expandSynonyms(adj, SCENE_SYNONYMS);
    // 传感器词单独展开，但不进 anchor 集合
    sensors = expandSynonyms(sensors, SENSOR_SYNONYMS);
    sensors = expandSynonyms(sensors, SCENE_SYNONYMS);
    dist = expandSynonyms(dist, PLATFORM_SYNONYMS);
    var sameFull = anchorAll.concat(sensors);
    // 去 adjacent 里已经在 dist 里的词
    function inArr(x, arr) {
      var xl = String(x).toLowerCase();
      for (var i = 0; i < arr.length; i++) if (String(arr[i]).toLowerCase() === xl) return true;
      return false;
    }
    var adjClean = [];
    for (var a = 0; a < adj.length; a++) { if (!inArr(adj[a], anchorAll) && !inArr(adj[a], dist)) adjClean.push(adj[a]); }
    return { same: sameFull, sameAnchor: anchorAll, sensors: sensors, adjacent: adjClean, distant: dist };
  }

  // 给一段文本打域标签：返回 'same' / 'adjacent' / 'distant' / 'none'。
  // 冲突优先级：distant > same > adjacent（保守给分——一段里既说金融又说电商时按远域算）。
  // 判定 same 时必须命中至少 1 个 sameAnchor（强域锚点）；只命中传感器词不算 same。
  function classifySegment(segText, sets) {
    if (!segText || !sets) return 'none';
    var hitDistant = matchKeywords(segText, sets.distant).count > 0;
    if (hitDistant) return 'distant';
    var hitAnchor = matchKeywords(segText, sets.sameAnchor).count > 0;
    if (hitAnchor) return 'same';
    var hitAdj = matchKeywords(segText, sets.adjacent).count > 0;
    if (hitAdj) return 'adjacent';
    return 'none';
  }

  function scoreDomainFit(c, jd, w, tier) {
    var dom = jd.domain;
    if (!dom) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未配置应用域' };
    }
    var sets = buildDomainKwSets(dom);
    if (!sets || (!sets.same.length && !sets.adjacent.length && !sets.distant.length)) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD域配置为空' };
    }

    // card 层：只能用 position / company / skills / selfIntro，拿不到完整经历描述，
    // 域信号很弱——只在 company 名或期望职位明确写出了同域/远域词时才给判断，否则 available:false。
    var segs;
    if (tier === 'card') {
      segs = [];
      if (c.position) segs.push({ kind: 'profile', text: c.position, weight: 1.0 });
      if (c.company) segs.push({ kind: 'company', text: c.company, weight: 1.2 });
      if (c.skills && c.skills.length) segs.push({ kind: 'skills', text: c.skills.join(' '), weight: 0.4 });
      if (c.selfIntro) segs.push({ kind: 'selfIntro', text: c.selfIntro, weight: 0.5 });
    } else {
      segs = buildSegmentedText(c);
    }
    if (!segs.length) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, note: '无文本可用于域判定' };
    }

    // 逐段分类加权
    var wSame = 0, wAdj = 0, wDist = 0, wNone = 0;
    var segEvid = { same: [], adjacent: [], distant: [] };
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var cls = classifySegment(seg.text, sets);
      // 段文本长度参与权重：10 字以下的公司名短句别跟一段 300 字的经历描述等权。
      // 启发式：长度 0-60 字线性插值 0.3→1.0，60 字以上封顶 1.0。
      var len = String(seg.text).length;
      var lenW = len < 10 ? 0.3 : len < 60 ? 0.3 + 0.7 * (len - 10) / 50 : 1.0;
      var sw = seg.weight * lenW;
      if (cls === 'same') { wSame += sw; segEvid.same.push(seg.kind); }
      else if (cls === 'adjacent') { wAdj += sw; segEvid.adjacent.push(seg.kind); }
      else if (cls === 'distant') { wDist += sw; segEvid.distant.push(seg.kind); }
      else { wNone += sw; }
    }
    var total = wSame + wAdj + wDist + wNone;
    if (total <= 0) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, note: '无域信号' };
    }
    // card 层若有信号段权重占比 < 30%，视为"信号太弱"——available:false 退出加权，
    // 避免凭一条公司名里的两个字就给出 80+ 的误判。
    var signalRatio = (wSame + wAdj + wDist) / total;
    if (tier === 'card' && signalRatio < 0.3) {
      return { dimension: 'domainFit', label: '应用域匹配', score: 0, weight: w, status: 'partial', available: false, note: '卡片层域信号不足' };
    }
    var rSame = wSame / total, rAdj = wAdj / total, rDist = wDist / total, rNone = wNone / total;

    // 【启发式】段级域信号传播：
    // 适用边界：当候选人【完全没有同域段】且远域段占比 ≥30% 时，没有域锚点词的段（skills 标签、
    // 项目名称里没写具体域）有较大概率是和远域工作同期做的（技能标签是整段工作的技能，
    // 不是独立于行业的抽象技能），把 none 段按"半信远域"处理——none 权重的一半并入远域、
    // 另一半保留中性。避免"异域候选人的技能标签段全给 55 中性分"抬高总分。
    // 失效场景：跨行业跳槽且老经历没写域词时，可能把中性段错归为远域。此时该候选人本来就复杂，
    // 给保守低分合理——详情层可以让 recruiter 看到任务点覆盖 note 后自行判断。
    // 当候选人【有同域段】时，不做传播——同域才是主方向，none 段保持中性更安全。
    var inferredDist = 0;
    if (wSame < 0.01 && rDist >= 0.3 && rNone > 0) {
      inferredDist = rNone * 0.5;
      rNone = rNone - inferredDist;
      rDist = rDist + inferredDist;
    }

    // 分数：same 段贡献 92、adjacent 贡献 55、distant 贡献 22、none 贡献 55（中性，不奖不罚）。
    // 常数基于通用招聘语义：同域=强对口、相邻=可迁移（给 55 而不是 50 略抬）、远域=要重新学
    // （给 22 而不是 15：保留"技术硬实力可迁移"的基础分，不至于让"域不对"把总分压到 30）。
    var score = Math.round(rSame * 92 + rAdj * 55 + rDist * 22 + rNone * 55);
    score = Math.max(0, Math.min(100, score));

    // 可解释 note：说清各档占比和证据来源
    var notes = [];
    if (rSame >= 0.1) notes.push('同域 ' + Math.round(rSame * 100) + '%（' + uniqJoin(segEvid.same) + '）');
    if (rAdj >= 0.1) notes.push('相邻域 ' + Math.round(rAdj * 100) + '%（' + uniqJoin(segEvid.adjacent) + '）');
    if (rDist >= 0.1) notes.push('远域 ' + Math.round(rDist * 100) + '%（' + uniqJoin(segEvid.distant) + (inferredDist > 0 ? '，含推断' : '') + '）');
    if (!notes.length) notes.push('无明确域信号');
    var status = score >= 75 ? 'match' : score >= 50 ? 'partial' : 'miss';
    return {
      dimension: 'domainFit', label: '应用域匹配', score: score, weight: w, status: status,
      note: notes.join('；'),
      // 暴露给硬技能/任务点维使用（M3）：这里返回的 rDist 包含推断部分，
      // 下游维也用这个传播后的比例——否则关键词/任务点在 none 段仍然按同域计，传播失效。
      _domainWeights: { same: rSame, adjacent: rAdj, distant: rDist, none: rNone },
    };
  }

  function uniqJoin(arr) {
    var seen = {}; var out = [];
    for (var i = 0; i < arr.length; i++) { if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); } }
    return out.join(',') || '—';
  }

  // 【JD 任务点覆盖 taskCoverage】（M2）
  //
  // 对每个 task（来自 jd.tasks）：
  //   direct   = 同域段命中关键词 → 按 task.weight 全额得分
  //   transfer = 异域（adjacent/distant）命中关键词 → 按折扣系数：
  //              · domainSensitive=true  + adjacent → 0.5（相邻域可迁移但要打五折）
  //              · domainSensitive=true  + distant  → 0.15（远域几乎不算，"支付风控"≠"推荐排序"）
  //              · domainSensitive=false + 任意异域 → 1.0（纯工程能力，哪里都能用，不打折）
  //   none     = 未命中 → 0
  //
  // 注意：判定"命中"用的是同域段的原文，不是全文——如果某词只在异域段出现，那它在该任务点
  // 最多算 transfer 分，而不是 direct 分。这是 M2 的核心：domainSensitive 任务要"同域+命中"
  // 才给 direct，异域命中一律折扣。
  //
  // 为什么折扣分两档（adjacent 0.5 / distant 0.15），不是统一 0：
  // 避免"一刀切压死异域候选人"——部署、性能优化这些非域敏感能力在别的域也是真本事，
  // 给它 1.0；核心链路的领域特有能力，异域做过的≠本域做过的，
  // 只是"补齐"不是本域深耕的，必须打狠折；相邻域做过同类机制、链路是通的，
  // 虽然没做过这个场景，但方法论与工程链路是可迁移的，给 0.5 合理。
  //
  // card 层：没有经历正文，taskCoverage 基本无证据 → notApplicable 退出加权，不进覆盖度分母。
  var TASK_DIRECT_SCORE = 1.0;
  var TASK_ADJ_SENSITIVE = 0.7;
  var TASK_DIST_SENSITIVE = 0.5;
  var TASK_TRANSFER_INSENSITIVE = 1.0;

  function scoreTaskCoverage(c, jd, w, tier) {
    var tasks = jd.tasks;
    if (!tasks || !tasks.length) {
      return { dimension: 'taskCoverage', label: '任务点覆盖', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: 'JD未配置任务点' };
    }
    if (tier === 'card') {
      // 卡片层完全没有经历正文 → 任务点命中判定不可靠，整维退出
      return { dimension: 'taskCoverage', label: '任务点覆盖', score: 0, weight: w, status: 'partial', available: false, notApplicable: true, note: '卡片层无法评估任务点覆盖' };
    }
    var segs = buildSegmentedText(c);
    if (!segs.length) {
      return { dimension: 'taskCoverage', label: '任务点覆盖', score: 0, weight: w, status: 'partial', available: false, note: '无经历/项目文本' };
    }
    // 先按段分组：同域段、相邻域段、远域段、未判域段（none/other）。
    var domSets = buildDomainKwSets(jd.domain || {});
    var sameText = '', adjText = '', distText = '', otherText = '';
    var sameSegs = [], adjSegs = [], distSegs = [], otherSegs = [];
    var wSame = 0, wAdj = 0, wDist = 0, wOth = 0;
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var cls = domSets ? classifySegment(seg.text, domSets) : 'none';
      var len = String(seg.text).length;
      var lenW = len < 10 ? 0.3 : len < 60 ? 0.3 + 0.7 * (len - 10) / 50 : 1.0;
      var sw = (seg.weight || 1) * lenW;
      if (cls === 'same') { sameText += ' ' + seg.text; sameSegs.push(seg); wSame += sw; }
      else if (cls === 'adjacent') { adjText += ' ' + seg.text; adjSegs.push(seg); wAdj += sw; }
      else if (cls === 'distant') { distText += ' ' + seg.text; distSegs.push(seg); wDist += sw; }
      else { otherText += ' ' + seg.text; otherSegs.push(seg); wOth += sw; }
    }
    // 【启发式】域信号传播：零同域 + 远域段权重 ≥30% → 把 other 段一半并入远域（与 scoreDomainFit 一致）。
    // 这让"技能标签/未写行业的项目"这些 none 段在整体远域背景下被正确当作远域处理，
    // 避免"分布式/高并发"这些出现在技能标签里时被算成"同域命中"。
    var totalSW = wSame + wAdj + wDist + wOth;
    var distInfer = 0;
    if (wSame < 0.01 && totalSW > 0 && wDist / totalSW >= 0.3 && wOth > 0) {
      // other 段文本按字符长度一半划入 distText（粗略：拼接后半段）
      distInfer = wOth * 0.5;
      wDist += distInfer; wOth -= distInfer;
      // 把 otherText 也并入一半给 distText（直接拼接——反正只是关键词命中检查，重复不影响）
      distText = distText + ' ' + otherText;
      otherText = '';
    }
    // 如果 domainFit 维完全没识别出同域/相邻/远域（domSets 空或都为 none），
    // 把所有文本当作"未判域"→ sameText，任务点命中按 direct 计——退化为纯关键词覆盖率，
    // 避免老 JD 不写 domain 时这一维全 0。
    var noDom = !domSets || (!sameText && !adjText && !distText);
    var fullText = sameText + ' ' + adjText + ' ' + distText + ' ' + otherText;
    if (noDom) { sameText = fullText; adjText = distText = otherText = ''; }

    // 逐任务点计分
    var totalW = 0, earnW = 0;
    var directHits = [], transferHits = [], misses = [];
    for (var t = 0; t < tasks.length; t++) {
      var task = tasks[t];
      var tw = task.weight || 1;
      var kws = task.keywords || [];
      if (!kws.length) { totalW += tw; earnW += tw * 0.5; continue; } // 没配关键词的任务给 0.5 中性分
      totalW += tw;
      var hitSame = matchKeywords(sameText, kws).count > 0;
      var hitAdj = !hitSame && adjText && matchKeywords(adjText, kws).count > 0;
      var hitDist = !hitSame && !hitAdj && distText && matchKeywords(distText, kws).count > 0;
      var hitOth = !hitSame && !hitAdj && !hitDist && otherText && matchKeywords(otherText, kws).count > 0;
      var hitAny = noDom ? matchKeywords(fullText, kws).count > 0 : (hitSame || hitAdj || hitDist || hitOth);
      if (!hitAny) {
        misses.push(task.label);
        continue;
      }
      if (hitSame || noDom) {
        earnW += tw * TASK_DIRECT_SCORE;
        directHits.push(task.label);
      } else if (hitOth) {
        // 出现在"未判域"段（技能标签、没写行业的项目）：
        //   · 有同域信号时（传播未触发）——保守按 adjacent 折扣，避免仅凭技能标签词给 direct；
        //   · 无同域但远域占比不高时（传播条件不满足）——仍按 adjacent 保守。
        // 非域敏感任务给全额，域敏感任务按 adjacent 折扣。
        if (!task.domainSensitive) { earnW += tw * TASK_TRANSFER_INSENSITIVE; transferHits.push(task.label + '(域无关,全计)'); }
        else { earnW += tw * TASK_ADJ_SENSITIVE; transferHits.push(task.label + '(未判域段×' + TASK_ADJ_SENSITIVE + ')'); }
      } else if (!task.domainSensitive) {
        // 异域命中但不敏感 → 全额
        earnW += tw * TASK_TRANSFER_INSENSITIVE;
        transferHits.push(task.label + '(域无关,全计)');
      } else if (hitAdj) {
        earnW += tw * TASK_ADJ_SENSITIVE;
        transferHits.push(task.label + '(相邻域×' + TASK_ADJ_SENSITIVE + ')');
      } else {
        // hitDist + domainSensitive
        earnW += tw * TASK_DIST_SENSITIVE;
        transferHits.push(task.label + '(远域×' + TASK_DIST_SENSITIVE + ')');
      }
    }
    if (totalW <= 0) {
      return { dimension: 'taskCoverage', label: '任务点覆盖', score: 50, weight: w, status: 'partial', note: '无有效任务点' };
    }
    // 覆盖率：把累计得分映射到 0-100。加一个幂次 0.9，让"覆盖一半任务点"不是 50 分而是 ~54 分，
    // 保持一点凸性但不激进——全中必须 100，零个命中必须贴近 0。
    var ratio = earnW / totalW;
    var score = Math.round(Math.pow(ratio, 0.9) * 100);
    score = Math.max(0, Math.min(100, score));

    var noteParts = [];
    if (directHits.length) noteParts.push('命中：' + directHits.join('、'));
    if (transferHits.length) noteParts.push('迁移：' + transferHits.join('、'));
    if (misses.length) noteParts.push('缺：' + misses.join('、'));
    var status = score >= 75 ? 'match' : score >= 45 ? 'partial' : 'miss';
    return {
      dimension: 'taskCoverage', label: '任务点覆盖', score: score, weight: w, status: status,
      note: noteParts.join('；'),
      directHits: directHits, transferHits: transferHits, misses: misses,
    };
  }

  // ===================== L4 汇总 + 可解释 =====================

  function extractHighlights(details) {
    var highlights = [];
    for (var i = 0; i < details.length; i++) {
      var d = details[i];
      // P1-20：available:false 的维恒为 score:0/status:'partial'（没数据），
      // 不是候选人的真实短板/亮点，必须剔除，否则"JD 未配置应用域"会冒充短板。
      if (d.notApplicable || d.available === false) continue;
      if (d.status === 'match' && d.score >= 85) {
        highlights.push({ label: d.label, note: d.note, score: d.score, dimension: d.dimension });
      }
    }
    // 按得分降序
    highlights.sort(function (a, b) { return b.score - a.score; });
    return highlights.slice(0, 3);
  }

  function extractGaps(details) {
    var gaps = [];
    for (var i = 0; i < details.length; i++) {
      var d = details[i];
      // P1-20：available:false 的维恒为 score:0/status:'partial'（没数据），
      // 且因升序排序会占满 gaps 前 3 位，把真实短板（硬技能/行业不符）挤掉。
      // 插件徽章直接渲染成「✗ 差距提示：应用域匹配：JD未配置应用域」——错误信息。
      if (d.notApplicable || d.available === false) continue;
      if (d.status === 'miss' || (d.status === 'partial' && d.score < 50)) {
        gaps.push({ label: d.label, note: d.note, score: d.score, dimension: d.dimension, severity: d.status === 'miss' ? 'hard' : 'soft' });
      }
    }
    // 按得分升序（最差的放前面）
    gaps.sort(function (a, b) { return a.score - b.score; });
    return gaps.slice(0, 3);
  }

  function extractSkills(keywordsDim) {
    return {
      exact: keywordsDim.exactHits || [],
      semantic: (keywordsDim.semanticHits || []).map(function (s) { return s.keyword + '(≈' + Math.round(s.sim * 100) + '%)'; }),
      bonus: keywordsDim.bonusHits || [],
      negative: keywordsDim.negativeHits || [],
      missingCount: keywordsDim.missed || 0,
    };
  }

  // ===================== 主入口 =====================

  function scoreCandidate(c, jd, thresholds, options) {
    var opts = options || {};
    // 就地改写入参会污染调用方（P1-22）：
    // 插件把 jdCache.jd 原对象递进来、rpa-engine 在无 scoreText 时把 card 本体递进去随后落库；
    // 传入 Object.freeze 的 jd/c 会直接抛 "Cannot add property basic"。
    // 归一化前先浅拷贝顶层——下面所有归一化都是整体重新赋值（jd.basic/jd.keywords/c.research），
    // 不就地改嵌套，所以浅拷贝足够且开销可忽略（对比深拷贝，避免 0.89ms/人 的性能劣化）。
    var jdInput = jd;
    var cInput = c;
    jd = jdInput && typeof jdInput === 'object' ? Object.assign({}, jdInput) : {};
    c = cInput && typeof cInput === 'object' ? Object.assign({}, cInput) : {};
    // JD 结构归一化（P1 修复：防止畸形 JD 抛 TypeError）。
    // keywords/industry 必须【重新构造】而不是浅拷贝引用：下面的 required/bonus/negative/
    // preferred/excluded 是就地赋值，若入参嵌套对象被 Object.freeze 会抛 "Cannot assign to
    // read only property"。构造全新对象即与入参彻底解耦（P1-22）。
    jd.basic = jd.basic || {};
    // P1-21：JD basic 数值字段强转（experienceMin/Max/ageMin/Max/salaryMin/Max）。
    // 脏值（'x'/NaN）→ null，参与比较时按"未设"处理，杜绝 `gap='x'-3=NaN`。
    if (jd.basic && typeof jd.basic === 'object') {
      jd.basic = Object.assign({}, jd.basic);
      jd.basic.experienceMin = numOrNull(jd.basic.experienceMin);
      jd.basic.experienceMax = numOrNull(jd.basic.experienceMax);
      jd.basic.ageMin = numOrNull(jd.basic.ageMin);
      jd.basic.ageMax = numOrNull(jd.basic.ageMax);
    }
    var jdKw = (jd.keywords && typeof jd.keywords === 'object') ? jd.keywords : {};
    // P1-21：required/bonus/negative 用 arrOf 清洗——`|| []` 挡不住非空标量（如 5），
    // 下面 jd.keywords.required.join 会 "join is not a function"。
    jd.keywords = {
      required: arrOf(jdKw.required),
      bonus: arrOf(jdKw.bonus),
      negative: arrOf(jdKw.negative),
    };
    var jdInd = (jd.industry && typeof jd.industry === 'object') ? jd.industry : {};
    jd.industry = { preferred: arrOf(jdInd.preferred), excluded: arrOf(jdInd.excluded) };
    jd.companyTier = jd.companyTier || {};
    // v4：domain/tasks/research 字段归一化（缺省不报错，整维 notApplicable 退出）。
    // P1-21：tasks 逐元素滤 null/非对象，避免下面 reading 'weight' 抛 TypeError。
    jd.domain = jd.domain || null;
    jd.tasks = arrOf(jd.tasks, true);
    // 候选人的数组字段同样清洗（P1-21）：skills 为字符串、workHistory/projects 含
    // null 元素、education 元素为标量，都是 658 例模糊测试里实测会抛的组合。
    c.skills = arrOf(c.skills);
    c.workHistory = arrOf(c.workHistory, true);
    c.projects = arrOf(c.projects, true);
    c.education = arrOf(c.education, true);
    // P1-21：候选人数值字段强转，字符串数字参与评分、脏值视为无信息。
    c.experienceYears = numOrNull(c.experienceYears);
    c.age = numOrNull(c.age);
    // 岗位职责归一化：引擎读顶层 jd.responsibilities，而平台的岗位库把它存在 jd.basic.responsibilities
    // （类型定义与 UI 都在 basic 下）。两边不一致时，用户在「岗位职责/核心工作」里填的内容
    // 【一个字都到不了引擎】。2026-08-03 审查查出，修在归一化处：落库位置不动，两处都认。
    //
    // 据实说明作用边界（别高估这条修复）：在 hasSemantic()==false（当前生产配置）下，
    // scoreProjects 只把 jdText 当"有没有依据"的门禁用，真正算分的是必选关键词命中率。
    // 所以只有【JD 没配必选关键词】时，这一栏才会改变结果（项目经验维从"信息不足/不计入"
    // 变成可评）。语义 provider 打开后它才直接参与算分。
    if ((!jd.responsibilities || !jd.responsibilities.length)
        && jd.basic && jd.basic.responsibilities && jd.basic.responsibilities.length) {
      jd.responsibilities = jd.basic.responsibilities;
    }
    if (c.research == null) c.research = null;

    var tpl = opts.weightTemplate ? WEIGHT_TEMPLATES[opts.weightTemplate] : WEIGHT_TEMPLATES.default;
    var weights = jd.weights || tpl;
    // v4：老 JD 保存的权重可能缺新键（domainFit/taskCoverage），用模板默认值兜底。
    // 不做整表替换：用户自定义过的键（如把 keywords 调 30）必须保留。
    var wDefaults = {
      positionFit: 12, domainFit: 21, taskCoverage: 22, keywords: 16, experience: 9,
      degree: 5, industry: 3, companyTier: 3, projects: 4,
      salary: 3, location: 4, age: 2, stability: 3,
    };
    // 合并：优先 jd.weights 自定义值 → 模板值 → wDefaults
    var w = {};
    for (var wk in wDefaults) {
      if (!Object.prototype.hasOwnProperty.call(wDefaults, wk)) continue;
      // ⚠️ 必须数值校验。2026-08-07 审查实测：<input type="number" v-model.number> 在用户清空
      // 输入框时产出空字符串，一路存进 jd.weights；下面 totalWeight 用 += 累加，一个字符串
      // 就把累加器变成字符串拼接 —— 同一 JD 下完美匹配的人从 98 掉到 0、coverage 89%→1%，
      // 整轮 RPA 的分全废且不报任何错。NaN/Infinity 则直接让 total 变 NaN 流到落库与 UI。
      // 非有限值或负数一律弃用，逐级回落，绝不让脏值进加权。
      var wv = weights ? Number(weights[wk]) : NaN;
      if (weights && weights[wk] != null && Number.isFinite(wv) && wv >= 0) w[wk] = wv;
      else if (tpl && Number.isFinite(Number(tpl[wk]))) w[wk] = Number(tpl[wk]);
      else w[wk] = wDefaults[wk];
    }

    var hardFlags = opts.hardFlags || (jd.hardFlags ? jd.hardFlags : DEFAULT_HARD_FLAGS);

    // 两级 tier：card = 只有列表卡片信息的速评；detail = 拿到详情/完整履历后的深评。
    // 不显式传就自动判：出现项目/教育经历/带正文的工作经历 → detail，否则 card。
    var tier = opts.tier;
    if (tier !== 'card' && tier !== 'detail') {
      var deepEvidence = (c.projects && c.projects.length)
        || (c.education && c.education.length);
      if (!deepEvidence && c.workHistory) {
        for (var we = 0; we < c.workHistory.length; we++) {
          if (c.workHistory[we] && (c.workHistory[we].description || '').length > 20) { deepEvidence = true; break; }
        }
      }
      tier = deepEvidence ? 'detail' : 'card';
    }

    // L1 硬门槛
    var mismatchReasons = checkHardFilters(c, jd, hardFlags);

    // L2+L3 各维度评分。
    // ⚠️ 保持每个元素都写成 scoreXxx(...) 形式：scripts/test-ext.mjs 通过正则从这里数维度数，
    // 用中间变量会让测试数错——见 test-ext.mjs:91 ENGINE_DIMS 注释。
    // 维度间通过共享的 buildDomainKwSets/classifySegment 自洽计算，不通过参数耦合。
    var details = [
      scorePositionFit(c, jd, w.positionFit),
      scoreDomainFit(c, jd, w.domainFit, tier),
      scoreTaskCoverage(c, jd, w.taskCoverage, tier),
      scoreKeywords(c, jd, w.keywords, tier),
      scoreExperience(c, jd, w.experience),
      scoreDegree(c, jd, w.degree),
      scoreIndustry(c, jd, w.industry),
      scoreCompanyTier(c, jd, w.companyTier),
      scoreProjects(c, jd, w.projects),
      scoreSalary(c, jd, w.salary),
      scoreLocation(c, jd, w.location),
      scoreAge(c, jd, w.age),
      scoreStability(c, jd, w.stability, tier),
    ];

    // 加权总分。
    //
    // ⚠️ 关键：把「判不了」的维度整个踢出加权（分子分母都不算），而不是给个中性分照常参与。
    // 真机 2026-07-28 暴露的问题：RPA 列表级模式只读推荐卡片，拿不到工作年限/公司/工作经历/项目，
    // 于是 experience/companyTier/projects/industry 对【每个人】都返回同一个常数，
    // 占掉 33%~45% 的权重。常数不产生区分度，只会把所有人朝中间拉——
    // 实测 47 人分数全挤在 53~58，高匹配 0 人，评分对筛人毫无价值。
    // 剔除后，分数由真正有数据的维度决定，区间自然拉开；同时输出 coverage 让使用者知道
    // 这个分基于多少信息（覆盖度低 = 需要开详情补数据）。
    // 两种"退出"语义：
    //   · notApplicable = JD 侧压根没提这个要求（如没配 domain/tasks、没配年龄区间）
    //     → 不是"数据缺失"，不该拖低覆盖度，分母里也要去掉；
    //   · available:false 且非 notApplicable = 候选人侧数据没采到 → 计入分母，拉低覆盖度。
    var usable = [];
    var allWeight = 0;
    for (var i = 0; i < details.length; i++) {
      if (details[i].notApplicable) continue;
      allWeight += details[i].weight;
      if (details[i].available !== false) usable.push(details[i]);
    }
    var pool = usable.length ? usable : details;
    var totalWeight = 0;
    for (var k = 0; k < pool.length; k++) totalWeight += pool[k].weight;
    if (totalWeight <= 0) totalWeight = 1;
    var total = 0;
    for (var j = 0; j < pool.length; j++) total += pool[j].score * pool[j].weight;
    total = total / totalWeight;
    total = Math.max(0, Math.min(100, total));
    var coverage = allWeight > 0 ? Math.round((usable.length ? totalWeight : 0) / allWeight * 100) : 0;

    // 校准拉伸（单调）：把加权均值天然堆积的 45-75 密集区拉开，排序不变。
    total = calibrate(total);

    // 必选词零命中闸门：JD 配了 ≥2 个必选词、精确+语义全部脱靶 → 总分封 55（单词 65）。
    // 硬技能是 must-have，不许被学历/薪资/城市这些 context 维凑成"看起来还行"的 70+。
    var gates = [];
    // 上界追踪（P1-17）：两道封顶（必选词零命中 / card CARD_MAX）先施加并记录到 upperCap，
    // 后到的证据托底若想把分抬上去，不得突破任何已施加的上界。
    var upperCap = Infinity;
    var kdim = null;
    for (var kd = 0; kd < details.length; kd++) if (details[kd].dimension === 'keywords') { kdim = details[kd]; break; }
    if (kdim && kdim.zeroRequiredHit) {
      var cap = kdim.reqTotal >= 2 ? 55 : 65;
      if (total > cap) {
        total = cap;
        gates.push('必选关键词零命中，总分封顶 ' + cap);
      }
      upperCap = Math.min(upperCap, cap);
    }

    // v4（M5）：card 层极端分压制。卡片层只有表面信息（职位/城市/学历/年限/公司/技能标签），
    // 域判定弱、任务点覆盖整维 notApplicable，给 90+ 或 10- 都是在误导真人做"点不点开"的决策。
    // detail 层有完整履历，才有证据做极端判断。
    if (tier === 'card') {
      if (total > CARD_MAX) {
        total = CARD_MAX;
        gates.push('卡片层信息有限，总分封顶 ' + CARD_MAX);
      } else if (total < CARD_MIN) {
        total = CARD_MIN;
        gates.push('卡片层信息有限，总分托底 ' + CARD_MIN);
      }
      upperCap = Math.min(upperCap, CARD_MAX);
    }

    total = Math.round(total);

    // 硬门槛不达标 → 总分封顶 45，并标记 mismatch
    var mismatch = mismatchReasons.length > 0;
    if (mismatch) total = Math.min(total, 45);

    // ============ 证据托底闸门（2026-08-07）============
    // 非对称要求：「低于 60 分」这一档必须极其准确（说不合适就是不合适，可以直接丢），
    // 「60 分以上」允许模糊（反正真人还会看）。所以拒绝必须有据，不能因为没采到数据就拒。
    //
    // 引擎此前把两件性质完全不同的事混同了：
    //   ① 确凿不符——学历/年限/城市明确越界（有 mismatchReasons），或证据充分但确实分低；
    //   ② 没采到——简历没解析出来、英文简历、卡片层字段稀疏。
    // ② 会让人拿到极低分。2026-08-07 实测：一份英文 CV 在生产配置下拿了 9 分，
    // 而这个人是进过面的——分低的原因是十几个维度全部 available:false，不是他不合格。
    //
    // 处置：够不着 low 线、又没有任何硬门槛证据、且覆盖度低于下限时 → 托底到 low 线，
    // 标 insufficientEvidence。它落进「待核」而不是「拒绝」，交回真人判断。
    // 注意不改 level 的枚举值（避免下游 UI/落库要跟着改），只是把人从可丢弃的那一桶里捞出来。
    // 但「覆盖度低」不等于「没看清」。判别性维度只要真评过、且评出来就是不匹配，
    // 那就是【看清了不合适】，该拒就拒——否则跨职能错配（做财务的人投技术岗）会全被托底放行，
    // 实测放宽到只看 coverage 时，跨岗错配识别率从 95% 掉到 45%。
    // 所以要求：判别性维度里至少有 2 个真的评过（有数据且 JD 提了要求），才承认拒绝有据。
    var DECISIVE = ['keywords', 'positionFit', 'domainFit', 'taskCoverage'];
    var decisiveEvaluated = 0;
    for (var dv = 0; dv < details.length; dv++) {
      var dd = details[dv];
      if (DECISIVE.indexOf(dd.dimension) === -1) continue;
      if (!dd.notApplicable && dd.available !== false) decisiveEvaluated++;
    }

    var loLine = thresholds && thresholds.low != null ? thresholds.low : 60;
    var insufficientEvidence = false;
    // 两道证据托底闸门对 coverage 的处理分档不同：
    //   · detail 层：coverage 仍是「信息是否足够下否定结论」的有效指标（进面样本覆盖度最低 61%，
    //     跨岗错配样本 95% 落在 60% 以下，60 这条线能把两者分开，见 MIN_COVERAGE_FOR_REJECT 注释）。
    //   · card 层：coverage 是反向指标 —— taskCoverage 在该层结构上 notApplicable、被剔出分母，
    //     缺失反而抬高 coverage。实测 13 张真顶卡全部 68~95%，MIN_COVERAGE_FOR_REJECT=60 永不触发，
    //     这条覆盖度门槛在 card 层形同虚设。所以 card 路径只认 decisiveEvaluated（真正评过的
    //     岗位专属维度个数），不再叠加 coverage 条件；detail 路径行为保持原样。
    if (!mismatch && total < loLine && decisiveEvaluated < 2
      && (tier === 'card' || coverage < MIN_COVERAGE_FOR_REJECT)) {
      insufficientEvidence = true;
      total = Math.min(loLine, upperCap);
      gates.push('证据不足（覆盖度 ' + coverage + '%，判别性维度仅 ' + decisiveEvaluated +
        ' 个可判），不作否定结论，托底 ' + total);
    }

    // 第二道证据托底：文本体量下限（2026-08-07，用飞书 62 份真实已终止样本实测出的洞）。
    // 覆盖度和判别性维度都骗得过残缺数据——一份只抓到 240 字顶卡的简历，keywords/domainFit
    // 照样"可判"，覆盖度照样 79%，然后引擎自信地给出 25 分。而这个人是简历评估通过、
    // 进过面试的（实测两例：岗位甲·候选人 C 25 分、岗位乙·候选人 A 35 分，均为文本残片）。
    // 判不了 ≠ 不合格：正文不足下限时不作否定结论。阈值 350 字的依据：真实简历正文
    // （含 OCR 版）最短 1000+ 字，残片均 <300 字，350 在两者之间留了余量。
    // 仅当既无成段文本、又无结构化字段（skills/education 全空）时才触发——
    // 有结构化卡片字段的稀疏候选人（BOSS 卡片层）照常判，那是真采到的证据。
    // 文本量按去重后的段落算：selfIntro 与 workHistory 常携带同一段文本，重复计数会骗过下限。
    var hasStructured = (c.skills && c.skills.length) || (c.education && c.education.length) ||
      (c.workHistory && c.workHistory.length > 1 && c.workHistory[0] && c.workHistory[0].company);
    if (!mismatch && !insufficientEvidence && total < loLine && !hasStructured) {
      var segsAll = buildSegmentedText(c);
      var uniqSeg = {};
      for (var tl = 0; tl < segsAll.length; tl++) uniqSeg[String(segsAll[tl].text || '')] = 1;
      var textLen = 0;
      for (var uk in uniqSeg) textLen += uk.length;
      if (textLen < MIN_TEXT_FOR_REJECT) {
        insufficientEvidence = true;
        total = Math.min(loLine, upperCap);
        gates.push('候选人文本仅 ' + textLen + ' 字（<' + MIN_TEXT_FOR_REJECT + '）且无结构化字段，证据体量不足，不作否定结论，托底 ' + total);
      }
    }

    // 等级
    var hi = thresholds && thresholds.high != null ? thresholds.high : 75;
    var lo = thresholds && thresholds.low != null ? thresholds.low : 60;
    var level = mismatch ? 'mismatch' : (total >= hi ? 'high' : total >= lo ? 'medium' : 'low');
    // 覆盖度太低时不得评为 high（高分会驱动自动打招呼这种对外动作，必须要求证据充分）。
    // v4（M5）：card 层天生低置信——没有经历正文，域判定弱、任务点覆盖整维退出，
    // 哪怕 coverage 看起来高（因为很多维 notApplicable 被剔出分母），也不许给 high 置信。
    // 只有 detail 层才有资格谈"高置信推荐"。
    var lowConfidence = (tier === 'card') || (coverage < MIN_COVERAGE_FOR_HIGH);
    if (level === 'high' && lowConfidence) level = 'medium';

    // 可解释输出
    var keywordsDim = null;
    for (var kdi = 0; kdi < details.length; kdi++) if (details[kdi].dimension === 'keywords') { keywordsDim = details[kdi]; break; }

    // ============ 卡片层三档判定（2026-08-11）============
    //
    // 【为什么卡片层不给数字分】
    // 真机症状：BOSS 插件一屏全是 85 分，毫无区分度。复现后根因清楚：
    // 卡片上只有职位名/公司/学历/年限/几个技能标签，而权重最大的两维
    // taskCoverage(22) + domainFit(21) —— 合计约 40% 权重 —— 在卡片层双双退出，
    // 剩下的全是"人人都拿高分"的通用维（年限 96 / 学历 96 / 行业 92 / 职位名相似 84），
    // 分数于是全部堆到 CARD_MAX=85 的天花板。实测「理想候选人」「空卡片（技能全无）」
    // 同为 85 分 —— 数字的精确感是假的，把它显示给 TA 只会消耗信任。
    //
    // 【三档怎么定：值得看必须有"正向证据"，不能只靠"没有负面证据"】
    // 这是本判定的核心。若只按 total 切档，空卡片（85）会和理想候选人（85）同档 ——
    // 那等于什么都没改。所以「值得看」额外要求岗位专属的正向信号：
    // 命中加分词 / 同域 / 必选词强命中。空卡片这些一个都没有，自然落到「一般」。
    //
    // detail 层不走这套：拿到完整履历后数字分是有意义的，照常输出。
    var cardVerdict = null;
    // 第四档「信息不足」：判别性维度评过的太少，既撑不起「值得看」也撑不起「不匹配」。
    // 判别性维度 = keywords / positionFit / domainFit / taskCoverage（岗位专属，通用维不算）。
    // 阈值 2 的依据：① 详情层证据托底同样要求 decisiveEvaluated ≥ 2 才承认拒绝有据（见上）；
    //   ② card 层 taskCoverage 结构上不可判，card 至多评 3 个判别维，<2 说明连"是不是干这行的"
    //   都没看清，这时不该下任何结论，归入「信息不足」。
    //
    // 两档都写本字段，三端（BOSS 插件 / BOSS RPA / 猎聘 RPA）只认 cardVerdict/cardVerdictLabel：
    //   · card 层：decisiveEvaluated < 2 → 'unknown'；但【可核验的硬门槛优先】——
    //     mismatch 成立说明学历/年限/年龄等字段确实采到了且明确越界（字段缺失时硬门槛根本
    //     不触发，见 checkHardFilters：c.degree 为空直接跳过），所以 fired 的硬门槛在卡片数据上
    //     就是可核验的拒绝依据（2026-08-11 决策，对应 A1 的例外条款：学历明示且低于要求即拒）。
    //     真正的 Rule 2(b) 场景（卡片没采到字段）压根不会走到 mismatch。
    //   · detail 层：insufficientEvidence === true → 结果必须呈现为「判不了」，而不是数字 60。
    //     60 是内部托底值（排序/落库仍用），但 UI 显示 60 会读成"通过"——详情层的"数字 60"
    //     和"确实匹配"的 60 无法分辨。所以 detail 层证据不足时也置 'unknown'，让三端统一读一个字段。
    //     若置 unknown 说明该人已被托底、非真实匹配，下游不得据此打标/排序（见 insufficientEvidence 契约）。
    var detailUnknown = (tier === 'detail' && insufficientEvidence);
    if (tier === 'card') {
      if (!mismatch && decisiveEvaluated < 2) {
        cardVerdict = 'unknown';
      } else {
        var bonusHitCount = (keywordsDim && keywordsDim.bonusHits) ? keywordsDim.bonusHits.length : 0;
        var reqStrongHit = keywordsDim ? (keywordsDim.reqTotal > 0 && !keywordsDim.zeroRequiredHit) : false;
        var domDim = null;
        for (var dvi = 0; dvi < details.length; dvi++) if (details[dvi].dimension === 'domainFit') { domDim = details[dvi]; break; }
        var domainSame = !!(domDim && !domDim.notApplicable && domDim.available !== false && domDim.score >= 70);
        var domainFar = !!(domDim && !domDim.notApplicable && domDim.available !== false && domDim.score <= 35);
        // 期望职位强对齐：卡片上最可靠的岗位专属信号（期望职位与 JD title 的对齐度 ≥70）。
        // 通用维（年限/学历/城市）一律不算正向证据。
        var pfDim = null;
        for (var pfi = 0; pfi < details.length; pfi++) if (details[pfi].dimension === 'positionFit') { pfDim = details[pfi]; break; }
        var positionAligned = !!(pfDim && !pfDim.notApplicable && pfDim.available !== false && pfDim.score >= 70);
        // 正向证据（Task C，2026-08-11 收紧）：必须【期望职位强对齐】叠加至少一个实质信号
        // （命中加分词 / 同域 / 必选强命中）。单靠公司名带来的域信号（缑向超：奇瑞→域92但无期望职位）
        // 或加分词的弱命中（子串，如"软件"命中公司名）不再足以撑起「值得看」——实测 13 张真顶卡里
        // 5 个 HR 拒绝的人仅凭这些弱信号拿到「值得看」，卡片层判定几乎不带信息。
        // 收紧后：真顶卡正样本候选人 D/E（期望职位 100% 对齐 + 加分/必选命中）仍稳居「值得看」；
        // 负样本从 5 个降到 2 个，且剩的 2 个（候选人 F/G）本身就是 title 100% 对齐的真实匹配——
        // 卡片层信息只能支撑"值得点开"，履历错配要到详情层才能判，这正是 card 与 detail 的分工。
        // 收紧只影响 worth→fair 的落档，不改变 total / nomatch 判定，故 Rule 1（正样本 <60、
        // 或 worth→nomatch）不可能被触发——worst case 是正样本从 worth 掉到 fair（允许）。
        var positiveEvidence = positionAligned
          && ((bonusHitCount >= 2) || domainSame || (reqStrongHit && bonusHitCount >= 1));

        if (mismatch || domainFar || total < lo) {
          cardVerdict = 'nomatch';
        } else if (positiveEvidence && total >= lo) {
          cardVerdict = 'worth';
        } else {
          cardVerdict = 'fair';
        }
      }
    } else if (detailUnknown) {
      cardVerdict = 'unknown';
    }

    return {
      total: total,
      level: level,
      tier: tier,
      gates: gates,
      mismatch: mismatch,
      mismatchReasons: mismatchReasons,
      coverage: coverage,
      missingDimensions: (function () {
        var out = [];
        for (var mi = 0; mi < details.length; mi++) {
          if (details[mi].available === false && !details[mi].notApplicable) out.push(details[mi].label);
        }
        return out;
      })(),
      lowConfidence: lowConfidence,
      // true = 这个分是「没看清」的托底，不是「看清了不合适」。使用方不该据此丢人。
      insufficientEvidence: insufficientEvidence,
      // 卡片层四档：'worth'值得看 / 'fair'一般 / 'nomatch'不匹配 / 'unknown'信息不足。
      //   'unknown' 只在判别性维度评过 <2 个时给出，且优先于其余三档。
      // detail 层：insufficientEvidence 时也置 'unknown'（三端统一读本字段，不再显示误导性的数字 60）；
      //   否则为 null（用数字分）。
      // ★ 三端（BOSS 插件 / BOSS RPA / 猎聘 RPA）在 tier==='card' 或本字段非 null 时一律显示它，
      //   不显示 total —— 卡片层的数字分没有区分度（见上方判定处的注释）。
      cardVerdict: cardVerdict,
      cardVerdictLabel: cardVerdict === 'worth' ? '值得看' : cardVerdict === 'fair' ? '一般'
        : cardVerdict === 'nomatch' ? '不匹配' : cardVerdict === 'unknown' ? '信息不足' : null,
      details: details,
      highlights: extractHighlights(details),
      gaps: extractGaps(details),
      skills: keywordsDim ? extractSkills(keywordsDim) : null,
    };
  }

  // ===================== 评分体检（本轮标定）=====================
  //
  // 解决的问题：真机 2026-07-29 跑了 75 人，分数全挤在 52~58、零高匹配，用户只能看到
  // 一串"不太匹配"，无从判断是"人真的不行"还是"评分配错了"。事后查库才发现两件事：
  //   · 75 人全在武汉，而 JD 城市写的是杭州 → 地理位置(权重15%)对每个人都给 30 分，
  //     既是统一扣分又零区分度；
  //   · 必选词「分布式架构」命中 0/75 → 权重最高的硬技能维(40%)被锁死在半命中基线。
  // 也就是说 55% 的权重在空转，而工具当时一个字都没提。
  //
  // 体检不改任何分数，只统计"这一维在本轮候选池上到底有没有产生区分度"，
  // 并把可执行的建议交给使用者（改必选词/改城市），判断权归人。
  function createScoreAudit() {
    var n = 0;
    var dims = {};        // dimension -> { label, weight, values: {}, counted, distinct }
    var reqHit = {};      // 必选词 -> 命中人数
    var cities = {};      // 候选人城市 -> 人数
    var levels = { high: 0, medium: 0, low: 0, mismatch: 0 };
    var totals = [];

    function bump(map, k) { if (!k) return; map[k] = (map[k] || 0) + 1; }

    return {
      count: function () { return n; },
      add: function (r, c) {
        if (!r) return;
        n++;
        if (levels[r.level] != null) levels[r.level]++;
        totals.push(r.total);
        bump(cities, c && c.city);
        var det = r.details || [];
        for (var i = 0; i < det.length; i++) {
          var d = det[i];
          if (d.notApplicable) continue;          // JD 没提要求的维度不参与体检
          var e = dims[d.dimension];
          if (!e) { e = dims[d.dimension] = { label: d.label, weight: d.weight, values: {}, counted: 0 }; }
          if (d.available === false) continue;     // 没数据的这一次不算，只统计真正计入加权的
          e.counted++;
          bump(e.values, String(d.score));
        }
        // 必选词逐词命中：exactHits 是本次命中的必选词数组
        var kw = null;
        for (var j = 0; j < det.length; j++) if (det[j].dimension === 'keywords') kw = det[j];
        if (kw && kw.exactHits) for (var k = 0; k < kw.exactHits.length; k++) bump(reqHit, kw.exactHits[k]);
      },
      /** 返回可直接写进运行日志的建议行；没有值得说的就返回空数组 */
      report: function (jd) {
        var out = [];
        if (n < 10) return out;                   // 样本太少，任何"常数维"的判断都不可靠
        jd = jd || {}; jd.basic = jd.basic || {}; jd.keywords = jd.keywords || {};

        // ① 零区分度维度：本轮所有人拿同一个分 → 这份权重完全没参与筛选
        var deadWeight = 0, liveWeight = 0, deadList = [];
        for (var key in dims) {
          if (!Object.prototype.hasOwnProperty.call(dims, key)) continue;
          var e = dims[key];
          if (e.counted < Math.max(5, n * 0.5)) continue; // 半数以上有数据才判定
          var distinct = 0;
          for (var v in e.values) if (Object.prototype.hasOwnProperty.call(e.values, v)) distinct++;
          if (distinct <= 1) { deadWeight += e.weight; deadList.push(e.label + '(' + e.weight + '%)'); }
          else liveWeight += e.weight;
        }
        if (deadList.length) {
          out.push('评分体检：' + deadList.join('、') + ' 这些维度本轮对所有候选人给出相同分数，'
            + '合计 ' + deadWeight + '% 权重没有产生任何区分度');
        }

        // ② 必选关键词零命中/极低命中 → 权重最高的一维被锁死
        var req = jd.keywords.required || [];
        for (var r2 = 0; r2 < req.length; r2++) {
          var hits = reqHit[req[r2]] || 0;
          var rate = Math.round(hits / n * 100);
          if (rate < 10) {
            out.push('评分体检：必选关键词「' + req[r2] + '」命中 ' + hits + '/' + n + ' 人（' + rate + '%）。'
              + '必选词几乎无人命中会把硬技能维锁在半命中基线，建议把它改成【加分词】，'
              + '或换成候选人简历里真会出现的写法');
          }
        }

        // ③ JD 城市与候选池不符 → 地理位置维对所有人统一扣分
        var jdCity = jd.basic.city;
        if (jdCity && jdCity !== '全国') {
          var top = '', topN = 0, matched = 0, total = 0;
          for (var ct in cities) {
            if (!Object.prototype.hasOwnProperty.call(cities, ct)) continue;
            total += cities[ct];
            if (cities[ct] > topN) { topN = cities[ct]; top = ct; }
            if (ct.indexOf(jdCity) !== -1 || jdCity.indexOf(ct) !== -1) matched += cities[ct];
          }
          if (total > 0 && matched / total < 0.2) {
            out.push('评分体检：JD 城市写的是「' + jdCity + '」，但本轮 ' + topN + '/' + total
              + ' 位候选人在「' + top + '」。BOSS 推荐流是按你在 BOSS 上的在招职位派人的，'
              + '与平台 JD 的城市不一致时，地理位置这一维会对每个人统一扣分且不产生区分度——'
              + '建议把 JD 城市改成「' + top + '」或「全国」');
          }
        }

        // ④ 总体结论
        if (out.length) {
          out.push('评分体检：本轮 ' + n + ' 人，高匹配 ' + levels.high + ' / 中 ' + levels.medium
            + ' / 低 ' + levels.low + ' / 不匹配 ' + levels.mismatch
            + '。以上几处修好之前，分数只在剩余 ' + liveWeight + '% 权重上区分人，参考价值有限');
        }
        return out;
      },
    };
  }

  // ===================== 对外 API =====================

  var api = {
    // 核心
    scoreCandidate: scoreCandidate,
    createScoreAudit: createScoreAudit,
    setSemanticProvider: setSemanticProvider,
    hasSemantic: hasSemantic,

    // 工具
    parseSalary: parseSalary,
    matchKeywords: matchKeywords,
    buildSkillText: buildSkillText,

    // 常量
    DEGREE_RANK: DEGREE_RANK,
    WEIGHT_TEMPLATES: WEIGHT_TEMPLATES,
    DEFAULT_HARD_FLAGS: DEFAULT_HARD_FLAGS,

    // 兼容旧调用（v1 只返回 total/level/details），上层若访问 highlights 等新增字段也能拿到
  };

  // 同时支持 Node (module.exports) 和浏览器 (window.__TA_SCORE__)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.__TA_SCORE__ = api;
  }
})(__engineRoot);
  var TA_ENGINE = __engineRoot.__TA_SCORE__;
  if (!TA_ENGINE) return;
  // 语义 provider 已内联但未注入（SEMANTIC_ENABLED_IN_BUNDLE=false，方案乙·纯字面匹配）。决策后切换 build-ext.mjs 与 scoring.ts 的开关即可。

  // ================================================================
  // 模块 4: content 主逻辑
  // ================================================================
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

  // ================================================================
  // 模块 5: 页面结构采样器（仅在用户点选项页按钮时触发，零常驻开销）
  // ================================================================
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
})();
