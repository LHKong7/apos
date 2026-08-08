import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      // 走代理而不是直连，SSE 与 API 才同源 —— 否则 EventSource 要处理 CORS，
      // 而 EventSource 不支持自定义头，认证会很别扭
      // ★ target 可用 API_URL 覆盖：3000 是常见的被占端口，
      //   写死会让「端口冲突时把 API 挪到 3001」变成改代码才能做的事
      '/api': {
        target: process.env['API_URL'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
