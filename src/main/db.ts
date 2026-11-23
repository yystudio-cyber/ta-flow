// 本地数据存储 —— 使用 better-sqlite3（生产级：真实关系表 + 事务 + WAL）
// 由早期 JSON 文件存储升级而来；对外导出的函数名/签名保持不变，调用方零改动。
//
// 设计要点：
//  - getDb() 返回真实的 better-sqlite3 Database 实例（其 .prepare 被就地包装以透明处理字段级加密）。
//    调用方仍用 db.prepare(sql).get/all/run 与 db.exec(sql)，SQL 直接在真实表上执行。
//  - H4: 敏感字段（JD data/name、候选人 PII）仍走字段级 AES-256-GCM 加密（encryptField/decryptField 逻辑不变，
//    safeStorage 主密钥不变）。加密在 INSERT 时对参数加密、SELECT 时对结果解密，落盘即密文。
//    解密失败（GCM 认证失败＝被篡改/换机）仍告警 + 字段置空。
//  - H6: 原子写由 sqlite 事务/WAL 承担；writeAtomic/persist 语义降级为 checkpoint/no-op，
//    但 persistImmediate/flushDb 导出仍在（调用方仍在调）。
//  - Medium: logs/candidates/riskHistory/dailyStats 均有硬上限，applyRetention 用 SQL 裁剪，防止长期膨胀。
//  - 一次性迁移：init 时若检测到旧 JSON store 且 sqlite 为空，则把旧数据导入 sqlite（旧文件保留做备份，不删）。
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { oplog } from './services/oplog';

type SqliteDb = Database.Database;
type SqliteStmt = Database.Statement<any[], any>;

// ============ 加密（H4） ============
// 字段级加密：使用 electron safeStorage 保护密钥，密钥派生后用 AES-256-GCM 加密敏感字段
// 只加密 PII 和核心画像，不加密 id/date/score 等非敏感字段（保留查询能力）

let encryptionEnabled = false;
let encryptionKey: Buffer | null = null;

// candidates 表中需要加密的敏感字段
const CANDIDATE_ENCRYPT_FIELDS: (keyof CandidateRow)[] = [
  'name', 'position', 'company', 'city', 'experience', 'degree', 'salary', 'url', 'note',
];
// jds 表中需要加密的字段（JD 含人才画像、薪资预算等）
const JD_ENCRYPT_FIELDS: (keyof JdRow)[] = ['name', 'data'];

// 各加密表的敏感列（供 prepare 包装层做 INSERT 参数加密 / SELECT 结果解密）
// 猎聘人才池的敏感列。res_id 刻意【不加密】：它是唯一索引与外键，
// 且本身只是平台的一个不透明 ID，不含任何个人信息。
const LIEPIN_TALENT_ENCRYPT_FIELDS = ['name', 'position', 'company', 'city',
  'experience', 'degree', 'salary', 'note'];

const ENCRYPTED_TABLE_FIELDS: Record<string, string[]> = {
  jds: JD_ENCRYPT_FIELDS as string[],
  candidates_export: CANDIDATE_ENCRYPT_FIELDS as string[],
  liepin_talents: LIEPIN_TALENT_ENCRYPT_FIELDS,
};

const ENC_PREFIX = 'ENC:';

export function isEncryptionAvailable(): boolean {
  try {
    // 动态 import safeStorage，开发期可能主进程未就绪
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeStorage } = require('electron');
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function getSafeStorage(): typeof import('electron').safeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron').safeStorage;
  } catch {
    return null;
  }
}

/** 从 safeStorage 获取/派生加密密钥（与机器绑定，换机不可解密） */
function loadOrCreateKey(): Buffer | null {
  const ss = getSafeStorage();
  if (!ss || !ss.isEncryptionAvailable()) return null;

  const STORED_KEY = 'encryption.masterKey';
  const existing = rawSettingGet(STORED_KEY);
  if (existing && typeof existing === 'string' && existing.startsWith(ENC_PREFIX)) {
    try {
      const encrypted = Buffer.from(existing.slice(ENC_PREFIX.length), 'base64');
      // Low: decryptString 返回的是 base64 明文口令（JS string 不可变、无法清零，只能尽快转 Buffer 并丢弃引用）
      const key = ss.decryptString(encrypted);
      const buf = Buffer.from(key, 'base64');
      encStatus = { mode: 'on', reason: '' };
      return buf;
    } catch (e) {
      // ── 密钥解不开时的自愈 ──────────────────────────────────────────────
      // 成因：这条密文是用【另一台机器/另一个 Windows 账户】的 DPAPI 加出来的（拷贝数据目录、
      // 账户凭据重置等），当前账户解不开。旧实现直接 return null → 整库静默降级为明文，
      // 而设置里加密还显示"开着"，形成"以为加密了其实没有"的合规假象。
      //
      // 自愈条件很关键：只有在【库里确实没有任何用这把旧密钥加密过的数据】时才允许换新钥，
      // 否则换钥会让那些密文永久无法解读（等于丢数据）。有密文就宁可继续降级并如实告警。
      const orphan = hasEncryptedPayload();
      if (orphan) {
        encStatus = {
          mode: 'degraded',
          reason: '主密钥无法解密（可能来自另一台机器或另一个 Windows 账户），且库中存在用旧密钥加密的数据，'
            + '为避免这些数据永久不可读，未自动更换密钥。请导出需要的数据后在设置中重置加密。',
        };
        console.error('[db] 解密主密钥失败，且检测到旧密文数据，保持明文模式并保留旧密钥:', e);
        return null;
      }
      console.warn('[db] 解密主密钥失败，且库中无任何旧密文数据 → 自动重新生成主密钥（不影响现有明文数据）');
      try { rawSettingSet(STORED_KEY, ''); } catch { /* 清不掉也不影响下面直接覆盖 */ }
      // 落到下面的"首次创建"分支重新生成
    }
  }

  // 首次创建：生成 32 字节随机密钥，用 safeStorage 加密后保存（返回的 Buffer 作为常驻会话密钥，
  // 会在 setEncryptionEnabled(false) 时 .fill(0) 清零）
  const rawKey = crypto.randomBytes(32);
  try {
    // Low: toString('base64') 会产生一份无法清零的临时 string，尽力而为，无法绝对消除
    const enc = ss.encryptString(rawKey.toString('base64'));
    rawSettingSet(STORED_KEY, ENC_PREFIX + Buffer.from(enc).toString('base64'));
    encStatus = { mode: 'on', reason: '' };
    return rawKey;
  } catch (e) {
    encStatus = { mode: 'degraded', reason: '创建加密密钥失败：' + ((e as any)?.message || e) };
    console.error('[db] 创建加密密钥失败:', e);
    return null;
  }
}

// 库里是否存在【用主密钥加密过】的业务数据（ENC: 前缀的字段值）。
// 注意排除 settings 里的主密钥本身——它是被 safeStorage 加密的，不是被主密钥加密的。
function hasEncryptedPayload(): boolean {
  for (const [table, fields] of Object.entries(ENCRYPTED_TABLE_FIELDS)) {
    for (const f of fields) {
      try {
        const row = rawPrepare(
          `SELECT 1 AS x FROM ${table} WHERE ${f} LIKE '${ENC_PREFIX}%' LIMIT 1`,
        ).get() as any;
        if (row) return true;
      } catch { /* 表/列不存在则跳过 */ }
    }
  }
  return false;
}

// ── 加密状态（供设置页如实展示，杜绝"静默降级"）──────────────────────────
// off      = 用户主动关闭
// on       = 已开启且密钥可用，敏感字段真的在加密
// degraded = 设置要求加密，但拿不到密钥 → 实际在写明文（这正是必须让用户看见的状态）
export type EncryptionMode = 'off' | 'on' | 'degraded';
let encStatus: { mode: EncryptionMode; reason: string } = { mode: 'off', reason: '' };

export function getEncryptionStatus(): {
  mode: EncryptionMode;
  reason: string;
  available: boolean;
  encryptedFields: Record<string, string[]>;
} {
  return {
    mode: encStatus.mode,
    reason: encStatus.reason,
    available: isEncryptionAvailable(),
    encryptedFields: ENCRYPTED_TABLE_FIELDS,
  };
}

/** 设置页「重置加密密钥」：删掉解不开的旧密钥，下次初始化会用当前账户重新生成。
 *  只在库中无旧密文数据时允许，避免把已有密文变成永久不可读。 */
export function resetEncryptionKey(): { ok: boolean; reason?: string } {
  if (hasEncryptedPayload()) {
    return { ok: false, reason: '库中存在用旧密钥加密的数据，重置会导致这些数据永久不可读。请先导出数据。' };
  }
  try {
    rawSettingSet('encryption.masterKey', '');
    const key = loadOrCreateKey();
    if (!key) return { ok: false, reason: encStatus.reason || '重新生成密钥失败' };
    encryptionKey = key;
    encryptionEnabled = true;
    encStatus = { mode: 'on', reason: '' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

function encryptField(value: string | null): string | null {
  if (!encryptionEnabled || !encryptionKey || value == null) return value;
  // P2-1：catch 分支不允许静默返回明文。若 cipher 抛异常：
  // (a) 把模块级 encStatus 翻成 'degraded'（让 getEncryptionStatus() 如实报告）；
  // (b) 重新抛出——调用方感知失败并可选择中止写入，而不是"以为加密了其实没有"。
  // 这正是该模块反复强调要杜绝的「声称已加密实为明文」问题。
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return ENC_PREFIX + iv.toString('base64') + '.' + enc.toString('base64');
  } catch (e: any) {
    encStatus = { mode: 'degraded', reason: `加密异常：${e?.message || String(e)}` };
    throw e;
  }
}

// H6-2: 解密失败（GCM 认证失败＝数据被篡改/损坏）不再静默返回密文。
// 返回 null（可识别的“损坏/置空”标记），并 console.error 告警字段与记录标识；
// 上层读取（prepare 包装层的解密）会把该字段落为 null，既不会把损坏值当明文用，
// 也不会因见到 ENC: 前缀而在写回时二次“保留”篡改数据。
function decryptField(value: string | null, ctx?: string): string | null {
  if (!encryptionEnabled || !encryptionKey || value == null) return value;
  // 非密文（无前缀）：直接原样返回，视为明文
  if (!value.startsWith(ENC_PREFIX)) return value;
  const inner = value.slice(ENC_PREFIX.length);
  const dot = inner.indexOf('.');
  if (dot < 0) {
    // 格式非法：不是合法密文结构，按损坏处理
    console.error(`[db] decryptField 密文格式非法，字段置空 (${ctx || 'unknown'})`);
    return null;
  }
  try {
    const iv = Buffer.from(inner.slice(0, dot), 'base64');
    const enc = Buffer.from(inner.slice(dot + 1), 'base64');
    const tagLen = 16;
    const tag = enc.slice(enc.length - tagLen);
    const ct = enc.slice(0, enc.length - tagLen);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    // GCM 认证失败：数据被篡改或密钥不匹配。明确告警并返回 null（安全默认：该字段置空）
    console.error(
      `[db] decryptField 解密/认证失败，疑似数据被篡改或密钥不匹配，字段置空 (${ctx || 'unknown'}):`,
      (e as Error)?.message || e,
    );
    return null;
  }
}

/**
 * 开启/关闭加密。
 *  - 开启：对表中现有明文敏感字段就地加密（reencryptStored(true)），此后写入自动加密。
 *  - 关闭：先把现有密文解密回明文（reencryptStored(false)，此时密钥仍在），再清空密钥与开关。
 * 操作成功返回 true，不可用时返回 false。
 */
export function setEncryptionEnabled(enabled: boolean): boolean {
  if (enabled) {
    if (encryptionEnabled) return true;
    const key = loadOrCreateKey();
    if (!key) return false;
    encryptionKey = key;
    encryptionEnabled = true;
    // 把现有明文行加密落盘
    reencryptStored(true);
    checkpoint();
    return true;
  } else {
    if (!encryptionEnabled) return true;
    // 关闭前必须先用现有密钥把密文解密回明文（此时 encryptionEnabled 仍为 true）
    // ⚠️ 解密回写【失败就必须中止】，绝不能继续往下删主密钥（审查 2026-07-29）。
    // 原实现吞掉事务异常照删不误，后果是本项目唯一不可逆且用户零感知的破坏：
    // 岗位薪资预算与候选人 PII 永久不可读，而界面还显示"已关闭加密"；
    // 下次启动因为没有密钥会铸一把新钥，旧密文解成 null 显示为空值 ——
    // 比看到 "ENC:" 前缀更隐蔽，用户根本不会意识到数据已经没了。
    if (!reencryptStored(false)) {
      console.error('[db] 解密回写失败，已中止关闭加密：主密钥保留，加密保持开启');
      encStatus = {
        mode: 'degraded',
        reason: '关闭加密时解密回写失败，为避免数据永久不可读，已中止关闭并保留主密钥。'
          + '请先导出需要的数据，再排查数据库是否被占用或损坏。',
      };
      return false;
    }
    encryptionEnabled = false;
    // Low: 主密钥用完清零，降低内存 dump 泄露风险（Buffer 可原地清零）
    if (encryptionKey) encryptionKey.fill(0);
    encryptionKey = null;
    rawSettingDelete('encryption.masterKey');
    checkpoint();
    return true;
  }
}

export function getEncryptionEnabled(): boolean {
  return encryptionEnabled;
}

/** 加密开关切换时，对现有行的敏感字段整体加密/解密（走 rawPrepare，绕过包装层，避免二次转换）。 */
function transformField(v: any, enable: boolean, ctx: string): any {
  if (v == null || typeof v !== 'string' || v === '') return v;
  if (enable) {
    if (v.startsWith(ENC_PREFIX)) return v; // 已是密文，跳过
    return encryptField(v);
  }
  if (!v.startsWith(ENC_PREFIX)) return v; // 已是明文，跳过
  return decryptField(v, ctx);
}

function reencryptStored(enable: boolean) {
  if (!rawDb) return;
  const tx = rawDb.transaction(() => {
    // jds
    const jRows = rawPrepare('SELECT id, name, data FROM jds').all() as JdRow[];
    const upJ = rawPrepare('UPDATE jds SET name = ?, data = ? WHERE id = ?');
    for (const r of jRows) {
      upJ.run(
        transformField(r.name, enable, `jds#${r.id}.name`),
        transformField(r.data, enable, `jds#${r.id}.data`),
        r.id,
      );
    }
    // candidates_export
    const cRows = rawPrepare(
      'SELECT id, name, position, company, city, experience, degree, salary, url, note FROM candidates_export',
    ).all() as any[];
    const upC = rawPrepare(
      'UPDATE candidates_export SET name=?, position=?, company=?, city=?, experience=?, degree=?, salary=?, url=?, note=? WHERE id=?',
    );
    for (const r of cRows) {
      upC.run(
        ...CANDIDATE_ENCRYPT_FIELDS.map((f) => transformField(r[f], enable, `candidates#${r.id}.${String(f)}`)),
        r.id,
      );
    }
    // ★ liepin_talents —— 此前漏在这里，后果是本应用唯一不可逆的数据破坏：
    //   关闭加密时它的密文不会被解回明文，而流程随后就销毁主密钥，
    //   猎聘人才池（设计上"长久保存"的资产）整批变成永远读不出来的 ENC: 串。
    //   ENCRYPTED_TABLE_FIELDS 里已经登记了这张表，唯独重加密这条路径漏了。
    const lRows = rawPrepare(
      `SELECT res_id, ${LIEPIN_TALENT_ENCRYPT_FIELDS.join(', ')} FROM liepin_talents`,
    ).all() as any[];
    const upL = rawPrepare(
      `UPDATE liepin_talents SET ${LIEPIN_TALENT_ENCRYPT_FIELDS.map((f) => `${f}=?`).join(', ')} WHERE res_id=?`,
    );
    for (const r of lRows) {
      upL.run(
        ...LIEPIN_TALENT_ENCRYPT_FIELDS.map((f) => transformField(r[f], enable, `liepin#${r.res_id}.${f}`)),
        r.res_id,
      );
    }
  });
  try {
    tx();
    return true;
  } catch (e) {
    console.error('[db] reencryptStored 失败:', e);
    return false;
  }
}

// ============ 数据模型 ============
export interface DailyRow {
  date: string;
  platform: string;
  viewed: number;
  greeted: number;
  favorited: number;
  high_match: number;
  mid_match: number;
  low_match: number;
  risk_events: number;
  // 猎聘三重配额（翻页/搜索/详情），BOSS 侧恒为 0 表示不门控
  pages: number;
  searches: number;
  details: number;
}

interface SettingsMap {
  [key: string]: any;
}

interface ToolRow {
  id: string;
  enabled: number;
  config: string;
}

interface JdRow {
  id: string;
  name: string;
  data: string;
  active: number;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  name: string;
  platform: string;
  data: string;
  created_at: number;
  updated_at: number;
  last_run_at?: number;
}

interface LogRow {
  id: number;
  date: string;
  time: number;
  level: string;
  task_id: string | null;
  platform?: string;
  message: string;
}

interface CandidateRow {
  id: number;
  date: string;
  jd_id: string | null;
  platform?: string;
  name: string | null;
  position: string | null;
  company: string | null;
  city: string | null;
  experience: string | null;
  degree: string | null;
  salary: string | null;
  score: number | null;
  url: string | null;
  greeted: number;
  favorited: number;
  note: string | null;
}

interface RiskEventRow {
  id: number;
  time: number;
  date: string;
  level: string;
  reason: string | null;
}

// 旧 JSON store 形状（仅一次性迁移时使用）
interface StoreShape {
  schemaVersion: number;
  settings: SettingsMap;
  tools: ToolRow[];
  jds: JdRow[];
  tasks: TaskRow[];
  logs: LogRow[];
  dailyStats: Record<string, DailyRow>;
  candidates: CandidateRow[];
  riskHistory: RiskEventRow[];
  _seq: {
    log: number;
    candidate: number;
    risk: number;
  };
}

// H-DB1: 当前数据结构版本。每次结构变更时 +1，并在 migrateStep/sqliteSchemaMigrate 里补对应升级步骤
// v2（G2/G3）：candidates_export.viewed 列 + jr_inbox 表
// v3（多平台隔离 / 猎聘接入）：
//   - daily_stats 主键改为 (date, platform) 复合主键，新增 pages/searches/details 三列
//   - risk_history / rpa_logs / candidates_export 三表新增 platform 列（默认 'boss'）
//   - candidates_export 新增 source_id / depth / detail_at 列，(platform, source_id) 部分唯一索引用于跨运行去重
//   - rpa_tasks.platform 回填 NULL/'' → 'boss'（新表 DDL 带 NOT NULL DEFAULT 'boss'）
//   - 相关 platform 索引：idx_logs_plat_time / idx_risk_plat_date / idx_candidates_plat_source(_uniq)
// v6（阶段5②）：猎聘人才库 FTS5 影子表 liepin_talents_fts（trigram）。新库由 createSchema 直接建；
//   老库在此补建并回填：遍历 liepin_talents 解密明文后灌入影子表。纯新增、不动任何既有数据。
const SCHEMA_VERSION = 6;

// ============ 容量上限（防止长期运行内存/磁盘膨胀） ============
const LIMITS = {
  logs: 5000,
  candidates: 20000,
  riskHistory: 2000,
  dailyStatsDays: 365, // 只保留最近一年
};

const DAILY_FIELDS: (keyof DailyRow)[] = [
  'viewed', 'greeted', 'favorited', 'high_match', 'mid_match', 'low_match', 'risk_events',
  'pages', 'searches', 'details',
];

// ============ 单例 ============
let rawDb: SqliteDb; // 真实 better-sqlite3 实例
let rawPrepare: (sql: string) => SqliteStmt; // 未被包装的原始 prepare（内部使用，绕过字段加密）
let dbPath = '';
let jsonBackupPath = ''; // 旧 JSON store 路径（迁移来源 + 备份）
let logDir = ''; // Low(独立日志文件): RPA 日志落盘目录 userData/logs/

// prepare 包装缓存：同一 SQL 复用同一个 CryptoStatement（底层 sqlite 语句 better-sqlite3 自身也会缓存）
const stmtCache = new Map<string, CryptoStatement>();

// ============ H-DB1: JSON→sqlite 迁移用的字段级默认值补全 ============
function defaultCandidateRow(): CandidateRow {
  return {
    id: 0, date: '', jd_id: null, name: null, position: null, company: null,
    city: null, experience: null, degree: null, salary: null, score: null,
    url: null, greeted: 0, favorited: 0, note: null,
  };
}
function defaultJdRow(): JdRow {
  return { id: '', name: '', data: '', active: 0, created_at: 0, updated_at: 0 };
}
function defaultTaskRow(): TaskRow {
  return { id: '', name: '', platform: '', data: '', created_at: 0, updated_at: 0 };
}
function defaultLogRow(): LogRow {
  return { id: 0, date: '', time: 0, level: 'info', task_id: null, message: '' };
}
function defaultRiskRow(): RiskEventRow {
  return { id: 0, time: 0, date: '', level: 'info', reason: null };
}
function defaultToolRow(): ToolRow {
  return { id: '', enabled: 0, config: '{}' };
}

function numOr(v: any, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}
function maxId<T extends { id?: any }>(rows: T[]): number {
  let m = 0;
  for (const r of rows) {
    const n = Number((r as any).id);
    if (isFinite(n) && n > m) m = n;
  }
  return m;
}

// 逐版本迁移步骤（作用于旧 JSON 形状）：从 fromVer 升到 fromVer+1，返回新版本号。
function migrateStep(_s: StoreShape, fromVer: number): number {
  switch (fromVer) {
    case 0:
      return 1;
    default:
      return SCHEMA_VERSION;
  }
}

// 把磁盘旧 JSON 原始对象规整为完整 StoreShape（逐行字段级补全），供一次性迁移导入 sqlite。
function loadAndMigrate(raw: any): StoreShape {
  if (!raw || typeof raw !== 'object') return emptyStore();
  const base = emptyStore();
  const s: StoreShape = { ...base };

  s.settings = { ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) };

  s.tools = Array.isArray(raw.tools) ? raw.tools.map((r: any) => ({ ...defaultToolRow(), ...r })) : [];
  s.jds = Array.isArray(raw.jds) ? raw.jds.map((r: any) => ({ ...defaultJdRow(), ...r })) : [];
  s.tasks = Array.isArray(raw.tasks) ? raw.tasks.map((r: any) => ({ ...defaultTaskRow(), ...r })) : [];
  s.logs = Array.isArray(raw.logs) ? raw.logs.map((r: any) => ({ ...defaultLogRow(), ...r })) : [];
  s.candidates = Array.isArray(raw.candidates)
    ? raw.candidates.map((r: any) => ({ ...defaultCandidateRow(), ...r }))
    : [];
  s.riskHistory = Array.isArray(raw.riskHistory)
    ? raw.riskHistory.map((r: any) => ({ ...defaultRiskRow(), ...r }))
    : [];

  s.dailyStats = {};
  if (raw.dailyStats && typeof raw.dailyStats === 'object') {
    for (const [k, v] of Object.entries(raw.dailyStats)) {
      // 旧 JSON store 迁移：全部归到 boss 平台（历史数据就是 boss）
      s.dailyStats[k] = { ...defaultDaily(k, 'boss'), ...(v as any), platform: 'boss' };
    }
  }

  s._seq = {
    log: numOr(raw._seq?.log, maxId(s.logs)),
    candidate: numOr(raw._seq?.candidate, maxId(s.candidates)),
    risk: numOr(raw._seq?.risk, maxId(s.riskHistory)),
  };

  let ver = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  let guard = 0;
  while (ver < SCHEMA_VERSION && guard++ < 100) {
    ver = migrateStep(s, ver);
  }
  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

function emptyStore(): StoreShape {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {},
    tools: [],
    jds: [],
    tasks: [],
    logs: [],
    dailyStats: {},
    candidates: [],
    riskHistory: [],
    _seq: { log: 0, candidate: 0, risk: 0 },
  };
}

// ============ 建表 + schema 迁移框架 ============
function createSchema() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS jds (
      id TEXT PRIMARY KEY,
      name TEXT,
      data TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS rpa_tasks (
      id TEXT PRIMARY KEY,
      name TEXT,
      platform TEXT NOT NULL DEFAULT 'boss',
      data TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      last_run_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS rpa_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      time INTEGER,
      level TEXT,
      task_id TEXT,
      platform TEXT NOT NULL DEFAULT 'boss',
      message TEXT
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'boss',
      viewed INTEGER NOT NULL DEFAULT 0,
      greeted INTEGER NOT NULL DEFAULT 0,
      favorited INTEGER NOT NULL DEFAULT 0,
      high_match INTEGER NOT NULL DEFAULT 0,
      mid_match INTEGER NOT NULL DEFAULT 0,
      low_match INTEGER NOT NULL DEFAULT 0,
      risk_events INTEGER NOT NULL DEFAULT 0,
      /* 猎聘三重配额：翻页/搜索/详情（BOSS 固定 0 表示不门控） */
      pages INTEGER NOT NULL DEFAULT 0,
      searches INTEGER NOT NULL DEFAULT 0,
      details INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, platform)
    );
    CREATE TABLE IF NOT EXISTS candidates_export (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      platform TEXT NOT NULL DEFAULT 'boss',
      jd_id TEXT,
      source_id TEXT,            /* 平台侧稳定唯一ID（boss=encryptGeekId, liepin=resIdEncode） */
      name TEXT,
      position TEXT,
      company TEXT,
      city TEXT,
      experience TEXT,
      degree TEXT,
      salary TEXT,
      score REAL,
      url TEXT,
      greeted INTEGER NOT NULL DEFAULT 0,
      favorited INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      viewed INTEGER NOT NULL DEFAULT 0,
      depth TEXT,                /* 'A'=列表级零额度 / 'B'=详情级已扣额度 */
      detail_at INTEGER          /* 猎聘阶段B：详情打开时间戳（跨运行去重） */
    );
    /* ─────────────────────────────────────────────────────────────
     * 猎聘人才池（与 BOSS 的 candidates_export 完全分开的一套）
     *
     * 为什么不复用 candidates_export：
     *   ① 保存期口径相反 —— BOSS 那张表是"本轮结果"，有 90 天保留期 + 20000 行滚删；
     *      猎聘要的是【长久保存、随时可打开】，滚在一起 17 天就开始把 BOSS 的人删掉。
     *   ② 猎聘一个人对应【多个岗位、多份评分】，一行一分的结构装不下。
     *
     * 存什么、不存什么（合规边界，别越）：
     *   存：resIdEncode 稳定锚 + 列表级公开摘要（姓名/公司/职位/年限/学历/城市/活跃度）。
     *   不存：简历全文、手机、邮箱、身份证。详情全文只在内存里参与评分，绝不落库。
     *   → 长久保存的是"一个 ID + 一张名片"，不是简历数据，刑事射程小得多。
     *
     * 链接不硬存：用 res_id 实时拼 detailUrl。链接格式变了不用迁数据。
     * ★ 但打开链接会消耗一份套餐额度，UI 必须明示（见人才库子页）。
     * ───────────────────────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS liepin_talents (
      res_id TEXT PRIMARY KEY,      /* resIdEncode：稳定锚，也是链接的唯一原料 */
      name TEXT,
      position TEXT,
      company TEXT,
      city TEXT,
      experience TEXT,
      degree TEXT,
      salary TEXT,
      active_status TEXT,           /* 活跃度：在线/今天活跃/3天内活跃…（排序的重要信号） */
      source_keyword TEXT,          /* 首次由哪个搜索组合命中（关键词效果复盘） */
      first_seen TEXT NOT NULL,     /* 首次入库日期 YYYY-MM-DD */
      last_seen TEXT NOT NULL,      /* 最近一次被搜到 —— 链接失效风险的代理指标 */
      detail_at INTEGER,            /* 最近一次开详情的时间戳：跨运行防重复扣费 */
      archived INTEGER NOT NULL DEFAULT 0,  /* 归档≠删除：收起不占视线，数据还在 */
      note TEXT,
      keep_until TEXT               /* 安全保存期到期日；到期进"待清理"待确认，绝不静默删 */
    );
    /* 候选人 × 岗位 的多份评分。同一个人对不同岗位分数不同，这是猎聘子页排序的依据 */
    CREATE TABLE IF NOT EXISTS liepin_talent_scores (
      res_id TEXT NOT NULL,
      jd_id TEXT NOT NULL,
      score REAL NOT NULL,
      level TEXT,                   /* high / medium / low */
      reasons TEXT,                 /* JSON：评分理由，供 TA 判断为什么是这个分 */
      depth TEXT,                   /* 'A'=列表级零额度评的 / 'B'=开过详情后重评的 */
      scored_at INTEGER NOT NULL,
      insufficient_evidence INTEGER NOT NULL DEFAULT 0, /* P1-19：证据不足被托底 */
      PRIMARY KEY (res_id, jd_id)
    );
    /* 标签：auto-jd = 按岗位库自动打（命中哪个岗位就带哪个岗位标）；manual = TA 自己打 */
    CREATE TABLE IF NOT EXISTS liepin_talent_tags (
      res_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (res_id, tag)
    );
    /*
     * 猎聘人才库全文检索 · FTS5 影子表（阶段5②）。
     * 为什么需要影子表：liepin_talents 的 name/position/company/city/experience/degree 是
     *   AES-256-GCM 密文存储（见 LIEPIN_TALENT_ENCRYPT_FIELDS），SQL 的 LIKE / FTS 都索引不到密文。
     *   旧做法是「取全表解密后内存 filter」，半永久累积 6000+/周、几月十万条时会卡。
     * 影子表存【明文】，在 upsertLiepinTalent 写入时同步喂入（此时明文尚在内存）。
     * tokenizer 用 trigram：英文与 ≥3 字符的中文串走索引加速；中文两字词（姓名「张三」、职位「前端」）
     *   trigram 生成不出 3-gram token 会匹配不到，由 listLiepinTalents 查询层对短词/无命中降级到
     *   「解密后内存 LIKE」（即原逻辑），正确性零损失。bigram tokenizer 在本 SQLite 构建里不可用。
     * ★ 影子表只存检索列 + res_id 外键，不存 note/salary 之外更敏感内容；写读一律走 rawPrepare
     *   （不能走加密包装层——影子表存的就是明文，再加密就索不到原文了）。
     */
    CREATE VIRTUAL TABLE IF NOT EXISTS liepin_talents_fts USING fts5(
      res_id UNINDEXED,
      name, position, company, city, experience, degree
    );
    CREATE TABLE IF NOT EXISTS jr_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      uniq_key TEXT NOT NULL UNIQUE,
      title TEXT,
      dept TEXT,
      city TEXT,
      status TEXT,
      raw TEXT,
      state TEXT NOT NULL DEFAULT 'new'
    );
    CREATE TABLE IF NOT EXISTS risk_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time INTEGER,
      date TEXT,
      platform TEXT NOT NULL DEFAULT 'boss',
      level TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jds_active ON jds(active);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated ON rpa_tasks(updated_at);
    CREATE INDEX IF NOT EXISTS idx_logs_time ON rpa_logs(time);
    CREATE INDEX IF NOT EXISTS idx_logs_date ON rpa_logs(date);
    CREATE INDEX IF NOT EXISTS idx_candidates_date ON candidates_export(date);
    CREATE INDEX IF NOT EXISTS idx_candidates_score ON candidates_export(score);
    CREATE INDEX IF NOT EXISTS idx_candidates_jd ON candidates_export(jd_id);
    CREATE INDEX IF NOT EXISTS idx_risk_date ON risk_history(date);
    CREATE INDEX IF NOT EXISTS idx_jr_inbox_state ON jr_inbox(state);
  `);
  // ⚠️ platform 相关索引【不能】放在上面这块 exec 里：createSchema 在 sqliteSchemaMigrate 之前执行，
  //    老 v2 库此刻还没有 platform/source_id 列，CREATE INDEX 引用这些列会直接抛 "no such column"，
  //    exec 中断后续语句也不执行 → createSchema 抛错到底层导致老用户启动崩溃。
  //    统一放到迁移完成后由 ensurePlatformIndexes() 建（对新库/老库都幂等，建失败只告警不阻断）。
}

function metaGet(key: string): string | undefined {
  const row = rawPrepare('SELECT value FROM _meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
function metaSet(key: string, value: string) {
  rawPrepare(
    'INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// 判断表是否已有某列（迁移幂等性判据，比 try/catch ALTER 更可靠）
function hasColumn(table: string, column: string): boolean {
  try {
    const cols = rawPrepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}

/**
 * v2 → v3：多平台隔离迁移。
 *  ① risk_history / rpa_logs / candidates_export 补 platform 列（默认 'boss'）；
 *  ② candidates_export 补 source_id / depth / detail_at 列；
 *     历史 BOSS 行的 url 若形如 'boss:geek:<encryptGeekId>'，反解填 source_id 让老数据也能跨运行去重；
 *  ③ rpa_tasks.platform 已有列，回填 NULL/'' → 'boss'（避免 UI 按平台筛时旧任务"消失"）；
 *  ④ daily_stats 主键 date → (date, platform)（sqlite 不支持改主键，重建表 + 搬数据），
 *     同时补 pages/searches/details 三列（猎聘三重配额，BOSS 历史行默认 0）。
 * 整体包在一个事务里：中途失败完全回滚，不留半迁移状态；不破坏任何现有 BOSS 数据。
 */
function migrateV2ToV3() {
  const tx = rawDb.transaction(() => {
    // ① 三表补 platform 列
    for (const t of ['risk_history', 'rpa_logs', 'candidates_export'] as const) {
      if (!hasColumn(t, 'platform')) {
        rawDb.exec(`ALTER TABLE ${t} ADD COLUMN platform TEXT NOT NULL DEFAULT 'boss'`);
      }
    }
    // ② candidates_export 补 source_id / depth / detail_at
    if (!hasColumn('candidates_export', 'source_id')) {
      rawDb.exec('ALTER TABLE candidates_export ADD COLUMN source_id TEXT');
      // 历史 BOSS 行：url 可能是明文 'boss:geek:<id>'（未加密时）或密文 'ENC:...'（已加密时）。
      // 只对明文形态反解；密文行 source_id 留 NULL（不影响正确性，只是不参与旧数据去重）。
      try {
        rawDb.exec(
          "UPDATE candidates_export SET source_id = substr(url, 11) "
          + "WHERE source_id IS NULL AND url LIKE 'boss:geek:%'",
        );
      } catch { /* 反解失败不阻断迁移 */ }
    }
    if (!hasColumn('candidates_export', 'depth')) {
      rawDb.exec("ALTER TABLE candidates_export ADD COLUMN depth TEXT");
    }
    if (!hasColumn('candidates_export', 'detail_at')) {
      rawDb.exec("ALTER TABLE candidates_export ADD COLUMN detail_at INTEGER");
    }
    // 回填 platform 为 NULL/'' 的历史行
    try {
      rawDb.exec("UPDATE candidates_export SET platform='boss' WHERE platform IS NULL OR platform=''");
    } catch { /* ignore */ }

    // ③ rpa_tasks.platform 回填 NULL/'' → 'boss'（DDL 默认值已在 createSchema 里加了 'boss'，
    //    旧库由本次 UPDATE 把历史空值收敛）
    try {
      rawDb.exec("UPDATE rpa_tasks SET platform='boss' WHERE platform IS NULL OR platform=''");
    } catch { /* ignore */ }

    // ④ daily_stats 重建：date 主键 → (date, platform) 复合主键；同时补 pages/searches/details
    try {
      const dsCols = rawPrepare('PRAGMA table_info(daily_stats)').all() as Array<{ name: string; pk: number }>;
      const alreadyPartitioned = dsCols.some((c) => c.name === 'platform' && c.pk > 0);
      if (!alreadyPartitioned) {
        rawDb.exec(`
          CREATE TABLE IF NOT EXISTS _ds_v3 (
            date TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'boss',
            viewed INTEGER NOT NULL DEFAULT 0, greeted INTEGER NOT NULL DEFAULT 0,
            favorited INTEGER NOT NULL DEFAULT 0, high_match INTEGER NOT NULL DEFAULT 0,
            mid_match INTEGER NOT NULL DEFAULT 0, low_match INTEGER NOT NULL DEFAULT 0,
            risk_events INTEGER NOT NULL DEFAULT 0,
            pages INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0, details INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, platform)
          );
        `);
        // 旧表可能已被更早的失败尝试加过 platform 普通列，优先取它；否则回填 'boss'
        const hasPlatCol = dsCols.some((c) => c.name === 'platform');
        const platExpr = hasPlatCol ? "COALESCE(NULLIF(platform, ''), 'boss')" : "'boss'";
        // pages/searches/details 在旧表里不存在 → 新表 DEFAULT 0 自动生效，不搬
        rawDb.exec(`
          INSERT OR REPLACE INTO _ds_v3
            (date, platform, viewed, greeted, favorited, high_match, mid_match, low_match, risk_events)
          SELECT date, ${platExpr}, viewed, greeted, favorited, high_match, mid_match, low_match, risk_events
          FROM daily_stats;
        `);
        rawDb.exec('DROP TABLE daily_stats');
        rawDb.exec('ALTER TABLE _ds_v3 RENAME TO daily_stats');
      } else {
        // 已复合主键但可能缺 pages/searches/details 列（半迁移遗留），补齐
        for (const col of ['pages', 'searches', 'details'] as const) {
          if (!hasColumn('daily_stats', col)) {
            rawDb.exec(`ALTER TABLE daily_stats ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
          }
        }
      }
    } catch (e) {
      // 重建失败（比如全新库 createSchema 已建好 v3 结构），不阻断；后续 ensurePlatformIndexes 兜底
      console.warn('[db] daily_stats 主键重建跳过（可能已是 v3 结构）:', (e as Error)?.message || e);
    }
  });
  try {
    tx();
    console.log('[db] v2→v3 多平台隔离迁移完成（历史 BOSS 数据保留，新平台独立分区）');
  } catch (e) {
    console.error('[db] v2→v3 迁移失败（已回滚，保持原结构）:', e);
    throw e; // 不静默带着半旧结构跑
  }
}

/**
 * 建立 platform 相关索引。必须在 v3 迁移【之后】调用（那时列才存在）。
 * 对新建库也幂等安全（createSchema 已含全部列）。任一条失败只告警，不阻断启动。
 */
/**
 * v3 → v4：猎聘人才池三张表。
 * 全部是 CREATE IF NOT EXISTS —— 不 ALTER、不 DROP、不动任何既有数据，
 * 迁移失败的最坏情况是"新表没建出来"，绝不会损坏 BOSS 的历史数据。
 */
function migrateV3ToV4() {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS liepin_talents (
      res_id TEXT PRIMARY KEY, name TEXT, position TEXT, company TEXT, city TEXT,
      experience TEXT, degree TEXT, salary TEXT, active_status TEXT, source_keyword TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, detail_at INTEGER,
      archived INTEGER NOT NULL DEFAULT 0, note TEXT, keep_until TEXT
    );
    CREATE TABLE IF NOT EXISTS liepin_talent_scores (
      res_id TEXT NOT NULL, jd_id TEXT NOT NULL, score REAL NOT NULL, level TEXT,
      reasons TEXT, depth TEXT, scored_at INTEGER NOT NULL,
      insufficient_evidence INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (res_id, jd_id)
    );
    CREATE TABLE IF NOT EXISTS liepin_talent_tags (
      res_id TEXT NOT NULL, tag TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL,
      PRIMARY KEY (res_id, tag)
    );
  `);
}

function ensurePlatformIndexes() {
  const stmts: Array<{ sql: string; name: string }> = [
    { name: 'idx_logs_plat_time', sql: 'CREATE INDEX IF NOT EXISTS idx_logs_plat_time ON rpa_logs(platform, time)' },
    { name: 'idx_risk_plat_date', sql: 'CREATE INDEX IF NOT EXISTS idx_risk_plat_date ON risk_history(platform, date)' },
    { name: 'idx_candidates_plat_source', sql: 'CREATE INDEX IF NOT EXISTS idx_candidates_plat_source ON candidates_export(platform, source_id)' },
    { name: 'idx_candidates_plat_date', sql: 'CREATE INDEX IF NOT EXISTS idx_candidates_plat_date ON candidates_export(platform, date)' },
    // 猎聘人才池：子页的两条主查询路径 ——「按岗位取分 ≥60 并排序」「按标签筛」
    { name: 'idx_lp_scores_jd', sql: 'CREATE INDEX IF NOT EXISTS idx_lp_scores_jd ON liepin_talent_scores(jd_id, score DESC)' },
    { name: 'idx_lp_tags_tag', sql: 'CREATE INDEX IF NOT EXISTS idx_lp_tags_tag ON liepin_talent_tags(tag)' },
    { name: 'idx_lp_talents_seen', sql: 'CREATE INDEX IF NOT EXISTS idx_lp_talents_seen ON liepin_talents(archived, last_seen DESC)' },
    { name: 'idx_lp_talents_keep', sql: 'CREATE INDEX IF NOT EXISTS idx_lp_talents_keep ON liepin_talents(keep_until)' },
  ];
  for (const { name, sql } of stmts) {
    try { rawDb.exec(sql); } catch (e) {
      console.warn(`[db] 建索引 ${name} 失败（不阻断）:`, (e as Error)?.message || e);
    }
  }
  // (platform, source_id) 唯一索引：若历史数据存在重复 (platform, source_id) 行会建失败 → 降级为普通索引
  try {
    rawDb.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_plat_source_uniq '
      + 'ON candidates_export(platform, source_id) WHERE source_id IS NOT NULL AND source_id != \'\'',
    );
  } catch (e) {
    console.warn('[db] (platform, source_id) 唯一索引建失败（疑有历史重复行），降级为普通索引:', (e as Error)?.message || e);
    try {
      rawDb.exec('CREATE INDEX IF NOT EXISTS idx_candidates_plat_source ON candidates_export(platform, source_id)');
    } catch { /* 仍失败则放弃 */ }
  }
}

// schema 版本迁移框架（DDL 级）。当前仅登记版本；未来结构变更在此按版本补 ALTER。
function sqliteSchemaMigrate() {
  let ver = Number(metaGet('schemaVersion') ?? 0);
  if (!isFinite(ver)) ver = 0;
  // P2-3：ver > SCHEMA_VERSION = 用新版本打开过的库被旧 build 打开（降级）。
  // 静默继续会把版本号盖回旧版本，导致之后升回新 build 时已执行过的 ALTER/CREATE
  // 步骤重跑，在含 DROP/ALTER 的迁移里直接损坏数据。
  // 拒绝以降级方式打开，给出清晰提示，不崩溃也不静默继续。
  if (ver > SCHEMA_VERSION) {
    const msg = `[db] 数据库版本(${ver})高于当前 build 支持的版本(${SCHEMA_VERSION})。`
      + `请升级应用（或联系支持）后再打开，不支持降级运行。`;
    console.error(msg);
    // 抛出可捕获的 Error；主进程调用方可选择展示对话框后退出，而不是崩溃
    throw new Error(msg);
  }
  const startVer = ver;
  let guard = 0;
  while (ver < SCHEMA_VERSION && guard++ < 100) {
    switch (ver) {
      case 0:
        // 0 -> 1：初始 schema（createSchema 已建全表），无额外 DDL
        ver = 1;
        break;
      case 1:
        // 1 -> 2（G2/G3）：candidates_export 加 viewed 列；jr_inbox 表由 createSchema 的
        // CREATE IF NOT EXISTS 保证存在。旧库补列，新库 createSchema 已含 → ALTER 会抛错，吞掉即可。
        try {
          rawDb.exec('ALTER TABLE candidates_export ADD COLUMN viewed INTEGER NOT NULL DEFAULT 0');
        } catch {
          /* 列已存在（新建库） */
        }
        ver = 2;
        break;
      case 2:
        // 2 -> 3（多平台隔离/猎聘接入）：三表补 platform、daily_stats 换复合主键、source_id 去重。
        // 具体步骤见 migrateV2ToV3 注释。不破坏任何现有 BOSS 数据。
        migrateV2ToV3();
        ver = 3;
        break;
      case 3:
        // 3 -> 4（猎聘人才池）：三张新表。纯 CREATE IF NOT EXISTS，不动任何既有数据，
        // 新库由 createSchema 直接建好，老库在这里补上。
        migrateV3ToV4();
        ver = 4;
        break;
      case 4:
        // 4 -> 5（P1-19）：liepin_talent_scores 加 insufficient_evidence 列。
        // 证据不足被托底的人不应与真正匹配的人混在一起打标/展示，
        // 需要持久化这个标志，供打标闸门和 UI 区分。
        try {
          rawDb.exec('ALTER TABLE liepin_talent_scores ADD COLUMN insufficient_evidence INTEGER NOT NULL DEFAULT 0');
        } catch {
          /* 新库 createSchema 已建，ALTER 会报"重复列"，忽略即可 */
        }
        ver = 5;
        break;
      case 5:
        // 5 -> 6（阶段5②）：建猎聘人才库 FTS5 影子表 liepin_talents_fts。
        // ⚠️ 只建表，不回填：此刻加密尚未初始化（initEncryptionFromSettings 在本函数之后才跑，
        //    见 index.ts:400→403），liepin_talents 的检索列是密文，无法在此解密灌明文。
        //    存量回填由 reindexLiepinTalentsFts() 在加密就绪后幂等执行（见其注释）。
        //    新库 createSchema 已建本表，CREATE IF NOT EXISTS 幂等跳过。
        try {
          rawDb.exec(
            `CREATE VIRTUAL TABLE IF NOT EXISTS liepin_talents_fts USING fts5(
               res_id UNINDEXED, name, position, company, city, experience, degree
             )`,
          );
        } catch {
          /* createSchema 已建则忽略 */
        }
        ver = 6;
        break;
      default:
        ver = SCHEMA_VERSION;
        break;
    }
  }
  // P2-3：只在 ver 实际推进时才写 schemaVersion，避免降级 build 把版本号盖回去。
  // startVer < SCHEMA_VERSION 意味着确实有迁移步骤跑了（或首次建库）。
  if (startVer < SCHEMA_VERSION) metaSet('schemaVersion', String(SCHEMA_VERSION));
  // 列已就位（新库来自 createSchema，老库来自 migrateV2ToV3）→ 现在安全建 platform 索引
  ensurePlatformIndexes();
}

// ============ 一次性 JSON→sqlite 迁移 ============
function dbHasAnyData(): boolean {
  const tables = ['settings', 'tools', 'jds', 'rpa_tasks', 'rpa_logs', 'daily_stats', 'candidates_export', 'risk_history'];
  for (const t of tables) {
    const row = rawPrepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
    if (row) return true;
  }
  return false;
}

function importStoreToSqlite(s: StoreShape) {
  const tx = rawDb.transaction(() => {
    for (const [k, v] of Object.entries(s.settings)) {
      rawSettingSet(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const insTool = rawPrepare('INSERT OR REPLACE INTO tools (id, enabled, config) VALUES (?, ?, ?)');
    for (const r of s.tools) insTool.run(r.id, r.enabled ? 1 : 0, r.config || '{}');

    // 敏感字段（jds.name/data、candidates.*）按 JSON 里的原样导入（若旧数据已加密则保持密文，
    // 运行期开启加密后读取自动解密；若为明文则保持明文）。走 rawPrepare 绕过包装层，不做二次加密。
    const insJd = rawPrepare(
      'INSERT OR REPLACE INTO jds (id, name, data, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const r of s.jds) insJd.run(r.id, r.name, r.data, r.active ? 1 : 0, r.created_at, r.updated_at);

    const insTask = rawPrepare(
      'INSERT OR REPLACE INTO rpa_tasks (id, name, platform, data, created_at, updated_at, last_run_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of s.tasks) insTask.run(r.id, r.name, r.platform, r.data, r.created_at, r.updated_at, r.last_run_at ?? null);

    const insLog = rawPrepare(
      'INSERT OR REPLACE INTO rpa_logs (id, date, time, level, task_id, platform, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of s.logs) insLog.run(r.id, r.date, r.time, r.level, r.task_id ?? null, r.platform || 'boss', r.message);

    const insDaily = rawPrepare(
      'INSERT OR REPLACE INTO daily_stats (date, platform, viewed, greeted, favorited, high_match, mid_match, low_match, risk_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const d of Object.values(s.dailyStats)) {
      insDaily.run(d.date, d.platform || 'boss', d.viewed, d.greeted, d.favorited, d.high_match, d.mid_match, d.low_match, d.risk_events);
    }

    const insCand = rawPrepare(
      'INSERT OR REPLACE INTO candidates_export (id, date, jd_id, platform, name, position, company, city, experience, degree, salary, score, url, greeted, favorited, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of s.candidates) {
      insCand.run(
        r.id, r.date, r.jd_id, r.platform || 'boss', r.name, r.position, r.company, r.city, r.experience, r.degree,
        r.salary, r.score, r.url, r.greeted ? 1 : 0, r.favorited ? 1 : 0, r.note,
      );
    }

    const insRisk = rawPrepare(
      'INSERT OR REPLACE INTO risk_history (id, time, date, platform, level, reason) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const r of s.riskHistory) insRisk.run(r.id, r.time, r.date, 'boss', r.level, r.reason);
  });
  tx();
}

function maybeMigrateFromJson() {
  // 已迁移过：跳过（清空数据后此标记仍在 _meta 中，避免旧 JSON 死灰复燃）
  if (metaGet('jsonMigrated') === '1') return;
  if (!jsonBackupPath || !fs.existsSync(jsonBackupPath)) {
    metaSet('jsonMigrated', '1');
    return;
  }
  // 若 sqlite 已有数据，说明并非全新库，不覆盖
  if (dbHasAnyData()) {
    metaSet('jsonMigrated', '1');
    return;
  }
  try {
    const raw = fs.readFileSync(jsonBackupPath, 'utf-8');
    const s = loadAndMigrate(JSON.parse(raw));
    importStoreToSqlite(s);
    metaSet('jsonMigrated', '1');
    console.log('[db] 已从旧 JSON store 一次性迁移到 sqlite（旧文件保留做备份，不删除）');
  } catch (e) {
    console.error('[db] JSON→sqlite 迁移失败（保持空库继续）:', e);
  }
}

// ============ 初始化 ============
export function initEncryptionFromSettings() {
  // ⚠️ 这里读的键必须与 SETTINGS_SAVE 写的键一致。2026-08-07 审查抓到：
  // 设置页把整个对象存在 `app-settings` 下（真实路径 app-settings.data.encryptionEnabled），
  // 而这里读的是独立键 `data.encryptionEnabled` —— 全仓只有这一处读、零处写。
  // 后果：用户关掉加密时 setEncryptionEnabled(false) 会把全表解密回明文【并删掉主密钥】，
  // 重启后这里读不到值 → 兜底 want=true → loadOrCreateKey 发现无密钥 → 重新生成一把新的、
  // 加密静默重新打开。开关等于空操作，且合规状态不可信。
  // 兼容读：先读独立键（历史遗留/未来可能的镜像写），没有再读设置对象里的真实路径。
  let raw = rawSettingGet('data.encryptionEnabled');
  if (raw == null) {
    try {
      const app = rawSettingGet('app-settings');
      const obj = typeof app === 'string' ? JSON.parse(app) : app;
      const v = obj?.data?.encryptionEnabled;
      if (v != null) raw = String(v);
    } catch { /* 设置损坏则按缺失处理，走合规默认（开启） */ }
  }
  // 合规默认：设置缺失（全新安装）视为开启；仅显式关闭('false'/'0'/falsy JSON)才走明文。
  // 说明：init 只置开关+密钥、不整体重加密——新装无数据无需迁移；旧装若曾为明文，历史明文行
  // 由解密包装层"无前缀即明文"透传照常可读，新写入自动加密，不产生二次加密/损坏。
  let want = true;
  if (raw != null && typeof raw === 'string') {
    if (raw === 'false' || raw === '0') want = false;
    else if (raw === 'true' || raw === '1') want = true;
    else {
      try { want = !!JSON.parse(raw); } catch { want = true; }
    }
  }
  if (!want) {
    encStatus = { mode: 'off', reason: '用户已在设置中关闭加密' };
  }
  if (want) {
    // loadOrCreateKey 内部会读取 settings 中已存在的密钥
    const key = loadOrCreateKey();
    if (!key) {
      // 只有在 loadOrCreateKey 没写过更具体原因时才用这条兜底文案
      if (encStatus.mode !== 'degraded') {
        encStatus = {
          mode: 'degraded',
          reason: isEncryptionAvailable()
            ? '主密钥不可用，敏感字段正以明文写入'
            : '本机 safeStorage 不可用（系统凭据服务异常），无法加密，敏感字段正以明文写入',
        };
      }
      console.warn('[db] 设置要求加密但本机 safeStorage 不可用或密钥解密失败，以明文模式启动：' + encStatus.reason);
      return;
    }
    encryptionKey = key;
    encryptionEnabled = true;
    // 磁盘上已是密文；读取时由 prepare 包装层透明解密，无需整体解密内存
  }
}

// 判定是否为"数据库损坏"类错误（用于自愈决策）
function isDbCorruptionError(e: any): boolean {
  const m = String(e?.message || e || '').toLowerCase();
  return (
    m.includes('malformed') || m.includes('disk image') || m.includes('not a database') ||
    m.includes('database corrupt') || m.includes('file is not a database') ||
    (!!e?.code && String(e.code).toUpperCase().includes('CORRUPT'))
  );
}

// 备份并移除指定后缀的 db 文件（先备份再删，可逆）
function backupAndRemove(bkDir: string, suffixes: string[]) {
  try { fs.mkdirSync(bkDir, { recursive: true }); } catch { /* 忽略 */ }
  for (const suf of suffixes) {
    const f = dbPath + suf;
    try {
      if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(bkDir, path.basename(f))); fs.rmSync(f, { force: true }); }
    } catch { /* 单个文件失败不阻断 */ }
  }
}

// 打开数据库 + 设 PRAGMA + 建表（可能因文件损坏抛错，交由 initDatabase 自愈）
function bringUpDb() {
  rawDb = new Database(dbPath);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('synchronous = NORMAL');
  rawDb.pragma('foreign_keys = ON');
  rawPrepare = rawDb.prepare.bind(rawDb);
  createSchema();
}

export function initDatabase(dataDir: string) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, 'ta-platform.db');
  jsonBackupPath = path.join(dataDir, 'ta-platform.json'); // 旧存储：迁移来源 + 备份
  initLogDir(dataDir);

  // 数据库损坏自愈：强杀/断电导致 WAL/SHM 损坏时，杜绝启动即崩、每天试验被卡死。
  //   一阶段：只弃 WAL/SHM 旁文件（最常见损坏源），保住主库全部数据；
  //   二阶段：主库本身损坏才隔离整库、重建空库（旧库完整备份到 db-corrupt-*，可事后恢复）。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    bringUpDb();
  } catch (e) {
    if (!isDbCorruptionError(e)) throw e;
    console.error('[db] 检测到数据库损坏，尝试自愈…', String((e as any)?.message || e));
    try { rawDb?.close(); } catch { /* 忽略 */ }
    // 一阶段：弃 WAL/SHM，保主库
    backupAndRemove(path.join(dataDir, `db-corrupt-${stamp}`), ['-wal', '-shm']);
    try {
      bringUpDb();
      console.warn('[db] 已通过弃用 WAL/SHM 旁文件恢复主库（数据保留）。');
    } catch (e2) {
      if (!isDbCorruptionError(e2)) throw e2;
      try { rawDb?.close(); } catch { /* 忽略 */ }
      // 二阶段：主库损坏，隔离整库、重建空库
      backupAndRemove(path.join(dataDir, `db-corrupt-${stamp}`), ['', '-wal', '-shm', '-journal']);
      bringUpDb();
      console.warn(`[db] 主库损坏无法修复，已隔离到 db-corrupt-${stamp} 并重建空库（旧库备份可事后恢复）。`);
    }
  }
  sqliteSchemaMigrate();
  maybeMigrateFromJson();

  // 就地包装 prepare：对外（getDb().prepare）返回带字段加密的语句；内部用 rawPrepare 保持原样。
  stmtCache.clear();
  (rawDb as any).prepare = patchedPrepare;

  applyRetention();
  checkpoint();

  // R2 合规：长驻会话下保留期需周期性执行（原先只在启动/改设置时跑一次，长时间不重启则永不清理）。
  // 每 12 小时跑一次保留清理；unref 不阻止进程退出；幂等，重复 init 时先清旧计时器。
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
  retentionTimer = setInterval(() => { try { applyRetention(); checkpoint(); } catch { /* 清理失败不影响运行 */ } }, 12 * 3600 * 1000);
  if (retentionTimer.unref) retentionTimer.unref();
}
let retentionTimer: NodeJS.Timeout | null = null;

// H5-2: 从 settings(app-settings.rpa.logRetentionDays) 读取日志保留天数，读取失败回退 30 天
function getLogRetentionDays(): number {
  try {
    const app = getSetting<any>('app-settings', null);
    const d = app?.rpa?.logRetentionDays;
    if (typeof d === 'number' && isFinite(d) && d > 0) return Math.floor(d);
  } catch {
    // 读取/解析失败：回退默认
  }
  return 30;
}

// 候选人 PII 保留天数（PIPL/网数条例 R2：无必要保留的应删除）。默认 90 天，可由设置覆盖；
// 0 或负值表示"不按期删除"（仅受 LIMITS.candidates 条数兜底）。
function getCandidateRetentionDays(): number {
  try {
    const app = getSetting<any>('app-settings', null);
    const d = app?.data?.candidateRetentionDays;
    if (typeof d === 'number' && isFinite(d) && d >= 0) return Math.floor(d);
  } catch {
    // 读取/解析失败：回退默认
  }
  return 90;
}

/* ════════════════════ 猎聘人才池 ════════════════════
 * 与 BOSS 的 candidates_export 完全分开，保留期口径也相反：
 * BOSS 那张表是"本轮结果"（90 天 + 条数滚删）；这张是【长久保存】，
 * 到期不删，只进"待清理"等人确认 —— 业务方明确要"随时能打开"。
 */

/** 安全保存期（天）。到期只是进待清理区提醒，不会静默删除。 */
export function getLiepinKeepDays(): number {
  try {
    const app = getSetting<any>('app-settings', null);
    const d = app?.data?.liepinKeepDays;
    if (typeof d === 'number' && isFinite(d) && d > 0) return Math.floor(d);
  } catch { /* 回退默认 */ }
  return 180;
}

// ══════════ 猎聘人才库 FTS5 影子表（阶段5②） ══════════
// liepin_talents 的检索列是密文，FTS 索引不到。影子表存明文，在写入/删除/回填三处同步。
// ⚠️ 影子表读写一律走 rawPrepare —— 存的就是明文，不能再走加密包装层（patchedPrepare 会再加密一遍导致索不到原文）。

/** 把单个候选人的明文检索列同步进 FTS 影子表（先删后插，幂等）。由 upsertLiepinTalent 调用。 */
function upsertLiepinFts(row: LiepinTalentRow): void {
  if (!row?.res_id) return;
  const del = rawPrepare('DELETE FROM liepin_talents_fts WHERE res_id = ?');
  const ins = rawPrepare(
    'INSERT INTO liepin_talents_fts (res_id, name, position, company, city, experience, degree) VALUES (?,?,?,?,?,?,?)',
  );
  del.run(row.res_id);
  ins.run(
    row.res_id,
    row.name ?? null, row.position ?? null, row.company ?? null,
    row.city ?? null, row.experience ?? null, row.degree ?? null,
  );
}

/**
 * 幂等回填 FTS 影子表（启动时加密就绪后调用一次）。
 * 触发条件：影子表行数 < 主表行数（存量未灌齐才回填，已灌齐则秒过，不每次启动重灌）。
 * 走 patchedPrepare 读主表拿到【解密明文】，走 rawPrepare 写影子表（明文）。
 * 484 行瞬时完成；十万级也只跑一次（之后由 upsert 增量维护）。
 */
export function reindexLiepinTalentsFts(): { indexed: number; skipped: boolean } {
  if (!rawDb) return { indexed: 0, skipped: true };
  try {
    // FTS 表不存在（迁移未跑 / 极旧库）→ 跳过，不抛错（不阻断启动）
    const has = rawPrepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='liepin_talents_fts' LIMIT 1").get();
    if (!has) return { indexed: 0, skipped: true };
    const mainN = Number((rawPrepare('SELECT COUNT(*) AS n FROM liepin_talents').get() as any)?.n || 0);
    const ftsN = Number((rawPrepare('SELECT COUNT(*) AS n FROM liepin_talents_fts').get() as any)?.n || 0);
    if (ftsN >= mainN) return { indexed: 0, skipped: true }; // 已灌齐
    // 走解密包装层读明文（get 端解密），rawPrepare 写明文进 FTS
    const rows = patchedPrepare(
      'SELECT res_id, name, position, company, city, experience, degree FROM liepin_talents',
    ).all() as LiepinTalentRow[];
    const delAll = rawPrepare('DELETE FROM liepin_talents_fts');
    const ins = rawPrepare(
      'INSERT INTO liepin_talents_fts (res_id, name, position, company, city, experience, degree) VALUES (?,?,?,?,?,?,?)',
    );
    const tx = rawDb.transaction((rs: LiepinTalentRow[]) => {
      delAll.run();
      let n = 0;
      for (const r of rs) { if (!r?.res_id) continue; ins.run(r.res_id, r.name ?? null, r.position ?? null, r.company ?? null, r.city ?? null, r.experience ?? null, r.degree ?? null); n++; }
      return n;
    });
    return { indexed: tx(rows) as number, skipped: false };
  } catch (e) {
    console.error('[db] reindexLiepinTalentsFts 失败（已忽略，不影响启动）:', e);
    return { indexed: 0, skipped: true };
  }
}

export interface LiepinTalentRow {
  res_id: string; name?: string; position?: string; company?: string; city?: string;
  experience?: string; degree?: string; salary?: string; active_status?: string;
  source_keyword?: string;
}

/**
 * 入库/更新一个猎聘候选人。
 * first_seen 只在首次写入时落，last_seen 每次都刷新 —— last_seen 是"链接还活着吗"
 * 的代理指标：很久没再被搜到的人，简历多半已下架。
 */
export function upsertLiepinTalent(row: LiepinTalentRow): void {
  if (!row?.res_id) return;
  const today = dateKey(new Date());
  const keepUntil = dateKey(new Date(Date.now() + getLiepinKeepDays() * 86400000));
  patchedPrepare(
    `INSERT INTO liepin_talents
       (res_id, name, position, company, city, experience, degree, salary,
        active_status, source_keyword, first_seen, last_seen, keep_until)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(res_id) DO UPDATE SET
       name = COALESCE(excluded.name, liepin_talents.name),
       position = COALESCE(excluded.position, liepin_talents.position),
       company = COALESCE(excluded.company, liepin_talents.company),
       city = COALESCE(excluded.city, liepin_talents.city),
       experience = COALESCE(excluded.experience, liepin_talents.experience),
       degree = COALESCE(excluded.degree, liepin_talents.degree),
       salary = COALESCE(excluded.salary, liepin_talents.salary),
       active_status = COALESCE(excluded.active_status, liepin_talents.active_status),
       last_seen = excluded.last_seen,
       keep_until = excluded.keep_until`,
    /* 注意：archived / note / detail_at 刻意不在 DO UPDATE 里 ——
       那是 TA 的人工操作与花钱记录，重抓一次绝不能把它们冲掉。 */
  ).run(
    row.res_id, row.name ?? null, row.position ?? null, row.company ?? null, row.city ?? null,
    row.experience ?? null, row.degree ?? null, row.salary ?? null,
    row.active_status ?? null, row.source_keyword ?? null, today, today, keepUntil,
  );
  // 阶段5②：同步明文检索列到 FTS5 影子表（主表是密文，FTS 索引不到；此处明文尚在内存）
  upsertLiepinFts(row);
}

/**
 * 入库并返回【是否本次新增】（2026-08-18 产量重构·修复5：跨轮持久去重）。
 *
 * 与 upsertLiepinTalent 的区别：返回 true = 人才库此前没有此人(本次新增)，
 * false = 已存在(仅刷新 last_seen/keep_until，不覆盖结构化字段、不计新增)。
 *
 * 为什么要这个返回值：深翻 + 更新时间排序时，跨轮跑会把已收录的人再翻出来。
 * 引擎需要「本轮新增(去重后)」计数来验收周产量(6000+/周目标看的是不重复的人，
 * 不是浏览次数)。seenCardIds 只是会话级，跨运行会被清空；持久去重必须查 DB。
 *
 * 已存在的人：仍刷新 last_seen/keep_until（last_seen 是"链接还活着吗"的代理指标，
 * 被再次搜到说明链接仍有效）；评分由调用方单独的 upsertLiepinScore 覆盖重算，
 * 保证已收录的人也评最新分。FTS 影子表同步刷新（明文在内存，幂等）。
 *
 * ⚠️ 存在性判断走 rawPrepare（密文表直接按主键 res_id 查，不解密、不走加密包装层）。
 */
export function upsertLiepinTalentIfNew(row: LiepinTalentRow): boolean {
  if (!row?.res_id) return false;
  const today = dateKey(new Date());
  const keepUntil = dateKey(new Date(Date.now() + getLiepinKeepDays() * 86400000));
  // 先查主键是否已存在（rawPrepare：liepin_talents 主键是 res_id，不需解密即可判存在）
  let exists = false;
  try {
    exists = !!rawPrepare('SELECT 1 FROM liepin_talents WHERE res_id = ? LIMIT 1').get(row.res_id);
  } catch { /* 查不到按不存在处理 → 走 INSERT */ }
  if (exists) {
    // 已存在：只刷新 last_seen/keep_until，不动结构化字段与 archived/note/detail_at
    rawPrepare('UPDATE liepin_talents SET last_seen = ?, keep_until = ? WHERE res_id = ?')
      .run(today, keepUntil, row.res_id);
    upsertLiepinFts(row);
    return false;
  }
  // 新增：走完整 INSERT（与 upsertLiepinTalent 同口径，ON CONFLICT 兜底竞态）
  patchedPrepare(
    `INSERT INTO liepin_talents
       (res_id, name, position, company, city, experience, degree, salary,
        active_status, source_keyword, first_seen, last_seen, keep_until)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(res_id) DO UPDATE SET
       last_seen = excluded.last_seen,
       keep_until = excluded.keep_until`,
  ).run(
    row.res_id, row.name ?? null, row.position ?? null, row.company ?? null, row.city ?? null,
    row.experience ?? null, row.degree ?? null, row.salary ?? null,
    row.active_status ?? null, row.source_keyword ?? null, today, today, keepUntil,
  );
  upsertLiepinFts(row);
  return true;
}

/** 写一份「该候选人对某岗位」的评分。同一 (人, 岗位) 覆盖更新。 */
export function upsertLiepinScore(
  resId: string, jdId: string, score: number, level: string, reasons: unknown, depth: 'A' | 'B',
  insufficientEvidence?: boolean,
): void {
  if (!resId || !jdId) return;
  rawPrepare(
    `INSERT INTO liepin_talent_scores (res_id, jd_id, score, level, reasons, depth, scored_at, insufficient_evidence)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(res_id, jd_id) DO UPDATE SET
       score = excluded.score, level = excluded.level, reasons = excluded.reasons,
       depth = excluded.depth, scored_at = excluded.scored_at,
       insufficient_evidence = excluded.insufficient_evidence`,
  ).run(resId, jdId, score, level, JSON.stringify(reasons ?? null), depth, Date.now(), insufficientEvidence ? 1 : 0);
}

/** 打标签。auto-jd 来源可重复写（幂等）；manual 是 TA 自己打的，不会被自动标覆盖。 */
export function addLiepinTag(resId: string, tag: string, source: 'auto-jd' | 'manual' = 'manual'): void {
  const t = String(tag || '').trim();
  if (!resId || !t) return;
  rawPrepare(
    `INSERT INTO liepin_talent_tags (res_id, tag, source, created_at) VALUES (?,?,?,?)
     ON CONFLICT(res_id, tag) DO NOTHING`,
  ).run(resId, t, source, Date.now());
}

export function removeLiepinTag(resId: string, tag: string): void {
  rawPrepare('DELETE FROM liepin_talent_tags WHERE res_id = ? AND tag = ?').run(resId, tag);
}

/** 标记「已开过详情」——跨运行防重复扣套餐额度的唯一依据。 */
export function markLiepinDetailOpened(resId: string): void {
  rawPrepare('UPDATE liepin_talents SET detail_at = ? WHERE res_id = ?').run(Date.now(), resId);
}

/** 归档 / 取消归档。归档 ≠ 删除：收起不占视线，数据与链接都还在。 */
export function archiveLiepinTalents(resIds: string[], archived: boolean): number {
  if (!resIds?.length) return 0;
  const stmt = rawPrepare('UPDATE liepin_talents SET archived = ? WHERE res_id = ?');
  const tx = rawDb.transaction((ids: string[]) => {
    let n = 0;
    for (const id of ids) n += stmt.run(archived ? 1 : 0, id).changes;
    return n;
  });
  return tx(resIds) as number;
}

/** 真删（含评分与标签）。只由用户在"待清理"区显式确认后调用。 */
export function deleteLiepinTalents(resIds: string[]): number {
  if (!resIds?.length) return 0;
  const tx = rawDb.transaction((ids: string[]) => {
    let n = 0;
    for (const id of ids) {
      rawPrepare('DELETE FROM liepin_talent_scores WHERE res_id = ?').run(id);
      rawPrepare('DELETE FROM liepin_talent_tags WHERE res_id = ?').run(id);
      n += rawPrepare('DELETE FROM liepin_talents WHERE res_id = ?').run(id).changes;
      // 阶段5②：同步删 FTS 影子表（明文检索列随主行清除，否则 FTS 命中会指向已删的人）
      rawPrepare('DELETE FROM liepin_talents_fts WHERE res_id = ?').run(id);
    }
    return n;
  });
  return tx(resIds) as number;
}

/** 保存期已到、等人确认清理的（绝不自动删） */
export function listLiepinExpiring(limit = 500): any[] {
  const today = dateKey(new Date());
  return patchedPrepare(
    `SELECT * FROM liepin_talents WHERE keep_until IS NOT NULL AND keep_until <= ?
     ORDER BY keep_until ASC LIMIT ?`,
  ).all(today, limit) as any[];
}

export interface LiepinTalentQuery {
  jdId?: string;      // 按岗位取该岗位下的评分
  minScore?: number;  // 默认 60：低于此分不显示（业务方要求）
  tag?: string;
  q?: string;         // 姓名/公司/职位模糊搜
  archived?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * FTS5 MATCH 查询词净化：把可能破坏 FTS5 查询语法的字符隔离掉。
 * trigram tokenizer 下，查询词被切成 3-gram；含双引号/星号/冒号/括号等 FTS5 操作符的输入
 * 会触发语法解析异常（FTS5 syntax error），整体抛错退化为"搜不到"。这里把整段用双引号包成
 * phrase query（"..."），并对内部的双引号做转义（"" → 一个字面引号），保证任意用户输入都不会炸查询。
 */
function sanitizeFtsMatch(q: string): string {
  const s = String(q ?? '').trim();
  if (!s) return '';
  // FTS5 phrase：内部双引号转义为 ""，整段用 " 包裹
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * 用 FTS5 影子表检索命中 res_id 集合。
 * 返回 null 表示「回退到内存 LIKE」：① FTS 表不存在 ② 查询词 <3 字符（trigram 匹不到）③ MATCH 抛错。
 * 返回 string[]（可能为空数组）表示走了 FTS：空数组=FTS 明确无命中，调用方据此返回空结果。
 */
function liepinFtsMatchIds(q: string): string[] | null {
  const raw = String(q ?? '').trim();
  if (raw.length < 3) return null; // trigram 对 <3 字符必无命中，直接回退
  // FTS 表不存在（极旧库/迁移未跑）→ 回退，不抛错
  const has = rawPrepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='liepin_talents_fts' LIMIT 1").get();
  if (!has) return null;
  try {
    const rows = rawPrepare(
      'SELECT res_id FROM liepin_talents_fts WHERE liepin_talents_fts MATCH ?',
    ).all(sanitizeFtsMatch(raw)) as Array<{ res_id: string }>;
    return rows.map((r) => r.res_id);
  } catch (e) {
    // MATCH 语法异常或 tokenizer 边界情况：回退内存 LIKE，不阻断检索
    console.warn('[db] liepin FTS MATCH 失败，回退内存 LIKE：', (e as Error)?.message || e);
    return null;
  }
}

/**
 * 猎聘子页主查询：按岗位取分、按分降序、低分不显示。
 * 全文检索（阶段5②）：查询词 ≥3 字符走 FTS5 影子表（trigram 索引加速）；<3 字符或 FTS 无命中/异常时
 *   回退「解密后内存 LIKE」（即原逻辑，正确性零损失）。主表是密文，SQL LIKE 索引不到，旧做法靠内存过滤。
 */
export function listLiepinTalents(opt: LiepinTalentQuery = {}): { rows: any[]; total: number } {
  const minScore = opt.minScore ?? 60;
  const archived = opt.archived ? 1 : 0;
  const params: any[] = [];
  let sql = `SELECT t.*, s.score AS score, s.level AS level, s.jd_id AS jd_id,
                    s.reasons AS reasons, s.depth AS depth,
                    s.insufficient_evidence AS insufficient_evidence
             FROM liepin_talents t `;
  if (opt.jdId) {
    sql += 'JOIN liepin_talent_scores s ON s.res_id = t.res_id AND s.jd_id = ? ';
    params.push(opt.jdId);
  } else {
    // 不指定岗位时取该人的最高分（TA 想看"这个人最适合的岗位是哪个"）
    sql += `LEFT JOIN liepin_talent_scores s ON s.res_id = t.res_id
            AND s.score = (SELECT MAX(score) FROM liepin_talent_scores x WHERE x.res_id = t.res_id) `;
  }
  if (opt.tag) {
    sql += 'JOIN liepin_talent_tags g ON g.res_id = t.res_id AND g.tag = ? ';
    params.push(opt.tag);
  }
  sql += 'WHERE t.archived = ? ';
  params.push(archived);
  if (minScore > 0) { sql += 'AND COALESCE(s.score, 0) >= ? '; params.push(minScore); }
  sql += 'GROUP BY t.res_id ORDER BY COALESCE(s.score, 0) DESC, t.last_seen DESC';

  // FTS5 路径：q ≥3 字符且 FTS 表就绪时，先拿命中 res_id 集，下推到主查询缩小结果集
  const ftsIds = opt.q ? liepinFtsMatchIds(opt.q) : null;

  // 拼接 FTS 过滤条件到【archived/score 之后、GROUP BY 之前】——需要重建 SQL 结构。
  // 为避免在已有 sql 上做脆弱的字符串替换，这里采用「主查询取全量 + 内存按 res_id 集过滤」的等价做法，
  // 与下方内存 LIKE 回退同一代码路径，行为一致且可读。FTS 的收益体现在：返回的命中集通常远小于全表，
  // 主查询本就在内存里（patchedPrepare 解密），FTS 把"全表解密+filter"换成"小集合 lookup"。
  let rows = patchedPrepare(sql).all(...params) as any[];

  if (opt.q) {
    const kw = String(opt.q).trim().toLowerCase();
    if (!kw) {
      // 空查询：不过滤
    } else if (ftsIds && ftsIds.length === 0) {
      // FTS 明确无命中 → 直接空集（不回退：≥3 字符走 FTS 是正确的，回退 LIKE 也搜不到同样的词）
      rows = [];
    } else if (ftsIds) {
      // FTS 命中：按 res_id 集过滤（FTS 已按 token 命中，这里只做集合归属）
      const idSet = new Set(ftsIds);
      rows = rows.filter((r) => idSet.has(r.res_id));
    } else {
      // 回退：FTS 不可用（<3 字符/表缺失/异常）→ 解密后内存 LIKE
      rows = rows.filter((r) => [r.name, r.company, r.position, r.city]
        .some((v) => String(v || '').toLowerCase().includes(kw)));
    }
  }
  const total = rows.length;
  const off = Math.max(0, opt.offset || 0);
  const lim = opt.limit && opt.limit > 0 ? opt.limit : 200;
  return { rows: rows.slice(off, off + lim), total };
}

/** 某人的全部岗位评分（子页展开行用：一个人对多个岗位的不同分数） */
export function getLiepinScoresFor(resId: string): any[] {
  return rawPrepare(
    'SELECT jd_id, score, level, reasons, depth, scored_at, insufficient_evidence FROM liepin_talent_scores '
    + 'WHERE res_id = ? ORDER BY score DESC',
  ).all(resId) as any[];
}

export function getLiepinTags(resIds: string[]): Record<string, Array<{ tag: string; source: string }>> {
  const out: Record<string, Array<{ tag: string; source: string }>> = {};
  if (!resIds?.length) return out;
  const stmt = rawPrepare('SELECT res_id, tag, source FROM liepin_talent_tags WHERE res_id = ?');
  for (const id of resIds) {
    out[id] = stmt.all(id) as Array<{ tag: string; source: string }>;
  }
  return out;
}

/** 全部标签 + 各自人数（子页左侧标签栏） */
export function getLiepinTagCounts(): Array<{ tag: string; n: number; source: string }> {
  return rawPrepare(
    `SELECT tag, COUNT(*) AS n, MIN(source) AS source FROM liepin_talent_tags
     GROUP BY tag ORDER BY n DESC, tag ASC`,
  ).all() as Array<{ tag: string; n: number; source: string }>;
}

/** 子页顶部统计：总量 / 今日新增 / 已归档 / 待清理 */
export function getLiepinTalentStats(): { total: number; today: number; archived: number; expiring: number; todayOpened: number } {
  const today = dateKey(new Date());
  const one = (sql: string, ...p: any[]) => Number((rawPrepare(sql).get(...p) as any)?.n || 0);
  // D3(2026-08-05)：todayOpened = 今日已消耗的套餐额度（detail_at 在今日的行数），
  // 用来在 UI 显示"今日还剩 N 份"，避免 TA 误点花冤枉钱。
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  return {
    total: one('SELECT COUNT(*) AS n FROM liepin_talents WHERE archived = 0'),
    today: one('SELECT COUNT(*) AS n FROM liepin_talents WHERE first_seen = ?', today),
    archived: one('SELECT COUNT(*) AS n FROM liepin_talents WHERE archived = 1'),
    expiring: one('SELECT COUNT(*) AS n FROM liepin_talents WHERE keep_until IS NOT NULL AND keep_until <= ?', today),
    todayOpened: one('SELECT COUNT(*) AS n FROM liepin_talents WHERE detail_at IS NOT NULL AND detail_at >= ?', todayStart.getTime()),
  };
}

export function applyRetention(platform?: string) {
  if (!rawDb) return;
  // H5-2: 日志按“保留天数”真正生效——删除 time 早于 now - retentionDays 的日志；
  // LIMITS.logs 作为条数兜底上限
  const retentionDays = getLogRetentionDays();
  const cutoffTs = Date.now() - retentionDays * 86400000;
  const plat = platform && platform.trim() ? platform.trim() : '';
  const hasPlat = !!plat;
  try {
    if (hasPlat) {
      rawPrepare('DELETE FROM rpa_logs WHERE platform = ? AND time IS NOT NULL AND time < ?').run(plat, cutoffTs);
      rawPrepare(
        'DELETE FROM rpa_logs WHERE platform = ? AND id NOT IN (SELECT id FROM rpa_logs WHERE platform = ? ORDER BY id DESC LIMIT ?)',
      ).run(plat, plat, LIMITS.logs);
    } else {
      rawPrepare('DELETE FROM rpa_logs WHERE time IS NOT NULL AND time < ?').run(cutoffTs);
      rawPrepare('DELETE FROM rpa_logs WHERE id NOT IN (SELECT id FROM rpa_logs ORDER BY id DESC LIMIT ?)').run(LIMITS.logs);
    }
    // 独立日志分文件同样按保留天数清理（分文件按日期组织，暂不按平台拆分，全局清）
    cleanupOldLogFiles(retentionDays);

    // B4: diagnostics/ 目录也纳入保留期清理（采样文件 30 天过期）
    cleanupDiagnosticsDir(retentionDays);

    // R2 合规：候选人 PII 按保留期到期删除（date 早于 now - candidateRetentionDays 即清），
    // 再叠加 LIMITS.candidates 条数兜底。retentionDays<=0 表示不按期删除。
    const candDays = getCandidateRetentionDays();
    if (candDays > 0) {
      const candCutoff = new Date();
      candCutoff.setDate(candCutoff.getDate() - candDays);
      const ds = dateKey(candCutoff);
      if (hasPlat) rawPrepare('DELETE FROM candidates_export WHERE platform = ? AND date IS NOT NULL AND date < ?').run(plat, ds);
      else rawPrepare('DELETE FROM candidates_export WHERE date IS NOT NULL AND date < ?').run(ds);
    }
    if (hasPlat) {
      rawPrepare(
        'DELETE FROM candidates_export WHERE platform = ? AND id NOT IN (SELECT id FROM candidates_export WHERE platform = ? ORDER BY id DESC LIMIT ?)',
      ).run(plat, plat, LIMITS.candidates);
      rawPrepare(
        'DELETE FROM risk_history WHERE platform = ? AND id NOT IN (SELECT id FROM risk_history WHERE platform = ? ORDER BY id DESC LIMIT ?)',
      ).run(plat, plat, LIMITS.riskHistory);
    } else {
      rawPrepare(
        'DELETE FROM candidates_export WHERE id NOT IN (SELECT id FROM candidates_export ORDER BY id DESC LIMIT ?)',
      ).run(LIMITS.candidates);
      rawPrepare(
        'DELETE FROM risk_history WHERE id NOT IN (SELECT id FROM risk_history ORDER BY id DESC LIMIT ?)',
      ).run(LIMITS.riskHistory);
    }

    // dailyStats 保留最近 N 天
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LIMITS.dailyStatsDays);
    const ds = dateKey(cutoff);
    if (hasPlat) rawPrepare('DELETE FROM daily_stats WHERE platform = ? AND date < ?').run(plat, ds);
    else rawPrepare('DELETE FROM daily_stats WHERE date < ?').run(ds);
  } catch (e) {
    console.error('[db] applyRetention 失败:', e);
  }
}

// 清空 RPA 日志（真删库 + 清分文件），供"清空日志"按钮持久生效
// platform 不传则清全平台（历史默认行为），传入则只清对应平台（避免 BOSS/猎聘互相误删）。
export function clearAllLogs(platform?: string) {
  if (!rawDb) return;
  const plat = platform && platform.trim() ? platform.trim() : '';
  try {
    if (plat) rawPrepare('DELETE FROM rpa_logs WHERE platform = ?').run(plat);
    else rawPrepare('DELETE FROM rpa_logs').run();
    // 独立分文件按天组织（未按平台拆分），只在全量清空时清理，避免误删其它平台当日日志
    if (!plat) {
      try {
        if (logDir && fs.existsSync(logDir)) {
          for (const f of fs.readdirSync(logDir)) {
            if (f.endsWith('.log')) fs.rmSync(path.join(logDir, f), { force: true });
          }
        }
      } catch {
        /* 分文件清理失败不阻断 */
      }
    }
  } catch (e) {
    console.error('[db] clearAllLogs 失败:', e);
  }
}

// ============ Low(独立日志文件): RPA 日志落盘 + 读取接口 ============
// 关键运行/风险/错误日志按天写入 userData/logs/YYYY-MM-DD.log（JSON Lines），
// 重启后不再丢失；提供 readLogFile 供 UI 读取。
function initLogDir(dataDir: string) {
  try {
    logDir = path.join(dataDir, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    console.error('[db] 初始化日志目录失败:', e);
    logDir = '';
  }
}

// 文件名安全化：只允许 YYYY-MM-DD 形态，异常回退今天
function logFileDay(date: string | undefined): string {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return dateKey(new Date());
}

function appendLogFile(row: { date: string; time: number; level: string; task_id: string | null; message: string }) {
  if (!logDir) return;
  try {
    const day = logFileDay(row.date);
    const file = path.join(logDir, `${day}.log`);
    const line = JSON.stringify({
      t: row.time,
      level: row.level,
      task: row.task_id,
      msg: row.message,
    }) + '\n';
    fs.appendFileSync(file, line, 'utf-8');
  } catch {
    // 落盘失败不影响主流程（sqlite 里的日志仍在）
  }
}

function cleanupOldLogFiles(retentionDays: number) {
  if (!logDir) return;
  try {
    const cutoffDay = dateKey(new Date(Date.now() - retentionDays * 86400000));
    for (const f of fs.readdirSync(logDir)) {
      if (!f.endsWith('.log')) continue;
      const d = f.slice(0, -4);
      if (d < cutoffDay) {
        try {
          fs.unlinkSync(path.join(logDir, f));
        } catch {}
      }
    }
  } catch {}
}

/** B4: 清理 diagnostics/ 目录下的旧采样文件。 */
function cleanupDiagnosticsDir(retentionDays: number) {
  try {
    if (!dbPath) return;
    const diagsDir = path.join(path.dirname(dbPath), 'diagnostics');
    if (!fs.existsSync(diagsDir)) return;
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const f of fs.readdirSync(diagsDir)) {
      if (!/^page-structure-\d+\.json$/.test(f)) continue;
      const full = path.join(diagsDir, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* 单个文件删不掉就算了 */ }
    }
  } catch { /* ignore */ }
}

/** 落盘日志读取接口（供 UI 用）。
 *  dateOrRange:
 *   - 省略：返回全部分文件
 *   - 'YYYY-MM-DD'：返回该天
 *   - { from?, to? }：按天区间（含端点，字典序比较，YYYY-MM-DD 天然可比）
 */
export interface LogFileEntry {
  time: number;
  level: string;
  taskId: string | null;
  message: string;
}
export function readLogFile(dateOrRange?: string | { from?: string; to?: string }): LogFileEntry[] {
  if (!logDir) return [];
  let files: string[];
  try {
    files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
  } catch {
    return [];
  }
  let selected: string[];
  if (!dateOrRange) {
    selected = files;
  } else if (typeof dateOrRange === 'string') {
    selected = files.filter((f) => f === `${dateOrRange}.log`);
  } else {
    const { from, to } = dateOrRange;
    selected = files.filter((f) => {
      const d = f.slice(0, -4);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }
  selected.sort();
  const out: LogFileEntry[] = [];
  for (const f of selected) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(logDir, f), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        out.push({ time: o.t, level: o.level, taskId: o.task ?? null, message: o.msg });
      } catch {
        // 单行损坏跳过
      }
    }
  }
  return out;
}

// ============ 落盘/刷新（sqlite 事务/WAL 承担原子性，这里降级为 checkpoint/no-op） ============
// 原 JSON 版本的 writeAtomic 走 tmp+rename+fsync；sqlite WAL 下每次事务提交即持久，
// 这里保留同名内部函数但语义改为“把 WAL 合并回主库”（checkpoint），best-effort。
function checkpoint() {
  if (!rawDb) return;
  try {
    rawDb.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // 某些状态下 checkpoint 可能被占用，忽略即可（数据已在 WAL 中持久）
  }
}

/** 关键变更后立即“落盘”。sqlite 已即时持久；这里做一次 checkpoint 把 WAL 合并回主库。 */
export function persistImmediate() {
  checkpoint();
}

// app.quit 前调用：确保 WAL 合并回主库。
export function flushDb() {
  checkpoint();
}

// ============ 对外 API（保持与既有调用兼容）============
// 返回真实 better-sqlite3 Database 实例（其 .prepare 已被就地包装以透明处理字段级加密）。
// 调用方使用 db.prepare(sql).get/all/run 与 db.exec(sql)，与既有代码完全一致。
export function getDb(): SqliteDb {
  return rawDb;
}

// 2026-08-07 审查项 P0-1: 恢复操作需要在替换文件前关闭 SQLite 句柄，否则 Windows 上
// better-sqlite3 持有的文件锁会让 fs.rmSync 在删到一半时抛 EPERM，导致数据目录被
// 删了一半但新数据还没拷进来。幂等：rawDb 未开或已关时直接返回。
export function closeDb(): void {
  if (!rawDb || !rawDb.open) return;
  stmtCache.clear();
  try { rawDb.close(); } catch { /* 关不掉也继续，让后续操作自行报错 */ }
}

// 真正的“清空所有数据”：清空各业务表（保留 _meta 中的 schemaVersion/jsonMigrated，防止旧 JSON 死灰复燃）。
export function clearAllData() {
  if (!rawDb) return;
  const tables = ['settings', 'tools', 'jds', 'rpa_tasks', 'rpa_logs', 'daily_stats', 'candidates_export', 'risk_history', 'jr_inbox',
    'liepin_talents', 'liepin_talent_scores', 'liepin_talent_tags'];
  const tx = rawDb.transaction(() => {
    for (const t of tables) rawDb.exec(`DELETE FROM ${t}`);
    // B-边界：同步清空 FTS5 影子表。主表 liepin_talents 清了但影子表没清会残留死行
    // （查询结果仍正确——主表无行 JOIN 出空集，但 FTS 占空间且不干净）。此处幂等清空。
    try {
      rawPrepare('DELETE FROM liepin_talents_fts').run();
    } catch { /* FTS 表不存在（极旧库）则忽略 */ }
    try {
      rawDb.exec('DELETE FROM sqlite_sequence');
    } catch {}
  });
  tx();
  checkpoint();
  // 阶段7 运行日志留痕（只记录，不改行为）：清空所有数据是破坏性动作，
  // 必须可追溯"何时清的、清了几张表"。无 PII：只记表数量，不记任何行内容。
  try { oplog('db', 'clear-all', { tables: tables.length }); } catch { /* 日志绝不影响清理 */ }

  // B4: 同时清空 diagnostics/ 目录下的采样文件
  try {
    if (dbPath) {
      const diagsDir = path.join(path.dirname(dbPath), 'diagnostics');
      if (fs.existsSync(diagsDir)) {
        for (const f of fs.readdirSync(diagsDir)) {
          if (!/^page-structure-\d+\.json$/.test(f)) continue;
          try { fs.unlinkSync(path.join(diagsDir, f)); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
}

// ============ prepare 包装：透明字段级加密（H4） ============
// 只对 jds / candidates_export 的敏感列做 INSERT 参数加密 与 SELECT 结果解密；
// 其它表/其它语句直接透传给真实语句，SQL 全部在真实表上执行。
interface StmtMeta {
  table: string | null;
  encIndices: number[]; // INSERT 时需加密的参数下标（对应 VALUES 里 ? 的顺序 = 列顺序）
  decFields: string[] | null; // SELECT 结果里需解密的列
  isLogInsert: boolean; // rpa_logs 的 INSERT：需额外落独立日志分文件
}

function analyzeSql(sql: string): StmtMeta {
  const meta: StmtMeta = { table: null, encIndices: [], decFields: null, isLogInsert: false };
  const s = sql.replace(/\s+/g, ' ').trim();

  // INSERT [OR REPLACE] INTO tbl (cols) VALUES (...)
  const ins = /^INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]*)\)/i.exec(s);
  if (ins) {
    const table = ins[1];
    meta.table = table;
    meta.isLogInsert = table === 'rpa_logs';
    const cols = ins[2].split(',').map((c) => c.trim());
    const enc = ENCRYPTED_TABLE_FIELDS[table];
    if (enc) {
      cols.forEach((c, i) => {
        if (enc.includes(c)) meta.encIndices.push(i);
      });
    }
    return meta;
  }

  // UPDATE tbl SET col1=?, col2=? ... （P2-2：解析 SET 子句填 encIndices）
  // 防的是：将来有人写普通 UPDATE 命中加密列，把明文写进"声称已加密"的列而无任何告警。
  // 注意参数下标是整个 SQL 里「?」的顺序（含 WHERE 子句的 ?），但加密只需管 SET 段。
  const upd = /^UPDATE\s+(\w+)\s+SET\s+([^)]*?)(?:\s+WHERE|\s*$)/i.exec(s);
  if (upd) {
    const table = upd[1];
    meta.table = table;
    const enc = ENCRYPTED_TABLE_FIELDS[table];
    if (enc) {
      // SET 子句: "col1 = ?, col2 = ?" 或 "col1=excluded.col1" (UPSERT DO UPDATE)
      // 只处理 col=? 形式（参数化写入），col=excluded.x 是 UPSERT 引用，无 ? 参数
      const setCols: string[] = [];
      for (const pair of upd[2].split(',')) {
        const m = /(\w+)\s*=\s*\?/.exec(pair.trim());
        if (m) setCols.push(m[1]);
      }
      setCols.forEach((c, i) => {
        if (enc.includes(c)) meta.encIndices.push(i);
      });
      meta.decFields = enc;
    }
    return meta;
  }

  // 其它语句：取 FROM 后的表名，若属加密表则标记需解密（仅 get/all 用到 decFields）
  const from = /\bFROM\s+(\w+)/i.exec(s);
  if (from) {
    const table = from[1];
    meta.table = table;
    if (ENCRYPTED_TABLE_FIELDS[table]) meta.decFields = ENCRYPTED_TABLE_FIELDS[table];
  }
  return meta;
}

// 包装后的语句：实现 better-sqlite3 Statement 常用的 get/all/run，其余方法按需透传。
class CryptoStatement {
  private stmt: SqliteStmt;
  private meta: StmtMeta;
  constructor(sql: string) {
    this.stmt = rawPrepare(sql);
    this.meta = analyzeSql(sql);
  }

  private decRow(row: any): any {
    if (!row || !encryptionEnabled || !this.meta.decFields) return row;
    for (const f of this.meta.decFields) {
      const v = row[f];
      if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
        row[f] = decryptField(v, `${this.meta.table}#${row.id ?? '?'}.${f}`);
      }
    }
    return row;
  }

  get(...params: any[]): any {
    const row = this.stmt.get(...params);
    return this.decRow(row);
  }

  all(...params: any[]): any[] {
    const rows = this.stmt.all(...params) as any[];
    if (encryptionEnabled && this.meta.decFields) {
      for (const r of rows) this.decRow(r);
    }
    return rows;
  }

  run(...params: any[]): Database.RunResult {
    let p = params;
    if (encryptionEnabled && this.meta.encIndices.length) {
      p = params.slice();
      for (const i of this.meta.encIndices) {
        if (typeof p[i] === 'string' && p[i]) p[i] = encryptField(p[i]);
      }
    }
    const res = this.stmt.run(...p);
    if (this.meta.isLogInsert) {
      // 独立日志分文件：参数顺序 = (date, time, level, task_id, message)
      try {
        appendLogFile({
          date: params[0],
          time: params[1],
          level: params[2],
          task_id: params[3] ?? null,
          message: params[4],
        });
      } catch {}
    }
    return res;
  }

  // 透传其余可能用到的方法/属性（当前调用方未使用，保底兼容）
  iterate(...params: any[]): IterableIterator<any> {
    return (this.stmt as any).iterate(...params);
  }
  pluck(toggle?: boolean): CryptoStatement {
    (this.stmt as any).pluck(toggle);
    return this;
  }
  bind(...params: any[]): CryptoStatement {
    (this.stmt as any).bind(...params);
    return this;
  }
  get source(): string {
    return (this.stmt as any).source;
  }
}

// getDb().prepare 的实际实现：同 SQL 复用同一 CryptoStatement
function patchedPrepare(sql: string): any {
  let c = stmtCache.get(sql);
  if (!c) {
    c = new CryptoStatement(sql);
    stmtCache.set(sql, c);
  }
  return c;
}

// ============ tools 表专用 API（H2 修复：字段级更新，不互相覆盖） ============
export function setToolEnabled(id: string, enabled: boolean): void {
  rawPrepare(
    `INSERT INTO tools (id, enabled, config) VALUES (?, ?, '{}')
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
  ).run(id, enabled ? 1 : 0);
}

export function setToolConfig(id: string, config: Record<string, any>): void {
  rawPrepare(
    `INSERT INTO tools (id, enabled, config) VALUES (?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config`,
  ).run(id, JSON.stringify(config));
}

function defaultDaily(date: string, platform: string = 'boss'): DailyRow {
  return {
    date,
    platform,
    viewed: 0,
    greeted: 0,
    favorited: 0,
    high_match: 0,
    mid_match: 0,
    low_match: 0,
    risk_events: 0,
    pages: 0,
    searches: 0,
    details: 0,
  };
}

// ============ 低层 settings 读写（settings 表非加密表，直接走 rawPrepare） ============
function rawSettingGet(key: string): string | undefined {
  if (!rawDb) return undefined;
  const row = rawPrepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
// 数据库段启动失败后（rawDb 为空），写路径必须与读路径同样安全：
// 此前只有 rawSettingGet 有守卫，任何 setSetting/bumpDaily 都是 TypeError——
// 而它们散布在风控 60s 定时器、路由记录等处，等于周期性向全局兜底扔异常。
let warnedDbDown = false;
function warnDbDownOnce(op: string) {
  if (warnedDbDown) return;
  warnedDbDown = true;
  console.warn(`[db] 数据库不可用，${op} 及后续写入均被丢弃（重启并修复数据库后恢复）`);
}
function rawSettingSet(key: string, value: string): void {
  if (!rawDb) { warnDbDownOnce(`settings 写入(${key})`); return; }
  rawPrepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
function rawSettingDelete(key: string): void {
  if (!rawDb) { warnDbDownOnce(`settings 删除(${key})`); return; }
  rawPrepare('DELETE FROM settings WHERE key = ?').run(key);
}

// ============ 公开辅助 ============
export function getSetting<T>(key: string, fallback: T): T {
  const v = rawSettingGet(key);
  if (v === undefined) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  rawSettingSet(key, JSON.stringify(value));
}

export function bumpDaily(field: keyof DailyRow, by = 1, platform: string = 'boss'): void {
  if (field === 'date' || field === 'platform') return;
  if (!DAILY_FIELDS.includes(field)) return; // 白名单校验，杜绝列名注入
  if (!rawDb) { warnDbDownOnce(`daily_stats 计数(${String(field)})`); return; }
  const date = todayKey();
  rawPrepare(
    `INSERT INTO daily_stats (date, platform, ${field}) VALUES (?, ?, ?)
     ON CONFLICT(date, platform) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
  ).run(date, platform, by);
}

export function getDaily(date = todayKey(), platform: string = 'boss'): DailyRow {
  if (!rawDb) return defaultDaily(date, platform);
  const row = rawPrepare('SELECT * FROM daily_stats WHERE date = ? AND platform = ?')
    .get(date, platform) as DailyRow | undefined;
  return row ? { ...defaultDaily(date, platform), ...row } : defaultDaily(date, platform);
}

function todayKey(): string {
  return dateKey(new Date());
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}
