import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkCoreBoundary, DESKTOP_ONLY_DIRS, DESKTOP_ONLY_FILES, ROOT } from './core-bundle.mjs'

describe('core boundary (src/core/index.ts bundled for Node)', () => {
  it('reaches the core modules and nothing that needs Electron', async () => {
    const result = await checkCoreBoundary()
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    for (const file of [
      'src/core/host.ts',
      'src/main/db/manager.ts',
      'src/main/db/tunnel.ts',
      'src/main/ipc/db.ts',
      'src/main/ipc/productionGuard.ts',
      'src/main/mysql/driver.ts',
      'src/main/postgres/driver.ts',
      'src/main/sqlite/driver.ts',
      'src/main/sqlite/nodeSpawner.ts',
      'src/main/mongo/driver.ts',
      'src/main/backup/archive.ts',
      'src/main/ipc/export.ts',
      'src/main/export/service.ts',
      'src/main/export/sources.ts',
      'src/main/credentials/keyCodec.ts',
      'src/shared/dialects/index.ts',
      'src/shared/typedConfirm.ts'
    ])
      expect(result.inputs, file).toContain(file)
    for (const file of DESKTOP_ONLY_FILES) expect(result.inputs).not.toContain(file)
    for (const dir of DESKTOP_ONLY_DIRS)
      expect(result.inputs.filter((f) => f.startsWith(dir))).toEqual([])
  })

  describe('fails on', () => {
    let dir: string
    const entry = (name: string, source: string): string => {
      writeFileSync(join(dir, name), source)
      return relative(ROOT, join(dir, name))
    }
    const toRepo = (target: string): string => relative(dir, join(ROOT, target))

    beforeAll(() => {
      mkdirSync(join(ROOT, 'tests', 'tmp'), { recursive: true })
      dir = mkdtempSync(join(ROOT, 'tests', 'tmp', 'core-boundary-'))
    })
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
      try {
        rmdirSync(join(ROOT, 'tests', 'tmp'))
      } catch {
        /* other files are still there */
      }
    })

    it("a static electron import, with the importing file and line (type-only ones are ESLint's)", async () => {
      const result = await checkCoreBoundary(
        entry('static.ts', "// first line\nimport { app } from 'electron'\nexport const a = app\n")
      )
      expect(result.ok).toBe(false)
      expect(result.errors).toEqual([
        expect.stringMatching(/static\.ts:2: "electron" is Electron-only.*import-statement/)
      ])
    })

    it('a dynamic import of electron (the old AI net.fetch pattern)', async () => {
      const result = await checkCoreBoundary(
        entry('dynamic.ts', "export const load = () => import('electron')\n")
      )
      expect(result.errors).toEqual([
        expect.stringMatching(/dynamic\.ts:1: "electron" is Electron-only.*dynamic-import/)
      ])
    })

    it('electron-updater', async () => {
      const result = await checkCoreBoundary(
        entry(
          'updater.ts',
          "import { autoUpdater } from 'electron-updater'\nexport { autoUpdater }\n"
        )
      )
      expect(result.errors.join('\n')).toMatch(/"electron-updater" is Electron-only/)
    })

    it('a desktop-only file, also one that never names electron (the utilityProcess worker)', async () => {
      const result = await checkCoreBoundary(
        entry(
          'adapters.ts',
          [
            `import { handle } from '${toRepo('src/main/ipc/typed')}'`,
            "import '@main/sqlite/worker'",
            "import { electronFetch } from '@main/ai/electronFetch'",
            'export { handle, electronFetch }',
            ''
          ].join('\n')
        )
      )
      expect(result.errors).toEqual([
        expect.stringMatching(/adapters\.ts:1: src\/main\/ipc\/typed\.ts is desktop-only/),
        expect.stringMatching(/adapters\.ts:2: src\/main\/sqlite\/worker\.ts is desktop-only/),
        expect.stringMatching(/adapters\.ts:3: src\/main\/ai\/electronFetch\.ts is desktop-only/)
      ])
    })

    it('a desktop-only file that is not TypeScript (a renderer view)', async () => {
      const result = await checkCoreBoundary(
        entry(
          'view.ts',
          `import App from '${toRepo('src/renderer/src/App.vue')}'\nexport { App }\n`
        )
      )
      expect(result.errors).toEqual([
        expect.stringMatching(/view\.ts:1: src\/renderer\/src\/App\.vue is desktop-only/)
      ])
    })

    it('but not on the core modules that replaced them', async () => {
      const result = await checkCoreBoundary(
        entry(
          'ports.ts',
          [
            "import { setAiFetch } from '@main/ai/index'",
            "import { HandlerRegistry } from '@main/ipc/router'",
            "import { nodeSqliteSpawner } from '@main/sqlite/nodeSpawner'",
            'export { setAiFetch, HandlerRegistry, nodeSqliteSpawner }',
            ''
          ].join('\n')
        )
      )
      expect(result.errors).toEqual([])
    })
  })
})
