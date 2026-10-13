/**
 * Extension side of the webview bridge (docs/vscode-extension-design.md,
 * "Webview bridge"). A webview is untrusted UI, like the desktop renderer:
 * - every message is checked by parseWebviewMessage; anything malformed is
 *   dropped without an answer;
 * - `invoke` answers only the channels its panel allows (never `app:*` or
 *   `settings:*` as such: a few are answered by host adapters instead), and a
 *   panel-specific scope check can refuse a call (another connection's id…);
 * - write channels go through the WriteGuard, which strips any
 *   `confirmProduction` the webview sent and asks the user itself;
 * - results are made JSON-safe; errors travel as their message only.
 */
import {
  parseWebviewMessage,
  type ConfirmPayload,
  type HostMessage,
  type WebviewMessage
} from '../../protocol'
import { toJsonSafe } from './json'

export type BridgeInvoke = (channel: string, args: unknown[]) => Promise<unknown>

export interface BridgeOptions {
  /** Core channels this panel may call. */
  channels: ReadonlySet<string>
  /** Channels answered by the host itself (file pickers…). */
  local?: Readonly<Record<string, (...args: unknown[]) => unknown>>
  /** Panel-specific check; return a message to refuse the call. */
  scope?: (channel: string, args: readonly unknown[]) => string | null
  /** Called after a successful core call (e.g. remember the id a save returned). */
  after?: (channel: string, args: readonly unknown[], result: unknown) => void
  /** core.invoke. */
  invoke: BridgeInvoke
  /** WriteGuard.prepareWebviewCall. */
  prepare: (
    channel: string,
    args: readonly unknown[]
  ) => Promise<{ args: unknown[] } | { refused: string }>
  /** Messages other than invoke (ready, confirm, notify, clipboard, close, stop). */
  onMessage?: (message: Exclude<WebviewMessage, { type: 'invoke' }>) => void | Promise<void>
  /** Posts an invoke result to the webview. */
  post: (message: Extract<HostMessage, { type: 'result' }>) => void
}

export const NOT_ALLOWED = 'Esta vista no puede usar esa operación.'

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'Error desconocido'

/** Handles one raw message from a webview. Never throws. */
export async function handleWebviewMessage(raw: unknown, options: BridgeOptions): Promise<void> {
  const message = parseWebviewMessage(raw)
  if (!message) return
  if (message.type !== 'invoke') {
    try {
      await options.onMessage?.(message)
    } catch {
      /* a failing UI action (clipboard, modal) never breaks the bridge */
    }
    return
  }
  const { id, channel, args } = message
  const reply = (result: { ok: true; value: unknown } | { ok: false; message: string }): void =>
    options.post({ type: 'result', id, ...result })
  const local =
    options.local && Object.prototype.hasOwnProperty.call(options.local, channel)
      ? options.local[channel]
      : undefined
  if (!local && !options.channels.has(channel)) return reply({ ok: false, message: NOT_ALLOWED })
  const refused = options.scope?.(channel, args) ?? null
  if (refused) return reply({ ok: false, message: refused })
  try {
    if (local) return reply({ ok: true, value: toJsonSafe(await local(...args)) ?? null })
    const prepared = await options.prepare(channel, args)
    if ('refused' in prepared) return reply({ ok: false, message: prepared.refused })
    const value = await options.invoke(channel, prepared.args)
    options.after?.(channel, prepared.args, value)
    reply({ ok: true, value: toJsonSafe(value) ?? null })
  } catch (err) {
    reply({ ok: false, message: messageOf(err) })
  }
}

/** Modal text of a webview confirmation: message, details and the listed items. */
export function confirmDetail(request: ConfirmPayload): string {
  const parts = [request.message]
  if (request.items?.length)
    parts.push(
      request.items
        .map((i) => `${i.tag ? `${i.tag}: ` : ''}${i.text}${i.warning ? ` (${i.warning})` : ''}`)
        .join('\n')
    )
  if (request.details) parts.push(request.details)
  return parts.join('\n\n')
}
