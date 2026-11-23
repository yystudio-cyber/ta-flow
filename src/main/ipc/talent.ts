// G2/G3: 岗位收件箱（飞书快照工具推送）+ 人才库（RPA 抓取的候选人）+ 外链打开
// 安全要点：
//  - jr-push 载荷字段白名单 + 单字段限长，入库前按 uniq_key 去重（INSERT OR IGNORE）；
//  - OPEN_EXTERNAL 只放行 http/https，其余协议一律拒绝（防 file:// / 自定义协议提权）；
//  - candidates 查询走 getDb() 包装层，敏感列（name/url/note 等）自动解密。
import { BrowserWindow, shell } from 'electron';
import { handle } from './wrap';
import { IPC, JD, JrInboxItem, TalentCandidate, PLATFORMS, PlatformId, SpeedMode } from '../../shared/types';
import { getDb, listLiepinTalents, getLiepinTags, getLiepinTalentStats, getLiepinTagCounts,
  getLiepinScoresFor, listLiepinExpiring, addLiepinTag, removeLiepinTag,
  archiveLiepinTalents, deleteLiepinTalents, markLiepinDetailOpened } from '../db';
import { buildDetailUrl as liepinDetailUrl } from '../services/adapters/liepin';
import { uid, liepinDetailCap, getDefaultLimits } from '../../shared/utils';
import { getSetting } from '../db';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { toolsChromeManager } from '../cdp/chrome';
import { getRuntime } from '../services/runtime-registry';
import { DEFAULT_WEIGHTS } from '../../shared/constants';

const S = (v: any, max = 300): string => (v == null ? '' : String(v).slice(0, max));

function rowToInbox(r: any): JrInboxItem {
  return {
    id: r.id,
    receivedAt: r.received_at,
    source: r.source,
    title: r.title || '',
    dept: r.dept || '',
    city: r.city || '',
    status: r.status || '',
    raw: r.raw || '',
    state: r.state,
  };
}

function rowToCandidate(r: any): TalentCandidate {
  return {
    id: r.id,
    date: r.date || '',
    jdId: r.jd_id ?? null,
    name: r.name ?? null,
    position: r.position ?? null,
    company: r.company ?? null,
    city: r.city ?? null,
    experience: r.experience ?? null,
    degree: r.degree ?? null,
    salary: r.salary ?? null,
    score: typeof r.score === 'number' ? r.score : r.score != null ? Number(r.score) : null,
    url: r.url ?? null,
    greeted: !!r.greeted,
    favorited: !!r.favorited,
    viewed: !!r.viewed,
    note: r.note ?? null,
  };
}

// H2(阶段1):人才库查询必须按平台过滤。candidates_export 是双平台共表（带 platform 列），
// 不加 WHERE platform=? 时猎聘跑批写入的 liepin 行会混进 BOSS 人才库 / CSV 导出。
// 不传 platform 或传非法值时兜底 'boss'，保持老调用方行为不变。
function safePlatform(p: any): PlatformId {
  return (PLATFORMS as readonly string[]).includes(p) ? (p as PlatformId) : 'boss';
}

export function registerTalentHandlers(winGetter: () => BrowserWindow | null) {
  // ---------- G2: 快照工具 → 岗位收件箱 ----------
  // 'jr-push' 事件：来自隔离世界 binding 的岗位数据，白名单入库并通知渲染层。
  // 隔离改造 2026-07-29：工具注入迁到了独立的 toolsChromeManager，binding 与事件
  // 都从那个实例 emit——两个实例都订阅，JR 快照无论活在哪个浏览器里都不断流。
  const onJrPush = (payload: { source: string; items: any[]; url: string }) => {
    try {
      const stmt = getDb().prepare(
        'INSERT OR IGNORE INTO jr_inbox (received_at, source, uniq_key, title, dept, city, status, raw, state) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      const now = Date.now();
      let added = 0;
      for (const it of payload.items) {
        if (!it || typeof it !== 'object') continue;
        const title = S(it.title, 200);
        if (!title) continue;
        // 唯一键：source + 工具侧 id（缺省用 title+dept 兜底），重复推送不重复入库
        const key = `${S(payload.source, 64)}|${S(it.id, 200) || title + '|' + S(it.dept, 100)}`;
        const info = stmt.run(now, S(payload.source, 64), key, title, S(it.dept, 100), S(it.city, 100), S(it.status, 50), S(it.raw, 500), 'new');
        if (info.changes > 0) added++;
      }
      if (added > 0) {
        const win = winGetter();
        if (win) win.webContents.send(IPC.JR_INBOX_EVENT, { added });
      }
    } catch (e) {
      console.error('[jr-inbox] ingest error', e);
    }
  };
  getRuntime('boss').chrome.on('jr-push', onJrPush);
  toolsChromeManager.on('jr-push', onJrPush);

  handle(IPC.JR_INBOX_LIST, (_e, state?: string): JrInboxItem[] => {
    const rows = state
      ? getDb().prepare('SELECT * FROM jr_inbox WHERE state = ? ORDER BY id DESC').all(state)
      : getDb().prepare("SELECT * FROM jr_inbox WHERE state != 'dismissed' ORDER BY id DESC").all();
    return (rows as any[]).map(rowToInbox);
  });

  // 收件箱条目 → 正式 JD（最小字段起草，其余进岗位库后再编辑完善）
  handle(IPC.JR_INBOX_IMPORT, (_e, ids: number[]): number => {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const db = getDb();
    const get = db.prepare('SELECT * FROM jr_inbox WHERE id = ?');
    const mark = db.prepare("UPDATE jr_inbox SET state = 'imported' WHERE id = ?");
    const saveJd = db.prepare(
      'INSERT OR REPLACE INTO jds (id, name, data, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    let ok = 0;
    for (const id of ids.slice(0, 200)) {
      const r = get.get(Number(id)) as any;
      if (!r || r.state === 'imported') continue;
      const now = Date.now();
      const jd: JD = {
        id: uid('jd'),
        name: r.title,
        title: r.title,
        active: false,
        // ⚠️ 没有来源的字段一律写 undefined，绝不凭空填一个"看起来合理"的值（审查 2026-07-29）。
        // JR 快照入库列只有 title/dept/city/status/raw，根本没有学历/年限/薪资。
        // 原来硬写 degree:'本科' 的后果是【误杀真人】：JR 原文压根没提学历要求，
        // 大专候选人却被以确定口吻标成"岗位不符：大专，低于要求本科"，从此不再被复核。
        // 评分引擎本来就按 `!= null` 表达"未设置"，写 undefined 它会正确地整维弃权。
        basic: {
          experienceMin: undefined as any, experienceMax: undefined as any,
          degree: undefined as any, city: r.city || '',
          salaryMin: undefined as any, salaryMax: undefined as any,
        },
        keywords: { required: [], bonus: [], negative: [] },
        industry: { preferred: [], excluded: [] },
        companyTier: { prefer: [], avoid: [] },
        weights: { ...DEFAULT_WEIGHTS },
        createdAt: now,
        updatedAt: now,
      } as JD;
      saveJd.run(jd.id, jd.name, JSON.stringify(jd), 0, now, now);
      mark.run(r.id);
      ok++;
    }
    return ok;
  });

  handle(IPC.JR_INBOX_DISMISS, (_e, ids: number[]): number => {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const stmt = getDb().prepare("UPDATE jr_inbox SET state = 'dismissed' WHERE id = ?");
    let n = 0;
    for (const id of ids.slice(0, 500)) n += stmt.run(Number(id)).changes;
    return n;
  });

  // ---------- G3: 人才库 ----------
  handle(
    IPC.CANDIDATES_LIST,
    (_e, args?: { jdId?: string | null; viewed?: boolean; limit?: number; platform?: PlatformId }): TalentCandidate[] => {
      const limit = Math.min(Math.max(Number(args?.limit) || 500, 1), 2000);
      const conds: string[] = [];
      const params: any[] = [];
      // H2(阶段1):按平台过滤，默认 'boss' 保兼容（猎聘跑批写入的 liepin 行不得混进 BOSS 人才库）
      conds.push('platform = ?');
      params.push(safePlatform(args?.platform));
      if (args && 'jdId' in args && args.jdId !== undefined) {
        if (args.jdId === null) conds.push('jd_id IS NULL');
        else {
          conds.push('jd_id = ?');
          params.push(args.jdId);
        }
      }
      if (args?.viewed !== undefined) {
        conds.push('viewed = ?');
        params.push(args.viewed ? 1 : 0);
      }
      const where = `WHERE ${conds.join(' AND ')}`;
      const rows = getDb()
        .prepare(`SELECT * FROM candidates_export ${where} ORDER BY score DESC, id DESC LIMIT ${limit}`)
        .all(...params) as any[];
      return rows.map(rowToCandidate);
    },
  );

  handle(IPC.CANDIDATES_MARK_VIEWED, (_e, id: number, viewed: boolean): boolean => {
    const info = getDb()
      .prepare('UPDATE candidates_export SET viewed = ? WHERE id = ?')
      .run(viewed ? 1 : 0, Number(id));
    return info.changes > 0;
  });

  // 每个 jd_id 的候选人计数（total/unviewed），含 jd_id IS NULL 的"未关联"桶（键 '__none__'）
  // H2(阶段1):按平台过滤，默认 'boss' 保兼容
  handle(IPC.CANDIDATES_STATS, (_e, platform?: PlatformId): Record<string, { total: number; unviewed: number }> => {
    const rows = getDb()
      .prepare(
        "SELECT COALESCE(jd_id, '__none__') AS k, COUNT(*) AS total, SUM(CASE WHEN viewed = 0 THEN 1 ELSE 0 END) AS unviewed FROM candidates_export WHERE platform = ? GROUP BY COALESCE(jd_id, '__none__')",
      )
      .all(safePlatform(platform)) as any[];
    const out: Record<string, { total: number; unviewed: number }> = {};
    for (const r of rows) out[r.k] = { total: r.total, unviewed: r.unviewed || 0 };
    return out;
  });

  // ══════════ 猎聘人才池子页 ══════════
  // 与 BOSS 人才库并列的一块，但语义相反：BOSS 那块是"本轮结果"，
  // 这块是【长久保存的人才链接】，随时能打开。
  handle(IPC.LIEPIN_TALENTS_LIST, (_e, q: any) => {
    const { rows, total } = listLiepinTalents({
      jdId: q?.jdId || undefined,
      minScore: typeof q?.minScore === 'number' ? q.minScore : 60, // 业务方要求：低于 60 不显示
      tag: q?.tag || undefined,
      q: q?.q || undefined,
      archived: !!q?.archived,
      limit: Number(q?.limit) || 200,
      offset: Number(q?.offset) || 0,
    });
    const tags = getLiepinTags(rows.map((r: any) => r.res_id));
    // 链接不落库，在这里用 res_id 实时拼 —— 链接格式变了不用迁数据
    return {
      total,
      rows: rows.map((r: any) => ({
        ...r,
        tags: tags[r.res_id] || [],
        detailUrl: liepinDetailUrl(r.res_id),
      })),
    };
  });

  // D3(2026-08-05)：stats 带上每日额度上限，UI 用来显示"今日还剩 N 份"
  function liepinDailyLimit(): number {
    try {
      const s = getSetting<any>('app-settings', DEFAULT_SETTINGS);
      const mode = (s?.rpa?.defaultSpeed || 'human') as SpeedMode; // ★ 2026-08-20 P2：唯一 human 档
      const tier = Number(s?.rpa?.liepinPackageTier) || 10;
      return liepinDetailCap(mode, tier);
    } catch { return 5; } // 保守兜底：基础版 human 档 = 5
  }
  handle(IPC.LIEPIN_TALENTS_STATS, () => {
    const st = getLiepinTalentStats();
    return { ...st, dailyLimit: liepinDailyLimit() };
  });
  handle(IPC.LIEPIN_TALENTS_TAGS, () => getLiepinTagCounts());
  handle(IPC.LIEPIN_TALENT_SCORES, (_e, resId: string) => getLiepinScoresFor(String(resId || '')));
  handle(IPC.LIEPIN_TALENT_EXPIRING, () => listLiepinExpiring().map((r: any) => ({
    ...r, detailUrl: liepinDetailUrl(r.res_id),
  })));

  handle(IPC.LIEPIN_TALENT_TAG_ADD, (_e, resId: string, tag: string) => {
    addLiepinTag(String(resId || ''), String(tag || ''), 'manual');
    return true;
  });
  handle(IPC.LIEPIN_TALENT_TAG_REMOVE, (_e, resId: string, tag: string) => {
    removeLiepinTag(String(resId || ''), String(tag || ''));
    return true;
  });
  // 归档 ≠ 删除：收起不占视线，数据与链接都还在
  handle(IPC.LIEPIN_TALENT_ARCHIVE, (_e, resIds: string[], archived: boolean) =>
    archiveLiepinTalents(Array.isArray(resIds) ? resIds : [], !!archived));
  // 真删只走这条，且只由用户在"待清理"区显式确认后调用
  handle(IPC.LIEPIN_TALENT_DELETE, (_e, resIds: string[]) =>
    deleteLiepinTalents(Array.isArray(resIds) ? resIds : []));

  /**
   * 打开猎聘简历详情。
   * ★ 这一下就是真金白银：猎聘按"打开即扣"计费。所以：
   *   ① 在【猎聘那个浏览器】里打开（不是系统默认浏览器——那边没登录态，等于白扣一次）；
   *   ② 落 detail_at 记账，人才池据此避免重复打开同一个人。
   * 前端点之前必须已经明示过"会消耗一份今日额度"。
   */
  handle(IPC.LIEPIN_TALENT_OPEN, async (_e, resId: string): Promise<{ ok: boolean; reason?: string; todayUsed?: number; dailyLimit?: number; consumed?: boolean }> => {
    const id = String(resId || '').trim();
    if (!id) return { ok: false, reason: '缺少候选人标识' };
    const url = liepinDetailUrl(id);
    try {
      const rt = getRuntime('liepin');
      // matchRe：已经有猎聘简历页就复用那个标签，别每点一次开一个新标签
      await rt.chrome.openSiteInDebugBrowser(url, /lpt\.liepin\.com\/cvview/i);
      markLiepinDetailOpened(id);
      // D3(2026-08-05)：成功后回传当日已用/上限，让 UI 可以直接显示"今日还剩 N 份"
      const after = getLiepinTalentStats();
      return { ok: true, todayUsed: after.todayOpened, dailyLimit: liepinDailyLimit(), consumed: true };
    } catch (e: any) {
      // 典型失败：猎聘浏览器没开、或端口被别人的 Chrome 占着（隔离保护拒绝连接）
      // D3(2026-08-05)：失败明确告诉 UI 这次没扣额度，避免 TA 因担心扣钱不敢再点
      const cur = getLiepinTalentStats();
      return {
        ok: false,
        reason: e?.message || '猎聘浏览器未就绪，请先在 RPA 页打开猎聘浏览器并登录',
        todayUsed: cur.todayOpened,
        dailyLimit: liepinDailyLimit(),
        consumed: false,
      };
    }
  });

  // 外链打开：只放行 http/https
  handle(IPC.OPEN_EXTERNAL, (_e, url: string): boolean => {
    if (typeof url !== 'string') return false;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    shell.openExternal(u.toString()).catch(() => {});
    return true;
  });

  // 会话重放：BOSS 招聘者候选人无永久 URL，人才库「打开链接」驱动 BOSS 推荐帧按 encryptGeekId 点开卡片。
  // 健壮化（修 #5①）：①刷新/重开界面后 puppeteer 会掉，浏览器还开着就自动重新接管；
  // ②用户切走了 BOSS 页面则自动导航回推荐页再试；③卡不在当前列表则如实告知（BOSS 推荐每天变，旧人选无法保证）。
  handle(IPC.CANDIDATE_OPEN_BOSS, async (_e, encryptGeekId: string): Promise<{ ok: boolean; reason?: string }> => {
    if (typeof encryptGeekId !== 'string' || !/^[\w~-]+$/.test(encryptGeekId)) return { ok: false, reason: '非法标识' };
    const RECOMMEND_URL = 'https://www.zhipin.com/web/chat/recommend';
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // ① 浏览器开着但未接管（刷新/重开界面后常见）→ 自动接管
    //   反检测护栏：若此刻浏览器正停在登录/验证页，绝不接管（登录/验证阶段要零 CDP 附着）。
    if (!getRuntime('boss').chrome.isConnected()) {
      const st = await getRuntime('boss').chrome.getBrowserStatus().catch(() => ({ open: false, attached: false }));
      if (st.open) {
        if (await getRuntime('boss').chrome.isOnLoginOrVerify().catch(() => false)) {
          return { ok: false, reason: '浏览器正处于登录/验证页，已避免此时接管以免打断登录。请完成登录后再打开候选人。' };
        }
        try { await getRuntime('boss').chrome.connectExisting(); } catch { /* 下面兜底 */ }
      }
    }
    if (!getRuntime('boss').chrome.isConnected()) {
      return { ok: false, reason: '浏览器未连接，请先在设置里「打开 BOSS 浏览器」并登录' };
    }

    const findFrame = async () => {
      const pages = await getRuntime('boss').chrome.pages().catch(() => []);
      for (const p of pages) {
        const frame = p.frames().find((f) => /\/web\/frame\/recommend\//.test(f.url()));
        if (frame) return { page: p, frame };
      }
      return null;
    };
    const tryClick = (frame: any) =>
      frame.evaluate((gid: string) => {
        const inner = document.querySelector(`li.card-item .card-inner[data-geekid="${gid}"]`);
        const li = inner && (inner.closest('li.card-item') as HTMLElement | null);
        if (!li) return false;
        li.scrollIntoView({ block: 'center' });
        (li.querySelector('.card-inner') as HTMLElement | null)?.click();
        return true;
      }, encryptGeekId).catch(() => false);

    // ② 找推荐帧；用户切走了就把一个 BOSS 页导航回推荐页再找
    let ctx = await findFrame();
    if (!ctx) {
      const pages = await getRuntime('boss').chrome.pages().catch(() => []);
      const p = pages.find((pg) => /zhipin\.com/.test(pg.url())) || pages[0];
      if (p) { try { await p.goto(RECOMMEND_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); await sleep(1800); } catch { /* 忽略 */ } }
      ctx = await findFrame();
    }
    if (!ctx) return { ok: false, reason: '未找到 BOSS 推荐页，请在浏览器进入「推荐牛人」后重试' };

    // ③ 点击；卡不在当前列表则如实告知
    if (await tryClick(ctx.frame)) return { ok: true };
    return { ok: false, reason: '该候选人已不在当前推荐列表（BOSS 推荐每天刷新，旧人选可能已不在）。已定位到推荐页，可重新捞取。' };
  });
}
