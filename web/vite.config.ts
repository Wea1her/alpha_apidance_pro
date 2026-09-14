import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 前端构建配置（Q12、Q21）。
 *
 * - root 指向 web/：配置从仓库根目录调用时也能解析 index.html；
 * - 开发时把 /api 代理到本地 API 服务，前端不硬编码后端地址；
 * - 产物输出到 web/dist，由 API 服务同域托管（第 7 节：同域部署，避免跨域与 Cookie 问题）。
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3080',
        changeOrigin: false
      }
    }
  }
});
