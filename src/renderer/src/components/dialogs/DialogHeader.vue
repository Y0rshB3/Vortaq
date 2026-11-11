<script setup lang="ts">
/** Nebula dialog header: gradient-tinted icon badge, title, optional subtitle and trailing slot. */
defineProps<{ icon: string; title: string; subtitle?: string; danger?: boolean }>()
</script>

<template>
  <header class="dialog-header">
    <span class="nd-icon-badge" :class="{ 'nd-icon-badge--danger': danger }" aria-hidden="true">
      <v-icon :icon="icon" size="18" />
    </span>
    <div class="dialog-header__text">
      <h2 class="dialog-header__title nd-ellipsis" :title="title">{{ title }}</h2>
      <div v-if="subtitle || $slots.subtitle" class="dialog-header__subtitle nd-ellipsis">
        <slot name="subtitle">{{ subtitle }}</slot>
      </div>
    </div>
    <div v-if="$slots.default" class="dialog-header__append">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.dialog-header {
  /* Never squeezed by a scrollable dialog's body on a short window. */
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px 12px;
  min-width: 0;
}
.dialog-header__text {
  flex: 1;
  min-width: 0;
}
.dialog-header__title {
  margin: 0;
  font-size: var(--nd-fs-title);
  font-weight: var(--nd-fw-heading);
  line-height: 1.3;
  color: var(--nd-text);
}
.dialog-header__subtitle {
  margin-top: 1px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.dialog-header__append {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
