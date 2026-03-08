import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api':     { target: 'http://gateway:8000', changeOrigin: true },
      '/auth':    { target: 'http://gateway:8000', changeOrigin: true },
      '/storage': { target: 'http://minio:9000',   changeOrigin: true, rewrite: path => path.replace(/^\/storage/, '') },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
