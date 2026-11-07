import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Local proxy: the browser calls /api, so no CORS is needed against the backend.
const proxy = {
  '/api': {
    target: process.env.BACKEND_URL ?? 'http://localhost:8000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  // Relative assets: the build must also work as a Dynamics 365 HTML web resource.
  base: './',
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022' },
  server: { proxy },
  preview: { proxy },
});
