<script setup lang="ts">
// Configuración de nómina, a todo el ancho bajo categorías y cuentas: personas en nómina (columna ancha, con sus
// componentes) y calendarios de pago (columna angosta). No hay borrado: una persona se desactiva y un calendario se
// archiva, porque las corridas pasadas los siguen nombrando.
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { CalendarClock, Plus, Pencil, Archive, ArchiveRestore, Users, Layers, Link2 } from 'lucide-vue-next';
import type { PayrollCalendar, PayrollPerson } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { fmtDay, today, weekdayName } from './format.ts';
import PayrollCalendarModal from './PayrollCalendarModal.vue';
import PayrollPersonModal from './PayrollPersonModal.vue';
import PayrollComponentsModal from './PayrollComponentsModal.vue';

const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const day = (x: string) => fmtDay(x, locale.value);

// ─── Calendarios ───
const calendars = computed(() => [...fin.calendars].sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.name.localeCompare(b.name)));
/** "Cada 2 semanas · paga los viernes", "Día 15 y último", "Mensual · día 5 del mes siguiente" */
function calendarRule(c: PayrollCalendar) {
  if (c.frequency === 'weekly' || c.frequency === 'biweekly') {
    const wd = c.anchorDate ? weekdayName(new Date(`${c.anchorDate}T12:00:00Z`).getUTCDay(), locale.value, 'long') : '';
    return t('finance.payroll.cal.ruleCycle', { freq: t(`finance.payroll.freq.${c.frequency}`), day: wd });
  }
  if (c.frequency === 'semimonthly') return t('finance.payroll.cal.semimonthlyRule');
  return c.payDay === 'last' || c.payDay == null ? t('finance.payroll.cal.ruleMonthlyLast') : t('finance.payroll.cal.ruleMonthlyDay', { d: c.payDay });
}
const calModal = ref(false);
const calEditing = ref<PayrollCalendar | null>(null);
const openCalendar = (c: PayrollCalendar | null) => { calEditing.value = c; calModal.value = true; };
const busy = ref<string | null>(null);
async function archive(c: PayrollCalendar) {
  busy.value = c.id;
  try {
    await api('PATCH /w/:slug/finance/payroll/calendars/:id', { params: { slug: s.workspace!.slug, id: c.id }, body: { archived: !c.archivedAt } });
    await fin.loadCalendars();
    toast(c.archivedAt ? t('finance.payroll.cal.restoredOk') : t('finance.payroll.cal.archivedOk'), 'success');
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = null; }
}

// ─── Personas ───
const people = computed(() => fin.people);
const activeCount = computed(() => fin.people.filter((p) => p.isActive).length);
/** Componentes vigentes hoy (los futuros y terminados no cuentan en el resumen de la fila) */
const currentComps = (p: PayrollPerson) => p.components.filter((c) => c.effectiveFrom <= today() && (!c.effectiveTo || c.effectiveTo >= today()));
const compSummary = (p: PayrollPerson) => {
  const kinds = [...new Set(currentComps(p).map((c) => c.kind))];
  return kinds.map((k) => t(`finance.payroll.kinds.${k}`)).join(' · ');
};
const personModal = ref(false);
const personEditing = ref<PayrollPerson | null>(null);
const openPerson = (p: PayrollPerson | null) => { personEditing.value = p; personModal.value = true; };
const compsOf = ref<PayrollPerson | null>(null);
/** Al crear una persona se abren sus componentes: sin ellos la línea de nómina saldría en cero */
async function personSaved(p: PayrollPerson, created: boolean) {
  await Promise.all([fin.loadPeople(), fin.loadCalendars()]);
  if (created) compsOf.value = p;
}
const compsSaved = () => { fin.loadPeople().catch(() => {}); };
</script>

<template>
  <section class="card">
    <header class="head">
      <div><h2><CalendarClock :size="20" />{{ t('finance.setup.payroll') }}</h2><small>{{ t('finance.setup.payrollHint') }}</small></div>
    </header>

    <div class="cols">
      <!-- Personas: la columna con más peso -->
      <div class="people">
        <div class="sub">
          <h3><Users :size="17" />{{ t('finance.payroll.people.title') }}<span v-if="people.length" class="n">{{ activeCount }}/{{ people.length }}</span></h3>
          <Button size="sm" variant="primary" :disabled="!fin.calendars.some((c) => !c.archivedAt)" @click="openPerson(null)"><Plus :size="15" />{{ t('finance.payroll.people.new') }}</Button>
        </div>
        <EmptyState v-if="!people.length" :icon="Users" :title="t('finance.payroll.people.empty')"
          :text="fin.calendars.length ? t('finance.payroll.people.emptyText') : t('finance.payroll.people.emptyNoCalendar')" />
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{{ t('finance.payroll.people.name') }}</th><th scope="col">{{ t('finance.payroll.people.calendar') }}</th>
                <th scope="col">{{ t('finance.payroll.people.method') }}</th><th scope="col">{{ t('finance.payroll.people.userShort') }}</th>
                <th scope="col">{{ t('finance.payroll.people.components') }}</th><th scope="col"><span class="sr-only">{{ t('finance.expenses.actions') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in people" :key="p.id" :class="{ off: !p.isActive }">
                <td class="who"><b>{{ p.name }}</b><small v-if="p.jobTitle || p.email">{{ [p.jobTitle, p.email].filter(Boolean).join(' · ') }}</small>
                  <Badge v-if="!p.isActive" class="st">{{ t('finance.payroll.people.inactive') }}</Badge></td>
                <td :data-label="t('finance.payroll.people.calendar')">{{ fin.calendar(p.calendarId)?.name ?? '—' }}</td>
                <td :data-label="t('finance.payroll.people.method')" class="nowrap">{{ t(`finance.methods.${p.payMethod}`) }}<small v-if="p.accountLast4">•••• {{ p.accountLast4 }}</small></td>
                <td :data-label="t('finance.payroll.people.userShort')">
                  <span v-if="p.userId" class="linked"><Link2 :size="13" />{{ fin.memberName(p.userId) }}</span>
                  <span v-else class="muted">{{ t('finance.payroll.people.noUserShort') }}</span>
                </td>
                <td :data-label="t('finance.payroll.people.components')" class="comps">
                  <button type="button" class="clink" @click="compsOf = p">
                    <Layers :size="14" />{{ currentComps(p).length ? compSummary(p) : t('finance.payroll.people.noComponents') }}
                  </button>
                </td>
                <td class="row-acts">
                  <button type="button" class="ico" :title="t('finance.payroll.people.edit')" :aria-label="t('finance.payroll.people.edit')" @click="openPerson(p)"><Pencil :size="16" /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Calendarios: columna angosta a la derecha -->
      <aside class="cals">
        <div class="sub">
          <h3><CalendarClock :size="17" />{{ t('finance.payroll.cal.title') }}</h3>
          <Button size="sm" @click="openCalendar(null)"><Plus :size="15" />{{ t('finance.payroll.cal.new') }}</Button>
        </div>
        <EmptyState v-if="!calendars.length" :title="t('finance.payroll.cal.empty')" :text="t('finance.payroll.cal.emptyText')">
          <Button variant="primary" @click="openCalendar(null)"><Plus :size="16" />{{ t('finance.payroll.cal.new') }}</Button>
        </EmptyState>
        <ul v-else class="clist">
          <li v-for="c in calendars" :key="c.id" :class="{ off: c.archivedAt }">
            <div class="main">
              <b>{{ c.name }}</b>
              <small>{{ calendarRule(c) }}</small>
              <span class="tags">
                <Badge v-if="c.archivedAt">{{ t('settings.archived') }}</Badge>
                <Badge v-else tone="neutral">{{ t('finance.payroll.cal.nPeople', { n: c.people }, c.people) }}</Badge>
                <span v-if="c.nextPeriod" class="next">{{ t('finance.payroll.cal.next', { from: day(c.nextPeriod.periodStart), to: day(c.nextPeriod.periodEnd), pay: day(c.nextPeriod.payDate) }) }}</span>
              </span>
            </div>
            <div class="acts">
              <button type="button" class="ico" :title="t('finance.payroll.cal.edit')" :aria-label="t('finance.payroll.cal.edit')" @click="openCalendar(c)"><Pencil :size="16" /></button>
              <button type="button" class="ico" :disabled="busy === c.id" :title="c.archivedAt ? t('finance.setup.restore') : t('settings.archive')"
                :aria-label="c.archivedAt ? t('finance.setup.restore') : t('settings.archive')" @click="archive(c)">
                <ArchiveRestore v-if="c.archivedAt" :size="16" /><Archive v-else :size="16" />
              </button>
            </div>
          </li>
        </ul>
        <p class="hint">{{ t('finance.payroll.cal.archiveHint') }}</p>
      </aside>
    </div>

    <PayrollCalendarModal v-model="calModal" :calendar="calEditing" @saved="fin.loadCalendars()" />
    <PayrollPersonModal v-model="personModal" :person="personEditing" @saved="personSaved" />
    <PayrollComponentsModal :person="compsOf" @close="compsOf = null" @saved="compsSaved" />
  </section>
</template>

<style scoped>
.card { display: grid; gap: 16px; align-content: start; padding: 18px 20px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); border-left: 4px solid var(--color-ink); }
.head { display: grid; gap: 2px; }
.head > div { display: grid; gap: 2px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.head small { color: var(--color-muted); }
.card :deep(.empty) { max-width: none; box-shadow: none; background: var(--color-canvas); }

.cols { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 24px; align-items: start; }
.sub { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 16px; }
.n { padding: 0 6px; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; background: var(--color-canvas); border: 1px solid var(--color-line); }

.table-wrap { overflow-x: auto; border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 9px 12px; font-size: 12px; font-weight: 600; text-align: left; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); border-bottom: 1px solid var(--color-line); white-space: nowrap; }
td { padding: 9px 12px; vertical-align: top; border-bottom: 1px solid var(--color-line); }
tbody tr:last-child td { border-bottom: 0; }
td small { display: block; margin-top: 2px; font-size: 12px; color: var(--color-muted); }
tr:hover td { background: var(--color-canvas); }
tr.off td { color: var(--color-muted); }
.who b { overflow-wrap: anywhere; }
.st { margin-top: 4px; }
.nowrap { white-space: nowrap; }
.linked { display: inline-flex; align-items: center; gap: 5px; font-weight: 500; }
.linked svg { color: var(--color-primary-dark); flex: none; }
.muted { color: var(--color-muted); }
.clink { display: inline-flex; align-items: flex-start; gap: 6px; padding: 0; font: inherit; font-size: 13px; text-align: left; color: var(--color-leaf); font-weight: 600; background: none; border: 0; cursor: pointer; }
.clink svg { flex: none; margin-top: 2px; }
.clink:hover { text-decoration: underline; }
.row-acts { text-align: right; white-space: nowrap; }
.ico { display: inline-grid; place-items: center; width: 34px; height: 34px; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }

.cals { min-width: 0; }
.clist { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.clist li { display: flex; align-items: flex-start; gap: 8px; padding: 12px 6px 12px 14px; border-top: 1px solid var(--color-line); border-left: 3px solid var(--color-primary); transition: background var(--duration); }
.clist li:first-child { border-top: 0; }
.clist li:hover { background: var(--color-canvas); }
.clist li.off { border-left-color: var(--color-line-strong); }
.clist li.off b, .clist li.off small { color: var(--color-muted); }
.main { flex: 1; min-width: 0; display: grid; gap: 2px; }
.main b { font-size: 15px; }
.main small { font-size: 13px; color: var(--color-muted); }
.tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 4px; }
.next { font-size: 12px; color: var(--color-muted); }
.acts { display: flex; flex: none; }
.hint { margin: 8px 0 0; font-size: 13px; color: var(--color-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } .cals { order: -1; } }
@media (max-width: 767px) {
  .card { padding: 16px; }
  /* Tabla como fichas: sin scroll horizontal a 390 px */
  .table-wrap { overflow: visible; }
  table, tbody, tr, td { display: block; }
  thead { display: none; }
  tbody tr { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; padding: 12px 14px; border-bottom: 1px solid var(--color-line); position: relative; }
  tbody tr:last-child { border-bottom: 0; }
  tbody td { padding: 0; border: 0; }
  tr:hover td { background: none; }
  td.who { grid-column: 1 / -1; padding-right: 40px; }
  td.comps { grid-column: 1 / -1; }
  td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 2px; font-size: 11px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
  .row-acts { position: absolute; top: 6px; right: 6px; }
}
</style>
