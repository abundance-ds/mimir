import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.js', 'review-workflow/**/*.test.js'],
    setupFiles: ['src/test/setup.js'],
    server: {
      deps: {
        inline: ['mammoth'],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js', 'src/**/*.vue'],
      exclude: ['src/test/**', '**/*.test.js'],
    },
  },
})
