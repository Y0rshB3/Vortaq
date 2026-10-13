import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer/src')
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/core/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'scripts/**/*.test.ts',
            'tests/integration/**/*.test.ts'
          ]
        }
      },
      {
        plugins: [vue()],
        resolve: { alias },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.ts'],
          server: { deps: { inline: ['vuetify'] } }
        }
      }
    ]
  }
})
