import { describe, expect, it } from 'vitest'
import type { CellValue, StorageClass } from '../types'
import {
  delimitedFormatter,
  escapeHtml,
  formatInList,
  formatRows,
  formatUpdates,
  htmlFormatter,
  insertFormatter,
  jsonFormatter,
  markdownFormatter,
  textFormatter
} from './formats'
import type { ExportColumn } from './types'
import { jsonValue, sqlLiteral, uniqueNames } from './values'

const cols: ExportColumn[] = [
  { name: 'id', type: 'INT' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'total', type: 'DECIMAL' }
]
const rows: CellValue[][] = [
  [1, 'ana', '12.50'],
  [2, 'semi;colon "quoted"\nline', null]
]

describe('CSV and TSV', () => {
  it('quotes fields with the separator, quotes or line breaks (RFC 4180) and uses CRLF', () => {
    const out = formatRows(
      delimitedFormatter(cols, {
        header: true,
        delimiter: ',',
        bom: false,
        nullText: '',
        eol: '\r\n'
      }),
      rows
    )
    expect(out).toBe('id,name,total\r\n1,ana,12.50\r\n2,"semi;colon ""quoted""\nline",\r\n')
  })

  it('semicolon separator, BOM and a literal NULL', () => {
    const out = formatRows(
      delimitedFormatter(cols, {
        header: false,
        delimiter: ';',
        bom: true,
        nullText: 'NULL',
        eol: '\r\n'
      }),
      rows
    )
    expect(out.startsWith('﻿1;ana;12.50\r\n')).toBe(true)
    expect(out).toContain('"semi;colon ""quoted""\nline";NULL\r\n')
  })

  it('TSV for the clipboard: tabs separate, values with tabs or newlines are quoted', () => {
    const out = formatRows(
      textFormatter('tsv', cols, {
        header: false,
        delimiter: ',',
        bom: false,
        nullText: '',
        jsonShape: 'objects',
        table: 't',
        batchSize: 1,
        dialect: 'mysql',
        eol: '\n'
      }),
      [
        [1, 'a\tb', true],
        [2, 'plain, comma', null]
      ]
    )
    expect(out).toBe('1\t"a\tb"\t1\n2\tplain, comma\t\n')
  })
})

describe('JSON', () => {
  it('objects keyed by unique names; numbers only in numeric columns and when exact', () => {
    const columns: ExportColumn[] = [
      { name: 'id', type: 'BIGINT UNSIGNED' },
      { name: 'id', type: 'VARCHAR' },
      { name: 'amount', type: 'DECIMAL' },
      { name: 'ok', typeKind: 'boolean' },
      { name: 'f', typeKind: 'float' }
    ]
    const out = formatRows(
      jsonFormatter(columns, { jsonShape: 'objects', header: true, eol: '\n' }),
      [
        ['42', '7', '1.10', true, 0.5],
        ['18446744073709551615', null, '-0.000001', false, 1e300]
      ]
    )
    expect(JSON.parse(out)).toEqual([
      { id: 42, id_2: '7', amount: '1.10', ok: true, f: 0.5 },
      { id: '18446744073709551615', id_2: null, amount: '-0.000001', ok: false, f: 1e300 }
    ])
    expect(out).toBe(
      '[\n  {"id": 42, "id_2": "7", "amount": "1.10", "ok": true, "f": 0.5},\n' +
        '  {"id": "18446744073709551615", "id_2": null, "amount": "-0.000001", "ok": false, "f": 1e+300}\n]\n'
    )
  })

  it('arrays, with the column names first', () => {
    const out = formatRows(
      jsonFormatter(cols, { jsonShape: 'arrays', header: true, eol: '\n' }),
      rows
    )
    expect(JSON.parse(out)).toEqual([
      ['id', 'name', 'total'],
      [1, 'ana', '12.50'],
      [2, 'semi;colon "quoted"\nline', null]
    ])
  })

  it('an empty result is an empty array', () => {
    expect(
      JSON.parse(
        formatRows(jsonFormatter(cols, { jsonShape: 'objects', header: true, eol: '\n' }), [])
      )
    ).toEqual([])
  })

  it('SQLite storage classes decide numbers in untyped columns', () => {
    const column: ExportColumn = { name: 'loose', typeKind: 'other' }
    expect(jsonValue(5, column, 'integer')).toBe(5)
    expect(jsonValue('9007199254740993', column, 'integer')).toBe('9007199254740993')
    expect(jsonValue(5, column, 'text')).toBe('5')
    expect(jsonValue('5', column, 'text')).toBe('5')
  })

  it('deduplicates names deterministically', () => {
    expect(uniqueNames(['a', 'a', 'a_2', 'b', 'a'])).toEqual(['a', 'a_2', 'a_2_2', 'b', 'a_3'])
  })
})

describe('SQL literals and INSERT', () => {
  it('quotes per engine and keeps numbers, binary and booleans as literals', () => {
    const text: ExportColumn = { name: 't', type: 'VARCHAR' }
    expect(sqlLiteral("it's \\ ok", text, 'mysql')).toBe("'it\\'s \\\\ ok'")
    expect(sqlLiteral("it's \\ ok", { name: 't', typeKind: 'text' }, 'postgresql')).toBe(
      "'it''s \\ ok'"
    )
    expect(sqlLiteral("it's", { name: 't', typeKind: 'text' }, 'sqlite')).toBe("'it''s'")
    expect(sqlLiteral('0x00FF', { name: 'b', type: 'VARBINARY' }, 'mysql')).toBe("X'00FF'")
    expect(sqlLiteral('0x', { name: 'b', type: 'BLOB' }, 'mariadb')).toBe("X''")
    expect(sqlLiteral('0x05', { name: 'b', type: 'BIT' }, 'mysql')).toBe("X'05'")
    expect(sqlLiteral('0x00ff', { name: 'b', typeKind: 'binary' }, 'postgresql')).toBe("'\\x00FF'")
    expect(sqlLiteral('12345678901234567890.5', { name: 'd', type: 'DECIMAL' }, 'mysql')).toBe(
      '12345678901234567890.5'
    )
    expect(sqlLiteral('12abc', { name: 'd', type: 'DECIMAL' }, 'mysql')).toBe("'12abc'")
    expect(sqlLiteral(true, { name: 'b', typeKind: 'boolean' }, 'postgresql')).toBe('TRUE')
    expect(sqlLiteral(false, { name: 'b', type: 'TINYINT' }, 'mysql')).toBe('0')
    expect(sqlLiteral(null, text, 'mysql')).toBe('NULL')
    expect(sqlLiteral('2026-01-02 03:04:05', { name: 'd', type: 'DATETIME' }, 'mysql')).toBe(
      "'2026-01-02 03:04:05'"
    )
  })

  it('SQLite keeps each cell storage class', () => {
    const loose: ExportColumn = { name: 'x', typeKind: 'other' }
    expect(sqlLiteral('0xCAFE', loose, 'sqlite', 'blob')).toBe("X'CAFE'")
    expect(sqlLiteral('9007199254740993', loose, 'sqlite', 'integer')).toBe('9007199254740993')
    expect(sqlLiteral('12', { name: 'n', typeKind: 'integer' }, 'sqlite', 'text')).toBe("'12'")
    expect(sqlLiteral(1.5, loose, 'sqlite', 'real')).toBe('1.5')
  })

  it('one statement per row, identifiers quoted only where the engine needs it', () => {
    const out = formatRows(
      insertFormatter(cols, {
        dialect: 'postgresql',
        table: 'Ventas',
        schema: 'public',
        batchSize: 1,
        eol: '\n'
      }),
      rows
    )
    expect(out).toBe(
      'INSERT INTO public."Ventas" (id, name, total) VALUES (1, \'ana\', 12.50);\n' +
        'INSERT INTO public."Ventas" (id, name, total) VALUES (2, \'semi;colon "quoted"\nline\', NULL);\n'
    )
  })

  it('multi-row batches close every statement, also the last partial one', () => {
    const many: CellValue[][] = [
      [1, 'a', '1'],
      [2, 'b', '2'],
      [3, 'c', '3']
    ]
    const out = formatRows(
      insertFormatter(cols, {
        dialect: 'mysql',
        table: 't',
        batchSize: 2,
        eol: '\n',
        sqlNames: ['id', 'nombre', 'total']
      }),
      many
    )
    expect(out).toBe(
      "INSERT INTO `t` (`id`, `nombre`, `total`) VALUES\n  (1, 'a', 1),\n  (2, 'b', 2);\n" +
        "INSERT INTO `t` (`id`, `nombre`, `total`) VALUES\n  (3, 'c', 3);\n"
    )
  })

  it('SQLite blobs keep their storage class in INSERT', () => {
    const out = formatRows(
      insertFormatter([{ name: 'b', typeKind: 'binary' }], {
        dialect: 'sqlite',
        table: 't',
        batchSize: 1,
        eol: '\n'
      }),
      [['0x0A0B']],
      [['blob' as StorageClass]]
    )
    expect(out).toBe("INSERT INTO t (b) VALUES (X'0A0B');\n")
  })
})

describe('UPDATE and IN lists', () => {
  it('SET the selected non-key columns WHERE the whole key; NULL keys use IS NULL', () => {
    const out = formatUpdates({
      columns: cols,
      rows: [
        [1, "o'k", '3'],
        [null, 'x', null]
      ],
      setColumns: [0, 1, 2],
      keyColumns: [0],
      dialect: 'mysql',
      table: 'orders',
      eol: '\n'
    })
    expect(out).toBe(
      "UPDATE `orders` SET `name` = 'o\\'k', `total` = 3 WHERE `id` = 1;\n" +
        "UPDATE `orders` SET `name` = 'x', `total` = NULL WHERE `id` IS NULL;\n"
    )
  })

  it('nothing to update when only key columns are selected', () => {
    expect(
      formatUpdates({
        columns: cols,
        rows,
        setColumns: [0],
        keyColumns: [0],
        dialect: 'mysql',
        table: 't',
        eol: '\n'
      })
    ).toBe('')
  })

  it('IN list: distinct values, numbers unquoted, NULL left out and counted', () => {
    expect(formatInList([cols[0]], [[1], [2], [1], [null]], 'mysql')).toEqual({
      text: '(1, 2)',
      values: 2,
      nulls: 1
    })
    expect(formatInList([cols[1]], [['a'], ["b'c"]], 'postgresql').text).toBe("('a', 'b''c')")
    expect(
      formatInList(
        cols.slice(0, 2),
        [
          [1, 'a'],
          [2, 'a']
        ],
        'sqlite'
      ).text
    ).toBe("id IN (1, 2)\nname IN ('a')")
  })
})

describe('Markdown and HTML', () => {
  it('Markdown escapes pipes, keeps line breaks as <br> and right-aligns numbers', () => {
    const out = formatRows(markdownFormatter(cols, { nullText: 'NULL', eol: '\n' }), [
      [1, 'a|b\nc', null]
    ])
    expect(out).toBe('| id | name | total |\n| ---: | --- | ---: |\n| 1 | a\\|b<br>c | NULL |\n')
  })

  it('HTML is escaped and complete', () => {
    const out = formatRows(htmlFormatter(cols, { nullText: 'NULL', eol: '\n', title: 'a<b>' }), [
      [1, '<script>alert("x")</script> & co', null]
    ])
    expect(out).toContain('<title>a&lt;b&gt;</title>')
    expect(out).toContain('<td>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</td>')
    expect(out).toContain('<td class="null">NULL</td>')
    expect(out).toContain('<td class="num">1</td>')
    expect(out.trim().endsWith('</html>')).toBe(true)
    expect(escapeHtml("'")).toBe('&#39;')
  })
})
