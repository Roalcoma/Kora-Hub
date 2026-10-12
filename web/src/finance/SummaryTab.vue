<script setup lang="ts">
// Resumen de Finanzas (docs/plan-finanzas.md §5): flujo de caja del periodo según lo cargado (entradas del banco −
// gastos pagados − nómina pagada), gastos por categoría con la "Nómina" virtual, entradas por compañía, comisiones de
// ventas esperadas vs. pagadas, próximos pagos (15 días), vencidos, por aprobar y barras de los últimos 6 meses.
// Cada tarjeta lleva a su pestaña con `go`. Sin dependencias de gráficos: las barras son divs.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowRight, ArrowDownLeft, Landmark, Receipt, Users, AlertTriangle, ShieldAlert, CalendarClock, LayoutDashboard, Plus } from 'lucide-vue-next';
import type { FinanceSummary } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toneColor } from '@/design/types.ts';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import DateFilter from '@/sales/DateFilter.vue';
import { useFinance } from './store.ts';
import { usd, fmtDay, financeRange, FINANCE_PERIODS, type DateFilterValue } from './format.ts';

type Tab = 'summary' | 'expenses' | 'payroll' | 'bank' | 'setup';
const emit = defineEmits<{ go: [tab: Tab] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);
const go = (tab: Tab) => emit('go', tab);

// ─── Periodo (mismo filtro que las demás pestañas; por defecto este mes) ───
const date = ref<DateFilterValue>({ period: 'month', from: '', to: '' });
const periodOptions = computed(() => FINANCE_PERIODS.filter((v) => v !== 'next30').map((v) => ({ value: v, label: t(`finance.periods.${v}`) })));
const data = ref<FinanceSummary | null>(null);
async function load() {
  data.value = null;
  try { data.value = await api('GET /w/:slug/finance/summary', { params: { slug: s.workspace!.slug }, query: financeRange(date.value) }); }
  catch (e) { toast(errorText(e), 'error'); }
}
watch(date, load, { immediate: true });

const resultTone = computed(() => ((data.value?.result ?? 0) < 0 ? 'neg' : 'pos'));
/** Nada cargado en el periodo ni pendiente: se invita a cargar en vez de mostrar ceros */
const empty = computed(() => {
  const d = data.value;
  return !!d && !d.bank.inflow && !d.bank.outflow && !d.expenses.paid && !d.payroll.paid && !d.upcoming.length
    && !d.overdue.count && !d.pendingApprovals && d.monthly.every((m) => !m.inflow && !m.spent);
});

/** Gastos por categoría + la Nómina virtual, de mayor a menor */
const byCategory = computed(() => {
  const d = data.value;
  if (!d) return [];
  const list = d.expenses.byCategory.map((c) => {
    const cat = fin.category(c.categoryId);
    return { key: c.categoryId, name: cat?.name ?? '—', color: toneColor(cat?.color ?? 'gray'), amount: c.amount, count: c.count, tab: 'expenses' as Tab };
  });
  if (d.payroll.paid) list.push({ key: 'payroll', name: t('finance.summary.payrollCategory'), color: 'var(--color-ink)', amount: d.payroll.paid, count: d.payroll.lines, tab: 'payroll' });
  list.sort((a, b) => b.amount - a.amount);
  const total = list.reduce((t, x) => t + x.amount, 0) || 1;
  const max = Math.max(1, ...list.map((x) => x.amount));
  return list.map((x) => ({ ...x, width: `${(x.amount / max) * 100}%`, pct: Math.round((x.amount / total) * 100) }));
});

const carriers = computed(() => {
  const list = data.value?.bank.inflowByCarrier ?? [];
  const max = Math.max(1, ...list.map((x) => x.amount));
  return list.map((x) => ({ ...x, name: x.carrierId ? fin.carrierName(x.carrierId) : t('finance.summary.noCarrier'), width: `${(x.amount / max) * 100}%` }));
});
const commissionPct = computed(() => {
  const c = data.value?.commissions;
  return c && c.expected > 0 ? Math.min(100, Math.round((c.paid / c.expected) * 100)) : 0;
});

// ─── Serie mensual: dos barras por mes (entradas, gastos + nómina) ───
const monthly = computed(() => {
  const list = data.value?.monthly ?? [];
  const max = Math.max(1, ...list.flatMap((m) => [m.inflow, m.spent]));
  return list.map((m) => ({
    ...m,
    label: new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString(locale.value, { month: 'short', timeZone: 'UTC' }),
    inH: `${(m.inflow / max) * 100}%`, outH: `${(m.spent / max) * 100}%`, net: m.inflow - m.spent,
  }));
});

/** Días hasta la fecha ("hoy", "en 3 días", "hace 2 días") */
function when(d: string) {
  const diff = Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${data.value!.today}T12:00:00Z`)) / 86_400_000);
  if (diff === 0) return t('finance.summary.today');
  return diff > 0 ? t('finance.summary.inDays', { n: diff }, diff) : t('finance.summary.daysAgo', { n: -diff }, -diff);
}
/** Periodo de una corrida sin año ("1 oct – 15 oct"): la fecha de pago ya lo dice */
const periodOf = (detail: string) => detail.split('|')
  .map((d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(locale.value, { day: 'numeric', month: 'short', timeZone: 'UTC' })).join(' – ');
</script>

<template>
  <div class="body">
    <div class="bar">
      <div class="filters">
        <DateFilter v-model="date" :presets="periodOptions" :label="t('finance.summary.period')" />
      </div>
      <p class="hint">{{ t('finance.summary.cashNote') }}</p>
    </div>

    <div v-if="!data" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="72px" /></div>

    <template v-else>
      <!-- Totales asimétricos: el resultado pesa más; cada tarjeta lleva a su pestaña -->
      <div class="totals">
        <div class="tot main" :class="resultTone">
          <small>{{ t('finance.summary.result') }}</small>
          <b>{{ money(data.result) }}</b>
          <span>{{ t('finance.summary.formula') }}</span>
        </div>
        <button type="button" class="tot link in" @click="go('bank')">
          <small><ArrowDownLeft :size="15" />{{ t('finance.summary.inflow') }}</small>
          <b>{{ money(data.bank.inflow) }}</b>
          <span>{{ t('finance.summary.outflow', { amount: money(data.bank.outflow) }) }}</span>
        </button>
        <button type="button" class="tot link" @click="go('expenses')">
          <small><Receipt :size="15" />{{ t('finance.summary.expensesPaid') }}</small>
          <b>{{ money(data.expenses.paid) }}</b>
          <span>{{ t('finance.summary.nExpenses', { n: data.expenses.count }, data.expenses.count) }}</span>
        </button>
        <button type="button" class="tot link" @click="go('payroll')">
          <small><Users :size="15" />{{ t('finance.summary.payrollPaid') }}</small>
          <b>{{ money(data.payroll.paid) }}</b>
          <span>{{ t('finance.summary.nLines', { n: data.payroll.lines }, data.payroll.lines) }}</span>
        </button>
      </div>

      <!-- Avisos: vencidos y por aprobar (no dependen del periodo) -->
      <div v-if="data.overdue.count || data.pendingApprovals" class="alerts">
        <button v-if="data.overdue.count" type="button" class="alert late" @click="go('expenses')">
          <AlertTriangle :size="18" />
          <span>{{ t('finance.summary.overdue', { n: data.overdue.count, amount: money(data.overdue.amount) }, data.overdue.count) }}</span>
          <ArrowRight :size="16" />
        </button>
        <button v-if="data.pendingApprovals" type="button" class="alert wait" @click="go('expenses')">
          <ShieldAlert :size="18" />
          <span>{{ t('finance.summary.approvals', { n: data.pendingApprovals }, data.pendingApprovals) }}</span>
          <ArrowRight :size="16" />
        </button>
      </div>

      <EmptyState v-if="empty" :icon="LayoutDashboard" :title="t('finance.summary.empty')" :text="t('finance.summary.emptyText')">
        <Button variant="primary" @click="go('expenses')"><Plus :size="16" />{{ t('finance.summary.goExpenses') }}</Button>
        <Button variant="ghost" @click="go('bank')"><Landmark :size="16" />{{ t('finance.summary.goBank') }}</Button>
      </EmptyState>

      <div v-else class="cols">
        <div class="main-col">
          <!-- Últimos 6 meses -->
          <section class="card chart">
            <header>
              <h3>{{ t('finance.summary.monthly') }}</h3>
              <span class="legend"><i class="sw in" />{{ t('finance.summary.legendIn') }}<i class="sw out" />{{ t('finance.summary.legendOut') }}</span>
            </header>
            <div class="bars" role="list">
              <div v-for="m in monthly" :key="m.month" class="month" role="listitem"
                :aria-label="`${m.label}: ${t('finance.summary.legendIn')} ${money(m.inflow)}, ${t('finance.summary.legendOut')} ${money(m.spent)}`">
                <div class="pair">
                  <span class="b in" :style="{ height: m.inH }" :title="money(m.inflow)" />
                  <span class="b out" :style="{ height: m.outH }" :title="money(m.spent)" />
                </div>
                <small class="mn">{{ m.label }}</small>
                <small class="net" :class="{ neg: m.net < 0 }">{{ m.inflow || m.spent ? money(m.net) : '—' }}</small>
              </div>
            </div>
          </section>

          <!-- Gastos por categoría + Nómina -->
          <section class="card cats">
            <header>
              <h3>{{ t('finance.summary.byCategory') }}</h3>
              <button type="button" class="more" @click="go('expenses')">{{ t('finance.summary.seeExpenses') }}<ArrowRight :size="14" /></button>
            </header>
            <p v-if="!byCategory.length" class="muted">{{ t('finance.summary.byCategoryEmpty') }}</p>
            <ul v-else>
              <li v-for="c in byCategory" :key="c.key">
                <button type="button" @click="go(c.tab)">
                  <span class="nm"><i :style="{ background: c.color }" />{{ c.name }}</span>
                  <b>{{ money(c.amount) }}</b>
                  <span class="track"><span class="fill" :style="{ width: c.width, background: c.color }" /></span>
                  <small>{{ c.pct }} %</small>
                </button>
              </li>
            </ul>
          </section>
        </div>

        <!-- Columna de contexto: próximos pagos, entradas por compañía y comisiones -->
        <aside class="side">
          <section class="card upcoming">
            <header>
              <h3><CalendarClock :size="17" />{{ t('finance.summary.upcoming') }}</h3>
              <small>{{ t('finance.summary.upcomingHint') }}</small>
            </header>
            <p v-if="!data.upcoming.length" class="muted">{{ t('finance.summary.upcomingEmpty') }}</p>
            <ul v-else>
              <li v-for="u in data.upcoming" :key="`${u.kind}-${u.id}`" :class="{ late: u.overdue }">
                <button type="button" @click="go(u.kind === 'payroll' ? 'payroll' : 'expenses')">
                  <span class="when"><b>{{ day(u.date) }}</b><small>{{ when(u.date) }}</small></span>
                  <span class="what">
                    <b>{{ u.label }}</b>
                    <small v-if="u.kind === 'payroll'">{{ t('finance.summary.payrollRun') }} · {{ periodOf(u.detail) }}</small>
                    <small v-else-if="u.detail">{{ u.detail }}</small>
                    <Badge v-if="u.kind === 'expense' && fin.category(u.categoryId!)" :tone="fin.category(u.categoryId!)!.color">{{ fin.category(u.categoryId!)!.name }}</Badge>
                    <Badge v-else-if="u.overdue" tone="danger">{{ t('finance.status.overdue') }}</Badge>
                  </span>
                  <span class="amt">{{ money(u.amount) }}</span>
                </button>
              </li>
            </ul>
          </section>

          <section class="card carriers">
            <header>
              <h3>{{ t('finance.summary.byCarrier') }}</h3>
              <button type="button" class="more" @click="go('bank')">{{ t('finance.summary.seeBank') }}<ArrowRight :size="14" /></button>
            </header>
            <p v-if="!carriers.length" class="muted">{{ t('finance.summary.byCarrierEmpty') }}</p>
            <ul v-else>
              <li v-for="c in carriers" :key="c.carrierId ?? 'none'">
                <span class="nm">{{ c.name }}</span><b>{{ money(c.amount) }}</b>
                <span class="track"><span class="fill" :style="{ width: c.width }" /></span>
              </li>
            </ul>
            <!-- Comisiones de ventas: lo esperado de las cuotas vs. lo marcado pagado (base de la conciliación futura) -->
            <div v-if="data.commissions" class="comm">
              <small>{{ t('finance.summary.commissions') }}</small>
              <div class="cm-row"><span>{{ t('finance.summary.commExpected') }}</span><b>{{ money(data.commissions.expected) }}</b></div>
              <div class="cm-row"><span>{{ t('finance.summary.commPaid') }}</span><b>{{ money(data.commissions.paid) }}</b></div>
              <span class="track"><span class="fill ok" :style="{ width: `${commissionPct}%` }" /></span>
              <small>{{ t('finance.summary.commCount', { paid: data.commissions.paidCount, n: data.commissions.count }, data.commissions.count) }}</small>
            </div>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.filters :deep(.dd) { min-width: 180px; }
.hint { flex: 1 1 280px; margin: 0; padding: 6px 12px; font-size: 13px; line-height: 1.45; color: var(--color-muted); border-left: 3px solid var(--color-cta); }

.totals { display: grid; grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); gap: 14px; }
.tot { display: grid; gap: 2px; align-content: start; padding: 14px 18px; font: inherit; text-align: left; color: inherit; background: var(--color-surface); border: 0; box-shadow: var(--shadow-md); }
.tot small { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--color-muted); }
.tot b { font-family: var(--font-display); font-size: 26px; font-variant-numeric: tabular-nums; }
.tot span { font-size: 13px; color: var(--color-muted); }
.tot.main { border-left: 4px solid var(--color-success); }
.tot.main b { font-size: 34px; color: var(--color-success); }
.tot.main.neg { border-left-color: var(--color-danger); }
.tot.main.neg b { color: var(--color-danger); }
.tot.link { cursor: pointer; border-bottom: 3px solid transparent; transition: box-shadow var(--duration), transform var(--duration), border-color var(--duration); }
.tot.link:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); border-bottom-color: var(--color-primary); }
.tot.in b { color: var(--color-ink); }

.alerts { display: flex; flex-wrap: wrap; gap: 10px 14px; }
.alert { flex: 1 1 280px; display: flex; align-items: center; gap: 10px; padding: 11px 16px; font: inherit; font-weight: 500; text-align: left; color: var(--color-ink);
  border: 0; box-shadow: var(--shadow-sm); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.alert span { flex: 1; }
.alert:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.alert.late { background: var(--color-danger-light); border-left: 4px solid var(--color-danger); }
.alert.late svg:first-child { color: var(--color-danger); }
.alert.wait { background: var(--color-warning-light); border-left: 4px solid var(--color-warning); }
.alert.wait svg:first-child { color: var(--color-warning); }

/* Columna principal ancha; la de contexto a la derecha */
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 20px; align-items: start; }
.main-col, .side { display: grid; gap: 20px; min-width: 0; }
.card { display: grid; gap: 12px; padding: 16px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.card header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.card h3 { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 16px; }
.card header small { font-size: 12px; color: var(--color-muted); }
.more { display: inline-flex; align-items: center; gap: 4px; padding: 0; font: inherit; font-size: 13px; font-weight: 600; color: var(--color-leaf); background: none; border: 0; cursor: pointer; }
.more:hover { text-decoration: underline; }
.muted { margin: 0; font-size: 13px; color: var(--color-muted); }
.track { display: block; height: 6px; background: var(--color-canvas-deep); }
.fill { display: block; height: 100%; background: var(--color-ink-soft); }
.fill.ok { background: var(--color-success); }

/* Barras mensuales */
.chart { border-top: 4px solid var(--color-ink); }
.legend { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-muted); }
.sw { width: 10px; height: 10px; display: inline-block; }
.sw.out { margin-left: 10px; }
.sw.in, .b.in { background: var(--color-success); }
.sw.out, .b.out { background: var(--color-primary); }
.bars { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; align-items: end; padding-top: 6px; border-bottom: 1px solid var(--color-line); }
.month { display: grid; gap: 4px; justify-items: center; min-width: 0; }
.pair { display: flex; align-items: flex-end; justify-content: center; gap: 4px; width: 100%; height: 170px; }
.b { width: min(26px, 40%); min-height: 2px; transition: height var(--duration); }
.mn { font-size: 12px; font-weight: 600; text-transform: capitalize; }
.net { padding-bottom: 8px; font-size: 11px; color: var(--color-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.net.neg { color: var(--color-danger); }

.cats ul, .upcoming ul, .carriers ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.cats li button { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; width: 100%; padding: 8px 8px 10px; font: inherit; text-align: left; color: inherit;
  background: none; border: 0; border-left: 3px solid transparent; cursor: pointer; transition: background var(--duration), border-color var(--duration); }
.cats li button:hover { background: var(--color-canvas); border-left-color: var(--color-primary); }
.cats .track, .cats small { grid-column: 1 / -1; }
.cats small { font-size: 12px; color: var(--color-muted); }
.nm { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm i { width: 10px; height: 10px; flex: none; }
.cats b, .carriers b { font-size: 14px; font-variant-numeric: tabular-nums; }

.upcoming { border-left: 4px solid var(--color-primary); }
.upcoming li button { display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; gap: 10px; align-items: start; width: 100%; padding: 10px 6px; font: inherit; text-align: left; color: inherit;
  background: none; border: 0; border-bottom: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration); }
.upcoming li:last-child button { border-bottom: 0; }
.upcoming li button:hover { background: var(--color-canvas); }
.upcoming li.late .when b { color: var(--color-danger); }
.when, .what { display: grid; gap: 2px; min-width: 0; }
.when b { font-size: 13px; white-space: nowrap; }
.when small, .what small { font-size: 12px; color: var(--color-muted); }
.what b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.what :deep(.badge) { justify-self: start; margin-top: 2px; }
.amt { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }

.carriers li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; padding: 6px 0 8px; }
.carriers .track { grid-column: 1 / -1; }
.carriers .fill { background: var(--color-success); }
.comm { display: grid; gap: 6px; margin-top: 4px; padding: 12px 14px; background: var(--color-canvas); border-left: 3px solid var(--color-ink); }
.comm > small { font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
.comm > small:last-child { font-weight: 400; text-transform: none; letter-spacing: 0; }
.cm-row { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; }
.cm-row b { font-variant-numeric: tabular-nums; }

@media (max-width: 1279px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .side { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items: start; }
  .totals { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tot.main { grid-column: 1 / -1; }
}
@media (max-width: 767px) {
  .body { padding: 14px 16px 32px; }
  .filters { width: 100%; }
  .filters :deep(.dd) { flex: 1 1 100%; }
  .totals { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .tot { padding: 12px; }
  .tot.main { grid-column: 1 / -1; }
  .tot b { font-size: 17px; }
  .tot.main b { font-size: 30px; }
  .tot small { font-size: 12px; }
  .tot small svg { display: none; }
  .tot span { font-size: 12px; }
  .side { grid-template-columns: minmax(0, 1fr); }
  .bars { gap: 4px; }
  .pair { height: 130px; gap: 2px; }
  .net { font-size: 10px; }
  .upcoming li button { grid-template-columns: 72px minmax(0, 1fr) auto; gap: 8px; }
}
</style>
