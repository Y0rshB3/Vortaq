import { describe, expect, it } from 'vitest'
import { sqliteRuntimeProblem } from './runtime'

const withDatabase = (prototype: Record<string, unknown>) => (id: string) =>
  id === 'node:sqlite' ? { DatabaseSync: { prototype } } : undefined

describe('sqliteRuntimeProblem', () => {
  it('accepts this Node (the repository requires Node 24, like Electron 44)', () => {
    expect(sqliteRuntimeProblem()).toBeNull()
  })

  it('accepts a runtime whose DatabaseSync has setAuthorizer', () => {
    expect(
      sqliteRuntimeProblem({
        version: '24.15.0',
        getBuiltinModule: withDatabase({ setAuthorizer: () => undefined })
      })
    ).toBeNull()
  })

  it('refuses a Node without node:sqlite or without getBuiltinModule', () => {
    expect(sqliteRuntimeProblem({ version: '20.18.2', getBuiltinModule: () => undefined })).toMatch(
      /Node 24\.10 o posterior.*Node 20\.18\.2 sin el módulo node:sqlite/
    )
    expect(sqliteRuntimeProblem({ version: '20.10.0' })).toMatch(/sin el módulo node:sqlite/)
  })

  it('refuses a node:sqlite without the authorizer (Node 22.x): fail closed', () => {
    expect(
      sqliteRuntimeProblem({ version: '22.22.1', getBuiltinModule: withDatabase({}) })
    ).toMatch(/Node 22\.22\.1.*adjunte otros archivos/)
  })
})
