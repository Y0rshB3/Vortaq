/** Connection form webview: the desktop connection dialog inside an editor tab. */
import type { ConnectionFormState } from '../../webviewState'
import { bootWebview } from '../boot'
import ConnectionApp from './ConnectionApp.vue'

void bootWebview<ConnectionFormState>(ConnectionApp, (state) => state.editing)
