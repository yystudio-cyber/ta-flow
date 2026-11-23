// 开机自启服务（单一来源）：index.ts 启动时按设置应用一次，
// SETTINGS_SAVE 保存时即时应用一次——避免"勾选保存后要重启才生效"。
import AutoLaunch from 'auto-launch';

const APP_NAME = 'TA Flow';

export async function setupAutoLaunch(enabled: boolean): Promise<void> {
  try {
    const autoLauncher = new AutoLaunch({ name: APP_NAME });
    const isEnabled = await autoLauncher.isEnabled();
    if (enabled && !isEnabled) await autoLauncher.enable();
    else if (!enabled && isEnabled) await autoLauncher.disable();
  } catch {
    /* 平台不支持/权限不足则静默忽略，不阻断保存 */
  }
}
