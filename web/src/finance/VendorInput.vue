<script setup lang="ts">
// Proveedor o beneficiario: texto libre con sugerencias de los ya usados (GET finance/vendors). Sin datalist nativo:
// la lista se dibuja como el menú de Dropdown y se maneja con flechas, Enter y Escape.
import { computed, ref, useId, watch } from 'vue';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';

const model = defineModel<string>({ default: '' });
defineProps<{ label?: string; placeholder?: string; error?: string | null }>();
const s = useSession();
const id = useId();

const all = ref<string[]>([]);
const open = ref(false);
const active = ref(0);
let timer: ReturnType<typeof setTimeout> | undefined;
/** El servidor ya filtra por `q`; se piden las sugerencias con una pausa corta mientras se escribe */
function fetchSoon() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const q = model.value.trim();
      all.value = await api('GET /w/:slug/finance/vendors', { params: { slug: s.workspace!.slug }, query: { q: q || undefined } });
    } catch { all.value = []; }
  }, 180);
}
const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const shown = computed(() => {
  const q = fold(model.value.trim());
  return all.value.filter((v) => fold(v).includes(q) && v !== model.value).slice(0, 8);
});
watch(shown, () => { active.value = 0; });

function onInput() { open.value = true; fetchSoon(); }
/** Al enfocar solo se piden las sugerencias: el menú se abre al escribir o con la flecha abajo (un modal enfoca este campo al abrirse) */
function onFocus() { fetchSoon(); }
function choose(v: string) { model.value = v; open.value = false; }
function onKey(e: KeyboardEvent) {
  if (!open.value && e.key === 'ArrowDown') { open.value = true; e.preventDefault(); return; }
  if (!open.value || !shown.value.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); active.value = (active.value + 1) % shown.value.length; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active.value = (active.value - 1 + shown.value.length) % shown.value.length; }
  else if (e.key === 'Enter') { e.preventDefault(); choose(shown.value[active.value]!); }
  else if (e.key === 'Escape') { e.stopPropagation(); open.value = false; }
}
</script>

<template>
  <div class="field">
    <label v-if="label" :for="id">{{ label }}</label>
    <div class="box" :class="{ invalid: error }">
      <input :id="id" v-model="model" :placeholder="placeholder" autocomplete="off" maxlength="120" role="combobox" :aria-expanded="open && !!shown.length"
        :aria-controls="`${id}-list`" :aria-activedescendant="open && shown.length ? `${id}-o${active}` : undefined" :aria-invalid="!!error"
        @input="onInput" @focus="onFocus" @blur="open = false" @keydown="onKey">
    </div>
    <ul v-if="open && shown.length" :id="`${id}-list`" role="listbox" class="menu">
      <li v-for="(v, i) in shown" :id="`${id}-o${i}`" :key="v" role="option" :aria-selected="i === active" :class="{ active: i === active }"
        @mousedown.prevent="choose(v)" @mousemove="active = i">{{ v }}</li>
    </ul>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.field { position: relative; display: grid; gap: 6px; }
label { font-size: 13px; font-weight: 500; }
.box { display: flex; background: var(--color-surface); border: 1px solid var(--color-line-strong); transition: border-color var(--duration), box-shadow var(--duration); }
.box:focus-within { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .25); }
.box.invalid { border-color: var(--color-danger); }
input { flex: 1; width: 0; min-width: 0; min-height: 40px; padding: 0 12px; border: 0; background: transparent; font: inherit; color: inherit; outline: none; }
.menu { position: absolute; z-index: 40; top: calc(100% + 4px); left: 0; right: 0; max-height: 260px; overflow: auto; margin: 0; padding: 6px; list-style: none;
  background: var(--color-surface); box-shadow: 0 18px 40px rgb(19 36 61 / .22), 0 2px 6px rgb(19 36 61 / .10), 0 0 0 1px rgb(19 36 61 / .06); }
li { position: relative; display: flex; align-items: center; min-height: 38px; padding: 6px 12px 6px 14px; cursor: pointer; }
li.active { background: var(--color-canvas); }
li.active::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; background: var(--color-primary); }
.error { margin: 0; font-size: 12px; color: var(--color-danger); font-weight: 500; }
</style>
