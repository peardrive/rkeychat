import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// @ts-expect-error pearkit/vite is plain CommonJS without a declaration file
import { pearkit } from 'pearkit/vite';

// The daemon serves app/dist at /app/; in development Vite proxies the API to it.
const DAEMON = 'http://127.0.0.1:4455';
const here = path.dirname(fileURLToPath(import.meta.url));
// PearKit is a file: dependency on a worktree that is being extended as we go, so the app reads
// its sources directly (new components appear without rebuilding lib/).
const PEARKIT_SRC = path.resolve(here, '../../pearkit--projects-shell/src/index.ts');

export default defineConfig({
  base: '/app/',
  plugins: [pearkit()],
  resolve: {
    alias: [{ find: /^pearkit$/, replacement: PEARKIT_SRC }],
    // pearkit lives behind a symlink with its own node_modules: one React, one RNW, one NativeWind.
    dedupe: ['react', 'react-dom', 'react-native', 'react-native-web', 'nativewind', 'react-native-css-interop', 'react-native-svg'],
  },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: DAEMON,
        changeOrigin: true,
        ws: false,
        // SSE: keep the stream flowing; no buffering, no timeouts.
        proxyTimeout: 0,
        timeout: 0,
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache';
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
