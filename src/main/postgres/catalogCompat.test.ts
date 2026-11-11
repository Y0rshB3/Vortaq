import { describe, expect, it } from 'vitest'
import {
  attidentitySql,
  encryptionLabel,
  indexKeyCountSql,
  partkeySql,
  pgCatalogFeatures,
  prokindSql,
  relispartitionSql,
  sslInfoSql,
  viewInsertableSql
} from './catalogCompat'

describe('PostgreSQL catalog features by server_version_num', () => {
  it('turns each piece on at the version that added it', () => {
    const on = (num: number) =>
      Object.entries(pgCatalogFeatures(num))
        .filter(([k, v]) => k !== 'versionNum' && v === true)
        .map(([k]) => k)
        .sort()
    expect(on(90223)).toEqual([])
    expect(on(90300)).toEqual(['createSchemaIfNotExists', 'matviews', 'updatableViews'])
    expect(on(90600)).toEqual([
      'createSchemaIfNotExists',
      'createSequenceIfNotExists',
      'matviews',
      'statSsl',
      'updatableViews'
    ])
    expect(on(100023)).toContain('identity')
    expect(on(100023)).not.toContain('prokind')
    expect(on(110000)).toContain('includeColumns')
    expect(on(110000)).not.toContain('generated')
    expect(on(170004)).toHaveLength(11)
  })

  it('reads an unknown version (0, missing) as a current server', () => {
    for (const unknown of [0, undefined, null, Number.NaN]) {
      const f = pgCatalogFeatures(unknown)
      expect(f.versionNum).toBe(0)
      expect(f.generated && f.prokind && f.statSsl).toBe(true)
    }
  })

  it('stands in for the missing catalog columns on old servers', () => {
    const old = pgCatalogFeatures(90200)
    const current = pgCatalogFeatures(170000)
    expect(attidentitySql(old)).toBe(`''::text`)
    expect(attidentitySql(current, 'x')).toBe('x.attidentity::text')
    expect(prokindSql(old)).toBe(
      `(CASE WHEN p.proisagg THEN 'a' WHEN p.proiswindow THEN 'w' ELSE 'f' END)::text`
    )
    expect(prokindSql(current)).toBe('p.prokind::text')
    expect(relispartitionSql(old)).toBe('false')
    expect(partkeySql(old)).toBe('NULL::text')
    expect(partkeySql(current, 'c', 'pg_catalog.')).toContain('pg_catalog.pg_get_partkeydef(c.oid)')
    expect(indexKeyCountSql(old)).toBe('i.indnatts')
    expect(indexKeyCountSql(current)).toBe('i.indnkeyatts')
    expect(viewInsertableSql(old)).toBe('false')
    expect(sslInfoSql(old)).not.toContain('pg_stat_ssl')
    expect(sslInfoSql(current)).toContain('pg_stat_ssl')
  })

  it('«Cifrado»: the server’s view when it has one, else the client socket’s', () => {
    const plain = { encrypted: false, protocol: null }
    const tls = { encrypted: true, protocol: 'TLSv1.3' }
    expect(encryptionLabel(true, 'TLSv1.2', plain)).toBe('SSL: TLSv1.2')
    expect(encryptionLabel(false, null, tls)).toBe('sin cifrar')
    expect(encryptionLabel(null, null, tls)).toBe('SSL: TLSv1.3')
    expect(encryptionLabel(null, null, plain)).toBe('sin cifrar')
  })
})
