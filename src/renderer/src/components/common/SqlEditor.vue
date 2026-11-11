<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { sql, StandardSQL, type SQLDialect } from '@codemirror/lang-sql'
import { javascript } from '@codemirror/lang-javascript'
import type { CompletionSource } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { tabKeymap } from './editor/tabKeymap'
import type { EngineId } from '@shared/types'
import { engineUi } from '@renderer/engines'
import { schemaCompletionSource, type SchemaProvider } from './editor/sqlCompletion'
import { vortaqSQLite } from './editor/sqliteCompletion'

const props = defineProps<{
  /** Table names (optionally with column names) used for autocompletion. */
  schema?: Record<string, string[]>
  /** Lazy completion of databases, tables and columns. */
  provider?: SchemaProvider
  readonly?: boolean
  minHeight?: string
  /** Engine whose SQL dialect the editor uses; absent means MySQL. */
  engine?: EngineId
  /**
   * Completion source of engines with their own provider (PostgreSQL); it
   * replaces the MySQL `provider` completion when given.
   */
  completionSource?: CompletionSource
}>()

const emit = defineEmits<{
  run: []
  runSelection: [sql: string]
  save: []
  beautify: []
}>()

const model = defineModel<string>({ default: '' })

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null
const langCompartment = new Compartment()
const readonlyCompartment = new Compartment()

/** The engine's CodeMirror dialect (MySQL: vortaqMySQL, SQLite: vortaqSQLite); plain SQL for an engine without a UI. */
function editorDialect(): SQLDialect {
  // SQLite: `"x"`, `[x]` and backticks are identifiers (same module as its completion source).
  if (props.engine === 'sqlite') return vortaqSQLite
  try {
    return engineUi(props.engine).editorLanguage
  } catch {
    return StandardSQL
  }
}

function languageExt() {
  // MongoDB: shell syntax (JavaScript highlighting) with its own completion source.
  if (props.engine === 'mongodb') {
    const js = javascript()
    return props.completionSource
      ? [js, js.language.data.of({ autocomplete: props.completionSource })]
      : js
  }
  const lang = sql({
    dialect: editorDialect(),
    schema: props.schema ?? {},
    upperCaseKeywords: true
  })
  if (props.completionSource)
    return [lang, lang.language.data.of({ autocomplete: props.completionSource })]
  if (!props.provider) return lang
  return [lang, lang.language.data.of({ autocomplete: schemaCompletionSource(props.provider) })]
}

/*
 * Nebula theme: every colour is a --nd-* token, so the same extension follows
 * the dark and light Vuetify themes without reconfiguring the editor.
 */
const nebulaTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    color: 'var(--nd-text)',
    backgroundColor: 'var(--nd-bg-sunken)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--nd-font-mono)',
    lineHeight: '1.6',
    fontVariantLigatures: 'none'
  },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--nd-cyan)' },
  '.cm-line': { padding: '0 12px 0 8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid transparent',
    borderImage: 'var(--nd-accent-gradient-v) 1',
    marginLeft: '-1px'
  },
  '.cm-selectionBackground': {
    background:
      'linear-gradient(90deg, rgba(var(--nd-accent-rgb), 0.18), rgba(var(--nd-violet-rgb), 0.18))'
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background:
      'linear-gradient(90deg, rgba(var(--nd-accent-rgb), 0.28), rgba(var(--nd-violet-rgb), 0.28))'
  },
  '.cm-content ::selection': { backgroundColor: 'transparent' },
  '.cm-activeLine': { backgroundColor: 'var(--nd-hover)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(var(--nd-violet-rgb), 0.16)' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--nd-warning-soft)',
    outline: '1px solid color-mix(in srgb, var(--nd-warning) 45%, transparent)'
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--nd-selection)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(var(--nd-accent-rgb), 0.16)',
    outline: '1px solid rgba(var(--nd-accent-rgb), 0.45)'
  },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--nd-error-soft)' },
  '.cm-gutters': {
    backgroundColor: 'var(--nd-bg-sunken)',
    color: 'var(--nd-text-muted)',
    border: 'none',
    borderRight: '1px solid var(--nd-hairline)',
    fontSize: '11.5px'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '36px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--nd-cyan)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--nd-text-muted)', padding: '0 4px' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--nd-hover)',
    border: '1px solid var(--nd-border)',
    color: 'var(--nd-text-2)',
    borderRadius: '4px',
    padding: '0 4px'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--nd-glass-strong)',
    backdropFilter: 'var(--nd-glass-blur)',
    border: '1px solid var(--nd-border-strong)',
    borderRadius: 'var(--nd-radius-control)',
    boxShadow: 'var(--nd-shadow-2)',
    color: 'var(--nd-text)',
    overflow: 'hidden'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--nd-font-mono)',
    fontSize: '12px',
    padding: '4px'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '3px 8px',
    borderRadius: 'var(--nd-radius-sm)'
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--nd-accent-gradient-soft)',
    color: 'var(--nd-text)',
    boxShadow: 'inset 2px 0 0 var(--nd-cyan)'
  },
  '.cm-completionIcon': { color: 'var(--nd-violet)', opacity: '0.9' },
  '.cm-completionDetail': { color: 'var(--nd-text-muted)', fontStyle: 'normal' },
  '.cm-completionMatchedText': { color: 'var(--nd-cyan)', textDecoration: 'none' },
  '.cm-panels': {
    backgroundColor: 'var(--nd-bg-panel)',
    color: 'var(--nd-text)',
    borderColor: 'var(--nd-border)'
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--nd-border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--nd-border)' },
  '.cm-panel input, .cm-panel button': {
    fontFamily: 'var(--nd-font-ui)',
    fontSize: '12px',
    color: 'var(--nd-text)',
    backgroundColor: 'var(--nd-bg-input)',
    border: '1px solid var(--nd-border-strong)',
    borderRadius: 'var(--nd-radius-sm)',
    backgroundImage: 'none'
  }
})

const nebulaHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--nd-cyan)', fontWeight: '500' },
  { tag: [t.function(t.variableName), t.standard(t.name), t.macroName], color: 'var(--nd-violet)' },
  { tag: [t.typeName, t.className], color: 'var(--nd-violet)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--nd-success)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--nd-warning)' },
  {
    tag: [t.lineComment, t.blockComment, t.comment],
    color: 'var(--nd-text-muted)',
    fontStyle: 'italic'
  },
  { tag: [t.special(t.name), t.labelName], color: 'var(--nd-info)' },
  { tag: [t.propertyName], color: 'var(--nd-text)' },
  { tag: [t.variableName, t.name], color: 'var(--nd-text)' },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator], color: 'var(--nd-text-2)' },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren], color: 'var(--nd-text-2)' },
  { tag: t.invalid, color: 'var(--nd-error)' }
])

function runHandler(): boolean {
  emit('run')
  return true
}

onMounted(() => {
  if (!host.value) return
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        keymap.of([
          { key: 'Mod-Enter', run: runHandler },
          { key: 'Mod-r', run: runHandler, preventDefault: true },
          {
            key: 'Mod-b',
            run: () => {
              emit('beautify')
              return true
            },
            preventDefault: true
          },
          {
            key: 'Mod-s',
            run: () => {
              emit('save')
              return true
            },
            preventDefault: true
          }
        ]),
        tabKeymap(),
        basicSetup,
        nebulaTheme,
        syntaxHighlighting(nebulaHighlight),
        langCompartment.of(languageExt()),
        readonlyCompartment.of(EditorState.readOnly.of(!!props.readonly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) model.value = update.state.doc.toString()
        })
      ]
    })
  })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

watch(model, (value) => {
  if (!view || view.state.doc.toString() === value) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
})

watch(
  () => [props.schema, props.provider, props.engine, props.completionSource],
  () => view?.dispatch({ effects: langCompartment.reconfigure(languageExt()) }),
  { deep: true }
)

watch(
  () => props.readonly,
  (ro) =>
    view?.dispatch({ effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(!!ro)) })
)

/** Selected text, or empty string when there is no selection. */
function getSelection(): string {
  if (!view) return ''
  const { from, to } = view.state.selection.main
  return from === to ? '' : view.state.sliceDoc(from, to)
}

/** Offset of the cursor in the document (0 before the editor exists). */
function getCursorOffset(): number {
  return view ? view.state.selection.main.head : 0
}

/** Replaces the current selection (or the whole document when nothing is selected). */
function replaceSelection(text: string): void {
  if (!view) return
  const { from, to } = view.state.selection.main
  const range = from === to ? { from: 0, to: view.state.doc.length } : { from, to }
  view.dispatch({
    changes: { ...range, insert: text },
    selection: { anchor: range.from, head: range.from + text.length },
    scrollIntoView: true
  })
  view.focus()
}

/**
 * Inserts text at the cursor (replacing the selection, if any) on its own
 * lines, selects it and focuses the editor. Used for AI-generated SQL: it is
 * only inserted, never run.
 */
function insertAtCursor(text: string): void {
  if (!view) return
  const { from, to } = view.state.selection.main
  const doc = view.state.doc
  const before = from > 0 && doc.sliceString(from - 1, from) !== '\n' ? '\n' : ''
  const after = to < doc.length && doc.sliceString(to, to + 1) !== '\n' ? '\n' : ''
  const insert = before + text + after
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + before.length, head: from + before.length + text.length },
    scrollIntoView: true
  })
  view.focus()
}

function focus(): void {
  view?.focus()
}

/** Puts the cursor at `pos` (an offset into the document, clamped) and scrolls to it. */
function moveCursor(pos: number): void {
  if (!view) return
  const at = Math.max(0, Math.min(pos, view.state.doc.length))
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
  view.focus()
}

defineExpose({
  getSelection,
  getCursorOffset,
  replaceSelection,
  insertAtCursor,
  focus,
  moveCursor
})
</script>

<template>
  <div ref="host" class="sql-editor" :style="{ minHeight: minHeight ?? '120px' }" />
</template>

<style scoped>
.sql-editor {
  height: 100%;
  overflow: hidden;
  background: var(--nd-bg-sunken);
}
.sql-editor :deep(.cm-editor) {
  height: 100%;
}
</style>
