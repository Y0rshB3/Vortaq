<script setup lang="ts">
import { ref } from 'vue'
import type { MenuAction } from '@renderer/composables/useObjectActions'
import { runSafely } from '@renderer/utils/errors'

const open = ref(false)
const position = ref<[number, number]>([0, 0])
const actions = ref<MenuAction[]>([])

function show(event: MouseEvent, items: MenuAction[]): void {
  actions.value = items
  position.value = [event.clientX, event.clientY]
  open.value = true
}

function run(item: MenuAction): void {
  if (item.children) return
  open.value = false
  void runSafely(item.action)
}

defineExpose({ show })
</script>

<template>
  <v-menu v-model="open" :target="position" location="bottom start" :close-on-content-click="true">
    <v-list
      density="compact"
      :min-width="actions.some((a) => a.hint) ? 270 : 220"
      class="context-menu"
      data-test="context-menu"
    >
      <template v-for="item in actions" :key="item.key">
        <v-divider v-if="item.divider" class="context-menu__divider" />
        <v-menu
          v-else-if="item.children"
          submenu
          open-on-hover
          open-on-click
          location="end"
          :close-on-content-click="true"
        >
          <template #activator="{ props: activator }">
            <v-list-item
              v-bind="activator"
              :prepend-icon="item.icon"
              :title="item.label"
              :disabled="item.disabled"
              append-icon="mdi-chevron-right"
              :data-test="`menu-${item.key}`"
            />
          </template>
          <v-list
            density="compact"
            min-width="180"
            class="context-menu"
            :data-test="`submenu-${item.key}`"
          >
            <template v-for="child in item.children" :key="child.key">
              <v-divider v-if="child.divider" class="context-menu__divider" />
              <v-list-item
                v-else
                :prepend-icon="child.icon"
                :title="child.label"
                :disabled="child.disabled"
                :data-test="`menu-${child.key}`"
                @click="run(child)"
              />
            </template>
          </v-list>
        </v-menu>
        <v-list-item
          v-else
          :prepend-icon="item.icon"
          :title="item.label"
          :disabled="item.disabled"
          :class="{ 'context-menu__item--danger': item.danger }"
          :data-test="`menu-${item.key}`"
          @click="run(item)"
        >
          <template v-if="item.hint" #append>
            <span class="context-menu__hint">{{ item.hint }}</span>
          </template>
        </v-list-item>
      </template>
    </v-list>
  </v-menu>
</template>

<style scoped>
.context-menu__divider {
  margin: 4px 6px;
}
.context-menu :deep(.v-list-item) {
  min-height: 30px;
}
.context-menu__hint {
  margin-left: 16px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
/* Destructive items stay neutral until hovered, then turn red. */
.context-menu__item--danger:hover,
.context-menu__item--danger:focus-visible {
  color: var(--nd-error);
  background: var(--nd-error-soft);
}
.context-menu__item--danger:hover :deep(.v-list-item__prepend > .v-icon),
.context-menu__item--danger:focus-visible :deep(.v-list-item__prepend > .v-icon) {
  color: var(--nd-error);
}
.context-menu__item--danger:hover :deep(.v-list-item__overlay) {
  opacity: 0;
}
</style>
