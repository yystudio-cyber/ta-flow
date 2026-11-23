// Tools handlers —— 工具库收口（2026-08-20）：只保留「浏览器扩展清单 + 导出安装包」两件事。
// 原安装/打开站点/打开目录/教程/行为采样/平台注入工具(listTools/开关/配置/installTool/openToolWorkPage)
// 的 handler 已全部删除（前端 ToolsPage.vue 只剩扩展卡 + 导出按钮）。
// 保留：TOOLS_EXTENSIONS（扩展清单）、TOOLS_EXTENSION_EXPORT（导出 zip）。
// 另保留 REQSHEET_*（需求汇总插件桥），它不走工具库 UI，是 reqsheet-bridge/scheduler 的独立通道，不在本次删除清单。
import { BrowserWindow, dialog, shell, app, clipboard } from 'electron';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { handle } from './wrap';
import { IPC } from '../../shared/types';
import { getRuntime } from '../services/runtime-registry';
import { jdBridgeStatus } from '../services/jd-bridge';
import { setRunToken, getLastState, reqsheetBridgeRunning, REQSHEET_BRIDGE_PORT, REQSHEET_EXTENSION_ID } from '../services/reqsheet-bridge';
import { readKnownReqIds, getTargetXlsxPath, getPendingCount } from '../services/req-sheet-writer';
import { getSchedulerStatus } from '../services/scheduler';
import { oplog } from '../services/oplog';

// BOSS 招聘端「推荐牛人」入口。
// ⚠️ 待真机校准：这个路径是按 BOSS 现行 URL 形态写的，改版就会失效（表现为点了按钮
// 落到别的页面）。校准时同步检查 extension/boss-match-score/manifest.json 的 matches
// 是否仍覆盖到它——两处对不上，插件就不会在这个页面上跑。
const BOSS_RECOMMEND_URL = 'https://www.zhipin.com/web/chat/recommend';

// 飞书招聘需求列表（生产租户 acme）。
// status=0 = 全部页签；filters 里 approval_status "3" = 审批通过。两者都必须显式带，
// 详见 EXTENSION_META['feishu-req-sheet-sync'] 上的说明。
export const REQUIREMENT_LIST_URL =
  'https://acme.feishu.cn/hire/job/requirement/list'
  + '?status=0&filters=%7B%22approval_status%22%3A%5B%223%22%5D%7D';

// 平台自带的浏览器扩展白名单。
// 行为采集插件已于 2026-08-03 剥离为独立仓（桌面\招聘行为采集插件），它与平台风险不对称、
// 不该被平台安装包/工具库/测试链裹着。
// 用白名单而非「枚举 extension/ 下所有目录」，是为了让平台"只有四功能"这条线不会因为
// 有人把别的扩展塞进 extension/ 就静默多出一张卡片。
const ALLOWED_EXTENSION_DIRS = ['boss-match-score', 'feishu-req2job', 'feishu-req-sheet-sync'];

/**
 * 每个扩展的分发元信息。
 * 收口后工具库 UI 只渲染扩展卡 + 导出安装包，不再用 siteUrl/guide 渲染按钮；
 * 但 listExtensions 仍把这些字段原样塞进返回体（扩展扫描/清单核心，属 export/list 依赖链，
 * 保留以确保清单数据结构与下游一致，删了反而要让扩展插件自己去拼 URL）。
 * 用 dirName 做键（白名单内），而不是让渲染进程传 URL —— 否则这条通道就成了任意 URL 打开器。
 */
const EXTENSION_META: Record<string, { siteUrl: string; siteLabel: string; guide: string[] }> = {
  'boss-match-score': {
    siteUrl: BOSS_RECOMMEND_URL,
    siteLabel: 'BOSS 推荐牛人页',
    guide: [
      '点「一键安装」——平台会自动打开 chrome://extensions，并把插件目录复制到剪贴板',
      '在打开的页面右上角，把「开发者模式」打开',
      '点「加载已解压的扩展程序」，在地址栏 Ctrl+V 粘贴路径 → 选择',
      '回到 BOSS 推荐牛人页，卡片上就会出现匹配分',
    ],
  },
  'feishu-req2job': {
    // ⚠️ 必须指向正式租户 acme。此前写了测试租户 demo，已修正。
    siteUrl: 'https://acme.feishu.cn/hire/job/requirement/list',
    siteLabel: '飞书招聘需求列表',
    guide: [
      '点「一键安装」——平台会自动打开 chrome://extensions，并把插件目录复制到剪贴板',
      '在打开的页面右上角，把「开发者模式」打开',
      '点「加载已解压的扩展程序」，在地址栏 Ctrl+V 粘贴路径 → 选择',
      '点「打开飞书招聘需求列表」，进入一条<b>审批通过</b>的需求详情',
      '点右下角面板上的「⚡ 一键：需求 → 新建职位」，它会自动填到最后一步并停下',
      '中间那个「已粘贴」框＝要填进去的内容，<b>可以直接改，改完立刻生效</b>（漏了字段就用「🎯 逐项点选」对准它点一下补进来）',
      '逐项核对后<b>自己点提交</b>——插件永远不会替你提交',
    ],
  },
  'feishu-req-sheet-sync': {
    // ⚠️ status=0 = 「全部」页签，必须显式带上。
    // 不带 status 时飞书会重定向到 status=2（进行中），于是「审批通过但不在进行中」的需求
    // ——未开始 / 已完成 / 已超期 / 已暂停 / 已取消——【一条都枚举不到】，而界面上完全看不出漏了。
    // 测试租户加「审批通过」筛选后的页签计数：未开始 5 / 进行中 10 / 已完成 5 / 已超期 8 /
    // 已暂停 0 / 已取消 3 / 全部 31 —— 只看进行中就是 10/31。
    // filters 是 URL 编码的 JSON，approval_status "3" = 审批通过。
    siteUrl: REQUIREMENT_LIST_URL,
    siteLabel: '飞书招聘需求列表',
    guide: [
      '点「一键安装」——平台会自动打开 chrome://extensions，并把插件目录复制到剪贴板',
      '在打开的页面右上角，把「开发者模式」打开',
      '点「加载已解压的扩展程序」，在地址栏 Ctrl+V 粘贴路径 → 选择',
      '回到平台工具库，点「打开并汇总」按钮启动首次同步',
      '如弹出「等待登录」横幅：正常登录飞书即可，插件会自动继续',
      '每天 11:00 自动运行一次；表格被 Excel 打开时数据会暂存，关闭后重试即自动写入',
    ],
  },
};

// 浏览器扩展目录：开发期在 cwd/extension，打包后随 extraResources 落在 resourcesPath/extension
function resolveExtensionDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'extension'),
    path.join(app.getAppPath(), '..', 'extension'),
    path.join(process.resourcesPath || '', 'extension'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/**
 * 在【用户日常那个 Chrome】里打开地址。
 *
 * ⚠️ 不能用 shell.openExternal：它走系统默认浏览器（用户实测是 Edge），
 * 而扩展装在 Chrome 里 —— 页面开了但插件不在，看起来就是"插件坏了"（2026-07-29 真机事故）。
 * 也不能用平台的 RPA / 工具调试 Chrome：那是独立 profile，既没装扩展也没有登录态。
 * 不传 --user-data-dir 就是用户日常的默认 profile，正是我们要的。
 *
 * 收口后仅 REQSHEET_RUN（需求汇总插件）使用；保留这条路 = 那条通道的底座，不删。
 */
async function openInDailyChrome(url: string, what: string) {
  const chromePath = getRuntime('boss').chrome.findChrome();
  if (chromePath) {
    try {
      // Windows 下裸 spawn 出来的 Chrome 会被并入 Electron 的 Job Object，随 app 一起被关掉
      // （表现为"打开即闪退"）。用 cmd /c start 剥离进程组，与 openBrowserForLogin 同一处置。
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '', chromePath, url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else {
        spawn(chromePath, [url], { detached: true, stdio: 'ignore' }).unref();
      }
      return { ok: true, url, browser: 'chrome' };
    } catch { /* 拉不起来就退回默认浏览器，并如实告知 */ }
  }
  try {
    await shell.openExternal(url);
    return {
      ok: true, url, browser: 'default',
      reason: chromePath
        ? `未能直接启动 Chrome，已用系统默认浏览器打开。若它不是 Chrome，${what}不会生效。`
        : `没找到 Chrome，已用系统默认浏览器打开。${what}只在 Chrome 里生效——`
          + '请在「设置 → 浏览器 → 高级」里指定 Chrome 路径，或手动用 Chrome 打开。',
    };
  } catch (e: any) {
    return { ok: false, reason: e?.message || '打开失败', url };
  }
}

export function registerToolsHandlers(winGetter: () => BrowserWindow | null) {
  // 浏览器扩展清单 + 连接状态。扩展不走平台注入，故不进 toolManager，单独一条通道。
  // ★ 保留：listExtensions 底座——读 extension/ 目录 + manifest，前端据此渲染扩展卡。
  handle(IPC.TOOLS_EXTENSIONS, () => {
    const base = resolveExtensionDir();
    const bridge = jdBridgeStatus();
    const items: any[] = [];
    if (base) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(base).filter((n) => {
          if (!ALLOWED_EXTENSION_DIRS.includes(n)) return false; // 只认平台白名单内的扩展
          try { return fs.statSync(path.join(base, n)).isDirectory(); } catch { return false; }
        });
      } catch { names = []; }
      for (const n of names) {
        const mf = path.join(base, n, 'manifest.json');
        try {
          if (!fs.existsSync(mf)) continue;
          const m = JSON.parse(fs.readFileSync(mf, 'utf-8'));
          const meta = EXTENSION_META[n];
          items.push({
            dirName: n,
            dir: path.join(base, n),
            name: m.name || n,
            version: m.version || '',
            description: m.description || '',
            matches: (m.content_scripts?.[0]?.matches) || [],
            siteUrl: meta?.siteUrl || '',
            siteLabel: meta?.siteLabel || '',
            guide: meta?.guide || [],
          });
        } catch { /* 单个 manifest 坏了不影响其它 */ }
      }
    }
    return { baseDir: base, items, bridge };
  });

  // 导出安装包（zip）。
  // 「一键安装」指的是本机这一台；TA 之间互相分发、或换台电脑，需要一个能带走的文件。
  // 直接压 extension/<dir>，产物解压出来就是可加载的目录，与本机装的是同一份字节。
  // ★ 保留：exportExtension 底座——compress 到 zip + 另存框，前端唯一保留的操作。
  handle(IPC.TOOLS_EXTENSION_EXPORT, async (_e, dirName: string) => {
    if (!ALLOWED_EXTENSION_DIRS.includes(dirName)) return { ok: false, reason: '未知扩展' };
    const base = resolveExtensionDir();
    const src = base ? path.join(base, dirName) : null;
    if (!src || !fs.existsSync(src)) return { ok: false, reason: '找不到扩展目录' };
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf-8')).version || ''; } catch { /* 用不到版本号也能导 */ }

    const win = winGetter();
    const def = path.join(app.getPath('downloads'), `${dirName}${version ? '-v' + version : ''}.zip`);
    const r = win
      ? await dialog.showSaveDialog(win, { title: '导出插件安装包', defaultPath: def, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
      : { canceled: false, filePath: def };
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };

    try { fs.rmSync(r.filePath, { force: true }); } catch { /* 覆盖前先删，Compress-Archive 的 -Force 对已存在文件不总生效 */ }
    try {
      // 用系统自带的压缩命令，不为这一个功能引 zip 依赖。
      // Windows：Compress-Archive 压 src\*（只压内容，不含父目录）。
      // macOS/Linux：从 src 内 `zip -r . `，同样只压内容——解压出来与本机装的同构。
      await new Promise<void>((res, rej) => {
        const isWin = process.platform === 'win32';
        const p = isWin
          ? spawn('powershell.exe', [
              '-NoProfile', '-NonInteractive', '-Command',
              `Compress-Archive -Path '${src.replace(/'/g, "''")}\\*' -DestinationPath '${r.filePath!.replace(/'/g, "''")}' -Force`,
            ], { windowsHide: true })
          : spawn('zip', ['-r', '-q', '-X', r.filePath!, '.'], { cwd: src });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => (code === 0 ? res() : rej(new Error(err.trim() || `打包失败（退出码 ${code}）`))));
        p.on('error', rej);
      });
    } catch (e: any) {
      return { ok: false, reason: e?.message || '打包失败' };
    }
    try { shell.showItemInFolder(r.filePath); } catch { /* 打不开资源管理器不影响导出本身 */ }
    return { ok: true, file: r.filePath };
  });

  // ── 飞书需求汇总 IPC（独立于工具库 UI，reqsheet-bridge/scheduler 通道，不在本次删除清单）───
  // 手动触发：读出当前 knownReqIds → 设置 run token → 打开 Chrome → 扩展轮询到 token 自动开跑
  handle(IPC.REQSHEET_RUN, async () => {
    try {
      const xlsxPath = getTargetXlsxPath();
      const knownIds = await readKnownReqIds(xlsxPath);
      const runId = `run-${Date.now()}`;
      setRunToken({ runId, knownReqIds: knownIds, config: { scheduled: false, maxPerRun: 50 } });
      const result = await openInDailyChrome(REQUIREMENT_LIST_URL, '需求汇总插件');
      oplog('reqsheet', 'manual-run', { runId, knownCount: knownIds.length });
      return { ok: result.ok, runId, xlsxPath, knownCount: knownIds.length, reason: result.reason };
    } catch (e: any) {
      return { ok: false, reason: e?.message || String(e) };
    }
  });

  handle(IPC.REQSHEET_STATUS, () => {
    const sched = getSchedulerStatus();
    const bridgeState = getLastState();
    return {
      bridgeRunning: reqsheetBridgeRunning(),
      bridgePort: REQSHEET_BRIDGE_PORT,
      extensionId: REQSHEET_EXTENSION_ID,
      lastState: bridgeState.state,
      lastStateAt: bridgeState.at,
      pending: getPendingCount(),
      scheduler: sched,
    };
  });

  handle(IPC.REQSHEET_PENDING_COUNT, () => getPendingCount());
}
