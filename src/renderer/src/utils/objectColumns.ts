import type {
  BackupFile,
  DatabaseInfo,
  EngineId,
  EventInfo,
  MongoCollectionInfo,
  ObjectSummary,
  RoutineInfo,
  SchemaInfo,
  TableInfo,
  ViewInfo
} from '@shared/types'
import type { SavedQuery } from './savedQueries'
import { formatBytes, formatDate, formatNumber } from './format'
import type { GroupKind } from './objectTypes'

/**
 * Column definitions and detail rows for the Objects list and the Info panel.
 * Pure functions only: no store access, so they are trivially testable.
 */

export type ObjectItem =
  | TableInfo
  | ViewInfo
  | RoutineInfo
  | EventInfo
  | SavedQuery
  | BackupFile
  | ObjectSummary
  | MongoCollectionInfo

export interface ObjectColumn<T = unknown> {
  key: string
  title: string
  align?: 'start' | 'end'
  /** Raw value used for sorting. */
  value: (item: T) => string | number | null
  /** Text shown in the cell; defaults to String(value). */
  display?: (item: T) => string
}

export interface DetailRow {
  label: string
  value: string
}

const text = (v: string | null | undefined): string =>
  v === null || v === undefined || v === '' ? '' : v
const dateValue = (v: string | null | undefined): string => text(v)

function col<T>(column: ObjectColumn<T>): ObjectColumn<unknown> {
  return column as ObjectColumn<unknown>
}

export const DATABASE_COLUMNS: ObjectColumn<unknown>[] = [
  col<DatabaseInfo>({ key: 'name', title: 'Nombre', value: (d) => d.name }),
  col<DatabaseInfo>({ key: 'charset', title: 'Juego de caracteres', value: (d) => d.characterSet }),
  col<DatabaseInfo>({ key: 'collation', title: 'Intercalación', value: (d) => d.collation })
]

/** PostgreSQL: schemas of a database (db:schemas). */
export const SCHEMA_COLUMNS: ObjectColumn<unknown>[] = [
  col<SchemaInfo>({ key: 'name', title: 'Nombre', value: (s) => s.name }),
  col<SchemaInfo>({ key: 'owner', title: 'Propietario', value: (s) => s.owner }),
  col<SchemaInfo>({ key: 'comment', title: 'Comentario', value: (s) => s.comment })
]

export const GROUP_COLUMNS: Record<GroupKind, ObjectColumn<unknown>[]> = {
  tables: [
    col<TableInfo>({ key: 'name', title: 'Nombre', value: (t) => t.name }),
    col<TableInfo>({
      key: 'rows',
      title: 'Filas',
      align: 'end',
      value: (t) => t.rows,
      display: (t) => formatNumber(t.rows)
    }),
    col<TableInfo>({
      key: 'dataLength',
      title: 'Longitud de datos',
      align: 'end',
      value: (t) => t.dataLength,
      display: (t) => formatBytes(t.dataLength)
    }),
    col<TableInfo>({ key: 'engine', title: 'Motor', value: (t) => t.engine }),
    col<TableInfo>({
      key: 'createTime',
      title: 'Fecha de creación',
      value: (t) => dateValue(t.createTime),
      display: (t) => formatDate(t.createTime)
    }),
    col<TableInfo>({
      key: 'updateTime',
      title: 'Fecha de modificación',
      value: (t) => dateValue(t.updateTime),
      display: (t) => formatDate(t.updateTime)
    }),
    col<TableInfo>({ key: 'collation', title: 'Intercalación', value: (t) => t.collation }),
    col<TableInfo>({ key: 'comment', title: 'Comentario', value: (t) => t.comment })
  ],
  views: [
    col<ViewInfo>({ key: 'name', title: 'Nombre', value: (v) => v.name }),
    col<ViewInfo>({ key: 'definer', title: 'Definidor', value: (v) => v.definer }),
    col<ViewInfo>({ key: 'security', title: 'Seguridad', value: (v) => v.security }),
    col<ViewInfo>({
      key: 'updatable',
      title: 'Actualizable',
      value: (v) => (v.updatable ? 1 : 0),
      display: (v) => (v.updatable ? 'Sí' : 'No')
    }),
    col<ViewInfo>({
      key: 'createTime',
      title: 'Fecha de creación',
      value: (v) => dateValue(v.createTime),
      display: (v) => formatDate(v.createTime)
    })
  ],
  functions: [
    col<RoutineInfo>({ key: 'name', title: 'Nombre', value: (r) => r.name }),
    col<RoutineInfo>({
      key: 'type',
      title: 'Tipo',
      value: (r) => r.type,
      display: (r) => (r.type === 'PROCEDURE' ? 'Procedimiento' : 'Función')
    }),
    col<RoutineInfo>({ key: 'returns', title: 'Devuelve', value: (r) => r.returns }),
    col<RoutineInfo>({ key: 'definer', title: 'Definidor', value: (r) => r.definer }),
    col<RoutineInfo>({
      key: 'created',
      title: 'Fecha de creación',
      value: (r) => dateValue(r.created),
      display: (r) => formatDate(r.created)
    }),
    col<RoutineInfo>({
      key: 'modified',
      title: 'Fecha de modificación',
      value: (r) => dateValue(r.modified),
      display: (r) => formatDate(r.modified)
    }),
    col<RoutineInfo>({ key: 'comment', title: 'Comentario', value: (r) => r.comment })
  ],
  events: [
    col<EventInfo>({ key: 'name', title: 'Nombre', value: (e) => e.name }),
    col<EventInfo>({ key: 'status', title: 'Estado', value: (e) => e.status }),
    col<EventInfo>({ key: 'type', title: 'Tipo', value: (e) => e.type }),
    col<EventInfo>({ key: 'schedule', title: 'Programación', value: (e) => eventSchedule(e) }),
    col<EventInfo>({ key: 'definer', title: 'Definidor', value: (e) => e.definer }),
    col<EventInfo>({
      key: 'modified',
      title: 'Fecha de modificación',
      value: (e) => dateValue(e.modified),
      display: (e) => formatDate(e.modified)
    }),
    col<EventInfo>({ key: 'comment', title: 'Comentario', value: (e) => e.comment })
  ],
  queries: [
    col<SavedQuery>({ key: 'name', title: 'Nombre', value: (q) => q.name }),
    col<SavedQuery>({ key: 'schema', title: 'Base de datos', value: (q) => q.schema }),
    col<SavedQuery>({
      key: 'updatedAt',
      title: 'Fecha de modificación',
      value: (q) => q.updatedAt,
      display: (q) => formatDate(q.updatedAt)
    })
  ],
  backups: [
    col<BackupFile>({ key: 'name', title: 'Nombre', value: (b) => b.fileName }),
    col<BackupFile>({ key: 'label', title: 'Comentario', value: (b) => b.label }),
    col<BackupFile>({
      key: 'size',
      title: 'Tamaño',
      align: 'end',
      value: (b) => b.sizeBytes,
      display: (b) => formatBytes(b.sizeBytes)
    }),
    col<BackupFile>({
      key: 'modifiedAt',
      title: 'Fecha de modificación',
      value: (b) => b.modifiedAt,
      display: (b) => formatDate(b.modifiedAt)
    }),
    col<BackupFile>({
      key: 'source',
      title: 'Origen',
      value: (b) => b.source,
      display: (b) => BACKUP_SOURCE_LABELS[b.source] ?? b.source
    })
  ],
  materializedViews: [
    col<ObjectSummary>({ key: 'name', title: 'Nombre', value: (o) => o.name }),
    col<ObjectSummary>({
      key: 'rows',
      title: 'Filas (estimadas)',
      align: 'end',
      value: (o) => o.rows ?? null,
      display: (o) => (o.rows === null || o.rows === undefined ? '—' : formatNumber(o.rows))
    }),
    col<ObjectSummary>({
      key: 'size',
      title: 'Tamaño',
      align: 'end',
      value: (o) => o.sizeBytes ?? null,
      display: (o) => formatBytes(o.sizeBytes ?? null)
    }),
    col<ObjectSummary>({ key: 'owner', title: 'Propietario', value: (o) => o.owner ?? '' }),
    col<ObjectSummary>({ key: 'detail', title: 'Estado', value: (o) => o.detail ?? '' }),
    col<ObjectSummary>({ key: 'comment', title: 'Comentario', value: (o) => o.comment ?? '' })
  ],
  sequences: [
    col<ObjectSummary>({ key: 'name', title: 'Nombre', value: (o) => o.name }),
    col<ObjectSummary>({ key: 'kind', title: 'Tipo', value: (o) => o.kind ?? '' }),
    col<ObjectSummary>({
      key: 'detail',
      title: 'Valor actual',
      align: 'end',
      value: (o) => o.detail ?? ''
    }),
    col<ObjectSummary>({ key: 'table', title: 'Pertenece a', value: (o) => o.table ?? '' }),
    col<ObjectSummary>({ key: 'owner', title: 'Propietario', value: (o) => o.owner ?? '' }),
    col<ObjectSummary>({ key: 'comment', title: 'Comentario', value: (o) => o.comment ?? '' })
  ],
  types: [
    col<ObjectSummary>({ key: 'name', title: 'Nombre', value: (o) => o.name }),
    col<ObjectSummary>({
      key: 'kind',
      title: 'Clase',
      value: (o) => o.kind ?? '',
      display: (o) => TYPE_KIND_LABELS[o.kind ?? ''] ?? o.kind ?? ''
    }),
    col<ObjectSummary>({ key: 'detail', title: 'Definición', value: (o) => o.detail ?? '' }),
    col<ObjectSummary>({ key: 'owner', title: 'Propietario', value: (o) => o.owner ?? '' }),
    col<ObjectSummary>({ key: 'comment', title: 'Comentario', value: (o) => o.comment ?? '' })
  ],
  // SQLite (preview)
  indexes: [
    col<ObjectSummary>({ key: 'name', title: 'Nombre', value: (o) => o.name }),
    col<ObjectSummary>({ key: 'table', title: 'Tabla', value: (o) => o.table ?? '' }),
    col<ObjectSummary>({ key: 'kind', title: 'Tipo', value: (o) => o.kind ?? '' }),
    col<ObjectSummary>({ key: 'detail', title: 'Columnas', value: (o) => o.detail ?? '' })
  ],
  triggers: [
    col<ObjectSummary>({ key: 'name', title: 'Nombre', value: (o) => o.name }),
    col<ObjectSummary>({ key: 'table', title: 'Tabla', value: (o) => o.table ?? '' }),
    col<ObjectSummary>({
      key: 'kind',
      title: 'Cuándo',
      value: (o) => o.kind ?? '',
      display: (o) => (o.kind ?? '').toUpperCase()
    })
  ],
  // MongoDB (preview): $collStats columns (section 9.1)
  collections: [
    col<MongoCollectionInfo>({ key: 'name', title: 'Nombre', value: (c) => c.name }),
    col<MongoCollectionInfo>({
      key: 'count',
      title: 'Documentos',
      align: 'end',
      value: (c) => c.count,
      display: (c) => (c.count === null ? '—' : formatNumber(c.count))
    }),
    col<MongoCollectionInfo>({
      key: 'size',
      title: 'Tamaño',
      align: 'end',
      value: (c) => c.sizeBytes,
      display: (c) => formatBytes(c.sizeBytes)
    }),
    col<MongoCollectionInfo>({
      key: 'storage',
      title: 'Almacenamiento',
      align: 'end',
      value: (c) => c.storageSizeBytes,
      display: (c) => formatBytes(c.storageSizeBytes)
    }),
    col<MongoCollectionInfo>({
      key: 'indexes',
      title: 'Índices',
      align: 'end',
      value: (c) => c.indexCount,
      display: (c) => (c.indexCount === null ? '—' : formatNumber(c.indexCount))
    }),
    col<MongoCollectionInfo>({
      key: 'avg',
      title: 'Tamaño medio',
      align: 'end',
      value: (c) => c.avgObjSizeBytes,
      display: (c) => formatBytes(c.avgObjSizeBytes)
    }),
    col<MongoCollectionInfo>({
      key: 'readOnly',
      title: 'Notas',
      value: (c) => (c.type === 'timeseries' ? 'serie temporal' : c.capped ? 'limitada' : '')
    })
  ]
}

/** MongoDB columns for the groups it shares (views and indexes). */
const MONGO_GROUP_COLUMNS: Partial<Record<GroupKind, ObjectColumn<unknown>[]>> = {
  views: [
    col<MongoCollectionInfo>({ key: 'name', title: 'Nombre', value: (v) => v.name }),
    col<MongoCollectionInfo>({ key: 'viewOn', title: 'Sobre', value: (v) => v.viewOn ?? '' })
  ],
  indexes: [
    col<ObjectSummary>({
      key: 'name',
      title: 'Nombre',
      value: (o) => (o.table ? o.name.slice(o.table.length + 1) : o.name)
    }),
    col<ObjectSummary>({ key: 'table', title: 'Colección', value: (o) => o.table ?? '' }),
    col<ObjectSummary>({ key: 'kind', title: 'Tipo', value: (o) => o.kind ?? '' }),
    col<ObjectSummary>({ key: 'detail', title: 'Claves', value: (o) => o.detail ?? '' })
  ]
}

/** SQLite columns: no sizes, dates, collations or definers in the catalog. */
const SQLITE_GROUP_COLUMNS: Partial<Record<GroupKind, ObjectColumn<unknown>[]>> = {
  tables: [
    col<TableInfo>({ key: 'name', title: 'Nombre', value: (t) => t.name }),
    col<TableInfo>({ key: 'engine', title: 'Tipo', value: (t) => t.engine ?? '' }),
    col<TableInfo>({
      key: 'autoIncrement',
      title: 'Auto incremento',
      align: 'end',
      value: (t) => t.autoIncrement,
      display: (t) => (t.autoIncrement === null ? '' : formatNumber(t.autoIncrement))
    })
  ],
  views: [col<ViewInfo>({ key: 'name', title: 'Nombre', value: (v) => v.name })]
}

const TYPE_KIND_LABELS: Record<string, string> = {
  enum: 'Enumerado',
  domain: 'Dominio',
  composite: 'Compuesto',
  range: 'Rango'
}

const ROUTINE_KIND_LABELS: Record<string, string> = {
  function: 'Función',
  procedure: 'Procedimiento',
  'trigger function': 'Función de disparador'
}

/**
 * PostgreSQL columns for the groups whose MySQL columns do not apply (no
 * storage engine, collation or creation dates); MySQL keeps GROUP_COLUMNS.
 */
const PG_GROUP_COLUMNS: Partial<Record<GroupKind, ObjectColumn<unknown>[]>> = {
  tables: [
    col<TableInfo>({ key: 'name', title: 'Nombre', value: (t) => t.name }),
    col<TableInfo>({
      key: 'rows',
      title: 'Filas (estimadas)',
      align: 'end',
      value: (t) => t.rows,
      display: (t) => (t.rows === null ? '—' : formatNumber(t.rows))
    }),
    col<TableInfo>({
      key: 'dataLength',
      title: 'Tamaño',
      align: 'end',
      value: (t) => t.dataLength,
      display: (t) => formatBytes(t.dataLength)
    }),
    col<TableInfo>({
      key: 'indexLength',
      title: 'Índices',
      align: 'end',
      value: (t) => t.indexLength,
      display: (t) => formatBytes(t.indexLength)
    }),
    col<TableInfo>({ key: 'engine', title: 'Tipo', value: (t) => t.engine }),
    col<TableInfo>({ key: 'comment', title: 'Comentario', value: (t) => t.comment })
  ],
  views: [
    col<ViewInfo>({ key: 'name', title: 'Nombre', value: (v) => v.name }),
    col<ViewInfo>({ key: 'definer', title: 'Propietario', value: (v) => v.definer }),
    col<ViewInfo>({ key: 'security', title: 'Seguridad', value: (v) => v.security }),
    col<ViewInfo>({
      key: 'updatable',
      title: 'Actualizable',
      value: (v) => (v.updatable ? 1 : 0),
      display: (v) => (v.updatable ? 'Sí' : 'No')
    })
  ],
  functions: [
    col<RoutineInfo>({ key: 'name', title: 'Nombre', value: (r) => r.name }),
    col<RoutineInfo>({ key: 'signature', title: 'Argumentos', value: (r) => r.signature ?? '' }),
    col<RoutineInfo>({
      key: 'type',
      title: 'Tipo',
      value: (r) => r.kind ?? r.type,
      display: (r) => ROUTINE_KIND_LABELS[r.kind ?? ''] ?? r.type
    }),
    col<RoutineInfo>({ key: 'returns', title: 'Devuelve', value: (r) => r.returns }),
    col<RoutineInfo>({ key: 'definer', title: 'Propietario', value: (r) => r.definer }),
    col<RoutineInfo>({ key: 'comment', title: 'Comentario', value: (r) => r.comment })
  ]
}

/** MariaDB sequences: options instead of PostgreSQL's current value and owner. */
const MARIADB_GROUP_COLUMNS: Partial<Record<GroupKind, ObjectColumn<unknown>[]>> = {
  sequences: [
    col<ObjectSummary>({ key: 'name', title: 'Nombre', value: (o) => o.name }),
    col<ObjectSummary>({ key: 'kind', title: 'Tipo', value: (o) => o.kind ?? '' }),
    col<ObjectSummary>({ key: 'detail', title: 'Definición', value: (o) => o.detail ?? '' }),
    col<ObjectSummary>({ key: 'comment', title: 'Comentario', value: (o) => o.comment ?? '' })
  ]
}

/** SQL Server: MySQL's table/view/routine columns fit its catalog; sequences like PostgreSQL. */
const MS_GROUP_COLUMNS: Partial<Record<GroupKind, ObjectColumn<unknown>[]>> = {
  sequences: PG_GROUP_COLUMNS.sequences
}

/** Columns of a group for a connection's engine (MySQL: GROUP_COLUMNS unchanged). */
export function columnsFor(group: GroupKind, engine?: EngineId | null): ObjectColumn<unknown>[] {
  if (engine === 'mariadb') return MARIADB_GROUP_COLUMNS[group] ?? GROUP_COLUMNS[group]
  if (engine === 'postgresql') return PG_GROUP_COLUMNS[group] ?? GROUP_COLUMNS[group]
  if (engine === 'sqlite') return SQLITE_GROUP_COLUMNS[group] ?? GROUP_COLUMNS[group]
  if (engine === 'sqlserver') return MS_GROUP_COLUMNS[group] ?? GROUP_COLUMNS[group]
  if (engine === 'mongodb') return MONGO_GROUP_COLUMNS[group] ?? GROUP_COLUMNS[group]
  return GROUP_COLUMNS[group]
}

const BACKUP_SOURCE_LABELS: Record<string, string> = {
  navicat: 'Navicat',
  vortaq: 'Vortaq',
  unknown: 'Desconocido'
}

export function eventSchedule(e: EventInfo): string {
  if (e.executeAt) return `Una vez: ${formatDate(e.executeAt)}`
  if (e.intervalValue && e.intervalField) return `Cada ${e.intervalValue} ${e.intervalField}`
  return ''
}

export function cellText(column: ObjectColumn<unknown>, item: unknown): string {
  if (column.display) return column.display(item)
  const v = column.value(item)
  return v === null || v === undefined ? '' : String(v)
}

/**
 * Identifier used in tree node ids (saved query id, backup path or object name).
 * PostgreSQL routines are `name(identity args)`: overloads share a name.
 */
export function itemName(group: GroupKind, item: unknown): string {
  const raw = item as { name?: string; id?: string; path?: string; signature?: string }
  if (group === 'queries') return raw.id ?? ''
  if (group === 'backups') return raw.path ?? ''
  if (group === 'functions' && raw.signature !== undefined)
    return `${raw.name ?? ''}(${raw.signature})`
  return raw.name ?? ''
}

/** Human label for an item. */
export function itemLabel(group: GroupKind, item: unknown): string {
  const raw = item as { name?: string; fileName?: string; signature?: string }
  if (group === 'backups') return raw.fileName ?? ''
  if (group === 'functions' && raw.signature !== undefined)
    return `${raw.name ?? ''}(${raw.signature})`
  return raw.name ?? ''
}

/**
 * Splits a PostgreSQL routine node name `name(args)` back into its parts;
 * a name without arguments (MySQL) has no signature.
 */
export function splitRoutineName(nodeName: string): { name: string; signature?: string } {
  const open = nodeName.indexOf('(')
  if (open <= 0 || !nodeName.endsWith(')')) return { name: nodeName }
  return { name: nodeName.slice(0, open), signature: nodeName.slice(open + 1, -1) }
}

export function compareCells(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0
  if (a === null || a === '') return -1
  if (b === null || b === '') return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' })
}

export function sortItems<T>(
  items: T[],
  column: ObjectColumn<unknown> | undefined,
  desc: boolean
): T[] {
  if (!column) return items
  const sorted = [...items].sort((x, y) => compareCells(column.value(x), column.value(y)))
  return desc ? sorted.reverse() : sorted
}

export function filterItems<T>(items: T[], group: GroupKind | null, query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => {
    const label = group ? itemLabel(group, item) : ((item as { name?: string }).name ?? '')
    return label.toLowerCase().includes(q)
  })
}

const row = (label: string, value: string | null | undefined): DetailRow => ({
  label,
  value: text(value) || '—'
})

/** Detail rows shown in the Info panel for a selected object. */
export function objectDetails(
  group: GroupKind,
  item: unknown,
  engine?: EngineId | null
): DetailRow[] {
  switch (group) {
    case 'tables': {
      const t = item as TableInfo
      return [
        row('Filas', formatNumber(t.rows)),
        row('Motor', t.engine),
        row('Longitud de datos', formatBytes(t.dataLength)),
        row('Longitud de índice', formatBytes(t.indexLength)),
        row('Auto incremento', formatNumber(t.autoIncrement)),
        row('Fecha de creación', formatDate(t.createTime)),
        row('Fecha de modificación', formatDate(t.updateTime)),
        row('Intercalación', t.collation),
        row('Comentario', t.comment)
      ]
    }
    case 'views': {
      if ('readOnlyReason' in (item as object)) {
        // MongoDB view: its source collection.
        const mv = item as MongoCollectionInfo
        return [row('Sobre', mv.viewOn), row('Edición', mv.readOnlyReason)]
      }
      const v = item as ViewInfo
      return [
        row('Definidor', v.definer),
        row('Seguridad', v.security),
        row('Actualizable', v.updatable ? 'Sí' : 'No'),
        row('Fecha de creación', formatDate(v.createTime ?? null))
      ]
    }
    case 'functions': {
      const r = item as RoutineInfo
      if (r.signature !== undefined)
        return [
          row('Tipo', ROUTINE_KIND_LABELS[r.kind ?? ''] ?? r.type),
          row('Argumentos', r.signature || '(ninguno)'),
          row('Devuelve', r.returns),
          row('Propietario', r.definer),
          row('Comentario', r.comment)
        ]
      return [
        row('Tipo', r.type === 'PROCEDURE' ? 'Procedimiento' : 'Función'),
        row('Devuelve', r.returns),
        row('Definidor', r.definer),
        row('Fecha de creación', formatDate(r.created)),
        row('Fecha de modificación', formatDate(r.modified)),
        row('Comentario', r.comment)
      ]
    }
    case 'events': {
      const e = item as EventInfo
      return [
        row('Estado', e.status),
        row('Tipo', e.type),
        row('Programación', eventSchedule(e)),
        row('Inicio', formatDate(e.starts)),
        row('Fin', formatDate(e.ends)),
        row('Definidor', e.definer),
        row('Fecha de modificación', formatDate(e.modified)),
        row('Comentario', e.comment)
      ]
    }
    case 'queries': {
      const q = item as SavedQuery
      return [row('Base de datos', q.schema), row('Fecha de modificación', formatDate(q.updatedAt))]
    }
    case 'backups': {
      const b = item as BackupFile
      return [
        row('Archivo', b.fileName),
        row('Tamaño', formatBytes(b.sizeBytes)),
        row('Fecha de modificación', formatDate(b.modifiedAt)),
        row('Origen', BACKUP_SOURCE_LABELS[b.source] ?? b.source),
        row('Comentario', b.label),
        row('Ruta', b.path)
      ]
    }
    case 'materializedViews': {
      const o = item as ObjectSummary
      return [
        row(
          'Filas (estimadas)',
          o.rows === null || o.rows === undefined ? '—' : formatNumber(o.rows)
        ),
        row('Tamaño', formatBytes(o.sizeBytes ?? null)),
        row('Propietario', o.owner),
        row('Estado', o.detail),
        row('Comentario', o.comment)
      ]
    }
    case 'sequences': {
      const o = item as ObjectSummary
      // MariaDB sequences carry their options in `detail` and have no owner.
      if (engine === 'mariadb')
        return [row('Tipo', o.kind), row('Definición', o.detail), row('Comentario', o.comment)]
      return [
        row('Tipo', o.kind),
        row('Valor actual', o.detail),
        row('Pertenece a', o.table),
        row('Propietario', o.owner),
        row('Comentario', o.comment)
      ]
    }
    case 'types': {
      const o = item as ObjectSummary
      return [
        row('Clase', TYPE_KIND_LABELS[o.kind ?? ''] ?? o.kind),
        row('Definición', o.detail),
        row('Propietario', o.owner),
        row('Comentario', o.comment)
      ]
    }
    case 'indexes': {
      const o = item as ObjectSummary
      return [row('Tabla', o.table), row('Tipo', o.kind), row('Columnas', o.detail)]
    }
    case 'triggers': {
      const o = item as ObjectSummary
      return [row('Tabla', o.table), row('Cuándo', (o.kind ?? '').toUpperCase())]
    }
    case 'collections': {
      const c = item as MongoCollectionInfo
      return [
        row('Documentos', c.count === null ? '—' : formatNumber(c.count)),
        row('Tamaño', formatBytes(c.sizeBytes)),
        row('Almacenamiento', formatBytes(c.storageSizeBytes)),
        row('Índices', c.indexCount === null ? '—' : formatNumber(c.indexCount)),
        row('Tamaño medio', formatBytes(c.avgObjSizeBytes)),
        row('Edición', c.readOnlyReason ?? 'Editable por _id')
      ]
    }
  }
}

/** Singular, lowercase noun for a group, used in toolbar labels ("Abrir tabla"). */
export const GROUP_SINGULAR: Record<GroupKind, string> = {
  tables: 'tabla',
  views: 'vista',
  functions: 'función',
  events: 'evento',
  queries: 'consulta',
  backups: 'copia de seguridad',
  materializedViews: 'vista materializada',
  sequences: 'secuencia',
  types: 'tipo',
  indexes: 'índice',
  triggers: 'trigger',
  collections: 'colección'
}
