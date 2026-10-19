import { onBeforeUnmount, onMounted } from 'vue'
import { useWorkspace } from './useWorkspace'
import { useTabActions } from './useTabActions'

/**
 * Global keyboard shortcuts of the shell. Cmd+R / Cmd+Enter belong to QueryView.
 * Note: Cmd+W only reaches the renderer when the main-process app menu does not
 * bind it to "Close Window".
 * Cmd/Ctrl+D opens the structure of the table in context (the open data tab, or
 * the tree's selection while the tree has focus); inside a text field or the
 * SQL editor the key keeps its own meaning there.
 */
/** Inputs, text areas and editable content (the SQL editor) keep their own Cmd/Ctrl+D. */
function isTextTarget(target: HTMLElement | null): boolean {
  if (!target) return false
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true
  return target.isContentEditable || !!target.closest('[contenteditable="true"], .cm-editor')
}

export function useShortcuts() {
  const ws = useWorkspace()
  const { requestCloseActive } = useTabActions()

  function onKeydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey
    if (!mod || event.altKey || event.shiftKey) return
    const key = event.key.toLowerCase()
    if (key === 'n') {
      event.preventDefault()
      ws.openQuery()
    } else if (key === 'w') {
      event.preventDefault()
      void requestCloseActive()
    } else if (key === 'd') {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (isTextTarget(target)) return
      if (ws.designCurrent(!!target?.closest('[role="tree"]'))) event.preventDefault()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

  return { onKeydown }
}
