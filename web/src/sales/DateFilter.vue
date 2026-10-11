<script setup lang="ts">
// Filtro de fecha de Ventas y Comisiones: los atajos de cada pestaña más "Hoy", "Un día…" y "Rango…".
// El modelo solo cambia con valores válidos (un rango con desde > hasta se marca y no se aplica).
// La raíz usa `display: contents`: el desplegable y las fechas se acomodan como piezas más de la barra de filtros.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dropdown from '@/design/Dropdown.vue';
import type { Option } from '@/design/types.ts';
import { CUSTOM_PERIODS, today, type DateFilterValue } from './format.ts';

const model = defineModel<DateFilterValue>({ required: true });
const props = defineProps<{ presets: Option[]; label?: string }>();
const { t } = useI18n();

const options = computed(() => [...props.presets, ...CUSTOM_PERIODS.map((v) => ({ value: v, label: t(`sales.dateFilter.${v}`) }))]);
const period = computed({
  get: () => model.value.period,
  set: (p: string) => {
    if (p === 'day') {
      const d = from.value || today();
      model.value = { period: p, from: d, to: d };
    } else if (p === 'range') model.value = { period: p, from: from.value, to: to.value };
    else model.value = { period: p, from: '', to: '' };
  },
});

// Borradores de los inputs: siguen al modelo cuando cambia desde afuera (p. ej. la pestaña lo pasa a "Todas").
// En "Rango…" mandan los borradores: así un rango inválido a medio escribir no se pisa.
const from = ref(model.value.from);
const to = ref(model.value.to);
watch(model, (v) => { if (v.period !== 'range') { from.value = v.from; to.value = v.to; } });
const invalid = computed(() => period.value === 'range' && !!from.value && !!to.value && from.value > to.value);

function setDay(v: string) {
  from.value = v;
  if (v) model.value = { period: 'day', from: v, to: v };
}
function setRange() {
  if (!invalid.value) model.value = { period: 'range', from: from.value, to: to.value };
}
</script>

<template>
  <div class="df">
    <Dropdown v-model="period" :options="options" :aria-label="label ?? t('sales.period')" />
    <label v-if="period === 'day'" class="when">
      <span>{{ t('sales.dateFilter.dayLabel') }}</span>
      <input :value="from" type="date" @change="setDay(($event.target as HTMLInputElement).value)">
    </label>
    <template v-else-if="period === 'range'">
      <label class="when" :class="{ bad: invalid }">
        <span>{{ t('sales.dateFilter.from') }}</span>
        <input v-model="from" type="date" :max="to || undefined" :aria-invalid="invalid" @change="setRange">
      </label>
      <label class="when" :class="{ bad: invalid }">
        <span>{{ t('sales.dateFilter.to') }}</span>
        <input v-model="to" type="date" :min="from || undefined" :aria-invalid="invalid" @change="setRange">
      </label>
      <p v-if="invalid" class="err" role="alert">{{ t('sales.dateFilter.invalid') }}</p>
    </template>
  </div>
</template>

<style scoped>
.df { display: contents; }
/* Fecha con su rótulo dentro del mismo recuadro, a la altura de los desplegables */
.when { display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 4px 0 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em;
  color: var(--color-muted); background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: border-color var(--duration), box-shadow var(--duration); }
.when:focus-within { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .22); }
.when input { min-height: 38px; padding: 0 6px; text-transform: none; letter-spacing: 0; font-weight: 400; border: 0; box-shadow: none; background: none; }
.when input:focus { box-shadow: none; }
.when.bad { border-color: var(--color-danger); }
.err { flex-basis: 100%; margin: -4px 0 0; font-size: 13px; color: var(--color-danger); }

@media (max-width: 767px) {
  .when { width: calc(50% - 6px); min-width: 0; flex-wrap: wrap; gap: 0; padding: 4px 4px 0 10px; }
  .when span { flex-basis: 100%; font-size: 11px; }
  .when input { width: 100%; min-width: 0; min-height: 34px; padding: 0; }
}
</style>
