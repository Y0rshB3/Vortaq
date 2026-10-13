import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { AppContext } from '../context'
import { CredentialStore, plainCodec } from '../credentials/store'
import { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from '../storage/repos'
import { getAiService, setAiFetch } from './index'
import { fakeFetch, jsonResponse } from './testing'

const dirs: string[] = []

function makeContext(): AppContext {
  const dir = mkdtempSync(join(tmpdir(), 'vortaq-ai-fetch-'))
  dirs.push(dir)
  return {
    userDataPath: dir,
    logDir: join(dir, 'logs'),
    connections: new ConnectionsRepo(dir),
    jobs: new JobsRepo(dir),
    runs: new RunsRepo(dir),
    settings: new SettingsRepo(dir, dir),
    credentials: new CredentialStore(dir, plainCodec, 'plain'),
    emit: <E extends IpcEventChannel>(_c: E, _p: IpcEventMap[E]) => {},
    headless: true
  }
}

afterEach(() => {
  setAiFetch(null)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AI network port (setAiFetch)', () => {
  it('sends provider calls through the fetch the host registered, also after the service exists', async () => {
    const service = getAiService(makeContext())
    const net = fakeFetch([jsonResponse(200, { data: [{ id: 'm-1' }] })])
    setAiFetch(net.fetch)
    const models = await service.listModels(
      { name: 'OpenAI', type: 'openai', baseUrl: '', model: '' },
      'sk-test'
    )
    expect(models).toEqual(['m-1'])
    expect(net.requests.map((r) => r.url)).toEqual(['https://api.openai.com/v1/models'])
  })
})
