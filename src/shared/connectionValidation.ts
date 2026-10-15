/**
 * Connection input validation shared by main (`connections:save`) and the
 * renderer's connection dialog. Pure: no Node, Electron or browser imports.
 *
 * The MySQL checks keep the exact messages and order each side used before
 * multi-engine (main throws the first problem, the dialog lists them all);
 * engine rules only add messages for engines other than MySQL.
 */
import { engineOf, isEngineId } from './engines'
import { mcpConfigError } from './mcp'
import type { ConnectionInput, Environment } from './types'

/**
 * OS whose absolute-path rules apply (a `process.platform` value); 'any'
 * accepts POSIX and Windows paths.
 */
export type PathPlatform = string

export interface ValidationOptions {
  /** Defaults to 'any' (the renderer); main passes process.platform. */
  platform?: PathPlatform
  /**
   * Environments that need the typed confirmation (Ajustes › Seguridad). When
   * given, «Lectura y escritura» for agents (MCP) is refused on them.
   */
  typedConfirmEnvironments?: readonly Environment[]
}

/**
 * MongoDB URI options that carry credentials. Secrets go through the
 * credential store only, so these keys are refused in `mongo.extraOptions`.
 */
export const MONGO_CREDENTIAL_OPTION_KEYS = [
  'password',
  'pass',
  'username',
  'user',
  'authMechanismProperties',
  'tlsCertificateKeyFilePassword',
  'sslPass',
  'proxyUsername',
  'proxyPassword'
] as const

const MONGO_CREDENTIAL_KEYS_LOWER = new Set(
  MONGO_CREDENTIAL_OPTION_KEYS.map((k) => k.toLowerCase())
)

export function isMongoCredentialOption(key: string): boolean {
  return MONGO_CREDENTIAL_KEYS_LOWER.has(key.trim().toLowerCase())
}

const POSIX_ABSOLUTE = /^\//
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/

/** Absolute path for `platform` (drive or UNC path on Windows, leading '/' elsewhere). */
export function isAbsolutePathFor(path: string, platform: PathPlatform = 'any'): boolean {
  if (platform === 'any') return POSIX_ABSOLUTE.test(path) || WINDOWS_ABSOLUTE.test(path)
  return platform === 'win32' ? WINDOWS_ABSOLUTE.test(path) : POSIX_ABSOLUTE.test(path)
}

/** Unknown engine, or an engine without a driver in this build. MySQL always passes. */
export function engineAvailabilityError(input: Pick<ConnectionInput, 'engine'>): string | null {
  if (input.engine === undefined || input.engine === null) return null
  if (!isEngineId(input.engine)) {
    return `Motor de base de datos desconocido: "${String(input.engine)}".`
  }
  const engine = engineOf(input)
  return engine.available
    ? null
    : `${engine.label} todavía no está disponible en esta versión de Vortaq.`
}

/** True when the port field is not used (SQLite files, MongoDB SRV records). */
function portUnused(input: ConnectionInput): boolean {
  const engine = engineOf(input)
  if (!engine.capabilities.needsHost) return true
  return engine.id === 'mongodb' && input.mongo?.srv === true
}

/**
 * Rules of the engine blocks (PostgreSQL, SQLite, MongoDB). Empty for MySQL.
 * Assumes a known engine (check `engineAvailabilityError` first).
 */
export function engineBlockErrors(
  input: ConnectionInput,
  options: ValidationOptions = {}
): string[] {
  const platform = options.platform ?? 'any'
  const errors: string[] = []
  const engine = engineOf(input).id
  if (engine === 'postgresql') {
    if (input.postgres && !input.postgres.initialDatabase?.trim()) {
      errors.push('PostgreSQL: la base de datos inicial es obligatoria.')
    }
  } else if (engine === 'sqlite') {
    const sqlite = input.sqlite
    const filePath = sqlite?.filePath?.trim() ?? ''
    if (!filePath) errors.push('SQLite: selecciona el archivo de la base de datos.')
    else if (sqlite?.pathNeedsReview || !isAbsolutePathFor(filePath, platform)) {
      errors.push('SQLite: la ruta del archivo no es válida en este equipo; selecciónalo de nuevo.')
    }
    const aliases = new Set<string>()
    for (const db of sqlite?.attached ?? []) {
      const alias = db.alias?.trim() ?? ''
      const lower = alias.toLowerCase()
      if (!alias) errors.push('SQLite: cada base de datos adjunta necesita un alias.')
      else if (lower === 'main' || lower === 'temp') {
        errors.push(`SQLite: el alias "${alias}" está reservado.`)
      } else if (aliases.has(lower)) errors.push(`SQLite: el alias "${alias}" está repetido.`)
      aliases.add(lower)
      const path = db.filePath?.trim() ?? ''
      if (!path || db.pathNeedsReview || !isAbsolutePathFor(path, platform)) {
        errors.push(
          `SQLite: la ruta de la base de datos adjunta "${alias || '?'}" no es válida; selecciónala de nuevo.`
        )
      }
    }
  } else if (engine === 'mongodb') {
    const mongo = input.mongo
    const ssh = input.ssh?.enabled === true
    if (mongo?.srv && ssh) {
      errors.push('MongoDB: una conexión SRV (mongodb+srv) no puede usar un túnel SSH.')
    } else if (ssh && mongo && mongo.topology !== 'standalone' && !mongo.directConnection) {
      errors.push('MongoDB: con un túnel SSH la conexión debe ser independiente o directa.')
    }
    if (mongo && !mongo.srv && mongo.topology !== 'standalone' && mongo.members.length === 0) {
      errors.push('MongoDB: añade al menos un miembro del conjunto de réplicas o del clúster.')
    }
    for (const key of Object.keys(mongo?.extraOptions ?? {})) {
      if (isMongoCredentialOption(key)) {
        errors.push(
          `MongoDB: la opción "${key}" lleva credenciales y no se puede guardar en las opciones extra.`
        )
      }
    }
  }
  return errors
}

/**
 * Every problem of a connection form, for the connection dialog. For MySQL
 * the list and its messages are the ones the dialog always showed.
 */
export function connectionFormErrors(
  input: ConnectionInput,
  options: ValidationOptions = {}
): string[] {
  const errors: string[] = []
  const engineError = engineAvailabilityError(input)
  if (engineError) return [engineError]
  const engine = engineOf(input)
  if (!input.name.trim()) errors.push('El nombre de la conexión es obligatorio.')
  if (engine.capabilities.needsHost && !input.host.trim()) errors.push('El host es obligatorio.')
  if (!portUnused(input) && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535))
    errors.push('El puerto debe estar entre 1 y 65535.')
  if (engine.capabilities.supportsSsh && input.ssh.enabled) {
    if (!input.ssh.host.trim()) errors.push('SSH: el host es obligatorio.')
    if (!input.ssh.username.trim()) errors.push('SSH: el usuario es obligatorio.')
    if (input.ssh.authType === 'key' && !input.ssh.privateKeyPath?.trim())
      errors.push('SSH: selecciona el archivo de clave privada.')
  }
  errors.push(...engineBlockErrors(input, options))
  const mcp = mcpProblem(input, options)
  if (mcp) errors.push(mcp)
  return errors
}

/** The MCP section's problem when the typed-confirmation environments are known. */
function mcpProblem(input: ConnectionInput, options: ValidationOptions): string | null {
  if (!options.typedConfirmEnvironments) return null
  return mcpConfigError(input, options.typedConfirmEnvironments)
}

/**
 * First problem of a `connections:save` input, or null. For MySQL these are
 * exactly the checks and messages main always applied.
 */
export function connectionSaveError(
  input: ConnectionInput,
  options: ValidationOptions = {}
): string | null {
  const engineError = engineAvailabilityError(input)
  if (engineError) return engineError
  const engine = engineOf(input)
  if (!input.name?.trim()) return 'El nombre de la conexión es obligatorio'
  if (engine.capabilities.needsHost && !input.host?.trim()) {
    return 'El host de la conexión es obligatorio'
  }
  if (
    !portUnused(input) &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
  ) {
    return 'El puerto debe ser un número entre 1 y 65535'
  }
  // MongoDB may sign in without a user; SQLite has none.
  if (
    engine.capabilities.needsHost &&
    !engine.capabilities.passwordOptional &&
    !input.username?.trim()
  ) {
    return 'El usuario de la conexión es obligatorio'
  }
  return engineBlockErrors(input, options)[0] ?? mcpProblem(input, options)
}
