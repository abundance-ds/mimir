import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.js'],
    setupFiles: ['src/test/setup.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js', 'src/**/*.vue'],
      exclude: ['src/test/**', '**/*.test.js'],
      thresholds: {
        lines: 65,
        statements: 62,
        functions: 57,
        branches: 53,
      },
    },
  },
})
