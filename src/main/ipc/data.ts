// Data handlers (export CSV, clear all, open folder)
// 修复历史：
//  - C1: DATA_CLEAR_ALL 改用 clearAllData() 内存+磁盘立即重置
//  - Medium: CSV 导出支持"匿名统计"模式（剔除姓名/链接等 PII）
import { BrowserWindow, dialog, shell, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { handle } from './wrap';
import { IPC, PLATFORMS, PlatformId } from '../../shared/types';
import { getDb, clearAllData, getSetting, initEncryptionFromSettings, getEncryptionStatus, resetEncryptionKey, closeDb } from '../db';
import { toolManager } from '../tools/manager';
import { DEFAULT_SETTINGS } from '../../shared/constants';

// Low: IPC.DATA_IMPORT 尚未在 shared/types 中定义（本次禁止改动该文件），
// 先用局部常量落地导入通道；typeAdditionsNeeded 中已登记待主控补 IPC.DATA_IMPORT。
const DATA_IMPORT_CHANNEL = 'data:import';

type ExportMode = 'full' | 'anonymous';

interface ExportCsvArgs {
  date?: string; // 单日导出（向后兼容）
  startDate?: string; // Low: 日期范围起（含），与 endDate 搭配使用
  endDate?: string; // Low: 日期范围止（含）
  mode?: ExportMode;
  platform?: PlatformId; // H2(阶段1):按平台过滤导出，默认 'boss' 保兼容
}

// H2(阶段1):CSV 导出必须按平台过滤——candidates_export 是双平台共表，不加 WHERE 时
// 猎聘跑批写入的 liepin 行会混进 BOSS 的导出 CSV。
function safePlatform(p: any): PlatformId {
  return (PLATFORMS as readonly string[]).includes(p) ? (p as PlatformId) : 'boss';
}

// Low: 导入时用的候选人局部结构（不改 shared/types，仅本文件使用）
interface ImportCandidate {
  date?: string | null;
  jd_id?: string | null;
  name?: string | null;
  position?: string | null;
  company?: string | null;
  city?: string | null;
  experience?: string | null;
  degree?: string | null;
  salary?: string | null;
  score?: number | null;
  url?: string | null;
  greeted?: number;
  favorited?: number;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

export function registerDataHandlers(winGetter: () => BrowserWindow | null, dataDir: string) {
  // 加密状态：如实暴露设置说要加密、实际在写明文的降级态。
  // 原先这个失败只在主进程控制台打一行 warn，界面上毫无痕迹 —— 用户不可能知道。
  handle(IPC.DATA_ENCRYPTION_STATUS, () => getEncryptionStatus());

  // 重置加密密钥：仅在库中无旧密文数据时允许（否则会把已有密文变成永久不可读）
  handle(IPC.DATA_RESET_ENCRYPTION_KEY, () => resetEncryptionKey());

  const getExportDir = (): string => {
    try {
      const s = getSetting<any>('app-settings', DEFAULT_SETTINGS);
      return s?.data?.exportDir || dataDir;
    } catch {
      return dataDir;
    }
  };

  handle(IPC.DATA_EXPORT_CSV, async (_e, args?: ExportCsvArgs) => {
    const win = winGetter();
    if (!win) return { ok: false };
    // Low: 支持日期范围。startDate/endDate 均提供时按区间导出（含端点），
    // 否则回退到单日 date（未指定则今日），保持向后兼容。
    const hasRange = !!(args?.startDate && args?.endDate);
    // 规范化区间顺序，允许调用方传反
    let rangeStart = args?.startDate || '';
    let rangeEnd = args?.endDate || '';
    if (hasRange && rangeStart > rangeEnd) {
      const tmp = rangeStart;
      rangeStart = rangeEnd;
      rangeEnd = tmp;
    }
    const date = args?.date || todayKey();

    // Medium: 先弹模式选择（完整 / 匿名统计），再弹保存位置
    if (!args?.mode) {
      const modeResp = await dialog.showMessageBox(win, {
        type: 'question',
        title: '导出模式',
        message: '选择 CSV 导出模式：',
        buttons: ['完整信息（含姓名/链接）', '匿名统计（去姓名/链接）', '取消'],
        cancelId: 2,
        defaultId: 0,
      });
      if (modeResp.response === 2) return { ok: false, canceled: true };
      args = { ...args, date, mode: modeResp.response === 0 ? 'full' : 'anonymous' };
    }
    const finalMode = args.mode!;
    const isAnon = finalMode === 'anonymous';

    // Low: 极简 SQL 引擎的 WHERE 只支持等值，无法做范围比较；
    // 因此范围导出时取全部候选人后在 JS 内按日期区间过滤（数据量有上限，可接受）。
    // H2(阶段1):platform 条件并入 SQL WHERE，不在 JS 过滤（减少跨平台行进内存）。
    const platform = safePlatform(args?.platform);
    let rows: any[];
    if (hasRange) {
      const all = getDb()
        .prepare(
          'SELECT date,name,position,company,city,experience,degree,salary,score,greeted,favorited,url,note FROM candidates_export WHERE platform = ? ORDER BY score DESC',
        )
        .all(platform) as any[];
      rows = all.filter((r) => {
        const d = r.date as string;
        return typeof d === 'string' && d >= rangeStart && d <= rangeEnd;
      });
    } else {
      rows = getDb()
        .prepare(
          'SELECT date,name,position,company,city,experience,degree,salary,score,greeted,favorited,url,note FROM candidates_export WHERE platform = ? AND date = ? ORDER BY score DESC',
        )
        .all(platform, date) as any[];
    }

    const headers = isAnon
      ? ['日期', '岗位', '公司', '城市', '经验', '学历', '薪资', '匹配分', '已招呼', '已收藏', '备注']
      : ['日期', '姓名', '岗位', '公司', '城市', '经验', '学历', '薪资', '匹配分', '已招呼', '已收藏', '链接', '备注'];

    const lines = [headers.join(',')];
    for (const r of rows) {
      const cells: (string | null)[] = [r.date];
      if (!isAnon) cells.push(r.name);
      cells.push(r.position, r.company, r.city, r.experience, r.degree, r.salary, r.score);
      cells.push(r.greeted ? '是' : '否');
      cells.push(r.favorited ? '是' : '否');
      if (!isAnon) cells.push(r.url);
      cells.push(r.note);
      lines.push(
        cells
          .map((v) => {
            const s = v == null ? '' : String(v);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) {
              return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
          })
          .join(','),
      );
    }
    const csv = lines.join('\n');

    // Low: 范围导出时文件名体现区间
    const stamp = hasRange ? `${rangeStart}_${rangeEnd}` : date;
    const defaultName = `candidates-${stamp}${isAnon ? '-anonymous' : ''}.csv`;
    const defaultPath = path.join(getExportDir(), defaultName);
    const saveResp = await dialog.showSaveDialog(win, {
      title: isAnon ? '导出匿名统计 CSV' : '导出候选人 CSV',
      defaultPath,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (saveResp.canceled || !saveResp.filePath) return { ok: false, canceled: true };

    fs.writeFileSync(saveResp.filePath, '﻿' + csv, 'utf-8'); // BOM
    shell.showItemInFolder(saveResp.filePath);
    return { ok: true, path: saveResp.filePath, count: rows.length, mode: finalMode };
  });

  handle(IPC.DATA_CLEAR_ALL, async () => {
    const win = winGetter();
    if (!win) return false;
    const confirm = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '确认清空',
      message: '将清空所有本地数据（配置、JD、任务、日志、候选人记录），无法恢复。确定继续？',
      buttons: ['取消', '确认清空'],
      cancelId: 0,
      defaultId: 0,
    });
    if (confirm.response !== 1) return false;
    // C1 修复：调用真正的 clearAllData（清空所有业务表，含 settings→trusted/加密开关）
    clearAllData();
    // 第四次审查: 清空后一并重置内存态安全状态，杜绝加密开关/已信任第三方工具在内存中残留
    try {
      initEncryptionFromSettings(); // 重读（已空）设置 → 加密回到安全默认
    } catch {}
    try {
      toolManager.loadAll(); // 从空 DB 重建 → 已信任第三方工具清空
    } catch {}
    return true;
  });

  handle(IPC.DATA_OPEN_FOLDER, () => {
    shell.openPath(getExportDir());
  });

  // E5(2026-08-05)：备份整个数据目录 —— 主库 ta-platform.db 改用 better-sqlite3 的 backup()
  // 做在线一致备份（WAL 模式下 fs.copyFileSync 会拿到不一致快照，WAL 中的最新事务丢失/损坏）。
  // 其他文件（设置 JSON/扩展/日志）仍用递归复制。
  handle(IPC.DATA_BACKUP, async () => {
    const win = winGetter();
    if (!win) return { ok: false };
    const stamp = new Date().toISOString().slice(0, 10);
    const resp = await dialog.showOpenDialog(win, {
      title: '选择备份存放位置（将创建一个子文件夹）',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (resp.canceled || !resp.filePaths[0]) return { ok: false, canceled: true };
    const destRoot = resp.filePaths[0];
    const backupDir = path.join(destRoot, `ta-platform-backup-${stamp}`);
    try {
      // 先复制除主库外的所有文件（跳过 .db/.db-wal/.db-shm，稍后用 backup() 写主库）
      copyDirRecursiveExcept(dataDir, backupDir, (name) => /^ta-platform\.(db|db-wal|db-shm)$/.test(name));
      // 用 better-sqlite3 的 online backup API 做一致快照——WAL 模式安全，不会中断运行
      const db = getDb() as any;
      const dbDest = path.join(backupDir, 'ta-platform.db');
      await db.backup(dbDest);
      shell.showItemInFolder(backupDir);
      return { ok: true, path: backupDir };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // M-14: 从备份目录恢复（会先备份当前数据，再用备份覆盖）
  // 2026-08-07 审查项 P0-1: 原实现在 SQLite 句柄仍打开时执行 fs.rmSync，Windows 上
  // better-sqlite3 持有的文件锁会让删除在执行到一半时抛 EPERM：logs/chrome-profile/
  // extensions/ 已删，主库却删不掉 → dataDir 被删了一半而新数据未拷入，且进程仍用已
  // 被破坏的旧句柄继续写文件。
  //
  // 修复方案：closeDb() → 替换目录 → app.relaunch()+app.exit()
  // 而不是"提示用户重启但进程继续跑"——关库后进程已无法可靠服务任何请求。
  handle(IPC.DATA_RESTORE, async () => {
    const win = winGetter();
    if (!win) return { ok: false };
    const resp = await dialog.showOpenDialog(win, {
      title: '选择备份目录（选择之前备份生成的 ta-platform-backup-* 文件夹）',
      properties: ['openDirectory'],
    });
    if (resp.canceled || !resp.filePaths[0]) return { ok: false, canceled: true };
    const src = resp.filePaths[0];
    // 校验备份完整性
    const validNames = ['ta-platform.db', 'ta-platform.json', 'data.json'];
    if (!validNames.some((n) => fs.existsSync(path.join(src, n)))) {
      dialog.showErrorBox('恢复失败', '所选目录不像一个有效的备份（未找到 ta-platform.db）');
      return { ok: false, error: '无效备份目录' };
    }
    const confirm = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '确认恢复',
      message: '将用备份覆盖当前所有数据。恢复完成后应用会自动重启。当前数据会先自动备份到 rollback 文件夹，失败时可自动还原。确定继续？',
      buttons: ['取消', '确认恢复并重启'],
      cancelId: 0,
      defaultId: 0,
    });
    if (confirm.response !== 1) return { ok: false, canceled: true };

    // 1. 建 rollback 快照（此时句柄仍开，用在线 backup API 保一致快照）
    const rollbackDir = path.join(path.dirname(dataDir), `data-rollback-${Date.now()}`);
    try {
      fs.mkdirSync(rollbackDir, { recursive: true });
      // 非 db 文件用递归拷贝
      copyDirRecursiveExcept(dataDir, rollbackDir, (name) => /^ta-platform\.(db|db-wal|db-shm)$/.test(name));
      // 主库用在线 backup 保一致快照
      const db = getDb() as any;
      if (db && db.backup) await db.backup(path.join(rollbackDir, 'ta-platform.db'));
    } catch (e) {
      // rollback 快照失败不阻断恢复，但给出警告
      console.warn('[restore] rollback snapshot failed:', e);
    }

    // 2. 关闭 SQLite 句柄 —— 必须在文件系统操作之前，否则 Windows 文件锁会让 rmSync 中途抛 EPERM
    closeDb();

    // 3. 替换目录；失败时从 rollback 恢复原状再报错
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.mkdirSync(dataDir, { recursive: true });
      copyDirRecursive(src, dataDir);
    } catch (e: any) {
      // 尝试从 rollback 目录恢复原状
      try {
        if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
        if (fs.existsSync(rollbackDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
          copyDirRecursive(rollbackDir, dataDir);
        }
      } catch (re) {
        console.error('[restore] rollback recovery also failed:', re);
      }
      dialog.showErrorBox('恢复失败', `替换数据目录时出错，已尝试还原原始数据。\n${e?.message || String(e)}`);
      return { ok: false, error: e?.message || String(e) };
    }

    // 4. 替换成功 → 立即重启（关库后无法继续服务请求，重启是唯一安全出路）
    app.relaunch();
    app.exit(0);
    return { ok: true, rollback: rollbackDir };
  });

  // Low: 数据导入通道 —— 支持导入 CSV / JSON 候选人，做基本校验与去重（upsert 语义）。
  // 唯一键：优先 url（非空），否则用 date|name|company|position 组合键；命中则跳过（视为已存在）。
  handle(DATA_IMPORT_CHANNEL, async () => {
    const win = winGetter();
    if (!win) return { ok: false };
    const resp = await dialog.showOpenDialog(win, {
      title: '选择要导入的候选人文件（CSV 或 JSON）',
      properties: ['openFile'],
      filters: [
        { name: 'CSV / JSON', extensions: ['csv', 'json'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (resp.canceled || !resp.filePaths[0]) return { ok: false, canceled: true };
    const file = resp.filePaths[0];

    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (e: any) {
      dialog.showErrorBox('导入失败', '无法读取所选文件：' + (e?.message || String(e)));
      return { ok: false, error: e?.message || String(e) };
    }
    // 去除可能存在的 BOM
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

    const ext = path.extname(file).toLowerCase();
    let candidates: ImportCandidate[];
    try {
      candidates = ext === '.json' ? parseJsonCandidates(content) : parseCsvCandidates(content);
    } catch (e: any) {
      dialog.showErrorBox('导入失败', '文件解析失败：' + (e?.message || String(e)));
      return { ok: false, error: e?.message || String(e) };
    }

    if (candidates.length === 0) {
      dialog.showMessageBox(win, { type: 'info', title: '导入完成', message: '未在文件中解析到任何候选人记录。' });
      return { ok: true, imported: 0, skipped: 0, invalid: 0, total: 0 };
    }

    // 读取现有候选人，构建去重键集合（含本批次内去重）
    const db = getDb();
    const existing = db
      .prepare('SELECT date,name,position,company,url FROM candidates_export')
      .all() as any[];
    const seen = new Set<string>();
    for (const r of existing) seen.add(candidateKey(r));

    const insertSql =
      'INSERT INTO candidates_export (date, jd_id, platform, name, position, company, city, experience, degree, salary, score, url, greeted, favorited) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    const stmt = db.prepare(insertSql);

    let imported = 0;
    let skipped = 0;
    let invalid = 0;
    for (const c of candidates) {
      // 基本校验：至少要有姓名或 url，否则视为无效记录
      const hasName = !!(c.name && String(c.name).trim());
      const hasUrl = !!(c.url && String(c.url).trim());
      if (!hasName && !hasUrl) {
        invalid++;
        continue;
      }
      const key = candidateKey(c);
      if (seen.has(key)) {
        skipped++; // upsert 语义：唯一键已存在则跳过（不重复插入）
        continue;
      }
      seen.add(key);
      stmt.run(
        c.date || todayKey(),
        c.jd_id ?? null,
        (c as any).platform || 'boss',
        c.name ?? null,
        c.position ?? null,
        c.company ?? null,
        c.city ?? null,
        c.experience ?? null,
        c.degree ?? null,
        c.salary ?? null,
        typeof c.score === 'number' && !Number.isNaN(c.score) ? c.score : null,
        c.url ?? null,
        c.greeted ? 1 : 0,
        c.favorited ? 1 : 0,
      );
      imported++;
    }

    dialog.showMessageBox(win, {
      type: 'info',
      title: '导入完成',
      message: `共解析 ${candidates.length} 条：新增 ${imported}，已存在跳过 ${skipped}，无效 ${invalid}。`,
    });
    return { ok: true, imported, skipped, invalid, total: candidates.length };
  });
}

// 递归复制目录（兼容旧 Node，fs.cpSync Node 16.7+ 可用，但做个兜底）
function copyDirRecursive(src: string, dest: string) {
  copyDirRecursiveExcept(src, dest, () => false);
}
// E5(2026-08-05)：带排除过滤器的递归拷贝，用于先复制非 db 文件、再用 backup() 写主库
function copyDirRecursiveExcept(src: string, dest: string, exclude: (name: string) => boolean) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    // 跳过 lock 文件和日志
    if (entry.name === 'SingletonLock' || entry.name.endsWith('.log')) continue;
    // 排除调用方指定的文件（如主 db 文件，交给 better-sqlite3 backup 处理）
    if (!entry.isDirectory() && exclude(entry.name)) continue;
    if (entry.isDirectory()) {
      copyDirRecursiveExcept(s, d, exclude);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ============ Low: 导入解析与去重辅助 ============

// 候选人去重唯一键：优先 url，否则 date|name|company|position（均小写去空白）
function candidateKey(c: { url?: any; date?: any; name?: any; company?: any; position?: any }): string {
  const url = c.url == null ? '' : String(c.url).trim();
  if (url) return 'u:' + url.toLowerCase();
  const norm = (v: any) => (v == null ? '' : String(v).trim().toLowerCase());
  return ['k', norm(c.date), norm(c.name), norm(c.company), norm(c.position)].join('|');
}

// 中文/英文表头 → 内部字段名映射（兼容本平台导出的 CSV 表头）
const HEADER_MAP: Record<string, keyof ImportCandidate> = {
  日期: 'date',
  date: 'date',
  姓名: 'name',
  name: 'name',
  岗位: 'position',
  position: 'position',
  公司: 'company',
  company: 'company',
  城市: 'city',
  city: 'city',
  经验: 'experience',
  experience: 'experience',
  学历: 'degree',
  degree: 'degree',
  薪资: 'salary',
  salary: 'salary',
  匹配分: 'score',
  score: 'score',
  已招呼: 'greeted',
  greeted: 'greeted',
  已收藏: 'favorited',
  favorited: 'favorited',
  链接: 'url',
  url: 'url',
};

function truthyFlag(v: any): number {
  if (v == null) return 0;
  const s = String(v).trim().toLowerCase();
  return s === '是' || s === '1' || s === 'true' || s === 'yes' || s === 'y' ? 1 : 0;
}

// 从任意对象（JSON 记录或 CSV 行）规范化为 ImportCandidate
function normalizeCandidate(raw: Record<string, any>): ImportCandidate {
  const out: ImportCandidate = {};
  for (const [k, v] of Object.entries(raw)) {
    const field = HEADER_MAP[k] || HEADER_MAP[k.trim()];
    if (!field) continue;
    if (field === 'score') {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
      out.score = Number.isNaN(n) ? null : n;
    } else if (field === 'greeted' || field === 'favorited') {
      out[field] = truthyFlag(v);
    } else {
      (out as any)[field] = v == null ? null : String(v);
    }
  }
  return out;
}

// 解析 JSON：支持顶层数组，或 { candidates: [...] }
function parseJsonCandidates(text: string): ImportCandidate[] {
  const data = JSON.parse(text);
  let arr: any[];
  if (Array.isArray(data)) arr = data;
  else if (data && Array.isArray(data.candidates)) arr = data.candidates;
  else throw new Error('JSON 需为候选人数组，或形如 { "candidates": [...] } 的对象');
  return arr.filter((x) => x && typeof x === 'object').map((x) => normalizeCandidate(x));
}

// 解析 CSV：支持带引号字段（含转义 "" 与字段内换行/逗号），首行为表头
function parseCsvCandidates(text: string): ImportCandidate[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: ImportCandidate[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    // 跳过完全空行
    if (cells.length === 0 || cells.every((c) => c.trim() === '')) continue;
    const rec: Record<string, any> = {};
    for (let j = 0; j < header.length; j++) {
      rec[header[j]] = cells[j] !== undefined ? cells[j] : '';
    }
    out.push(normalizeCandidate(rec));
  }
  return out;
}

// 极简但正确的 CSV 分词器：处理引号、"" 转义、字段内换行、\r\n
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\r') {
        // 忽略，交由 \n 处理；若是孤立 \r 也当作换行
        if (text[i + 1] !== '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        }
      } else {
        field += ch;
      }
    }
  }
  // 收尾最后一个字段/行
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
