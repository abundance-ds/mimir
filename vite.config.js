import { defineConfig } from 'vite'
import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [tailwindcss(), vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // CodeMirror and the provider SDK are intentionally isolated heavyweight
    // engines. Their sizes are stable and below this explicit release budget.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        manualChunks: {
          'codemirror': [
            '@codemirror/autocomplete',
            '@codemirror/commands',
            '@codemirror/lang-markdown',
            '@codemirror/language',
            '@codemirror/search',
            '@codemirror/state',
            '@codemirror/view',
            '@lezer/highlight',
          ],
          'ai-sdk': [
            '@ai-sdk/anthropic',
            '@ai-sdk/google',
            '@ai-sdk/openai',
            '@ai-sdk/vue',
            'ai',
          ],
        },
      },
      onwarn(warning, warn) {
        // Tauri core/event are deliberately static shell dependencies. A few
        // lazy editor paths import them defensively; Rollup correctly keeps
        // those imports in the static chunk, so this warning carries no
        // chunking action.
        if (
          warning.message?.includes('dynamically imported by')
          && (
            warning.message.includes('@tauri-apps/api/core.js')
            || warning.message.includes('@tauri-apps/api/event.js')
          )
        ) return
        warn(warning)
      },
    },
  },
})
