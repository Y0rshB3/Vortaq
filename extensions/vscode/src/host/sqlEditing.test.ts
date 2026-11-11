import { describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { keywordCompletionSource } from '@codemirror/lang-sql'
import type { ConnectionConfig, VortaqCore } from '@core'
import {
  cachedMs,
  msCompletionSource,
  vortaqMSSQL
} from '@renderer/components/common/editor/msCompletion'
import type { ConnectionService } from './connections'
import { SqlCompletionProvider, SqlFormattingProvider, suggestionsAt } from './sqlEditing'
import type { DocumentTarget, DocumentTargets } from './targets'

/** A SQL Server database with dbo.[Order Details] and dbo.customers. */
const MS_TABLES: Record<string, { name: string; columnType: string }[]> = {
  'Order Details': [
    { name: 'OrderID', columnType: 'int' },
    { name: 'Unit Price', columnType: 'money' }
  ],
  customers: [
    { name: 'id', columnType: 'int' },
    { name: 'name', columnType: 'nvarchar(80)' }
  ]
}

function msSource() {
  return msCompletionSource(
    cachedMs({
      searchPath: () => ['dbo'],
      schemas: async () => ['dbo', 'ventas'],
      tables: async (s) =>
        s === 'dbo' ? Object.keys(MS_TABLES).map((name) => ({ name, kind: 'table' as const })) : [],
      columns: async (_s, t) =>
        (MS_TABLES[t] ?? []).map((c) => ({ name: c.name, type: c.columnType })),
      functions: async () => []
    })
  )
}

describe('headless completion (the desktop sources in the editor)', () => {
  it('SQL Server: tables after `dbo.`, bracketed when needed, replacing the whole name', async () => {
    const text = 'SELECT * FROM dbo.Ord'
    const s = await suggestionsAt(text, text.length, true, vortaqMSSQL, [msSource()])
    const order = s.find((x) => x.label === 'Order Details')!
    expect(order.insertText).toBe('[Order Details]')
    expect(order.type).toBe('class')
    expect(text.slice(order.from, order.to)).toBe('Ord')
    expect(s.map((x) => x.label)).toContain('customers')
  })

  it('SQL Server: columns of the alias after `c.`', async () => {
    const text = 'SELECT c. FROM dbo.customers c'
    const offset = 'SELECT c.'.length
    const s = await suggestionsAt(text, offset, true, vortaqMSSQL, [msSource()])
    expect(s.filter((x) => x.type === 'property').map((x) => x.label)).toEqual(['id', 'name'])
    expect(s.find((x) => x.label === 'name')?.detail).toContain('nvarchar(80)')
  })

  it('keywords of the dialect, upper case', async () => {
    const s = await suggestionsAt('SEL', 3, true, vortaqMSSQL, [
      keywordCompletionSource(vortaqMSSQL, true)
    ])
    expect(s.some((x) => x.label === 'SELECT' && x.type === 'keyword')).toBe(true)
  })

  it('looks only at a window of whole lines around the cursor in a big script', async () => {
    const filler = '-- comentario\n'.repeat(3000)
    const text = `${filler}SELECT * FROM dbo.cu`
    const s = await suggestionsAt(text, text.length, true, vortaqMSSQL, [msSource()])
    const customers = s.find((x) => x.label === 'customers')!
    expect(text.slice(customers.from, customers.to)).toBe('cu')
  })
})

/** A one-document world: text, a target and an open or closed connection. */
function world(text: string, target: DocumentTarget | null, open: boolean) {
  const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
    if (channel === 'db:schemas') return [{ name: 'dbo' }]
    if (channel === 'db:tables') return [{ name: 'customers' }]
    if (channel === 'db:views') return []
    if (channel === 'db:columns') return MS_TABLES.customers
    if (channel === 'db:routines') return []
    return []
  })
  const core = { invoke } as unknown as VortaqCore
  const changed = new vscode.EventEmitter<void>()
  const connections = {
    get: (id: string) =>
      id === 'ms' ? ({ id: 'ms', engine: 'sqlserver' } as ConnectionConfig) : null,
    isOpen: () => open,
    onDidChange: changed.event
  } as unknown as ConnectionService
  const targets = { get: () => target } as unknown as DocumentTargets
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const document = {
    uri: { toString: () => 'untitled:Untitled-1' },
    getText: (range?: vscode.Range) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
    offsetAt: (p: vscode.Position) => offsetAt(p),
    positionAt: (o: number) => {
      let line = 0
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= o) line++
      return new vscode.Position(line, o - lineStarts[line])
    }
  } as unknown as vscode.TextDocument
  function offsetAt(p: vscode.Position): number {
    return lineStarts[p.line] + p.character
  }
  return { core, connections, targets, document, invoke, changed }
}

const invokeContext = {
  triggerKind: vscode.CompletionTriggerKind.Invoke
} as vscode.CompletionContext
const token = { isCancellationRequested: false } as vscode.CancellationToken

describe('SqlCompletionProvider', () => {
  it('offers the open connection’s tables and columns as completion items', async () => {
    const text = 'SELECT * FROM dbo.cu'
    const w = world(text, { connectionId: 'ms', database: 'tienda', schema: 'dbo' }, true)
    const provider = new SqlCompletionProvider(w.core, w.connections, w.targets)
    const items = await provider.provideCompletionItems(
      w.document,
      new vscode.Position(0, text.length),
      token,
      invokeContext
    )
    const customers = items.find((i) => (i.label as { label: string }).label === 'customers')!
    expect(customers.kind).toBe(vscode.CompletionItemKind.Class)
    expect(customers.insertText).toBe('customers')
    expect(w.invoke).toHaveBeenCalledWith('db:tables', 'ms', { database: 'tienda', schema: 'dbo' })
    provider.dispose()
  })

  it('never opens a closed connection: only keywords then', async () => {
    const text = 'SELECT * FROM dbo.cu'
    const w = world(text, { connectionId: 'ms', database: 'tienda', schema: 'dbo' }, false)
    const provider = new SqlCompletionProvider(w.core, w.connections, w.targets)
    const items = await provider.provideCompletionItems(
      w.document,
      new vscode.Position(0, 3),
      token,
      invokeContext
    )
    expect(w.invoke).not.toHaveBeenCalled()
    // Keywords and built-ins, but no table or column of the server.
    expect(items.length).toBeGreaterThan(0)
    expect(
      items.some(
        (i) =>
          i.kind === vscode.CompletionItemKind.Class || i.kind === vscode.CompletionItemKind.Field
      )
    ).toBe(false)
    provider.dispose()
  })

  it('a document without a connection still gets SQL keywords', async () => {
    const w = world('sel', null, false)
    const provider = new SqlCompletionProvider(w.core, w.connections, w.targets)
    const items = await provider.provideCompletionItems(
      w.document,
      new vscode.Position(0, 3),
      token,
      invokeContext
    )
    expect(items.some((i) => (i.label as { label: string }).label === 'SELECT')).toBe(true)
    provider.dispose()
  })
})

describe('SqlFormattingProvider', () => {
  it('formats with the target engine’s grammar (T-SQL keeps GO)', () => {
    const text = 'select [a b] from t\ngo\nselect 1'
    const w = world(text, { connectionId: 'ms', database: 'tienda', schema: 'dbo' }, false)
    const warn = vi.fn()
    const formatting = new SqlFormattingProvider(w.connections, w.targets, warn)
    const [edit] = formatting.provideDocumentFormattingEdits(w.document) as unknown as {
      newText: string
    }[]
    expect(edit.newText).toContain('[a b]')
    expect(edit.newText.split('\n')).toContain('go')
    expect(warn).not.toHaveBeenCalled()
  })
})
