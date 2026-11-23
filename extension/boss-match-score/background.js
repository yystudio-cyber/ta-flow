// TA 匹配分助手 · 后台 service worker
//
// 职责：
//   1. 每分钟从【本机平台】拉取当前激活岗位(JD)+JD 列表，写 chrome.storage.local 供 content script 用；
//   2. 接收 options 页"采样当前页面结构"请求，让 BOSS 页面的 content script 采样 DOM，
//      然后 POST 到本机平台落盘（供适配新卡片形态）。
//
// 为什么不用 chrome.tabs.sendMessage 主动推送 JD：
//   带 url 过滤的 chrome.tabs.query 需要 "tabs" 权限或 zhipin.com 的 host 权限，
//   这两个本扩展都不要（多一份权限就多一份解释成本）。写 storage 后 content script
//   的 chrome.storage.onChanged 会收到变更，效果一样且零额外权限。
//
// 风险边界（勿改）：
//   · 本扩展【绝不向 zhipin.com 发任何请求】。
//   · 唯一网络目标是 http://127.0.0.1:17385（本机回环），
//     manifest.host_permissions 限死这个来源。
//   · 采样请求【只在用户点按钮时】发一次，不常驻、不轮询。

const BRIDGE_BASE = 'http://127.0.0.1:17385';
const CACHE_KEY = 'ta-jd-cache';
const SYNC_ALARM = 'ta-jd-sync';
const MIN_SYNC_GAP_MS = 8000;   // 两次主动拉取的最小间隔，防止多个 BOSS 标签页同时开时打连发

// BOSS 页面心跳：content script 只在 BOSS 页面上跑，它说话就代表 BOSS 开着。
// service worker 会被浏览器随时休眠，这些变量丢了不要紧——下一次心跳（15 秒）就补回来。
let bossAliveAt = 0;
let bossCards = 0;
let lastCardsAt = 0;   // 最近一次「报上来的卡片数 > 0」的时刻
let lastSyncAt = 0;

async function syncJd() {
  lastSyncAt = Date.now();
  try {
    // 把 BOSS 页面状态捎给平台：平台据此决定工具库里那个按钮显示"打开 BOSS"还是"运行中"。
    // 仍然只发本机回环这一个请求，没有新增任何对外请求。
    const aliveSec = bossAliveAt ? Math.round((Date.now() - bossAliveAt) / 1000) : -1;
    // v=当前清单版本：平台据此发现「Chrome 里跑的是旧版（改完没点刷新）」并明确提示。
    // 这是"装好了却不出分"这一整类故障的自诊断通道——manifest 改动必须手动刷新才生效，
    // 而弹窗页每次都从磁盘现读，两边看起来都"正常"，没有版本指纹根本对不出来。
    const v = encodeURIComponent((chrome.runtime.getManifest() || {}).version || '');
    const q = `?bossAgo=${aliveSec}&cards=${bossCards}&v=${v}`;
    const res = await fetch(`${BRIDGE_BASE}/jd/active${q}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await chrome.storage.local.set({ [CACHE_KEY]: { ...data, fetchedAt: Date.now(), online: true } });
    return { ok: true, data };
  } catch (e) {
    // 平台没开：保留上次缓存继续打分，只把 online 标成 false（选项页据此显示"平台未运行"）
    const cur = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    if (cur) {
      await chrome.storage.local.set({
        [CACHE_KEY]: { ...cur, online: false, lastError: String((e && e.message) || e) },
      });
    }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  syncJd();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  syncJd();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === SYNC_ALARM) syncJd();
});

// content script / 选项页主动索取
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'ta-boss-alive') {
    bossAliveAt = Date.now();
    // ⚠️ v2.1 起 content script 跑在【多个帧】里（顶层文档 + 推荐 iframe）。
    // 顶层永远报 0 张卡，真正有卡的是 iframe。若无脑取最后一条，计数会在 15 和 0 之间来回跳，
    // 平台侧的「运行中/这页有 N 张卡」就成了随机数。
    // 规则：有卡的报数优先；只有当"连续 25 秒没有任何帧报出过卡"时，才允许把它归零
    //（那才是真的翻到了没有卡的页面，而不是顶层帧插了一嘴）。
    const n = Number(msg.cards) || 0;
    if (n > 0) { bossCards = n; lastCardsAt = Date.now(); }
    else if (Date.now() - lastCardsAt > 25000) bossCards = 0;
    // 只有"页面刚开 / 刚切回来"（first）才顺手拉一次最新岗位——平台那个
    // 「打开 BOSS 推荐牛人页」按钮点下去就是开新标签页，走的正是这条路，
    // 用户点完立刻看到最新的分，不用干等一分钟的定时同步。
    // 普通心跳绝不能触发拉取：心跳 15 秒一次，那样会把同步频率放大好几倍。
    // gap 只用来防"多个 BOSS 标签页同时开"时的连发。
    if (msg.first && Date.now() - lastSyncAt > MIN_SYNC_GAP_MS) syncJd();
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'ta-get-jd') {
    chrome.storage.local.get(CACHE_KEY).then((r) => sendResponse(r[CACHE_KEY] || null));
    return true;
  }
  if (msg && msg.type === 'ta-sync-now') {
    syncJd().then(sendResponse);
    return true;
  }
  // 采样当前页面结构：options 页按钮 → 这里 → content script 采样 → POST 平台落盘。
  // 不常驻，点一次做一次；不发任何 zhipin 请求；唯一网络目标是本机回环。
  if (msg && msg.type === 'ta-start-sample') {
    (async () => {
      try {
        // 找当前窗口的活动 tab（不需要 tabs 权限，activeTab 默认就有）
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) { sendResponse({ ok: false, error: '找不到活动标签页' }); return; }
        if (!/^https?:\/\/([^/]+\.)?zhipin\.com\//.test(tab.url || '')) {
          sendResponse({ ok: false, error: '当前标签页不是 zhipin.com，请到 BOSS 页面再采' });
          return;
        }
        // frameId:0 = 主帧（顶层文档）。顶层 content script 的 samplePageStructure 会
        // 递归同源 iframe 的 contentDocument，一次采完所有帧，不需要向每帧单独发消息。
        const sample = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { type: 'ta-sample-page' }, { frameId: 0 }, (resp) => {
            if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
            else resolve(resp || null);
          });
        });
        if (!sample) { sendResponse({ ok: false, error: 'content script 未响应（刷新 BOSS 页面试试）' }); return; }
        if (sample.error) { sendResponse({ ok: false, error: '采样失败：' + sample.error }); return; }
        if (sample.ignored) { sendResponse({ ok: false, error: '收到非顶层响应，重试一次' }); return; }
        // POST 到本机平台
        const body = JSON.stringify(sample.data || sample);
        const res = await fetch(`${BRIDGE_BASE}/structure/sample`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          sendResponse({ ok: false, error: `平台返回 HTTP ${res.status}：${txt.slice(0, 200)}` });
          return;
        }
        const info = await res.json().catch(() => ({}));
        sendResponse({ ok: true, sizeKb: sample.sizeKb, truncated: !!sample.truncated, saved: info });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // 异步响应
  }
  return false;
});
