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
        // Editor extension (extensions/vscode): host modules with a mocked `vscode`, and the
        // pure webview helpers. Its VS Code integration suite runs with `npm run ext:test`.
        resolve: {
          alias: {
            ...alias,
            '@core': resolve('src/core/index.ts'),
            vscode: resolve('extensions/vscode/test/vscode.mock.ts')
          }
        },
        test: {
          name: 'ext',
          environment: 'node',
          include: ['extensions/vscode/src/**/*.test.ts'],
          // theme.test.ts reads the desktop design tokens (tokens.css?raw).
          css: { include: [/styles\/tokens\.css/] }
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
