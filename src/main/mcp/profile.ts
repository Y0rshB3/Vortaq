/**
 * The MCP process reads the profile the desktop app writes and never changes
 * it: no profile or secret migration runs here. While a migration from
 * ElectronDB/Navidog is still due (first start under the Vortaq name, or
 * secrets still to re-encrypt), every tool answers with this problem instead.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findLegacyProfiles, readMigrationMarker } from '../migration/profile'

export const MIGRATION_PENDING =
  'Abre Vortaq una vez para terminar de trasladar tus datos de ElectronDB o Navidog (conexiones y contraseñas) y vuelve a intentarlo. El modo para agentes nunca hace ese traslado.'

export interface ProfileFacts {
  /** The Vortaq profile folder this process reads. */
  profileDir: string
  /** <appData>, where earlier product names kept their profiles. */
  appData: string
  /** VORTAQ_USER_DATA is set: a scratch profile never migrates. */
  scratch: boolean
}

/** Why tools cannot run on this profile yet, or null. */
export function mcpProfileProblem(facts: ProfileFacts): string | null {
  const marker = readMigrationMarker(facts.profileDir)
  if (marker) return marker.secrets === 'pending' ? MIGRATION_PENDING : null
  if (facts.scratch) return null
  // The desktop app copies a legacy profile only into a profile without connections.
  if (existsSync(join(facts.profileDir, 'connections.json'))) return null
  const legacy = findLegacyProfiles(facts.appData).some(
    ({ dir }) =>
      existsSync(join(dir, 'connections.json')) || existsSync(join(dir, 'credentials.json'))
  )
  return legacy ? MIGRATION_PENDING : null
}
