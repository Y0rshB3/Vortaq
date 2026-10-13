/* global process, console, fetch */
/**
 * Writes the README download badges (shields.io "endpoint" JSON) counting only
 * real downloads: installers and app packages (.dmg, .zip, .exe, .AppImage,
 * .deb). latest*.yml (read by every update check), blockmaps and
 * SHA256SUMS.txt are left out. Run hourly by .github/workflows/download-badges.yml.
 *
 *   node scripts/download-badges.mjs <out dir>
 *
 * Env: GITHUB_TOKEN (optional, higher rate limit), GITHUB_REPOSITORY (default Y0rshB3/Vortaq).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const INSTALLER = /\.(dmg|zip|exe|AppImage|deb)$/i

/** Downloads of installer files in one release. */
export function installerDownloads(release) {
  return (release.assets ?? [])
    .filter((a) => INSTALLER.test(a.name))
    .reduce((sum, a) => sum + (a.download_count ?? 0), 0)
}

export const DESKTOP_TAG = /^v\d/

/** The newest published desktop release, or undefined. */
export function latestDesktopRelease(releases) {
  return releases
    .filter((r) => !r.draft && !r.prerelease && DESKTOP_TAG.test(r.tag_name ?? ''))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0]
}

/** shields.io endpoint badge for a count. */
export function badge(label, count, color) {
  return { schemaVersion: 1, label, message: String(count), color, cacheSeconds: 1800 }
}

async function releases(repo, token) {
  const out = []
  for (let page = 1; page < 20; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }
    )
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const batch = await res.json()
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

async function main() {
  const dir = process.argv[2] ?? 'badges'
  const repo = process.env.GITHUB_REPOSITORY || 'Y0rshB3/Vortaq'
  const all = (await releases(repo, process.env.GITHUB_TOKEN)).filter(
    (r) => !r.draft && !r.prerelease
  )
  const latest = latestDesktopRelease(all)
  const latestCount = latest ? installerDownloads(latest) : 0
  const total = all.reduce((sum, r) => sum + installerDownloads(r), 0)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'downloads-latest.json'),
    JSON.stringify(badge(`descargas ${latest?.tag_name ?? ''}`.trim(), latestCount, 'f59e0b')) +
      '\n'
  )
  writeFileSync(
    join(dir, 'downloads-total.json'),
    JSON.stringify(badge('descargas totales', total, 'ec4899')) + '\n'
  )
  console.log(`${latest?.tag_name ?? '-'}: ${latestCount} · total: ${total}`)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
