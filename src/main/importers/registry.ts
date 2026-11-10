import { existsSync, statSync } from 'node:fs'
import { join, win32 } from 'node:path'
import type { ImportFileFilter, ImportSourceId, ImportSourceInfo } from '@shared/importers'

/**
 * Sources of the «Importar…» wizard. Each one reads only a file or folder the
 * user owns and picks (or confirms at its usual location); none reads another
 * application's keychain, credential manager or registry.
 */

export interface SourceEnvironment {
  home: string
  platform: NodeJS.Platform
  /** %APPDATA% on Windows (roaming application data). */
  appData?: string | null
}

const SQL_FILTERS: ImportFileFilter[] = [
  { name: 'Volcado SQL', extensions: ['sql', 'gz'] },
  { name: 'Todos los archivos', extensions: ['*'] }
]

interface SourceSpec {
  id: ImportSourceId
  flow: ImportSourceInfo['flow']
  label: string
  description: string
  icon: string
  pick: 'file' | 'folder'
  filters: ImportFileFilter[]
  mayContainPasswords: boolean
  /** Usual location of the file on `env.platform`, or null. */
  usualPath(env: SourceEnvironment): string | null
}

/** Joins with the separator of the target platform (Windows paths on any host in tests). */
function joinFor(env: SourceEnvironment, ...parts: string[]): string {
  return env.platform === 'win32' ? win32.join(...parts) : join(...parts)
}

const appDataOf = (env: SourceEnvironment): string =>
  env.appData?.trim() || win32.join(env.home, 'AppData', 'Roaming')

/** DBeaver's workspace file (connections only; its credentials file is never read). */
export function dbeaverDataSourcesPath(env: SourceEnvironment): string | null {
  if (!env.home) return null
  const tail = ['workspace6', 'General', '.dbeaver', 'data-sources.json']
  if (env.platform === 'darwin') return joinFor(env, env.home, 'Library', 'DBeaverData', ...tail)
  if (env.platform === 'win32') return joinFor(env, appDataOf(env), 'DBeaverData', ...tail)
  return joinFor(env, env.home, '.local', 'share', 'DBeaverData', ...tail)
}

/** MySQL Workbench's connections file (its passwords live in the OS keychain: never read). */
export function workbenchConnectionsPath(env: SourceEnvironment): string | null {
  if (!env.home) return null
  if (env.platform === 'darwin')
    return joinFor(
      env,
      env.home,
      'Library',
      'Application Support',
      'MySQL',
      'Workbench',
      'connections.xml'
    )
  if (env.platform === 'win32')
    return joinFor(env, appDataOf(env), 'MySQL', 'Workbench', 'connections.xml')
  return joinFor(env, env.home, '.mysql', 'workbench', 'connections.xml')
}

const SOURCES: SourceSpec[] = [
  {
    id: 'navicat-folder',
    flow: 'navicatFolder',
    label: 'Navicat — carpeta (macOS)',
    description: 'Conexiones, tareas de automatización y copias .nb3 de la carpeta de Navicat.',
    icon: 'mdi-folder-cog-outline',
    pick: 'folder',
    filters: [],
    mayContainPasswords: false,
    usualPath: (env) =>
      env.platform === 'darwin' && env.home
        ? join(env.home, 'Library', 'Application Support', 'PremiumSoft CyberTech', 'Navicat CC')
        : null
  },
  {
    id: 'navicat-ncx',
    flow: 'connections',
    label: 'Navicat — archivo .ncx',
    description:
      'Conexiones exportadas con «Export Connections», con contraseñas si se exportaron.',
    icon: 'mdi-file-key-outline',
    pick: 'file',
    filters: [{ name: 'Conexiones exportadas (.ncx)', extensions: ['ncx'] }],
    mayContainPasswords: true,
    usualPath: () => null
  },
  {
    id: 'dbeaver',
    flow: 'connections',
    label: 'DBeaver',
    description: 'Conexiones MySQL y MariaDB del espacio de trabajo (sin contraseñas).',
    icon: 'mdi-database-arrow-right-outline',
    pick: 'file',
    filters: [{ name: 'data-sources.json', extensions: ['json'] }],
    mayContainPasswords: false,
    usualPath: dbeaverDataSourcesPath
  },
  {
    id: 'workbench',
    flow: 'connections',
    label: 'MySQL Workbench',
    description: 'Conexiones y túneles SSH de connections.xml (sin contraseñas).',
    icon: 'mdi-dolphin',
    pick: 'file',
    filters: [{ name: 'connections.xml', extensions: ['xml'] }],
    mayContainPasswords: false,
    usualPath: workbenchConnectionsPath
  },
  {
    id: 'sql-dump',
    flow: 'sqlDump',
    label: 'Archivo .sql',
    description:
      'Volcado .sql o .sql.gz (mysqldump, phpMyAdmin, HeidiSQL, Adminer, otros gestores).',
    icon: 'mdi-file-document-outline',
    pick: 'file',
    filters: SQL_FILTERS,
    mayContainPasswords: false,
    usualPath: () => null
  },
  {
    id: 'sql-folder',
    flow: 'sqlFolder',
    label: 'Carpeta de volcados .sql',
    description: 'Un archivo por base de datos, importados juntos como un paquete.',
    icon: 'mdi-folder-multiple-outline',
    pick: 'folder',
    filters: [],
    mayContainPasswords: false,
    usualPath: () => null
  },
  {
    id: 'vqb',
    flow: 'nb3',
    label: 'Copia .vqb (Vortaq)',
    description:
      'Restaura una copia .vqb de MySQL, MariaDB o PostgreSQL en una conexión del mismo motor; pide la contraseña si está cifrada.',
    icon: 'mdi-archive-lock-open-outline',
    pick: 'file',
    filters: [{ name: 'Copia .vqb', extensions: ['vqb'] }],
    mayContainPasswords: false,
    usualPath: () => null
  },
  {
    id: 'nb3',
    flow: 'nb3',
    label: 'Copia .nb3 (Navicat/Vortaq)',
    description: 'Restaura una copia .nb3 en una conexión.',
    icon: 'mdi-archive-arrow-up-outline',
    pick: 'file',
    filters: [{ name: 'Copia .nb3', extensions: ['nb3'] }],
    mayContainPasswords: false,
    usualPath: () => null
  }
]

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isImportSourceId(value: unknown): value is ImportSourceId {
  return typeof value === 'string' && SOURCES.some((s) => s.id === value)
}

/** The source spec; throws an actionable error for an unknown id. */
export function sourceSpec(id: unknown): SourceSpec {
  const spec = SOURCES.find((s) => s.id === id)
  if (!spec) throw new Error('Origen de importación desconocido.')
  return spec
}

/** Usual file of a source when it exists on this computer (only files, never folders). */
export function detectedPathOf(id: ImportSourceId, env: SourceEnvironment): string | null {
  const spec = sourceSpec(id)
  if (spec.pick !== 'file') return null
  const path = spec.usualPath(env)
  return path && isFile(path) ? path : null
}

/** Every source with its usual location on this OS and whether that file exists. */
export function listImportSources(env: SourceEnvironment): ImportSourceInfo[] {
  return SOURCES.map((spec) => {
    const hint = spec.usualPath(env)
    return {
      id: spec.id,
      flow: spec.flow,
      label: spec.label,
      description: spec.description,
      icon: spec.icon,
      pick: spec.pick,
      filters: spec.filters,
      defaultPathHint: hint,
      detectedPath: spec.pick === 'file' && hint && isFile(hint) ? hint : null,
      mayContainPasswords: spec.mayContainPasswords
    }
  })
}

/** Remembers the files and folders the user picked in this session (main side). */
export class PickedPaths {
  private readonly paths = new Set<string>()

  add(path: string): void {
    this.paths.add(path)
  }

  /** True for a picked file, or a file directly inside a picked folder. */
  allows(path: string): boolean {
    if (this.paths.has(path)) return true
    for (const p of this.paths) {
      if (path.startsWith(p) && /^[\\/][^\\/]+$/.test(path.slice(p.length))) return true
    }
    return false
  }

  has(path: string): boolean {
    return this.paths.has(path)
  }
}

/** File-system check used before reading a picked path. */
export function existsAsFile(path: string): boolean {
  return existsSync(path) && isFile(path)
}
