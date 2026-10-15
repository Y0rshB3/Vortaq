import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@core'
import { CONNECTION_FORM_CHANNELS, FormScope } from './connectionForm'
import { RESULTS_CHANNELS } from './results'

const editing = { id: 'c1', extraBackupDirs: ['/backups/navicat'] } as unknown as ConnectionConfig

describe('connection form scope', () => {
  it('an edit form only touches its own connection', () => {
    const scope = new FormScope(editing)
    expect(scope.check('connections:save', [{ id: 'c1', name: 'x' }])).toBeNull()
    expect(scope.check('connections:setPassword', ['c1', 'pw'])).toBeNull()
    expect(scope.check('connections:save', [{ id: 'c2', name: 'x' }])).toMatch(/su propia conexión/)
    expect(scope.check('connections:hasPassword', ['c2'])).toMatch(/su propia conexión/)
    // «Probar conexión» with another id would send that connection's stored password elsewhere.
    expect(scope.check('connections:test', [{ id: 'c2', host: 'otro' }, null, null])).toMatch(
      /su propia conexión/
    )
    expect(scope.check('connections:test', [{ id: 'c1', host: 'nuevo' }, null, null])).toBeNull()
  })

  it('a new form may work on the connection its first save created', () => {
    const scope = new FormScope(null)
    expect(scope.check('connections:save', [{ name: 'nueva' }])).toBeNull()
    expect(scope.check('connections:setPassword', ['c9', 'pw'])).toMatch(/su propia conexión/)
    scope.saved({ id: 'c9' })
    expect(scope.check('connections:setPassword', ['c9', 'pw'])).toBeNull()
    expect(scope.check('connections:save', [{ id: 'c9', name: 'nueva' }])).toBeNull()
  })

  it('creates only the SQLite file chosen in the save dialog', () => {
    const scope = new FormScope(null)
    expect(scope.check('sqlite:createFile', ['/tmp/x.db'])).toMatch(/Crear base de datos nueva/)
    scope.savePathChosen('/tmp/x.db')
    expect(scope.check('sqlite:createFile', ['/tmp/x.db'])).toBeNull()
    expect(scope.check('sqlite:createFile', ['/etc/other.db'])).toMatch(/Crear base de datos nueva/)
  })

  it('reveals only the extra backup folders of the edited connection', () => {
    const scope = new FormScope(editing)
    expect(scope.mayReveal('/backups/navicat')).toBe(true)
    expect(scope.mayReveal('/etc')).toBe(false)
    expect(new FormScope(null).mayReveal('/backups/navicat')).toBe(false)
  })

  it('the webviews never get settings, app, job or SQL-execution channels', () => {
    for (const channel of CONNECTION_FORM_CHANNELS)
      expect(channel).toMatch(/^(connections|db|sqlite):/)
    // Results: the grid's editability check and Aplicar, and «Exportar».
    expect([...RESULTS_CHANNELS].sort()).toEqual([
      'db:applyRowChanges',
      'db:tableStructure',
      'export:cancel',
      'export:query',
      'export:rows'
    ])
    for (const forbidden of [
      'db:execute',
      'connections:delete',
      'connections:list',
      'settings:update',
      'jobs:run'
    ])
      expect(CONNECTION_FORM_CHANNELS.has(forbidden) || RESULTS_CHANNELS.has(forbidden)).toBe(false)
  })
})
