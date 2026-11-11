import { describe, expect, it } from 'vitest'
import { corePatch, DEFAULT_MAX_ROWS, DEFAULT_MCP_PORT, readSettings } from './settings'

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
      confirmDestructiveEverywhere: false,
      mcpEnabled: false
    })
  })

  it('keeps agents off unless vortaq.mcp.enabled is exactly true, with a valid port', () => {
    expect(readSettings(config({})).mcp).toEqual({ enabled: false, port: DEFAULT_MCP_PORT })
    expect(readSettings(config({ 'mcp.enabled': 'true' })).mcp.enabled).toBe(false)
    const on = readSettings(config({ 'mcp.enabled': true, 'mcp.port': 40000 }))
    expect(on.mcp).toEqual({ enabled: true, port: 40000 })
    expect(corePatch(on).mcpEnabled).toBe(true)
    for (const port of [80, 70000, 1.5, 'x'])
      expect(readSettings(config({ 'mcp.port': port })).mcp.port).toBe(DEFAULT_MCP_PORT)
  })
})
