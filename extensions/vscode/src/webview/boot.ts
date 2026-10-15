/**
 * Shared start-up of Vortaq's webviews: the bridge as `window.vortaq`, Pinia,
 * Vuetify with the desktop app's options (its theme stylesheet carrying the
 * page's CSP nonce), the editor theme, and two adapters so reused desktop
 * components behave as in VS Code:
 * - notifications (useNotify) become VS Code notifications (a view may keep
 *   some for the host to show itself, see BootOptions.skipNotification);
 * - confirmations (useConfirm → ui.ask) become VS Code modal dialogs. A
 *   typed-name confirmation is answered here with «yes» because the host asks
 *   for the connection name itself, natively, when the write reaches it
 *   (host/guard.ts); the webview cannot confirm a write on its own.
 */
import { createApp, watch, type Component } from 'vue'
import { createPinia, type Pinia } from 'pinia'
import { createVuetify } from 'vuetify'
import { vuetifyOptions } from '@renderer/plugins/vuetify'
import type { Notification } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import type { ConnectionConfig } from '@shared/types'
import '@renderer/styles/tokens.css'
import '@renderer/styles/global.css'
import '@renderer/styles/vuetify-overrides.css'
import './webview.css'
import type { WebviewSettings } from '../webviewState'
import { connectHost, type WebviewHost } from './bridge'
import { forwardNotifications } from './notifications'
import { applyEditorTheme } from './theme'

/** Read while this bundle's <script> runs: the nonce of the page's CSP. */
const NONCE = (document.currentScript as HTMLScriptElement | null)?.nonce ?? ''

export interface BootState {
  platform: string
  settings: WebviewSettings
}

export interface BootOptions {
  /**
   * Notifications not forwarded to VS Code, because the host shows its own
   * (the export result, with «Abrir» and «Mostrar en carpeta»).
   */
  skipNotification?: (notification: Notification) => boolean
}

function forwardConfirmations(host: WebviewHost<unknown>, pinia: Pinia): void {
  const ui = useUiStore(pinia)
  watch(
    () => ui.confirm.open,
    (open) => {
      if (!open) return
      const request = ui.confirm
      if (request.production || request.requireTyped) {
        ui.answer(true)
        return
      }
      void host
        .confirm({
          title: request.title,
          message: request.message,
          ...(request.details ? { details: request.details } : {}),
          ...(request.items ? { items: request.items.map((i) => ({ ...i })) } : {}),
          ...(request.confirmText ? { confirmText: request.confirmText } : {}),
          ...(request.danger ? { danger: true } : {}),
          ...(request.notice ? { notice: true } : {})
        })
        .then((ok) => {
          if (ui.confirm.open) ui.answer(ok)
        })
    },
    { flush: 'sync' }
  )
}

/** Desktop stores the reused components read, filled from the host's state. */
export function applyState(
  pinia: Pinia,
  state: BootState,
  connection?: ConnectionConfig | null
): void {
  const settings = useSettingsStore(pinia)
  settings.settings = {
    ...settings.settings,
    typedConfirmEnvironments: [...state.settings.typedConfirmEnvironments],
    confirmDestructiveEverywhere: state.settings.confirmDestructiveEverywhere,
    defaultRowLimit: state.settings.defaultRowLimit
  }
  settings.loaded = true
  if (connection) {
    const connections = useConnectionsStore(pinia)
    connections.items = [connection]
    connections.loaded = true
  }
}

/**
 * Mounts `component` once the host sent the first state. The component gets
 * `host` and `initial` as props.
 */
export async function bootWebview<State extends BootState>(
  component: Component,
  connectionOf: (state: State) => ConnectionConfig | null = () => null,
  options: BootOptions = {}
): Promise<void> {
  const host = connectHost<State>()
  window.vortaq = host.api
  const vuetify = createVuetify({
    ...vuetifyOptions,
    theme: { ...vuetifyOptions.theme, cspNonce: NONCE }
  })
  applyEditorTheme(vuetify.theme, NONCE)
  const initial = await host.ready()
  const pinia = createPinia()
  const app = createApp(component, { host, initial })
  app.use(pinia).use(vuetify)
  applyState(pinia, initial, connectionOf(initial))
  host.onState((state) => applyState(pinia, state, connectionOf(state)))
  forwardNotifications(host as WebviewHost<unknown>, options.skipNotification)
  forwardConfirmations(host as WebviewHost<unknown>, pinia)
  app.config.errorHandler = (err) =>
    host.post({
      type: 'notify',
      level: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  app.mount('#app')
}
