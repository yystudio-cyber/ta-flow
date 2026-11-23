// JD 桥 —— 给「TA 匹配分助手」浏览器扩展提供当前激活岗位
//
// 为什么需要它：人工 sourcing 时 HR 用的是自己日常的 Chrome，扩展读不到平台的 SQLite。
// 手动粘贴 JD 太麻烦（换岗位就得重来一次），所以平台起一个【只监听 127.0.0.1】的极小服务，
// 扩展后台每分钟拉一次，换岗位后自动生效。
//
// 安全边界：
//   · 只 listen 在 127.0.0.1，不对局域网暴露；
//   · CORS 只放行【固定 ID 的那一个扩展】（manifest 里 pin 了公钥，ID 恒定），
//     网页 origin 一律不放行——否则任意网页都能读你的 JD；
//   · GET 只吐岗位与评分配置；POST /structure/sample 写盘前已对候选人文本字段脱敏；
//     不存储原始姓名/手机/邮箱等 PII（对齐登记册 R2）。
import http from 'http';
import path from 'path';
import fs from 'fs';
import type { AddressInfo } from 'net';
import { EventEmitter } from 'events';
import { getDb, getSetting } from '../db';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { AppSettings } from '../../shared/types';

// 与 extension/boss-match-score/manifest.json 的 key 对应的固定扩展 ID。
// 改扩展的 key 就必须同步改这里，否则 CORS 会把它挡掉。
export const EXTENSION_ID = 'hhjilkjdngolnidebdlmkkhpoidegbgc';
const ALLOWED_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const JD_BRIDGE_PORT = 17385;

const MAX_SAMPLE_BODY = 512 * 1024;  // 采样请求体上限 512KB
const SAMPLE_RETENTION = 20;        // 内存里保留最近 20 份采样信息
export const MAX_SAMPLE_FILES = 200;        // 落盘文件上限（超出后删最旧的）—— contract-check 锁定值 200
export const MAX_SAMPLE_DIR_MB = 50;        // 落盘目录总大小上限（MB）—— contract-check 锁定值 50

let server: http.Server | null = null;
let diagnosticsDir: string | null = null;
// 扩展最近一次成功取到 JD 的时刻——这是平台侧唯一能拿到的"扩展是否真的装好并在跑"的信号
// （平台无法查询 Chrome 已装扩展列表，除非去 attach 调试端口，而那正是本方案要避免的）。
let lastPolledAt = 0;
// BOSS 页面状态：扩展的 content script 只在 BOSS 页面上跑，它上报了就代表页面开着。
// 平台据此把工具库的按钮分成「打开 BOSS」和「运行中」两种形态。
let lastBossAliveAt = 0;
let lastBossCards = 0;
// Chrome 里实际在跑的扩展版本（同步请求 ?v= 捎带）。与磁盘 manifest 版本不一致
// 就说明用户改完代码没在 chrome://extensions 点刷新——"装好了却不出分"的头号根因。
let lastExtVersion: string | null = null;

// 最近收到的页面结构采样（供 IPC 查询 + 事件通知）
interface SampleRecord {
  id: string;
  at: number;
  url: string;
  file: string;      // 落盘文件相对路径（相对 diagnosticsDir）
  sizeKb: number;
  truncated: boolean;
  cardCount: number;
}
const recentSamples: SampleRecord[] = [];
export const bridgeEvents = new EventEmitter();

function readActiveJd(): any | null {
  try {
    const row = getDb().prepare('SELECT data FROM jds WHERE active = 1 LIMIT 1').get() as any;
    return row ? JSON.parse(row.data) : null;
  } catch {
    return null;
  }
}

/**
 * 返回所有 JD 的【完整】内容，供扩展做岗位自动识别 + 切岗位后就地重新评分。
 *
 * 这里必须是完整 JD，不能只给 id/name/title：扩展在用户切换岗位后，直接拿列表里的
 * 这一项当 JD 交给评分引擎。只给精简字段的话 basic/keywords 全是空的，引擎会给每个
 * 候选人打出一模一样的默认分——照样出分、照样好看，但分是假的，比不出分更坑。
 *
 * PII 边界不变：JD 是用户自己写的岗位要求，不含任何候选人信息。
 */
function readJdList(): any[] {
  try {
    const rows = getDb().prepare('SELECT id, name, data FROM jds').all() as any[];
    const list: any[] = [];
    for (const row of rows) {
      try {
        const d = JSON.parse(row.data);
        list.push({
          ...d,
          id: d.id || row.id,
          name: d.name || row.name || '',
          title: d.title || '',
          bossJobId: d.bossJobId || d.basic?.bossJobId || undefined,
        });
      } catch { /* 跳过损坏记录 */ }
    }
    return list;
  } catch {
    return [];
  }
}

/**
 * 组装下发给扩展的 payload。
 *
 * 导出是为了让 scripts/jd-bridge-lab.mjs 直接测【这一份实现】——链路断言（domain/tasks
 * 必须完整下桥）如果测的是复刻逻辑，源码改了测试不会跟，等于没测。
 *
 * ⚠️ jd 与 jdList 都是【整份 JD 原样透传】。不要改成挑字段下发：
 * 一旦挑字段，将来在岗位库里新增的评分字段就会默默地"平台算得到、插件算不到"，
 * 表现为同一个人在 App 里和插件徽章上分数不一样，而且没有任何报错。
 */
export function buildPayload() {
  const jd = readActiveJd();
  const s = getSetting<AppSettings>('app-settings', DEFAULT_SETTINGS);
  return {
    jd,                                   // 岗位本身（用户自己写的，不含任何候选人信息）
    jdList: readJdList(),                 // 所有 JD（含各自的 weights，用于岗位自动识别与切换）
    // ⚠️ weights 与 defaultWeights 必须分开下发。
    // 原来只有一个 weights，取值是「激活 JD 的私有权重 || 设置页默认权重」，
    // 而插件侧把它当成「设置页默认权重」，回填给 jdList 里任何没配权重的 JD。
    // 后果：激活岗位 A 配了自定义权重时，用户在插件菜单切到没配权重的岗位 B，
    // B 会用上 A 的权重打分，而平台侧 B 用的是默认权重——两边分数对不上。
    weights: jd?.weights || s.matchScore?.defaultWeights || null, // 兼容旧版插件，勿删
    defaultWeights: s.matchScore?.defaultWeights || null,         // 纯默认权重，插件回填只认这个
    thresholds: {
      high: s.matchScore?.highThreshold ?? 75,
      low: s.matchScore?.lowThreshold ?? 60,
    },
    serverTime: Date.now(),
  };
}

export function startJdBridge(opts?: { diagnosticsDir?: string }): void {
  if (server) return;
  if (opts?.diagnosticsDir) {
    diagnosticsDir = opts.diagnosticsDir;
    try { fs.mkdirSync(diagnosticsDir, { recursive: true }); } catch { /* 建目录失败忽略，落盘时再处理 */ }
  }
  // 整个回调包一层（隔离改造 2026-07-29）：node http 回调里的同步异常会变成
  // uncaughtException——在没有进程级兜底的年代，这条支线曾能把整个主进程杀掉。
  // buildPayload → getSetting 底层抛错就是现实入口。这里就地 500，绝不外溢。
  server = http.createServer((req, res) => {
    try {
      handleBridgeRequest(req, res);
    } catch (e: any) {
      console.warn('[jd-bridge] 请求处理异常（已隔离）：', e?.message || e);
      try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal Error'); } catch { /* 响应已损坏则放弃 */ }
    }
  });

  server.on('error', (e: any) => {
    // 端口被占等情况：不影响平台主体功能，只是扩展拿不到 JD（它会退回上次缓存）
    console.warn('[jd-bridge] 启动失败：', e?.message || e);
    server = null;
  });

  // 只绑回环地址
  server.listen(JD_BRIDGE_PORT, '127.0.0.1', () => {
    const a = server?.address() as AddressInfo | null;
    console.log('[jd-bridge] 已启动 http://127.0.0.1:' + (a?.port ?? JD_BRIDGE_PORT));
  });
}

function handleBridgeRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  {
    const origin = req.headers.origin || '';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');

    // Host 白名单：防 DNS rebinding。
    // 原来的防护完全靠 Origin，但 rebinding 之后是【同源 GET】，根本不带 Origin 头，
    // 下面 `if (origin && !isAllowedOrigin)` 就会放行并把响应交出去。
    // 这里泄露面只有 JD/权重/阈值（无候选人 PII），但把门关严成本极低。
    const host = String(req.headers.host || '');
    const hostOk = host === `127.0.0.1:${JD_BRIDGE_PORT}` || host === `localhost:${JD_BRIDGE_PORT}`;
    if (!hostOk) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // CORS 严格校验：非白名单 origin 一律 403（包括 OPTIONS 预检）
    const isAllowedOrigin = origin === ALLOWED_ORIGIN;
    if (origin && !isAllowedOrigin) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    if (isAllowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '3600');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(isAllowedOrigin ? 204 : 403);
      res.end();
      return;
    }

    const [url, rawQuery] = (req.url || '').split('?');

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === '/jd/active') {
      if (origin && origin !== ALLOWED_ORIGIN) { res.writeHead(403).end(); return; }
      lastPolledAt = Date.now();
      // 扩展捎带上来的 BOSS 页面状态：bossAgo = 距最近一次心跳多少秒（-1 表示没开）
      try {
        const qs = new URLSearchParams(rawQuery || '');
        const ago = Number(qs.get('bossAgo'));
        if (Number.isFinite(ago) && ago >= 0) {
          lastBossAliveAt = Date.now() - ago * 1000;
          const cards = Number(qs.get('cards'));
          lastBossCards = Number.isFinite(cards) && cards >= 0 ? cards : 0;
        }
        const v = (qs.get('v') || '').trim();
        // 只收形如 2.3.0 的版本串，防脏数据进 UI
        if (/^\d+(\.\d+){0,3}$/.test(v)) lastExtVersion = v;
      } catch { /* query 坏了不影响主流程 */ }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(buildPayload()));
      return;
    }
    // POST /structure/sample — 扩展采回的 DOM 结构采样（供适配新页面）。
    // 只有 GET 默认 405，POST 仅允许此路径。
    if (url === '/structure/sample') {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      // A1: POST 写磁盘，Origin 必须【强制校验】——空 Origin（curl / 本机任意进程）也拒绝。
      // GET 可以不带 Origin（DNS rebinding 防护由 Host 白名单兜底，只读无损失），
      // 但写文件操作必须严格：没有 chrome-extension:// Origin 就是非扩展来源，一律 403。
      // 浏览器扩展的 fetch 一定带 chrome-extension://<id> Origin，不会误拦正常采样请求。
      if (origin !== ALLOWED_ORIGIN) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden: origin required'); return; }
      // 只接受 127.0.0.1（Host 白名单已校验），Content-Type 必须为 application/json，
      // 大小上限 512KB——超了直接 413。
      if (req.headers['content-type'] && !/^application\/json/i.test(req.headers['content-type'])) {
        res.writeHead(415, { 'Content-Type': 'text/plain' }).end('Content-Type must be application/json');
        return;
      }
      const cl = parseInt(String(req.headers['content-length'] || '0'), 10);
      if (cl > MAX_SAMPLE_BODY) {
        res.writeHead(413, { 'Content-Type': 'text/plain' }).end('Payload too large (max 512KB)');
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      req.on('data', (b: Buffer) => {
        total += b.length;
        if (total > MAX_SAMPLE_BODY) { tooLarge = true; req.destroy(); return; }
        chunks.push(b);
      });
      req.on('end', () => {
        try {
          if (tooLarge) { res.writeHead(413).end('Payload too large'); return; }
          const body = Buffer.concat(chunks).toString('utf-8');
          let data: any;
          try { data = JSON.parse(body); } catch (e) { res.writeHead(400).end('Invalid JSON'); return; }
          const rec = saveStructureSample(data);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...rec }));
        } catch (e: any) {
          console.warn('[jd-bridge] 保存采样失败：', e?.message || e);
          try { res.writeHead(500).end('Save failed: ' + String(e?.message || e)); } catch {}
        }
      });
      req.on('error', () => { try { res.destroy(); } catch {} });
      return;
    }
    // 不认识的路径 / 方法不对：404 或 405
    if (req.method === 'GET') res.writeHead(404).end();
    else res.writeHead(405).end();
  }
}

/**
 * B4: 对 candidateCards 的文本字段脱敏。
 * 姓名/公司/职位在 DB 中是 AES 加密且有保留期，diagnostics/ 目录此前三样都不占。
 * 结构诊断只需要 tag/class/层级信息，不需要人名——脱敏后保留 DOM 结构即可。
 */
function sanitizeCards(data: any): any {
  if (!data) return data;
  try {
    const s = JSON.stringify(data);
    // 对候选人名字段做替换（不改变 JSON 结构）
    const sanitized = s
      .replace(/"(?:name|姓名|geekName|liepinName|candidateName|candidate_name|ename|cname)"\s*:\s*"[^"]*"/gi, (m) => {
        const key = m.split(':')[0];
        return `${key}: "***"`;
      })
      .replace(/"(?:company|公司|companyName|currentCompany|current_company|lastCompany)"\s*:\s*"[^"]*"/gi, (m) => {
        const key = m.split(':')[0];
        return `${key}: "***"`;
      })
      .replace(/"(?:title|职位|position|jobTitle|job_title|applyJob|apply_job)"\s*:\s*"[^"]*"/gi, (m) => {
        const key = m.split(':')[0];
        return `${key}: "***"`;
      })
      .replace(/"(?:phone|mobile|email|idcard|电话|手机|邮箱)"\s*:\s*"[^"]*"/gi, (m) => {
        const key = m.split(':')[0];
        return `${key}: "***"`;
      });
    return JSON.parse(sanitized);
  } catch {
    return data; // 脱敏失败保留原始（结构诊断优先于隐私——但这种情况极罕见）
  }
}

function saveStructureSample(data: any): SampleRecord {
  const ts = Date.now();
  const id = `page-structure-${ts}.json`;
  let file = id;
  let wrote = false;
  if (diagnosticsDir) {
    try {
      fs.mkdirSync(diagnosticsDir, { recursive: true });
      const full = path.join(diagnosticsDir, id);
      // B4: 落盘前脱敏，只保留 DOM 结构信息
      fs.writeFileSync(full, JSON.stringify(sanitizeCards(data), null, 2), 'utf-8');
      file = id;
      wrote = true;
    } catch (e: any) {
      console.warn('[jd-bridge] 采样落盘失败：', e?.message || e);
    }
  }
  const pageUrl = (data && typeof data.url === 'string') ? data.url : '';
  const truncated = !!(data && data._note);
  let cardCount = 0;
  try {
    if (data && Array.isArray(data.candidateCards)) cardCount = data.candidateCards.length;
    else if (data && data.frames) {
      for (const fr of data.frames) if (fr && Array.isArray(fr.candidateCards)) cardCount += fr.candidateCards.length;
    }
  } catch {}
  const rec: SampleRecord = {
    id,
    at: ts,
    url: pageUrl.slice(0, 200),
    file,
    sizeKb: Math.round(Buffer.byteLength(JSON.stringify(data), 'utf-8') / 1024),
    truncated,
    cardCount,
  };
  recentSamples.unshift(rec);
  while (recentSamples.length > SAMPLE_RETENTION) recentSamples.pop();
  bridgeEvents.emit('sample', rec);
  if (wrote) {
    console.log(`[jd-bridge] 收到页面结构采样：${pageUrl.slice(0, 80)} → ${file} (${rec.sizeKb}KB, ${cardCount} 张卡片)`);
    // A3: 写盘后立即检查容量，超限则删最旧的文件，防止无限堆积
    purgeSampleDir(diagnosticsDir!);
  } else {
    console.warn('[jd-bridge] diagnosticsDir 未配置，采样未落盘');
  }
  return rec;
}

/**
 * A3: 落盘清理——超过 MAX_SAMPLE_FILES 份或总大小超过 MAX_SAMPLE_DIR_MB MB 时删除最旧的文件。
 * 只处理 page-structure-*.json 格式的采样文件，不删其它文件。
 * 失败静默（不影响正常流程）。
 * 导出供 scripts/jd-bridge-lab.mjs 真源码测试——测的就是这一份实现，不要复制逻辑。
 */
export function purgeSampleDir(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^page-structure-\d+\.json$/.test(f))
      .map((f) => {
        try {
          const p = path.join(dir, f);
          const size = fs.statSync(p).size;
          const ts = parseInt(f.replace('page-structure-', '').replace('.json', ''), 10) || 0;
          return { f, p, size, ts };
        } catch { return null; }
      })
      .filter(Boolean) as Array<{ f: string; p: string; size: number; ts: number }>;

    // 按时间戳升序（最旧的在前）
    files.sort((a, b) => a.ts - b.ts);

    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    const totalMB = totalBytes / (1024 * 1024);
    let removed = 0;

    // 超限时从最旧的删起，直到同时满足两个上限
    while (files.length > 0 && (files.length > MAX_SAMPLE_FILES || (files.reduce((s, f) => s + f.size, 0) / (1024 * 1024)) > MAX_SAMPLE_DIR_MB)) {
      const oldest = files.shift()!;
      try { fs.unlinkSync(oldest.p); removed++; } catch { /* 删失败继续下一个 */ }
    }

    if (removed > 0) {
      console.log(`[jd-bridge] 采样清理：删除 ${removed} 份旧文件（原 ${files.length + removed} 份, ${totalMB.toFixed(1)}MB）`);
    }
  } catch (e: any) {
    console.warn('[jd-bridge] 采样目录清理失败（已忽略）：', e?.message || e);
  }
}

export function stopJdBridge(): void {
  try { server?.close(); } catch { /* ignore */ }
  server = null;
}

export function jdBridgeRunning(): boolean {
  return !!server && server.listening;
}

/** 供工具库展示：桥是否在跑 + 扩展最近一次来取岗位的时间（据此判断扩展是否真的装好了）。 */
export function jdBridgeStatus(): {
  running: boolean;
  port: number;
  extensionId: string;
  lastPolledAt: number;
  extensionSeen: boolean; // 5 分钟内被取过 = 扩展在线（后台每分钟拉一次）
  activeJdName: string | null;
  bossOpen: boolean;      // BOSS 页面是否开着（心跳 15 秒一次，给 90 秒宽限）
  bossCards: number;      // 当前那页有多少张候选人卡片
  lastBossAliveAt: number;
  extVersion: string | null; // Chrome 里实际在跑的扩展版本（null = 旧版扩展未上报）
} {
  let activeJdName: string | null = null;
  try {
    const jd = readActiveJd();
    activeJdName = jd ? (jd.name || jd.title || null) : null;
  } catch { /* ignore */ }
  return {
    running: jdBridgeRunning(),
    port: JD_BRIDGE_PORT,
    extensionId: EXTENSION_ID,
    lastPolledAt,
    extensionSeen: lastPolledAt > 0 && Date.now() - lastPolledAt < 5 * 60 * 1000,
    activeJdName,
    // 宽限期取 90 秒：心跳 15 秒一次，但扩展的 service worker 会被浏览器休眠，
    // 状态要等下一次拉取（最长 1 分钟）才捎上来，给太短会闪成"没开"。
    bossOpen: lastBossAliveAt > 0 && Date.now() - lastBossAliveAt < 90 * 1000,
    bossCards: lastBossCards,
    lastBossAliveAt,
    extVersion: lastExtVersion,
  };
}

/** 供工具库 UI 查询最近的采样记录（渲染层轮询或事件通知）。 */
export function getRecentSamples(): SampleRecord[] {
  return recentSamples.slice();
}

/** 在系统文件管理器里打开 diagnostics 目录，方便用户查看采样文件。 */
export function getDiagnosticsDir(): string | null {
  return diagnosticsDir;
}
