import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiDoneEvent } from '@shared/ai'
import type { AppSettings } from '@shared/types'
import { CredentialStore, plainCodec } from '../credentials/store'
import type { AdapterRequest, ChatAdapter } from './adapter'
import { explainSelect, formatPlan, isSingleSelect } from './explain'
import { isMetadataSql, type Queryable } from './metadata'
import { buildUserMessage, trimHistory } from './prompts'
import { normalizeProviderInput, resolveBaseUrl } from './providers'
import { AiService, type AiServiceDeps, type BorrowedSession } from './service'
import { AiConversationsRepo, AiMemoryRepo } from './store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vortaq-ai-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('base URL validation and presets', () => {
  it('fixed presets ignore any stored URL', () => {
    expect(resolveBaseUrl('openai', 'https://evil.example.com')).toBe('https://api.openai.com/v1')
    expect(resolveBaseUrl('groq', '')).toBe('https://api.groq.com/openai/v1')
    expect(resolveBaseUrl('xai', '')).toBe('https://api.x.ai/v1')
    expect(resolveBaseUrl('zhipu', '')).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(resolveBaseUrl('zai', '')).toBe('https://api.z.ai/api/paas/v4')
    expect(resolveBaseUrl('anthropic', 'x')).toBe('')
  })

  it('Ollama defaults to localhost and accepts http only locally', () => {
    expect(resolveBaseUrl('ollama', '')).toBe('http://localhost:11434/v1')
    expect(resolveBaseUrl('ollama', 'http://127.0.0.1:11500/v1/')).toBe('http://127.0.0.1:11500/v1')
    expect(() => resolveBaseUrl('ollama', 'http://192.168.1.5:11434/v1')).toThrow(/https/)
  })

  it('custom requires a valid https URL (http only for localhost)', () => {
    expect(() => resolveBaseUrl('custom', '')).toThrow(/URL base/)
    expect(() => resolveBaseUrl('custom', 'nope')).toThrow(/no es válida/)
    expect(() => resolveBaseUrl('custom', 'http://llm.example.com/v1')).toThrow(/https/)
    expect(() => resolveBaseUrl('custom', 'ftp://llm.example.com')).toThrow(/https/)
    expect(() => resolveBaseUrl('custom', 'https://user:pw@llm.example.com')).toThrow(/usuario/)
    expect(() => resolveBaseUrl('custom', 'https://llm.example.com/v1?key=1')).toThrow(/parámetros/)
    expect(resolveBaseUrl('custom', 'https://llm.example.com/v1')).toBe(
      'https://llm.example.com/v1'
    )
    expect(resolveBaseUrl('custom', 'http://localhost:8080/v1')).toBe('http://localhost:8080/v1')
  })

  it('normalises profiles', () => {
    expect(
      normalizeProviderInput({ name: '', type: 'anthropic', baseUrl: '', model: '' })
    ).toMatchObject({
      name: 'Anthropic Claude',
      model: 'claude-opus-5-5'
    })
    expect(() =>
      normalizeProviderInput({ name: 'x', type: 'openai', baseUrl: '', model: '' })
    ).toThrow(/modelo/)
    expect(() =>
      normalizeProviderInput({ name: 'x', type: 'nope' as never, baseUrl: '', model: 'm' })
    ).toThrow(/Tipo/)
  })
})

describe('conversation and memory persistence', () => {
  it('saves, lists, renames and deletes conversations per connection (local JSON)', () => {
    const repo = new AiConversationsRepo(dir)
    const a = repo.save({
      connectionId: 'c1',
      title: 'Primera',
      schema: 'app',
      messages: [{ role: 'user', text: 'hola' }]
    })
    repo.save({ connectionId: 'c2', title: 'Otra', schema: null, messages: [] })
    expect(repo.list('c1').map((c) => c.title)).toEqual(['Primera'])
    const renamed = repo.save({ ...a, title: 'Renombrada' })
    expect(renamed.id).toBe(a.id)
    expect(renamed.createdAt).toBe(a.createdAt)
    // a fresh repo reads it back from disk
    const again = new AiConversationsRepo(dir)
    expect(again.get('c1', a.id)).toMatchObject({
      title: 'Renombrada',
      messages: [{ role: 'user', text: 'hola' }]
    })
    again.delete('c1', a.id)
    expect(again.list('c1')).toEqual([])
    expect(readdirSync(join(dir, 'ai')).length).toBe(2)
    again.deleteConnection('c2')
    expect(readdirSync(join(dir, 'ai')).length).toBe(1)
  })

  it('drops invalid messages', () => {
    const repo = new AiConversationsRepo(dir)
    const c = repo.save({
      connectionId: 'c1',
      title: '',
      schema: null,
      messages: [
        { role: 'system' as never, text: 'x' },
        { role: 'assistant', text: 'ok', stopReason: 'weird' as never }
      ]
    })
    expect(c.title).toBe('Conversación')
    expect(c.messages).toEqual([{ role: 'assistant', text: 'ok' }])
  })

  it('keeps memory per connection and per database', () => {
    const repo = new AiMemoryRepo(dir)
    repo.set('c1', null, 'status 3 = baja')
    repo.set('c1', 'app', 'tablas en español')
    const again = new AiMemoryRepo(dir)
    expect(again.get('c1', null)).toBe('status 3 = baja')
    expect(again.get('c1', 'app')).toBe('tablas en español')
    expect(again.get('c1', 'other')).toBe('')
    expect(() => again.set('c1', null, 'x'.repeat(20_001))).toThrow(/demasiado larga/)
    again.deleteConnection('c1')
    expect(again.get('c1', null)).toBe('')
  })
})

describe('prompts', () => {
  it('trims history to alternating turns ending with the assistant', () => {
    expect(
      trimHistory([
        { role: 'assistant', text: 'orphan' },
        { role: 'user', text: 'a' },
        { role: 'user', text: 'b' },
        { role: 'assistant', text: '' },
        { role: 'assistant', text: 'c' },
        { role: 'user', text: 'unanswered' }
      ])
    ).toEqual([
      { role: 'user', text: 'a\n\nb' },
      { role: 'assistant', text: 'c' }
    ])
  })

  it('builds the volatile user turn per mode', () => {
    const base = { providerId: null, connectionId: 'c', schema: 'app', history: [] }
    expect(buildUserMessage({ ...base, mode: 'chat', input: 'hola' }, null)).toBe('hola')
    const err = buildUserMessage(
      { ...base, mode: 'explainError', input: '', sql: 'SELEC 1', error: 'You have an error' },
      null
    )
    expect(err).toMatch(/failed on the server/)
    expect(err).toContain('```sql\nSELEC 1\n```')
    expect(err).toContain('Server error:\nYou have an error')
    const explain = buildUserMessage(
      { ...base, mode: 'explain', input: '', sql: 'SELECT 1' },
      'id | type\n1 | ALL'
    )
    expect(explain).toContain('EXPLAIN plan')
  })
})

describe('EXPLAIN only for one SELECT', () => {
  it('detects single SELECT statements', () => {
    expect(isSingleSelect('SELECT 1')).toBe(true)
    expect(isSingleSelect('  -- comment\n/* c */ (SELECT 1) UNION (SELECT 2);')).toBe(true)
    expect(isSingleSelect('SELECT 1; SELECT 2')).toBe(false)
    expect(isSingleSelect('DELETE FROM t')).toBe(false)
    expect(isSingleSelect('UPDATE t SET a = 1')).toBe(false)
    expect(isSingleSelect('WITH x AS (SELECT 1) DELETE FROM t')).toBe(false)
    expect(isSingleSelect('')).toBe(false)
  })

  it('runs EXPLAIN only for a SELECT and formats the plan', async () => {
    const calls: string[] = []
    const plan = [
      {
        id: 1,
        select_type: 'SIMPLE',
        table: 't',
        type: 'ALL',
        key: null,
        rows: 10,
        Extra: 'Using where'
      }
    ]
    const q: Queryable = {
      query: async <T>(sql: string): Promise<T[]> => {
        calls.push(sql)
        return plan as T[]
      }
    }
    expect(await explainSelect(q, 'DROP TABLE t')).toBeNull()
    expect(calls).toEqual([])
    const text = await explainSelect(q, 'SELECT * FROM t WHERE a = 1;')
    expect(calls).toEqual(['EXPLAIN SELECT * FROM t WHERE a = 1'])
    expect(text).toBe(
      'id | select_type | table | type | rows | Extra\n1 | SIMPLE | t | ALL | 10 | Using where'
    )
    expect(formatPlan([])).toBe('(sin plan)')
  })
})

/* ---------- service ---------- */

const SETTINGS: AppSettings = {
  navicatRootPath: '',
  backupsRootDir: '',
  defaultRowLimit: 1000,
  theme: 'dark',
  typedConfirmEnvironments: ['production'],
  confirmDestructiveEverywhere: true,
  checkUpdatesOnStartup: true,
  autoDownloadUpdates: false,
  aiEnabled: true,
  aiDefaultProviderId: null,
  aiEffort: 'medium',
  aiMaxTokens: 8000,
  mcpEnabled: false
}

function harness(
  options: { settings?: Partial<AppSettings>; answer?: string; deps?: Partial<AiServiceDeps> } = {}
) {
  const credentials = new CredentialStore(dir, plainCodec, 'plain')
  const events: { channel: string; payload: unknown }[] = []
  const sessionSql: string[] = []
  const requests: AdapterRequest[] = []
  const fakeAdapter: ChatAdapter = {
    async chat(req, cb) {
      requests.push(req)
      cb.onText(options.answer ?? 'respuesta')
      return { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    },
    test: async () => ({ ok: true, message: 'ok' }),
    listModels: async () => ['m1']
  }
  const acquire = vi.fn(async (): Promise<BorrowedSession> => ({
    async query<T>(sql: string): Promise<T[]> {
      sessionSql.push(sql)
      if (/^EXPLAIN/.test(sql)) return [{ id: 1, type: 'ALL' }] as T[]
      if (/SCHEMATA/.test(sql)) return [{ name: 'app' }, { name: 'crm' }] as T[]
      if (/VERSION/.test(sql)) return [{ version: '8.4.3' }] as T[]
      if (/information_schema\.TABLES/.test(sql))
        return [
          { TABLE_NAME: 'orders', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 5, TABLE_COMMENT: '' }
        ] as T[]
      if (/information_schema\.COLUMNS/.test(sql))
        return [
          {
            TABLE_NAME: 'orders',
            COLUMN_NAME: 'id',
            COLUMN_TYPE: 'int',
            IS_NULLABLE: 'NO',
            COLUMN_KEY: 'PRI',
            EXTRA: '',
            COLUMN_COMMENT: ''
          }
        ] as T[]
      return []
    },
    release: async () => undefined
  }))
  const service = new AiService({
    userDataPath: dir,
    credentials,
    settings: { get: () => ({ ...SETTINGS, ...options.settings }) },
    environmentOf: () => 'production',
    acquire,
    emit: (channel, payload) => events.push({ channel, payload }),
    log: { info: () => undefined, warn: () => undefined },
    adapterFactory: () => fakeAdapter,
    ...options.deps
  })
  const done = (): Promise<AiDoneEvent> =>
    vi.waitFor(() => {
      const e = events.find((x) => x.channel === 'event:aiDone')
      if (!e) throw new Error('not done')
      return e.payload as AiDoneEvent
    })
  return { service, credentials, events, sessionSql, requests, acquire, done }
}

describe('AiService', () => {
  it('never returns keys to the renderer', () => {
    const { service, credentials } = harness()
    const p = service.saveProvider({
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5'
    })
    service.setKey(p.id, '  sk-ant-secret  ')
    expect(credentials.get('ai', p.id)).toBe('sk-ant-secret')
    const views = service.listProviders()
    expect(views).toEqual([expect.objectContaining({ id: p.id, hasKey: true })])
    expect(JSON.stringify(views)).not.toContain('sk-ant-secret')
    expect(JSON.stringify(service.saveProvider({ ...p }))).not.toContain('sk-ant-secret')
    expect(readFileSync(join(dir, 'ai-providers.json'), 'utf8')).not.toContain('sk-ant-secret')
    service.deleteProvider(p.id)
    expect(credentials.has('ai', p.id)).toBe(false)
  })

  it('refuses to chat while disabled or without a provider', () => {
    const off = harness({ settings: { aiEnabled: false } })
    expect(() =>
      off.service.startChat({
        providerId: null,
        connectionId: 'c',
        schema: null,
        mode: 'chat',
        history: [],
        input: 'x'
      })
    ).toThrow(/desactivado/)
    const none = harness()
    expect(() =>
      none.service.startChat({
        providerId: null,
        connectionId: 'c',
        schema: null,
        mode: 'chat',
        history: [],
        input: 'x'
      })
    ).toThrow(/Configura un proveedor/)
  })

  it('streams an answer built from structure only and the user text', async () => {
    const h = harness()
    h.service.saveProvider({
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5'
    })
    h.service.memory.set('c1', null, 'status 2 = pagado')
    const { requestId } = h.service.startChat({
      providerId: null,
      connectionId: 'c1',
      schema: 'app',
      mode: 'chat',
      history: [
        { role: 'user', text: 'antes' },
        { role: 'assistant', text: 'vale' }
      ],
      input: '¿cuántos pedidos?'
    })
    const done = await h.done()
    expect(done).toMatchObject({ requestId, stopReason: 'end_turn' })
    expect(
      h.events.some(
        (e) => e.channel === 'event:aiDelta' && (e.payload as { text: string }).text === 'respuesta'
      )
    ).toBe(true)
    const req = h.requests[0]
    expect(req.effort).toBe('medium')
    expect(req.maxTokens).toBe(8000)
    expect(req.context).toContain('Entorno de la conexión: Producción.')
    expect(req.context).toContain('status 2 = pagado')
    expect(req.context).toContain('orders ~5 filas: id int PK')
    expect(req.history).toHaveLength(2)
    expect(req.userMessage).toBe('¿cuántos pedidos?')
    // Only metadata statements reached the server.
    expect(h.sessionSql.length).toBeGreaterThan(0)
    for (const sql of h.sessionSql) expect(isMetadataSql(sql)).toBe(true)
  })

  it('runs EXPLAIN for a single SELECT in explain mode and nothing else', async () => {
    const h = harness()
    h.service.saveProvider({
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5'
    })
    h.service.startChat({
      providerId: null,
      connectionId: 'c1',
      schema: 'app',
      mode: 'explain',
      history: [],
      input: '',
      sql: 'SELECT * FROM orders'
    })
    await h.done()
    expect(h.sessionSql.filter((s) => !isMetadataSql(s))).toEqual(['EXPLAIN SELECT * FROM orders'])
    expect(h.requests[0].userMessage).toContain('EXPLAIN plan (from the server')

    const h2 = harness()
    h2.service.saveProvider({
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5'
    })
    h2.service.startChat({
      providerId: null,
      connectionId: 'c1',
      schema: 'app',
      mode: 'explain',
      history: [],
      input: '',
      sql: 'DELETE FROM orders'
    })
    await h2.done()
    expect(h2.sessionSql.filter((s) => !isMetadataSql(s))).toEqual([])
    expect(h2.requests[0].userMessage).not.toContain('EXPLAIN plan (from the server')
    expect(h2.acquire).toHaveBeenCalledTimes(2) // metadata only (structure + database names), no session for EXPLAIN
  })

  it('sees the whole connection when no database is selected', async () => {
    const h = harness()
    const preview = await h.service.buildContext({ connectionId: 'c1', schema: null })
    expect(preview.context).toContain(
      'Conexión completa (MySQL 8.4.3): 2 bases de datos (app, crm).'
    )
    expect(preview.context).toContain('app.orders')
    expect(preview.context).toContain('crm.orders')
    expect(preview.tableCount).toBe(2)
    expect(preview.chars).toBe(preview.instructions.length + preview.context.length)
    expect(h.sessionSql.every(isMetadataSql)).toBe(true)
  })

  it('names the other databases when only one is in scope', async () => {
    const h = harness()
    const preview = await h.service.buildContext({ connectionId: 'c1', schema: 'app' })
    expect(preview.context).toContain('Base de datos: app')
    expect(preview.context).toContain('Otras bases de datos de esta conexión')
    expect(preview.context).toContain(': crm.')
    expect(preview.context).not.toContain('crm.orders')
  })

  it('includes every database with scope «connection», keeping the notes of each', async () => {
    const h = harness()
    h.service.memory.set('c1', 'crm', 'clientes del CRM')
    const preview = await h.service.buildContext({
      connectionId: 'c1',
      schema: 'app',
      scope: 'connection'
    })
    expect(preview.context).toContain('Base de datos seleccionada: app.')
    expect(preview.context).toContain('crm.orders')
    expect(preview.context).toContain(
      'Notas del usuario sobre la base de datos crm:\nclientes del CRM'
    )
  })

  it('a chat request with scope «connection» sends every database', async () => {
    const h = harness()
    h.service.saveProvider({
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5'
    })
    h.service.startChat({
      providerId: null,
      connectionId: 'c1',
      schema: 'app',
      scope: 'connection',
      mode: 'chat',
      history: [],
      input: '¿cómo se relacionan?'
    })
    await h.done()
    expect(h.requests[0].context).toContain('crm.orders')
    expect(h.requests[0].context).toContain('Base de datos seleccionada: app.')
  })

  it('leaves system databases out and caps the databases with structure', async () => {
    const h = harness()
    const names = ['mysql', 'sys', 'information_schema', 'performance_schema']
    for (let i = 0; i < 45; i++) names.push(`db${String(i).padStart(2, '0')}`)
    h.acquire.mockImplementation(async () => ({
      async query<T>(sql: string): Promise<T[]> {
        h.sessionSql.push(sql)
        if (/SCHEMATA/.test(sql)) return names.map((name) => ({ name })) as T[]
        if (/VERSION/.test(sql)) return [{ version: '11.8.9-MariaDB' }] as T[]
        return []
      },
      release: async () => undefined
    }))
    const preview = await h.service.buildContext({
      connectionId: 'c1',
      schema: 'db44',
      scope: 'connection'
    })
    expect(preview.context).toContain('(MariaDB 11.8.9): 40 bases de datos (')
    expect(preview.context).toContain('db44')
    expect(preview.context).not.toMatch(/\b(sys|performance_schema|information_schema)\b/)
    expect(preview.context).toContain(
      'Otras bases de datos (solo el nombre; pide su estructura con get_table_structure): db39, db40, db41, db42, db43'
    )
    expect(preview.truncated).toBe(true)
  })

  it('adds the MariaDB note on MariaDB connections', async () => {
    const h = harness({ deps: { engineOf: () => 'mariadb' } })
    const preview = await h.service.buildContext({ connectionId: 'c1', schema: 'app' })
    expect(preview.context).toContain('Motor: MariaDB.')
  })

  it('cancels a running request', async () => {
    const h = harness()
    h.service.saveProvider({
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5'
    })
    const { requestId } = h.service.startChat({
      providerId: null,
      connectionId: 'c1',
      schema: 'app',
      mode: 'chat',
      history: [],
      input: 'x'
    })
    h.service.cancel(requestId)
    const done = await h.done()
    expect(done.stopReason).toBe('cancelled')
  })

  it('validates requests', () => {
    const h = harness()
    h.service.saveProvider({
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5'
    })
    const base = { providerId: null, connectionId: 'c1', schema: null, history: [] }
    expect(() => h.service.startChat({ ...base, mode: 'chat', input: '  ' })).toThrow(
      /Escribe una pregunta/
    )
    expect(() => h.service.startChat({ ...base, mode: 'explainError', input: '' })).toThrow(
      /No hay SQL/
    )
    expect(() => h.service.startChat({ ...base, mode: 'nope' as never, input: 'x' })).toThrow(
      /Modo/
    )
  })
})
