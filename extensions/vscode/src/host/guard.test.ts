import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import type { ConnectionConfig, Environment, VortaqCore } from '@core'
import { stripConfirm, vscodePrompter, WriteGuard, type Prompter } from './guard'

function connection(
  id: string,
  environment: Environment,
  engine: ConnectionConfig['engine'] = 'mysql'
): ConnectionConfig {
  return { id, name: `Base ${id}`, environment, engine } as ConnectionConfig
}

/** The part of the core the guard reads: connections and the typed-confirmation settings. */
function fakeCore(
  list: ConnectionConfig[],
  typedConfirmEnvironments: Environment[] = ['production']
): VortaqCore {
  return {
    context: {
      connections: { get: (id: string) => list.find((c) => c.id === id) ?? null },
      settings: { get: () => ({ typedConfirmEnvironments }) }
    }
  } as unknown as VortaqCore
}

function prompter(
  typed: string | undefined,
  confirm = true
): Prompter & {
  typedName: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn>
} {
  return { typedName: vi.fn(async () => typed), confirm: vi.fn(async () => confirm) }
}

const prod = connection('p', 'production')
const local = connection('l', 'local')
const staging = connection('s', 'staging', 'postgresql')

describe('SQL from an editor', () => {
  it('a write on production asks for the connection name and then confirms it', async () => {
    const ask = prompter('Base p')
    const guard = new WriteGuard(fakeCore([prod]), () => ask)
    const decision = await guard.checkSql(prod, 'UPDATE t SET a = 1 WHERE id = 2', true)
    expect(decision).toEqual({ proceed: true, confirmProduction: true })
    expect(ask.typedName).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Base p', title: 'Confirmar escritura en producción' })
    )
    // The typed confirmation replaces the destructive one: one dialog at most.
    expect(ask.confirm).not.toHaveBeenCalled()
  })

  it('a wrong name or a dismissed prompt runs nothing', async () => {
    for (const typed of ['base p', undefined]) {
      const guard = new WriteGuard(fakeCore([prod]), () => prompter(typed))
      expect(await guard.checkSql(prod, 'DELETE FROM t', true)).toEqual({
        proceed: false,
        confirmProduction: false
      })
    }
  })

  it('read-only statements on production run without asking', async () => {
    const ask = prompter('Base p')
    const guard = new WriteGuard(fakeCore([prod]), () => ask)
    expect(await guard.checkSql(prod, 'SELECT * FROM t; SHOW TABLES', true)).toEqual({
      proceed: true,
      confirmProduction: false
    })
    expect(ask.typedName).not.toHaveBeenCalled()
  })

  it('anything not provably read-only counts as a write (allowlist)', async () => {
    const ask = prompter(undefined)
    const guard = new WriteGuard(fakeCore([prod]), () => ask)
    expect((await guard.checkSql(prod, 'CALL mystery()', true)).proceed).toBe(false)
    expect(ask.typedName).toHaveBeenCalledOnce()
  })

  it('environments chosen in vortaq.typedConfirmEnvironments ask too', async () => {
    const ask = prompter('Base s')
    const guard = new WriteGuard(fakeCore([staging], ['production', 'staging']), () => ask)
    expect(await guard.checkSql(staging, 'INSERT INTO t VALUES (1)', true)).toEqual({
      proceed: true,
      confirmProduction: true
    })
    expect(ask.typedName.mock.calls[0][0].title).toBe('Confirmar escritura en «Base s»')
  })

  it('elsewhere, destructive statements ask once when the setting is on', async () => {
    const ask = prompter(undefined, false)
    const guard = new WriteGuard(fakeCore([local]), () => ask)
    expect(await guard.checkSql(local, 'DROP TABLE clientes', true)).toEqual({
      proceed: false,
      confirmProduction: false
    })
    expect(ask.confirm.mock.calls[0][0]).toMatchObject({ confirmText: 'Ejecutar' })
    expect(ask.confirm.mock.calls[0][0].detail).toContain('DROP TABLE')
    // Off: no question; a plain write never asks on an unguarded connection.
    const quiet = prompter(undefined, false)
    const relaxed = new WriteGuard(fakeCore([local]), () => quiet)
    expect((await relaxed.checkSql(local, 'DROP TABLE clientes', false)).proceed).toBe(true)
    expect((await relaxed.checkSql(local, 'UPDATE t SET a = 1 WHERE id = 1', true)).proceed).toBe(
      true
    )
    expect(quiet.confirm).not.toHaveBeenCalled()
  })
})

describe('webview calls', () => {
  const changes = [
    { kind: 'update', key: { id: 1 }, values: { a: 2 } },
    { kind: 'delete', key: { id: 3 } }
  ]

  it('never forwards a confirmProduction the webview sent', async () => {
    const ask = prompter(undefined)
    const guard = new WriteGuard(fakeCore([local]), () => ask)
    const prepared = await guard.prepareWebviewCall('db:applyRowChanges', [
      'l',
      'tienda',
      'clientes',
      changes,
      { confirmProduction: true }
    ])
    expect(prepared).toEqual({ args: ['l', 'tienda', 'clientes', changes, {}] })
    expect(ask.typedName).not.toHaveBeenCalled()
    expect(stripConfirm({ confirmProduction: true, schema: 'x' })).toEqual({ schema: 'x' })
    expect(stripConfirm('plain')).toBe('plain')
  })

  it('a row write on production asks here, then carries the confirmation', async () => {
    const ask = prompter('Base p')
    const guard = new WriteGuard(fakeCore([prod]), () => ask)
    const prepared = await guard.prepareWebviewCall('db:applyRowChanges', [
      'p',
      'tienda',
      'clientes',
      changes
    ])
    expect(prepared).toEqual({
      args: ['p', 'tienda', 'clientes', changes, { confirmProduction: true }]
    })
    expect(ask.typedName.mock.calls[0][0].prompt).toContain(
      'Se aplicarán 2 cambios en tienda.clientes (1 modificación, 1 fila borrada).'
    )
  })

  it('refuses when the name is not typed, even if the webview claimed it was', async () => {
    const guard = new WriteGuard(fakeCore([prod]), () => prompter('otra'))
    const prepared = await guard.prepareWebviewCall('db:applyRowChanges', [
      'p',
      { database: 'app', schema: 'public' },
      'clientes',
      changes,
      { confirmProduction: true }
    ])
    expect(prepared).toEqual({
      refused:
        'No se escribió nada: para escribir en «Base p» hay que confirmar escribiendo el nombre de la conexión.'
    })
  })

  it('reads (structure) pass through without asking', async () => {
    const ask = prompter(undefined)
    const guard = new WriteGuard(fakeCore([prod]), () => ask)
    expect(
      await guard.prepareWebviewCall('db:tableStructure', ['p', 'tienda', 'clientes'])
    ).toEqual({
      args: ['p', 'tienda', 'clientes']
    })
    expect(ask.typedName).not.toHaveBeenCalled()
  })
})

describe('VS Code prompts', () => {
  beforeEach(() => vi.mocked(vscode.window.showInputBox).mockReset())

  it('the typed-name input box only validates the exact name', async () => {
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('Base p' as never)
    await vscodePrompter.typedName({ title: 'T', prompt: 'P', name: 'Base p' })
    const options = vi.mocked(vscode.window.showInputBox).mock.calls[0][0]!
    expect(options).toMatchObject({ title: 'T', prompt: 'P', ignoreFocusOut: true })
    const validate = options.validateInput!
    expect(validate('Base p')).toBeNull()
    expect(validate('base p')).toBe('El nombre no coincide: escribe «Base p».')
    expect(validate('')).toMatchObject({ severity: vscode.InputBoxValidationSeverity.Info })
  })

  it('the modal confirmation is true only for its confirm button', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Ejecutar' as never)
    expect(await vscodePrompter.confirm({ title: 'T', detail: 'D', confirmText: 'Ejecutar' })).toBe(
      true
    )
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never)
    expect(await vscodePrompter.confirm({ title: 'T', detail: 'D', confirmText: 'Ejecutar' })).toBe(
      false
    )
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][1]).toEqual({
      modal: true,
      detail: 'D'
    })
  })
})
