<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { filterEnumOptions, matchEnumOption } from './enumValues'

/**
 * Cell editor of an ENUM column: a text field with the allowed values listed
 * under it. The list opens with the editor showing every value; typing narrows
 * it (values starting with the text first) and ↑/↓ move through it. Enter or a
 * click writes the highlighted value; text that is exactly one value (ignoring
 * case when only one fits) is accepted too. Anything else shows an error and is
 * never committed. Focus stays in the field: the list is not focusable.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    options: readonly string[]
    nullable?: boolean
    label: string
    placeholder?: string
    autofocus?: boolean
  }>(),
  { nullable: false, placeholder: undefined, autofocus: false }
)

const emit = defineEmits<{
  'update:modelValue': [text: string]
  /** One of the options, or null from the NULL entry. */
  commit: [value: string | null]
  cancel: []
  /** Focus left the field with its text still uncommitted. */
  leave: []
  /** Any other key, for the host (Tab, Cmd+S...). */
  keydown: [event: KeyboardEvent]
}>()

const NULL_ENTRY = Symbol('null')
type Entry = string | typeof NULL_ENTRY

const input = ref<HTMLInputElement | null>(null)
const open = ref(false)
/** False until the user types: the list then shows every value, not just the current one. */
const typed = ref(false)
/** The user moved through the list with ↑/↓: leaving writes the highlighted value. */
const moved = ref(false)
const highlight = ref(-1)
const error = ref<string | null>(null)
const listId = `enum-list-${useId()}`

const entries = computed<Entry[]>(() => {
  const text = typed.value ? props.modelValue : ''
  const list: Entry[] = filterEnumOptions(props.options, text)
  const q = text.trim().toLowerCase()
  if (props.nullable && (!q || 'null'.startsWith(q))) list.unshift(NULL_ENTRY)
  return list
})

const entryLabel = (e: Entry): string => (e === NULL_ENTRY ? 'NULL' : e === '' ? "''" : e)

/** Highlights the current value when the list opens, the first match while typing. */
function resetHighlight(): void {
  if (!typed.value) {
    const current = entries.value.findIndex((e) => e === props.modelValue)
    highlight.value = current >= 0 ? current : entries.value.length ? 0 : -1
  } else highlight.value = entries.value.length ? 0 : -1
}
watch(entries, resetHighlight)

/* ---------- position (fixed, under the field or above it when there is no room) ---------- */

const listStyle = ref<Record<string, string>>({})
const LIST_MAX_H = 240
function place(): void {
  const rect = input.value?.closest('.enum-input')?.getBoundingClientRect()
  if (!rect) return
  const below = window.innerHeight - rect.bottom
  const up = below < Math.min(LIST_MAX_H, entries.value.length * 28 + 8) && rect.top > below
  listStyle.value = {
    left: `${Math.round(rect.left)}px`,
    minWidth: `${Math.round(rect.width)}px`,
    maxHeight: `${Math.max(120, Math.min(LIST_MAX_H, (up ? rect.top : below) - 8))}px`,
    ...(up
      ? { bottom: `${Math.round(window.innerHeight - rect.top + 2)}px` }
      : { top: `${Math.round(rect.bottom + 2)}px` })
  }
}
function show(): void {
  open.value = true
  resetHighlight()
  place()
  void nextTick(scrollToHighlight)
}
window.addEventListener('scroll', onViewportChange, true)
window.addEventListener('resize', onViewportChange)
function onViewportChange(): void {
  if (open.value) place()
}
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})

onMounted(async () => {
  if (!props.autofocus) return
  await nextTick()
  input.value?.focus()
  input.value?.select()
  show()
})

function scrollToHighlight(): void {
  document.getElementById(`${listId}-${highlight.value}`)?.scrollIntoView?.({ block: 'nearest' })
}

/* ---------- committing ---------- */

function choose(entry: Entry): void {
  error.value = null
  open.value = false
  emit('commit', entry === NULL_ENTRY ? null : entry)
}

/**
 * Commits the highlighted value once the user typed or moved through the list,
 * else the value the text stands for; untouched, it just closes (a NULL cell
 * stays NULL). Invalid text shows an error and returns false.
 */
function tryCommit(): boolean {
  if (open.value && (typed.value || moved.value) && highlight.value >= 0) {
    choose(entries.value[highlight.value])
    return true
  }
  if (!typed.value) {
    open.value = false
    emit('cancel')
    return true
  }
  const match = matchEnumOption(props.options, props.modelValue)
  if (match !== null) {
    choose(match)
    return true
  }
  error.value = `«${props.modelValue}» no es uno de los valores permitidos`
  input.value?.focus()
  if (!open.value) show()
  return false
}

function onInput(event: Event): void {
  error.value = null
  typed.value = true
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  if (!open.value) show()
  else void nextTick(place)
}

function moveHighlight(step: number): void {
  if (!open.value) return show()
  const n = entries.value.length
  if (!n) return
  moved.value = true
  highlight.value = (highlight.value + step + n) % n
  void nextTick(scrollToHighlight)
}

function onKeydown(event: KeyboardEvent): void {
  const own = (): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    own()
    moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter') {
    own()
    if (open.value && highlight.value >= 0) choose(entries.value[highlight.value])
    else tryCommit()
    return
  }
  if (event.key === 'Escape') {
    own()
    if (open.value) open.value = false
    else emit('cancel')
    return
  }
  emit('keydown', event)
}

function onBlur(): void {
  open.value = false
  emit('leave')
}

defineExpose({ tryCommit, error, open })
</script>

<template>
  <span class="enum-input" :class="{ 'has-error': !!error }" data-test="enum-input">
    <input
      ref="input"
      class="enum-input__field"
      role="combobox"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="listId"
      aria-autocomplete="list"
      :aria-activedescendant="open && highlight >= 0 ? `${listId}-${highlight}` : undefined"
      :aria-invalid="!!error"
      :title="error ?? `${label}: escribe o elige un valor (↑/↓, Intro)`"
      autocomplete="off"
      spellcheck="false"
      data-test="cell-input"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
      @click.stop="open ? undefined : show()"
      @dblclick.stop
    />
    <button
      type="button"
      class="enum-input__btn"
      tabindex="-1"
      :aria-label="open ? 'Cerrar la lista' : 'Mostrar los valores'"
      data-test="enum-open"
      @mousedown.prevent
      @click.stop="open ? (open = false) : show()"
    >
      <v-icon :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="16" />
    </button>
    <span v-if="error" class="enum-input__error" role="alert" data-test="enum-error">{{
      error
    }}</span>
    <Teleport to="body">
      <div
        v-if="open"
        :id="listId"
        class="enum-list"
        role="listbox"
        :aria-label="label"
        :style="listStyle"
        data-test="enum-list"
        @mousedown.prevent
      >
        <div
          v-for="(entry, i) in entries"
          :id="`${listId}-${i}`"
          :key="entry === NULL_ENTRY ? '\u0000null' : entry"
          role="option"
          class="enum-list__item"
          :class="{
            'is-highlighted': i === highlight,
            'is-current': !typed && entry === modelValue,
            'is-null': entry === NULL_ENTRY
          }"
          :aria-selected="i === highlight"
          :data-test="entry === NULL_ENTRY ? 'enum-option-null' : `enum-option-${i}`"
          @mouseenter="highlight = i"
          @click="choose(entry)"
        >
          <span class="enum-list__label">{{ entryLabel(entry) }}</span>
          <v-icon
            v-if="!typed && entry === modelValue"
            icon="mdi-check"
            size="14"
            aria-hidden="true"
          />
        </div>
        <div v-if="!entries.length" class="enum-list__empty" data-test="enum-empty">
          Ningún valor coincide
        </div>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.enum-input {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
}
.enum-input__field {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0 4px 0 12px;
  background: transparent;
  color: var(--nd-text);
  font: inherit;
  border: none;
  outline: none;
}
.enum-input__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 100%;
  color: var(--nd-text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
}
.enum-input__btn:hover {
  color: var(--nd-accent);
}
.enum-input.has-error .enum-input__field {
  color: var(--nd-error);
}
.enum-input__error {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 3;
  margin-top: 2px;
  padding: 2px 8px;
  border-radius: var(--nd-radius-sm);
  font-size: var(--nd-fs-xs);
  white-space: nowrap;
  color: var(--nd-error);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-error);
}
.enum-list {
  position: fixed;
  z-index: 2400;
  overflow-y: auto;
  padding: 4px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border-strong);
  box-shadow: var(--nd-shadow-2);
  font-size: var(--nd-fs-dense);
}
.enum-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 26px;
  padding: 0 10px;
  border-radius: var(--nd-radius-sm);
  color: var(--nd-text);
  cursor: pointer;
  white-space: nowrap;
}
.enum-list__item.is-highlighted {
  background: rgba(var(--nd-accent-rgb), 0.14);
}
.enum-list__item.is-current {
  color: var(--nd-accent);
}
.enum-list__item.is-null .enum-list__label {
  font-style: italic;
  color: var(--nd-text-muted);
}
.enum-list__empty {
  padding: 4px 10px;
  color: var(--nd-text-muted);
}
</style>
