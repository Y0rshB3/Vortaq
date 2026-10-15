import { describe, expect, it } from 'vitest'
import { DATA_KEY, looksLikeDataKey, shapeOf } from './documents'

const collapsed = (docs: Record<string, unknown>[]) => shapeOf(docs, { collapseDataKeys: true })
const paths = (docs: Record<string, unknown>[]) => collapsed(docs).map((f) => f.path)

describe('shapeOf with collapseDataKeys (structure without values)', () => {
  it('keys that look like values become <clave>: e-mails, numbers, dates, hex ids, UUIDs, spaces', () => {
    for (const key of [
      'ana@example.com',
      '12345',
      '-3.5',
      '2026-10-14',
      '2026-10-14T10:00:00',
      '652f1c2e9b1e8a0012345678',
      'deadbeefcafebabe',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      'con espacio'
    ])
      expect(looksLikeDataKey(key), key).toBe(true)
    for (const key of [
      'name',
      'address_line_2',
      'createdAt',
      'v2',
      'utm_campaign_2024',
      '_id',
      'tags'
    ])
      expect(looksLikeDataKey(key), key).toBe(false)
  })

  it('collapses map-shaped objects and data-like keys, merging their types', () => {
    const docs = [
      {
        _id: 1,
        name: 'x',
        votes: { 'ana@x.com': 1, 'luis@y.org': 2 },
        byDay: { '2026-10-01': { n: 1 } }
      },
      { _id: 2, name: 'y', votes: { 'eva@z.net': 3 }, byDay: { '2026-10-02': { n: 2 } } }
    ]
    const out = collapsed(docs)
    expect(out.map((f) => f.path)).toEqual([
      '_id',
      'byDay',
      `byDay.${DATA_KEY}`,
      `byDay.${DATA_KEY}.n`,
      'name',
      'votes',
      `votes.${DATA_KEY}`
    ])
    const votes = out.find((f) => f.path === `votes.${DATA_KEY}`)!
    expect(votes.types).toEqual({ int: 3 })
    expect(votes.count).toBe(2) // documents that have any of the keys
    expect(JSON.stringify(out)).not.toMatch(/@|2026-10/)
  })

  it('a nested object with more than 20 distinct keys is a map, whatever its keys look like', () => {
    const tokens = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`tok${'abcdefghij'[i % 10]}${i}x`, true])
    )
    expect(paths([{ _id: 1, sessions: tokens }])).toEqual([
      '_id',
      'sessions',
      `sessions.${DATA_KEY}`
    ])
    // The document root never counts as a map: wide documents keep their field names.
    const wide = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field_${String.fromCharCode(97 + (i % 26))}${i}`, i])
    )
    expect(paths([wide])).toHaveLength(30)
    // An ordinary sub-document keeps its keys.
    expect(paths([{ address: { street: 'x', city: 'y', zip: '1' } }])).toEqual([
      'address',
      'address.city',
      'address.street',
      'address.zip'
    ])
  })

  it('without the option the shape is unchanged (the documents view needs the real keys)', () => {
    expect(shapeOf([{ votes: { 'ana@x.com': 1 } }]).map((f) => f.path)).toEqual([
      'votes',
      'votes.ana@x.com'
    ])
  })
})
