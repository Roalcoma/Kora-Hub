<script setup lang="ts">
// Nueva corrida (elige calendario → propone su siguiente periodo, editable) o cambiar fechas y notas de un borrador.
// Crear calcula una línea por persona activa del calendario; cambiar el periodo recalcula.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CalendarClock } from 'lucide-vue-next';
import type { PayrollRunDetail } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Dropdown from '@/design/Dropdown.vue';
import Textarea from '@/design/Textarea.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ run?: PayrollRunDetail | null; calendarId?: string }>();
const emit = defineEmits<{ saved: [run: PayrollRunDetail] }>();
const { t } = useI18n();
const s = useSession();
const fin = useFinance();

const f = reactive({ calendarId: '', periodStart: '', periodEnd: '', payDate: '', notes: '' });
const busy = ref(false);
const error = ref<string | null>(null);
const active = computed(() => fin.calendars.filter((c) => !c.archivedAt));
/** Al elegir calendario se proponen las fechas de su siguiente periodo sin corrida */
function suggest(id: string) {
  const p = fin.calendar(id)?.nextPeriod;
  if (p) Object.assign(f, { periodStart: p.periodStart, periodEnd: p.periodEnd, payDate: p.payDate });
}
watch(open, (v) => {
  if (!v) return;
  const r = props.run;
  if (r) Object.assign(f, { calendarId: r.calendarId, periodStart: r.periodStart, periodEnd: r.periodEnd, payDate: r.payDate, notes: r.notes });
  else {
    Object.assign(f, { calendarId: props.calendarId ?? active.value[0]?.id ?? '', periodStart: '', periodEnd: '', payDate: '', notes: '' });
    suggest(f.calendarId);
  }
  error.value = null;
});
const pick = (id: string | undefined) => { if (!id) return; f.calendarId = id; suggest(id); };

const calendarOptions = computed(() => active.value.map((c) => ({ value: c.id, label: c.name,
  hint: `${t(`finance.payroll.freq.${c.frequency}`)} · ${t('finance.payroll.cal.nPeople', { n: c.people }, c.people)}` })));
const periodBad = computed(() => !!f.periodStart && !!f.periodEnd && f.periodEnd < f.periodStart);
const valid = computed(() => f.calendarId && f.periodStart && f.periodEnd && f.payDate && !periodBad.value);
const people = computed(() => fin.calendar(f.calendarId)?.people ?? 0);

async function save() {
  busy.value = true;
  error.value = null;
  const dates = { periodStart: f.periodStart, periodEnd: f.periodEnd, payDate: f.payDate, notes: f.notes.trim() };
  try {
    const slug = s.workspace!.slug;
    const saved = props.run
      ? await api('PATCH /w/:slug/finance/payroll/runs/:id', { params: { slug, id: props.run.id }, body: dates })
      : await api('POST /w/:slug/finance/payroll/runs', { params: { slug }, body: { ...dates, calendarId: f.calendarId } });
    toast(props.run ? t('common.saved') : t('finance.payroll.run.createdOk'), 'success');
    open.value = false;
    emit('saved', saved);
    fin.loadCalendars().catch(() => {});   // el siguiente periodo sugerido cambia
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="run ? t('finance.payroll.run.editDates') : t('finance.payroll.run.new')" :subtitle="run ? t('finance.payroll.run.editDatesHint') : t('finance.payroll.run.newHint')" width="560px">
    <form id="prun-form" class="grid gap-4" novalidate @submit.prevent="valid && save()">
      <Dropdown v-if="!run" :model-value="f.calendarId" :options="calendarOptions" :label="t('finance.payroll.people.calendar')"
        :placeholder="t('finance.payroll.people.pickCalendar')" @update:model-value="pick" />
      <fieldset class="period">
        <legend>{{ t('finance.payroll.run.period') }}</legend>
        <div class="row">
          <label class="date">{{ t('finance.payroll.run.periodStart') }}<input v-model="f.periodStart" type="date"></label>
          <label class="date" :class="{ invalid: periodBad }">{{ t('finance.payroll.run.periodEnd') }}<input v-model="f.periodEnd" type="date" :min="f.periodStart || undefined">
            <small v-if="periodBad">{{ t('finance.payroll.run.periodBad') }}</small></label>
        </div>
        <label class="date pay">{{ t('finance.payroll.run.payDate') }}<input v-model="f.payDate" type="date"></label>
        <p v-if="!run && f.calendarId" class="preview"><CalendarClock :size="16" />{{ t('finance.payroll.run.willInclude', { n: people }, people) }}</p>
      </fieldset>
      <Textarea v-model="f.notes" :label="t('finance.expenses.notes')" :rows="2" />
      <p class="note">{{ t('finance.payroll.run.effectiveNote') }}</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="prun-form" :loading="busy" :disabled="!valid">{{ run ? t('common.save') : t('finance.payroll.run.create') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.period { display: grid; gap: 12px; margin: 0; padding: 14px 16px 16px; min-width: 0; border: 0; border-left: 3px solid var(--color-primary); background: var(--color-canvas); }
.period legend { float: left; width: 100%; padding: 0; font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.date small { font-size: 12px; font-weight: 400; color: var(--color-danger); }
.date.invalid input { border-color: var(--color-danger); }
.date.pay { max-width: calc(50% - 6px); }
.preview { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 12px; font-weight: 600; background: var(--color-surface); box-shadow: var(--shadow-sm); }
.preview svg { color: var(--color-primary-dark); flex: none; }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 520px) { .row { grid-template-columns: 1fr; } .date.pay { max-width: none; } }
</style>
