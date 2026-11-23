// 飞书招聘需求 → 本地 Excel 写入服务
//
// 职责：读取 / 追加本地招聘进展表；去重；备份；pending queue（文件被锁时暂存）
//
// 安全约束：
//   · 只追加，绝不删除或修改现有行
//   · 写入前做 header guard；格式不认识就拒绝写
//   · 写入前备份（最多 10 份）；原子写（.tmp → rename）
//   · 文件被 Excel 占用时落 sqlite pending queue，下次启动自动 flush
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import ExcelJS from 'exceljs';
import { getDb, getSetting, setSetting } from '../db';
import { oplog } from './oplog';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';

export const REQSHEET_TEMPLATE_NAME = '招聘进展表.xlsx';
const BACKUP_MAX = 10;

// 15 个期望表头（含 \r\n 双语行）
export const EXPECTED_HEADERS = [
  '0级部门\r\nLevel 0 Department',
  '1级部门\r\nLevel 1 Department',
  '职位名称\r\nJob Title',
  '关键岗位\r\nCritical Position',
  '紧急度\r\nUrgency Level',
  '级别\r\nJob Level',
  '工作地\r\nBase Location',
  '上级\r\nHiring Manager',
  '招聘原因\r\nReason',
  'HC类别\r\nHC Type',
  '审批具体时间\r\nReq Approval Date',
  'Lead Time cutoff 180D',
  '招聘启动日期\r\nHiring Kick Off Date',
  '预期到岗时间\r\nExpected Onboard Time',
  '招聘需求编号\r\nReq#',
];
const COL_REQ_ID = 15;   // O列 = 第 15 列（1-indexed）

export interface SheetRow {
  A?: string; B?: string; C?: string; D?: string; E?: string;
  F?: string; G?: string; H?: string; I?: string; J?: string;
  K?: string; L?: string; M?: string; N?: string; O?: string;
  [col: string]: string | undefined;
}

export interface WriteResult {
  written: number;
  skipped_dup: number;
  blocked_file: boolean;
  pending_queued: number;
  unmapped_fields: number;
  header_mismatch?: string;
  errors: string[];
}

// ── 配置 ────────────────────────────────────────────────────────────────────

export function getTargetXlsxPath(): string {
  try {
    const s = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
    const configured = (s as any).reqSheet?.targetPath as string | undefined;
    if (configured && configured.trim()) return configured.trim();
  } catch { /* ignore */ }
  const desktop = path.join(app.getPath('home'), 'Desktop');
  return path.join(desktop, REQSHEET_TEMPLATE_NAME);
}

/**
 * 空白模板（只有表头行的 15 列表）。TA 机器上还没有目标表时用它自举。
 *
 * ⚠️ 这三个候选此前【全是死路】：src/assets/ 目录从来没有过、
 * tools/feishu-req-sheet-sync/ 在收口时被整个删掉、tools/ 也不在 extraResources 里。
 * 结果 getTemplatePath() 恒返回 ''，新机器上第一次跑必然失败。
 * 现在模板落在仓库根 resources/，并已加进 package.json 的 extraResources。
 */
export function getTemplatePath(): string {
  const candidates = [
    // 开发期：仓库根 resources/
    path.join(process.cwd(), 'resources', 'reqsheet-template.xlsx'),
    // 打包后：extraResources 落在 process.resourcesPath 下
    path.join(process.resourcesPath || '', 'resources', 'reqsheet-template.xlsx'),
    path.join(process.resourcesPath || '', 'reqsheet-template.xlsx'),
    // 兜底：相对 app 目录
    path.join(app.getAppPath(), '..', 'resources', 'reqsheet-template.xlsx'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

// ── 表头校验 ─────────────────────────────────────────────────────────────────

function normalizeHeader(h: string): string {
  return String(h || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function checkHeaders(ws: ExcelJS.Worksheet): { ok: boolean; diff: string } {
  const headerRow = ws.getRow(1);
  const actual: string[] = [];
  for (let c = 1; c <= 15; c++) {
    const cell = headerRow.getCell(c);
    const v = cell.value;
    actual.push(typeof v === 'string' ? v : (v == null ? '' : String(v)));
  }
  const diffs: string[] = [];
  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    const exp = normalizeHeader(EXPECTED_HEADERS[i]);
    const got = normalizeHeader(actual[i] || '');
    if (exp !== got) diffs.push(`列${String.fromCharCode(65 + i)}: 期望「${exp}」实际「${got}」`);
  }
  return diffs.length === 0
    ? { ok: true, diff: '' }
    : { ok: false, diff: diffs.join('; ') };
}

// ── 备份 ────────────────────────────────────────────────────────────────────

function makeBackup(filePath: string): void {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const ext = path.extname(filePath);
    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '-',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    const bakPath = path.join(dir, `${base}.bak-${ts}${ext}`);
    fs.copyFileSync(filePath, bakPath);
    // 只保留最新 BACKUP_MAX 份
    const baks = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-`) && f.endsWith(ext))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = BACKUP_MAX; i < baks.length; i++) {
      try { fs.unlinkSync(path.join(dir, baks[i].f)); } catch { /* ignore */ }
    }
  } catch (e: any) {
    oplog('reqsheet', 'backup-failed', { reason: e?.message });
  }
}

// ── Pending Queue（SQLite） ──────────────────────────────────────────────────

function ensurePendingTable(): void {
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS reqsheet_pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queued_at INTEGER NOT NULL,
        row_json TEXT NOT NULL
      )
    `);
  } catch { /* ignore */ }
}

function queuePending(rows: SheetRow[]): void {
  try {
    ensurePendingTable();
    const stmt = getDb().prepare('INSERT INTO reqsheet_pending (queued_at, row_json) VALUES (?, ?)');
    const now = Date.now();
    for (const row of rows) {
      stmt.run(now, JSON.stringify(row));
    }
  } catch (e: any) {
    oplog('reqsheet', 'queue-pending-failed', { reason: e?.message });
  }
}

function drainPending(): SheetRow[] {
  try {
    ensurePendingTable();
    const rows = getDb().prepare('SELECT id, row_json FROM reqsheet_pending ORDER BY id ASC').all() as any[];
    if (!rows.length) return [];
    const ids = rows.map((r: any) => r.id);
    getDb().prepare(`DELETE FROM reqsheet_pending WHERE id IN (${ids.join(',')})`).run();
    return rows.map((r: any) => { try { return JSON.parse(r.row_json); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function getPendingCount(): number {
  try {
    ensurePendingTable();
    const r = getDb().prepare('SELECT COUNT(*) as n FROM reqsheet_pending').get() as any;
    return r?.n ?? 0;
  } catch { return 0; }
}

// ── 字段映射（从共享 map 文件加载） ─────────────────────────────────────────

// 列字母 A..O → 0-indexed
function colToIndex(col: string): number {
  return col.toUpperCase().charCodeAt(0) - 65;
}

function applyMapping(rawFields: Record<string, string>): { row: SheetRow; unmappedCount: number } {
  // 动态 require 共享映射（不在 TS 类型树里，运行时 JS）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // ⚠️ 路径深度：本文件在 src/main/services/，`../../` 只到 src/，
  // tools/ 在【仓库根】，必须三层。写成两层时 esbuild/require 直接 resolve 失败，
  // 而 reqsheet:lab 是直接 require 映射表来测的，测不到这条路径 —— 真机跑写入才炸出来。
  const { SHEET_COLUMN_MAP } = require('../../../tools/_shared/req-to-sheet-map.js');

  const row: SheetRow = {};
  let unmappedCount = 0;

  const colKValues: Record<string, string> = {};  // 先收集各列值，再做计算列

  for (const entry of SHEET_COLUMN_MAP) {
    if (entry.compute) continue;  // 计算列留到后面
    if (entry.unmapped || !entry.sources || entry.sources.length === 0) {
      row[entry.col] = '';
      unmappedCount++;
      continue;
    }
    let val = '';
    for (const src of entry.sources) {
      const candidate = rawFields[src] || '';
      if (candidate) { val = candidate; break; }
    }
    // transform
    if (val && entry.transform) {
      try { val = entry.transform(val); } catch { /* ignore */ }
    }
    row[entry.col] = val;
    colKValues[entry.col] = val;
  }

  // 计算列（如 L = K + 180天）
  for (const entry of SHEET_COLUMN_MAP) {
    if (!entry.compute) continue;
    try {
      row[entry.col] = entry.compute(colKValues) || '';
    } catch {
      row[entry.col] = '';
    }
  }

  return { row, unmappedCount };
}

// ── 主写入函数 ───────────────────────────────────────────────────────────────

/**
 * 将提取出的需求字段列表追加到本地 Excel。
 * rowFields: 每项是 { 飞书字段名: 值 } + __row_id__（需求编号）
 */
export async function appendRowsToSheet(
  rowFields: Array<Record<string, string>>,
  opts?: { xlsxPath?: string }
): Promise<WriteResult> {
  const result: WriteResult = {
    written: 0,
    skipped_dup: 0,
    blocked_file: false,
    pending_queued: 0,
    unmapped_fields: 0,
    errors: [],
  };

  const xlsxPath = opts?.xlsxPath || getTargetXlsxPath();

  // 确保目标文件存在
  if (!fs.existsSync(xlsxPath)) {
    const tpl = getTemplatePath();
    if (tpl && fs.existsSync(tpl)) {
      try {
        fs.copyFileSync(tpl, xlsxPath);
        oplog('reqsheet', 'template-copied', { dest: xlsxPath });
      } catch (e: any) {
        result.errors.push('无法创建目标文件：' + e?.message);
        return result;
      }
    } else {
      result.errors.push(`目标文件不存在且无内置模板：${xlsxPath}`);
      return result;
    }
  }

  // 先 flush pending queue
  const pending = drainPending();

  // 映射字段
  const mappedRows: SheetRow[] = [];
  let totalUnmapped = 0;
  const allToWrite = [...pending, ...rowFields];

  for (const fields of allToWrite) {
    const reqId = String(fields['需求编号'] || fields['__row_id__'] || '').trim();
    if (!reqId) {
      result.errors.push('跳过一行：需求编号为空（硬错误，不写入）');
      continue;
    }
    const { row, unmappedCount } = applyMapping(fields);
    row['O'] = reqId;   // 确保需求编号
    totalUnmapped += unmappedCount;
    mappedRows.push(row);
  }
  result.unmapped_fields = totalUnmapped;

  if (mappedRows.length === 0) return result;

  // 备份
  makeBackup(xlsxPath);

  // 读取工作簿
  let wb: ExcelJS.Workbook;
  let ws: ExcelJS.Worksheet;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    ws = wb.worksheets[0];
    if (!ws) throw new Error('工作簿没有工作表');
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/EBUSY|EPERM|locked/i.test(msg)) {
      result.blocked_file = true;
      queuePending(mappedRows);
      result.pending_queued = mappedRows.length;
      oplog('reqsheet', 'file-locked', { queued: mappedRows.length });
      return result;
    }
    result.errors.push('读取文件失败：' + msg);
    return result;
  }

  // Header guard
  const headerCheck = checkHeaders(ws);
  if (!headerCheck.ok) {
    result.header_mismatch = headerCheck.diff;
    result.errors.push('表头不匹配，拒绝写入：' + headerCheck.diff);
    oplog('reqsheet', 'header-mismatch', { diff: headerCheck.diff }, { ok: false });
    return result;
  }

  // 读出现有需求编号（O列，防御性去重）
  const existingIds = new Set<string>();
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const cellO = row.getCell(COL_REQ_ID);
    const v = String(cellO.value ?? '').trim();
    if (v) existingIds.add(v);
  });

  // 追加
  const lastRow = ws.lastRow?.number ?? 1;
  let nextRow = lastRow + 1;
  const templateRow = ws.getRow(Math.max(2, lastRow));  // 样式模板行

  for (const mappedRow of mappedRows) {
    const reqId = String(mappedRow['O'] || '').trim();
    if (existingIds.has(reqId)) {
      result.skipped_dup++;
      continue;
    }
    existingIds.add(reqId);

    const newRow = ws.getRow(nextRow++);
    // 复制上方行样式
    try {
      templateRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
        const newCell = newRow.getCell(colNum);
        newCell.style = { ...cell.style };
      });
    } catch { /* 样式复制失败不阻断写入 */ }

    // 填值
    for (let c = 0; c < EXPECTED_HEADERS.length; c++) {
      const colLetter = String.fromCharCode(65 + c);
      const val = mappedRow[colLetter] || '';
      newRow.getCell(c + 1).value = val;
    }
    newRow.commit();
    result.written++;
  }

  if (result.written === 0 && result.skipped_dup > 0) {
    // 全是重复，不需要写文件
    oplog('reqsheet', 'all-dup', { skipped: result.skipped_dup });
    return result;
  }

  // 原子写（.tmp → rename）
  const tmpPath = xlsxPath + '.tmp';
  try {
    await wb.xlsx.writeFile(tmpPath);
    fs.renameSync(tmpPath, xlsxPath);
  } catch (e: any) {
    const msg = String(e?.message || e);
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (/EBUSY|EPERM|locked/i.test(msg)) {
      result.blocked_file = true;
      queuePending(mappedRows);
      result.pending_queued = mappedRows.length;
      oplog('reqsheet', 'file-locked-on-write', { queued: mappedRows.length });
      return result;
    }
    result.errors.push('写入文件失败：' + msg);
    oplog('reqsheet', 'write-failed', { reason: msg }, { ok: false });
    return result;
  }

  oplog('reqsheet', 'rows-appended', { written: result.written, skipped_dup: result.skipped_dup });
  return result;
}

/** 读出 O 列所有需求编号（用于生成 run token 的 knownReqIds） */
export async function readKnownReqIds(xlsxPath?: string): Promise<string[]> {
  const p = xlsxPath || getTargetXlsxPath();
  if (!fs.existsSync(p)) return [];
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const ids: string[] = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const v = String(row.getCell(COL_REQ_ID).value ?? '').trim();
      if (v) ids.push(v);
    });
    return ids;
  } catch {
    return [];
  }
}
