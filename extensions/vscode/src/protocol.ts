/**
 * Messages between the extension host and Vortaq's webviews (connection form,
 * results). Pure: no `vscode`, Node or DOM imports, so both sides and the unit
 * tests share it.
 *
 * The webview side mirrors the renderer's `window.vortaq.invoke` on top of
 * these messages (docs/vscode-extension-design.md, "Webview bridge"): the
 * host checks every message here, then answers only the IPC channels its
 * panel allows. Messages are JSON (VS Code serialises them), so results go
 * through `toJsonSafe` first.
 */

/** A confirmation the webview asks the host to show (useConfirm → ui.ask). */
export interface ConfirmPayload {
  title: string
  message: string
  details?: string
  items?: { text: string; tag?: string; warning?: string }[]
  confirmText?: string
  /** Destructive operation: the host's modal says so. */
  danger?: boolean
  /** Information only (one button). */
  notice?: boolean
}

export type NotifyLevel = 'success' | 'info' | 'warning' | 'error'

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'invoke'; id: number; channel: string; args: unknown[] }
  | { type: 'confirm'; id: number; request: ConfirmPayload }
  | { type: 'notify'; level: NotifyLevel; message: string }
  | { type: 'clipboard'; text: string; label?: string }
  | { type: 'close' }
  | { type: 'stop' }
  /** The results webview holds unapplied row edits (or no longer does). */
  | { type: 'dirty'; dirty: boolean }

export type HostMessage<State = unknown> =
  | { type: 'init'; state: State }
  | { type: 'state'; state: State }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; message: string }
  | { type: 'confirmResult'; id: number; ok: boolean }
  | { type: 'event'; channel: string; payload: unknown }

/** Largest argument list a channel of the IPC map takes (db:createDatabase has 6). */
export const MAX_INVOKE_ARGS = 8
/** Longest text copied to the clipboard in one message (50 MB of UTF-16). */
export const MAX_CLIPBOARD_CHARS = 25_000_000
const MAX_TEXT = 20_000
const NOTIFY_LEVELS: readonly NotifyLevel[] = ['success', 'info', 'warning', 'error']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const shortText = (v: unknown, max = MAX_TEXT): v is string =>
  typeof v === 'string' && v.length <= max

function confirmPayload(v: unknown): ConfirmPayload | null {
  if (!isRecord(v) || !shortText(v.title, 500) || !shortText(v.message)) return null
  if (v.details !== undefined && !shortText(v.details)) return null
  if (v.confirmText !== undefined && !shortText(v.confirmText, 200)) return null
  let items: ConfirmPayload['items']
  if (v.items !== undefined) {
    if (!Array.isArray(v.items) || v.items.length > 500) return null
    items = []
    for (const item of v.items) {
      if (!isRecord(item) || !shortText(item.text, 2000)) return null
      if (item.tag !== undefined && !shortText(item.tag, 200)) return null
      if (item.warning !== undefined && !shortText(item.warning, 500)) return null
      items.push({
        text: item.text,
        ...(item.tag !== undefined ? { tag: item.tag as string } : {}),
        ...(item.warning !== undefined ? { warning: item.warning as string } : {})
      })
    }
  }
  return {
    title: v.title,
    message: v.message,
    ...(v.details !== undefined ? { details: v.details as string } : {}),
    ...(items ? { items } : {}),
    ...(v.confirmText !== undefined ? { confirmText: v.confirmText as string } : {}),
    ...(v.danger === true ? { danger: true } : {}),
    ...(v.notice === true ? { notice: true } : {})
  }
}

/**
 * The message a webview posted, checked field by field, or null for anything
 * malformed (unknown type, wrong field types, oversized text). The host drops
 * null messages without answering.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null
  switch (raw.type) {
    case 'ready':
    case 'close':
    case 'stop':
      return { type: raw.type }
    case 'invoke':
      if (!isId(raw.id) || !shortText(raw.channel, 64) || !Array.isArray(raw.args)) return null
      if (raw.args.length > MAX_INVOKE_ARGS) return null
      return { type: 'invoke', id: raw.id, channel: raw.channel, args: raw.args }
    case 'confirm': {
      if (!isId(raw.id)) return null
      const request = confirmPayload(raw.request)
      return request ? { type: 'confirm', id: raw.id, request } : null
    }
    case 'dirty':
      return typeof raw.dirty === 'boolean' ? { type: 'dirty', dirty: raw.dirty } : null
    case 'notify':
      if (!NOTIFY_LEVELS.includes(raw.level as NotifyLevel) || !shortText(raw.message)) return null
      return { type: 'notify', level: raw.level as NotifyLevel, message: raw.message }
    case 'clipboard':
      if (!shortText(raw.text, MAX_CLIPBOARD_CHARS)) return null
      if (raw.label !== undefined && !shortText(raw.label, 200)) return null
      return {
        type: 'clipboard',
        text: raw.text,
        ...(raw.label !== undefined ? { label: raw.label as string } : {})
      }
    default:
      return null
  }
}
