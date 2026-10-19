import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/types'
import { enumOptions, filterEnumOptions, matchEnumOption, parseEnumType } from './enumValues'

const info = (columnType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name: 'status',
  ordinal: 1,
  columnType,
  dataType: columnType.replace(/\(.*$/, ''),
  nullable: true,
  key: '',
  defaultValue: null,
  extra: '',
  characterSet: null,
  collation: null,
  comment: '',
  ...extra
})

describe('enum values', () => {
  it('reads the information_schema spelling (doubled quotes and backslashes, commas, empty)', () => {
    // Exactly what MySQL 8.4 and MariaDB 11 return in COLUMN_TYPE for these values.
    expect(parseEnumType("enum('Active','it''s','back\\\\slash','a,b','')")).toEqual([
      'Active',
      "it's",
      'back\\slash',
      'a,b',
      ''
    ])
    expect(parseEnumType("ENUM('ACTIVE', 'ARCHIVED')")).toEqual(['ACTIVE', 'ARCHIVED'])
  })

  it('refuses anything it cannot read whole', () => {
    expect(parseEnumType("set('x','y')")).toBeNull()
    expect(parseEnumType('varchar(20)')).toBeNull()
    expect(parseEnumType("enum('a','b")).toBeNull()
    expect(parseEnumType("enum('a' 'b')")).toBeNull()
    expect(parseEnumType('enum()')).toBeNull()
    expect(parseEnumType(null)).toBeNull()
  })

  it('prefers the driver list (PostgreSQL pg_enum) over the type text', () => {
    expect(enumOptions(info('mood', { enumValues: ['sad', 'ok', 'happy'] }))).toEqual([
      'sad',
      'ok',
      'happy'
    ])
    expect(enumOptions(info("enum('a','b')"))).toEqual(['a', 'b'])
    expect(enumOptions(info('int'))).toBeNull()
    expect(enumOptions(null)).toBeNull()
  })

  it('matches typed text exactly, then ignoring case when only one option fits', () => {
    const options = ['Active', 'Archived']
    expect(matchEnumOption(options, 'Active')).toBe('Active')
    expect(matchEnumOption(options, 'archived')).toBe('Archived')
    expect(matchEnumOption(options, 'arch')).toBeNull()
    expect(matchEnumOption(['a', 'A'], 'a')).toBe('a')
    expect(matchEnumOption(['a', 'A'], 'A')).toBe('A')
    expect(matchEnumOption(['ab', 'AB'], 'Ab')).toBeNull()
  })

  it('lists the options starting with the text first, then those containing it', () => {
    const options = ['Archived', 'Active', 'Inactive', 'Pending']
    expect(filterEnumOptions(options, '')).toEqual(options)
    expect(filterEnumOptions(options, 'act')).toEqual(['Active', 'Inactive'])
    expect(filterEnumOptions(options, ' A ')).toEqual(['Archived', 'Active', 'Inactive'])
    expect(filterEnumOptions(options, 'zz')).toEqual([])
  })
})
