#!/usr/bin/env node
/**
 * 用 Electron 内置的 Node 运行脚本（ELECTRON_RUN_AS_NODE=1）。
 *
 * 为什么需要：better-sqlite3 是原生模块，postinstall 的 electron-builder install-app-deps
 * 把它编译成了【Electron 的 Node ABI】。用系统 node 直接 require 会报
 * NODE_MODULE_VERSION 不匹配。
 * ⚠️ 不要为了跑测试而 npm rebuild —— 那会把它改回系统 ABI，App 反而起不来。
 *
 * 用法：node scripts/run-electron-node.mjs <script> [args...]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：node scripts/run-electron-node.mjs <script> [args...]');
  process.exit(2);
}

const bin = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const electron = path.join(ROOT, 'node_modules', '.bin', bin);
if (!fs.existsSync(electron)) {
  console.error(`未找到 electron 可执行文件：${electron}（请先 npm install）`);
  process.exit(2);
}

// Windows 路径含空格时 shell 拼接会截断 → 用 `"${electron}"` 包裹
const child = spawn(
  process.platform === 'win32' ? `"${electron}"` : electron,
  args,
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    shell: process.platform === 'win32',
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (e) => { console.error(e); process.exit(1); });
