// 浏览器预览专用：仅渲染层，不加载 electron 插件（不拉起主进程/原生模块）。
// 用于在普通浏览器里查看 UI —— window.api 由 src/renderer/src/dev/mock-api.ts 提供样例数据。
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  server: { port: 5199 },
});
