<script setup lang="ts">
// Comisiones: cuotas por fecha de pago (adelanto al ISSUE, resto a los 12 meses, chargebacks), resumen por
// beneficiario y, para el Admin, marcar pagadas en lote.
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Download, Wallet, CircleCheck, Undo2, ArrowRight, ArrowLeft } from 'lucide-vue-next';
import type { Installment, InstallmentStatus } from '@agencia-hub/contracts';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import Pagination from '@/design/Pagination.vue';
import { usePaged } from '@/design/paged.ts';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useSales } from './store.ts';
import { usd, fmtDay, today, addMonths, monthStart, monthEnd } from './format.ts';

const { t, locale } = useI18n();
const s = useSession();
const ref_ = useSales();
const slug = () => s.workspace!.slug;
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);

type Period = 'month' | 'nextMonth' | 'next12' | 'past' | 'all';
const period = ref<Period>('month');
const who = ref('');
const status = ref<InstallmentStatus | ''>('');
const periodOptions = computed(() => (['month', 'nextMonth', 'next12', 'past', 'all'] as const).map((v) => ({ value: v, label: t(`sales.duePeriods.${v}`) })));
const statusOptions = computed(() => [{ value: '' as const, label: t('sales.allStatuses') },
  ...(['pending', 'paid', 'void'] as const).map((v) => ({ value: v, label: t(`sales.installment.${v}`) }))]);
const query = computed(() => {
  const now = today();
  const r = period.value === 'month' ? { from: monthStart(now), to: monthEnd(now) }
    : period.value === 'nextMonth' ? { from: addMonths(monthStart(now), 1), to: monthEnd(addMonths(monthStart(now), 1)) }
    : period.value === 'next12' ? { from: now, to: addMonths(now, 12) }
    : period.value === 'past' ? { from: undefined, to: now }
    : { from: undefined, to: undefined };
  return { ...r, status: status.value || undefined };
});

const items = ref<Installment[] | null>(null);
const selected = ref<Set<string>>(new Set());
async function load() {
  items.value = null;
  selected.value = new Set();
  try {
    items.value = (await api('GET /w/:slug/commissions', { params: { slug: slug() }, query: query.value })).items;
    await reveal();
  } catch (e) { toast(errorText(e), 'error'); }
}
watch(query, load, { immediate: true });

// ─── Saltar a la otra cuota de la misma comisión (adelanto ↔ resto) ───
const focusId = ref<string | null>(null);
const flash = ref<string | null>(null);
/** Lleva a la página de la cuota buscada, la centra y la resalta un momento */
async function reveal() {
  if (!focusId.value) return;
  await nextTick();   // deja que la paginación procese la lista nueva antes de elegir página
  const idx = rows.value.findIndex((i) => i.id === focusId.value);
  if (idx < 0) return;
  page.value = Math.floor(idx / size.value) + 1;
  await nextTick();
  document.getElementById(`inst-${focusId.value}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash.value = focusId.value;
  focusId.value = null;
  setTimeout(() => { flash.value = null; }, 2400);
}
/** Si la pareja no está en el filtro actual, se abre el filtro a "Todas" de ese beneficiario */
function jump(i: Installment) {
  focusId.value = i.sibling!.id;
  if (rows.value.some((r) => r.id === focusId.value)) return reveal();
  who.value = i.beneficiaryUserId;
  status.value = '';
  if (period.value === 'all' && !query.value.status) reveal();
  else period.value = 'all';
}

const rows = computed(() => (items.value ?? []).filter((i) => !who.value || i.beneficiaryUserId === who.value));
const { page, size, rows: pageRows, total } = usePaged(rows);
const pagerLabels = computed(() => ({ prev: t('common.pager.prev'), next: t('common.pager.next'), perPage: t('common.pager.perPage'), of: t('common.pager.of') }));
const whoOptions = computed(() => [{ value: '', label: t('sales.everyone') },
  ...[...new Set((items.value ?? []).map((i) => i.beneficiaryUserId))].map((id) => ({ value: id, label: ref_.memberName(id) }))
    .sort((a, b) => a.label.localeCompare(b.label))]);

const cents = (n: number) => Math.round(n * 100);
/** Resumen por beneficiario; anuladas no suman */
const summary = computed(() => {
  const by = new Map<string, { id: string; direct: number; override: number; chargeback: number; pending: number; paid: number }>();
  for (const i of rows.value) {
    if (i.status === 'void') continue;
    const r = by.get(i.beneficiaryUserId) ?? { id: i.beneficiaryUserId, direct: 0, override: 0, chargeback: 0, pending: 0, paid: 0 };
    if (i.part === 'chargeback') r.chargeback += cents(i.amount); else r[i.kind] += cents(i.amount);
    r[i.status] += cents(i.amount);
    by.set(i.beneficiaryUserId, r);
  }
  return [...by.values()].map((r) => ({ ...r, total: r.direct + r.override + r.chargeback }))
    .sort((a, b) => b.total - a.total);
});
const grand = computed(() => summary.value.reduce((g, r) => ({ total: g.total + r.total, pending: g.pending + r.pending, paid: g.paid + r.paid }), { total: 0, pending: 0, paid: 0 }));

const csvUrl = computed(() => `/api/v1/w/${slug()}/commissions.csv?${new URLSearchParams(Object.entries(query.value).filter(([, v]) => v) as [string, string][])}`);

// ─── Pagos (Admin) ───
const payable = computed(() => rows.value.filter((i) => i.status !== 'void'));
const allOn = computed(() => payable.value.length > 0 && payable.value.every((i) => selected.value.has(i.id)));
const toggleAll = () => { selected.value = allOn.value ? new Set() : new Set(payable.value.map((i) => i.id)); };
const toggle = (id: string) => {
  const next = new Set(selected.value);
  if (!next.delete(id)) next.add(id);
  selected.value = next;
};
const payDate = ref(today());
const busy = ref(false);
async function pay(paid: boolean) {
  busy.value = true;
  try {
    await api('POST /w/:slug/commissions/pay', { params: { slug: slug() }, body: { ids: [...selected.value], paidAt: paid ? payDate.value : null } });
    toast(paid ? t('sales.paidOk') : t('sales.unpaidOk'), 'success');
    await load();
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
const STATUS_TONE = { pending: 'warning', paid: 'success', void: 'neutral' } as const;
</script>

<template>
  <div class="body">
    <div class="filters">
      <Dropdown v-model="period" :options="periodOptions" :aria-label="t('sales.period')" />
      <Dropdown v-model="who" :options="whoOptions" searchable :search-placeholder="t('sales.searchAgent')" :aria-label="t('sales.beneficiary')" />
      <Dropdown v-model="status" :options="statusOptions" :aria-label="t('sales.statusLabel')" />
      <a :href="csvUrl" download class="exp"><Download :size="16" />CSV</a>
    </div>

    <div v-if="!items" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="52px" /></div>
    <EmptyState v-else-if="!rows.length" :icon="Wallet" :title="t('sales.noCommissions')" :text="t('sales.noCommissionsText')" />
    <template v-else>
      <div class="split">
        <div class="totals">
          <div class="tot main"><small>{{ t('sales.commissionTotal') }}</small><b>{{ money(grand.total / 100) }}</b></div>
          <div class="tot"><small>{{ t('sales.toCollect') }}</small><b>{{ money(grand.pending / 100) }}</b></div>
          <div class="tot"><small>{{ t('sales.installment.paid') }}</small><b>{{ money(grand.paid / 100) }}</b></div>
        </div>
        <div v-if="summary.length > 1" class="table-wrap">
          <table class="sum">
            <thead><tr>
              <th scope="col">{{ t('sales.beneficiary') }}</th><th scope="col" class="num">{{ t('sales.kind.direct') }}</th>
              <th scope="col" class="num">{{ t('sales.kind.override') }}</th><th scope="col" class="num">{{ t('sales.part.chargeback') }}</th>
              <th scope="col" class="num">{{ t('sales.toCollect') }}</th><th scope="col" class="num">Total</th>
            </tr></thead>
            <tbody>
              <tr v-for="r in summary" :key="r.id" class="pick" @click="who = who === r.id ? '' : r.id">
                <th scope="row">{{ ref_.memberName(r.id) }}</th>
                <td class="num">{{ r.direct ? money(r.direct / 100) : '—' }}</td><td class="num">{{ r.override ? money(r.override / 100) : '—' }}</td>
                <td class="num" :class="{ neg: r.chargeback }">{{ r.chargeback ? money(r.chargeback / 100) : '—' }}</td>
                <td class="num">{{ money(r.pending / 100) }}</td><td class="num"><b>{{ money(r.total / 100) }}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="s.isAdmin && selected.size" class="bulk">
        <span>{{ t('sales.selected', { n: selected.size }, selected.size) }}</span>
        <label class="date">{{ t('sales.paidOn') }}<input v-model="payDate" type="date"></label>
        <Button variant="primary" :loading="busy" :disabled="!payDate" @click="pay(true)"><CircleCheck :size="16" />{{ t('sales.markPaid') }}</Button>
        <Button variant="ghost" :loading="busy" @click="pay(false)"><Undo2 :size="16" />{{ t('sales.markUnpaid') }}</Button>
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr>
            <th v-if="s.isAdmin" scope="col"><input type="checkbox" :checked="allOn" :aria-label="t('sales.selectAll', { n: payable.length })" :title="t('sales.selectAll', { n: payable.length })" @change="toggleAll"></th>
            <th scope="col">{{ t('sales.dueDate') }}</th><th scope="col">{{ t('sales.beneficiary') }}</th><th scope="col">{{ t('sales.concept') }}</th>
            <th scope="col">{{ t('sales.client') }}</th><th scope="col">{{ t('sales.product') }}</th>
            <th scope="col" class="num">{{ t('sales.saleAmount') }}</th><th scope="col" class="num">{{ t('sales.levelRate') }}</th>
            <th scope="col" class="num">{{ t('sales.installmentCol') }}</th><th scope="col">{{ t('sales.statusLabel') }}</th>
          </tr></thead>
          <tbody>
            <tr v-for="i in pageRows" :id="`inst-${i.id}`" :key="i.id" :class="{ off: i.status === 'void', flash: flash === i.id }">
              <td v-if="s.isAdmin"><input v-if="i.status !== 'void'" type="checkbox" :checked="selected.has(i.id)" :aria-label="i.sale.clientName" @change="toggle(i.id)"></td>
              <td class="nowrap">{{ day(i.dueDate) }}</td>
              <td>{{ ref_.memberName(i.beneficiaryUserId) }}</td>
              <td>
                <Badge :tone="i.kind === 'override' ? 'purple' : 'blue'">{{ t(`sales.kind.${i.kind}`) }}</Badge>
                <small class="part">{{ t(`sales.part.${i.part}`) }}<template v-if="i.sibling"> · {{ t('sales.nOf2', { n: i.part === 'advance' ? 1 : 2 }) }}</template></small>
                <button v-if="i.sibling" type="button" class="pair" @click="jump(i)">
                  <ArrowLeft v-if="i.sibling.part === 'advance'" :size="13" />
                  {{ t(i.sibling.part === 'advance' ? 'sales.seeAdvance' : 'sales.seeRemainder', { amount: money(i.sibling.amount), date: day(i.sibling.dueDate) }) }}
                  <ArrowRight v-if="i.sibling.part === 'remainder'" :size="13" />
                </button>
              </td>
              <td><b>{{ i.sale.clientName }}</b><small v-if="i.kind === 'override'">{{ t('sales.soldBy', { name: ref_.memberName(i.sale.agentUserId) }) }}</small></td>
              <td>{{ ref_.productLabel(i.sale.productId) }}</td>
              <td class="num">{{ money(i.sale.amount) }}</td>
              <td class="num">{{ i.level ?? '—' }} · {{ i.rate }}%</td>
              <td class="num" :class="{ neg: i.amount < 0 }"><b>{{ money(i.amount) }}</b>
                <small v-if="i.sibling">{{ t('sales.ofTotal', { total: money(i.total) }) }}</small></td>
              <td><Badge :tone="STATUS_TONE[i.status]">{{ t(`sales.installment.${i.status}`) }}</Badge><small v-if="i.paidAt">{{ day(i.paidAt) }}</small></td>
            </tr>
          </tbody>
        </table>
      </div>
      <Pagination v-model="page" v-model:size="size" :total="total" :labels="pagerLabels" />
    </template>
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.filters :deep(.dd) { width: 210px; }
.exp { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; margin-left: auto; padding: 0 12px; font-size: 14px; font-weight: 500; color: var(--color-ink); text-decoration: none; background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration); }
.exp:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }

/* Dos columnas de distinto peso: totales apilados a la izquierda, resumen por persona a la derecha */
.split { display: grid; grid-template-columns: minmax(240px, 1fr) 2.4fr; gap: 16px; align-items: start; }
.split:has(> :only-child) { grid-template-columns: 1fr; }
.totals { display: grid; gap: 12px; }
.split:has(> :only-child) .totals { grid-template-columns: 1.6fr 1fr 1fr; }
.tot { display: grid; gap: 2px; padding: 14px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.tot.main { border-left: 4px solid var(--color-primary); }
.tot small { font-size: 13px; color: var(--color-muted); }
.tot b { font-family: var(--font-display); font-size: 24px; font-variant-numeric: tabular-nums; }
.tot.main b { font-size: 30px; }

.bulk { position: sticky; top: 0; z-index: 3; display: flex; flex-wrap: wrap; align-items: end; gap: 12px; padding: 12px 16px; background: var(--color-ink); color: #fff; box-shadow: var(--shadow-lg); }
.bulk > span { align-self: center; margin-right: auto; font-weight: 600; }
.bulk .date { display: grid; gap: 4px; font-size: 12px; color: var(--color-sidebar-text); }

.table-wrap { overflow-x: auto; background: var(--color-surface); box-shadow: var(--shadow-md); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 10px 14px; font-size: 12px; font-weight: 600; text-align: left; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); border-bottom: 1px solid var(--color-line); white-space: nowrap; }
tbody th { font-size: 14px; font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--color-ink); background: none; }
td { padding: 10px 14px; vertical-align: top; border-bottom: 1px solid var(--color-line); }
td small { display: block; margin-top: 3px; font-size: 12px; color: var(--color-muted); }
tr:hover td, tr:hover th { background: var(--color-canvas); }
tr.off td { color: var(--color-muted); }
/* Cuota a la que se saltó desde su pareja: se ilumina y se apaga sola */
tr.flash td, tr.flash th { background: var(--color-primary-light); transition: background 600ms; }
.part { display: block; }
.pair { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; white-space: nowrap; padding: 0; font: inherit; font-size: 12px; font-weight: 600; color: var(--color-leaf); text-align: left; background: none; border: 0; cursor: pointer; }
.pair:hover { text-decoration: underline; }
tr.off b { text-decoration: line-through; }
.pick { cursor: pointer; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.neg { color: var(--color-danger); }
.nowrap { white-space: nowrap; }

@media (max-width: 1100px) { .split { grid-template-columns: 1fr; } .totals { grid-template-columns: 1.6fr 1fr 1fr; } }
@media (max-width: 767px) {
  .body { padding: 14px 16px 32px; }
  .filters :deep(.dd) { width: calc(50% - 6px); }
  .totals, .split:has(> :only-child) .totals { grid-template-columns: 1fr 1fr; }
  .tot.main { grid-column: 1 / -1; }
}
</style>
