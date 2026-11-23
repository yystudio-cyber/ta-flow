/**
 * E2(2026-08-05)：手动翻转 Electron Fuse 位。
 *
 * 背景：electron-builder 24.x 不支持内置 electronFuses 配置（v25+ 才引入）。
 * 过渡方案：打包后手动运行此脚本翻转 fuse 位，在升级 electron-builder 前使用。
 *
 * 前置：npm install --save-dev @electron/fuses
 * 用法：node scripts/apply-fuses.mjs <打包产物路径>
 *   例：node scripts/apply-fuses.mjs release/win-unpacked/TA\ AI提效平台.exe
 *
 * 目标 fuse 设置：
 *   RunAsNode                      → false（CVE-2024-23738~23743：防 ELECTRON_RUN_AS_NODE 执行任意代码）
 *   EnableNodeCliInspectArguments  → false（防 --inspect 调试端口被滥用）
 *   EnableNodeOptionsEnvironmentVariable → false（防 NODE_OPTIONS 注入）
 *   EnableCookieEncryption         → true（OS 级 Cookie 加密）
 *   OnlyLoadAppFromAsar            → true（防止 asar 外的代码被加载）
 */
import path from 'path';

// 读取 fuse 状态（用 @electron/fuses 的 read 命令）
const appPath = process.argv[2];
if (!appPath) {
  console.error('用法：node scripts/apply-fuses.mjs <产物路径>');
  console.error('例：node scripts/apply-fuses.mjs release/win-unpacked/TA\\ AI提效平台.exe');
  process.exit(1);
}

let fusesPkg;
try {
  fusesPkg = await import('@electron/fuses');
} catch {
  console.error('❌ 需要先安装 @electron/fuses：npm install --save-dev @electron/fuses');
  process.exit(1);
}

const { flipFuses, FuseVersion, FuseV1Options } = fusesPkg;

console.log(`正在对 ${appPath} 翻转 fuse 位...`);
await flipFuses(appPath, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
});
console.log('✓ fuse 位翻转完成');
console.log('验证：npx @electron/fuses read --app', appPath);
