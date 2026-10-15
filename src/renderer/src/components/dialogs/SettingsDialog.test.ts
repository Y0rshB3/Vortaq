import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import type { AppSettings } from '@shared/types'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTourStore } from '@renderer/stores/tour'
import { useUiStore } from '@renderer/stores/ui'
import SettingsDialog from './SettingsDialog.vue'
import { calls, freshPinia, mockVortaq, mountWith, settle } from './testing'

const base: AppSettings = {
  navicatRootPath: '',
  backupsRootDir: '/b',
  defaultRowLimit: 1000,
  theme: 'dark',
  typedConfirmEnvironments: ['production'],
  confirmDestructiveEverywhere: true,
  checkUpdatesOnStartup: true,
  autoDownloadUpdates: false,
  aiEnabled: false,
  aiDefaultProviderId: null,
  aiEffort: 'low',
  aiMaxTokens: 16000,
  mcpEnabled: false
}

describe('SettingsDialog › Seguridad typed-confirmation environments', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockVortaq({
      'app:info': () => ({ version: '0.1.5' }),
      // Echo the patch like main does (normalised by SettingsRepo there).
      'settings:update': (patch) => ({ ...base, ...(patch as Partial<AppSettings>) })
    })
  })
  afterEach(() => wrapper?.unmount())

  async function mountDialog(stored: Partial<AppSettings> = {}) {
    const pinia = freshPinia()
    useSettingsStore().settings = { ...base, ...stored }
    useUiStore().settingsDialog = true
    wrapper = mountWith(SettingsDialog, pinia)
    await settle()
    return wrapper
  }

  const chip = (env: string) => wrapper!.get(`[data-test="settings-typed-env-${env}"]`)
  const box = (env: string) => chip(env).get('input[type="checkbox"]').element as HTMLInputElement

  it('shows one chip per environment with its colour pill; Producción checked and locked', async () => {
    const w = await mountDialog()
    expect(w.get('[data-test="settings-typed-envs"]').text()).toContain(
      'Pedir confirmación escribiendo el nombre antes de escribir en:'
    )
    expect(chip('production').get('.nd-pill').classes()).toContain('nd-pill--production')
    expect(chip('staging').get('.nd-pill').classes()).toContain('nd-pill--staging')
    expect(chip('local').get('.nd-pill').classes()).toContain('nd-pill--local')
    expect(chip('other').get('.nd-pill').text()).toBe('Otro')
    expect(box('production').checked).toBe(true)
    expect(box('production').disabled).toBe(true)
    expect(chip('production').find('.mdi-lock').exists()).toBe(true)
    expect(box('production').getAttribute('aria-label')).toContain(
      'producción siempre pide escribir el nombre'
    )
    for (const env of ['staging', 'local', 'other']) {
      expect(box(env).checked).toBe(false)
      expect(box(env).disabled).toBe(false)
    }
    // The old "production off" warning no longer exists, and the second switch stays.
    expect(w.text()).not.toContain('ya no pedirán escribir el nombre')
    expect(w.find('[data-test="settings-confirm-destructive"]').exists()).toBe(true)
  })

  it('saves the checked environments (production always included)', async () => {
    const w = await mountDialog()
    await chip('staging').get('input').setValue(true)
    await chip('other').get('input').setValue(true)
    await chip('other').get('input').setValue(false)
    expect(box('staging').checked).toBe(true)
    await w.get('[data-test="settings-save"]').trigger('click')
    await settle()
    const [[patch]] = calls(invoke, 'settings:update') as [[Partial<AppSettings>]]
    expect(patch.typedConfirmEnvironments).toEqual(['production', 'staging'])
    expect('confirmProductionWrites' in patch).toBe(false)
    expect(useSettingsStore().typedEnvironments).toEqual(['production', 'staging'])
  })

  it('production cannot be unchecked from the UI, even if the stored list lacks it', async () => {
    const w = await mountDialog({ typedConfirmEnvironments: ['local'] })
    expect(box('production').checked).toBe(true)
    expect(box('local').checked).toBe(true)
    // A forced change event on the disabled box is ignored by the form.
    box('production').checked = false
    await chip('production').get('input').trigger('change')
    await w.get('[data-test="settings-save"]').trigger('click')
    await settle()
    const [[patch]] = calls(invoke, 'settings:update') as [[Partial<AppSettings>]]
    expect(patch.typedConfirmEnvironments).toEqual(['production', 'local'])
  })
})

describe('SettingsDialog › Ver tour de bienvenida', () => {
  it('closes Ajustes and starts the welcome tour', async () => {
    const invoke = mockVortaq({
      'app:info': () => ({ version: '0.1.7' }),
      'navicat:findCandidates': () => ({ supportedPlatform: true, candidates: [] })
    })
    const pinia = freshPinia()
    useSettingsStore().settings = { ...base }
    const ui = useUiStore()
    ui.settingsDialog = true
    const wrapper = mountWith(SettingsDialog, pinia)
    await settle()
    await wrapper.get('[data-test="settings-replay-tour"]').trigger('click')
    await settle()
    expect(ui.settingsDialog).toBe(false)
    expect(calls(invoke, 'navicat:findCandidates')).toHaveLength(1)
    expect(useTourStore().active).toBe(true)
    expect(useTourStore().kind).toBe('welcome')
    wrapper.unmount()
  })
})

const savedSettings: AppSettings = {
  navicatRootPath: '/nav',
  backupsRootDir: '/backups',
  defaultRowLimit: 1000,
  theme: 'dark',
  typedConfirmEnvironments: ['production'],
  confirmDestructiveEverywhere: true,
  checkUpdatesOnStartup: true,
  autoDownloadUpdates: false,
  aiEnabled: false,
  aiDefaultProviderId: null,
  aiEffort: 'low',
  aiMaxTokens: 16000,
  mcpEnabled: false
}

describe('SettingsDialog without «Motores en vista previa» (every engine is regular)', () => {
  let invoke: Mock
  let wrapper: ReturnType<typeof mountWith> | null = null

  beforeEach(() => {
    invoke = mockVortaq({
      'app:info': () => ({ version: '2.0.0' }),
      'settings:get': () => ({ ...savedSettings }),
      'settings:update': (patch) => ({ ...savedSettings, ...(patch as Partial<AppSettings>) })
    })
  })
  afterEach(() => wrapper?.unmount())

  it('has no preview switch and never sends one', async () => {
    const pinia = freshPinia()
    await useSettingsStore().load()
    useUiStore().settingsDialog = true
    wrapper = mountWith(SettingsDialog, pinia)
    await settle()
    expect(wrapper.find('[data-test="settings-preview-engines"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('vista previa')
    await wrapper.get('[data-test="settings-save"]').trigger('click')
    await settle()
    const [patch] = calls(invoke, 'settings:update')[0] as [AppSettings]
    expect(patch).toMatchObject(savedSettings)
    expect('previewEngines' in patch).toBe(false)
  })
})
