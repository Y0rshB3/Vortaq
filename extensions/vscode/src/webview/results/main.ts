/** Results webview: query results, «Ver datos» and «Ver documentos». */
import type { ResultsState } from '../../webviewState'
import { bootWebview } from '../boot'
import { isExportDoneNotice } from './exportNotices'
import ResultsApp from './ResultsApp.vue'

void bootWebview<ResultsState>(ResultsApp, (state) => state.connection, {
  // The host announces finished exports itself, with «Abrir» and «Mostrar en carpeta».
  skipNotification: isExportDoneNotice
})
