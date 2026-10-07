<script setup lang="ts">
// Menú contextual (clic derecho o botón "más"). Se posiciona en x/y y se cierra con Esc o clic fuera.
import { computed, nextTick, ref, watch } from 'vue';
import type { MenuItem } from './types.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ items: MenuItem[]; x: number; y: number }>();
const menu = ref<HTMLDivElement>();
const left = computed(() => Math.max(8, Math.min(props.x, window.innerWidth - 220)));

watch(open, async (v) => {
  if (!v) return;
  await nextTick();
  (menu.value?.querySelector('button') as HTMLElement | null)?.focus();
});
function run(item: MenuItem) {
  open.value = false;
  item.action();
}
function onKey(e: KeyboardEvent) {
  const btns = [...(menu.value?.querySelectorAll('button') ?? [])];
  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown') btns[(i + 1) % btns.length]?.focus();
  else if (e.key === 'ArrowUp') btns[(i - 1 + btns.length) % btns.length]?.focus();
  else if (e.key === 'Escape') open.value = false;
  else return;
  e.preventDefault();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="scrim" @mousedown="open = false" @contextmenu.prevent="open = false" />
    <div v-if="open" ref="menu" class="menu" role="menu" :style="{ left: `${left}px`, top: `${y}px` }" @keydown="onKey">
      <button v-for="it in items" :key="it.label" type="button" role="menuitem" :class="{ danger: it.danger }" @click="run(it)">
        <component :is="it.icon" v-if="it.icon" :size="16" />{{ it.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: 60; }
.menu { position: fixed; z-index: 61; min-width: 200px; padding: 4px 0; background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-lg); display: grid; }
button { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 0 14px; font: inherit; font-size: 14px; text-align: left; color: var(--color-ink); background: none; border: 0; cursor: pointer; }
button:hover, button:focus-visible { background: var(--color-ink); color: #fff; outline: none; }
.danger { color: var(--color-danger); }
.danger:hover, .danger:focus-visible { background: var(--color-danger); color: #fff; }
</style>
