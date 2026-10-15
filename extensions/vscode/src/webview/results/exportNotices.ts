/**
 * «Exportar» in the results webview: the desktop ExportDialog announces a
 * finished export with a «Mostrar en la carpeta» button whose handler lives in
 * this page and cannot run in a VS Code notification. The host shows that
 * notification itself, with «Abrir» and «Mostrar en carpeta»
 * (host/panels/exports.ts), so the dialog's own one is not forwarded. Its
 * other notices (cells cut to Excel's limit, errors) are.
 */
import type { Notification } from '@renderer/composables/useNotify'

/** Label of ExportDialog's button (src/renderer/src/components/data/ExportDialog.vue). */
export const EXPORT_DONE_ACTION = 'Mostrar en la carpeta'

export function isExportDoneNotice(n: Pick<Notification, 'level' | 'action'>): boolean {
  return n.level === 'success' && n.action?.label === EXPORT_DONE_ACTION
}
