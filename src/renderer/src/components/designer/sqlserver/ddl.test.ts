import { describe, expect, it } from 'vitest'
import { msBuildDdlScript, msIsRename, msParseObjectName } from './ddl'

describe('SQL Server DDL editor', () => {
  it('parses bracketed, quoted and plain names', () => {
    expect(msParseObjectName('CREATE VIEW [dbo].[Mi Vista] AS SELECT 1 AS a', 'view')).toBe(
      'Mi Vista'
    )
    expect(msParseObjectName('create or alter proc dbo.p AS SELECT 1', 'procedure')).toBe('p')
    expect(
      msParseObjectName('ALTER FUNCTION "f"() RETURNS int AS BEGIN RETURN 1 END', 'function')
    ).toBe('f')
    expect(msIsRename('CREATE VIEW dbo.V2 AS SELECT 1 AS a', 'view', 'v2')).toBe(false)
  })

  it('applies CREATE OR ALTER and drops the old name after a rename', () => {
    expect(
      msBuildDdlScript('CREATE VIEW dbo.v_saldo AS SELECT id, balance FROM dbo.customers', {
        type: 'view',
        schema: 'dbo',
        originalName: null,
        removeDefiner: false
      })
    ).toBe('CREATE OR ALTER VIEW dbo.v_saldo AS SELECT id, balance FROM dbo.customers')
    expect(
      msBuildDdlScript('CREATE VIEW dbo.v_saldos AS SELECT id, balance FROM dbo.customers;', {
        type: 'view',
        schema: 'dbo',
        originalName: 'v_saldo',
        removeDefiner: false
      })
    ).toBe(
      'CREATE OR ALTER VIEW dbo.v_saldos AS SELECT id, balance FROM dbo.customers\nGO\nDROP VIEW IF EXISTS [dbo].[v_saldo]'
    )
  })
})
