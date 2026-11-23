import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'
import { copyFileSync, mkdirSync } from 'fs'

// scoring.ts 运行时 require('../../shared/scoring-universal.js')，rollup externalize 后
// 该文件需实际存在于 dist-electron/shared/。构建后自动拷贝，保证生产/打包可运行。
const copyScoringUniversal = {
  name: 'copy-scoring-universal',
  writeBundle() {
    const dir = resolve(__dirname, 'dist-electron/shared')
    mkdirSync(dir, { recursive: true })
    copyFileSync(resolve(__dirname, 'src/shared/scoring-universal.js'), resolve(dir, 'scoring-universal.js'))
  },
}

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          plugins: [copyScoringUniversal],
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: [
                'puppeteer-core',
                'puppeteer-extra',
                'puppeteer-extra-plugin-stealth',
                'auto-launch',
                'electron',
                // 原生模块：不打包，运行时 require（.node 二进制由 electron-builder asarUnpack）
                'better-sqlite3',
              ],
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
