<script setup lang="ts">
// Paginación de listas largas: rango visible, páginas con elipsis y tamaño de página. Va alineada a la derecha,
// debajo de la tabla. Los textos llegan por props (el design system no depende de i18n), con español por defecto.
import { computed } from 'vue';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
import Dropdown from './Dropdown.vue';

const page = defineModel<number>({ required: true });
const size = defineModel<number>('size', { default: 25 });
const props = withDefaults(defineProps<{
  total: number; sizes?: number[];
  labels?: { prev: string; next: string; perPage: string; of: string };
}>(), { sizes: () => [25, 50, 100], labels: () => ({ prev: 'Anterior', next: 'Siguiente', perPage: 'por página', of: 'de' }) });

const pages = computed(() => Math.max(1, Math.ceil(props.total / size.value)));
const from = computed(() => (props.total ? (page.value - 1) * size.value + 1 : 0));
const to = computed(() => Math.min(props.total, page.value * size.value));
/** 1 … 4 5 6 … 12: siempre la primera, la última y dos alrededor de la actual */
const items = computed(() => {
  const n = pages.value, p = page.value;
  const keep = [...new Set([1, n, p - 1, p, p + 1].filter((x) => x >= 1 && x <= n))].sort((a, b) => a - b);
  return keep.flatMap((x, i) => (i && x - keep[i - 1]! > 1 ? ['…', x] : [x]));
});
const sizeOptions = computed(() => props.sizes.map((x) => ({ value: String(x), label: `${x} ${props.labels.perPage}` })));
const sizeStr = computed({ get: () => String(size.value), set: (v) => { size.value = Number(v); page.value = 1; } });
</script>

<template>
  <nav v-if="total > sizes[0]!" class="pager" :aria-label="`${from}–${to} ${labels.of} ${total}`">
    <span class="range"><b>{{ from }}–{{ to }}</b> {{ labels.of }} {{ total }}</span>
    <Dropdown v-model="sizeStr" :options="sizeOptions" class="size" :aria-label="labels.perPage" />
    <div class="pages">
      <button type="button" class="nav" :disabled="page <= 1" :aria-label="labels.prev" @click="page--"><ChevronLeft :size="17" /></button>
      <template v-for="(x, i) in items" :key="i">
        <span v-if="x === '…'" class="gap">…</span>
        <button v-else type="button" :class="{ on: x === page }" :aria-current="x === page ? 'page' : undefined" @click="page = x as number">{{ x }}</button>
      </template>
      <button type="button" class="nav" :disabled="page >= pages" :aria-label="labels.next" @click="page++"><ChevronRight :size="17" /></button>
    </div>
  </nav>
</template>

<style scoped>
.pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px 16px; }
.range { margin-right: auto; font-size: 14px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
.range b { color: var(--color-ink); }
.size { width: 150px; }
.pages { display: flex; align-items: center; gap: 4px; padding: 3px; background: var(--color-surface); box-shadow: var(--shadow-sm); }
.pages button { min-width: 34px; height: 34px; padding: 0 8px; display: inline-grid; place-items: center; font: inherit; font-size: 14px; font-variant-numeric: tabular-nums; color: var(--color-ink); background: none; border: 0; cursor: pointer; transition: background var(--duration), box-shadow var(--duration); }
.pages button:hover:not(:disabled):not(.on) { background: var(--color-canvas-deep); }
.pages button.on { font-weight: 700; background: var(--color-primary); box-shadow: var(--shadow-sm); }
.pages button:disabled { color: var(--color-line-strong); cursor: not-allowed; }
.gap { min-width: 20px; text-align: center; color: var(--color-muted); }
@media (max-width: 520px) { .range { width: 100%; } .size { width: 130px; } }
</style>
