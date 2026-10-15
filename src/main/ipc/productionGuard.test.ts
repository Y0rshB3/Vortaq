import type {
  AppSettings,
  ConnectionConfig,
  Environment,
  Job,
  JobInput,
  JobTask
} from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  assertJobRunAllowed,
  assertJobSaveAllowed,
  assertProductionWriteConfirmed,
  assertScriptAllowed
} from './productionGuard'

function connection(id: string, environment: ConnectionConfig['environment']): ConnectionConfig {
  return { id, name: `conn-${id}`, environment } as ConnectionConfig
}

/** `stored` is what settings.json holds (may be hand-edited, old or invalid). */
function makeCtx(
  stored: Partial<Record<keyof AppSettings | 'confirmProductionWrites', unknown>> = {}
) {
  const items = [
    connection('prod', 'production'),
    connection('dev', 'local'),
    connection('stg', 'staging'),
    { ...connection('pgprod', 'production'), engine: 'postgresql' } as ConnectionConfig
  ]
  return {
    connections: { get: (id: string) => items.find((c) => c.id === id) ?? null },
    settings: { get: () => stored as unknown as AppSettings }
  } as unknown as Parameters<typeof assertProductionWriteConfirmed>[0]
}

const withTyped = (typedConfirmEnvironments: Environment[]) => makeCtx({ typedConfirmEnvironments })

const sqlTask = (connectionId: string, sql = 'DELETE FROM t'): JobTask => ({
  id: `t-${connectionId}`,
  type: 'runquery',
  connectionId,
  schema: 'app',
  referenceName: 'paso',
  sql
})

const backupTask = (connectionId: string): JobTask => ({
  id: `b-${connectionId}`,
  type: 'backupschema',
  connectionId,
  schema: 'app',
  referenceName: 'backup'
})

function jobInput(tasks: JobTask[], enabled = true): JobInput {
  return {
    name: 'Nocturna',
    continueOnError: false,
    tasks,
    schedule: { enabled, cron: '0 3 * * *', launchAgent: false }
  }
}

describe('assertProductionWriteConfirmed', () => {
  it('rejects unconfirmed writes on production with an actionable message', () => {
    expect(() =>
      assertProductionWriteConfirmed(makeCtx(), 'prod', undefined, 'Eliminar t')
    ).toThrow(/Eliminar t en «conn-prod» \(producción\) necesita confirmación explícita/)
  })

  it('allows confirmed writes and environments that are not listed', () => {
    const ctx = makeCtx()
    expect(() =>
      assertProductionWriteConfirmed(ctx, 'prod', { confirmProduction: true }, 'x')
    ).not.toThrow()
    expect(() => assertProductionWriteConfirmed(ctx, 'dev', undefined, 'x')).not.toThrow()
    expect(() => assertProductionWriteConfirmed(ctx, 'stg', undefined, 'x')).not.toThrow()
    expect(() => assertProductionWriteConfirmed(ctx, 'missing', undefined, 'x')).not.toThrow()
  })

  it('production cannot be turned off: old false flag, empty or edited lists still guard it', () => {
    for (const stored of [
      { confirmProductionWrites: false },
      { typedConfirmEnvironments: [] },
      { typedConfirmEnvironments: ['staging'] },
      { typedConfirmEnvironments: 'production' },
      { typedConfirmEnvironments: ['bogus'] }
    ]) {
      expect(
        () => assertProductionWriteConfirmed(makeCtx(stored), 'prod', undefined, 'x'),
        JSON.stringify(stored)
      ).toThrow(/producción/)
    }
  })

  it('refuses unconfirmed writes on staging when staging is listed, naming the environment', () => {
    const ctx = withTyped(['production', 'staging'])
    expect(() => assertProductionWriteConfirmed(ctx, 'stg', undefined, 'Eliminar t')).toThrow(
      /Eliminar t en «conn-stg» \(entorno Staging\) necesita confirmación explícita/
    )
    expect(() =>
      assertProductionWriteConfirmed(ctx, 'stg', { confirmProduction: true }, 'x')
    ).not.toThrow()
    expect(() => assertProductionWriteConfirmed(ctx, 'dev', undefined, 'x')).not.toThrow()
    expect(() =>
      assertProductionWriteConfirmed(withTyped(['local']), 'dev', undefined, 'x')
    ).toThrow(/entorno Local/)
  })
})

describe('assertScriptAllowed', () => {
  it('lets read-only scripts through on production', () => {
    const ctx = makeCtx()
    expect(() => assertScriptAllowed(ctx, 'prod', 'SELECT 1; SHOW TABLES', undefined)).not.toThrow()
    expect(() =>
      assertScriptAllowed(ctx, 'prod', "-- note\nSELECT 'DELETE FROM t'", undefined)
    ).not.toThrow()
  })

  it('rejects scripts with an obvious write unless confirmed', () => {
    const ctx = makeCtx()
    expect(() =>
      assertScriptAllowed(ctx, 'prod', 'SELECT 1;\n/* x */ DELETE FROM t', undefined)
    ).toThrow()
    expect(() => assertScriptAllowed(ctx, 'prod', 'TRUNCATE TABLE t', {})).toThrow()
    expect(() =>
      assertScriptAllowed(ctx, 'prod', 'TRUNCATE TABLE t', { confirmProduction: true })
    ).not.toThrow()
    expect(() => assertScriptAllowed(ctx, 'dev', 'DROP TABLE t', undefined)).not.toThrow()
  })

  it('PostgreSQL: side-effect functions need the confirmation under any spelling', () => {
    const ctx = makeCtx()
    for (const sql of [
      'SELECT U&"pg\\005fterminate\\005fbackend"(pid) FROM pg_stat_activity',
      'SELECT U&"pg!005fterminate!005fbackend" UESCAPE \'!\' (1)',
      'SELECT "pg_catalog"."pg_terminate_backend"(1)',
      'SELECT U&"pg\\zz"(1)'
    ]) {
      expect(() => assertScriptAllowed(ctx, 'pgprod', sql, undefined), sql).toThrow(/confirmación/)
      expect(() =>
        assertScriptAllowed(ctx, 'pgprod', sql, { confirmProduction: true })
      ).not.toThrow()
    }
    expect(() =>
      assertScriptAllowed(ctx, 'pgprod', 'SELECT U&"n\\0061me" FROM t', undefined)
    ).not.toThrow()
  })

  it('applies to listed environments too', () => {
    const ctx = withTyped(['staging'])
    expect(() => assertScriptAllowed(ctx, 'stg', 'DROP TABLE t', undefined)).toThrow(
      /entorno Staging/
    )
    expect(() => assertScriptAllowed(ctx, 'stg', 'SELECT 1', undefined)).not.toThrow()
    expect(() => assertScriptAllowed(makeCtx(), 'stg', 'DROP TABLE t', undefined)).not.toThrow()
  })
})

describe('assertJobRunAllowed', () => {
  it('needs confirmation only for SQL tasks on production', () => {
    const ctx = makeCtx()
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [backupTask('prod')] }, undefined)
    ).not.toThrow()
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [sqlTask('dev')] }, undefined)
    ).not.toThrow()
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [sqlTask('prod')] }, undefined)
    ).toThrow(/«conn-prod» \(producción\)/)
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [sqlTask('prod')] }, { confirmProduction: true })
    ).not.toThrow()
  })

  it('needs confirmation for SQL tasks on a listed environment', () => {
    expect(() =>
      assertJobRunAllowed(makeCtx(), { name: 'j', tasks: [sqlTask('stg')] }, undefined)
    ).not.toThrow()
    const ctx = withTyped(['production', 'staging'])
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [sqlTask('stg'), sqlTask('prod')] }, undefined)
    ).toThrow(/«conn-stg» \(entorno Staging\), «conn-prod» \(producción\)/)
    expect(() =>
      assertJobRunAllowed(ctx, { name: 'j', tasks: [sqlTask('stg')] }, { confirmProduction: true })
    ).not.toThrow()
  })
})

describe('assertJobSaveAllowed', () => {
  const ctx = makeCtx()

  it('needs confirmation to schedule SQL on production', () => {
    expect(() => assertJobSaveAllowed(ctx, jobInput([sqlTask('prod')]), null, undefined)).toThrow(
      /Programar «Nocturna»/
    )
    expect(() =>
      assertJobSaveAllowed(ctx, jobInput([sqlTask('prod')]), null, { confirmProduction: true })
    ).not.toThrow()
  })

  it('does not ask for unscheduled jobs or jobs without production SQL', () => {
    expect(() =>
      assertJobSaveAllowed(ctx, jobInput([sqlTask('prod')], false), null, undefined)
    ).not.toThrow()
    expect(() =>
      assertJobSaveAllowed(ctx, jobInput([backupTask('prod')]), null, undefined)
    ).not.toThrow()
  })

  it('does not ask again when the stored job already had the same risk', () => {
    const input = jobInput([sqlTask('prod')])
    const stored = { ...input, id: 'j1' } as Job
    expect(() =>
      assertJobSaveAllowed(ctx, { ...input, name: 'Otro nombre' }, stored, undefined)
    ).not.toThrow()
    const changed = jobInput([sqlTask('prod', 'DELETE FROM otra')])
    expect(() => assertJobSaveAllowed(ctx, changed, stored, undefined)).toThrow()
  })

  it('scheduling SQL on a listed environment needs confirmation', () => {
    const input = jobInput([sqlTask('stg')])
    expect(() => assertJobSaveAllowed(ctx, input, null, undefined)).not.toThrow()
    const listed = withTyped(['production', 'staging'])
    expect(() => assertJobSaveAllowed(listed, input, null, undefined)).toThrow(/entorno Staging/)
    expect(() =>
      assertJobSaveAllowed(listed, input, null, { confirmProduction: true })
    ).not.toThrow()
    // A stored job whose staging SQL changes asks again.
    const stored = { ...input, id: 'j2' } as Job
    const changed = jobInput([sqlTask('stg', 'DELETE FROM otra')])
    expect(() => assertJobSaveAllowed(listed, changed, stored, undefined)).toThrow()
  })
})
