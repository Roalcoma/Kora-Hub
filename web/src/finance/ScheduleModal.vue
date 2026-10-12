<script setup lang="ts">
// Plantilla de gasto recurrente: diaria (cada N días, solo hábiles), semanal (cada N semanas, días de la semana) o
// mensual (cada N meses, día del mes o último). El job genera las ocurrencias hasta 35 días adelante; cambiar el monto
// aplica desde la próxima pendiente. Si la guarda un Contable, queda por aprobar y no genera nada hasta entonces.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { TriangleAlert, Repeat } from 'lucide-vue-next';
import { EXPENSE_PAY_METHODS, SCHEDULE_FREQUENCIES, type ExpensePayMethod, type ExpenseSchedule, type ScheduleFrequency } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toneColor } from '@/design/types.ts';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { today, cents, scheduleRule, weekdayName, WEEK_ORDER } from './format.ts';
import VendorInput from './VendorInput.vue';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ schedule?: ExpenseSchedule | null }>();
const emit = defineEmits<{ saved: [schedule: ExpenseSchedule] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();

const f = reactive({
  vendor: '', concept: '', categoryId: '', amount: '', payMethod: 'card' as ExpensePayMethod,
  frequency: 'monthly' as ScheduleFrequency, interval: '1', weekdays: [] as number[], monthDay: '1', businessDaysOnly: false,
  startsOn: '', endsOn: '',
});
const busy = ref(false);
const error = ref<string | null>(null);
watch(open, (v) => {
  if (!v) return;
  const x = props.schedule;
  const now = today();
  Object.assign(f, {
    vendor: x?.vendor ?? '', concept: x?.concept ?? '', categoryId: x?.categoryId ?? fin.activeCategories[0]?.id ?? '',
    amount: x ? String(x.amount) : '', payMethod: x?.payMethod ?? 'card', frequency: x?.frequency ?? 'monthly',
    interval: String(x?.interval ?? 1), weekdays: x?.weekdays ?? [new Date(`${now}T12:00:00Z`).getUTCDay()],
    monthDay: String(x?.monthDay ?? Number(now.slice(8, 10))), businessDaysOnly: x?.businessDaysOnly ?? false,
    startsOn: x?.startsOn ?? now, endsOn: x?.endsOn ?? '',
  });
  error.value = null;
});

const categoryOptions = computed(() => fin.categories.filter((c) => !c.archivedAt || c.id === props.schedule?.categoryId)
  .map((c) => ({ value: c.id, label: c.name, swatch: toneColor(c.color) })));
const methodOptions = computed(() => EXPENSE_PAY_METHODS.map((m) => ({ value: m, label: t(`finance.methods.${m}`) })));
const dayOptions = computed(() => [
  ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: t('finance.schedules.dayN', { d: i + 1 }), hint: i + 1 > 28 ? t('finance.schedules.shortMonths') : undefined })),
  { value: 'last', label: t('finance.schedules.lastDay') },
]);
const toggleDay = (d: number) => {
  f.weekdays = f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d].sort();
};

/** La regla tal como la verá el backend: cada frecuencia manda solo sus campos */
const rule = computed(() => ({
  frequency: f.frequency, interval: Math.max(1, Math.trunc(Number(f.interval) || 1)),
  weekdays: f.frequency === 'weekly' ? f.weekdays : null,
  monthDay: f.frequency === 'monthly' ? (f.monthDay === 'last' ? 'last' as const : Number(f.monthDay)) : null,
  businessDaysOnly: f.frequency === 'daily' && f.businessDaysOnly,
}));
const intervalOk = computed(() => Number.isInteger(Number(f.interval)) && Number(f.interval) >= 1 && Number(f.interval) <= 365);
const endsBad = computed(() => !!f.endsOn && !!f.startsOn && f.endsOn < f.startsOn);
const valid = computed(() => f.categoryId && f.vendor.trim() && Number(f.amount) > 0 && intervalOk.value && f.startsOn && !endsBad.value
  && (f.frequency !== 'weekly' || f.weekdays.length > 0));
const willNeedApproval = computed(() => fin.isAccountant
  && (!props.schedule || (props.schedule.approvalStatus === 'approved' && Number(f.amount) !== props.schedule.amount)));

async function save() {
  busy.value = true;
  error.value = null;
  const body = {
    categoryId: f.categoryId, vendor: f.vendor.trim(), concept: f.concept.trim(), amount: cents(f.amount), payMethod: f.payMethod,
    ...rule.value, startsOn: f.startsOn, endsOn: f.endsOn || null,
  };
  try {
    const params = { slug: s.workspace!.slug };
    const saved = props.schedule
      ? await api('PATCH /w/:slug/finance/expense-schedules/:id', { params: { ...params, id: props.schedule.id }, body })
      : await api('POST /w/:slug/finance/expense-schedules', { params, body });
    toast(saved.approvalStatus === 'pending' ? t('finance.schedules.savedPending') : t('common.saved'), 'success');
    open.value = false;
    emit('saved', saved);
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="schedule ? t('finance.schedules.edit') : t('finance.schedules.new')" :subtitle="t('finance.schedules.newHint')" width="620px">
    <form id="schedule-form" class="grid gap-4" novalidate @submit.prevent="valid && save()">
      <div class="row wide">
        <VendorInput v-model="f.vendor" :label="t('finance.expenses.vendor')" :placeholder="t('finance.expenses.vendorPh')" />
        <Input v-model="f.amount" type="number" prefix="$" :label="t('finance.expenses.estimated')" />
      </div>
      <Input v-model="f.concept" :label="t('finance.expenses.concept')" :placeholder="t('finance.schedules.conceptPh')" />
      <div class="row">
        <Dropdown v-model="f.categoryId" :options="categoryOptions" :label="t('finance.expenses.category')" :placeholder="t('finance.expenses.pickCategory')" />
        <Dropdown v-model="f.payMethod" :options="methodOptions" :label="t('finance.expenses.method')" />
      </div>

      <!-- Regla de repetición: bloque con acento, la frecuencia manda qué opciones aparecen -->
      <fieldset class="rule">
        <legend>{{ t('finance.schedules.repeat') }}</legend>
        <div class="seg" role="radiogroup" :aria-label="t('finance.schedules.frequency')">
          <button v-for="fr in SCHEDULE_FREQUENCIES" :key="fr" type="button" role="radio" :aria-checked="f.frequency === fr" @click="f.frequency = fr">
            {{ t(`finance.schedules.freq.${fr}`) }}
          </button>
        </div>
        <div class="opts">
          <Input v-model="f.interval" type="number" class="every" :prefix="t('finance.schedules.everyPrefix')" :label="t(`finance.schedules.intervalLabel.${f.frequency}`)"
            :error="intervalOk ? null : t('finance.schedules.intervalBad')" />
          <div v-if="f.frequency === 'weekly'" class="days">
            <span class="lbl">{{ t('finance.schedules.weekdays') }}</span>
            <div class="chips" role="group" :aria-label="t('finance.schedules.weekdays')">
              <button v-for="d in WEEK_ORDER" :key="d" type="button" class="chip" :aria-pressed="f.weekdays.includes(d)" :title="weekdayName(d, locale, 'long')" @click="toggleDay(d)">
                {{ weekdayName(d, locale) }}
              </button>
            </div>
            <small v-if="!f.weekdays.length" class="bad">{{ t('finance.schedules.pickWeekday') }}</small>
          </div>
          <Dropdown v-else-if="f.frequency === 'monthly'" v-model="f.monthDay" class="mday" :options="dayOptions" :label="t('finance.schedules.monthDay')" />
          <label v-else class="check biz"><input v-model="f.businessDaysOnly" type="checkbox">{{ t('finance.schedules.businessDaysOnly') }}</label>
        </div>
        <div class="row">
          <label class="date">{{ t('finance.schedules.startsOn') }}<input v-model="f.startsOn" type="date"></label>
          <label class="date" :class="{ invalid: endsBad }">{{ t('finance.schedules.endsOn') }}<input v-model="f.endsOn" type="date" :min="f.startsOn || undefined">
            <small>{{ endsBad ? t('finance.schedules.endsBad') : t('finance.schedules.endsHint') }}</small></label>
        </div>
        <p class="preview"><Repeat :size="16" />{{ scheduleRule(rule, t, locale) }}</p>
      </fieldset>

      <p v-if="schedule" class="note">{{ t('finance.schedules.editNote') }}</p>
      <p v-if="willNeedApproval" class="warn"><TriangleAlert :size="16" />{{ schedule ? t('finance.approval.willNeedEdit') : t('finance.approval.willNeedSchedule') }}</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="schedule-form" :loading="busy" :disabled="!valid">{{ t('common.save') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.row.wide { grid-template-columns: 1.5fr 1fr; }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.date small { font-size: 12px; font-weight: 400; color: var(--color-muted); }
.date.invalid input { border-color: var(--color-danger); }
.date.invalid small { color: var(--color-danger); }

.rule { display: grid; gap: 14px; margin: 0; padding: 14px 16px 16px; min-width: 0; border: 0; border-left: 3px solid var(--color-primary); background: var(--color-canvas); }
.rule legend { float: left; width: 100%; padding: 0; font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
.seg { display: flex; width: max-content; max-width: 100%; border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.seg button { min-height: 38px; padding: 0 16px; font: inherit; font-size: 14px; font-weight: 500; color: var(--color-ink); background: none; border: 0; border-left: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration); }
.seg button:first-child { border-left: 0; }
.seg button:hover { background: var(--color-canvas); }
.seg button[aria-checked="true"] { color: #fff; background: var(--color-ink); }
.opts { display: grid; grid-template-columns: minmax(130px, 150px) minmax(0, 1fr); gap: 12px 16px; align-items: start; }
.lbl { font-size: 13px; font-weight: 500; }
.days { display: grid; gap: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { min-width: 42px; min-height: 40px; padding: 0 6px; font: inherit; font-size: 13px; font-weight: 600; text-transform: capitalize; color: var(--color-ink); cursor: pointer;
  background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: background var(--duration), border-color var(--duration), box-shadow var(--duration); }
.chip:hover { border-color: var(--color-ink); box-shadow: var(--shadow-md); }
.chip[aria-pressed="true"] { color: var(--color-ink); background: var(--color-primary); border-color: var(--color-primary); }
.bad { font-size: 12px; color: var(--color-danger); }
.mday { max-width: 260px; }
.check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; cursor: pointer; }
.biz { margin-top: 31px; }
.preview { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 12px; font-weight: 600; background: var(--color-surface); box-shadow: var(--shadow-sm); }
.preview svg { color: var(--color-primary-dark); flex: none; }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.warn { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; font-size: 13px; line-height: 1.45; color: var(--color-ink); background: var(--color-warning-light); border-left: 3px solid var(--color-warning); }
.warn svg { flex: none; margin-top: 1px; color: var(--color-warning); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 560px) {
  .row, .row.wide, .opts { grid-template-columns: 1fr; }
  .biz { margin-top: 0; }
  .seg { width: 100%; }
  .seg button { flex: 1; padding: 0 8px; }
}
</style>
