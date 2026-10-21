<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import TemporalPicker from './TemporalPicker.vue'
import { normalizeTemporal, type TemporalSpec } from './temporal'

/**
 * Text editor for a temporal value with a calendar popover (button or
 * Alt+ArrowDown). The text stays editable (type or paste a literal); Enter
 * validates and commits the exact MySQL literal, Esc cancels. Invalid text
 * shows an inline error and is not committed.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    spec: TemporalSpec
    nullable?: boolean
    label: string
    placeholder?: string
    autofocus?: boolean
    /** Opened by typing a character: the caret goes after it instead of selecting the text. */
    fromTyping?: boolean
  }>(),
  { nullable: false, placeholder: undefined, autofocus: false, fromTyping: false }
)

const emit = defineEmits<{
  'update:modelValue': [text: string]
  /** Validated literal (or null from the NULL action). */
  commit: [value: string | null]
  cancel: []
  /** Focus left the editor (and its popover) with this text still uncommitted. */
  leave: []
  /** Any other key, for the host (Tab, Cmd+S...). */
  keydown: [event: KeyboardEvent]
}>()

const input = ref<HTMLInputElement | null>(null)
const open = ref(false)
const error = ref<string | null>(null)

const hint = computed(
  () =>
    ({
      date: 'AAAA-MM-DD',
      datetime: `AAAA-MM-DD hh:mm:ss${props.spec.fsp ? '.' + 'f'.repeat(props.spec.fsp) : ''}`,
      time: 'hh:mm:ss',
      year: 'AAAA'
    })[props.spec.kind]
)

function focus(select = false): void {
  input.value?.focus()
  if (select) input.value?.select()
}

onMounted(async () => {
  if (!props.autofocus) return
  await nextTick()
  focus(!props.fromTyping)
  if (props.fromTyping)
    input.value?.setSelectionRange(props.modelValue.length, props.modelValue.length)
})

/** Validates the current text; emits commit with the normalised literal when valid. */
function tryCommit(): boolean {
  const result = normalizeTemporal(props.modelValue, props.spec)
  if (!result.ok) {
    error.value = result.error
    focus()
    return false
  }
  error.value = null
  open.value = false
  emit('commit', result.text)
  return true
}

function onInput(event: Event): void {
  error.value = null
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault()
    event.stopPropagation()
    open.value = true
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    tryCommit()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (open.value) open.value = false
    else emit('cancel')
    return
  }
  emit('keydown', event)
}

function onBlur(event: FocusEvent): void {
  // Moving into the popover is not leaving the editor.
  const next = event.relatedTarget as HTMLElement | null
  if (open.value || next?.closest('[data-test="temporal-picker"]')) return
  emit('leave')
}

function onMenu(value: boolean): void {
  open.value = value
  if (!value) void nextTick(() => focus())
}

function onPicked(text: string): void {
  error.value = null
  emit('update:modelValue', text)
}

function onNull(): void {
  open.value = false
  emit('commit', null)
}

defineExpose({ tryCommit, focus, error })
</script>

<template>
  <span class="tinput" :class="{ 'has-error': !!error }" data-test="temporal-input">
    <input
      ref="input"
      class="tinput__field"
      :value="modelValue"
      :placeholder="placeholder ?? hint"
      :aria-label="label"
      :aria-invalid="!!error"
      :title="error ?? `${label} (${hint}). Alt+↓ abre el calendario`"
      data-test="cell-input"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
      @click.stop
      @dblclick.stop
    />
    <v-menu
      :model-value="open"
      location="bottom end"
      :close-on-content-click="false"
      @update:model-value="onMenu"
    >
      <template #activator="{ props: menuProps }">
        <button
          type="button"
          class="tinput__btn"
          v-bind="menuProps"
          tabindex="-1"
          :aria-label="spec.kind === 'time' ? 'Elegir hora' : 'Abrir calendario'"
          data-test="temporal-open"
          @mousedown.prevent
          @click.stop
        >
          <v-icon
            :icon="spec.kind === 'time' ? 'mdi-clock-outline' : 'mdi-calendar-month-outline'"
            size="15"
          />
        </button>
      </template>
      <TemporalPicker
        :model-value="modelValue"
        :spec="spec"
        :nullable="nullable"
        @update:model-value="onPicked"
        @accept="tryCommit"
        @null="onNull"
      />
    </v-menu>
    <span v-if="error" class="tinput__error" role="alert" data-test="temporal-error">{{
      error
    }}</span>
  </span>
</template>

<style scoped>
.tinput {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
}
.tinput__field {
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
.tinput__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--nd-text-2);
  cursor: pointer;
}
.tinput__btn:hover,
.tinput__btn[aria-expanded='true'] {
  color: var(--nd-accent);
}
.tinput.has-error .tinput__field {
  color: var(--nd-error);
}
.tinput__error {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 5;
  margin-top: 2px;
  padding: 2px 8px;
  border-radius: var(--nd-radius-sm);
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-xs);
  white-space: nowrap;
  color: var(--nd-error);
  background: var(--nd-bg-raised);
  border: 1px solid color-mix(in srgb, var(--nd-error) 50%, transparent);
}
</style>
