/**
 * The part of the `vscode` module the extension's unit tests reach (vitest
 * aliases `vscode` to this file). Window prompts are vi.fn()s each test
 * programs; nothing here talks to an editor.
 */
import { vi } from 'vitest'

export class EventEmitter<T> {
  private listeners = new Set<(value: T) => void>()
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }
  fire(value: T): void {
    for (const l of [...this.listeners]) l(value)
  }
  dispose(): void {
    this.listeners.clear()
  }
}

export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn()
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class TreeItem {
  id?: string
  description?: string
  tooltip?: unknown
  iconPath?: unknown
  contextValue?: string
  resourceUri?: Uri
  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export enum InputBoxValidationSeverity {
  Info = 1,
  Warning = 2,
  Error = 3
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query = ''
  ) {}
  static file(path: string): Uri {
    return new Uri('file', path)
  }
  static parse(value: string): Uri {
    const [scheme, rest = ''] = value.split(':', 2)
    return new Uri(scheme, rest)
  }
  static from(parts: { scheme: string; path?: string; query?: string }): Uri {
    return new Uri(parts.scheme, parts.path ?? '', parts.query ?? '')
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, [base.path, ...segments].join('/'))
  }
  get fsPath(): string {
    return this.path
  }
  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`
  }
}

export class MarkdownString {
  value = ''
  constructor(value = '') {
    this.value = value
  }
  appendMarkdown(text: string): this {
    this.value += text
    return this
  }
}

export const window = {
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  setStatusBarMessage: vi.fn(),
  createStatusBarItem: vi.fn(() => ({ show: vi.fn(), hide: vi.fn(), dispose: vi.fn() })),
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  activeTextEditor: undefined as unknown
}

export const workspace = {
  getConfiguration: vi.fn(() => ({ get: (_key: string, fallback: unknown) => fallback })),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  workspaceFolders: undefined as unknown
}

export const env = {
  clipboard: { writeText: vi.fn() }
}

export const commands = {
  executeCommand: vi.fn(),
  registerCommand: vi.fn(() => ({ dispose: vi.fn() }))
}
