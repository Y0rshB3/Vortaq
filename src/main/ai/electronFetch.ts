/**
 * Electron adapter of the AI network port (setAiFetch in ./index.ts): provider
 * calls go through Electron's network stack, which uses the system proxy and
 * certificates. Desktop-only; registered by src/main/index.ts.
 */
import { net } from 'electron'
import type { FetchFn } from './adapter'

export const electronFetch: FetchFn = ((input: Parameters<FetchFn>[0], init?: RequestInit) =>
  net.fetch(input instanceof URL ? input.toString() : input, init)) as FetchFn
