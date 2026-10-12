<script setup lang="ts">
// Nómina: corridas por calendario (borrador → aprobada → pagada) con filtros por fecha de pago, calendario y estado,
// totales del filtro y, a la derecha, el siguiente periodo de cada calendario para prepararlo con un clic.
// El detalle de una corrida (PayrollRunView) se abre dentro de la pestaña; queda en ?run= para recargar o compartir.
// Personas y calendarios se configuran en SetupPayroll.vue.
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Plus, Users, CalendarClock, ChevronRight, Settings } from 'lucide-vue-next';
import { RUN_STATUS, type PayrollRun, type PayrollRunDetail } from '@agencia-hub/contracts';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import Pagination from '@/design/Pagination.vue';
import Skeleton from '@/design/Skeleton.vue';
import { usePaged } from '@/design/paged.ts';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import DateFilter from '@/sales/DateFilter.vue';
import { useFinance } from './store.ts';
import { usd, fmtDay, financeRange, FINANCE_PERIODS, type DateFilterValue } from './format.ts';
import PayrollRunView from './PayrollRunView.vue';
import PayrollRunModal from './PayrollRunModal.vue';

const emit = defineEmits<{ go: [tab: 'summary' | 'expenses' | 'payroll' | 'bank' | 'setup'] }>();
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const fin = useFinance();
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);

// ─── Detalle abierto (?run=) ───
const runId = computed(() => (typeof route.query.run === 'string' ? route.query.run : null));
const openRun = (id: string | null) => router.replace({ query: id ? { ...route.query, run: id } : { ...route.query, run: undefined } });

// ─── Filtros (fecha de pago) ───
const date = ref<DateFilterValue>({ period: 'all', from: '', to: '' });
const f = reactive({ calendar: '', status: '' as '' | PayrollRun['status'] });
const periodOptions = computed(() => FINANCE_PERIODS.map((v) => ({ value: v, label: t(`finance.periods.${v}`) })));
const calendarOptions = computed(() => [{ value: '', label: t('finance.payroll.allCalendars') }, ...fin.calendars.map((c) => ({ value: c.id, label: c.name }))]);
const statusOptions = computed(() => [{ value: '' as const, label: t('finance.expenses.allStatuses') },
  ...RUN_STATUS.map((v) => ({ value: v, label: t(`finance.payroll.status.${v}`) }))]);
const query = computed(() => ({ ...financeRange(date.value), calendarId: f.calendar || undefined, status: f.status || undefined }));

const runs = ref<PayrollRun[] | null>(null);
async function load() {
  try { runs.value = await api('GET /w/:slug/finance/payroll/runs', { params: { slug: s.workspace!.slug }, query: query.value }); }
  catch (e) { runs.value = []; toast(errorText(e), 'error'); }
}
watch(query, () => { runs.value = null; load(); }, { immediate: true });

const rows = computed(() => runs.value ?? []);
const { page, size, rows: pageRows, total } = usePaged(rows);
const pagerLabels = computed(() => ({ prev: t('common.pager.prev'), next: t('common.pager.next'), perPage: t('common.pager.perPage'), of: t('common.pager.of') }));
const sum = (k: 'net' | 'paid' | 'gross') => Math.round(rows.value.reduce((n, r) => n + r.totals[k], 0) * 100) / 100;
const drafts = computed(() => rows.value.filter((r) => r.status === 'draft').length);
const statusTone = (st: string) => (st === 'paid' ? 'success' : st === 'approved' ? 'primary' : 'neutral');

/** Siguiente periodo de cada calendario vigente: el atajo para preparar la próxima corrida */
const upcoming = computed(() => fin.calendars.filter((c) => !c.archivedAt && c.nextPeriod).sort((a, b) => a.nextPeriod!.payDate.localeCompare(b.nextPeriod!.payDate)));
const ready = computed(() => fin.calendars.some((c) => !c.archivedAt) && fin.people.some((p) => p.isActive));

// ─── Nueva corrida ───
const modal = ref(false);
const preset = ref<string | undefined>();
const newRun = (calendarId?: string) => { preset.value = calendarId; modal.value = true; };
const created = (r: PayrollRunDetail) => { load(); openRun(r.id); };
</script>

<template>
  <div class="body">
    <PayrollRunView v-if="runId" :run-id="runId" @back="openRun(null)" @changed="load(); fin.loadCalendars().catch(() => {})" />

    <template v-else>
      <div class="bar">
        <div class="filters">
          <DateFilter v-model="date" :presets="periodOptions" :label="t('finance.payroll.run.payDate')" />
          <Dropdown v-model="f.calendar" :options="calendarOptions" :aria-label="t('finance.payroll.people.calendar')" />
          <Dropdown v-model="f.status" :options="statusOptions" :aria-label="t('finance.expenses.status')" />
        </div>
        <Button variant="primary" :disabled="!fin.calendars.some((c) => !c.archivedAt)" @click="newRun()"><Plus :size="17" />{{ t('finance.payroll.run.new') }}</Button>
      </div>

      <div class="totals">
        <div class="tot main"><small>{{ t('finance.payroll.totalNet') }}</small><b>{{ money(sum('net')) }}</b>
          <span>{{ t('finance.payroll.nRuns', { n: rows.length }, rows.length) }}</span></div>
        <div class="tot"><small>{{ t('finance.payroll.run.gross') }}</small><b>{{ money(sum('gross')) }}</b></div>
        <div class="tot ok"><small>{{ t('finance.expenses.paid') }}</small><b>{{ money(sum('paid')) }}</b></div>
        <div class="tot"><small>{{ t('finance.payroll.drafts') }}</small><b>{{ drafts }}</b></div>
      </div>

      <div class="cols">
        <div class="list">
          <div v-if="!runs" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="52px" /></div>
          <EmptyState v-else-if="!ready" :icon="Users" :title="t('finance.payroll.setupFirst')" :text="t('finance.payroll.setupFirstText')">
            <Button variant="primary" @click="emit('go', 'setup')"><Settings :size="16" />{{ t('finance.payroll.goSetup') }}</Button>
          </EmptyState>
          <EmptyState v-else-if="!rows.length" :icon="Users" :title="t('finance.payroll.empty')" :text="t('finance.payroll.emptyText')">
            <Button variant="primary" @click="newRun()"><Plus :size="16" />{{ t('finance.payroll.run.new') }}</Button>
          </EmptyState>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{{ t('finance.payroll.run.payDate') }}</th><th scope="col">{{ t('finance.payroll.run.period') }}</th>
                  <th scope="col" class="num">{{ t('finance.payroll.peopleCol') }}</th><th scope="col" class="num">{{ t('finance.payroll.run.gross') }}</th>
                  <th scope="col" class="num">{{ t('finance.payroll.run.net') }}</th><th scope="col">{{ t('finance.expenses.status') }}</th><th scope="col"><span class="sr-only">{{ t('finance.expenses.actions') }}</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in pageRows" :key="r.id" @click="openRun(r.id)">
                  <td class="nowrap pay"><b>{{ day(r.payDate) }}</b><small>{{ fin.calendar(r.calendarId)?.name ?? '—' }}</small></td>
                  <td class="nowrap" :data-label="t('finance.payroll.run.period')">{{ day(r.periodStart) }} – {{ day(r.periodEnd) }}</td>
                  <td class="num" :data-label="t('finance.payroll.peopleCol')">{{ r.totals.people }}</td>
                  <td class="num" :data-label="t('finance.payroll.run.gross')">{{ money(r.totals.gross) }}</td>
                  <td class="num" :data-label="t('finance.payroll.run.net')"><b :class="{ neg: r.totals.net < 0 }">{{ money(r.totals.net) }}</b>
                    <small v-if="r.status === 'approved' && r.totals.paid">{{ t('finance.payroll.paidSoFar', { amount: money(r.totals.paid) }) }}</small></td>
                  <td :data-label="t('finance.expenses.status')"><Badge :tone="statusTone(r.status)">{{ t(`finance.payroll.status.${r.status}`) }}</Badge></td>
                  <td class="go"><button type="button" class="ico" :aria-label="t('finance.payroll.openRun')" @click.stop="openRun(r.id)"><ChevronRight :size="18" /></button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <Pagination v-if="runs && rows.length" v-model="page" v-model:size="size" :total="total" :labels="pagerLabels" />
        </div>

        <aside class="next">
          <h3><CalendarClock :size="17" />{{ t('finance.payroll.upcoming') }}</h3>
          <p v-if="!upcoming.length" class="muted">{{ t('finance.payroll.upcomingEmpty') }}</p>
          <ul v-else>
            <li v-for="c in upcoming" :key="c.id">
              <div><b>{{ c.name }}</b>
                <small>{{ day(c.nextPeriod!.periodStart) }} – {{ day(c.nextPeriod!.periodEnd) }}</small>
                <small>{{ t('finance.payroll.paysOn', { date: day(c.nextPeriod!.payDate) }) }} · {{ t('finance.payroll.cal.nPeople', { n: c.people }, c.people) }}</small></div>
              <Button size="sm" @click="newRun(c.id)">{{ t('finance.payroll.prepare') }}</Button>
            </li>
          </ul>
        </aside>
      </div>
    </template>

    <PayrollRunModal v-model="modal" :calendar-id="preset" @saved="created" />
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; flex: 1; min-width: 0; }
.filters :deep(.dd) { flex: 0 1 220px; min-width: 0; }
.filters :deep(.trigger) { min-width: 0; }

.totals { display: grid; grid-template-columns: 1.6fr 1fr 1fr .8fr; gap: 14px; }
.tot { display: grid; gap: 2px; align-content: start; padding: 14px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.tot.main { border-left: 4px solid var(--color-primary); }
.tot.ok b { color: var(--color-success); }
.tot small, .tot span { font-size: 13px; color: var(--color-muted); }
.tot b { font-family: var(--font-display); font-size: 26px; font-variant-numeric: tabular-nums; }
.tot.main b { font-size: 32px; }

.cols { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
.list { display: grid; gap: 14px; min-width: 0; }
.list :deep(.empty) { max-width: none; }
.table-wrap { overflow-x: auto; background: var(--color-surface); box-shadow: var(--shadow-md); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 10px 14px; font-size: 12px; font-weight: 600; text-align: left; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); border-bottom: 1px solid var(--color-line); white-space: nowrap; }
td { padding: 10px 14px; vertical-align: top; border-bottom: 1px solid var(--color-line); }
td small { display: block; margin-top: 2px; font-size: 12px; color: var(--color-muted); }
tbody tr { cursor: pointer; }
tbody tr:hover td { background: var(--color-canvas); }
tbody tr:hover td:first-child { box-shadow: inset 3px 0 0 var(--color-primary); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.neg { color: var(--color-danger); }
.nowrap { white-space: nowrap; }
.go { width: 44px; text-align: right; }
.ico { display: inline-grid; place-items: center; width: 32px; height: 32px; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }

.next { display: grid; gap: 12px; padding: 16px 18px; background: var(--color-surface); border-top: 4px solid var(--color-ink); box-shadow: var(--shadow-md); }
.next h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 16px; }
.next ul { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.next li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0 10px 10px; border-top: 1px solid var(--color-line); border-left: 3px solid var(--color-primary); }
.next li:first-child { border-top: 0; }
.next li > div { display: grid; gap: 1px; min-width: 0; }
.next li b { font-size: 14px; }
.next li small { font-size: 12px; color: var(--color-muted); }
.muted { margin: 0; font-size: 13px; color: var(--color-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

@media (max-width: 1279px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .next ul { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px 16px; }
  .next li { border-top: 0; }
}
@media (max-width: 767px) {
  .body { padding: 14px 16px 32px; }
  .filters :deep(.dd) { flex: 1 1 calc(50% - 6px); }
  .bar > :deep(.btn) { width: 100%; justify-content: center; }
  .totals { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .tot { padding: 12px; }
  .tot.main { grid-column: 1 / -1; }
  .tot b { font-size: 18px; }
  .tot.main b { font-size: 28px; }
  .totals .tot:last-child { display: none; }   /* borradores: el filtro de estado ya lo cuenta */
  /* Tabla como fichas: sin scroll horizontal a 390 px */
  .table-wrap { overflow: visible; }
  table, tbody, tr, td { display: block; }
  thead { display: none; }
  tbody tr { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; padding: 12px 14px; border-bottom: 1px solid var(--color-line); }
  tbody td { padding: 0; border: 0; }
  tbody tr:hover td { background: none; box-shadow: none !important; }
  td.pay { grid-column: 1 / -1; padding-right: 36px; }
  td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 2px; font-size: 11px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
  .num { text-align: left; }
  .go { position: absolute; top: 8px; right: 8px; width: auto; }
}
</style>
