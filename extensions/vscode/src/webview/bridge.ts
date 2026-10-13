/**
 * Webview side of the bridge: `window.vortaq` on top of the VS Code webview
 * API, so the desktop renderer's api.ts, stores and components run unchanged
 * (docs/vscode-extension-design.md, "Webview bridge"). Calls become `invoke`
 * messages; the host answers with `result` messages (the value, or the error
 * message only). The host decides what a view may call and confirms writes.
 */
import type { IpcEventChannel, IpcEventMap, VortaqApi } from '@shared/ipc'
import type { ConfirmPayload, HostMessage, WebviewMessage } from '../protocol'

interface VsCodeWebviewApi {
  postMessage(message: unknown): void
}
declare function acquireVsCodeApi(): VsCodeWebviewApi

export interface WebviewHost<State> {
  readonly api: VortaqApi
  post(message: WebviewMessage): void
  /** A modal confirmation shown by the host; resolves the user's answer. */
  confirm(request: ConfirmPayload): Promise<boolean>
  /** Posts `ready` and resolves the first state the host sends. */
  ready(): Promise<State>
  /** Later states (results of a new run…). */
  onState(listener: (state: State) => void): void
}

/** Connects to the host. One per page (acquireVsCodeApi can only be called once). */
export function connectHost<State extends { platform?: string }>(
  vscode: VsCodeWebviewApi = acquireVsCodeApi()
): WebviewHost<State> {
  let platform = 'any'
  let seq = 0
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const confirms = new Map<number, (ok: boolean) => void>()
  const events = new Map<string, Set<(payload: unknown) => void>>()
  const stateListeners = new Set<(state: State) => void>()
  let resolveInit: (state: State) => void = () => undefined
  const init = new Promise<State>((resolve) => (resolveInit = resolve))

  const post = (message: WebviewMessage): void => vscode.postMessage(message)

  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as HostMessage<State> | null
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case 'init':
        platform = message.state?.platform ?? platform
        resolveInit(message.state)
        return
      case 'state':
        platform = message.state?.platform ?? platform
        for (const listener of stateListeners) listener(message.state)
        return
      case 'result': {
        const call = calls.get(message.id)
        if (!call) return
        calls.delete(message.id)
        if (message.ok) call.resolve(message.value)
        else call.reject(new Error(message.message))
        return
      }
      case 'confirmResult': {
        const answer = confirms.get(message.id)
        confirms.delete(message.id)
        answer?.(message.ok === true)
        return
      }
      case 'event':
        for (const listener of events.get(message.channel) ?? []) listener(message.payload)
        return
    }
  })

  const api: VortaqApi = {
    get platform() {
      return platform
    },
    invoke(channel, ...args) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        calls.set(id, { resolve: resolve as (v: unknown) => void, reject })
        post({ type: 'invoke', id, channel, args })
      })
    },
    on<E extends IpcEventChannel>(channel: E, listener: (payload: IpcEventMap[E]) => void) {
      const set = events.get(channel) ?? new Set()
      set.add(listener as (payload: unknown) => void)
      events.set(channel, set)
      return () => set.delete(listener as (payload: unknown) => void)
    }
  }

  return {
    api,
    post,
    confirm(request) {
      const id = ++seq
      return new Promise<boolean>((resolve) => {
        confirms.set(id, resolve)
        post({ type: 'confirm', id, request })
      })
    },
    ready() {
      post({ type: 'ready' })
      return init
    },
    onState(listener) {
      stateListeners.add(listener)
    }
  }
}
