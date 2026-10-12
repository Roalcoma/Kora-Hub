<script setup lang="ts">
// Desglose de una línea de nómina: ingresos a la izquierda (suman al bruto), deducciones a la derecha y el neto.
// Lo usan el detalle de la corrida (con quitar ajuste en borrador) y el recibo imprimible.
// Los nombres por defecto llegan del servidor en español; aquí se traducen por tipo si no se personalizaron.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { X } from 'lucide-vue-next';
import type { PayrollItem, PayrollLine } from '@agencia-hub/contracts';
import { usd } from './format.ts';

const props = defineProps<{ line: PayrollLine; removable?: boolean; busy?: boolean }>();
const emit = defineEmits<{ removeAdjustment: [id: string] }>();
const { t, locale } = useI18n();
const money = (n: number) => usd(n, locale.value);

/** Nombres por defecto de payroll-calc.ts → clave de i18n */
const DEFAULTS: Record<string, string> = {
  Sueldo: 'salary', Horas: 'hourly', 'Comisiones de ventas': 'sales_commission', '% de ventas': 'sales_percent',
  Bono: 'bonus', Deducción: 'deduction_fixed', 'Deducción %': 'deduction_percent',
};
const label = (i: PayrollItem) => {
  if (i.label === 'Chargebacks de comisión') return t('finance.payroll.run.chargebacks');
  return DEFAULTS[i.label] && !i.kind.startsWith('adjustment') ? t(`finance.payroll.kinds.${DEFAULTS[i.label]}`) : i.label;
};
const EARNING = ['salary', 'hourly', 'sales_commission', 'sales_percent', 'bonus', 'adjustment_bonus'];
/** El renglón informativo de "neto negativo" (monto 0, sin origen) no se lista: se destaca aparte */
const items = computed(() => props.line.breakdown.filter((i) => !(i.sourceId == null && i.amount === 0 && i.kind === 'adjustment_deduction')));
const earnings = computed(() => items.value.filter((i) => EARNING.includes(i.kind)));
const deductions = computed(() => items.value.filter((i) => !EARNING.includes(i.kind)));
const isAdjustment = (i: PayrollItem) => i.kind.startsWith('adjustment') && i.sourceId;
</script>

<template>
  <div class="bd">
    <section class="col">
      <h4>{{ t('finance.payroll.run.earnings') }}</h4>
      <p v-if="!earnings.length" class="none">{{ t('finance.payroll.run.noEarnings') }}</p>
      <ul v-else>
        <li v-for="(i, n) in earnings" :key="n">
          <span class="lbl">{{ label(i) }}<small v-if="isAdjustment(i)" class="adj">{{ t('finance.payroll.run.oneOff') }}</small><small v-if="i.detail">{{ i.detail }}</small></span>
          <b>{{ money(i.amount) }}</b>
          <button v-if="removable && isAdjustment(i)" type="button" class="rm" :disabled="busy" :title="t('finance.payroll.run.removeAdj')"
            :aria-label="t('finance.payroll.run.removeAdj')" @click="emit('removeAdjustment', i.sourceId!)"><X :size="14" /></button>
        </li>
      </ul>
      <p class="sum"><span>{{ t('finance.payroll.run.gross') }}</span><b>{{ money(line.gross) }}</b></p>
    </section>
    <section class="col ded">
      <h4>{{ t('finance.payroll.run.deductions') }}</h4>
      <p v-if="!deductions.length" class="none">{{ t('finance.payroll.run.noDeductions') }}</p>
      <ul v-else>
        <li v-for="(i, n) in deductions" :key="n">
          <span class="lbl">{{ label(i) }}<small v-if="isAdjustment(i)" class="adj">{{ t('finance.payroll.run.oneOff') }}</small><small v-if="i.detail">{{ i.detail }}</small></span>
          <b>−{{ money(i.amount) }}</b>
          <button v-if="removable && isAdjustment(i)" type="button" class="rm" :disabled="busy" :title="t('finance.payroll.run.removeAdj')"
            :aria-label="t('finance.payroll.run.removeAdj')" @click="emit('removeAdjustment', i.sourceId!)"><X :size="14" /></button>
        </li>
      </ul>
      <p class="sum"><span>{{ t('finance.payroll.run.totalDeductions') }}</span><b>{{ line.deductions ? '−' : '' }}{{ money(line.deductions) }}</b></p>
    </section>
    <p class="net" :class="{ neg: line.net < 0 }"><span>{{ t('finance.payroll.run.net') }}</span><b>{{ money(line.net) }}</b>
      <small v-if="line.net < 0">{{ t('finance.payroll.run.negativeHint') }}</small></p>
  </div>
</template>

<style scoped>
.bd { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; }
.col { display: grid; gap: 6px; align-content: start; min-width: 0; padding-left: 12px; border-left: 3px solid var(--color-success); }
.col.ded { border-left-color: var(--color-danger); }
h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: start; gap: 8px; font-size: 14px; }
.lbl { min-width: 0; overflow-wrap: anywhere; }
.lbl small { display: block; font-size: 12px; color: var(--color-muted); }
.lbl small.adj { display: inline; margin-left: 6px; padding: 0 5px; font-weight: 600; color: var(--color-ink); background: var(--color-primary-light); }
li b { font-variant-numeric: tabular-nums; white-space: nowrap; }
.rm { display: grid; place-items: center; width: 24px; height: 24px; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.rm:hover { color: var(--color-danger); background: var(--color-danger-light); }
.none { margin: 0; font-size: 13px; color: var(--color-muted); }
.sum { display: flex; justify-content: space-between; gap: 8px; margin: 4px 0 0; padding-top: 6px; font-size: 14px; border-top: 1px dashed var(--color-line-strong); }
.sum b { font-variant-numeric: tabular-nums; }
.net { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; margin: 0; padding: 10px 12px;
  background: var(--color-canvas); border-left: 4px solid var(--color-ink); }
.net span { font-weight: 600; }
.net b { font-family: var(--font-display); font-size: 20px; font-variant-numeric: tabular-nums; }
.net small { flex-basis: 100%; font-size: 12px; color: var(--color-danger); }
.net.neg { background: var(--color-danger-light); border-left-color: var(--color-danger); }
.net.neg b { color: var(--color-danger); }
@media (max-width: 600px) { .bd { grid-template-columns: 1fr; } }
</style>
