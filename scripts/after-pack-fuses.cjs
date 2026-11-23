/**
 * electron-builder afterPack 钩子：打包后自动翻转 Electron Fuse 位。
 *
 * 为什么需要这个文件（2026-08-07 审查）：
 *   package.json 里曾直接写 `build.electronFuses`，但那是 electron-builder **25+** 才有的配置项，
 *   当前锁定 24.13.3 → 配置校验直接失败，`npm run build` / `build:dir` / `build:portable`
 *   **三条打包路径全部报 "unknown property 'electronFuses'" 中止**，整个应用打不出包。
 *   而同时存在的 scripts/apply-fuses.mjs 是**手动**步骤且依赖未安装，实际从未执行过 ——
 *   即：fuse 位一个都没生效，安全加固全程是纸面上的。
 *
 * 现在的做法：从 package.json 移除 electronFuses（v24 不认），改由本钩子在 afterPack 阶段
 * 对产物 exe 翻转 fuse，打包链自动带上，没有需要人记住的手动步骤。
 * 升级到 electron-builder 25+ 后，可改回内置 electronFuses 配置并删除本文件与 apply-fuses.mjs。
 *
 * 目标 fuse（与 apply-fuses.mjs 保持一致）：
 *   RunAsNode                            → false  CVE-2024-23738~23743，防 ELECTRON_RUN_AS_NODE 执行任意代码
 *   EnableNodeCliInspectArguments        → false  防 --inspect 调试端口被滥用
 *   EnableNodeOptionsEnvironmentVariable → false  防 NODE_OPTIONS 注入
 *   EnableCookieEncryption               → true   OS 级 Cookie 加密（保护 BOSS/猎聘登录态）
 *   OnlyLoadAppFromAsar                  → true   防止 asar 外的代码被加载
 */
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  // ⚠️ 跨平台构建 macOS 目标（在 Windows/Linux 上打 darwin 包）：
  //   flipFuses 会修改二进制，随后 resetAdHocDarwinSignature 必须用 `codesign` 重新 ad-hoc 签名，
  //   而 codesign 只在 macOS 存在 → 在 Windows 上这一步必然失败，且 arm64 macOS 上未签名/签名失效的
  //   二进制根本无法运行。因此跨平台构建 darwin 时【跳过】fuse 翻转与签名，交由 Mac 侧一条
  //   `codesign --force --deep -s -` 完成最终签名（见交付说明）。原生在 Mac 上构建时本分支不触发。
  if (electronPlatformName === 'darwin' && process.platform !== 'darwin') {
    console.warn('[fuses] 跨平台构建 macOS：跳过 fuse 翻转与 ad-hoc 签名（codesign 仅 macOS 可用，需在 Mac 上补签）。');
    return;
  }

  // 产物主程序路径（Windows 为 <productName>.exe；mac/linux 走各自约定）
  let appPath;
  if (electronPlatformName === 'win32') {
    appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`);
  } else if (electronPlatformName === 'darwin') {
    appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  } else {
    appPath = path.join(appOutDir, packager.appInfo.productFilename);
  }

  if (!fs.existsSync(appPath)) {
    throw new Error(`[fuses] 找不到打包产物：${appPath}——fuse 位未翻转，拒绝出包`);
  }

  let fusesPkg;
  try {
    fusesPkg = await import('@electron/fuses');
  } catch {
    // 硬失败而非跳过：静默出一个没加固的包，比打不出包更危险。
    throw new Error('[fuses] 缺少 @electron/fuses，无法翻转 fuse 位。请先 npm install --save-dev @electron/fuses');
  }

  const { flipFuses, FuseVersion, FuseV1Options } = fusesPkg;
  await flipFuses(appPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log(`[fuses] ✓ 已翻转 fuse 位：${appPath}`);
};
