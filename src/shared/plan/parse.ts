/**
 * Each engine's plan → the common PlanNode tree (shared/plan/types.ts). Pure:
 * the server's text in, the tree out. Costs are each server's own units; the
 * percentage of a node is its own cost (its subtree minus its children's) over
 * the root's.
 */
import type { EngineId } from '../types'
import type { ExecutionPlan, PlanNode } from './types'
import { findAll, parseXml, type XmlElement } from './xml'

const MAX_DETAIL = 400

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function newNode(id: number, operation: string): PlanNode {
  return {
    id,
    operation,
    object: null,
    details: [],
    estRows: null,
    actualRows: null,
    cost: null,
    costPercent: null,
    actualMs: null,
    warnings: [],
    children: []
  }
}

/** Fills costPercent from the subtree costs (own = subtree − children). */
export function withCostShares(root: PlanNode): PlanNode {
  const total = root.cost
  const walk = (node: PlanNode): void => {
    node.children.forEach(walk)
    if (total && total > 0 && node.cost !== null) {
      const below = node.children.reduce((sum, c) => sum + (c.cost ?? 0), 0)
      const own = Math.max(0, node.cost - below)
      node.costPercent = Math.round((own / total) * 1000) / 10
    }
  }
  walk(root)
  return root
}

/** Actual rows far from the estimate: the optimizer was misled (statistics, parameters). */
function flagEstimates(root: PlanNode): void {
  const walk = (node: PlanNode): void => {
    const { estRows: est, actualRows: real } = node
    if (est !== null && real !== null && Math.max(est, real) >= 100) {
      const ratio = Math.max(est, 1) / Math.max(real, 1)
      if (ratio >= 10 || ratio <= 0.1)
        node.warnings.push(
          `La estimación (${Math.round(est)} filas) está muy lejos de las reales (${real}): revisa las estadísticas.`
        )
    }
    node.children.forEach(walk)
  }
  walk(root)
}

/* ---------- SQL Server: SHOWPLAN XML / STATISTICS XML ---------- */

const MS_WARNINGS: Record<string, string> = {
  NoJoinPredicate: 'Join sin condición (producto cartesiano)',
  ColumnsWithNoStatistics: 'Columnas sin estadísticas',
  SpillToTempDb: 'Desbordó a tempdb (memoria insuficiente)',
  PlanAffectingConvert: 'Una conversión de tipo afecta al plan',
  UnmatchedIndexes: 'Índices filtrados que no se pudieron usar',
  MemoryGrantWarning: 'Concesión de memoria inadecuada',
  Wait: 'Esperas durante la ejecución'
}

const unbracket = (s: string | undefined): string => (s ?? '').replace(/^\[|\]$/g, '')

function msObject(relop: XmlElement): string | null {
  const object = findAll(relop, 'Object', 'RelOp')[0]
  if (!object) return null
  const parts = [object.attrs.Schema, object.attrs.Table].map(unbracket).filter(Boolean)
  if (!parts.length) return null
  let text = parts.join('.')
  if (object.attrs.Alias && unbracket(object.attrs.Alias) !== unbracket(object.attrs.Table))
    text += ` ${unbracket(object.attrs.Alias)}`
  if (object.attrs.Index) text += ` (índice ${unbracket(object.attrs.Index)})`
  return text
}

/** Predicates of the operator itself (not of the operators below it). */
function msDetails(relop: XmlElement): string[] {
  const details: string[] = []
  if (relop.attrs.LogicalOp && relop.attrs.LogicalOp !== relop.attrs.PhysicalOp)
    details.push(`Operación lógica: ${relop.attrs.LogicalOp}`)
  const labelled = (name: string, label: string): void => {
    for (const holder of findAll(relop, name, 'RelOp')) {
      const scalar = findAll(holder, 'ScalarOperator', 'RelOp')[0]
      if (scalar?.attrs.ScalarString) details.push(`${label}: ${clip(scalar.attrs.ScalarString)}`)
    }
  }
  labelled('SeekPredicates', 'Búsqueda')
  labelled('Predicate', 'Predicado')
  for (const order of findAll(relop, 'OrderBy', 'RelOp')) {
    const cols = findAll(order, 'OrderByColumn', 'RelOp').map((c) => {
      const ref = findAll(c, 'ColumnReference')[0]
      return `${unbracket(ref?.attrs.Column)} ${c.attrs.Ascending === 'false' ? 'DESC' : 'ASC'}`
    })
    if (cols.length) details.push(`Orden: ${cols.join(', ')}`)
  }
  return details.slice(0, 6)
}

function msNode(relop: XmlElement, ids: { next: number }): PlanNode {
  const node = newNode(ids.next++, relop.attrs.PhysicalOp || relop.attrs.LogicalOp || 'Operador')
  node.object = msObject(relop)
  node.details = msDetails(relop)
  node.estRows = num(relop.attrs.EstimateRows)
  node.cost = num(relop.attrs.EstimatedTotalSubtreeCost)
  const counters = findAll(relop, 'RunTimeCountersPerThread', 'RelOp')
  if (counters.length) {
    node.actualRows = counters.reduce((sum, c) => sum + (num(c.attrs.ActualRows) ?? 0), 0)
    const ms = counters
      .map((c) => num(c.attrs.ActualElapsedms))
      .filter((n): n is number => n !== null)
    if (ms.length) node.actualMs = Math.max(...ms)
  }
  for (const warnings of findAll(relop, 'Warnings', 'RelOp'))
    for (const w of warnings.children) node.warnings.push(MS_WARNINGS[w.name] ?? w.name)
  node.children = findAll(relop, 'RelOp', 'RelOp').map((child) => msNode(child, ids))
  return node
}

export function parseMsShowplan(xml: string, actual: boolean): ExecutionPlan {
  const doc = parseXml(xml)
  const statement = findAll(doc, 'StmtSimple')[0]
  const queryPlan = statement ? findAll(statement, 'QueryPlan')[0] : undefined
  const top = queryPlan ? findAll(queryPlan, 'RelOp', 'RelOp')[0] : undefined
  if (!statement || !queryPlan || !top)
    throw new Error('SQL Server no devolvió un plan para esta sentencia.')
  const root = msNode(top, { next: 1 })
  const summary: string[] = []
  for (const group of findAll(queryPlan, 'MissingIndexGroup')) {
    for (const missing of findAll(group, 'MissingIndex')) {
      const cols = (usage: string): string[] =>
        findAll(missing, 'ColumnGroup')
          .filter((g) => g.attrs.Usage === usage)
          .flatMap((g) => findAll(g, 'Column').map((c) => unbracket(c.attrs.Name)))
      const keys = [...cols('EQUALITY'), ...cols('INEQUALITY')]
      const include = cols('INCLUDE')
      const impact = num(group.attrs.Impact)
      summary.push(
        `Índice recomendado${impact !== null ? ` (mejora estimada ${Math.round(impact)} %)` : ''}: ` +
          `${unbracket(missing.attrs.Schema)}.${unbracket(missing.attrs.Table)} (${keys.join(', ')})` +
          (include.length ? ` INCLUDE (${include.join(', ')})` : '')
      )
    }
  }
  const total = num(statement.attrs.StatementSubTreeCost) ?? root.cost
  if (root.cost === null) root.cost = total
  if (actual) flagEstimates(root)
  return {
    engine: 'sqlserver',
    actual,
    root: withCostShares(root),
    totalCost: total,
    summary,
    raw: xml,
    rawFormat: 'xml'
  }
}

/* ---------- PostgreSQL: EXPLAIN (FORMAT JSON) ---------- */

const PG_DETAILS: [key: string, label: string][] = [
  ['Index Cond', 'Condición del índice'],
  ['Recheck Cond', 'Recomprobación'],
  ['Hash Cond', 'Condición del hash'],
  ['Merge Cond', 'Condición del merge'],
  ['Join Filter', 'Filtro del join'],
  ['Filter', 'Filtro'],
  ['Sort Key', 'Orden'],
  ['Group Key', 'Agrupar por'],
  ['Rows Removed by Filter', 'Filas descartadas por el filtro'],
  ['Sort Method', 'Método de orden'],
  ['Strategy', 'Estrategia']
]

function pgNode(plan: Record<string, unknown>, ids: { next: number }): PlanNode {
  const type = String(plan['Node Type'] ?? 'Nodo')
  const join = typeof plan['Join Type'] === 'string' ? plan['Join Type'] : null
  const node = newNode(ids.next++, join && !type.includes(join) ? `${type} (${join})` : type)
  const relation = plan['Relation Name']
  if (typeof relation === 'string') {
    const schema = typeof plan.Schema === 'string' ? `${plan.Schema}.` : ''
    const alias = typeof plan.Alias === 'string' && plan.Alias !== relation ? ` ${plan.Alias}` : ''
    node.object = `${schema}${relation}${alias}`
  } else if (typeof plan['CTE Name'] === 'string') node.object = `CTE ${plan['CTE Name']}`
  else if (typeof plan['Function Name'] === 'string') node.object = `${plan['Function Name']}()`
  if (typeof plan['Index Name'] === 'string')
    node.object = `${node.object ? `${node.object} ` : ''}(índice ${plan['Index Name']})`
  for (const [key, label] of PG_DETAILS) {
    const value = plan[key]
    if (value === undefined || value === null) continue
    const text = Array.isArray(value) ? value.join(', ') : String(value)
    if (text) node.details.push(`${label}: ${clip(text)}`)
  }
  node.estRows = num(plan['Plan Rows'])
  node.cost = num(plan['Total Cost'])
  const loops = num(plan['Actual Loops']) ?? 1
  const rows = num(plan['Actual Rows'])
  if (rows !== null) node.actualRows = Math.round(rows * loops)
  const time = num(plan['Actual Total Time'])
  if (time !== null) node.actualMs = Math.round(time * loops * 1000) / 1000
  if (plan['Actual Loops'] === 0) node.warnings.push('No se ejecutó')
  const children = Array.isArray(plan.Plans) ? plan.Plans : []
  node.children = children
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => pgNode(c, ids))
  return node
}

export function parsePgPlan(json: string, actual: boolean): ExecutionPlan {
  const parsed: unknown = JSON.parse(json)
  const top = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined
  const plan = top?.Plan
  if (!plan || typeof plan !== 'object') throw new Error('PostgreSQL no devolvió un plan.')
  const root = pgNode(plan as Record<string, unknown>, { next: 1 })
  const summary: string[] = []
  const planning = num(top['Planning Time'])
  const execution = num(top['Execution Time'])
  if (planning !== null) summary.push(`Planificación: ${planning} ms`)
  if (execution !== null) summary.push(`Ejecución: ${execution} ms`)
  if (actual) flagEstimates(root)
  return {
    engine: 'postgresql',
    actual,
    root: withCostShares(root),
    totalCost: root.cost,
    summary,
    raw: json,
    rawFormat: 'json'
  }
}

/* ---------- MySQL 8: EXPLAIN FORMAT=TREE / EXPLAIN ANALYZE ---------- */

const TREE_COST = /\(cost=([\d.e+-]+)(?:\.\.([\d.e+-]+))?\s+rows=([\d.e+-]+)\)/
const TREE_ACTUAL = /\(actual time=([\d.e+-]+)\.\.([\d.e+-]+)\s+rows=([\d.e+-]+)\s+loops=(\d+)\)/

function treeLine(text: string, id: number): PlanNode {
  const cost = TREE_COST.exec(text)
  const actual = TREE_ACTUAL.exec(text)
  let label = text
    .replace(TREE_COST, '')
    .replace(TREE_ACTUAL, '')
    .replace(/\(never executed\)/, '')
    .trim()
  const node = newNode(id, label)
  if (/\(never executed\)/.test(text)) node.warnings.push('No se ejecutó')
  const colon = label.indexOf(': ')
  if (colon > 0) {
    node.operation = label.slice(0, colon)
    node.details.push(clip(label.slice(colon + 2)))
    label = node.operation
  } else {
    const on = /^(.+?) on (\S+)(?: using (\S+))?(?: (?:over )?\((.*)\))?$/.exec(label)
    if (on) {
      node.operation = on[1]
      node.object = on[3] ? `${on[2]} (índice ${on[3]})` : on[2]
      if (on[4]) node.details.push(clip(on[4]))
    }
  }
  if (cost) {
    node.cost = num(cost[2] ?? cost[1])
    node.estRows = num(cost[3])
  }
  if (actual) {
    const loops = Number(actual[4])
    node.actualRows = Math.round((num(actual[3]) ?? 0) * loops)
    node.actualMs = Math.round((num(actual[2]) ?? 0) * loops * 1000) / 1000
  }
  return node
}

export function parseMysqlTree(text: string, actual: boolean): ExecutionPlan {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('->'))
  if (!lines.length) throw new Error('MySQL no devolvió un plan en forma de árbol.')
  let id = 1
  const stack: { indent: number; node: PlanNode }[] = []
  let root: PlanNode | null = null
  for (const line of lines) {
    const indent = line.indexOf('->')
    const node = treeLine(line.slice(indent + 2).trim(), id++)
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else if (!root) root = node
    else {
      // Several top-level lines: put them under one root.
      const top: PlanNode = newNode(0, 'Consulta')
      top.children = [root, node]
      root = top
    }
    stack.push({ indent, node })
  }
  if (actual) flagEstimates(root!)
  return {
    engine: 'mysql',
    actual,
    root: withCostShares(root!),
    totalCost: root!.cost,
    summary: [],
    raw: text,
    rawFormat: 'text'
  }
}

/* ---------- MySQL 5.7 / MariaDB: tabular EXPLAIN (MariaDB ANALYZE adds r_rows) ---------- */

const ACCESS: Record<string, string> = {
  ALL: 'Recorrido completo de la tabla',
  index: 'Recorrido completo del índice',
  range: 'Rango de un índice',
  ref: 'Búsqueda por índice',
  eq_ref: 'Búsqueda única por índice',
  const: 'Fila constante',
  system: 'Fila constante',
  index_merge: 'Combinación de índices',
  ref_or_null: 'Búsqueda por índice (con NULL)',
  fulltext: 'Búsqueda de texto completo'
}

export function parseMysqlTable(
  rows: readonly Record<string, unknown>[],
  engine: EngineId,
  actual: boolean
): ExecutionPlan {
  if (!rows.length) throw new Error('El servidor no devolvió un plan.')
  const root = newNode(1, 'Consulta')
  let id = 2
  for (const r of rows) {
    const type = r.type === null || r.type === undefined ? '' : String(r.type)
    const node = newNode(id++, ACCESS[type] ?? (type || String(r.select_type ?? 'Paso')))
    if (r.table) node.object = r.key ? `${r.table} (índice ${r.key})` : String(r.table)
    if (r.select_type && r.select_type !== 'SIMPLE') node.details.push(`Tipo: ${r.select_type}`)
    if (r.possible_keys) node.details.push(`Índices posibles: ${r.possible_keys}`)
    if (r.ref) node.details.push(`Referencia: ${r.ref}`)
    if (r.Extra) node.details.push(clip(String(r.Extra)))
    node.estRows = num(r.rows)
    if (actual) node.actualRows = num(r.r_rows)
    if (type === 'ALL' && (node.estRows ?? 0) > 1000)
      node.warnings.push('Lee la tabla entera: un índice en las columnas del filtro lo evitaría')
    root.children.push(node)
  }
  if (actual) flagEstimates(root)
  return {
    engine,
    actual,
    root,
    totalCost: null,
    summary: [],
    raw: JSON.stringify(rows, null, 2),
    rawFormat: 'json'
  }
}

/* ---------- SQLite: EXPLAIN QUERY PLAN ---------- */

export function parseSqlitePlan(rows: readonly Record<string, unknown>[]): ExecutionPlan {
  if (!rows.length) throw new Error('SQLite no devolvió un plan.')
  const root = newNode(0, 'Consulta')
  const byId = new Map<number, PlanNode>([[0, root]])
  for (const r of rows) {
    const id = Number(r.id)
    const detail = String(r.detail ?? '')
    const node = newNode(id, detail)
    const scan = /^(SCAN|SEARCH)\s+(\S+)(?:\s+(.*))?$/i.exec(detail)
    if (scan) {
      node.operation = scan[1].toUpperCase() === 'SCAN' ? 'SCAN (recorrido)' : 'SEARCH (búsqueda)'
      node.object = scan[2]
      if (scan[3]) node.details.push(clip(scan[3]))
      if (scan[1].toUpperCase() === 'SCAN' && !scan[3]) node.warnings.push('Recorre toda la tabla')
    }
    byId.set(id, node)
    ;(byId.get(Number(r.parent)) ?? root).children.push(node)
  }
  return {
    engine: 'sqlite',
    actual: false,
    root: root.children.length === 1 ? root.children[0] : root,
    totalCost: null,
    summary: [],
    raw: rows.map((r) => `${r.id}|${r.parent}|${r.detail}`).join('\n'),
    rawFormat: 'text'
  }
}
