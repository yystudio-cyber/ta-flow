// Platform handlers —— 双平台路由基础通道
import { BrowserWindow, shell } from 'electron';
import { handle } from './wrap';
import { IPC } from '../../shared/types';
import { PLATFORMS } from '../../shared/types';
import { getRuntime } from '../services/runtime-registry';
import { getDb } from '../db';

/**
 * B3: 安全外链打开 —— 只放行 http/https，拒绝 file:// / ms-msdt: / 自定义协议。
 * 从 candidates_export.url 导入的 URL 可能含任意字符串（CSV 导入无校验），
 * 直接传给 shell.openExternal 是已知 1-click RCE 模式。
 */
export function openExternalSafe(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  shell.openExternal(u.toString()).catch(() => {});
  return true;
}

export function registerPlatformHandlers(winGetter: () => BrowserWindow | null) {
  void winGetter; // 暂未用到窗口引用

  handle(IPC.PLATFORM_LIST, () => {
    return PLATFORMS.map((id) => {
      const rt = getRuntime(id);
      return { id, name: rt.adapter.name };
    });
  });

  handle(IPC.CANDIDATES_OPEN_SOURCE, async (_e, candidateId: number) => {
    const row = getDb()
      .prepare('SELECT url, platform FROM candidates_export WHERE id = ?')
      .get(candidateId) as any;
    if (!row) return { ok: false, reason: '候选人不存在' };
    const url = row.url;
    if (!url) return { ok: false, reason: '无来源链接' };
    if (!openExternalSafe(url)) return { ok: false, reason: '来源链接无效或协议不允许' };
    return { ok: true };
  });
}
