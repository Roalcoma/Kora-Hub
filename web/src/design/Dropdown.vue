<script setup lang="ts" generic="T extends string">
// Reemplazo del <select> nativo (prohibido por el design system). Patrón listbox con teclado.
import { computed, nextTick, ref, useId } from 'vue';
import { ChevronsUpDown, Check } from 'lucide-vue-next';

import type { Option } from './types.ts';

const model = defineModel<T>();
const props = defineProps<{ options: Option<T>[]; label?: string; placeholder?: string; dark?: boolean; disabled?: boolean }>();

const id = useId();
const open = ref(false);
const active = ref(0);
const list = ref<HTMLUListElement>();
const root = ref<HTMLDivElement>();
const current = computed(() => props.options.find((o) => o.value === model.value));

async function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    active.value = Math.max(0, props.options.findIndex((o) => o.value === model.value));
    await nextTick();
    list.value?.focus();
  }
}
function choose(i: number) {
  const opt = props.options[i];
  if (opt) model.value = opt.value;
  open.value = false;
}
function onFocusOut(e: FocusEvent) {
  if (!root.value?.contains(e.relatedTarget as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  const n = props.options.length;
  if (e.key === 'ArrowDown') active.value = (active.value + 1) % n;
  else if (e.key === 'ArrowUp') active.value = (active.value - 1 + n) % n;
  else if (e.key === 'Home') active.value = 0;
  else if (e.key === 'End') active.value = n - 1;
  else if (e.key === 'Enter' || e.key === ' ') choose(active.value);
  else if (e.key === 'Escape' || e.key === 'Tab') open.value = false;
  else return;
  e.preventDefault();
}
</script>

<template>
  <div ref="root" class="dd" :class="{ dark }" @focusout="onFocusOut">
    <span v-if="label" :id="`${id}-label`" class="lbl">{{ label }}</span>
    <button type="button" class="trigger" :disabled="disabled" aria-haspopup="listbox" :aria-expanded="open"
      :aria-labelledby="label ? `${id}-label ${id}-btn` : undefined" :id="`${id}-btn`" @click="toggle"
      @keydown.down.prevent="!open && toggle()">
      <span :class="{ ph: !current }">{{ current?.label ?? placeholder ?? '—' }}</span>
      <ChevronsUpDown :size="15" />
    </button>
    <ul v-if="open" ref="list" class="menu" role="listbox" tabindex="-1" :aria-activedescendant="`${id}-o${active}`" @keydown="onKey">
      <li v-for="(o, i) in options" :id="`${id}-o${i}`" :key="o.value" role="option" :aria-selected="o.value === model"
        :class="{ active: i === active }" @mousedown.prevent="choose(i)" @mousemove="active = i">
        <span class="txt">{{ o.label }}<small v-if="o.hint">{{ o.hint }}</small></span>
        <Check v-if="o.value === model" :size="15" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.dd { position: relative; display: grid; gap: 6px; }
.lbl { font-size: 13px; font-weight: 500; }
.trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; padding: 0 10px 0 12px; font: inherit; color: inherit; text-align: left; background: var(--color-surface); border: 1px solid var(--color-line-strong); cursor: pointer; transition: border-color var(--duration); }
.trigger:hover:not(:disabled) { border-color: var(--color-ink); }
.trigger:disabled { opacity: .55; cursor: not-allowed; }
.ph { color: var(--color-muted); }
.menu { position: absolute; z-index: 40; top: 100%; left: 0; right: 0; min-width: 180px; margin: 4px 0 0; padding: 4px 0; list-style: none; background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-lg); max-height: 280px; overflow: auto; outline: none; color: var(--color-ink); }
li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; cursor: pointer; }
li.active { background: var(--color-ink); color: #fff; }
.txt { display: grid; }
small { font-size: 12px; color: var(--color-muted); }
li.active small { color: var(--color-sidebar-text); }
.dark .trigger { background: rgb(255 255 255 / .06); border-color: rgb(255 255 255 / .14); color: #fff; }
.dark .trigger:hover:not(:disabled) { border-color: rgb(255 255 255 / .4); }
.dark .lbl { color: var(--color-sidebar-text); }
</style>
