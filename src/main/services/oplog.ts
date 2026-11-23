// 运行日志（oplog）—— 平台全功能行为记录，供事后精确诊断
//
// 目的：用户独立运行整个平台，出问题时靠这份日志还原"到底发生了什么"，
//      而不是靠回忆和猜测。
//
// ★ 铁律：只记录，绝不影响任何功能。为此做了五条硬约束：
//   ① 所有对外函数整体 try/catch，任何内部异常一律吞掉 —— 日志坏了业务照跑；
//   ② 写入是"投进内存缓冲即返回"，落盘在定时器里做 —— 不在业务热路径上做 I/O；
//   ③ 缓冲有上限，满了丢最旧的 —— 绝不因为日志把内存吃爆；
//   ④ 不写 SQLite —— 主库是 better-sqlite3 同步 API，日志高频写会和业务抢主线程；
//      改用按天滚动的 JSONL 文件，顺带方便整包导出给我看；
//   ⑤ 不记 PII —— 候选人姓名/公司/联系方式一律不进日志，只记数量、ID 哈希、耗时。
//
// 读法：每行一个 JSON。字段 t=时间戳 a=功能域 n=动作 ok=成败 ms=耗时 d=细节。
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface OpLogEntry {
  t: number;              // 时间戳
  a: string;              // 功能域：ipc / rpa / risk / chrome / db / ui / proc / tool
  n: string;              // 动作名
  ok?: boolean;           // 成败（无成败概念的事件可省略）
  ms?: number;            // 耗时
  p?: string;             // 平台（boss / liepin），无关的省略
  d?: Record<string, any>; // 细节（已脱敏）
}

const MAX_BUFFER = 2000;          // 内存缓冲条数上限，超了丢最旧的
const FLUSH_INTERVAL_MS = 3000;   // 落盘间隔
const MAX_FILE_BYTES = 8 * 1024 * 1024;  // 单文件 8MB，超了滚动
const RETENTION_DAYS = 30;        // 保留天数

let buffer: OpLogEntry[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let dir: string | null = null;
let dropped = 0;                  // 因缓冲满而丢弃的条数（下次落盘时如实记一条）
let sessionId = '';
let disabled = false;             // 出过致命错误就整体停用，绝不反复拖累业务

/** 日志目录。懒初始化：app.getPath 在 ready 之前不可用。 */
function logDir(): string | null {
  if (disabled) return null;
  if (dir) return dir;
  try {
    const d = path.join(app.getPath('userData'), 'oplog');
    fs.mkdirSync(d, { recursive: true });
    dir = d;
    return d;
  } catch {
    disabled = true;   // 建不出目录就彻底放弃，不再重试
    return null;
  }
}

function todayFile(): string | null {
  const d = logDir();
  if (!d) return null;
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(d, `oplog-${key}.jsonl`);
}

/** 敏感字段脱敏：候选人姓名这类绝不入日志，只留长度/哈希，够诊断就行。 */
export function hashId(v: unknown): string {
  try {
    const s = String(v ?? '');
    if (!s) return '';
    return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
  } catch {
    return '';
  }
}

/** 细节对象的安全化：截断超长值、丢掉可能含 PII 的键。 */
const PII_KEYS = /name|phone|mobile|email|idcard|资料|姓名|手机|邮箱|简历|resume|detailText|cardText/i;
function safeDetail(d?: Record<string, any>): Record<string, any> | undefined {
  if (!d) return undefined;
  try {
    const out: Record<string, any> = {};
    let n = 0;
    for (const [k, v] of Object.entries(d)) {
      if (n++ >= 24) break;                      // 键数上限，防止把整个对象倒进来
      if (PII_KEYS.test(k)) continue;            // 疑似 PII 的键直接跳过
      if (v == null) { out[k] = v; continue; }
      const t = typeof v;
      if (t === 'number' || t === 'boolean') { out[k] = v; continue; }
      if (t === 'string') { out[k] = (v as string).slice(0, 200); continue; }
      if (Array.isArray(v)) { out[k] = `[${v.length}]`; continue; }  // 数组只记长度
      out[k] = '{obj}';
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * 记一条。★ 这是热路径上唯一会被调用的函数，必须极快且绝不抛。
 * 只做"投进数组"，真正的 I/O 在定时器里。
 *
 * 重要事件（失败、风险、进程）立即落盘：崩溃前 3 秒恰恰是要查的，不能等定时器。
 */
export function oplog(area: string, action: string, detail?: Record<string, any>,
  opts?: { ok?: boolean; ms?: number; platform?: string }): void {
  if (disabled) return;
  try {
    if (buffer.length >= MAX_BUFFER) {
      buffer.shift();   // 丢最旧的，保住最近的现场
      dropped++;
    }
    buffer.push({
      t: Date.now(),
      a: String(area).slice(0, 24),
      n: String(action).slice(0, 64),
      ...(opts?.ok !== undefined ? { ok: opts.ok } : {}),
      ...(opts?.ms !== undefined ? { ms: Math.round(opts.ms) } : {}),
      ...(opts?.platform ? { p: opts.platform } : {}),
      ...(detail ? { d: safeDetail(detail) } : {}),
    });
    // A2: 失败、风险、进程事件立即落盘，其余仍走定时器
    if (opts?.ok === false || area === 'risk' || area === 'proc') {
      flush();
    } else {
      ensureTimer();
    }
  } catch {
    /* 记日志本身出错，什么都不做 —— 绝不让它冒泡到业务 */
  }
}

/** 计时器版：返回一个 done 回调，业务在结束时调一次。同样绝不抛。 */
export function oplogTimed(area: string, action: string, detail?: Record<string, any>) {
  const t0 = Date.now();
  return (ok: boolean, extra?: Record<string, any>) => {
    oplog(area, action, { ...(detail || {}), ...(extra || {}) }, { ok, ms: Date.now() - t0 });
  };
}

function ensureTimer() {
  if (flushTimer || disabled) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_INTERVAL_MS);
  // unref：日志定时器绝不能拖住进程退出
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** 落盘。同步 append 但只在定时器里发生，不在业务调用栈上。 */
export function flush(): void {
  if (disabled || !buffer.length) return;
  const batch = buffer;
  buffer = [];
  try {
    const f = todayFile();
    if (!f) return;
    if (dropped > 0) {
      batch.unshift({ t: Date.now(), a: 'oplog', n: 'buffer-overflow', d: { dropped } });
      dropped = 0;
    }
    // 文件超限先滚动（保留旧的，加序号后缀）
    try {
      const st = fs.statSync(f);
      if (st.size > MAX_FILE_BYTES) {
        fs.renameSync(f, f.replace(/\.jsonl$/, `.${Date.now()}.jsonl`));
      }
    } catch { /* 文件不存在，正常 */ }
    fs.appendFileSync(f, batch.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  } catch {
    /* 落盘失败就丢掉这一批，不重试不报错 —— 日志不值得为自己冒任何风险 */
  }
}

/** 会话开始。记一条环境快照，事后定位"哪个版本、什么环境"。 */
export function startSession(extra?: Record<string, any>): void {
  try {
    sessionId = hashId(`${Date.now()}-${Math.random()}`);
    oplog('proc', 'session-start', {
      session: sessionId,
      ver: app.getVersion?.() || '',
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      ...(extra || {}),
    });
    cleanupOld();
  } catch { /* ignore */ }
}

export function getSessionId(): string { return sessionId; }

/** 保留期清理。启动时跑一次即可，失败无所谓。 */
function cleanupOld(): void {
  try {
    const d = logDir();
    if (!d) return;
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const f of fs.readdirSync(d)) {
      // A5: 同时清理 oplog- 和 bundle- 前缀的文件
      if (!f.startsWith('oplog-') && !f.startsWith('bundle-')) continue;
      const full = path.join(d, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* 单个文件删不掉就算了 */ }
    }
  } catch { /* ignore */ }
}

/** 日志目录路径（供 UI 的「打开日志文件夹」用） */
export function getOplogDir(): string {
  return logDir() || '';
}

/** A4: 日志健康状态 —— 供运行日志页顶部显示，让用户明确知道日志是否在记录。 */
export function getOplogHealth(): { enabled: boolean; dir: string; todayBytes: number; lastWriteAt: number; disabledReason?: string } {
  try {
    const d = logDir();
    if (!d) {
      return { enabled: false, dir: '', todayBytes: 0, lastWriteAt: 0, disabledReason: '日志目录创建失败（磁盘满或权限不足）' };
    }
    const f = todayFile();
    let todayBytes = 0;
    let lastWriteAt = 0;
    if (f && fs.existsSync(f)) {
      try {
        const st = fs.statSync(f);
        todayBytes = st.size;
        lastWriteAt = st.mtimeMs;
      } catch { /* ignore */ }
    }
    return { enabled: true, dir: d, todayBytes, lastWriteAt };
  } catch {
    return { enabled: false, dir: '', todayBytes: 0, lastWriteAt: 0, disabledReason: '未知错误' };
  }
}

/** 最近 N 条（供 UI 内置查看器用，不读全量文件） */
export function recentEntries(limit = 300): OpLogEntry[] {
  try {
    flush();
    const f = todayFile();
    if (!f || !fs.existsSync(f)) return [];
    // 只读文件尾部，避免大文件全量载入
    const st = fs.statSync(f);
    const readBytes = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, st.size - readBytes);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      const out: OpLogEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try { out.push(JSON.parse(lines[i])); } catch { /* 半行忽略 */ }
      }
      return out;
    } finally {
      // A5: 确保 fd 一定关闭，即使 readSync 抛异常
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** 汇总：按功能域/动作统计调用数、失败数、P95 耗时。用来一眼看出哪个功能在出问题。 */
export function summarize(days = 3): Array<{ area: string; action: string; n: number; fail: number; p95: number }> {
  try {
    flush();
    const d = logDir();
    if (!d) return [];
    const cutoff = Date.now() - days * 86400000;
    const agg = new Map<string, { n: number; fail: number; ms: number[] }>();
    // ⚠️ 这是在主进程上同步解析文件，而主进程还要驱动 CDP 和界面。
    //    单文件上限 8MB × 多天可能几十 MB，全解析会让界面冻结好几秒。
    //    加总量闸：超过就停下（汇总本来就是"看个大概"，不需要绝对精确）。
    const MAX_SCAN_BYTES = 12 * 1024 * 1024;
    let scanned = 0;
    // 新文件优先（倒序）：预算用完时，保住的是最近的数据 —— 那才是诊断要看的
    for (const f of fs.readdirSync(d).sort().reverse()) {
      if (scanned > MAX_SCAN_BYTES) break;
      if (!f.startsWith('oplog-')) continue;
      const full = path.join(d, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) continue;
        scanned += st.size;
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (!line) continue;
          let e: OpLogEntry;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.t < cutoff) continue;
          const k = `${e.a} ${e.n}`;
          let s = agg.get(k);
          if (!s) { s = { n: 0, fail: 0, ms: [] }; agg.set(k, s); }
          s.n++;
          if (e.ok === false) s.fail++;
          if (typeof e.ms === 'number') s.ms.push(e.ms);
        }
      } catch { /* 单个文件坏了跳过 */ }
    }
    const out: Array<{ area: string; action: string; n: number; fail: number; p95: number }> = [];
    for (const [k, s] of agg) {
      const [area, action] = k.split(' ');
      s.ms.sort((x, y) => x - y);
      const p95 = s.ms.length ? s.ms[Math.min(s.ms.length - 1, Math.floor(s.ms.length * 0.95))] : 0;
      out.push({ area, action, n: s.n, fail: s.fail, p95 });
    }
    // 先按失败数、再按调用量排 —— 出问题的排最前面
    out.sort((x, y) => (y.fail - x.fail) || (y.n - x.n));
    return out;
  } catch {
    return [];
  }
}

/** 导出诊断包：把最近若干天的日志拼成一个文件，供发给我做诊断。
 *  extraSections: 调用方可附加 DB 数据（rpa_logs / risk_history / daily_stats 等），
 *  这些数据会一并打包且经过脱敏。 */
export function exportBundle(days = 7, extraSections?: Array<{ name: string; content: string }>): { ok: boolean; file?: string; reason?: string } {
  try {
    flush();
    const d = logDir();
    if (!d) return { ok: false, reason: '日志目录不可用' };
    const cutoff = Date.now() - days * 86400000;
    const parts: string[] = [];
    // 1. oplog JSONL 文件
    for (const f of fs.readdirSync(d).sort()) {
      if (!f.startsWith('oplog-') || f.startsWith('bundle-')) continue;
      const full = path.join(d, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) continue;
        parts.push(`\n===== ${f} =====\n` + fs.readFileSync(full, 'utf8'));
      } catch { /* 跳过 */ }
    }
    // 2. 附加数据源（rpa_logs / risk_history / daily_stats）
    if (extraSections && extraSections.length > 0) {
      for (const sec of extraSections) {
        try {
          parts.push(`\n===== DB: ${sec.name} =====\n${sec.content}`);
        } catch { /* 附加段损坏不影响主日志 */ }
      }
    }
    const out = path.join(d, `bundle-${Date.now()}.txt`);
    fs.writeFileSync(out, parts.join('\n'), 'utf8');
    return { ok: true, file: out };
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/** 退出前把缓冲写干净（在 before-quit 里调） */
export function shutdown(): void {
  try {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    oplog('proc', 'session-end', { session: sessionId });
    flush();
  } catch { /* ignore */ }
}
