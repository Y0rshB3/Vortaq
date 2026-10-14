import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultExportOptions } from '@shared/export/types'
import type { ConnectionConfig, ProgressEvent } from '@shared/types'
import type { ConnectionManager } from '../db/manager'
import { createExportService, normalizeOptions } from './service'
import { EXPORT_MONGO_REFUSED } from './sources'

function fakeContext(engine: ConnectionConfig['engine']) {
  const events: ProgressEvent[] = []
  return {
    events,
    ctx: {
      connections: {
        get: (id: string) => (id === 'c1' ? ({ id, engine } as ConnectionConfig) : null)
      },
      emit: (_channel: string, payload: unknown) => events.push(payload as ProgressEvent)
    } as unknown as Parameters<typeof createExportService>[0]
  }
}

/** A manager that fails the test if anything tries to open a connection. */
const noConnections = {
  connection: () => {
    throw new Error('must not open a connection')
  },
  acquire: () => {
    throw new Error('must not open a connection')
  }
} as unknown as ConnectionManager

describe('export service', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vortaq-export-svc-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('normalises options and refuses unknown formats', () => {
    expect(() => normalizeOptions({ format: 'pdf' })).toThrow('Formato')
    const o = normalizeOptions({ format: 'sql', batchSize: 999999, delimiter: '|', table: ' t ' })
    expect(o.batchSize).toBe(10_000)
    expect(o.delimiter).toBe(',')
    expect(o.table).toBe('t')
    expect(normalizeOptions({ format: 'csv', batchSize: 0 }).batchSize).toBe(100)
  })

  it('export:rows writes the rows the renderer sent', async () => {
    const { ctx } = fakeContext('mysql')
    const service = createExportService(ctx, noConnections)
    const file = join(dir, 'sel.md')
    const result = await service.rows({
      filePath: file,
      columns: [{ name: 'a' }, { name: 'b', type: 'INT' }],
      rows: [
        ['x|y', 1],
        [null, 2]
      ],
      options: defaultExportOptions({ format: 'markdown', nullText: 'NULL' })
    })
    expect(result.rows).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe(
      '| a | b |\r\n| --- | ---: |\r\n| x\\|y | 1 |\r\n| NULL | 2 |\r\n'
    )
  })

  it('refuses relative paths and missing folders', async () => {
    const { ctx } = fakeContext('mysql')
    const service = createExportService(ctx, noConnections)
    const base = { columns: [{ name: 'a' }], rows: [], options: defaultExportOptions() }
    await expect(service.rows({ ...base, filePath: 'rel.csv' })).rejects.toThrow('absoluta')
    await expect(service.rows({ ...base, filePath: join(dir, 'nope', 'x.csv') })).rejects.toThrow(
      'no existe'
    )
  })

  it('refuses statements that may write before opening any connection', async () => {
    const { ctx, events } = fakeContext('postgresql')
    const service = createExportService(ctx, noConnections)
    for (const sql of [
      'DELETE FROM t',
      'SELECT 1; SELECT 2',
      'UPDATE t SET a = 1 RETURNING *',
      "SELECT set_config('default_transaction_read_only', 'off', false)"
    ]) {
      await expect(
        service.query('op-1', {
          connectionId: 'c1',
          filePath: join(dir, 'x.csv'),
          source: { kind: 'statement', sql },
          options: defaultExportOptions()
        })
      ).rejects.toThrow(/solo lectura|única sentencia|lectura/)
    }
    expect(readdirSync(dir)).toEqual([])
    expect(events.at(-1)).toMatchObject({ kind: 'export', done: true, phase: 'error' })
    expect(service.running()).toEqual([])
  })

  it('refuses MongoDB connections', async () => {
    const { ctx } = fakeContext('mongodb')
    const service = createExportService(ctx, noConnections)
    await expect(
      service.query('op-2', {
        connectionId: 'c1',
        filePath: join(dir, 'x.csv'),
        source: { kind: 'statement', sql: 'db.c.find()' },
        options: defaultExportOptions()
      })
    ).rejects.toThrow(EXPORT_MONGO_REFUSED)
  })
})
