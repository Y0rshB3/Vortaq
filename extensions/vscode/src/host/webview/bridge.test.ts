import { describe, expect, it, vi } from 'vitest'
import { MAX_INVOKE_ARGS, parseWebviewMessage } from '../../protocol'
import { confirmDetail, handleWebviewMessage, NOT_ALLOWED, type BridgeOptions } from './bridge'

function options(overrides: Partial<BridgeOptions> = {}) {
  const posted: unknown[] = []
  const opts: BridgeOptions = {
    channels: new Set(['db:tableStructure', 'db:applyRowChanges']),
    invoke: vi.fn(async (channel: string) => ({ channel })),
    prepare: vi.fn(async (_channel: string, args: readonly unknown[]) => ({ args: [...args] })),
    post: (m) => posted.push(m),
    ...overrides
  }
  return { opts, posted }
}

describe('webview messages', () => {
  it('accepts only well-formed messages of the known types', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' })
    expect(
      parseWebviewMessage({ type: 'invoke', id: 3, channel: 'db:tables', args: ['c', 'db'] })
    ).toEqual({
      type: 'invoke',
      id: 3,
      channel: 'db:tables',
      args: ['c', 'db']
    })
    for (const bad of [
      null,
      'ready',
      { type: 'eval', code: '1' },
      { type: 'invoke', id: -1, channel: 'x', args: [] },
      { type: 'invoke', id: 1.5, channel: 'x', args: [] },
      { type: 'invoke', id: 1, channel: 7, args: [] },
      { type: 'invoke', id: 1, channel: 'x', args: 'nope' },
      { type: 'invoke', id: 1, channel: 'x', args: new Array(MAX_INVOKE_ARGS + 1).fill(0) },
      { type: 'notify', level: 'debug', message: 'x' },
      { type: 'confirm', id: 1, request: { title: 'T' } },
      { type: 'clipboard', text: 42 }
    ])
      expect(parseWebviewMessage(bad)).toBeNull()
  })

  it('copies confirmation requests field by field (no extra keys reach the host)', () => {
    const parsed = parseWebviewMessage({
      type: 'confirm',
      id: 1,
      request: {
        title: 'T',
        message: 'M',
        items: [{ text: 'DELETE', extra: 1 }],
        requireTyped: 'x',
        production: true
      }
    })
    expect(parsed).toEqual({
      type: 'confirm',
      id: 1,
      request: { title: 'T', message: 'M', items: [{ text: 'DELETE' }] }
    })
  })
})

describe('handleWebviewMessage', () => {
  it('answers the allowed channels with JSON-safe values', async () => {
    const { opts, posted } = options({ invoke: vi.fn(async () => ({ n: 5n, when: new Date(0) })) })
    await handleWebviewMessage(
      { type: 'invoke', id: 1, channel: 'db:tableStructure', args: ['c', 'db', 't'] },
      opts
    )
    expect(opts.invoke).toHaveBeenCalledWith('db:tableStructure', ['c', 'db', 't'])
    expect(posted).toEqual([
      { type: 'result', id: 1, ok: true, value: { n: '5', when: '1970-01-01T00:00:00.000Z' } }
    ])
  })

  it('refuses channels the panel does not allow, without calling the core', async () => {
    const { opts, posted } = options()
    for (const channel of [
      'db:execute',
      'connections:delete',
      'settings:update',
      'app:openExternal'
    ])
      await handleWebviewMessage({ type: 'invoke', id: 2, channel, args: [] }, opts)
    expect(opts.invoke).not.toHaveBeenCalled()
    expect(posted.every((m) => (m as { message?: string }).message === NOT_ALLOWED)).toBe(true)
  })

  it('applies the panel scope before anything runs', async () => {
    const { opts, posted } = options({
      scope: (_c, args) => (args[0] === 'mine' ? null : 'otra conexión')
    })
    await handleWebviewMessage(
      { type: 'invoke', id: 3, channel: 'db:applyRowChanges', args: ['other'] },
      opts
    )
    expect(opts.prepare).not.toHaveBeenCalled()
    expect(posted).toEqual([{ type: 'result', id: 3, ok: false, message: 'otra conexión' }])
  })

  it('sends the arguments the guard prepared, or its refusal', async () => {
    const prepare = vi.fn(async () => ({ args: ['c', 'db', 't', [], { confirmProduction: true }] }))
    const { opts } = options({ prepare })
    await handleWebviewMessage(
      {
        type: 'invoke',
        id: 4,
        channel: 'db:applyRowChanges',
        args: ['c', 'db', 't', [], { confirmProduction: true }]
      },
      opts
    )
    expect(prepare).toHaveBeenCalledWith('db:applyRowChanges', [
      'c',
      'db',
      't',
      [],
      { confirmProduction: true }
    ])
    expect(opts.invoke).toHaveBeenCalledWith('db:applyRowChanges', [
      'c',
      'db',
      't',
      [],
      { confirmProduction: true }
    ])

    const refused = options({ prepare: vi.fn(async () => ({ refused: 'No se escribió nada' })) })
    await handleWebviewMessage(
      { type: 'invoke', id: 5, channel: 'db:applyRowChanges', args: ['c'] },
      refused.opts
    )
    expect(refused.opts.invoke).not.toHaveBeenCalled()
    expect(refused.posted).toEqual([
      { type: 'result', id: 5, ok: false, message: 'No se escribió nada' }
    ])
  })

  it('reports errors as their message only', async () => {
    const err = new Error('Tabla no encontrada')
    err.stack = 'Error: Tabla no encontrada\n    at secret (/home/u/x.js:1:1)'
    const { opts, posted } = options({ invoke: vi.fn(async () => Promise.reject(err)) })
    await handleWebviewMessage(
      { type: 'invoke', id: 6, channel: 'db:tableStructure', args: [] },
      opts
    )
    expect(posted).toEqual([{ type: 'result', id: 6, ok: false, message: 'Tabla no encontrada' }])
  })

  it('answers host adapters locally and hands other messages over; drops malformed ones', async () => {
    const pick = vi.fn(async () => '/tmp/x.db')
    const onMessage = vi.fn()
    const { opts, posted } = options({ local: { 'app:pickFile': pick }, onMessage })
    await handleWebviewMessage(
      { type: 'invoke', id: 7, channel: 'app:pickFile', args: ['Abrir'] },
      opts
    )
    expect(pick).toHaveBeenCalledWith('Abrir')
    expect(opts.invoke).not.toHaveBeenCalled()
    await handleWebviewMessage({ type: 'clipboard', text: 'a\tb' }, opts)
    await handleWebviewMessage({ type: 'nonsense' }, opts)
    expect(onMessage).toHaveBeenCalledWith({ type: 'clipboard', text: 'a\tb' })
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(posted).toEqual([{ type: 'result', id: 7, ok: true, value: '/tmp/x.db' }])
  })

  it('builds the modal text of a confirmation', () => {
    expect(
      confirmDetail({
        title: '¿Eliminar 1 fila?',
        message: 'Se eliminará 1 fila.',
        items: [{ tag: 'DELETE', text: 'id = 3', warning: 'sin WHERE' }],
        details: 'detalle'
      })
    ).toBe('Se eliminará 1 fila.\n\nDELETE: id = 3 (sin WHERE)\n\ndetalle')
  })
})
