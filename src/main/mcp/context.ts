/**
 * The AppContext of the MCP process: the desktop profile's files, read-only.
 * The caller turns on JsonStore's reload and read-only modes for the process
 * (setJsonStoreReload / setJsonStoreReadOnly) so every call sees what the
 * open app saved last and nothing is ever written back.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppContext } from '../context'
import { CredentialStore, type CodecName, type SecretCodec } from '../credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '../storage/repos'

export interface McpContextOptions {
  /** The Vortaq profile folder (VORTAQ_USER_DATA or <appData>/Vortaq). */
  profileDir: string
  secrets: { codec: SecretCodec; codecName: CodecName }
  home?: string
}

export function createMcpContext(options: McpContextOptions): AppContext {
  const dir = options.profileDir
  return {
    userDataPath: dir,
    logDir: join(dir, 'logs'),
    connections: new ConnectionsRepo(dir),
    jobs: new JobsRepo(dir),
    runs: new RunsRepo(dir),
    settings: new SettingsRepo(dir, options.home ?? homedir()),
    credentials: new CredentialStore(dir, options.secrets.codec, options.secrets.codecName),
    emit: () => undefined,
    // Headless: a `mysql` connection whose server is MariaDB is never rewritten to `mariadb`.
    headless: true,
    isolatedProfile: true
  }
}
