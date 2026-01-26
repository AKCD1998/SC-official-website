import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '')
  const base = env.VITE_BASE || '/'

  return {
    base,
    plugins: [react()],
    appType: 'spa',
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: path.resolve(rootDir, 'index.html'),
          '404': path.resolve(rootDir, '404.html'),
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': 'http://localhost:3000',
      },
    },
  }
})
