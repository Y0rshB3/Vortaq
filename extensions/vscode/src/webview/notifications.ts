/**
 * The reused desktop components notify through useNotify; in a webview each
 * notification becomes a `notify` message, which the host shows as a VS Code
 * notification. A view may drop some (`skip`) when the host shows its own.
 */
import { watch } from 'vue'
import { useNotify, type Notification } from '@renderer/composables/useNotify'
import type { WebviewHost } from './bridge'

export function forwardNotifications(
  host: Pick<WebviewHost<unknown>, 'post'>,
  skip: (notification: Notification) => boolean = () => false
): void {
  const notify = useNotify()
  watch(
    () => notify.queue.length,
    () => {
      for (const n of [...notify.queue]) {
        if (!skip(n)) host.post({ type: 'notify', level: n.level, message: n.message })
        notify.dismiss(n.id)
      }
    }
  )
}
