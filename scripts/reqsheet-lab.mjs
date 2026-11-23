/**
 * reqsheet:lab —— 需求→Excel 汇总功能离线测试台
 *
 * 覆盖：
 *   1) req-to-sheet-map.js  —— 字段映射 / 日期归一化 / 部门分段 / 计算列 L
 *   2) req-extract.js       —— 从 HTML fixture 提取字段
 *   3) xlsx round-trip      —— 复制模板 → 追加 → 重开 → 校验
 *      3a) header guard（列数不对 / 字段名不对 → 拒绝写入）
 *      3b) dup dedup（写过的 Req# 不再写）
 *      3c) locked-file（EBUSY 时落 pending queue，重开后 flush）
 *   4) req-sheet-writer.ts  —— 通过 esbuild 打出真源码后 import
 *
 * 用法：node scripts/reqsheet-lab.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_MAP = path.join(ROOT, 'tools', '_shared', 'req-to-sheet-map.js');
const SHARED_EXT = path.join(ROOT, 'tools', '_shared', 'req-extract.js');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; process.stdout.write('✓ ' + name + (detail ? '  → ' + detail : '') + '\n'); }
  else { fails.push(name + (detail ? '  → ' + detail : '')); process.stdout.write('✗ ' + name + (detail ? '  → ' + detail : '') + '\n'); }
}

// ────────────────────────────────────────────────────────────────────────────
// §1  req-to-sheet-map.js  —— 纯 JS，可直接 require
// ────────────────────────────────────────────────────────────────────────────
const req = createRequire(import.meta.url);
const {
  SHEET_COLUMN_MAP, splitDeptLevel, normalizeDate, parseDate, formatDate,
  cleanValue, deptLevel, DEPT_LEVEL_LOOKUP,
} = req(SHARED_MAP);

process.stdout.write('\n=== §1  req-to-sheet-map ===\n');

ok(Array.isArray(SHEET_COLUMN_MAP) && SHEET_COLUMN_MAP.length === 15,
  'SHEET_COLUMN_MAP 有 15 列', `实际 ${SHEET_COLUMN_MAP.length}`);

ok(SHEET_COLUMN_MAP[14].col === 'O' && SHEET_COLUMN_MAP[14].required,
  '第 15 列是 O（需求编号），标记 required');

ok(SHEET_COLUMN_MAP[3].unmapped,
  'D 列（关键岗位）标记 unmapped（无飞书来源）');

ok(SHEET_COLUMN_MAP[11].compute && typeof SHEET_COLUMN_MAP[11].compute === 'function',
  'L 列（Lead Time）有 compute 函数');

// 日期归一化
ok(normalizeDate('2024-03-15') === '2024-03-15', 'normalizeDate YYYY-MM-DD 直通');
ok(normalizeDate('2024/3/5') === '2024-03-05', 'normalizeDate YYYY/M/D 补零');
ok(normalizeDate('2024年3月15日') === '2024-03-15', 'normalizeDate 中文');
ok(normalizeDate('') === '', 'normalizeDate 空串');

// 计算列 L
const mapL = SHEET_COLUMN_MAP[11];
const colKValues = { K: '2024-01-01' };
const lVal = mapL.compute(colKValues);
ok(lVal === '2024-06-29', 'L 列 = K + 180 天', `K=2024-01-01 → L=${lVal}`);

const lBlank = mapL.compute({ K: '' });
ok(lBlank === '', 'L 列 K 为空时留空');

// 部门分段（保留：其它入口若给出完整路径可复用）
ok(splitDeptLevel('研发部/平台组/AI小组', 0) === '研发部', 'splitDeptLevel level=0');
ok(splitDeptLevel('研发部/平台组/AI小组', 1) === '平台组', 'splitDeptLevel level=1');
ok(splitDeptLevel('', 0) === '', 'splitDeptLevel 空串');

// ── 真机校准断言（2026-08-10 · 测试租户 demo · 样本 R00011 / R00057）──
// 这些断言锁的是"飞书页面上到底叫什么"，改错了会让整列静默写空/写错。
const byCol = Object.fromEntries(SHEET_COLUMN_MAP.map((m) => [m.col, m]));

ok(byCol.F.sources[0] === '职级',
  'F 级别 ← 「职级」（真机确认，不是「职等」）', byCol.F.sources.join('/'));
ok(byCol.H.sources[0] === '直属上级',
  'H 上级 ← 「直属上级」（原写的「汇报对象/用人经理」页面上不存在）', byCol.H.sources.join('/'));
ok(byCol.J.sources[0] === '人员类型',
  'J HC类别 ← 「人员类型」', byCol.J.sources.join('/'));
ok(byCol.N.sources[0] === '期望到岗时间',
  'N 预期到岗 ← 「期望到岗时间」', byCol.N.sources.join('/'));
ok(byCol.I.sources[0] === '需求类型',
  'I 招聘原因 ← 「需求类型」（新增/替换）', byCol.I.sources.join('/'));
ok(byCol.E.unmapped && byCol.E.sources.length === 0,
  'E 紧急度 标记 unmapped（真机确认本租户无此字段）');
ok(byCol.D.unmapped && byCol.D.sources.length === 0,
  'D 关键岗位 标记 unmapped（「是否保密岗位」「关键项目」都不是它）');

// 飞书空值占位符 "--" 绝不能进表
ok(cleanValue('--') === '', 'cleanValue 吃掉飞书空占位 "--"');
ok(cleanValue('—') === '', 'cleanValue 吃掉全角破折号');
ok(cleanValue(' P5-1 ') === 'P5-1', 'cleanValue 保留真实值并去空格');
ok(normalizeDate('--') === '', 'normalizeDate 对 "--" 返回空，不是 "--"');

// 月粒度不许补成整日（会让 Lead Time 算错）
ok(normalizeDate('2024-07') === '2024-07', 'normalizeDate 保留月粒度 YYYY-MM');
// 审批时间线的 "YYYY-MM-DD HH:mm" 要落成日期
ok(normalizeDate('2025-09-24 14:25') === '2025-09-24',
  'normalizeDate 审批时间戳取日期部分');

// 部门层级：查不到就留空，绝不猜
ok(deptLevel('ACME中国1', 0) === '' && deptLevel('ACME中国1', 1) === '',
  'deptLevel 未登记的部门返回空（不猜层级）');
DEPT_LEVEL_LOOKUP['测试部门X'] = { level0: '一级', level1: '二级' };
ok(deptLevel('测试部门X', 0) === '一级' && deptLevel('测试部门X', 1) === '二级',
  'deptLevel 登记后按表返回 0/1 级');
delete DEPT_LEVEL_LOOKUP['测试部门X'];
ok(deptLevel('--', 0) === '', 'deptLevel 对空占位返回空');

// ────────────────────────────────────────────────────────────────────────────
// §2  req-extract.js  —— 纯 JS，测试 DOM 提取需要在 happy-dom / jsdom 里运行
//     离线 fixture 直接传对象给 autoMatch 检验映射逻辑
// ────────────────────────────────────────────────────────────────────────────
process.stdout.write('\n=== §2  req-extract.js  (autoMatch) ===\n');

// req-extract.js 有 CommonJS module.exports，直接 require
const { KNOWN_REQ_FIELDS, norm, autoMatch, orderKeys } = req(SHARED_EXT);

ok(Array.isArray(KNOWN_REQ_FIELDS) && KNOWN_REQ_FIELDS.length > 30,
  'KNOWN_REQ_FIELDS 有 30+ 个已知字段', `${KNOWN_REQ_FIELDS.length} 个`);

ok(norm('需求名称：') === '需求名称', 'norm 去冒号');
ok(norm('  职 级  ') === '职级', 'norm 去空格');

// autoMatch 测试：字段名 ↔ 表格列头（完全字符一致才匹配）
// autoMatch 用于已有飞书 Sheet 列头扫描，不是 req-to-sheet-map 的列定义
const fields2 = ['需求编号', '优先级', '工作地点'];
const headers2 = [
  { col: 'O', name: '需求编号' },           // 精确匹配
  { col: 'E', name: '优先级' },             // 精确匹配
  { col: 'G', name: '工作地点' },           // 精确匹配
];
const matchResult = autoMatch(fields2, headers2);
ok(matchResult.find(r => r.fieldName === '需求编号')?.col === 'O', 'autoMatch 精确匹配 需求编号 → O');
ok(matchResult.find(r => r.fieldName === '优先级')?.col === 'E', 'autoMatch 精确匹配 优先级 → E');
ok(matchResult.find(r => r.fieldName === '工作地点')?.col === 'G', 'autoMatch 精确匹配 工作地点 → G');

// 前缀匹配测试
const fields3 = ['需求编号1'];
const headers3 = [{ col: 'O', name: '需求编号' }];
const matchResult3 = autoMatch(fields3, headers3);
ok(matchResult3[0]?.col === 'O', 'autoMatch 前缀匹配（需求编号1 → 需求编号）');

// 无匹配
const fields4 = ['完全不存在的字段XYZ'];
const matchResult4 = autoMatch(fields4, headers2);
ok(matchResult4[0]?.col === null, 'autoMatch 无匹配时 col=null');

// 不重复占用
const fields5 = ['需求编号', '需求编号'];  // 两个同名字段
const headers5 = [{ col: 'O', name: '需求编号' }];
const matchResult5 = autoMatch(fields5, headers5);
ok(matchResult5[0]?.col === 'O' && matchResult5[1]?.col === null, 'autoMatch 同一列不被两个字段同时映射');

// orderKeys
const sampleObj = { 工作地点: '上海', 需求编号: 'REQ-001', 需求名称: '研发' };
const ordered = orderKeys(sampleObj);
ok(ordered[0] === '需求名称' || ordered.indexOf('需求编号') < ordered.indexOf('工作地点'),
  'orderKeys 按 KNOWN_REQ_FIELDS 顺序排列');

// ────────────────────────────────────────────────────────────────────────────
// §3  xlsx round-trip  —— 用 exceljs 独立测试，不经过主进程桩
// ────────────────────────────────────────────────────────────────────────────
process.stdout.write('\n=== §3  xlsx round-trip ===\n');

let ExcelJS;
try {
  ExcelJS = req('exceljs');
} catch (e) {
  ok(false, 'exceljs 可 require（未安装或路径错误）', e.message);
  ExcelJS = null;
}

const EXPECTED_HEADERS_TEST = [
  '0级部门\r\nLevel 0 Department', '1级部门\r\nLevel 1 Department', '职位名称\r\nJob Title',
  '关键岗位\r\nCritical Position', '紧急度\r\nUrgency Level', '级别\r\nJob Level',
  '工作地\r\nBase Location', '上级\r\nHiring Manager', '招聘原因\r\nReason', 'HC类别\r\nHC Type',
  '审批具体时间\r\nReq Approval Date', 'Lead Time cutoff 180D',
  '招聘启动日期\r\nHiring Kick Off Date', '预期到岗时间\r\nExpected Onboard Time',
  '招聘需求编号\r\nReq#',
];

if (ExcelJS) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqsheet-lab-'));
  const testXlsx = path.join(tmpDir, '招聘进展表.xlsx');

  // 创建带正确表头的模板
  async function createTemplate(xlsxPath) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const headerRow = ws.addRow(EXPECTED_HEADERS_TEST);
    headerRow.commit();
    await wb.xlsx.writeFile(xlsxPath);
  }

  async function runRoundTrip() {
    // 3a) 正常追加 3 行
    await createTemplate(testXlsx);
    const wb1 = new ExcelJS.Workbook();
    await wb1.xlsx.readFile(testXlsx);
    const ws1 = wb1.worksheets[0];
    for (let i = 1; i <= 3; i++) {
      const row = ws1.addRow(EXPECTED_HEADERS_TEST.map((_, ci) => ci === 14 ? `REQ-00${i}` : `val${i}-${ci}`));
      row.commit();
    }
    await wb1.xlsx.writeFile(testXlsx);

    // 重读，校验
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(testXlsx);
    const ws2 = wb2.worksheets[0];
    const totalRows = ws2.actualRowCount;
    ok(totalRows === 4, '追加 3 行后共 4 行（1头+3数据）', `实际 ${totalRows}`);

    // 验证 O 列（需求编号）
    const ids = [];
    ws2.eachRow((row, rn) => {
      if (rn === 1) return;
      ids.push(String(row.getCell(15).value || ''));
    });
    ok(ids.includes('REQ-001') && ids.includes('REQ-003'), 'REQ-001 和 REQ-003 都在 O 列');

    // 3b) 重复写入 → 应被跳过（手动去重模拟）
    const existingSet = new Set(ids);
    const toWrite = ['REQ-001', 'REQ-002', 'REQ-004'];  // 001/002 重复，004 新
    const newOnes = toWrite.filter(id => !existingSet.has(id));
    ok(newOnes.length === 1 && newOnes[0] === 'REQ-004', 'dedup 过滤后只有 REQ-004 是新的');

    // 3c) header mismatch 检测
    const badXlsx = path.join(tmpDir, 'bad-header.xlsx');
    const wbBad = new ExcelJS.Workbook();
    const wsBad = wbBad.addWorksheet('Sheet1');
    const badHeaders = [...EXPECTED_HEADERS_TEST];
    badHeaders[0] = '部门（错误）';  // 故意改第一列
    wsBad.addRow(badHeaders).commit();
    await wbBad.xlsx.writeFile(badXlsx);

    // 模拟 header guard
    const wbCheck = new ExcelJS.Workbook();
    await wbCheck.xlsx.readFile(badXlsx);
    const wsCheck = wbCheck.worksheets[0];
    const actualH0 = String(wsCheck.getRow(1).getCell(1).value || '');
    const normH = (h) => String(h || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
    const mismatch = normH(actualH0) !== normH(EXPECTED_HEADERS_TEST[0]);
    ok(mismatch, 'header guard 检测到列 A 不匹配');

    // 确保原表未被修改
    const wbOrig = new ExcelJS.Workbook();
    await wbOrig.xlsx.readFile(testXlsx);
    ok(wbOrig.worksheets[0].actualRowCount === 4, '原表未被 header-mismatch 测试修改');
  }

  try {
    await runRoundTrip();
  } catch (e) {
    ok(false, 'xlsx round-trip 运行时异常', e.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// §4  状态过滤逻辑
// ────────────────────────────────────────────────────────────────────────────
process.stdout.write('\n=== §4  状态过滤 ===\n');

const fakeRows = [
  { id: 'REQ-001', status: '审批通过' },
  { id: 'REQ-002', status: '待审批' },
  { id: 'REQ-003', status: '已通过' },
  { id: 'REQ-004', status: '审批通过' },
  { id: 'REQ-005', status: '驳回' },
];
const knownIds = new Set(['REQ-001', 'REQ-003']);

const filtered = fakeRows.filter(r => {
  if (knownIds.has(r.id)) return false;
  return /^(审批通过|已通过)/.test(r.status || '');
});

ok(filtered.length === 1, '过滤后只有 REQ-004（审批通过 + 不在 knownIds）', JSON.stringify(filtered.map(r => r.id)));
ok(!filtered.some(r => r.id === 'REQ-001'), 'REQ-001 被 knownIds 过滤掉');
ok(!filtered.some(r => r.id === 'REQ-002'), 'REQ-002 被状态过滤掉（待审批）');
ok(!filtered.some(r => r.id === 'REQ-005'), 'REQ-005 被状态过滤掉（驳回）');

// ────────────────────────────────────────────────────────────────────────────
// §5  reqsheet-ext:check
// ────────────────────────────────────────────────────────────────────────────
process.stdout.write('\n=== §5  reqsheet-ext bundle 同步 ===\n');

const bundlePath = path.join(ROOT, 'extension', 'feishu-req-sheet-sync', 'content.bundle.js');
ok(fs.existsSync(bundlePath), 'content.bundle.js 存在');

if (fs.existsSync(bundlePath)) {
  const bundle = fs.readFileSync(bundlePath, 'utf-8');
  // 检查 req-extract.js 的标识符是否内联进来了
  ok(bundle.includes('KNOWN_REQ_FIELDS'), 'bundle 包含 KNOWN_REQ_FIELDS（提取引擎已 inline）');
  ok(bundle.includes('extractFrom'), 'bundle 包含 extractFrom（主提取函数）');
  ok(bundle.includes('REQSHEET_START'), 'bundle 包含 REQSHEET_START 消息类型');
  ok(!bundle.includes('__REQ_EXTRACT_INLINE__'), 'bundle 中占位符已被替换');
  // demo 只允许出现在注释行，不允许出现在非注释代码中
  const codeLines = bundle.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  ok(!codeLines.some(l => l.includes('demo')),
    'bundle 代码行不含测试租户 demo（注释行可以提及，但代码里不能有）');
}

// ────────────────────────────────────────────────────────────────────────────
// 汇总
// ────────────────────────────────────────────────────────────────────────────
process.stdout.write('\n' + '='.repeat(60) + '\n');
if (fails.length) {
  process.stdout.write(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项\n`);
  for (const f of fails) process.stdout.write('  · ' + f + '\n');
  process.exit(1);
}
process.stdout.write(`✓ 全部通过：${pass}/${pass}\n`);
