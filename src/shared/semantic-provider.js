/**
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
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
