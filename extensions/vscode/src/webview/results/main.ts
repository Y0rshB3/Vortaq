/** Results webview: query results, «Ver datos» and «Ver documentos». */
import type { ResultsState } from '../../webviewState'
import { bootWebview } from '../boot'
import ResultsApp from './ResultsApp.vue'

void bootWebview<ResultsState>(ResultsApp, (state) => state.connection)
