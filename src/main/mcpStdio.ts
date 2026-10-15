/**
 * First module index.ts loads. In MCP mode (`Vortaq --mcp`) stdout carries
 * only the JSON-RPC messages of the MCP transport: everything else that
 * writes to stdout (console.log, a library, a debug line) is sent to stderr
 * instead, before any other module runs. Normal starts are untouched.
 */
import { Writable } from 'node:stream'
import { isMcpArgv } from '@shared/mcp'

export const MCP_MODE = isMcpArgv(process.argv)

let transportOut: Writable | null = null

if (MCP_MODE) {
  const stdoutWrite = process.stdout.write.bind(process.stdout) as (
    chunk: Uint8Array | string,
    callback: (err?: Error | null) => void
  ) => boolean
  const stderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: Uint8Array | string, ...rest: unknown[]) =>
    (stderrWrite as (c: Uint8Array | string, ...r: unknown[]) => boolean)(
      chunk,
      ...rest
    )) as typeof process.stdout.write
  for (const level of ['log', 'info', 'debug', 'trace'] as const)
    console[level] = (...args: unknown[]) => console.error(...args)
  transportOut = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stdoutWrite(chunk, (err) => callback(err ?? null))
    }
  })
}

/** The only writer of the real stdout in MCP mode (the MCP stdio transport). */
export function mcpStdout(): Writable {
  if (!transportOut) throw new Error('mcpStdout() is only available in MCP mode')
  return transportOut
}
