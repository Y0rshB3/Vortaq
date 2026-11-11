/**
 * «Plan de ejecución»: one tree for every engine (SQL Server SHOWPLAN XML,
 * PostgreSQL EXPLAIN JSON, MySQL EXPLAIN tree or table, MariaDB EXPLAIN /
 * ANALYZE, SQLite EXPLAIN QUERY PLAN), built by shared/plan/parse.ts and drawn
 * by components/plan/PlanView.vue in the desktop app and the editor extension.
 */
import type { EngineId } from '../types'

export interface PlanNode {
  id: number
  /** Operator as the server names it: «Clustered Index Seek», «Seq Scan», «Table scan»… */
  operation: string
  /** Table, index or alias it reads, when any. */
  object: string | null
  /** Predicates, join conditions, sort keys… («Predicado: …»), as the server writes them. */
  details: string[]
  /** Rows the optimizer expects. */
  estRows: number | null
  /** Rows it produced (actual plans only; all loops). */
  actualRows: number | null
  /** Estimated cost of the node with everything below it, in the server's units. */
  cost: number | null
  /** Share of the plan's total cost spent in this node alone, 0–100. */
  costPercent: number | null
  /** Time spent in the node and below, in ms (actual plans only). */
  actualMs: number | null
  /** What the server warns about (no statistics, spills, a missing index…). */
  warnings: string[]
  children: PlanNode[]
}

export interface ExecutionPlan {
  engine: EngineId
  /** True when the statement ran to measure rows and times. */
  actual: boolean
  root: PlanNode
  totalCost: number | null
  /** Facts about the whole plan: planning and execution time, recommended indexes… */
  summary: string[]
  /** The server's own plan, for «Copiar». */
  raw: string
  rawFormat: 'xml' | 'json' | 'text'
}

export interface PlanRequest {
  /** One statement (SQL Server: one batch with one statement). */
  sql: string
  /** MySQL/MariaDB database, SQLite alias, or PostgreSQL / SQL Server database + schema. */
  schema: string | { database: string; schema: string } | null
  /** Run the statement to measure (read-only SELECT only, in a session that cannot keep changes). */
  actual: boolean
}
