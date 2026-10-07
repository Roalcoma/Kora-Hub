<script setup lang="ts" generic="T extends string">
// Reemplazo del <select> nativo (prohibido por el design system). Patrón listbox con teclado.
// `searchable`: caja de búsqueda arriba de la lista (listas largas, p. ej. zonas horarias). Ignora acentos.
import { computed, nextTick, ref, useId } from 'vue';
import { ChevronDown, Check, Search } from 'lucide-vue-next';
import type { Option } from './types.ts';

const model = defineModel<T>();
const props = defineProps<{ options: Option<T>[]; label?: string; placeholder?: string; dark?: boolean; disabled?: boolean; searchable?: boolean; searchPlaceholder?: string }>();

const id = useId();
const open = ref(false);
const active = ref(0);
const q = ref('');
const list = ref<HTMLUListElement>();
const search = ref<HTMLInputElement>();
const root = ref<HTMLDivElement>();
const current = computed(() => props.options.find((o) => o.value === model.value));
const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const shown = computed(() => (props.searchable && q.value.trim()
  ? props.options.filter((o) => fold(`${o.label} ${o.hint ?? ''}`).includes(fold(q.value.trim())))
  : props.options));

const scrollActive = () => list.value?.children[active.value]?.scrollIntoView({ block: 'nearest' });
async function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    q.value = '';
    active.value = Math.max(0, props.options.findIndex((o) => o.value === model.value));
    await nextTick();
    (props.searchable ? search.value : list.value)?.focus();
    scrollActive();
  }
}
function choose(i: number) {
  const opt = shown.value[i];
  if (opt) model.value = opt.value;
  open.value = false;
}
function onFocusOut(e: FocusEvent) {
  if (!root.value?.contains(e.relatedTarget as Node)) open.value = false;
}
function onSearch() {
  active.value = 0;
  list.value?.scrollTo({ top: 0 });
}
function onKey(e: KeyboardEvent) {
  const n = shown.value.length;
  const typing = e.target === search.value;
  if (e.key === 'ArrowDown') active.value = (active.value + 1) % Math.max(n, 1);
  else if (e.key === 'ArrowUp') active.value = (active.value - 1 + n) % Math.max(n, 1);
  else if (e.key === 'Home' && !typing) active.value = 0;
  else if (e.key === 'End' && !typing) active.value = n - 1;
  else if (e.key === 'Enter' || (e.key === ' ' && !typing)) choose(active.value);
  else if (e.key === 'Escape' || e.key === 'Tab') open.value = false;
  else return;
  e.preventDefault();
  scrollActive();
}
</script>

<template>
  <div ref="root" class="dd" :class="{ dark, open }" @focusout="onFocusOut">
    <span v-if="label" :id="`${id}-label`" class="lbl">{{ label }}</span>
    <button :id="`${id}-btn`" type="button" class="trigger" :disabled="disabled" aria-haspopup="listbox" :aria-expanded="open"
      :aria-labelledby="label ? `${id}-label ${id}-btn` : undefined" @click="toggle" @keydown.down.prevent="!open && toggle()">
      <span class="value" :class="{ ph: !current }">{{ current?.label ?? placeholder ?? '—' }}</span>
      <ChevronDown :size="16" class="chev" />
    </button>
    <Transition name="menu">
      <div v-if="open" class="menu" @keydown="onKey">
        <label v-if="searchable" class="find"><Search :size="15" />
          <input ref="search" v-model="q" :placeholder="searchPlaceholder ?? '…'" :aria-label="searchPlaceholder ?? label" :aria-controls="`${id}-list`"
            :aria-activedescendant="shown.length ? `${id}-o${active}` : undefined" @input="onSearch">
        </label>
        <ul :id="`${id}-list`" ref="list" role="listbox" tabindex="-1" :aria-activedescendant="shown.length ? `${id}-o${active}` : undefined">
          <li v-for="(o, i) in shown" :id="`${id}-o${i}`" :key="o.value" role="option" :aria-selected="o.value === model"
            :class="{ active: i === active, selected: o.value === model }" @mousedown.prevent="choose(i)" @mousemove="active = i">
            <span class="txt">{{ o.label }}<small v-if="o.hint">{{ o.hint }}</small></span>
            <Check v-if="o.value === model" :size="16" class="check" />
          </li>
          <li v-if="!shown.length" class="none">—</li>
        </ul>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dd { position: relative; display: grid; gap: 6px; }
.lbl { font-size: 13px; font-weight: 500; }
.trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 42px; padding: 0 12px 0 14px;
  font: inherit; color: inherit; text-align: left; background: var(--color-surface); border: 1px solid var(--color-line-strong);
  box-shadow: var(--shadow-sm); cursor: pointer; transition: border-color var(--duration), box-shadow var(--duration);
}
.trigger:hover:not(:disabled) { border-color: var(--color-ink); box-shadow: var(--shadow-md); }
.open .trigger { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .22), var(--shadow-md); }
.trigger:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; }
.value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph { color: var(--color-muted); }
.chev { flex: none; color: var(--color-muted); transition: transform var(--duration); }
.open .chev { transform: rotate(180deg); color: var(--color-ink); }

.menu {
  position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; min-width: max(100%, 200px);
  display: flex; flex-direction: column; color: var(--color-ink);
  background: var(--color-surface); box-shadow: 0 18px 40px rgb(19 36 61 / .22), 0 2px 6px rgb(19 36 61 / .10), 0 0 0 1px rgb(19 36 61 / .06);
  transform-origin: top left;
}
ul { max-height: 300px; overflow: auto; margin: 0; padding: 6px; list-style: none; outline: none; }
.find { display: flex; align-items: center; gap: 8px; margin: 6px 6px 0; padding: 0 10px; color: var(--color-muted); background: var(--color-canvas); border: 1px solid var(--color-line); }
.find:focus-within { border-color: var(--color-ink); background: var(--color-surface); }
.find input { flex: 1; min-width: 0; min-height: 36px; font: inherit; font-size: 14px; color: var(--color-ink); background: none; border: 0; outline: none; }
li.none { color: var(--color-muted); cursor: default; }
li { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 40px; padding: 6px 12px 6px 14px; cursor: pointer; transition: background 120ms; }
/* Opción activa: fondo suave y barra naranja a la izquierda, en vez de invertir colores */
li.active { background: var(--color-canvas); }
li.active::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; background: var(--color-primary); }
li.selected .txt { font-weight: 700; }
.check { color: var(--color-primary-dark); flex: none; }
.txt { display: grid; gap: 1px; }
small { font-size: 12px; font-weight: 400; color: var(--color-muted); }
.menu-enter-active, .menu-leave-active { transition: opacity 140ms, transform 140ms; }
.menu-enter-from, .menu-leave-to { opacity: 0; transform: translateY(-4px) scale(.98); }

.dark .trigger { background: rgb(255 255 255 / .06); border-color: rgb(255 255 255 / .14); color: #fff; box-shadow: inset 0 1px 0 rgb(255 255 255 / .04); }
.dark .trigger:hover:not(:disabled) { border-color: rgb(255 255 255 / .4); box-shadow: none; }
.dark.open .trigger { border-color: var(--color-cta); box-shadow: 0 0 0 3px rgb(96 208 250 / .18); }
.dark .chev, .dark.open .chev { color: var(--color-sidebar-text); }
.dark .lbl { color: var(--color-sidebar-text); }
</style>
