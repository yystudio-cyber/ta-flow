// 浏览器预览专用：当 window.api 不存在（非 Electron 环境）时，注入一套带样例数据的假 API，
// 让整站能在普通浏览器里完整渲染。生产 Electron 环境下 preload 已注入真 api，本文件不会启用。
import { DEFAULT_SETTINGS } from '../../../shared/constants';
import type { JD, RPATask } from '../../../shared/types';

function delay<T>(v: T, ms = 60): Promise<T> {
  return new Promise((r) => setTimeout(() => r(v), ms));
}

const now = Date.now();
const day = (n: number) => new Date(now - n * 86400000).toISOString().slice(0, 10);

const JDS: JD[] = [
  {
    id: 'jd_1', name: '嵌入式软件工程师-杭州', title: '嵌入式软件工程师', active: true,
    basic: { experienceMin: 3, experienceMax: 5, degree: '本科', city: '杭州', salaryMin: 25, salaryMax: 40 },
    keywords: { required: ['嵌入式', 'C语言', 'Linux驱动'], bonus: ['RTOS', 'CAN总线', '互联网'], negative: ['纯APP', '纯前端'] },
    industry: { preferred: ['互联网', '芯片'], excluded: ['纯互联网'] },
    companyTier: { prefer: ['上市', '外企'], avoid: ['外包'] } as any,
    weights: { experience: 20, keywords: 30, degree: 10, industry: 15, companyTier: 10, salary: 10, location: 5 } as any,
    createdAt: now, updatedAt: now,
  } as JD,
  {
    id: 'jd_2', name: '后端开发工程师-上海', title: 'Go 后端工程师', active: false,
    basic: { experienceMin: 3, experienceMax: 6, degree: '本科', city: '上海', salaryMin: 30, salaryMax: 50 },
    keywords: { required: ['Go', '微服务', 'MySQL'], bonus: ['K8s', 'gRPC'], negative: [] },
    industry: { preferred: ['云计算'], excluded: [] },
    companyTier: { prefer: [], avoid: [] } as any,
    weights: { experience: 20, keywords: 30, degree: 10, industry: 15, companyTier: 10, salary: 10, location: 5 } as any,
    createdAt: now, updatedAt: now,
  } as JD,
];

const TASKS: RPATask[] = [
  {
    id: 'task_1', name: '嵌入式-杭州-Sourcing', platform: 'boss',
    search: { keywords: '嵌入式 驱动 Linux', city: '杭州', experience: '3-5年', degree: '本科', salary: '' },
    actions: { autoGreet: true, greetThreshold: 75, greetTemplate: '您好，看到您的经历很匹配，方便聊聊吗？', autoFavorite: true, favoriteThreshold: 70, exportCsv: true },
    speed: { mode: 'human', dailyGreetLimit: 15, dailyBrowseLimit: 240, dailyFavoriteLimit: 40 },
    schedule: { trigger: 'manual', runDurationMin: 120, cron: '30 12,18 * * *', idleStartMinutes: 5, idlePauseOnInput: true },
    createdAt: now, updatedAt: now,
  } as RPATask,
];

const NAMES = ['张伟', '李娜', '王强', '郑凯', '陈静', '杨帆', '赵磊', '周敏', '吴迪', '孙悦', '徐涛', '朱琳'];
const COMPANIES = ['示例科技', '示例科技（上海）', '另一家示例公司', '示例集团'];
const CANDS = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1, date: day(i % 7), jd_id: i % 5 === 0 ? 'jd_2' : 'jd_1',
  name: NAMES[i % NAMES.length], position: i % 5 === 0 ? 'Go 后端' : '嵌入式工程师',
  company: COMPANIES[i % COMPANIES.length], city: i % 5 === 0 ? '上海' : '杭州',
  experience: `${3 + (i % 5)}年`, degree: ['本科', '硕士', '本科', '大专'][i % 4], salary: `${25 + (i % 20)}-${40 + (i % 15)}K`,
  score: 92 - i * 2.4, url: `https://www.zhipin.com/geek/detail-${1000 + i}.html`,
  greeted: i % 3 === 0 ? 1 : 0, favorited: i % 4 === 0 ? 1 : 0, viewed: i % 3 === 1 ? 1 : 0, note: '',
}));

const INBOX = [
  { id: 1, receivedAt: now - 3600000, source: 'feishu-jr-snapshot', title: '高级嵌入式工程师', dept: '研发中心', city: '杭州', status: '招聘中', raw: '', state: 'new' as const },
  { id: 2, receivedAt: now - 7200000, source: 'feishu-jr-snapshot', title: '算法工程师（视觉）', dept: 'AI 实验室', city: '上海', status: '急聘', raw: '', state: 'new' as const },
];

const LOGS = [
  { time: now - 8000, level: 'info', message: '启动任务：嵌入式-杭州-Sourcing' },
  { time: now - 7000, level: 'info', message: '打开 BOSS 搜索结果页' },
  { time: now - 6000, level: 'success', message: '候选人「张伟」匹配分 88，已收藏' },
  { time: now - 5000, level: 'info', message: '浏览候选人「李娜」详情页' },
  { time: now - 4000, level: 'success', message: '候选人「李娜」匹配分 81，已发送打招呼' },
  { time: now - 2500, level: 'warn', message: '距离上次操作 8s，模拟人工停顿' },
  { time: now - 1000, level: 'info', message: '继续浏览下一位候选人…' },
];

const rpaState = {
  status: 'running', taskId: 'task_1', elapsedMs: 1000 * 60 * 42, currentPage: 'BOSS 直聘 · 搜索结果页',
  stats: { viewed: 37, greeted: 12, favorited: 9, pagesBrowsed: 3 },
  logs: LOGS,
};
const riskState = {
  level: 'notice',
  metrics: { greetCountToday: 62, browseCountToday: 210, favoriteCountToday: 28, lastHourOps: 44, lastWindowLoads: 2, pageAnomaly: false, accountRestricted: false, nightActivity: false },
  reasons: ['今日打招呼接近黄色阈值'], suggestions: ['建议放慢打招呼节奏', '优先跟进收藏夹里的高分候选人'],
};

const noop = () => () => {};

export function installMockApi() {
  const api = {
    getVersion: () => delay('1.0.0-preview'),
    quit: noop, openDevTools: noop,
    checkUpdate: () => delay({ current: '1.0.0', latest: '1.0.0', hasUpdate: false, message: '当前已是最新版本' }),
    behaviorStatus: () => delay({ enabled: true, sampleCount: 34, scrollCount: 58, learned: { sampleCount: 34, profile: { clickIntervalMs: { mean: 2400 } } } }),
    behaviorApply: () => delay(true), behaviorReset: () => delay(true),
    getSettings: () => delay(JSON.parse(JSON.stringify(DEFAULT_SETTINGS))),
    saveSettings: (s: any) => delay(s), resetSettings: () => delay(DEFAULT_SETTINGS),
    // 工具库收口(2026-08-20)：mock 只剩 listExtensions + exportExtension（与真 preload API 面对齐）
    listJds: () => delay(JSON.parse(JSON.stringify(JDS))),
    saveJd: (jd: any) => delay({ ...jd, id: jd.id || 'jd_new' }),
    deleteJd: () => delay(true), setActiveJd: () => delay(true),
    getActiveJd: () => delay(JDS[0]),
    getRpaState: () => delay(rpaState),
    startRpa: () => delay(true), pauseRpa: () => delay(true), resumeRpa: () => delay(true), stopRpa: () => delay(true),
    listTasks: () => delay(JSON.parse(JSON.stringify(TASKS))),
    saveTask: (t: any) => delay({ ...t, id: t.id || 'task_new' }), deleteTask: () => delay(true),
    onRpaEvent: noop,
    getRiskState: () => delay(riskState), onRiskEvent: noop,
    listExtensions: () => delay({
      baseDir: '/extension',
      items: [{
        dirName: 'boss-match-score', dir: '/extension/boss-match-score',
        name: 'TA 匹配分助手（BOSS 招聘端）', version: '1.0.0',
        description: '人工 sourcing 时在 BOSS「推荐牛人」卡片上实时显示与当前激活岗位的匹配分。',
        matches: [],
      }],
      bridge: {
        running: true, port: 17385, extensionId: 'hhjilkjdngolnidebdlmkkhpoidegbgc',
        lastPolledAt: now - 30000, extensionSeen: true, activeJdName: '嵌入式软件工程师-杭州',
      },
    }),
    exportExtension: () => delay({ ok: true, file: '/downloads/boss-match-score-v1.0.0.zip' }),
    getEncryptionStatus: () => delay({ mode: 'degraded', reason: '主密钥无法解密（可能来自另一台机器或另一个 Windows 账户）', available: true, encryptedFields: {} }),
    resetEncryptionKey: () => delay({ ok: true }),
    getRiskHistory: () => delay({
      daily: Array.from({ length: 7 }, (_, i) => ({ date: day(6 - i), count: [0, 1, 0, 2, 1, 0, 1][i] })),
      events: [
        { id: 1, time: now - 3600000, date: day(0), level: 'notice', reason: '打招呼接近黄色阈值' },
        { id: 2, time: now - 90000000, date: day(1), level: 'danger', reason: '短时操作频率过高，已自动暂停' },
      ],
    }),
    getDashboard: () => delay({
      today: { viewed: 37, greeted: 12, favorited: 9, highMatch: 8, midMatch: 15, lowMatch: 14 },
      weekTrend: Array.from({ length: 7 }, (_, i) => ({ date: day(6 - i), viewed: [22, 41, 33, 58, 47, 30, 37][i], greeted: [6, 12, 9, 18, 14, 8, 12][i] })),
      risk: riskState, rpa: { isRunning: true }, activeJD: JDS[0],
    }),
    getCdpStatus: () => delay({ connected: true, open: true }),
    launchBrowser: () => delay(true), connectBrowser: () => delay(true), closeBrowser: () => delay(true), onCdpStatus: noop,
    openBrowserForLogin: () => delay({ launched: true, alreadyOpen: false, focused: true, url: 'https://www.zhipin.com' }),
    smartConnect: () => delay({ mode: 'existing' }),
    testMatch: () => delay({
      total: 82, level: 'high',
      details: [
        { dimension: 'experience', label: '工作年限', weight: 20, score: 90, status: 'match', note: '4 年，落在 3-5 年区间' },
        { dimension: 'keywords', label: '关键词', weight: 30, score: 78, status: 'partial', note: '命中 嵌入式/Linux，缺 RTOS' },
        { dimension: 'degree', label: '学历', weight: 10, score: 100, status: 'match', note: '本科达标' },
        { dimension: 'industry', label: '行业', weight: 15, score: 70, status: 'partial', note: '相关行业' },
        { dimension: 'salary', label: '薪资', weight: 10, score: 85, status: 'match', note: '在预算内' },
      ],
    }),
    exportCsv: () => delay({ ok: true }), clearAllData: () => delay(true), openDataFolder: noop,
    backupData: () => delay({ ok: true, path: 'C:/backup' }), restoreData: () => delay({ ok: true }),
    onTrayAction: noop,
    // G2/G3
    listJrInbox: () => delay(JSON.parse(JSON.stringify(INBOX))),
    importJrInbox: (ids: number[]) => delay(ids.length), dismissJrInbox: (ids: number[]) => delay(ids.length), onJrInbox: noop,
    listCandidates: (args?: { jdId?: string | null }) => delay(JSON.parse(JSON.stringify(
      args && 'jdId' in args ? CANDS.filter((c) => (args.jdId == null ? c.jd_id == null : c.jd_id === args.jdId)) : CANDS,
    ))),
    markCandidateViewed: () => delay(true),
    candidateStats: () => delay({ jd_1: { total: 19, unviewed: 12 }, jd_2: { total: 5, unviewed: 3 } }),
    openExternal: (url: string) => { window.open(url, '_blank'); return delay(true); },
    // ── 补齐与真 preload 的 API 面漂移（缺了这些，预览模式点按钮会直接 TypeError）──
    clearRisk: () => delay(riskState),
    importData: () => delay({ ok: true }),
    openBossGeek: () => delay({ ok: true }),
    onIpcError: noop,
  };
  (window as any).api = api;
  // eslint-disable-next-line no-console
  console.info('[mock-api] 浏览器预览模式已启用（样例数据）');
}
