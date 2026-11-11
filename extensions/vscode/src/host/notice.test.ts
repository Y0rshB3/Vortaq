import { describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { plainNoticeText, showError, showInformation, showWarning } from './notice'

const ZWSP = '​'

describe('notifications never carry a link the editor would open', () => {
  it('breaks up [text](target) so it is plain text, and leaves the rest as it reads', () => {
    const server =
      'Mensaje del servidor: [Reintentar](command:workbench.action.terminal.sendSequence?%7B%7D "Reintentar")'
    const plain = plainNoticeText(server)
    expect(plain).not.toMatch(/\]\s*\(/)
    expect(plain.split(ZWSP).join('')).toBe(server)
    expect(plainNoticeText('[a] (b)')).not.toMatch(/\]\s*\(/)
    expect(plainNoticeText('Sin enlaces: tabla [x] y (y)')).toBe('Sin enlaces: tabla [x] y (y)')
  })

  it('every kind of notification goes through it, with its buttons unchanged', async () => {
    vi.mocked(vscode.window.showErrorMessage).mockClear()
    await showError('[x](command:y)', 'Editar conexión')
    expect(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]).toEqual([
      `[x]${ZWSP}(command:y)`,
      'Editar conexión'
    ])
    await showWarning('[x](https://example.com)')
    await showInformation('[x](command:z)', { modal: false }, 'Abrir')
    expect(String(vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[0])).not.toMatch(
      /\]\(/
    )
    const info = vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)
    expect(String(info?.[0])).not.toMatch(/\]\(/)
    expect(info?.slice(1)).toEqual([{ modal: false }, 'Abrir'])
  })
})
