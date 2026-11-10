<script setup lang="ts">
import { ref } from 'vue'
import { emptyColumn, type ColumnDraft } from '@renderer/utils/tableDesigner'
import {
  COLUMN_TYPES,
  defaultToInput,
  inputToDefault,
  isNumericType,
  joinColumnType,
  lengthForBase,
  splitColumnType
} from './columnType'

const props = withDefaults(
  defineProps<{
    /** Type list of the engine (MariaDB adds uuid/inet types); MySQL's by default. */
    columnTypes?: string[]
    /** «Sin signo» column (MySQL family); SQL Server has no unsigned types. */
    unsigned?: boolean
  }>(),
  { columnTypes: () => COLUMN_TYPES, unsigned: true }
)
const model = defineModel<ColumnDraft[]>({ required: true })
const selected = ref<number | null>(null)

function patch(index: number, change: Partial<ColumnDraft>): void {
  model.value = model.value.map((c, i) => (i === index ? { ...c, ...change } : c))
}

function patchType(index: number, part: 'base' | 'length', value: string | null): void {
  const split = splitColumnType(model.value[index].columnType)
  split[part] = value ?? ''
  if (part === 'base') {
    // A length valid for the old type is often invalid for the new one (date(255), json(255)).
    split.length = lengthForBase(split.base, split.length)
    if (!isNumericType(split.base)) split.suffix = ''
  }
  const change: Partial<ColumnDraft> = { columnType: joinColumnType(split) }
  if (part === 'base' && !isNumericType(split.base)) {
    change.unsigned = false
    change.autoIncrement = false
  }
  patch(index, change)
}

function patchDefault(index: number, value: string | null): void {
  patch(index, { defaultValue: inputToDefault(value) })
}

function add(insertAt?: number): void {
  const col = emptyColumn()
  const next = [...model.value]
  const at = insertAt ?? next.length
  next.splice(at, 0, col)
  model.value = next
  selected.value = at
}

function remove(): void {
  if (selected.value === null) return
  model.value = model.value.filter((_, i) => i !== selected.value)
  selected.value = model.value.length ? Math.min(selected.value, model.value.length - 1) : null
}

function move(delta: number): void {
  if (selected.value === null) return
  const to = selected.value + delta
  if (to < 0 || to >= model.value.length) return
  const next = [...model.value]
  const [item] = next.splice(selected.value, 1)
  next.splice(to, 0, item)
  model.value = next
  selected.value = to
}
</script>

<template>
  <div class="columns-editor">
    <div class="designer-toolbar" role="toolbar" aria-label="Campos">
      <v-btn prepend-icon="mdi-plus" size="small" data-test="add-column" @click="add()"
        >Añadir campo</v-btn
      >
      <v-btn
        prepend-icon="mdi-table-row-plus-before"
        size="small"
        :disabled="selected === null"
        @click="add(selected ?? 0)"
      >
        Insertar
      </v-btn>
      <v-btn
        prepend-icon="mdi-delete-outline"
        size="small"
        :disabled="selected === null"
        data-test="remove-column"
        @click="remove"
      >
        Eliminar
      </v-btn>
      <span class="designer-toolbar__sep" aria-hidden="true" />
      <v-btn
        icon="mdi-arrow-up"
        size="small"
        aria-label="Subir campo"
        :disabled="selected === null || selected === 0"
        @click="move(-1)"
      />
      <v-btn
        icon="mdi-arrow-down"
        size="small"
        aria-label="Bajar campo"
        :disabled="selected === null || selected >= model.length - 1"
        @click="move(1)"
      />
      <span class="designer-toolbar__count">{{ model.length }} campo(s)</span>
    </div>
    <div class="columns-editor__scroll">
      <table class="designer-table">
        <thead>
          <tr>
            <th class="w-name">Nombre</th>
            <th class="w-type">Tipo</th>
            <th class="w-len">Longitud</th>
            <th class="w-check text-center" title="Admite NULL">Nulo</th>
            <th class="w-check text-center" title="Clave primaria">Clave</th>
            <th class="w-default">Predeterminado</th>
            <th class="w-check text-center" title="Auto incremento">A.I.</th>
            <th v-if="props.unsigned" class="w-check text-center">Sin signo</th>
            <th>Comentario</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(col, i) in model"
            :key="col.id"
            :class="{ 'is-selected': selected === i, 'is-new': !col.originalName }"
            :data-test="`column-row-${i}`"
            @click="selected = i"
          >
            <td>
              <input
                :value="col.name"
                class="designer-input"
                aria-label="Nombre del campo"
                :data-test="`column-name-${i}`"
                @input="patch(i, { name: ($event.target as HTMLInputElement).value })"
              />
            </td>
            <td>
              <v-combobox
                :model-value="splitColumnType(col.columnType).base"
                :items="props.columnTypes"
                density="compact"
                variant="plain"
                hide-details
                aria-label="Tipo"
                class="designer-combo"
                @update:model-value="patchType(i, 'base', $event)"
              />
            </td>
            <td>
              <input
                :value="splitColumnType(col.columnType).length"
                class="designer-input designer-input--short"
                aria-label="Longitud"
                @input="patchType(i, 'length', ($event.target as HTMLInputElement).value)"
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="col.nullable"
                aria-label="Admite NULL"
                @change="patch(i, { nullable: !col.nullable })"
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="col.primaryKey"
                aria-label="Clave primaria"
                @change="
                  patch(i, {
                    primaryKey: !col.primaryKey,
                    nullable: col.primaryKey ? col.nullable : false
                  })
                "
              />
            </td>
            <td>
              <input
                :value="defaultToInput(col.defaultValue)"
                class="designer-input"
                :class="{ 'designer-input--null-hint': col.nullable }"
                :placeholder="col.nullable ? 'NULL' : 'Sin valor'"
                title="Vacío = sin valor predeterminado (NULL si admite nulos). Escribe '' para una cadena vacía."
                aria-label="Valor predeterminado"
                :disabled="col.autoIncrement"
                @input="patchDefault(i, ($event.target as HTMLInputElement).value)"
              />
            </td>
            <td class="text-center">
              <input
                type="checkbox"
                :checked="col.autoIncrement"
                aria-label="Auto incremento"
                :disabled="!isNumericType(splitColumnType(col.columnType).base)"
                @change="patch(i, { autoIncrement: !col.autoIncrement, defaultValue: null })"
              />
            </td>
            <td v-if="props.unsigned" class="text-center">
              <input
                type="checkbox"
                :checked="col.unsigned"
                aria-label="Sin signo"
                :disabled="!isNumericType(splitColumnType(col.columnType).base)"
                @change="patch(i, { unsigned: !col.unsigned })"
              />
            </td>
            <td>
              <input
                :value="col.comment"
                class="designer-input designer-input--ui"
                aria-label="Comentario"
                @input="patch(i, { comment: ($event.target as HTMLInputElement).value })"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!model.length" class="designer-empty">
        <v-icon icon="mdi-table-column-plus-after" size="32" />
        La tabla no tiene campos. Añade uno para empezar.
      </div>
    </div>
  </div>
</template>

<style scoped src="./designerTable.css"></style>
<style scoped>
.columns-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.columns-editor__scroll {
  flex: 1 1 auto;
  overflow: auto;
}
.w-name {
  width: 22%;
}
.w-type {
  width: 170px;
}
.w-len {
  width: 100px;
}
.w-check {
  width: 64px;
}
.w-default {
  width: 18%;
}
</style>
