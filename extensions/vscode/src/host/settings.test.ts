import { describe, expect, it } from 'vitest'
import { corePatch, DEFAULT_MAX_ROWS, readSettings } from './settings'

const config = (values: Record<string, unknown>) => ({
  get: <T>(key: string, fallback?: T) => (key in values ? (values[key] as T) : (fallback as T))
})

describe('extension settings', () => {
  it('always keeps production in the typed-confirmation list', () => {
    expect(readSettings(config({ typedConfirmEnvironments: [] })).typedConfirmEnvironments).toEqual(
      ['production']
    )
    expect(
      readSettings(config({ typedConfirmEnvironments: ['local', 'nope'] })).typedConfirmEnvironments
    ).toEqual(['production', 'local'])
  })

  it('clamps the row limit and copies what the core reads', () => {
    expect(readSettings(config({ maxRows: 0 })).maxRows).toBe(DEFAULT_MAX_ROWS)
    expect(readSettings(config({ maxRows: 10_000_000 })).maxRows).toBe(100_000)
    const settings = readSettings(config({ maxRows: 50, confirmDestructive: false }))
    expect(corePatch(settings)).toEqual({
      defaultRowLimit: 50,
      typedConfirmEnvironments: ['production'],
      confirmDestructiveEverywhere: false
    })
  })
})
