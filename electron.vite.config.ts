import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Worker de git (task #2): entry próprio — o main carrega
          // out/main/gitWorker.js via worker_threads para tirar o git do
          // thread principal (as travadas de executar/integrar).
          gitWorker: resolve(__dirname, 'src/main/gitWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
