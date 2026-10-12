<script setup lang="ts">
// Crear o editar un calendario de pago. La frecuencia se elige al crear y no cambia (se crea otro calendario):
// semanal y quincenal piden una fecha de pago del ciclo (ancla), dos veces al mes paga el 15 y el último,
// mensual paga un día del mes siguiente o el último día del mismo mes.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CalendarClock } from 'lucide-vue-next';
import { PAYROLL_FREQUENCIES, type PayrollCalendar, type PayrollFrequency } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { today } from './format.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ calendar?: PayrollCalendar | null }>();
const emit = defineEmits<{ saved: [calendar: PayrollCalendar] }>();
const { t } = useI18n();
const s = useSession();

const f = reactive({ name: '', frequency: 'biweekly' as PayrollFrequency, anchorDate: '', payDay: 'last' });
const busy = ref(false);
const error = ref<string | null>(null);
watch(open, (v) => {
  if (!v) return;
  const c = props.calendar;
  Object.assign(f, {
    name: c?.name ?? '', frequency: c?.frequency ?? 'biweekly', anchorDate: c?.anchorDate ?? today(),
    payDay: c?.payDay == null ? 'last' : String(c.payDay),
  });
  error.value = null;
});

const cycle = computed(() => f.frequency === 'weekly' || f.frequency === 'biweekly');
const dayOptions = computed(() => [
  { value: 'last', label: t('finance.payroll.cal.lastDaySame') },
  ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: t('finance.payroll.cal.dayNext', { d: i + 1 }) })),
]);
const valid = computed(() => f.name.trim() && (!cycle.value || f.anchorDate));

async function save() {
  busy.value = true;
  error.value = null;
  const payDay = f.frequency === 'monthly' ? (f.payDay === 'last' ? 'last' as const : Number(f.payDay)) : null;
  const anchorDate = cycle.value ? f.anchorDate : null;
  try {
    const params = { slug: s.workspace!.slug };
    const saved = props.calendar
      ? await api('PATCH /w/:slug/finance/payroll/calendars/:id', { params: { ...params, id: props.calendar.id }, body: { name: f.name.trim(), anchorDate, payDay } })
      : await api('POST /w/:slug/finance/payroll/calendars', { params, body: { name: f.name.trim(), frequency: f.frequency, anchorDate, payDay } });
    toast(t('common.saved'), 'success');
    open.value = false;
    emit('saved', saved);
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="calendar ? t('finance.payroll.cal.edit') : t('finance.payroll.cal.new')" :subtitle="t('finance.payroll.cal.newHint')" width="560px">
    <form id="pcal-form" class="grid gap-4" novalidate @submit.prevent="valid && save()">
      <Input v-model="f.name" :label="t('finance.payroll.cal.name')" :placeholder="t('finance.payroll.cal.namePh')" />
      <fieldset class="rule">
        <legend>{{ t('finance.payroll.cal.frequency') }}</legend>
        <div class="seg" role="radiogroup" :aria-label="t('finance.payroll.cal.frequency')">
          <button v-for="fr in PAYROLL_FREQUENCIES" :key="fr" type="button" role="radio" :aria-checked="f.frequency === fr"
            :disabled="!!calendar && calendar.frequency !== fr" @click="f.frequency = fr">{{ t(`finance.payroll.freq.${fr}`) }}</button>
        </div>
        <label v-if="cycle" class="date">{{ t('finance.payroll.cal.anchor') }}<input v-model="f.anchorDate" type="date">
          <small>{{ t(f.frequency === 'weekly' ? 'finance.payroll.cal.anchorWeekly' : 'finance.payroll.cal.anchorBiweekly') }}</small></label>
        <Dropdown v-else-if="f.frequency === 'monthly'" v-model="f.payDay" class="mday" :options="dayOptions" :label="t('finance.payroll.cal.payDay')" />
        <p v-else class="preview"><CalendarClock :size="16" />{{ t('finance.payroll.cal.semimonthlyRule') }}</p>
        <small v-if="f.frequency === 'monthly'" class="muted">{{ t('finance.payroll.cal.monthlyHint') }}</small>
      </fieldset>
      <p v-if="calendar" class="note">{{ t('finance.payroll.cal.freqFixed') }}</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="pcal-form" :loading="busy" :disabled="!valid">{{ t('common.save') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; max-width: 300px; }
.date input { min-height: 42px; }
.date small, .muted { font-size: 12px; font-weight: 400; color: var(--color-muted); }
.rule { display: grid; gap: 14px; margin: 0; padding: 14px 16px 16px; min-width: 0; border: 0; border-left: 3px solid var(--color-primary); background: var(--color-canvas); }
.rule legend { float: left; width: 100%; padding: 0; font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
.seg { display: flex; flex-wrap: wrap; width: max-content; max-width: 100%; border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.seg button { min-height: 38px; padding: 0 14px; font: inherit; font-size: 14px; font-weight: 500; color: var(--color-ink); background: none; border: 0; border-left: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration); }
.seg button:first-child { border-left: 0; }
.seg button:hover:not(:disabled) { background: var(--color-canvas); }
.seg button:disabled { color: var(--color-muted); cursor: not-allowed; }
.seg button[aria-checked="true"] { color: #fff; background: var(--color-ink); }
.mday { max-width: 320px; }
.preview { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 12px; font-weight: 600; background: var(--color-surface); box-shadow: var(--shadow-sm); }
.preview svg { color: var(--color-primary-dark); flex: none; }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 560px) {
  .seg { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
  .seg button { border-left: 0; border-top: 1px solid var(--color-line); }
  .seg button:nth-child(-n+2) { border-top: 0; }
  .seg button:nth-child(even) { border-left: 1px solid var(--color-line); }
}
</style>
