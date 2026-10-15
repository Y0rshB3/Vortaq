import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  DEFAULT_TYPED_CONFIRM_ENVIRONMENTS,
  normalizeTypedConfirmEnvironments,
  requiresTypedConfirm
} from '@shared/typedConfirm'
import type { AppSettings, Environment } from '@shared/types'
import { api } from '@renderer/api'

const DEFAULTS: AppSettings = {
  navicatRootPath: '',
  backupsRootDir: '',
  defaultRowLimit: 1000,
  theme: 'dark',
  typedConfirmEnvironments: [...DEFAULT_TYPED_CONFIRM_ENVIRONMENTS],
  confirmDestructiveEverywhere: true,
  checkUpdatesOnStartup: true,
  autoDownloadUpdates: false,
  aiEnabled: false,
  aiDefaultProviderId: null,
  aiEffort: 'low',
  aiMaxTokens: 16000,
  defaultBackupFormat: 'vqb',
  mcpEnabled: false
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...DEFAULTS })
  const loaded = ref(false)

  async function load(): Promise<void> {
    settings.value = { ...DEFAULTS, ...(await api.settings.get()) }
    loaded.value = true
  }

  async function update(patch: Partial<AppSettings>): Promise<void> {
    settings.value = { ...DEFAULTS, ...(await api.settings.update(patch)) }
  }

  const rowLimit = computed(() =>
    Math.max(1, settings.value.defaultRowLimit || DEFAULTS.defaultRowLimit)
  )
  /** Environments that need the typed name before writes (always with production). */
  const typedEnvironments = computed(() =>
    normalizeTypedConfirmEnvironments(settings.value.typedConfirmEnvironments)
  )
  function needsTypedConfirm(environment: Environment | null | undefined): boolean {
    return requiresTypedConfirm(environment, typedEnvironments.value)
  }
  const themeName = computed(() =>
    settings.value.theme === 'light' ? 'vortaqLight' : 'vortaqDark'
  )

  return {
    settings,
    loaded,
    rowLimit,
    themeName,
    typedEnvironments,
    needsTypedConfirm,
    load,
    update
  }
})
