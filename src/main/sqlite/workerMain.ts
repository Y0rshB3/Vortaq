/**
 * Transport-neutral body of the SQLite worker: turns one request into one
 * response on a SqliteCore. worker.ts plugs it into Electron's parentPort;
 * tests plug it into an in-process fake or a Node child process.
 */
import { SqliteCore, toWorkerError } from './core'
import type { WorkerOps, WorkerRequest, WorkerResponse } from './protocol'

export type WorkerHandler = (request: WorkerRequest) => WorkerResponse

export function createWorkerHandler(core = new SqliteCore()): WorkerHandler {
  return (request) => {
    try {
      return { id: request.id, ok: true, result: dispatch(core, request) }
    } catch (err) {
      return { id: request.id, ok: false, error: toWorkerError(err) }
    }
  }
}

function dispatch(core: SqliteCore, request: WorkerRequest): unknown {
  switch (request.op) {
    case 'open':
      return core.open(...(request.args as WorkerOps['open']['args']))
    case 'run':
      return core.runStatement(...(request.args as WorkerOps['run']['args']))
    case 'query':
      return core.query(...(request.args as WorkerOps['query']['args']))
    case 'batch':
      return core.batch(...(request.args as WorkerOps['batch']['args']))
    case 'vacuumInto':
      return core.vacuumInto(...(request.args as WorkerOps['vacuumInto']['args']))
    case 'cursorOpen':
      return core.cursorOpen(...(request.args as WorkerOps['cursorOpen']['args']))
    case 'cursorRead':
      return core.cursorRead(...(request.args as WorkerOps['cursorRead']['args']))
    case 'cursorClose':
      core.cursorClose(...(request.args as WorkerOps['cursorClose']['args']))
      return null
    case 'ping':
      return { pid: process.pid }
    case 'close':
      core.close()
      return null
    default:
      throw new Error(`Operación desconocida: ${String((request as { op: unknown }).op)}`)
  }
}
