/**
 * 端到端测试：飞书需求一键生成
 *
 * 流程：
 *  1. 打开一个已存在的职位详情页 → 运行 content.js 的提取逻辑 → 拿到提取结果
 *  2. 导航到需求列表 → 点新建需求 → 运行 content.js 的填充逻辑 → 检查填充结果
 *  3. （可选）提交后删除测试数据
 *
 * 直接在 puppeteer evaluate 中跑"等价于 content.js"的提取/填充逻辑，
 * 用来在正式注入前验证选择器和字段映射的正确性。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const OUT_DIR = path.join(__dirname, 'e2e-output');

const JOB_DETAIL_ID = process.argv[2] || ''; // 可以传一个职位 ID；不传则用列表第一个
const JOB_LIST_URL = 'https://acme.feishu.cn/hire/job/list?job_process_id=7079972948115294472&newFilters=%7B%22active_status%22%3A1%7D';
const REQ_LIST_URL = 'https://acme.feishu.cn/hire/job/requirement/list?status=2';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}` });
  console.log('已连接 CDP:', await browser.version());
  return browser;
}

async function getOrCreatePage(browser, url) {
  const pages = await browser.pages();
  let page = pages.find(p => p.url().startsWith(url.split('?')[0])) || pages.find(p => /feishu\.cn\/hire/.test(p.url()));
  if (!page) page = await browser.newPage();
  await page.bringToFront();
  if (page.url() !== url && !page.url().startsWith(url.split('?')[0])) {
    console.log('导航到:', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await sleep(3000);
  return page;
}

// 在 page 上下文中注入提取逻辑，返回提取到的字段
const EXTRACT_FN = function extractJobFields() {
  // 复制 content.js 中的核心常量
  var FORM_ITEM = '[class*="form__item"], [class*="form-item"], .form-group-item, [data-field-key], .ud-form-item';
  var LABEL_EL = 'label, [class*="form__item-label"], [class*="form-item-label"], [class*="item-label"]';
  var VALUE_INPUT = 'input.ud__native-input, input.ud-input, input';
  var VALUE_TEXTAREA = 'textarea.ud__native-input, textarea.ud-textarea, textarea';
  var VALUE_RICH = '[contenteditable="true"], .lark-editor, .slate-editor, [data-slate-editor="true"], [class*="rich-text"], [class*="editor-content"]';
  var VALUE_SELECT = '.ud__select__selector, .ud-select__selector, [class*="select__selector"], .ud-selector, [class*="cascader"]';

  var ALIAS = {
    title: ['职位名称', '岗位名称', '职位', '岗位', '招聘职位', 'title', 'name'],
    department: ['部门', '所属部门', '需求部门', '归属部门', 'department', 'dept'],
    city: ['工作地点', '工作城市', '城市', 'base', '地点', 'city', 'location'],
    headcount: ['招聘人数', '需求人数', '人数', 'HC', 'headcount', '招聘数量'],
    salaryRange: ['薪资范围', '薪酬范围', '薪资', '薪酬', '月薪', 'salary'],
    jobType: ['工作性质', '雇佣类型', '用工形式', '用工类型', '招聘类型', '职位性质'],
    rank: ['职级', '级别', '等级', '岗位级别', 'rank', 'level'],
    category: ['职位类别', '职位序列', '岗位类别', '职能', '职位分类', 'category', 'function'],
    reportTo: ['汇报对象', '汇报上级', '汇报人', 'report'],
    duty: ['岗位职责', '工作职责', '岗位描述', '职位描述', '工作内容', '主要职责', 'JD'],
    requirement: ['任职要求', '任职资格', '岗位要求', '能力要求', '技能要求', '资格要求'],
    priority: ['优先级', '紧急程度', 'priority'],
    recruiter: ['招聘负责人', 'HRBP', '招聘HR', '对接HR', 'recruiter'],
    hiringManager: ['用人经理', '招聘经理', '业务负责人', 'hiring manager', 'hm'],
    reason: ['招聘原因', '开放原因', '需求原因', '补充原因', '编制原因', 'reason'],
    remark: ['备注', '其他说明', 'remark', 'note'],
  };

  function canon(raw) {
    if (!raw) return null;
    var lbl = String(raw).replace(/\s*[:：\*]/g, '').trim().toLowerCase();
    if (!lbl) return null;
    for (var k in ALIAS) {
      var arr = ALIAS[k];
      for (var i = 0; i < arr.length; i++) {
        var a = String(arr[i]).toLowerCase();
        if (lbl === a || lbl.indexOf(a) !== -1) return k;
      }
    }
    return null;
  }

  function getLabel(item) {
    var lab = item.querySelector(LABEL_EL);
    if (lab) return (lab.textContent || '').trim();
    return '';
  }

  function getValue(item) {
    var inp = item.querySelector(VALUE_INPUT);
    if (inp && inp.value) return inp.value;
    var ta = item.querySelector(VALUE_TEXTAREA);
    if (ta && ta.value) return ta.value;
    var rich = item.querySelector(VALUE_RICH);
    if (rich) {
      var tmp = document.createElement('div');
      tmp.innerHTML = rich.innerHTML;
      var t = (tmp.innerText || tmp.textContent || '').replace(/ /g, ' ').trim();
      if (t) return t;
    }
    var sel = item.querySelector(VALUE_SELECT);
    if (sel) {
      var st = (sel.textContent || '').trim();
      if (st && st.indexOf('请选择') === -1 && st.indexOf('请输入') === -1) return st;
    }
    // 兜底纯文本（去 label）
    var labEl = item.querySelector(LABEL_EL);
    var cl = item.cloneNode(true);
    if (labEl && labEl.parentNode) {
      var labInClone = cl.querySelector(LABEL_EL);
      if (labInClone && labInClone.parentNode) labInClone.parentNode.removeChild(labInClone);
    }
    var rest = (cl.textContent || '').replace(/\s+/g, ' ').trim();
    return rest;
  }

  var data = {};
  var raw = {};
  var items = document.querySelectorAll(FORM_ITEM);
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var label = getLabel(it);
    if (!label) continue;
    var val = getValue(it);
    if (!val) continue;
    raw[label] = val;
    var key = canon(label);
    if (key) {
      if (!data[key] || String(val).length > String(data[key]).length) data[key] = val;
    }
  }
  // 兜底 title
  if (!data.title) {
    var h1 = document.querySelector('h1, [class*="job-title"], [class*="detail-title"], header [class*="title"]');
    if (h1) {
      var t = (h1.textContent || '').trim();
      if (t && t.length < 80) data.title = t;
    }
  }
  return { data: data, raw: raw, itemCount: items.length };
};

// 填充逻辑（在页面对象上下文中执行，接收 data 对象）
const FILL_FN = function fillRequirementForm(source) {
  var FORM_ITEM = '[class*="form__item"], [class*="form-item"], .form-group-item, [data-field-key], .ud-form-item';
  var LABEL_EL = 'label, [class*="form__item-label"], [class*="form-item-label"], [class*="item-label"]';
  var VALUE_INPUT = 'input.ud__native-input, input.ud-input, input';
  var VALUE_TEXTAREA = 'textarea.ud__native-input, textarea.ud-textarea, textarea';
  var VALUE_RICH = '[contenteditable="true"], .lark-editor, .slate-editor, [data-slate-editor="true"], [class*="rich-text"], [class*="editor-content"]';
  var VALUE_SELECT = '.ud__select__selector, .ud-select__selector, [class*="select__selector"], .ud-selector, [class*="cascader"]';

  var TARGET_LABEL = {
    title: '职位名称', department: '部门', city: '工作地点', headcount: '招聘人数',
    salaryRange: '薪资范围', jobType: '工作性质', rank: '职级', category: '职位类别',
    reportTo: '汇报对象', duty: '岗位职责', requirement: '任职要求', priority: '优先级',
    recruiter: '招聘负责人', hiringManager: '用人经理', reason: '招聘原因', remark: '备注',
  };

  function canon(raw) {
    // 同 EXTRACT_FN 中的 alias（简化版，只识别常见 label）
    var ALIAS = {
      title: ['职位名称', '岗位名称', '职位', '岗位', '招聘职位', '需求名称', 'title', 'name'],
      department: ['部门', '所属部门', '需求部门', '归属部门', 'department', 'dept'],
      city: ['工作地点', '工作城市', '城市', 'base', '地点', 'city', 'location'],
      headcount: ['招聘人数', '需求人数', '人数', 'HC', 'headcount', '招聘数量'],
      salaryRange: ['薪资范围', '薪酬范围', '薪资', '薪酬', '月薪', 'salary'],
      jobType: ['工作性质', '雇佣类型', '用工形式', '用工类型', '招聘类型', '职位性质'],
      rank: ['职级', '级别', '等级', '岗位级别', 'rank', 'level'],
      category: ['职位类别', '职位序列', '岗位类别', '职能', '职位分类', 'category', 'function'],
      reportTo: ['汇报对象', '汇报上级', '汇报人', 'report'],
      duty: ['岗位职责', '工作职责', '岗位描述', '职位描述', '工作内容', '主要职责', 'JD'],
      requirement: ['任职要求', '任职资格', '岗位要求', '能力要求', '技能要求', '资格要求'],
      priority: ['优先级', '紧急程度', 'priority'],
      recruiter: ['招聘负责人', 'HRBP', '招聘HR', '对接HR', 'recruiter'],
      hiringManager: ['用人经理', '招聘经理', '业务负责人', 'hiring manager', 'hm'],
      reason: ['招聘原因', '开放原因', '需求原因', '补充原因', '编制原因', 'reason'],
      remark: ['备注', '其他说明', 'remark', 'note'],
    };
    if (!raw) return null;
    var lbl = String(raw).replace(/\s*[:：\*]/g, '').trim().toLowerCase();
    if (!lbl) return null;
    for (var k in ALIAS) {
      var arr = ALIAS[k];
      for (var i = 0; i < arr.length; i++) {
        var a = String(arr[i]).toLowerCase();
        if (lbl === a || lbl.indexOf(a) !== -1) return k;
      }
    }
    return null;
  }

  function getLabel(item) {
    var lab = item.querySelector(LABEL_EL);
    if (lab) return (lab.textContent || '').trim();
    return '';
  }

  function setInput(el, v) {
    if (!el) return false;
    try {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) { desc.set.call(el, v); } else { el.value = v; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch (e) { try { el.value = v; return true; } catch (e2) { return false; } }
  }

  function setRich(el, v) {
    if (!el) return false;
    try {
      el.focus();
      el.innerHTML = '';
      var ok = false;
      try { document.execCommand('insertText', false, v); ok = true; } catch (e1) { el.textContent = v; ok = true; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return ok;
    } catch (e) { return false; }
  }

  function findFormRoot() {
    var cands = ['[role="dialog"]', '[class*="drawer"]', '[class*="modal"]', 'form', '[class*="requirement"]'];
    var best = null, bestCount = 0;
    for (var i = 0; i < cands.length; i++) {
      var nodes = document.querySelectorAll(cands[i]);
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.offsetParent === null) continue;
        var c = n.querySelectorAll(FORM_ITEM).length;
        if (c > bestCount) { best = n; bestCount = c; }
      }
    }
    return best || document;
  }

  var root = findFormRoot();
  var items = root.querySelectorAll(FORM_ITEM);
  var filled = [];
  var needManual = [];
  var notFound = [];
  var unmatched = [];

  for (var k in source) {
    if (k.indexOf('__') === 0) continue;
    var val = source[k];
    if (!val) continue;
    var preferred = TARGET_LABEL[k];
    var target = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var lb = getLabel(it);
      if (!lb) continue;
      if (preferred && lb.replace(/\s*[:：\*]/g, '').trim() === preferred) { target = it; break; }
    }
    if (!target) {
      for (var m = 0; m < items.length; m++) {
        var it2 = items[m];
        var lb2 = getLabel(it2);
        if (canon(lb2) === k) { target = it2; break; }
      }
    }
    if (!target) { notFound.push(k); continue; }
    // 尝试填充
    var ta = target.querySelector(VALUE_TEXTAREA);
    var inp = target.querySelector(VALUE_INPUT);
    var rich = target.querySelector(VALUE_RICH);
    var sel = target.querySelector(VALUE_SELECT);
    var ok = false, manual = false;
    if (ta) ok = setInput(ta, val);
    else if (inp) ok = setInput(inp, val);
    else if (rich) ok = setRich(rich, val);
    else if (sel) { manual = true; needManual.push(k + '(' + preferred + ')'); }
    else { needManual.push(k + '(' + preferred + ') - 未知控件类型'); }
    if (ok) filled.push(k + ' -> ' + preferred);
  }

  // 收集没填的表单 label（反向：哪些字段在表单里但数据里没提供）
  for (var n = 0; n < items.length; n++) {
    var lbN = getLabel(items[n]);
    if (!lbN) continue;
    var kN = canon(lbN);
    if (kN && source[kN]) continue; // 已经处理过
    if (lbN && lbN.length < 30) unmatched.push(lbN);
  }

  return {
    filled: filled,
    needManual: needManual,
    notFound: notFound,
    unmatchedFormFields: unmatched.slice(0, 40),
    formItemCount: items.length,
  };
};

async function runExtractTest(page) {
  console.log('\n========= 步骤 1：提取职位详情字段 =========');
  const result = await page.evaluate(EXTRACT_FN);
  console.log('表单条目数:', result.itemCount);
  console.log('提取到字段数:', Object.keys(result.data).length);
  console.log('字段明细:');
  for (const [k, v] of Object.entries(result.data)) {
    console.log(`  ${k.padEnd(15, ' ')} = ${String(v).slice(0, 60)}`);
  }
  console.log('未识别到别名的原始 label:', Object.keys(result.raw).filter(l => {
    // 简单判断是否在 data 里
    return !Object.values(result.data).some(v => result.raw[l] === v);
  }).slice(0, 20));
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'extract-result.json'), JSON.stringify(result, null, 2), 'utf-8');
  return result.data;
}

async function openFirstJobDetail(page) {
  console.log('\n进入职位详情...');
  const ok = await page.evaluate(() => {
    var links = document.querySelectorAll('a[href*="/hire/job/"]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute('href') || '';
      // 排除列表本身（list/requirement 等）
      if (/\/job\/\d+/.test(href) && href.indexOf('list') === -1 && href.indexOf('requirement') === -1) {
        if (a.offsetParent !== null) { a.click(); return { clicked: true, href: href }; }
      }
    }
    // 兜底：找列表行的第一个可点击元素
    var rows = document.querySelectorAll('tbody tr, [class*="list-item"], [class*="job-item"]');
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (r.offsetParent === null) continue;
      r.click();
      return { clicked: true, row: j };
    }
    return { clicked: false };
  });
  console.log('结果:', ok);
  await sleep(3000);
  return ok && ok.clicked;
}

async function clickNewRequirement(page) {
  console.log('\n点击「新建需求」...');
  const clicked = await page.evaluate(() => {
    var btns = document.querySelectorAll('button, [role="button"], a, [class*="btn"]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var txt = (b.textContent || '').trim();
      if (/新建需求|创建需求|新增需求/.test(txt)) {
        if (b.offsetParent !== null) { b.click(); return true; }
      }
    }
    return false;
  });
  console.log('点击结果:', clicked);
  await sleep(3000);
  return clicked;
}

async function runFillTest(page, data) {
  console.log('\n========= 步骤 2：填充新建需求表单 =========');
  // 给 data 加点测试字段（模拟"测试数据"）
  const testData = {
    ...data,
    // 如果原数据缺某些字段，补一个测试值（方便验证填充是否成功）
    headcount: data.headcount || '1',
    remark: data.remark || '【测试数据，将删除】AI 工具自动生成的测试需求',
  };
  const result = await page.evaluate(FILL_FN, testData);
  console.log('表单条目数:', result.formItemCount);
  console.log('成功填充:', result.filled.length, '个');
  result.filled.forEach(f => console.log('  ✓', f));
  console.log('需手选（下拉/级联/选择器）:', result.needManual.length, '个');
  result.needManual.forEach(m => console.log('  ⚠', m));
  console.log('数据里有但表单没找到:', result.notFound);
  console.log('表单里有但数据没提供（反向）:', result.unmatchedFormFields);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'fill-result.json'), JSON.stringify(result, null, 2), 'utf-8');
  return result;
}

async function main() {
  const browser = await connect();
  try {
    // 1. 去职位列表 → 进第一个职位 → 提取
    const page = await getOrCreatePage(browser, JOB_LIST_URL);
    console.log('当前 URL:', page.url());
    const detailOpened = await openFirstJobDetail(page);
    if (!detailOpened) {
      console.error('无法进入职位详情页，请手动打开一个职位详情页后重跑');
      process.exit(1);
    }
    console.log('详情页 URL:', page.url());
    const data = await runExtractTest(page);

    if (Object.keys(data).length === 0) {
      console.warn('⚠ 没提取到任何字段，继续填充可能没意义，但还是试一下');
    }

    // 2. 去需求列表 → 新建需求 → 填充
    await page.goto(REQ_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);
    console.log('需求列表 URL:', page.url());
    const formOpened = await clickNewRequirement(page);
    if (!formOpened) {
      console.error('无法打开新建需求表单，请检查页面权限');
      process.exit(1);
    }
    const fillResult = await runFillTest(page, data);

    console.log('\n========= 结果总结 =========');
    console.log(`提取: ${Object.keys(data).length} 个字段`);
    console.log(`填充: ${fillResult.filled.length} 成功 / ${fillResult.needManual.length} 需手选 / ${fillResult.notFound.length} 找不到`);
    console.log(`表单共 ${fillResult.formItemCount} 个字段，未匹配 ${fillResult.unmatchedFormFields.length} 个`);
    console.log('\n详细输出目录:', OUT_DIR);

    if (fillResult.filled.length > 0) {
      console.log('\n✓ 基础填充链路跑通！接下来可：');
      console.log('  - 根据 notFound/needManual/unmatched 校准字段映射');
      console.log('  - 把脚本固化到 content.js 作为最终工具');
      console.log('  - 做提交→删除的闭环验证');
    }
  } catch (e) {
    console.error('E2E 测试失败:', e.message);
    console.error(e.stack);
  }
}

main().catch(console.error);
