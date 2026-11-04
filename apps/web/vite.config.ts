import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same origin for the app and the API (http://localhost:5180), so passkeys,
// cookies and the RP ID all line up in development.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // IPv4: VS Code port forwarding connects here (container 'localhost' is IPv6-only)
    port: 5180,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
