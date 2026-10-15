/**
 * MCP server (src/main/mcp) on SQLite with real worker processes (the esbuild
 * bundle of src/main/sqlite/nodeWorker.ts): a runaway query is stopped by the
 * timeout (its read-only worker is killed) and the next call works; reads run
 * in that separate read-only worker; execute_sql by level and environment; an
 * attached database; and a missing file's error never names the file.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSqliteOptions } from '@shared/engines'
import type { ConnectionInput } from '@shared/types'
import { setSqliteSpawner } from '@main/sqlite/spawner'
import { baseInput, startMcpHarness, until, type McpHarness } from './mcpHarness'
import { childProcessSpawner } from './sqliteWorkerProcess'

describe('MCP server [SQLite, worker processes]', () => {
  let files: string
  let h: McpHarness
  let pids: number[]

  const lite = (
    name: string,
    filePath: string,
    environment: ConnectionInput['environment'],
    mcp: ConnectionInput['mcp'],
    attached: { alias: string; filePath: string }[] = []
  ): ConnectionInput =>
    baseInput({
      name,
      environment,
      engine: 'sqlite',
      authMode: 'none',
      savePassword: false,
      sqlite: { ...defaultSqliteOptions(false), filePath, attached },
      mcp
    })

  beforeAll(async () => {
    files = mkdtempSync(join(tmpdir(), 'vortaq-mcp-sqlite-it-'))
    const main = join(files, 'tienda.db')
    const aux = join(files, 'aux.db')
    const db = new DatabaseSync(main)
    db.exec(`
      CREATE TABLE productos (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, precio REAL);
      INSERT INTO productos VALUES (1, 'Té', 2.5), (2, 'Café', 3);
    `)
    db.close()
    const other = new DatabaseSync(aux)
    other.exec(
      `CREATE TABLE notas (id INTEGER PRIMARY KEY, texto TEXT); INSERT INTO notas VALUES (1, 'hola');`
    )
    other.close()
    const spawner = await childProcessSpawner()
    pids = spawner.pids
    setSqliteSpawner(spawner)
    h = await startMcpHarness([
      {
        input: lite('Tienda', main, 'local', { enabled: true, access: 'read' }, [
          { alias: 'aux', filePath: aux }
        ])
      },
      { input: lite('Escritura', main, 'local', { enabled: true, access: 'write' }) },
      { input: lite('Producción', main, 'production', { enabled: true, access: 'write' }) },
      {
        input: lite('Perdida', join(files, 'privado', 'clientes-2026.db'), 'local', {
          enabled: true,
          access: 'read'
        })
      }
    ])
  }, 120_000)

  afterAll(async () => {
    await h?.close()
    rmSync(files, { recursive: true, force: true })
  })

  it('lists main and the attached alias, and describes tables of both', async () => {
    expect((await h.ok('list_databases', { connection: 'Tienda' })).databases).toEqual([
      { name: 'main' },
      { name: 'aux' }
    ])
    const notas = await h.ok('describe_table', {
      connection: 'Tienda',
      database: 'aux',
      table: 'notas'
    })
    expect(notas.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'texto'])
    expect((await h.ok('list_tables', { connection: 'Tienda' })).tables).toEqual([
      expect.objectContaining({ name: 'productos', kind: 'table' })
    ])
  })

  it('run_query reads in a read-only worker, also across attached databases', async () => {
    const r = await h.ok('run_query', {
      connection: 'Tienda',
      sql: 'SELECT p.nombre, n.texto FROM productos p JOIN aux.notas n ON n.id = p.id'
    })
    expect(r.rows).toEqual([['Té', 'hola']])
    expect(
      await h.refused('run_query', { connection: 'Tienda', sql: 'DELETE FROM productos' })
    ).toMatch(/run_query/)
  })

  it('a timeout kills the runaway query (its worker process) and the next call works', async () => {
    const before = pids.length
    const started = Date.now()
    expect(
      await h.refused('run_query', {
        connection: 'Tienda',
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
        timeout_seconds: 1
      })
    ).toMatch(/tiempo límite de 1 s/)
    expect(Date.now() - started).toBeLessThan(5000)
    // The reader spawned for this query is gone.
    const reader = pids[before]
    expect(reader).toBeDefined()
    await until(() => {
      try {
        process.kill(reader, 0)
        return false
      } catch {
        return true
      }
    })
    expect(
      (
        await h.ok('run_query', {
          connection: 'Tienda',
          sql: 'SELECT COUNT(*) AS n FROM productos'
        })
      ).rows
    ).toEqual([[2]])
  })

  it('execute_sql writes at the write level; refused at read level and on production', async () => {
    const r = await h.ok('execute_sql', {
      connection: 'Escritura',
      sql: "INSERT INTO productos VALUES (3, 'Mate', 4); SELECT COUNT(*) AS n FROM productos"
    })
    expect(r.statements[0].affected_rows).toBe(1)
    expect(r.statements[1].result.rows).toEqual([[3]])
    expect(
      await h.refused('execute_sql', { connection: 'Tienda', sql: 'DELETE FROM productos' })
    ).toMatch(/execute_sql necesita/)
    expect(
      await h.refused('execute_sql', { connection: 'Producción', sql: 'DELETE FROM productos' })
    ).toMatch(/producción/)
    expect(
      (await h.ok('run_query', { connection: 'Producción', sql: 'SELECT COUNT(*) FROM productos' }))
        .rows
    ).toEqual([[3]])
  })

  it('a missing file is reported without its path or name', async () => {
    const message = await h.refused('list_tables', { connection: 'Perdida' })
    expect(message).toMatch(/no encontrado|not found|no existe/i)
    expect(message).not.toContain(files)
    expect(message).not.toContain('clientes-2026.db')
    expect(message).not.toContain('privado')
    expect(existsSync(join(files, 'privado'))).toBe(false)
  })
})
