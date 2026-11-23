/**
 * 端到端：用【合成示例需求行】跑通 映射 → 本地 Excel 写入。
 *
 * 数据来源：scripts/fixtures/reqsheet-sample-rows.json —— 纯合成数据，
 * 结构与真实提取路径（atsxPc_fieldLine 结构化提取 + 审批时间线合成）的输出一致。
 *
 * 跑法：node scripts/run-electron-node.mjs scripts/reqsheet-e2e-real.mjs <rows.json> <out.xlsx>
 * 验的是：模板落地 → 表头守卫 → 映射 → 追加 → 备份 → 去重复跑。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { build } from 'esbuild';

const require_ = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 默认用仓库内的合成夹具 + 临时输出，可无参跑进 npm test
const rowsPath = process.argv[2] || path.join(ROOT, 'scripts/fixtures/reqsheet-sample-rows.json');
const outDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.reqsheet-out-'));
const outPath = process.argv[3] || path.join(outDir, '招聘进展表-测试.xlsx');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('✓ ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('✗ ' + label + (extra ? '  → ' + extra : '')); }
}

// 把 TS 服务打成可 import 的 ESM（与 smoke-db-migration 同样的做法）
const tmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.reqsheet-e2e-'));
const bundle = path.join(tmpDir, 'writer.cjs');
// electron 桩：ELECTRON_RUN_AS_NODE 下 require('electron') 只返回可执行文件路径，
// 拿不到 app.getPath —— 用别名把它换成一个最小桩（与 oplog-lab 同样的做法）。
const stub = path.join(tmpDir, 'electron-stub.cjs');
const userData = path.join(tmpDir, 'userData');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(stub, [
  'exports.app = {',
  '  getPath: () => ' + JSON.stringify(userData) + ',',
  '  getAppPath: () => ' + JSON.stringify(ROOT) + ',',
  '};',
].join('\n'));
await build({
  entryPoints: [path.join(ROOT, 'src/main/services/req-sheet-writer.ts')],
  outfile: bundle,
  bundle: true, platform: 'node', format: 'cjs', target: 'node18',
  external: ['exceljs', 'better-sqlite3'],
  alias: { electron: stub },
});
const W = require_(bundle);

const raw = JSON.parse(fs.readFileSync(rowsPath, 'utf8'));
console.log('\n=== 输入：真机抓取的 ' + raw.length + ' 条需求 ===');
console.log(raw.map((r) => r['需求编号']).join(', '));

// 从模板起一张干净的目标表
const tpl = W.getTemplatePath();
ok(!!tpl && fs.existsSync(tpl), '模板存在', tpl);
fs.copyFileSync(tpl, outPath);

console.log('\n=== 第 1 次写入 ===');
const r1 = await W.appendRowsToSheet(raw, { xlsxPath: outPath });
console.log(JSON.stringify(r1));
ok(!r1.header_mismatch, '表头守卫通过（模板 15 列被认出来）');
ok(r1.written === raw.length, '10 条全部写入', `written=${r1.written}`);
ok(r1.skipped_dup === 0, '首轮无重复', `skipped=${r1.skipped_dup}`);
ok(!r1.blocked_file, '文件未被占用');

console.log('\n=== 复跑（去重必须全部跳过）===');
const r2 = await W.appendRowsToSheet(raw, { xlsxPath: outPath });
console.log(JSON.stringify(r2));
ok(r2.written === 0, '复跑一条都不写', `written=${r2.written}`);
ok(r2.skipped_dup === raw.length, '10 条全部判为重复', `skipped=${r2.skipped_dup}`);

console.log('\n=== 回读 Excel 校验 ===');
const ExcelJS = require_('exceljs');
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(outPath);
const ws = wb.worksheets[0];
ok(ws.rowCount === raw.length + 1, '共 11 行（1 表头 + 10 数据）', `实际 ${ws.rowCount}`);

const hdr = ws.getRow(1).values.slice(1).map((v) => String(v == null ? '' : v));
ok(hdr.length === 15, '表头仍是 15 列', `实际 ${hdr.length}`);
// 注意：xlsx 里换行存的是 \n，代码里的 EXPECTED_HEADERS 写成 \r\n，
// 由 normalizeHeader 归一后比较 —— 断言这里也要归一，否则测的是换行符不是表头。
const nh = (s) => String(s).replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
ok(nh(hdr[0]) === nh('0级部门\r\nLevel 0 Department'), '表头第 1 列未被改写', hdr[0].replace(/\n/g, '\\n'));
ok(nh(hdr[14]) === nh('招聘需求编号\r\nReq#'), '表头第 15 列未被改写', hdr[14].replace(/\n/g, '\\n'));

const body = [];
for (let i = 2; i <= ws.rowCount; i++) {
  const v = ws.getRow(i).values.slice(1).map((x) => String(x == null ? '' : x));
  body.push(v);
}
const nos = body.map((r) => r[14]);
ok(JSON.stringify(nos) === JSON.stringify(raw.map((r) => r['需求编号'])),
  'O 列需求编号与输入逐条对齐（没有错位）', nos.join(','));

// 抽查 R00011：字段最全的一条
const i11 = nos.indexOf('R00011');
const r11 = body[i11];
ok(r11[2] === 'ZBJ测试需求', 'C 职位名称 ← 需求名称', r11[2]);
ok(r11[5] === 'P5-1', 'F 级别 ← 职级', r11[5]);
ok(r11[6] === '杭州', 'G 工作地 ← 工作地点', r11[6]);
ok(r11[7] === '审批人B', 'H 上级 ← 直属上级', r11[7]);
ok(r11[8] === '新增', 'I 招聘原因 ← 需求类型', r11[8]);
ok(r11[9] === '外包', 'J HC类别 ← 人员类型', r11[9]);
ok(r11[10] === '2024-10-25', 'K 审批具体时间 ← 审批时间线（取日期部分）', r11[10]);
ok(r11[11] === '2025-04-23', 'L Lead Time = K + 180 天', r11[11]);
ok(r11[12] === '2024-10-12', 'M 招聘启动日期 ← 开始日期', r11[12]);
ok(r11[13] === '2024-07', 'N 预期到岗保留月粒度（没被补成整日）', r11[13]);
ok(r11[0] === '' && r11[1] === '', 'A/B 部门层级留空（未登记对照表时不猜）');
ok(r11[3] === '' && r11[4] === '', 'D 关键岗位 / E 紧急度 留空（飞书无此字段）');

// 空值占位不许进表
const hasPlaceholder = body.some((r) => r.some((c) => /^(--|—)$/.test(c)));
ok(!hasPlaceholder, '全表没有 "--" 占位符');

// 备份
const bakDir = path.dirname(outPath);
const baks = fs.readdirSync(bakDir).filter((f) => f.includes(path.basename(outPath, '.xlsx')) && f.includes('.bak-'));
ok(baks.length >= 1, '写入前已生成备份', baks.slice(0, 2).join(', '));

console.log('\n' + '='.repeat(60));
console.log(fail === 0 ? `✓ 全部通过：${pass}/${pass}` : `✗ 失败 ${fail} 项 / 通过 ${pass} 项`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
try { if (!process.argv[3]) fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
