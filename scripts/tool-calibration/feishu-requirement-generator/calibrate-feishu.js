/**
 * 飞书需求一键生成 - CDP 校准 + 端到端测试脚本
 *
 * 用途：
 *  1) 连到本地 9222 调试端口的 Chrome
 *  2) 导航到飞书招聘职位详情页 → 抓取表单 DOM 结构（用于校准提取选择器）
 *  3) 导航到需求列表 → 点新建需求 → 抓取新建需求表单 DOM 结构（用于校准填充选择器）
 *  4) 端到端跑通：从职位详情提取 → 切换到需求列表 → 新建需求 → 填充 → 检查结果
 *
 * 用法（需要先启动 TA 平台浏览器、或任意开着 9222 调试端口的 Chrome）：
 *   node calibrate-feishu.js
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const OUT_DIR = path.join(__dirname, 'calibrate-output');

const JOB_LIST_URL = 'https://acme.feishu.cn/hire/job/list?job_process_id=7079972948115294472&newFilters=%7B%22active_status%22%3A1%7D';
const REQ_LIST_URL = 'https://acme.feishu.cn/hire/job/requirement/list?status=2';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connect() {
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}` });
  } catch (e) {
    console.error('无法连接到 127.0.0.1:' + CDP_PORT + '，请先启动带调试端口的 Chrome');
    console.error('错误：', e.message);
    process.exit(1);
  }
  console.log('已连接 CDP，版本:', await browser.version());
  const pages = await browser.pages();
  console.log('当前标签数:', pages.length);
  return browser;
}

// 找出当前页面中"最像"飞书招聘的页；没有则新建标签导航过去
async function ensureFeishuPage(browser, url, label) {
  const pages = await browser.pages();
  let page = pages.find(p => /feishu\.cn\/hire/i.test(p.url()));
  if (page) {
    console.log(`[${label}] 复用现有飞书页:`, page.url().slice(0, 80));
  } else {
    console.log(`[${label}] 新开标签导航到:`, url);
    page = await browser.newPage();
  }
  await page.bringToFront();
  if (page.url() !== url && !page.url().startsWith(url.split('?')[0])) {
    console.log(`[${label}] 导航到目标页...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await sleep(2500); // 等飞书 SPA 渲染
  return page;
}

// 抓取页面上所有"看起来像表单项"的 DOM 节点，输出结构化信息
function dumpFormItems(maxDepth = 2) {
  const results = [];
  // 候选选择器（从广到窄）
  const selectors = [
    '[class*="form__item"]',
    '[class*="form-item"]',
    '[class*="FormItem"]',
    '[data-field]',
    '[data-field-key]',
    '.ud-form-item',
    'label', // label 兜底
  ];
  const seen = new Set();
  for (const sel of selectors) {
    const nodes = document.querySelectorAll(sel);
    nodes.forEach(node => {
      if (seen.has(node)) return;
      if (node.offsetParent === null) return; // 不可见
      // 基本信息
      const txt = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!txt || txt.length < 2) return;
      // 找 label
      let labelEl = node.querySelector('label, [class*="label"], [class*="Label"]');
      let labelText = labelEl ? (labelEl.textContent || '').trim().slice(0, 60) : '';
      // 找控件
      const hasInput = !!node.querySelector('input, textarea, [contenteditable], select, [class*="select"], [class*="cascader"], [class*="tree-select"]');
      // 类名
      const className = node.className || '';
      const clsList = typeof className === 'string' ? className.split(/\s+/).filter(Boolean) : [];
      // 父层类名（追溯 2 层，找标识性的类）
      let parentInfo = [];
      let p = node.parentElement;
      for (let i = 0; i < 3 && p; i++) {
        const pc = (p.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
        if (pc) parentInfo.push(`<${p.tagName.toLowerCase()} class="${pc}">`);
        p = p.parentElement;
      }
      results.push({
        selector: sel,
        tag: node.tagName.toLowerCase(),
        classes: clsList,
        parentClasses: parentInfo,
        label: labelText,
        hasInput: hasInput,
        textSample: txt.slice(0, 80),
        bounding: node.getBoundingClientRect ? {
          x: Math.round(node.getBoundingClientRect().x),
          y: Math.round(node.getBoundingClientRect().y),
          w: Math.round(node.getBoundingClientRect().width),
          h: Math.round(node.getBoundingClientRect().height),
        } : null,
      });
      seen.add(node);
    });
  }
  // 按位置排序（从上到下，从左到右）
  results.sort((a, b) => {
    if (!a.bounding || !b.bounding) return 0;
    if (Math.abs(a.bounding.y - b.bounding.y) < 20) return a.bounding.x - b.bounding.x;
    return a.bounding.y - b.bounding.y;
  });
  return { total: results.length, items: results.slice(0, 60) };
}

async function captureFormStructure(page, outFile, title) {
  console.log(`\n=== ${title} ===`);
  await sleep(1500);
  const data = await page.evaluate(dumpFormItems);
  console.log(`发现 ${data.total} 个表单项（取前 ${data.items.length} 个）`);
  // 打印前 20 个
  data.items.slice(0, 20).forEach((it, i) => {
    const clsShort = it.classes.slice(0, 3).join('.');
    const mark = it.hasInput ? '[控件]' : '[文本]';
    console.log(`  ${String(i+1).padStart(2,' ')}. ${mark} ${clsShort.slice(0,50).padEnd(50,' ')} | label="${it.label}" | sample="${it.textSample.slice(0,40)}"`);
  });
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, outFile), JSON.stringify(data, null, 2), 'utf-8');
  console.log('完整数据已写入:', outFile);
  return data;
}

// 在需求列表页点击"新建需求"按钮
async function clickNewRequirement(page) {
  console.log('\n寻找「新建需求」按钮...');
  const btn = await page.evaluateHandle(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div[class*="btn"]'));
    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      if (/^新建需求$|创建需求|新增需求|\+ 新建需求|\+新建需求/.test(txt)) {
        if (el.offsetParent !== null) return el;
      }
    }
    return null;
  });
  if (btn._remoteObject && btn._remoteObject.subtype === 'null') {
    console.warn('⚠ 未找到新建需求按钮，请确认页面');
    return false;
  }
  console.log('找到按钮，点击...');
  await btn.click();
  await sleep(2500);
  return true;
}

// 在职位列表页点击第一个职位进入详情
async function clickFirstJob(page) {
  console.log('\n寻找第一个职位条目并点击...');
  const ok = await page.evaluate(() => {
    const selectors = [
      '[class*="job-item"]',
      '[class*="list-item"]',
      'tbody tr',
      '[class*="card"]',
    ];
    for (const sel of selectors) {
      const items = document.querySelectorAll(sel);
      if (items.length > 2) {
        // 找第一个有链接/可点击的
        for (const it of items) {
          if (it.offsetParent === null) continue;
          const a = it.querySelector('a[href*="/hire/job/"]');
          if (a) { a.click(); return { clicked: true, selector: sel }; }
          // 尝试直接点条目本身（如果绑定了 click）
          const txt = (it.textContent || '').trim();
          if (txt && txt.length > 10 && txt.length < 200) {
            it.click();
            return { clicked: true, selector: sel, reason: 'direct-click' };
          }
        }
      }
    }
    return { clicked: false };
  });
  if (ok && ok.clicked) {
    console.log('已点击第一个职位');
    await sleep(2500);
    return true;
  }
  console.warn('⚠ 未找到可点击的职位');
  return false;
}

async function main() {
  const browser = await connect();

  try {
    // ====== 1. 职位列表页结构 ======
    const jobListPage = await ensureFeishuPage(browser, JOB_LIST_URL, '职位列表');
    await captureFormStructure(jobListPage, 'job-list-items.json', '职位列表页 DOM');

    // ====== 2. 职位详情页结构 ======
    await clickFirstJob(jobListPage);
    await sleep(2000);
    await captureFormStructure(jobListPage, 'job-detail-items.json', '职位详情页 DOM');

    // ====== 3. 切到需求列表 ======
    const reqListPage = await ensureFeishuPage(browser, REQ_LIST_URL, '需求列表');
    await captureFormStructure(reqListPage, 'req-list-items.json', '需求列表页 DOM');

    // ====== 4. 新建需求表单结构 ======
    const clicked = await clickNewRequirement(reqListPage);
    if (clicked) {
      await captureFormStructure(reqListPage, 'new-req-form-items.json', '新建需求表单 DOM');
    }

    console.log('\n=== 校准数据全部输出到:', OUT_DIR);
  } catch (e) {
    console.error('校准过程出错:', e.message);
    console.error(e.stack);
  }
}

main().catch(console.error);
