/**
 * Screenshots of the extension in a real VS Code (dark, light and high-contrast themes): the
 * results panel with an editable result, the grid menu with «Copiar como», the «Exportar»
 * dialog, the production confirmation, the connection form and MongoDB documents. Runs test/integration/shots.ts in the extension host (like
 * `npm run ext:test`, same servers and cache folder) and captures the window through the
 * DevTools protocol (--remote-debugging-port), so no screen-recording permission is needed.
 *
 *   node extensions/vscode/scripts/screenshots.mjs [output folder]
 *
 * Synthetic data only (the test servers of tests/docker-compose.yml).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildExtension, DIST_TEST, EXT } from './build.mjs'
import { cacheFolder, SERVERS } from './test-integration.mjs'

const PORT = 9339

async function cdp(url, method, params = {}) {
  const ws = new WebSocket(url)
  await new Promise((ok, fail) => {
    ws.onopen = ok
    ws.onerror = () => fail(new Error(`cannot connect to ${url}`))
  })
  try {
    return await new Promise((ok, fail) => {
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        if (message.error) fail(new Error(`${method}: ${message.error.message}`))
        else ok(message.result)
      }
      ws.send(JSON.stringify({ id: 1, method, params }))
    })
  } finally {
    ws.close()
  }
}

async function workbench() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && /workbench/.test(t.url))
  if (!page) throw new Error('VS Code workbench page not found')
  return page
}

/** Runs `script` in each of the extension's webviews (their frames are debug targets too). */
async function inWebviews(script) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const results = []
  for (const t of targets)
    if (t.url.startsWith('vscode-webview://') && t.webSocketDebuggerUrl) {
      const out = await cdp(t.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      }).catch((err) => ({ result: { value: String(err) } }))
      results.push(out?.result?.value)
    }
  return results
}

async function capture(file, request) {
  if (request.webview) {
    console.log(`[shots] webview script: ${JSON.stringify(await inWebviews(request.webview))}`)
    await new Promise((r) => setTimeout(r, 800))
  }
  const page = await workbench()
  const { data } = await cdp(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(file, Buffer.from(data, 'base64'))
}

async function main(out) {
  const testElectron = await import('@vscode/test-electron')
  for (const [env] of SERVERS.slice(0, 1))
    if (!process.env[env]) throw new Error(`${env} is needed for the screenshots`)
  await buildExtension({ dev: true, tests: true })
  mkdirSync(out, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'vortaq-ext-shots-'))
  const steps = join(scratch, 'steps')
  mkdirSync(steps)
  mkdirSync(join(scratch, 'workspace'))
  const settings = join(scratch, 'user-data', 'User')
  mkdirSync(settings, { recursive: true })
  writeFileSync(
    join(settings, 'settings.json'),
    JSON.stringify(
      {
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.startupEditor': 'none',
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.tips.enabled': false,
        'chat.disableAIFeatures': true,
        'editor.minimap.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'security.workspace.trust.enabled': false,
        'window.restoreWindows': 'none',
        'window.newWindowDimensions': 'maximized'
      },
      null,
      2
    )
  )
  const done = new Set()
  let stop = false
  const watcher = (async () => {
    while (!stop) {
      for (const file of existsSync(steps) ? readdirSync(steps) : []) {
        if (!file.endsWith('.ready') || done.has(file)) continue
        done.add(file)
        const name = file.slice(0, -'.ready'.length)
        try {
          const text = readFileSync(join(steps, file), 'utf8')
          await capture(join(out, `${name}.png`), text ? JSON.parse(text) : {})
          console.log(`[shots] ${name}.png`)
        } catch (err) {
          console.error(`[shots] ${name}: ${err instanceof Error ? err.message : err}`)
        }
        writeFileSync(join(steps, `${name}.done`), '')
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  })()
  try {
    const vscodeExecutablePath = await testElectron.downloadAndUnzipVSCode({
      version: process.env.VORTAQ_VSCODE_TEST_VERSION?.trim() || 'stable',
      cachePath: cacheFolder()
    })
    await testElectron.runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: EXT,
      extensionTestsPath: join(DIST_TEST, 'shots.cjs'),
      launchArgs: [
        join(scratch, 'workspace'),
        '--disable-extensions',
        '--user-data-dir',
        join(scratch, 'user-data'),
        '--extensions-dir',
        join(scratch, 'extensions'),
        '--use-inmemory-secretstorage',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-telemetry',
        '--disable-updates',
        `--remote-debugging-port=${PORT}`
      ],
      extensionTestsEnv: {
        VORTAQ_SHOTS_STEPS: steps,
        VORTAQ_EXT_IT_SCRATCH: scratch,
        ...Object.fromEntries(SERVERS.map(([env]) => [env, process.env[env] ?? '']))
      }
    })
  } finally {
    stop = true
    await watcher
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(`[shots] ${out}`)
}

main(resolve(process.argv[2] ?? join(tmpdir(), 'vortaq-ext-shots'))).catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
