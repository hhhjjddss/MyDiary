import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5399,
    open: false,
    proxy: {
      '/api': {
        target: 'http://localhost:4399',
        changeOrigin: true,
      },
      '/images': {
        target: 'http://localhost:4399',
        changeOrigin: true,
      },
    },
  },
})
