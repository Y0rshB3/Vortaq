/** «Diagrama de relaciones» and «Consulta gráfica» webview. */
import type { SchemaViewState } from '../../webviewState'
import { bootWebview } from '../boot'
import SchemaApp from './SchemaApp.vue'

void bootWebview<SchemaViewState>(SchemaApp, (state) => state.connection)
