<script setup lang="ts">
// Ventas: filtros por periodo, agente, compañía y estado; totales; ISSUE pendiente vencido; acciones del Admin
// (registrar, editar, marcar ISSUED, rechazar y cancelar con chargeback).
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Download, CircleCheck, Clock, Pencil, Ban, Undo2, Receipt, TriangleAlert } from 'lucide-vue-next';
import type { Sale, SaleStatus } from '@agencia-hub/contracts';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import EmptyState from '@/design/EmptyState.vue';
import Pagination from '@/design/Pagination.vue';
import { usePaged } from '@/design/paged.ts';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useSales } from './store.ts';
import { usd, fmtDay, today, addMonths, monthStart, monthEnd, customRange, type DateFilterValue } from './format.ts';
import SaleModal from './SaleModal.vue';
import DateFilter from './DateFilter.vue';

const { t, locale } = useI18n();
const s = useSession();
const ref_ = useSales();
const slug = () => s.workspace!.slug;
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);

// ─── Filtros (fecha esperada de ISSUE) ───
const date = ref<DateFilterValue>({ period: 'month', from: '', to: '' });
const f = reactive({ agent: '', carrier: '', status: '' as SaleStatus | '' | 'overdue' });
const periodOptions = computed(() => (['month', 'lastMonth', 'last90', 'year', 'all'] as const).map((v) => ({ value: v, label: t(`sales.periods.${v}`) })));
const range = computed(() => {
  const custom = customRange(date.value);
  if (custom) return custom;
  const now = today(), p = date.value.period;
  if (p === 'month') return { from: monthStart(now), to: monthEnd(now) };
  if (p === 'lastMonth') { const m = addMonths(monthStart(now), -1); return { from: m, to: monthEnd(m) }; }
  if (p === 'last90') return { from: addMonths(now, -3), to: undefined };
  if (p === 'year') return { from: `${now.slice(0, 4)}-01-01`, to: `${now.slice(0, 4)}-12-31` };
  return { from: undefined, to: undefined };
});

const items = ref<Sale[] | null>(null);
const overdue = ref<Sale[]>([]);
async function load() {
  items.value = null;
  try {
    const params = { slug: slug() };
    const [list, late] = await Promise.all([
      api('GET /w/:slug/sales', { params, query: range.value }),
      api('GET /w/:slug/sales', { params, query: { overdue: 'true' } }),
    ]);
    items.value = list.items;
    overdue.value = late.items;
  } catch (e) { toast(errorText(e), 'error'); }
}
watch(range, load, { immediate: true });

const rows = computed(() => {
  const base = f.status === 'overdue' ? overdue.value : items.value ?? [];
  return base.filter((x) => (!f.agent || x.agentId === f.agent) && (!f.carrier || x.carrierId === f.carrier)
    && (!f.status || f.status === 'overdue' || x.status === f.status));
});
const { page, size, rows: pageRows, total } = usePaged(rows);
const pagerLabels = computed(() => ({ prev: t('common.pager.prev'), next: t('common.pager.next'), perPage: t('common.pager.perPage'), of: t('common.pager.of') }));
const sum = (list: Sale[]) => list.reduce((n, x) => n + Math.round(x.amount * 100), 0) / 100;
const totals = computed(() => ({
  count: rows.value.length, amount: sum(rows.value),
  issued: sum(rows.value.filter((x) => x.status === 'issued')), pending: sum(rows.value.filter((x) => x.status === 'pending')),
}));

// Agentes que aparecen en las ventas visibles (un agente ve solo los suyos; el dueño, también los de su equipo)
const agentOptions = computed(() => {
  const ids = [...new Set([...(items.value ?? []), ...overdue.value].map((x) => x.agentId))];
  return [{ value: '', label: t('sales.allAgents') },
    ...ids.map((id) => ({ value: id, label: ref_.agentName(id) })).sort((a, b) => a.label.localeCompare(b.label))];
});
const carrierOptions = computed(() => [{ value: '', label: t('sales.allCarriers') }, ...ref_.carriers.map((c) => ({ value: c.id, label: c.name }))]);
const statusOptions = computed(() => [{ value: '' as const, label: t('sales.allStatuses') },
  ...(['pending', 'issued', 'declined', 'cancelled'] as const).map((v) => ({ value: v, label: t(`sales.status.${v}`) })),
  { value: 'overdue' as const, label: t('sales.overdueOnly') }]);
const TONE = { pending: 'warning', issued: 'success', declined: 'neutral', cancelled: 'danger' } as const;

const csvUrl = computed(() => `/api/v1/w/${slug()}/sales.csv?${new URLSearchParams(Object.entries(range.value).filter(([, v]) => v) as [string, string][])}`);

// ─── Acciones (Admin) ───
const modal = ref(false);
const editing = ref<Sale | null>(null);
const openSale = (x: Sale | null) => { editing.value = x; modal.value = true; };

const issuing = ref<Sale | null>(null);
const issueDate = ref('');
const issueOpen = computed({ get: () => !!issuing.value, set: (v) => { if (!v) issuing.value = null; } });
const openIssue = (x: Sale) => { issuing.value = x; issueDate.value = x.expectedIssueDate <= today() ? x.expectedIssueDate : today(); };

const cancelling = ref<Sale | null>(null);
const chargeback = ref('100');
const cancelOpen = computed({ get: () => !!cancelling.value, set: (v) => { if (!v) cancelling.value = null; } });
/** Proporcional sugerido: meses del adelanto que el cliente no alcanzó a pagar */
const suggested = computed(() => {
  const x = cancelling.value;
  if (!x?.issuedAt) return 100;
  const months = ref_.carrier(x.carrierId)?.advanceMonths ?? 9;
  const [y1, m1] = x.issuedAt.split('-').map(Number) as [number, number];
  const [y2, m2] = today().split('-').map(Number) as [number, number];
  const elapsed = Math.max(0, (y2 - y1) * 12 + (m2 - m1));
  return months ? Math.max(0, Math.round(((months - elapsed) / months) * 100)) : 0;
});
const openCancel = (x: Sale) => { cancelling.value = x; chargeback.value = '100'; };

const busy = ref(false);
async function act(fn: () => Promise<unknown>, ok: string) {
  busy.value = true;
  try {
    await fn();
    toast(ok, 'success');
    issuing.value = null;
    cancelling.value = null;
    declining.value = null;
    await load();
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
const issue = () => act(() => api('POST /w/:slug/sales/:id/issue', { params: { slug: slug(), id: issuing.value!.id }, body: { issuedAt: issueDate.value } }), t('sales.issuedOk'));
const declining = ref<Sale | null>(null);
const declineOpen = computed({ get: () => !!declining.value, set: (v) => { if (!v) declining.value = null; } });
const decline = () => act(() => api('POST /w/:slug/sales/:id/decline', { params: { slug: slug(), id: declining.value!.id } }), t('sales.declinedOk'));
const cancel = () => act(() => api('POST /w/:slug/sales/:id/cancel', { params: { slug: slug(), id: cancelling.value!.id }, body: { chargebackPercent: Number(chargeback.value) } }), t('sales.cancelledOk'));
</script>

<template>
  <div class="body">
    <div class="filters">
      <DateFilter v-model="date" :presets="periodOptions" :label="t('sales.expectedIssue')" />
      <Dropdown v-model="f.agent" :options="agentOptions" searchable :search-placeholder="t('sales.searchAgent')" :aria-label="t('sales.agent')" />
      <Dropdown v-model="f.carrier" :options="carrierOptions" :aria-label="t('sales.carrier')" />
      <Dropdown v-model="f.status" :options="statusOptions" :aria-label="t('sales.statusLabel')" />
      <div class="acts">
        <a :href="csvUrl" download class="exp"><Download :size="16" />CSV</a>
        <Button v-if="s.can('sales', 'edit')" variant="primary" @click="openSale(null)"><Plus :size="17" />{{ t('sales.newSale') }}</Button>
      </div>
    </div>

    <button v-if="overdue.length && f.status !== 'overdue'" type="button" class="late" @click="f.status = 'overdue'">
      <Clock :size="18" />
      <span>{{ t('sales.overdueBanner', { n: overdue.length }, overdue.length) }}</span>
      <b>{{ t('sales.review') }}</b>
    </button>

    <div class="totals">
      <div class="tot main"><small>{{ t('sales.totalSold') }}</small><b>{{ money(totals.amount) }}</b><span>{{ t('sales.nSales', { n: totals.count }, totals.count) }}</span></div>
      <div class="tot"><small>{{ t('sales.status.issued') }}</small><b>{{ money(totals.issued) }}</b></div>
      <div class="tot"><small>{{ t('sales.pendingIssue') }}</small><b>{{ money(totals.pending) }}</b></div>
    </div>

    <div v-if="!items" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="52px" /></div>
    <EmptyState v-else-if="!rows.length" :icon="Receipt" :title="t('sales.empty')" :text="s.can('sales', 'edit') ? t('sales.emptyAdmin') : t('sales.emptyMember')">
      <Button v-if="s.can('sales', 'edit')" variant="primary" @click="openSale(null)"><Plus :size="16" />{{ t('sales.newSale') }}</Button>
    </EmptyState>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{{ t('sales.soldOn') }}</th><th scope="col">{{ t('sales.expectedIssue') }}</th><th scope="col">{{ t('sales.client') }}</th><th scope="col">{{ t('sales.agent') }}</th>
            <th scope="col">{{ t('sales.product') }}</th><th scope="col" class="num">{{ t('sales.amount') }}</th><th scope="col">{{ t('sales.statusLabel') }}</th>
            <th v-if="s.can('sales', 'edit')" scope="col"><span class="sr-only">{{ t('sales.actions') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="x in pageRows" :key="x.id" :class="{ off: x.status === 'declined' || x.status === 'cancelled' }">
            <td class="nowrap">{{ day(x.soldOn) }}</td>
            <td class="nowrap">{{ day(x.expectedIssueDate) }}<small v-if="x.issuedAt">ISSUE {{ day(x.issuedAt) }}</small></td>
            <td><b>{{ x.clientName }}</b><small v-if="x.clientState">{{ x.clientState }}</small></td>
            <td>{{ ref_.agentName(x.agentId) }}<small v-if="x.uplineAgentId">{{ t('sales.under', { name: ref_.agentName(x.uplineAgentId) }) }}</small></td>
            <td>{{ ref_.productLabel(x.productId) }}</td>
            <td class="num"><b>{{ money(x.amount) }}</b></td>
            <td>
              <Badge :tone="x.overdue ? 'danger' : TONE[x.status]">
                <TriangleAlert v-if="x.overdue" :size="12" />{{ x.overdue ? t('sales.overdue') : t(`sales.status.${x.status}`) }}
              </Badge>
              <small v-if="x.source === 'discord'" class="src">Discord</small>
            </td>
            <td v-if="s.can('sales', 'edit')" class="row-acts">
              <template v-if="x.status === 'pending'">
                <Button size="sm" variant="primary" @click="openIssue(x)"><CircleCheck :size="15" />ISSUE</Button>
                <button type="button" class="ico" :title="t('sales.editSale')" :aria-label="t('sales.editSale')" @click="openSale(x)"><Pencil :size="16" /></button>
                <button type="button" class="ico" :title="t('sales.decline')" :aria-label="t('sales.decline')" @click="declining = x"><Ban :size="16" /></button>
              </template>
              <Button v-else-if="x.status === 'issued'" size="sm" variant="ghost" @click="openCancel(x)"><Undo2 :size="15" />{{ t('sales.cancel') }}</Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Pagination v-if="items && rows.length" v-model="page" v-model:size="size" :total="total" :labels="pagerLabels" />

    <SaleModal v-model="modal" :sale="editing" @saved="load" />

    <Modal v-model="issueOpen" :title="t('sales.issueTitle')" :subtitle="issuing ? `${issuing.clientName} · ${ref_.productLabel(issuing.productId)} · ${money(issuing.amount)}` : ''">
      <label class="date">{{ t('sales.issueDate') }}<input v-model="issueDate" type="date"></label>
      <p class="note">{{ t('sales.issueNote', { months: issuing ? ref_.carrier(issuing.carrierId)?.advanceMonths ?? 9 : 9 }) }}</p>
      <template #footer>
        <Button variant="ghost" @click="issuing = null">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="busy" :disabled="!issueDate" @click="issue">{{ t('sales.markIssued') }}</Button>
      </template>
    </Modal>

    <Modal v-model="declineOpen" :title="t('sales.declineTitle')" :subtitle="declining ? `${declining.clientName} · ${money(declining.amount)}` : ''">
      <p class="note">{{ t('sales.declineNote') }}</p>
      <template #footer>
        <Button variant="ghost" @click="declining = null">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="busy" @click="decline">{{ t('sales.decline') }}</Button>
      </template>
    </Modal>

    <Modal v-model="cancelOpen" :title="t('sales.cancelTitle')" :subtitle="cancelling ? `${cancelling.clientName} · ${money(cancelling.amount)}` : ''">
      <p class="note">{{ t('sales.cancelNote') }}</p>
      <Input v-model="chargeback" type="number" :label="t('sales.chargebackPct')" :hint="t('sales.chargebackHint', { n: suggested })" />
      <div><Button size="sm" @click="chargeback = String(suggested)">{{ t('sales.useSuggested', { n: suggested }) }}</Button></div>
      <template #footer>
        <Button variant="ghost" @click="cancelling = null">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="busy" :disabled="!(Number(chargeback) >= 0 && Number(chargeback) <= 100)" @click="cancel">{{ t('sales.confirmCancel') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.filters :deep(.dd) { width: 200px; }
/* Nombres largos (agentes) se recortan con … en vez de desbordar el desplegable */
.filters :deep(.trigger) { min-width: 0; }
.acts { display: flex; gap: 8px; margin-left: auto; }
.exp { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 12px; font-size: 14px; font-weight: 500; color: var(--color-ink); text-decoration: none; background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration); }
.exp:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }

.late { display: flex; align-items: center; gap: 12px; padding: 12px 16px; font: inherit; text-align: left; color: var(--color-warning); background: var(--color-warning-light); border: 0; border-left: 4px solid var(--color-warning); box-shadow: var(--shadow-sm); cursor: pointer; transition: box-shadow var(--duration); }
.late:hover { box-shadow: var(--shadow-md); }
.late span { flex: 1; color: var(--color-ink); }
.late b { color: var(--color-leaf); text-decoration: underline; }

/* Totales asimétricos: el total vendido pesa más que los otros dos */
.totals { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 14px; }
.tot { display: grid; gap: 2px; padding: 14px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.tot.main { border-left: 4px solid var(--color-primary); }
.tot small { font-size: 13px; color: var(--color-muted); }
.tot b { font-family: var(--font-display); font-size: 26px; font-variant-numeric: tabular-nums; }
.tot.main b { font-size: 32px; }
.tot span { font-size: 13px; color: var(--color-muted); }

.table-wrap { overflow-x: auto; background: var(--color-surface); box-shadow: var(--shadow-md); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 10px 14px; font-size: 12px; font-weight: 600; text-align: left; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); border-bottom: 1px solid var(--color-line); white-space: nowrap; }
td { padding: 10px 14px; vertical-align: top; border-bottom: 1px solid var(--color-line); }
td small { display: block; margin-top: 2px; font-size: 12px; color: var(--color-muted); }
tr:hover td { background: var(--color-canvas); }
tr.off td { color: var(--color-muted); }
tr.off b { text-decoration: line-through; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.src { color: var(--color-cat-purple) !important; font-weight: 600; }
.row-acts { white-space: nowrap; text-align: right; }
.row-acts > * { vertical-align: middle; }
.ico { display: inline-grid; place-items: center; width: 32px; height: 32px; margin-left: 4px; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }

.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

@media (max-width: 767px) {
  .body { padding: 14px 16px 32px; }
  .filters :deep(.dd) { width: calc(50% - 6px); }
  .acts { width: 100%; margin-left: 0; }
  .totals { grid-template-columns: 1fr 1fr; }
  .tot.main { grid-column: 1 / -1; }
}
</style>
