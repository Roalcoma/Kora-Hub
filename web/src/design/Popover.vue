<script setup lang="ts">
// Contenido flotante anclado a su disparador. Se cierra con Esc o clic fuera.
import { onBeforeUnmount, ref, watch } from 'vue';

const open = defineModel<boolean>({ default: false });
defineProps<{ placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' }>();
const root = ref<HTMLElement>();

const onDown = (e: PointerEvent) => { if (!root.value?.contains(e.target as Node)) open.value = false; };
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') open.value = false; };
watch(open, (v) => {
  if (v) {
    setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    document.addEventListener('keydown', onKey);
  } else {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
  }
});
onBeforeUnmount(() => { open.value = false; });
</script>

<template>
  <span ref="root" class="pop">
    <slot name="trigger" />
    <Transition name="pop">
      <div v-if="open" class="panel" :class="placement ?? 'top-start'"><slot /></div>
    </Transition>
  </span>
</template>

<style scoped>
.pop { position: relative; display: inline-flex; }
.panel { position: absolute; z-index: 45; }
.top-start { bottom: calc(100% + 6px); left: 0; }
.top-end { bottom: calc(100% + 6px); right: 0; }
.bottom-start { top: calc(100% + 6px); left: 0; }
.bottom-end { top: calc(100% + 6px); right: 0; }
.pop-enter-active, .pop-leave-active { transition: opacity var(--duration), transform var(--duration); }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(4px); }
</style>
