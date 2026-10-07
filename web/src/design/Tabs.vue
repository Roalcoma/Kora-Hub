<script setup lang="ts" generic="T extends string">
import type { Option } from './types.ts';

const model = defineModel<T>({ required: true });
const props = defineProps<{ tabs: (Option<T> & { count?: number })[] }>();

function onKey(e: KeyboardEvent) {
  const i = props.tabs.findIndex((t) => t.value === model.value);
  const n = props.tabs.length;
  const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : -1;
  if (next < 0) return;
  model.value = props.tabs[next]!.value;
  ((e.currentTarget as HTMLElement).children[next] as HTMLElement).focus();
}
</script>

<template>
  <div class="tabs" role="tablist" @keydown="onKey">
    <button v-for="t in tabs" :key="t.value" type="button" role="tab" :aria-selected="t.value === model"
      :tabindex="t.value === model ? 0 : -1" @click="model = t.value">
      {{ t.label }}<span v-if="t.count !== undefined" class="n">{{ t.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-line); overflow-x: auto; }
button { display: inline-flex; align-items: center; gap: 6px; min-height: var(--tap); padding: 0 12px; font: inherit; font-weight: 500; font-size: 14px; color: var(--color-muted); background: none; border: 0; border-bottom: 3px solid transparent; cursor: pointer; white-space: nowrap; transition: color var(--duration), border-color var(--duration); }
button:hover { color: var(--color-ink); }
button[aria-selected="true"] { color: var(--color-ink); border-bottom-color: var(--color-primary); }
.n { font-size: 12px; padding: 0 6px; background: var(--color-canvas); border: 1px solid var(--color-line); font-variant-numeric: tabular-nums; }
</style>
