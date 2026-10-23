import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { pwaBuildPlugin } from './vite-plugins/pwaBuildPlugin.ts';

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaBuildPlugin()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/unit/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
  },
});
