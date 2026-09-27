import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // 直接指向源码，省掉构建步骤；与 vitest.config.ts 的别名保持一致
      '@lrs/shared': resolvePath('../shared/src/index.ts'),
      '@': resolvePath('./src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/health': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
