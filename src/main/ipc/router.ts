/**
 * Host-neutral side of the typed IPC map. Feature modules register their
 * handlers through a `HandleFn`: the desktop app passes the ipcMain-backed
 * `handle` of typed.ts, other hosts (the editor extension, Node tests) a
 * `HandlerRegistry`. Nothing here imports Electron (docs/vscode-extension-design.md).
 */
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import { getLogger } from '../log'
import { describeForLog } from './errorLog'

const log = getLogger('ipc')

export type IpcHandler<C extends IpcChannel> = (
  ...args: IpcArgs<C>
) => Promise<IpcResult<C>> | IpcResult<C>

/** Registers the handler of one channel of the IPC map. */
export type HandleFn = <C extends IpcChannel>(channel: C, fn: IpcHandler<C>) => void

/**
 * Runs a handler. A failure is logged with describeForLog (never row data or
 * secrets) and rethrown as a plain Error with only its message, so the caller
 * receives a readable text instead of a serialised object with internals.
 */
export async function runHandler<C extends IpcChannel>(
  channel: C,
  fn: IpcHandler<C>,
  args: IpcArgs<C>
): Promise<IpcResult<C>> {
  try {
    return await fn(...args)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`${channel} failed: ${describeForLog(err)}`)
    throw new Error(message)
  }
}

/**
 * In-memory handler table for hosts without ipcMain. `invoke` behaves like
 * the renderer's `window.vortaq.invoke`: same handlers, same guards, same
 * error normalisation.
 */
export class HandlerRegistry {
  private readonly handlers = new Map<IpcChannel, (...args: never[]) => unknown>()

  /** Same contract as typed.ts `handle`: a later registration replaces the earlier one. */
  readonly handle: HandleFn = (channel, fn) => {
    this.handlers.set(channel, fn as (...args: never[]) => unknown)
  }

  has(channel: IpcChannel): boolean {
    return this.handlers.has(channel)
  }

  /** Registered channels, in registration order. */
  channels(): IpcChannel[] {
    return [...this.handlers.keys()]
  }

  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
    const fn = this.handlers.get(channel) as IpcHandler<C> | undefined
    if (!fn) return Promise.reject(new Error(`Canal no disponible: ${channel}`))
    return runHandler(channel, fn, args)
  }
}
