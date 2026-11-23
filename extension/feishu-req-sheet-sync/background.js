/**
 * feishu-req-sheet-sync  background (service worker)
 *
 * 职责：
 *   · 持有 runId + knownReqIds（从 GET /reqsheet/run-token 取）
 *   · 通过 chrome.tabs 向 content script 发送指令（startScan / getState）
 *   · 接收 content script 上报的 state 变化，转发到 POST /reqsheet/state
 *   · 接收 content script 送来的 rows，转发到 POST /reqsheet/rows
 *
 * 安全边界：
 *   · 桥只监听 127.0.0.1，CORS 只放行此扩展 ID（主进程侧保证）
 *   · 不存储任何 PII，rows 转发后立即丢弃
 */

const BRIDGE_BASE = 'http://127.0.0.1:17386';
const HIRE_ORIGIN = /^https:\/\/(acme|[a-z0-9]+)\.feishu\.cn\/hire/;

let currentRun = null;  // { runId, knownReqIds: Set, tabId }

// ── 取 run token（主进程发起手动触发或定时触发后调用） ──────────────────────

async function fetchRunToken() {
  try {
    const r = await fetch(BRIDGE_BASE + '/reqsheet/run-token');
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[reqsheet-bg] fetchRunToken failed:', e.message);
    return null;
  }
}

// ── 上报状态 ────────────────────────────────────────────────────────────────

async function postState(state, extra) {
  if (!currentRun) return;
  try {
    await fetch(BRIDGE_BASE + '/reqsheet/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: currentRun.runId, state, ...extra }),
    });
  } catch (e) { /* 网络闪断不影响主流程 */ }
}

// ── 接收 rows，转发到主进程 ─────────────────────────────────────────────────

async function postRows(rows, stats) {
  if (!currentRun) return null;
  try {
    const r = await fetch(BRIDGE_BASE + '/reqsheet/rows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: currentRun.runId, rows, stats }),
    });
    if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
    return await r.json();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ── 向 content script 发送消息 ──────────────────────────────────────────────

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    console.warn('[reqsheet-bg] sendToTab error:', e.message);
    return null;
  }
}

// ── 启动一轮扫描 ─────────────────────────────────────────────────────────────

async function startRun() {
  const token = await fetchRunToken();
  if (!token || !token.run) {
    console.log('[reqsheet-bg] no active run token, skip');
    return;
  }

  currentRun = {
    runId: token.runId,
    knownReqIds: new Set(token.knownReqIds || []),
    config: token.config || {},
  };

  // 找到已打开的飞书招聘 tab（主进程会先 openInDailyChrome）
  let targetTab = null;
  const tabs = await chrome.tabs.query({ url: 'https://*.feishu.cn/hire/*' });
  for (const t of tabs) {
    if (t.url && HIRE_ORIGIN.test(t.url)) { targetTab = t; break; }
  }

  if (!targetTab) {
    // Chrome 可能刚启动，轮询等待最多 20 次 × 3s
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const ts = await chrome.tabs.query({ url: 'https://*.feishu.cn/hire/*' });
      for (const t of ts) {
        if (t.url && HIRE_ORIGIN.test(t.url)) { targetTab = t; break; }
      }
      if (targetTab) break;
    }
  }

  if (!targetTab) {
    await postState('error', { msg: '未找到飞书招聘标签页' });
    currentRun = null;
    return;
  }

  currentRun.tabId = targetTab.id;
  await sendToTab(targetTab.id, {
    type: 'REQSHEET_START',
    runId: currentRun.runId,
    knownReqIds: [...currentRun.knownReqIds],
    config: currentRun.config,
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 接收 content script 消息 ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'REQSHEET_STATE') {
    postState(msg.state, msg.extra || {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'REQSHEET_ROWS') {
    postRows(msg.rows, msg.stats).then(report => {
      sendResponse({ ok: true, report });
    });
    return true;  // async
  }

  if (msg.type === 'REQSHEET_DONE') {
    postState('done', { report: msg.report });
    currentRun = null;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'REQSHEET_ERROR') {
    postState('error', { msg: msg.msg });
    currentRun = null;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ── 主进程通过 chrome.runtime.sendMessage 触发手动运行 ─────────────────────
// （实际路径：主进程 IPC → 桥端点 POST /reqsheet/trigger → 本扩展轮询检测）
// 本扩展每 60s 轮询一次 run-token，拿到 run=true 就启动
setInterval(async () => {
  if (currentRun) return;  // 已在跑，不重入
  const token = await fetchRunToken();
  if (token && token.run) {
    await startRun();
  }
}, 60000);

// 立即检查一次（扩展刚加载时）
(async () => {
  const token = await fetchRunToken();
  if (token && token.run) await startRun();
})();
