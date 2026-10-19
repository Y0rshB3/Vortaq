import { describe, expect, it } from 'vitest'
import {
  binaryBytes,
  byteLength,
  compactJson,
  displayColumnType,
  formatBytes,
  hexDump,
  isBinaryValue,
  isJsonText,
  jsonTokens,
  prettyJson
} from './cellValue'

describe('cellValue helpers', () => {
  it('detects JSON objects and arrays only', () => {
    expect(isJsonText('{"a": [1, 2]}')).toBe(true)
    expect(isJsonText(' [1] ')).toBe(true)
    expect(isJsonText('12')).toBe(false)
    expect(isJsonText('{nope}')).toBe(false)
    expect(isJsonText(null)).toBe(false)
  })

  it('pretty prints and compacts JSON', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}')
    expect(compactJson('{ "a" : 1 }')).toBe('{"a":1}')
  })

  it('tokenizes JSON for highlighting without losing text', () => {
    const text = prettyJson('{"name":"ñ \\"x\\"","n":-1.5e3,"ok":true,"none":null}')
    const tokens = jsonTokens(text)
    expect(tokens.map((t) => t.text).join('')).toBe(text)
    expect(tokens.filter((t) => t.kind === 'key').map((t) => t.text)).toEqual([
      '"name"',
      '"n"',
      '"ok"',
      '"none"'
    ])
    expect(tokens.find((t) => t.kind === 'number')?.text).toBe('-1500')
    expect(tokens.filter((t) => t.kind === 'literal').map((t) => t.text)).toEqual(['true', 'null'])
  })

  it('shows binary as a hex dump with its size', () => {
    expect(isBinaryValue('0xDEAD', 'BLOB')).toBe(true)
    expect(isBinaryValue('0xDEAD', 'VARCHAR')).toBe(false)
    expect(hexDump('0x' + '00'.repeat(17))).toBe(
      '00000000  ' + Array(16).fill('00').join(' ') + '\n00000010  00'
    )
    expect(binaryBytes('0xDEADBEEF')).toBe(4)
  })

  it('measures UTF-8 bytes', () => {
    expect(byteLength('ñ🐦')).toBe(6)
    expect(formatBytes(2048)).toBe('2.0 KB')
  })
})

describe('displayColumnType', () => {
  it('upper-cases the type but keeps ENUM/SET values as defined', () => {
    expect(displayColumnType("enum('Active','Archived')")).toBe("ENUM('Active','Archived')")
    expect(displayColumnType("set('it''s','a\\\\b') not null")).toBe(
      "SET('it''s','a\\\\b') NOT NULL"
    )
    expect(displayColumnType('varchar(22)')).toBe('VARCHAR(22)')
    expect(displayColumnType('int unsigned')).toBe('INT UNSIGNED')
  })
})
