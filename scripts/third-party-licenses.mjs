/* global process, console */
/**
 * Writes THIRD_PARTY_LICENSES.txt: the licence notices of every production
 * dependency shipped inside Vortaq, plus Electron/Chromium. Run by
 * `npm run build` (the file lands in out/ and electron-builder ships it as an
 * extraResource next to LICENSE); «Acerca de Vortaq» shows it.
 *
 *   node scripts/third-party-licenses.mjs [output file]   (default out/THIRD_PARTY_LICENSES.txt)
 *
 * No extra tooling: the package list comes from package-lock.json (entries not
 * marked dev, and present on disk) and each package's own LICENSE / LICENCE /
 * COPYING / NOTICE files. A package that ships no licence file is listed with
 * its SPDX id and repository.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i
const RULE = '='.repeat(78)

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** SPDX id from a package.json `license` / legacy `licenses` field. */
export function licenseId(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses))
    return pkg.licenses
      .map((l) => (typeof l === 'string' ? l : l?.type))
      .filter(Boolean)
      .join(' OR ')
  return 'UNKNOWN'
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return (repo || pkg.homepage || '').replace(/^git\+/, '').replace(/\.git$/, '')
}

function licenseTexts(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => LICENSE_FILE.test(n))
    .sort()
    .filter((n) => statSync(join(dir, n)).isFile())
    .map((n) => ({ file: n, text: readFileSync(join(dir, n), 'utf8').trim() }))
}

/**
 * Name, version, licence, origin and licence texts of the package installed in
 * `dir` (a node_modules/<name> folder). Also used by the editor extension's
 * build for the packages its bundles contain.
 */
export function describePackage(dir, fallbackName) {
  const pkg = readJson(join(dir, 'package.json'))
  return {
    name: pkg.name ?? fallbackName ?? dir.split(/[\\/]/).pop(),
    version: pkg.version,
    license: licenseId(pkg),
    repository: repositoryOf(pkg),
    texts: licenseTexts(dir)
  }
}

/**
 * Production packages of `root` (package-lock.json v2/v3), sorted by name.
 * Dev-only entries and optional packages that are not installed are left out.
 */
export function collectPackages(root) {
  const lock = readJson(join(root, 'package-lock.json'))
  const seen = new Map()
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/') || entry.dev || entry.devOptional || entry.link) continue
    const dir = join(root, path)
    if (!existsSync(join(dir, 'package.json'))) continue
    const described = describePackage(dir, path.slice(path.lastIndexOf('node_modules/') + 13))
    const key = `${described.name}@${described.version}`
    if (seen.has(key)) continue
    seen.set(key, described)
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  )
}

/** Electron (MIT) and the note about Chromium's own notices. */
function electronSection(root) {
  const dir = join(root, 'node_modules', 'electron')
  if (!existsSync(join(dir, 'package.json'))) return null
  const pkg = readJson(join(dir, 'package.json'))
  return {
    name: 'electron',
    version: pkg.version,
    license: licenseId(pkg),
    repository: repositoryOf(pkg),
    texts: licenseTexts(dir),
    note:
      'Vortaq se ejecuta sobre Electron, que incluye Chromium y Node.js. Sus avisos de licencia ' +
      'completos se instalan con la aplicación en el archivo LICENSES.chromium.html (junto al ' +
      'ejecutable en Windows y Linux; en Contents/Resources del paquete .app en macOS).'
  }
}

export function renderPackage(p) {
  const lines = [RULE, `${p.name} ${p.version}`, `Licencia: ${p.license}`]
  if (p.repository) lines.push(`Origen: ${p.repository}`)
  if (p.note) lines.push('', p.note)
  if (p.texts.length) {
    for (const t of p.texts) lines.push('', `--- ${t.file} ---`, '', t.text)
  } else {
    lines.push(
      '',
      'El paquete no incluye un archivo de licencia; se distribuye con la licencia indicada arriba.'
    )
  }
  return lines.join('\n')
}

export function renderNotices({ appName, appVersion, packages, electron }) {
  const counts = new Map()
  for (const p of packages) counts.set(p.license, (counts.get(p.license) ?? 0) + 1)
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, n]) => `  ${id}: ${n}`)
  const head = [
    `${appName} ${appVersion} — Licencias de terceros`,
    '',
    `${appName} es software libre con licencia MIT (archivo LICENSE). Incluye los componentes de código abierto listados a continuación, cada uno con su licencia y su aviso de copyright, tal como los publican sus autores. Las fuentes Inter y JetBrains Mono se distribuyen con la SIL Open Font License 1.1 y los iconos Material Design Icons con la licencia de Pictogrammers (ver sus secciones).`,
    '',
    `Componentes: ${packages.length + (electron ? 1 : 0)}`,
    ...summary
  ]
  return [
    head.join('\n'),
    ...(electron ? [renderPackage(electron)] : []),
    ...packages.map(renderPackage),
    RULE,
    ''
  ].join('\n\n')
}

export function generateNotices(root) {
  const pkg = readJson(join(root, 'package.json'))
  return renderNotices({
    appName: pkg.productName ?? pkg.name,
    appVersion: pkg.version,
    packages: collectPackages(root),
    electron: electronSection(root)
  })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const out = resolve(root, process.argv[2] ?? join('out', 'THIRD_PARTY_LICENSES.txt'))
  mkdirSync(dirname(out), { recursive: true })
  const text = generateNotices(root)
  writeFileSync(out, text)
  console.log(`[licenses] ${out} (${Math.round(text.length / 1024)} KB)`)
}
