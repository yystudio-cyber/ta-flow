// 飞书需求汇总 —— 本地 HTTP 桥
//
// 与 jd-bridge.ts 同形态但独立端口（17386）：
//   · 只监听 127.0.0.1
//   · CORS 只放行 feishu-req-sheet-sync 扩展的固定 ID
//   · 不对局域网/Internet 暴露
//
// 端点：
//   GET  /reqsheet/run-token  → { run, runId, knownReqIds, config }
//   POST /reqsheet/rows       → { runId, rows, stats } → WriteResult
//   POST /reqsheet/state      → { runId, state, ... }  → { ok }
import http from 'http';
import type { AddressInfo } from 'net';
import { appendRowsToSheet, readKnownReqIds, getPendingCount, getTargetXlsxPath } from './req-sheet-writer';
import { oplog } from './oplog';

// feishu-req-sheet-sync 扩展的固定 ID（manifest.json 的 key 决定）
export const REQSHEET_EXTENSION_ID = 'oiocdcoifinkpjeikjkmhnlfgcofeebi';
const ALLOWED_ORIGIN = `chrome-extension://${REQSHEET_EXTENSION_ID}`;
export const REQSHEET_BRIDGE_PORT = 17386;

const MAX_BODY = 2 * 1024 * 1024;   // 2MB 请求体上限

let server: http.Server | null = null;

// 当前活跃 run token（主进程侧设置，扩展侧轮询取）
interface RunToken {
  runId: string;
  knownReqIds: string[];
  config: Record<string, any>;
  createdAt: number;
  consumed: boolean;
}
let activeToken: RunToken | null = null;

// 最近一次扫描状态（供 UI 查询）
let lastState = '';
let lastStateAt = 0;

export function setRunToken(token: Omit<RunToken, 'consumed' | 'createdAt'>): void {
  activeToken = { ...token, createdAt: Date.now(), consumed: false };
}

export function clearRunToken(): void {
  activeToken = null;
}

export function getLastState(): { state: string; at: number } {
  return { state: lastState, at: lastStateAt };
}

export function startReqsheetBridge(): void {
  if (server) return;

  server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (e: any) {
      console.warn('[reqsheet-bridge] 请求处理异常：', e?.message || e);
      try { res.writeHead(500).end('Internal Error'); } catch { /* ignore */ }
    }
  });

  server.on('error', (e: any) => {
    console.warn('[reqsheet-bridge] 启动失败：', e?.message || e);
    server = null;
  });

  server.listen(REQSHEET_BRIDGE_PORT, '127.0.0.1', () => {
    const a = server?.address() as AddressInfo | null;
    console.log('[reqsheet-bridge] 已启动 http://127.0.0.1:' + (a?.port ?? REQSHEET_BRIDGE_PORT));
  });
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin || '';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  // Host 白名单（DNS rebinding 防护）
  const host = String(req.headers.host || '');
  const hostOk = host === `127.0.0.1:${REQSHEET_BRIDGE_PORT}` || host === `localhost:${REQSHEET_BRIDGE_PORT}`;
  if (!hostOk) { res.writeHead(403).end('Forbidden'); return; }

  // CORS
  const isAllowedOrigin = origin === ALLOWED_ORIGIN;
  if (origin && !isAllowedOrigin) { res.writeHead(403).end('Forbidden'); return; }
  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '3600');
  }

  if (req.method === 'OPTIONS') { res.writeHead(isAllowedOrigin ? 204 : 403).end(); return; }

  const [url] = (req.url || '').split('?');

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /reqsheet/run-token
  if (url === '/reqsheet/run-token' && req.method === 'GET') {
    if (!activeToken || activeToken.consumed) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ run: false }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      run: true,
      runId: activeToken.runId,
      knownReqIds: activeToken.knownReqIds,
      config: activeToken.config,
    }));
    activeToken.consumed = true;
    return;
  }

  // POST /reqsheet/rows  or  POST /reqsheet/state
  if (req.method === 'POST' && (url === '/reqsheet/rows' || url === '/reqsheet/state')) {
    // POST 端点强制校验 Origin（写操作不允许空 Origin）
    if (origin !== ALLOWED_ORIGIN) { res.writeHead(403).end('Forbidden: origin required'); return; }

    const cl = parseInt(String(req.headers['content-length'] || '0'), 10);
    if (cl > MAX_BODY) { res.writeHead(413).end('Payload too large'); req.resume(); return; }

    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (b: Buffer) => {
      total += b.length;
      if (total > MAX_BODY) { tooLarge = true; req.destroy(); return; }
      chunks.push(b);
    });
    req.on('end', async () => {
      try {
        if (tooLarge) { res.writeHead(413).end('Payload too large'); return; }
        const body = Buffer.concat(chunks).toString('utf-8');
        let data: any;
        try { data = JSON.parse(body); } catch { res.writeHead(400).end('Invalid JSON'); return; }

        if (!data.runId) { res.writeHead(400).end('Missing runId'); return; }

        if (url === '/reqsheet/state') {
          lastState = String(data.state || '');
          lastStateAt = Date.now();
          oplog('reqsheet', 'ext-state', { runId: data.runId, state: lastState });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // /reqsheet/rows
        const rows = Array.isArray(data.rows) ? data.rows : [];
        oplog('reqsheet', 'rows-received', { runId: data.runId, count: rows.length });
        const result = await appendRowsToSheet(rows);
        const pending = getPendingCount();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...result, pending }));
      } catch (e: any) {
        oplog('reqsheet', 'bridge-rows-error', { reason: e?.message }, { ok: false });
        try { res.writeHead(500).end('Server error: ' + String(e?.message || e)); } catch { /* ignore */ }
      }
    });
    req.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    return;
  }

  if (req.method === 'GET') res.writeHead(404).end();
  else res.writeHead(405).end();
}

export function stopReqsheetBridge(): void {
  try { server?.close(); } catch { /* ignore */ }
  server = null;
}

export function reqsheetBridgeRunning(): boolean {
  return !!server && server.listening;
}
