import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { useUiStore } from '@renderer/stores/ui'
import ConnectionDialog from './ConnectionDialog.vue'
import { connectionUri, emptyConnectionInput, withSslMode } from './connectionForm'
import { freshPinia, makeConnection, mockVortaq, mountWith, settle } from './testing'

describe('ConnectionDialog · PostgreSQL', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  /** The «Motor» select (a dropdown since 2.6.1: six buttons wrapped and squeezed the tabs). */
  function enginePicker(w: NonNullable<typeof wrapper>) {
    const select = w
      .findAllComponents({ name: 'VSelect' })
      .find((c) => c.attributes('data-test') === 'conn-engine-picker')
    if (!select) throw new Error('engine picker not found')
    return select
  }
  const offered = (w: NonNullable<typeof wrapper>): string[] =>
    (enginePicker(w).props('items') as { id: string }[]).map((i) => i.id)
  async function pickEngine(w: NonNullable<typeof wrapper>, id: string): Promise<void> {
    enginePicker(w).vm.$emit('update:modelValue', id)
    await settle()
  }

  beforeEach(() => {
    invoke = mockVortaq({
      'connections:save': (input) => makeConnection({ ...(input as ConnectionInput), id: 'pg-1' }),
      'connections:setPassword': () => undefined,
      'connections:setSslKeyPassword': () => undefined,
      'connections:hasPassword': () => false,
      'connections:hasSshPassword': () => false,
      'connections:hasSslKeyPassword': () => false
    })
  })
  afterEach(() => wrapper?.unmount())

  it('offers every engine, without any «vista previa» label', async () => {
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    expect(offered(wrapper)).toEqual([
      'mysql',
      'mariadb',
      'postgresql',
      'sqlite',
      'mongodb',
      'sqlserver'
    ])
    expect(enginePicker(wrapper).props('modelValue')).toBe('mysql')
    expect(wrapper.text()).not.toContain('vista previa')
    // MySQL is still the default engine of a new connection.
    expect(wrapper.find('[data-test="conn-pg-database"]').exists()).toBe(false)
  })

  it('leaves out the engines the host cannot run (hiddenEngines, editor extension)', async () => {
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia, { props: { hiddenEngines: ['sqlite'] } })
    await settle()
    expect(offered(wrapper)).toEqual(['mysql', 'mariadb', 'postgresql', 'mongodb', 'sqlserver'])
  })

  it('picking SQLite on the SSH tab goes back to General (SQLite has no SSH/SSL tabs)', async () => {
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    const tabs = () => wrapper!.findComponent({ name: 'VTabs' })
    tabs().vm.$emit('update:modelValue', 'ssh')
    await settle()
    expect(tabs().props('modelValue')).toBe('ssh')
    await pickEngine(wrapper, 'postgresql')
    expect(tabs().props('modelValue')).toBe('ssh')
    await pickEngine(wrapper, 'sqlite')
    expect(tabs().props('modelValue')).toBe('general')
    expect(wrapper.find('[data-test="sqlite-path"]').exists()).toBe(true)
  })

  it('creates a MariaDB connection from the picker (engine mariadb, MySQL defaults)', async () => {
    expect(emptyConnectionInput('mariadb')).toMatchObject({
      engine: 'mariadb',
      port: 3306,
      username: 'root'
    })
    const pinia = freshPinia()
    const ui = useUiStore()
    ui.connectionDialog = { open: true, editing: null, engine: 'mariadb' }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    expect(enginePicker(wrapper).props('modelValue')).toBe('mariadb')
    await pickEngine(wrapper, 'mysql')
    await pickEngine(wrapper, 'mariadb')
    expect(wrapper.text()).toContain('ed25519 y parsec')
    await wrapper.get('[data-test="conn-name"] input').setValue('Maria local')
    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()
    const call = invoke.mock.calls.find((c) => c[0] === 'connections:save')!
    expect(call[1]).toMatchObject({ engine: 'mariadb', name: 'Maria local', port: 3306 })
  })

  it('offers PostgreSQL and saves the postgres block', async () => {
    const pinia = freshPinia()
    const ui = useUiStore()
    ui.connectionDialog = { open: true, editing: null }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    await pickEngine(wrapper, 'postgresql')
    expect((wrapper.get('[data-test="conn-port"] input').element as HTMLInputElement).value).toBe(
      '5432'
    )
    expect((wrapper.get('[data-test="conn-user"] input').element as HTMLInputElement).value).toBe(
      'postgres'
    )
    await wrapper.get('[data-test="conn-name"] input').setValue('PG local')
    await wrapper.get('[data-test="conn-pg-database"] input').setValue('shop')
    await wrapper.get('[data-test="conn-pg-search-path"] input').setValue(' app, public ')
    await wrapper.get('[data-test="conn-password"] input').setValue('s3cret')
    await wrapper.get('[data-test="conn-save"]').trigger('click')
    await settle()
    const call = invoke.mock.calls.find((c) => c[0] === 'connections:save')!
    const saved = call[1] as ConnectionInput
    expect(saved).toMatchObject({
      engine: 'postgresql',
      port: 5432,
      username: 'postgres',
      postgres: { initialDatabase: 'shop', searchPath: 'app, public', showSystemSchemas: false },
      ssl: { mode: 'disable', enabled: false }
    })
    expect(JSON.stringify(saved)).not.toContain('s3cret')
    expect(ui.connectionDialog.open).toBe(false)
  })

  it('opens directly on the engine chosen from the toolbar and shows the chip when editing', async () => {
    const pinia = freshPinia()
    useUiStore().connectionDialog = { open: true, editing: null, engine: 'postgresql' }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    expect(wrapper.find('[data-test="conn-pg-database"]').exists()).toBe(true)
    wrapper.unmount()
    const editing = makeConnection({
      id: 'pg-2',
      name: 'PG edit',
      engine: 'postgresql',
      port: 5432,
      postgres: { initialDatabase: 'db', showSystemSchemas: false, timeZone: '', searchPath: '' }
    })
    useUiStore().connectionDialog = { open: true, editing }
    wrapper = mountWith(ConnectionDialog, pinia)
    await settle()
    expect(wrapper.find('[data-test="conn-engine-picker"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="conn-engine-chip"]').exists()).toBe(true)
  })
})

describe('connectionForm · PostgreSQL helpers', () => {
  it('keeps enabled/verifyServer consistent with the SSL mode', () => {
    const ssl = emptyConnectionInput('postgresql').ssl
    expect(withSslMode(ssl, 'verify-full')).toMatchObject({ enabled: true, verifyServer: true })
    expect(withSslMode(ssl, 'require')).toMatchObject({ enabled: true, verifyServer: false })
    expect(withSslMode(ssl, 'disable')).toMatchObject({ enabled: false, verifyServer: false })
  })

  it('builds «Copiar URI» without the password', () => {
    const input: ConnectionInput = {
      ...emptyConnectionInput('postgresql'),
      host: 'db.example.test',
      username: 'app user',
      ssl: withSslMode(emptyConnectionInput('postgresql').ssl, 'verify-full'),
      postgres: {
        initialDatabase: 'shop/eu',
        showSystemSchemas: false,
        timeZone: '',
        searchPath: ''
      }
    }
    const uri = connectionUri(input)
    expect(uri).toBe('postgresql://app%20user@db.example.test:5432/shop%2Feu?sslmode=verify-full')
    expect(connectionUri(emptyConnectionInput('mysql'))).toBeNull()
  })

  it('keeps the MySQL defaults unchanged', () => {
    const mysql = emptyConnectionInput()
    expect(mysql).toMatchObject({ engine: 'mysql', port: 3306, username: 'root' })
    expect(mysql.postgres).toBeUndefined()
    expect(mysql.network).toBeUndefined()
  })
})
