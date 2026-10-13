import { ipcMain } from 'electron'
import type { IpcArgs, IpcChannel } from '@shared/ipc'
import { runHandler, type IpcHandler } from './router'

export { describeForLog, IpcError } from './errorLog'

/**
 * Registers a typed invoke handler on ipcMain: the desktop app's HandleFn
 * (router.ts). Errors are normalised by runHandler so the renderer receives a
 * readable text instead of a serialised object with internals.
 */
export function handle<C extends IpcChannel>(channel: C, fn: IpcHandler<C>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_event, ...args) => runHandler(channel, fn, args as IpcArgs<C>))
}
