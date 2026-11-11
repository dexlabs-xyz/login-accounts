import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same origin for the app and the API (http://localhost:5180), so passkeys,
// cookies and the RP ID all line up in development.
// A second checkout (e.g. the redesign worktree) can run beside the main one: WEB_PORT=5280 API_PORT=8797.
const webPort = Number(process.env.WEB_PORT ?? 5180);
const api = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  // The Railgun SDK (in the worker) imports Node's crypto and stream modules.
  // Railgun ships these browser versions as its own dependencies.
  resolve: {
    alias: {
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
    },
  },
  worker: { format: 'es' },
  // Scan the Railgun worker's imports at startup too. Otherwise Vite discovers
  // them on first unlock, rebuilds, and reloads the page, which locks the
  // wallet (development only).
  optimizeDeps: { entries: ['index.html', 'src/railgun/worker.ts'] },
  server: {
    host: '127.0.0.1', // IPv4: VS Code port forwarding connects here (container 'localhost' is IPv6-only)
    port: webPort,
    strictPort: true,
    // /oidc and /.well-known belong to the OIDC provider in the same API server.
    proxy: {
      '/api': api,
      '/oidc': api,
      '/.well-known': api,
    },
  },
});
