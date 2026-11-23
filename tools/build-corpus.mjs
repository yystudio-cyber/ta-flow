// 第 1 条：数据吸收与标签化
// 把 岗位＋简历 目录下全部简历吃成统一样本集 JSON（产物放系统临时目录，不污染仓库）。
// 用法：node tools/build-corpus.mjs [--out <path>] [--ocr-cache <dir>]
// 依赖：
//   - 系统命令 pdftotext（PDF 文字层）
//   - PowerShell 脚本 tools/winocr.ps1（Windows.Media.Ocr 识别扫描件图片）
//   - unzip（解压 docx 取 word/document.xml 与 word/media/*）

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const REPO = 'C://Users//you/Desktop/AI/TA Flow';
const DATA = 'C://Users//you/Desktop/AI/TA流程优化/TA数据/岗位＋简历';
const OCR_SCRIPT = path.join(REPO, 'tools', 'winocr.ps1');

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const cacheArg = args.find((a) => a.startsWith('--ocr-cache='));
const OUT = outArg ? outArg.split('=')[1] : path.join(os.tmpdir(), 'ta-corpus.json');
const OCR_CACHE = cacheArg ? cacheArg.split('=')[1] : path.join(os.tmpdir(), 'ta-ocr-cache');

fs.mkdirSync(OCR_CACHE, { recursive: true });

// ── 专业词白名单（保护不被水印清洗误删）─────────────────────────
const PROTECT = [
  'CPA', 'CTA', 'ACCA', 'SAP', 'ERP', 'BP', 'VBA', 'SQL', 'PRC', 'GAAP', 'PPAP', 'APQP', 'DFMEA',
  'BOM', 'ADAS', 'HMI', 'SoC', 'ECU', 'OEM', 'RFI', 'RFQ', 'CAN', 'CANoe', 'AVM', 'OTA', 'TBOX',
  'MCU', 'AEC', 'SEM', 'FIB', 'EDS', 'EDX', 'X-ray', 'X-Ray', 'Decap', 'EMMI', 'IATF', 'JEDEC',
  'HTOL', 'TCT', 'THB', 'HAST', '8D', 'FMEA', 'PFMEA', 'PMP', 'SRM', 'Power BI', 'AR-HUD', 'TCU',
  'IVI', 'HIL', 'UDS', 'ADB', 'CATIA', 'UG', 'SolidWorks', 'Creo', 'ProE', 'EMC', 'SOP', 'PRD',
  'CET', 'TOEFL', 'IELTS', 'GPS', 'LCD', 'OLED', 'USB', 'HDMI', 'CPU', 'GPU', 'NPU', 'LTE', '5G',
  'ISO', 'IEC', 'ROHS', 'REACH', 'C1', 'C2', 'Linux', 'Android', 'iOS', 'python', 'Python', 'office',
].map((w) => w.toLowerCase());

// ── 标签口径 ────────────────────────────────────────────────────
// 进过面一律正样本（模型职责=简历该不该约面试，不预测面试表现）。
// 被拒绝简历按拒因二次分流：neg(pos含"不通过|XX不匹配")/pos(含"进面级")/skip(无关质量)。
const POS_FOLDERS = [
  '进面一面通过二面未通过', '进面一面通过二面结果未知', '进面一面待定',   // 最强正样本
  '进面但未安排', '进面未安排面试', '进面未安排', '未安排仅进面', '进面还未一面', // 正样本
  '进面但一面挂',  // 简历评估通过，挂在面试表现 → 正样本
];

function classifyByFolder(job, folderName) {
  if (!folderName) return 'pos'; // 岗位根目录下的简历（PDF/docx 进面样本）
  if (folderName === '被拒绝简历') return null; // 需拒因分流
  if (folderName === '进面但一面挂') return 'pos';
  if (POS_FOLDERS.includes(folderName)) return 'pos';
  return null;
}

function classifyByRejectReason(job, reason) {
  if (!reason) return null;
  const r = reason || '';
  if (/不通过/.test(r)) {
    // 含 不通过|XX不匹配 → 真负样本；但若同时标注 进面级（简历评估通过）→ 正样本
    if (/进面级/.test(r)) return 'pos';
    if (/非质量/.test(r) && !/不通过/.test(r)) return 'skip';
    return 'neg';
  }
  if (/进面级/.test(r)) return 'pos';
  // 非质量/转岗/长时间未处理自动终止，且不含 不通过 → 与简历质量无关
  if (/非质量|转岗|长时间未处理自动终止|自动终止|无评估/.test(r)) return 'skip';
  return null;
}

// ── 档位原文（标签的档位文件夹名，用于报告）───────────────────
function folderNameOf(rel) {
  const parts = rel.split(/[\\/]/);
  const job = parts[0];
  const sub = parts.slice(1);
  if (sub.length === 0) return '';
  return sub[sub.length - 2]; // 档位文件夹名
}

// ── JD 提取（docx 文字层 / txt）────────────────────────────────
function extractDocxText(p) {
  const dir = path.join(os.tmpdir(), 'docx_' + Math.floor(Math.random() * 1e9));
  fs.mkdirSync(dir, { recursive: true });
  try {
    const pWin = p.split('/').join('\\');
    execSync(`unzip -o -q "${pWin}" word/document.xml -d "${dir}"`, { stdio: 'ignore' });
    const doc = path.join(dir, 'word', 'document.xml');
    if (!fs.existsSync(doc)) throw new Error('无 word/document.xml');
    const x = fs.readFileSync(doc, 'utf8');
    const paras = [...x.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) => {
      const t = [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((mm) => mm[1]).join('');
      return t.trim();
    }).filter(Boolean);
    return paras.join('\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 面试评价抽取：从 docx 文字层把「简历评估/一面评价…」单列 ──
const EVAL_RE = /(简历评估|面试评价|一面评价|二面评价|终面评价|评估)\s*[:：]?/g;
function splitEvalFromText(text) {
  if (!text) return { body: '', evalText: '' };
  let evalText = '';
  // ⚠ 必须含「简历评价」。此前只写了「简历评估」，而 HR 真实写法是「简历评价：」，
  // 一字之差导致剥离从未生效：4 条纯评价文档（25~39 字）整段当成简历正文进了正样本集。
  // 危害是反向的——评价原话「没有AVM 和智驾相关测试经验」含 AVM 字样，
  // 会让被点名"缺 AVM 经验"的人反而在 AVM 关键词上命中（文档第八条明令禁止的标签泄漏）。
  const evalMarks = [...text.matchAll(/(简历评价|简历评估|面试评价|一面评价|二面评价|终面评价|初筛评价)[:：]?/g)];
  if (evalMarks.length > 0) {
    const firstIdx = evalMarks[0].index;
    evalText = text.slice(firstIdx).trim();
  }
  // 正文 = 去掉评价段
  let body = text;
  if (evalText) {
    // 评价段通常在文字层末尾；取第一个评价标记之前的全部为正文
    body = text.slice(0, text.indexOf(evalText)).trim();
    // 纯评价文档剥完就是空——这里【不再回填原文】。回填等于把评价文本当简历，
    // 正是上面说的标签泄漏。正文为空的记录在下游强制标 skip，不进正/负判据。
  }
  return { body, evalText };
}

// ── PDF 提取（pdftotext）──────────────────────────────────────
function extractPdfText(p) {
  const out = execSync(`pdftotext -enc UTF-8 -nopgbrk "${p.split('/').join('\\')}" -`, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

// ── OCR 扫描图片（Windows.Media.Ocr，逐图，超 2200px 切片）─────
function ocrImage(imgPath, cacheKey) {
  const cacheFile = path.join(OCR_CACHE, cacheKey + '.txt');
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8');
  let txt;
  try {
    // 由 PowerShell 处理切片与识别，避免在 node 里做 BMP 位图变换
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${OCR_SCRIPT.split('/').join('\\')}" -Image "${imgPath.split('/').join('\\')}"`;
    txt = execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error('OCR 失败: ' + String(e && e.message).slice(0, 300));
  }
  fs.writeFileSync(cacheFile, txt, 'utf8');
  return txt;
}

// ── docx 里提取并 OCR 全部内嵌简历图片 ───────────────────────
function ocrDocxEmbedded(p, key, warnings) {
  const dir = path.join(os.tmpdir(), 'docximg_' + Math.floor(Math.random() * 1e9));
  fs.mkdirSync(dir, { recursive: true });
  const texts = [];
  try {
    const pWin = p.split('/').join('\\');
    execSync(`unzip -o -q "${pWin}" "word/media/*" -d "${dir}"`, { stdio: 'ignore' });
    const mediaDir = path.join(dir, 'word', 'media');
    if (!fs.existsSync(mediaDir)) {
      warnings.push(`${key}: docx 无内嵌图片`);
      return texts.join('\n');
    }
    const imgs = fs.readdirSync(mediaDir).filter((f) => /\.(png|jpg|jpeg|gif|bmp)$/i.test(f)).sort();
    for (const img of imgs) {
      const imgPath = path.join(mediaDir, img);
      const rel = (key + '__' + img).replace(/[\\/:]/g, '_');
      try {
        const t = ocrImage(imgPath, rel).trim();
        if (t) texts.push(t);
      } catch (e) {
        warnings.push(`${key}/${img}: ${String(e.message).slice(0, 200)}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return texts.join('\n');
}

// ── 清洗 ───────────────────────────────────────────────────────
// 1. BOSS 简历 PDF 防复制水印：定长 ASCII 乱串碎片，插在词中间。
//    策略：找出反复出现的长 ASCII 乱串作为水印母串，删除
//      ① 独立成词的 ≥4 位碎片 ② 夹在汉字中间的 1-3 位含字母碎片 ③ 汉字与标点间的悬挂碎片
// 2. OCR 数字被断开（「12 年」→「1 2 年」）→ 数字串空格收拢
// 3. 保护专业词白名单，不得误删正文专业词
function cleanText(raw) {
  if (!raw) return '';
  let t = raw;

  // ---- 先保护专业词（把白名单词替换成占位，清洗后再还原）----
  const protectMap = new Map();
  const PROTECT_RE = new RegExp('\\b(' + PROTECT.map(escRe).join('|') + ')\\b', 'gi');
  let pi = 0;
  t = t.replace(PROTECT_RE, (m) => {
    const tok = `\u0001${pi}\u0002`;
    protectMap.set(tok, m);
    pi++;
    return tok;
  });

  // ---- 水印母串识别 ----
  // BOSS 简历防复制水印是一串定长乱码（如 c8b61f19a1ce42f11HJ92du7FFFVxI--UvKcWOeln_PYMhJm），
  // pdftotext 把它拆成碎片插进正文。策略：
  //  1) 找全文出现 ≥2 次的最长混合类型 ASCII 块作为「母串」
  //  2) 母串的全部 ≥4 位子串 + 其它独立成词的混合碎片，一并删除
  //  3) 绝不删专业词白名单（已先行保护）
  // 注意水印母串本身可能含连字符（如 ...FFFVxI--UvKcWO...），所以 ASCII 块要含 `-`，
  // 否则母串在 `--` 处被切断，跨连字符的碎片（如 VxI--U）就漏网。
  const asciiBlockRe = /[A-Za-z0-9_-]{4,}/g;
  const blocks = [...t.matchAll(asciiBlockRe)].map((m) => m[0]);
  const freq = new Map();
  for (const b of blocks) freq.set(b, (freq.get(b) || 0) + 1);

  // 母串特征：大小写+数字 混排（≥2 类型），且出现 ≥2 次 或 长度 ≥16
  const candidateMasters = [...freq.entries()]
    .filter(([b, n]) => {
      if (b.length < 6) return false;
      const types = [/[A-Z]/, /[a-z]/, /[0-9]/].filter((re) => re.test(b)).length;
      return (types >= 2 && (n >= 2 || b.length >= 16)) || (b.includes('_') && b.length >= 12);
    })
    .map(([b]) => b);
  let master = candidateMasters.sort((a, b2) => b2.length - a.length)[0] || '';

  // 由母串生成要删除的全部碎片（≥4 位连续子串）。跨 `-` 的碎片（VxI--U）也进集合。
  const fragmentSet = new Set();
  if (master) {
    for (let i = 0; i < master.length; i++) {
      for (let j = i + 4; j <= master.length; j++) {
        fragmentSet.add(master.slice(i, j));
      }
    }
  }

  // 独立成词的 ≥4 位混合碎片：母串碎片 + 其它含「大小写双字母」的碎片。
  // 水印乱码几乎都同时含大写与小写字母（+数字）；纯数字区间（20-40K）、
  // 单一大小写的专业词（SAP 已保护）不会被误删。
  const standaloneRe = [];
  for (const [block] of freq) {
    if (block.length < 4) continue;
    const isFrag = fragmentSet.has(block);
    const hasUpper = /[A-Z]/.test(block);
    const hasLower = /[a-z]/.test(block);
    const isMixedCaseNoise = hasUpper && hasLower; // 水印乱码特征
    if (isFrag || isMixedCaseNoise) {
      standaloneRe.push(block);
    }
  }
  standaloneRe.sort((a, b2) => b2.length - a.length);
  for (const block of standaloneRe) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escRe(block)}(?![A-Za-z0-9])`, 'g');
    t = t.replace(re, ' ');
  }


  // ---- 夹在汉字中间的 1-3 位含字母碎片（如「证b书6」）----
  // 形如 汉字+字母数字混合1-3位+汉字，或 汉字+字母+汉字
  t = t.replace(/([一-龥])(?=[A-Za-z])[A-Za-z0-9]{1,3}([一-龥])/g, '$1$2');
  // 汉字与标点间的悬挂碎片：汉字+1-4位字母数字+标点 或 标点+字母数字+汉字
  t = t.replace(/([一-龥])(?=[A-Za-z])[A-Za-z0-9]{1,4}([，。；：、！？,.!?;:s])/g, '$1$2');
  t = t.replace(/([，。；：、！？,.!?;:s])(?=[A-Za-z])[A-Za-z0-9]{1,4}([一-龥])/g, '$1$2');

  // ---- OCR 数字空格收拢：「1 2 年」→「12 年」，但保留专业词 ----
  t = t.replace(/(\d)\s+(\d)/g, '$1$2');

  // ---- 还原专业词占位 ----
  for (const [tok, word] of protectMap) {
    t = t.split(tok).join(word);
  }

  // 清理多余空白
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 姓名提取：优先从拒因 JSON / 文件名，其次正文首行 ─────────
function guessName(rel, reason) {
  const base = path.basename(rel).replace(/\.(ocr\.txt|txt|pdf|docx)$/i, '');
  // 文件名常为「姓名.xxx」或「姓名-xxx」或「姓名_xxx」
  const nameFromFile = base
    .replace(/^\d+/, '')  // 去掉前导序号（1.docx 这种没有姓名）
    .replace(/\.(ocr|txt|png)$/i, '');
  // 若文件名是纯数字/序号（如 1.docx），无法取姓名 → 从正文首行
  if (/^\d+$/.test(nameFromFile)) return '';
  // 去掉常见后缀
  const clean = nameFromFile
    .replace(/_(?:\d+)?$/, '')
    .replace(/\s*\(1\)$/, '')
    .replace(/简历$/, '')
    .replace(/^CV\s*/i, '');
  return clean;
}

// ── 主体：枚举并处理全部简历 ───────────────────────────────────
const jobs = fs.readdirSync(DATA).filter((j) => {
  const p = path.join(DATA, j);
  return fs.statSync(p).isDirectory() && !j.startsWith('~');
});

const records = [];
const failures = [];
const rejectReasons = {};

// 预读各岗位拒因 JSON
for (const job of jobs) {
  const rp = path.join(DATA, job, '被拒绝简历', '_拒绝原因.json');
  if (fs.existsSync(rp)) {
    try {
      rejectReasons[job] = JSON.parse(fs.readFileSync(rp, 'utf8'));
    } catch (e) {
      failures.push({ file: path.join(job, '被拒绝简历', '_拒绝原因.json'), reason: 'JSON 解析失败: ' + e.message });
    }
  }
}

function addFailure(rel, reason) {
  failures.push({ file: rel, reason });
}

// 处理每个文件
for (const job of jobs) {
  const jobDir = path.join(DATA, job);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else files.push(fp);
    }
  })(jobDir);

  for (const fp of files) {
    const rel = path.relative(DATA, fp);
    const name = path.basename(fp);
    // 跳过非简历文件
    if (!/\.(pdf|docx|txt|ocr\.txt)$/i.test(name)) continue;
    if (name.startsWith('~$')) continue; // Word 临时文件
    if (name.includes('_拒绝原因')) continue;

    const jobName = job;

    // 档位文件夹：rel = 岗位/档位/文件 或 岗位/文件（根级进面样本）或 岗位/被拒绝简历/文件
    const parts = rel.split(/[\\/]/);
    // 只有两段（岗位/文件）→ 根级样本，folder 为空（正样本）；三段 → folder=parts[1]
    const folder = parts.length >= 3 ? parts[1] : '';
    const subFolder = parts.length > 2 ? parts[2] : ''; // 被拒绝简历 下的层级

    // JD 文件：排除（JD 不做样本；可能是 jd 命名，也可能是岗位名命名的 JD docx）
    if (/~/.test(name)) continue;
    // 根级文件若是 JD 文档（文字层为 JD 描述而非简历），交给主逻辑按正文判断，这里先排除已知 JD 名
    // 但 xxx.docx / yyy.docx / jd.docx 都是 JD —— 用「是否含 jd 名」+ 目录结构判断不可靠，
    // 改为：root 级 docx 且无档位文件夹，若文字层是 JD 描述则跳过（由后续处理决定）。这里仅跳过明确 JD 名。
    if (/[Jj][Dd]\.(docx|txt)$/.test(name)) continue;

    // 根级 docx 且无内嵌图片、文字层无简历特征 → JD 文档（如 somepos.docx、anotherpos.docx）
    // 这些是岗位 JD 描述，不是简历样本。识别：docx 无 word/media 且文件名非「纯序号」。
    if (!folder && /\.docx$/i.test(name)) {
      const rawB = fs.readFileSync(fp);
      const hasMedia = rawB.toString('latin1').includes('word/media/');
      if (!hasMedia && !/^\d+\.docx$/.test(name)) {
        continue; // JD 文档，跳过
      }
    }

    // 标签判定
    let label = null;
    let rejectReason = '';
    let tier = folder;
    if (folder === '被拒绝简历') {
      // 用拒因表
      const rr = rejectReasons[job] || {};
      const reasonKey = Object.keys(rr).find((k) => name.startsWith(k) || name.includes(k));
      rejectReason = reasonKey ? rr[reasonKey] : '';
      label = classifyByRejectReason(job, rejectReason);
      if (!label) {
        // 拒因表没命中（如某岗位无拒因文件、某人未捕获评估）：
        // 被拒绝简历默认按真负样本处理（rejected = neg），并如实记录。
        label = 'neg';
        if (!rejectReason) addFailure(rel, '被拒绝简历且无拒因可查，默认按 neg 处理');
      }
      // 被拒绝简历的档位原文 = 拒因里的档位信息
      tier = rejectReason || '被拒绝简历';
    } else {
      label = classifyByFolder(job, folder);
      if (!label) {
        addFailure(rel, '未知档位文件夹: ' + folder);
        continue;
      }
    }

    // 提取正文
    let body = '';
    let evalText = '';
    const warnings = [];
    const ext = path.extname(name).toLowerCase();
    try {
      if (ext === '.pdf') {
        body = extractPdfText(fp);
        // PDF 无面试评价文本层（评价在 docx），body 即正文，后续统一清洗
      } else if (ext === '.docx') {
        const docText = extractDocxText(fp);
        const { body: b, evalText: ev } = splitEvalFromText(docText);
        evalText = ev;
        // 进面简历 docx：正文是内嵌图片（文字层只有面试评价）。若文字层有 >20 字正文则用之，
        // 否则（纯扫描件）OCR 全部内嵌图片作为正文。
        if (b.trim().length > 20) {
          body = b;
        } else {
          body = ocrDocxEmbedded(fp, rel, warnings);
          if (!body.trim() && !evalText) {
            addFailure(rel, 'docx 无文字层且 OCR 无输出' + (warnings.length ? '；WARN: ' + warnings.join(' | ') : ''));
            continue;
          }
        }
      } else if (ext === '.txt' || name.endsWith('.ocr.txt')) {
        // 已提取的文本（.txt 预览 或 .ocr.txt）
        body = fs.readFileSync(fp, 'utf8');
        // .ocr.txt 为空但有同名 .png 时回退 OCR 该图
        if (!body.trim() && /\.ocr\.txt$/i.test(name)) {
          const pngPath = fp.replace(/\.ocr\.txt$/i, '.png');
          if (fs.existsSync(pngPath)) {
            body = ocrImage(pngPath, 'fallback_' + (path.basename(fp).replace(/[\\/:]/g, '_')));
          }
        }
      }
    } catch (e) {
      addFailure(rel, '抽取异常: ' + String(e.message).slice(0, 200));
      continue;
    }

    // 清洗
    body = cleanText(body);
    // 去重空白行
    body = body.replace(/\n{3,}/g, '\n\n').trim();

    if (!body && !evalText) {
      addFailure(rel, '清洗后正文为空');
      continue;
    }

    // 姓名：被拒绝简历用拒因表键名（权威），否则从文件名猜
    let nameFromFile;
    if (folder === '被拒绝简历' && rejectReason) {
      nameFromFile = Object.keys(rejectReasons[job] || {}).find((k) => name.startsWith(k) || name.includes(k)) || guessName(rel, rejectReason);
    } else {
      nameFromFile = guessName(rel, rejectReason);
    }

    // 只有评价文本、没有简历正文的记录 → 强制 skip。
    // 「判不了 ≠ 不合格」：没有简历就既不能当正样本也不能当负样本，让它退出判据，
    // 而不是拿一句面试评语去代表这个人的简历。
    let label2 = label;
    let 备注;
    if (!body && evalText) {
      label2 = 'skip';
      备注 = '仅有面试评价文本、无简历正文，不进正/负判据';
    }

    const record = {
      岗位: job,
      档位原文: tier,
      标签: label2,
      姓名: nameFromFile,
      简历正文: body,
      面试评价文本: evalText.trim(),
      来源文件: rel,
      字数: body ? body.replace(/\s/g, '').length : 0,
    };
    if (rejectReason) record.拒因 = rejectReason;
    if (备注) record.备注 = 备注;
    records.push(record);
  }
}

// ── 统计表 ─────────────────────────────────────────────────────
const stats = {};
for (const r of records) {
  stats[r.岗位] = stats[r.岗位] || { pos: [], neg: [], skip: [] };
  stats[r.岗位][r.标签].push(r.字数);
}

const out = {
  _meta: {
    generated: new Date().toISOString(),
    source: DATA,
    note: '标签口径：进过面一律正样本；被拒绝简历按拒因二次分流(pos/neg/skip)',
  },
  records,
  failures,
  stats,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

// ── 打印统计表 ────────────────────────────────────────────────
console.log('\n========== 统计表：岗位 × 标签 ==========');
console.log('岗位'.padEnd(16) + ' 正样本(pos) 负样本(neg)  跳过(skip)  正文字数中位数');
let totalPos = 0, totalNeg = 0, totalSkip = 0;
for (const job of jobs) {
  const s = stats[job];
  if (!s) continue;
  const med = (arr) => {
    if (!arr.length) return '-';
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  totalPos += s.pos.length; totalNeg += s.neg.length; totalSkip += s.skip.length;
  console.log(
    (job.length > 15 ? job.slice(0, 15) + '…' : job).padEnd(16) +
    ` ${String(s.pos.length).padStart(6)}      ${String(s.neg.length).padStart(6)}      ${String(s.skip.length).padStart(6)}      ${med(s.pos)}`,
  );
}
console.log('-'.repeat(60));
console.log(`合计：正样本 ${totalPos}，负样本 ${totalNeg}，跳过 ${totalSkip}`);
console.log(`\n产物：${OUT}`);

// ── 抽取失败清单 ──────────────────────────────────────────────
console.log('\n========== 抽取失败清单（' + failures.length + ' 项） ==========');
for (const f of failures) console.log(`  [${f.file}] ${f.reason}`);

// ── 随机样本正文前 300 字 ─────────────────────────────────────
console.log('\n========== 随机样本抽样（正文前 300 字） ==========');
const sampleIdx = [];
for (const r of records) {
  if (r.标签 === 'pos' && r.简历正文.length > 50) sampleIdx.push(r);
}
// 固定种子取 3 份
const seeded = [Math.floor(sampleIdx.length / 3), Math.floor(sampleIdx.length / 2), sampleIdx.length - 1];
for (const i of seeded.slice(0, 3)) {
  const r = sampleIdx[i];
  if (!r) continue;
  console.log(`\n--- ${r.岗位} / ${r.档位原文} / ${r.姓名} / ${r.标签} (${r.字数}字) ---`);
  console.log(r.简历正文.slice(0, 300));
}
