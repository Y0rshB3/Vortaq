import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATION_PENDING, mcpProfileProblem } from './profile'

describe('MCP profile check (never migrates)', () => {
  let appData: string
  let profile: string
  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'vortaq-mcp-profile-'))
    profile = join(appData, 'Vortaq')
  })
  afterEach(() => rmSync(appData, { recursive: true, force: true }))

  const check = (scratch = false) => mcpProfileProblem({ profileDir: profile, appData, scratch })

  it('a fresh computer or a Vortaq profile with connections is fine', () => {
    expect(check()).toBeNull()
    mkdirSync(profile)
    writeFileSync(join(profile, 'connections.json'), '{"version":1,"items":[]}')
    expect(check()).toBeNull()
  })

  it('an ElectronDB or Navidog profile not copied yet asks to open Vortaq once', () => {
    mkdirSync(join(appData, 'ElectronDB'))
    writeFileSync(join(appData, 'ElectronDB', 'connections.json'), '{}')
    expect(check()).toBe(MIGRATION_PENDING)
    // A scratch profile never migrates.
    expect(check(true)).toBeNull()
  })

  it('secrets still pending re-encryption also wait for the app', () => {
    mkdirSync(profile)
    writeFileSync(
      join(profile, 'migrated-from-electrondb.json'),
      JSON.stringify({ source: 'ElectronDB', secrets: 'pending' })
    )
    expect(check()).toBe(MIGRATION_PENDING)
    writeFileSync(
      join(profile, 'migrated-from-electrondb.json'),
      JSON.stringify({ source: 'ElectronDB', secrets: 'done' })
    )
    expect(check()).toBeNull()
  })
})
