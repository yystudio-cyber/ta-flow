// 简历正文 → 评分候选人的构造器（第 2/3 条共用）。
// 贴近真实适配器：把正文按段落切成多个 workHistory 条目（每条 ~380 字），
// 而不是整篇塞进一个字段 —— 整篇单段时一个远域词会毒化全篇（实测 89→49）。
//
// 2026-08-11 修（P0）：此前用【姓名】顶替 position 与 workHistory[0].company，
// 又用正文里一个孤立的「本科/硕士」词填 education。三者都让引擎的
// hasStructured（skills/education/workHistory[0].company 任一非空）为真，
// 使不足 350 字的记录绕过第二道证据托底闸门、被当成「证据充分的低分」拒掉。
// 现在的原则：**抓不到就留空，让维度自然退出；只落真实存在于正文里的字段。**

// BOSS 顶卡 UI 噪声行（非候选人信息，必须先剔除，否则会被当成公司名/专业）
const TC_NOISE = /^(返回|搜索|上一个|下一个|画像匹配度|备注(\s*\(\d+\))?|加入文件夹|跟进提醒|保护期\s*￥?|猎头|收藏|沟通|一本|二本|211|985|双一流|QS\d+|BAT|互联网\d+强|世界\d+强|留学生?|暂无|保密|未填写)$/;
// 联系方式行。注意不能写成 /^\d[\d\-\s]{6,}/ —— 那会把「2024-04 - 至今」这类起止日期行
// 当成电话号吞掉，导致顶卡的工作块/教育块永远无法闭合（实测 23 条顶卡里 20 条解析为空）。
const TC_CONTACT = /@|^[+＋]|^\d{3}[-\s]?\d{4}[-\s]?\d{4}/;
const DEGREE_WORD = /^(全日制本科|本科|硕士|研究生|博士|大专|专科|MBA|EMBA|其他|中专|高中)$/;
const DATE_RANGE = /^\d{4}[-./]\d{1,2}\s*[-–—]\s*(\d{4}[-./]\d{1,2}|至今|今)$/;
const SCHOOL_HINT = /(大学|学院|学校|College|University)/i;
const DEGREE_RANK = { 大专: 1, 专科: 1, 中专: 1, 高中: 0, 本科: 2, 全日制本科: 2, 学士: 2, 硕士: 3, 研究生: 3, MBA: 3, EMBA: 3, 博士: 4 };

/**
 * 解析 BOSS「顶卡」段（结构化卡片，字段真实可靠但可选）。
 * 典型形态（字段可缺，顺序稳定）：
 *   姓名 / 联系方式 / 标签 / 城市，中国大陆 / N 岁 / N 年工作经验
 *   公司名 / 职位名 / 起-止        ← 工作块（职位行可缺）
 *   学校名 / 专业 / 学历 / 起-止   ← 教育块（专业行可缺）
 * 返回 null 表示这段不是顶卡。
 */
function parseTopcard(seg, knownName) {
  if (!seg) return null;
  let lines = seg.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    .filter((s) => !TC_NOISE.test(s) && !TC_CONTACT.test(s) && s !== '【顶卡】');
  if (!lines.length) return null;
  // 顶卡里姓名会出现两次（标题 + 详情头），且排在公司名【前面】。
  // 不剔除的话工作块的第一行就是姓名，company 又会被填成人名——正是本次要修的病根。
  const nm = knownName || lines[0];
  if (nm) lines = lines.filter((s) => s !== nm);
  if (!lines.length) return null;

  const out = { position: '', company: '', city: '', age: null, experienceYears: null, degree: '', education: [], works: [] };

  // 标量字段：整段直取（不依赖行序）
  const joined = lines.join('\n');
  const expM = joined.match(/(\d+)\s*年工作经验/);
  if (expM) out.experienceYears = Number(expM[1]);
  const ageM = joined.match(/(\d+)\s*岁/);
  if (ageM) out.age = Number(ageM[1]);
  const cityM = joined.match(/^(.{2,10}?)[，,]\s*中国大陆$/m);
  if (cityM) out.city = cityM[1].trim();

  // 以「起-止日期行」为锚，往上收集连续非日期行构成一个块
  let block = [];
  for (const ln of lines) {
    if (DATE_RANGE.test(ln.replace(/\s+/g, ' '))) {
      // 块内已消费掉的标量行剔除，避免「31 岁」被当成公司名
      const b = block.filter((s) => !/^\d+\s*(岁|年工作经验)$/.test(s) && !/[，,]\s*中国大陆$/.test(s));
      if (b.length) {
        if (b.some((s) => SCHOOL_HINT.test(s))) {
          // 去掉粘在校名前的栏目标题（实测「教育经历天津工业大学」）
          const school = (b.find((s) => SCHOOL_HINT.test(s)) || '').replace(/^(教育经历|教育背景|学习经历|工作经历)/, '');
          const degree = b.find((s) => DEGREE_WORD.test(s)) || '';
          const major = b.find((s) => s !== school && s !== degree) || '';
          out.education.push({ school, major, degree: degree === '其他' ? '' : degree });
        } else {
          out.works.push({ company: b[0], position: b[1] || '' });
        }
      }
      block = [];
    } else {
      block.push(ln);
    }
  }

  if (out.works.length) { out.company = out.works[0].company; out.position = out.works[0].position; }
  // 顶层 degree 取教育经历里的最高学历（引擎的 degree 维与硬门槛读这个字段）
  let best = -1;
  for (const e of out.education) {
    const r = DEGREE_RANK[e.degree];
    if (r != null && r > best) { best = r; out.degree = e.degree; }
  }
  // 既无工作块也无教育块 → 不是顶卡结构，按普通正文处理
  if (!out.works.length && !out.education.length && out.experienceYears == null) return null;
  return out;
}

export function buildCandidate(rec) {
  const raw = (rec.简历正文 || '');

  // 顶卡与附件预览正文分离：顶卡是结构化【逐行】字段，预览是经历正文，两者角色不同。
  // ⚠ 顶卡必须从【原始文本】解析：下面那条「压掉汉字间空格」的 OCR 规则会把 \n 也吃掉
  // （"返回\n姓名" → "返回姓名"、"某大学\n计算机科学与技术\n本科" 粘成一行），
  // 行结构一毁，顶卡就无法分块。正文侧仍保留该规则（OCR 简历确实需要）。
  let tc = null;
  let bodyRaw = raw;
  if (/【顶卡】/.test(raw)) {
    const parts = raw.split('【附件预览文本】');
    tc = parseTopcard(parts[0], rec.姓名 || '');
    bodyRaw = parts[1] || '';
  }
  // 统一空白：OCR 常把汉字【逐字】插空格（"个 人 简 历"、"智 能 座 舱"）。
  //
  // ⚠ 必须用前瞻，不能写成 /([一-龥])\s+([一-龥])/g → '$1$2'：
  // 那个写法会把第二个汉字一起消费掉，正则从它【之后】继续匹配，
  // 于是逐字空格只能压掉一半——"分 布 式 系 统" → "分布式 系统"，
  // JD 关键词「分布式系统」直接匹配不上。实测 36/127 条 OCR 记录受影响，
  // 表现为 domainFit「无明确域信号」、taskCoverage 偏低、positionFit「无期望职位」，
  // 若干进面候选人因此被打到 39~45 分。
  //
  // 同样重要：只吃空格和制表符，不吃 \n。用 \s 会连换行一起压掉，
  // 整篇 OCR 简历粘成一段后，段落切分退化为单条 workHistory，
  // 一个远域词就能毒化全篇（文档第 7 条，实测 89→49）。
  const compact = bodyRaw.replace(/([一-龥])[ \t]+(?=[一-龥])/g, '$1').trim();
  const paras = compact.split(/\n+/).map((s) => s.trim()).filter(Boolean);

  // 姓名：优先 rec.姓名（拒因表/文件名），否则从正文首几行提取「汉字 2-4 连字」人名
  let name = rec.姓名 || '';
  if (!name) {
    for (let i = 0; i < Math.min(3, paras.length); i++) {
      const m = paras[i].match(/^([一-龥]{2,4})\s*(?:男|女|生|姓|名|[·•|])/);
      if (m) { name = m[1]; break; }
    }
  }

  // 求职意向/期望职位：含「求职意向」「期望职位」「求职方向」的行。
  // 抓不到就【留空】——绝不用姓名顶替：position 会进 positionFit 维做职位名相似度，
  // 填姓名等于拿人名去和 JD 职位名算相似度，既产生噪声分，又让本该退出的维度"可判"。
  let position = '';
  for (const p of paras.slice(0, 12)) {
    if (/求职意向|期望职位|求职方向|目标岗位|意向岗位/.test(p)) {
      position = p.replace(/求职意向|期望职位|求职方向|目标岗位|意向岗位|[:：]|\s/g, '').slice(0, 16);
      break;
    }
  }
  if (!position && tc && tc.position) position = tc.position;

  // 学历：顶卡有结构化教育经历就用它（真字段）；否则只在正文里抓到【学校名】时才落。
  // 单独一个「本科/硕士」词不算结构化证据——它会让 hasStructured 为真，
  // 使 200 字残片绕过 <350 字托底闸门。实测曾造成 4 例假误杀。
  let edu = [];
  let degree = '';
  if (tc && tc.education.length) {
    edu = tc.education;
    degree = tc.degree;
  } else {
    const degreeM = compact.match(/(全日制本科|本科|硕士|研究生|博士|大专)/);
    const schoolM = compact.match(/([一-龥]{2,12}(?:大学|学院))/);
    if (schoolM) edu.push({ school: schoolM[1], major: '', degree: degreeM ? degreeM[1] : '' });
    // ⚠ 顶层 c.degree 只认【顶卡结构化学历】，正文正则抓的词绝不往上填。
    // 引擎的学历硬门槛读 c.degree，命中即封顶 45 并标 mismatch——直接打进 60 以下。
    // 而长篇 OCR 正文里第一个出现的学历词并不等于本人最高学历（可能是专升本的前段、
    // 也可能是正文里提到的别的学历字样）。实测张绍琪 taskCoverage 100 / keywords 100 的
    // 强匹配正样本，被正文里一个「大专」打成 45 分 mismatch。
    // 铁律：60 分以下必须极其准确 → 证据不可核验时宁可让 degree 维退出，也不许据此拒绝。
  }

  // 技能标签：常见的工具/技术词粗提（供 keywords 维）
  const skillRe = /(Linux|Python|Java|Go|Docker|Kubernetes|Jenkins|Git|MySQL|Redis|Kafka|Elasticsearch|Nginx|JavaScript|TypeScript|Vue|React|SQL|Power\s*BI|Excel|SAP|ERP|VBA|PMP|CPA|ACCA|项目管理|数据分析|自动化测试|性能优化|微服务|分布式|架构设计|需求分析|英语|TOEFL|IELTS|CET)/gi;
  const skills = [...new Set(compact.match(skillRe) || [])].slice(0, 20);

  // workHistory：正文按段落聚合，每段 ~380 字
  const segs = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length + p.length > 380 && cur) { segs.push(cur); cur = ''; }
    cur += (cur ? ' ' : '') + p;
  }
  if (cur) segs.push(cur);

  // company 绝不用姓名顶替：只有顶卡里真实存在的公司名才填。
  let workHistory;
  if (tc && tc.works.length) {
    // 顶卡工作块是真字段；正文段落作为 description 挂到第一条，其余段独立成条
    workHistory = tc.works.map((w, i) => ({
      company: w.company,
      position: w.position,
      description: i === 0 ? (segs[0] || '') : '',
    }));
    for (let i = 1; i < segs.length; i++) workHistory.push({ company: '', position: '', description: segs[i] });
  } else {
    workHistory = segs.map((s, i) => ({
      company: '',
      position: i === 0 ? position : '',
      description: s,
    }));
  }

  const out = {
    name,
    position,
    selfIntro: paras.slice(0, 4).join(' '),
    skills,
    education: edu,
    workHistory,
    // 注：不含面试评价文本（标签泄漏防护在 eval 层保证）
  };
  if (tc) {
    if (tc.company) out.company = tc.company;
    if (tc.city) out.city = tc.city;
    if (tc.age != null) out.age = tc.age;
    if (tc.experienceYears != null) out.experienceYears = tc.experienceYears;
  }
  if (degree) out.degree = degree;
  return out;
}
