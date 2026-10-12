<script setup lang="ts">
// Gastos: lista por fecha de vencimiento con filtros (categoría, estado, aprobación, proveedor), totales del servidor
// (pagado, pendiente, vencido) y total por categoría; acciones pagar, saltar, reabrir, editar y borrar; aviso de gastos
// por aprobar para Owner/Admin. La sub-vista "Recurrentes" maneja las plantillas (SchedulesPanel).
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Download, Pencil, Undo2, SkipForward, Trash2, Repeat, Paperclip, Check, Ban, ShieldAlert, Wallet, CircleCheck } from 'lucide-vue-next';
import type { Expense, ExpenseSchedule, ExpensesList } from '@agencia-hub/contracts';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Modal from '@/design/Modal.vue';
import EmptyState from '@/design/EmptyState.vue';
import Pagination from '@/design/Pagination.vue';
import Skeleton from '@/design/Skeleton.vue';
import { usePaged } from '@/design/paged.ts';
import { toneColor } from '@/design/types.ts';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import DateFilter from '@/sales/DateFilter.vue';
import { useFinance } from './store.ts';
import { usd, fmtDay, financeRange, qs, FINANCE_PERIODS, type DateFilterValue } from './format.ts';
import ExpenseModal from './ExpenseModal.vue';
import PayExpenseModal from './PayExpenseModal.vue';
import SchedulesPanel from './SchedulesPanel.vue';

const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const slug = () => s.workspace!.slug;
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);

// ─── Sub-vista: gastos o plantillas recurrentes ───
const view = ref<'list' | 'schedules'>('list');
const schedules = ref<ExpenseSchedule[] | null>(null);
async function loadSchedules() {
  try { schedules.value = await api('GET /w/:slug/finance/expense-schedules', { params: { slug: slug() } }); }
  catch (e) { schedules.value = []; toast(errorText(e), 'error'); }
}
const pendingSchedules = computed(() => (fin.canApprove ? schedules.value?.filter((x) => x.approvalStatus === 'pending').length ?? 0 : 0));

// ─── Filtros (fecha de vencimiento) ───
const date = ref<DateFilterValue>({ period: 'month', from: '', to: '' });
const f = reactive({ category: '', status: '' as '' | 'pending' | 'paid' | 'skipped' | 'overdue', approval: '' as '' | 'pending' | 'rejected', vendor: '' });
const periodOptions = computed(() => FINANCE_PERIODS.map((v) => ({ value: v, label: t(`finance.periods.${v}`) })));
const categoryOptions = computed(() => [{ value: '', label: t('finance.expenses.allCategories') },
  ...fin.activeCategories.map((c) => ({ value: c.id, label: c.name, swatch: toneColor(c.color) }))]);
const statusOptions = computed(() => [{ value: '' as const, label: t('finance.expenses.allStatuses') },
  ...(['pending', 'paid', 'skipped'] as const).map((v) => ({ value: v, label: t(`finance.status.${v}`) })),
  { value: 'overdue' as const, label: t('finance.status.overdue') }]);
const approvalOptions = computed(() => [{ value: '' as const, label: t('finance.approval.any') },
  { value: 'pending' as const, label: t('finance.approval.pending') }, { value: 'rejected' as const, label: t('finance.approval.rejected') }]);
const vendors = ref<string[]>([]);
const vendorOptions = computed(() => [{ value: '', label: t('finance.expenses.allVendors') }, ...vendors.value.map((v) => ({ value: v, label: v }))]);
const loadVendors = async () => { try { vendors.value = await api('GET /w/:slug/finance/vendors', { params: { slug: slug() } }); } catch { /* el filtro queda sin opciones */ } };

/** "Vencidos" y "Por aprobar" no dependen del periodo: muestran todos */
const query = computed(() => {
  const r = f.status === 'overdue' || f.approval === 'pending' ? { from: undefined, to: undefined } : financeRange(date.value);
  return {
    ...r, categoryId: f.category || undefined, vendor: f.vendor || undefined,
    status: f.status && f.status !== 'overdue' ? f.status : undefined, overdue: f.status === 'overdue' ? 'true' as const : undefined,
    approvalStatus: f.approval || undefined,
  };
});
const data = ref<ExpensesList | null>(null);
async function load() {
  data.value = null;
  try { data.value = await api('GET /w/:slug/finance/expenses', { params: { slug: slug() }, query: query.value }); }
  catch (e) { data.value = { items: [], totals: { count: 0, amount: 0, paid: 0, pending: 0, overdue: 0, overdueCount: 0 }, byCategory: [] }; toast(errorText(e), 'error'); }
}
watch(query, load, { immediate: true });
onMounted(() => { loadSchedules(); loadVendors(); });
/** Tras cualquier cambio: lista, número de "por aprobar" y proveedores nuevos */
const refresh = () => Promise.all([load(), fin.countApprovals().catch(() => {}), loadVendors()]);

const rows = computed(() => data.value?.items ?? []);
/** Total = pagado (monto real) + por pagar (estimado): así nunca queda por debajo de lo pagado */
const periodTotal = computed(() => Math.round(((data.value?.totals.paid ?? 0) + (data.value?.totals.pending ?? 0)) * 100) / 100);
const { page, size, rows: pageRows, total } = usePaged(rows);
const pagerLabels = computed(() => ({ prev: t('common.pager.prev'), next: t('common.pager.next'), perPage: t('common.pager.perPage'), of: t('common.pager.of') }));
const csvUrl = computed(() => `/api/v1/w/${slug()}/finance/expenses.csv?${qs(query.value)}`);

/** Total por categoría, de mayor a menor; la barra muestra cuánto ya se pagó */
const byCategory = computed(() => {
  const list = data.value?.byCategory ?? [];
  const max = Math.max(1, ...list.map((x) => x.amount));
  return [...list].sort((a, b) => b.amount - a.amount).map((x) => ({
    ...x, cat: fin.category(x.categoryId), width: `${(x.amount / max) * 100}%`, paidPct: x.amount ? `${(x.paid / x.amount) * 100}%` : '0%',
  }));
});

const reviewApprovals = () => { f.approval = 'pending'; f.status = ''; };

// ─── Estado visible de una fila ───
function badge(x: Expense): { tone: 'warning' | 'danger' | 'success' | 'neutral' | 'primary'; label: string } {
  if (x.approvalStatus === 'pending') return { tone: 'warning', label: t('finance.approval.pending') };
  if (x.approvalStatus === 'rejected') return { tone: 'danger', label: t('finance.approval.rejected') };
  if (x.status === 'paid') return { tone: 'success', label: t('finance.status.paid') };
  if (x.status === 'skipped') return { tone: 'neutral', label: t('finance.status.skipped') };
  return x.overdue ? { tone: 'danger', label: t('finance.status.overdue') } : { tone: 'primary', label: t('finance.status.pending') };
}

// ─── Acciones ───
const modal = ref(false);
const editing = ref<Expense | null>(null);
const openExpense = (x: Expense | null) => { editing.value = x; modal.value = true; };
const paying = ref<Expense | null>(null);
const deleting = ref<Expense | null>(null);
const deleteOpen = computed({ get: () => !!deleting.value, set: (v) => { if (!v) deleting.value = null; } });

const busy = ref<string | null>(null);
async function act(x: Expense, fn: () => Promise<unknown>, ok: string) {
  busy.value = x.id;
  try {
    await fn();
    toast(ok, 'success');
    deleting.value = null;
    await refresh();
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = null; }
}
const p = (x: Expense) => ({ params: { slug: slug(), id: x.id } });
const approve = (x: Expense) => act(x, () => api('POST /w/:slug/finance/expenses/:id/approve', p(x)), t('finance.approval.approvedOk'));
const reject = (x: Expense) => act(x, () => api('POST /w/:slug/finance/expenses/:id/reject', p(x)), t('finance.approval.rejectedOk'));
const skip = (x: Expense) => act(x, () => api('POST /w/:slug/finance/expenses/:id/skip', p(x)), t('finance.expenses.skippedOk'));
const reopen = (x: Expense) => act(x, () => api('POST /w/:slug/finance/expenses/:id/reopen', p(x)), t('finance.expenses.reopenedOk'));
const remove = () => { const x = deleting.value!; return act(x, () => api('DELETE /w/:slug/finance/expenses/:id', p(x)), t('finance.expenses.deletedOk')); };
</script>

<template>
  <div class="body">
    <div class="bar">
      <div class="seg" role="tablist" :aria-label="t('finance.tabs.expenses')">
        <button type="button" role="tab" :aria-selected="view === 'list'" @click="view = 'list'"><Wallet :size="16" />{{ t('finance.expenses.title') }}</button>
        <button type="button" role="tab" :aria-selected="view === 'schedules'" @click="view = 'schedules'">
          <Repeat :size="16" />{{ t('finance.schedules.title') }}<span v-if="schedules?.length" class="n">{{ schedules.length }}</span>
        </button>
      </div>
      <div v-if="view === 'list'" class="acts">
        <a :href="csvUrl" download class="exp"><Download :size="16" />CSV</a>
        <Button variant="primary" @click="openExpense(null)"><Plus :size="17" />{{ t('finance.expenses.new') }}</Button>
      </div>
    </div>

    <!-- Aviso para Owner/Admin: lo que cargó un Contable espera su visto bueno -->
    <div v-if="fin.canApprove && (fin.pendingApprovals || pendingSchedules) && !(view === 'list' && f.approval === 'pending')" class="approvals" role="status">
      <ShieldAlert :size="20" />
      <span>
        <template v-if="fin.pendingApprovals">{{ t('finance.approval.banner', { n: fin.pendingApprovals }, fin.pendingApprovals) }}</template>
        <template v-if="fin.pendingApprovals && pendingSchedules"> · </template>
        <template v-if="pendingSchedules">{{ t('finance.approval.bannerSchedules', { n: pendingSchedules }, pendingSchedules) }}</template>
      </span>
      <button v-if="fin.pendingApprovals" type="button" @click="view = 'list'; reviewApprovals()">{{ t('finance.approval.review') }}</button>
      <button v-if="pendingSchedules && view !== 'schedules'" type="button" @click="view = 'schedules'">{{ t('finance.approval.reviewSchedules') }}</button>
    </div>

    <SchedulesPanel v-if="view === 'schedules'" :schedules="schedules" @changed="loadSchedules(); refresh()" />

    <template v-else>
      <div class="filters">
        <DateFilter v-if="f.status !== 'overdue' && f.approval !== 'pending'" v-model="date" :presets="periodOptions" :label="t('finance.expenses.dueDate')" />
        <Dropdown v-model="f.category" :options="categoryOptions" :aria-label="t('finance.expenses.category')" />
        <Dropdown v-model="f.status" :options="statusOptions" :aria-label="t('finance.expenses.status')" />
        <Dropdown v-model="f.approval" :options="approvalOptions" :aria-label="t('finance.approval.label')" />
        <Dropdown v-model="f.vendor" :options="vendorOptions" searchable :search-placeholder="t('finance.expenses.searchVendor')" :aria-label="t('finance.expenses.vendor')" />
      </div>
      <p v-if="f.status === 'overdue' || f.approval === 'pending'" class="scope">
        {{ f.approval === 'pending' ? t('finance.approval.allDates') : t('finance.expenses.overdueAllDates') }}
        <button type="button" @click="f.status = ''; f.approval = ''">{{ t('finance.expenses.clear') }}</button>
      </p>

      <!-- Totales asimétricos: el total del periodo pesa más; lo vencido se marca en rojo -->
      <div class="totals">
        <div class="tot main"><small>{{ t('finance.expenses.total') }}</small><b>{{ money(periodTotal) }}</b>
          <span>{{ t('finance.expenses.nExpenses', { n: data?.totals.count ?? 0 }, data?.totals.count ?? 0) }}</span></div>
        <div class="tot ok"><small>{{ t('finance.expenses.paid') }}</small><b>{{ money(data?.totals.paid ?? 0) }}</b></div>
        <div class="tot"><small>{{ t('finance.expenses.pendingTotal') }}</small><b>{{ money(data?.totals.pending ?? 0) }}</b></div>
        <button type="button" class="tot late" :class="{ on: (data?.totals.overdueCount ?? 0) > 0 }" :disabled="!data?.totals.overdueCount" @click="f.status = 'overdue'">
          <small>{{ t('finance.expenses.overdue') }}</small><b>{{ money(data?.totals.overdue ?? 0) }}</b>
          <span>{{ t('finance.expenses.nOverdue', { n: data?.totals.overdueCount ?? 0 }, data?.totals.overdueCount ?? 0) }}</span>
        </button>
      </div>

      <div class="cols">
        <div class="list">
          <div v-if="!data" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="52px" /></div>
          <EmptyState v-else-if="!rows.length" :icon="Wallet" :title="t('finance.expenses.empty')"
            :text="fin.activeCategories.length ? t('finance.expenses.emptyText') : t('finance.expenses.emptyNoCategories')">
            <Button variant="primary" @click="openExpense(null)"><Plus :size="16" />{{ t('finance.expenses.new') }}</Button>
            <Button variant="ghost" @click="view = 'schedules'"><Repeat :size="16" />{{ t('finance.schedules.new') }}</Button>
          </EmptyState>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{{ t('finance.expenses.dueDate') }}</th><th scope="col">{{ t('finance.expenses.vendor') }}</th>
                  <th scope="col">{{ t('finance.expenses.category') }}</th><th scope="col" class="num">{{ t('finance.expenses.amount') }}</th>
                  <th scope="col">{{ t('finance.expenses.status') }}</th><th scope="col"><span class="sr-only">{{ t('finance.expenses.actions') }}</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="x in pageRows" :key="x.id" :class="{ off: x.status === 'skipped' || x.approvalStatus === 'rejected', late: x.overdue && x.approvalStatus === 'approved' }">
                  <td class="nowrap" :data-label="t('finance.expenses.dueDate')">{{ day(x.dueDate) }}
                    <small v-if="x.paidAt">{{ t('finance.expenses.paidOn', { date: day(x.paidAt) }) }}</small></td>
                  <td class="vendor">
                    <b>{{ x.vendor }}<Repeat v-if="x.scheduleId" :size="13" class="rep" :aria-label="t('finance.expenses.recurring')" /></b>
                    <small v-if="x.concept">{{ x.concept }}</small>
                    <small class="meta">{{ t(`finance.methods.${x.payMethod}`) }}<template v-if="x.reference"> · {{ x.reference }}</template>
                      <a v-if="x.file" :href="x.file.url" target="_blank" rel="noopener" class="file" :title="x.file.name"><Paperclip :size="12" />{{ t('finance.expenses.receiptShort') }}</a></small>
                  </td>
                  <td :data-label="t('finance.expenses.category')">
                    <Badge v-if="fin.category(x.categoryId)" :tone="fin.category(x.categoryId)!.color">{{ fin.category(x.categoryId)!.name }}</Badge>
                  </td>
                  <td class="num" :data-label="t('finance.expenses.amount')">
                    <b>{{ money(x.paidAmount ?? x.amount) }}</b>
                    <small v-if="x.paidAmount != null && x.paidAmount !== x.amount">{{ t('finance.expenses.estimatedWas', { amount: money(x.amount) }) }}</small>
                  </td>
                  <td :data-label="t('finance.expenses.status')"><Badge :tone="badge(x).tone">{{ badge(x).label }}</Badge>
                    <small v-if="x.approvalStatus === 'pending' && x.createdBy">{{ t('finance.approval.by', { name: fin.memberName(x.createdBy) }) }}</small></td>
                  <td class="row-acts">
                    <template v-if="x.approvalStatus === 'pending' && fin.canApprove">
                      <Button size="sm" variant="primary" :loading="busy === x.id" @click="approve(x)"><Check :size="15" />{{ t('finance.approval.approve') }}</Button>
                      <button type="button" class="ico" :disabled="busy === x.id" :title="t('finance.approval.reject')" :aria-label="t('finance.approval.reject')" @click="reject(x)"><Ban :size="16" /></button>
                    </template>
                    <Button v-else-if="x.status === 'pending' && x.approvalStatus === 'approved'" size="sm" variant="primary" @click="paying = x"><CircleCheck :size="15" />{{ t('finance.expenses.pay') }}</Button>
                    <button v-if="x.status === 'pending'" type="button" class="ico" :title="t('finance.expenses.edit')" :aria-label="t('finance.expenses.edit')" @click="openExpense(x)"><Pencil :size="16" /></button>
                    <button v-if="x.status === 'pending' && x.scheduleId && x.approvalStatus === 'approved'" type="button" class="ico" :disabled="busy === x.id"
                      :title="t('finance.expenses.skip')" :aria-label="t('finance.expenses.skip')" @click="skip(x)"><SkipForward :size="16" /></button>
                    <button v-if="x.status === 'pending' && !x.scheduleId" type="button" class="ico" :title="t('finance.expenses.delete')" :aria-label="t('finance.expenses.delete')" @click="deleting = x"><Trash2 :size="16" /></button>
                    <button v-if="x.status !== 'pending'" type="button" class="ico" :disabled="busy === x.id" :title="t('finance.expenses.reopen')" :aria-label="t('finance.expenses.reopen')" @click="reopen(x)"><Undo2 :size="16" /></button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <Pagination v-if="data && rows.length" v-model="page" v-model:size="size" :total="total" :labels="pagerLabels" />
        </div>

        <!-- Columna de contexto: total por categoría del filtro actual -->
        <aside class="cats">
          <h3>{{ t('finance.expenses.byCategory') }}</h3>
          <p v-if="!byCategory.length" class="muted">{{ t('finance.expenses.byCategoryEmpty') }}</p>
          <ul v-else>
            <li v-for="c in byCategory" :key="c.categoryId">
              <button type="button" :class="{ on: f.category === c.categoryId }" @click="f.category = f.category === c.categoryId ? '' : c.categoryId">
                <span class="nm"><i :style="{ background: toneColor(c.cat?.color ?? 'gray') }" />{{ c.cat?.name ?? '—' }}</span>
                <b>{{ money(c.amount) }}</b>
                <span class="track" :style="{ width: c.width }"><span class="fill" :style="{ width: c.paidPct, background: toneColor(c.cat?.color ?? 'gray') }" /></span>
                <small>{{ t('finance.expenses.paidOf', { paid: money(c.paid) }) }}</small>
              </button>
            </li>
          </ul>
        </aside>
      </div>
    </template>

    <ExpenseModal v-model="modal" :expense="editing" @saved="refresh" />
    <PayExpenseModal :expense="paying" @close="paying = null" @saved="refresh" />
    <Modal v-model="deleteOpen" :title="t('finance.expenses.deleteTitle')" :subtitle="deleting ? `${deleting.vendor} · ${money(deleting.amount)} · ${day(deleting.dueDate)}` : ''">
      <p class="note">{{ t('finance.expenses.deleteNote') }}</p>
      <template #footer>
        <Button variant="ghost" @click="deleting = null">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="!!busy" @click="remove">{{ t('finance.expenses.delete') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.seg { display: flex; border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.seg button { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px; font: inherit; font-size: 14px; font-weight: 500; color: var(--color-ink);
  background: none; border: 0; border-left: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration); }
.seg button:first-child { border-left: 0; }
.seg button:hover { background: var(--color-canvas); }
.seg button[aria-selected="true"] { color: #fff; background: var(--color-ink); }
.seg .n { font-size: 12px; padding: 0 6px; font-variant-numeric: tabular-nums; background: rgb(255 255 255 / .16); }
.seg button[aria-selected="false"] .n { background: var(--color-canvas); border: 1px solid var(--color-line); }

.approvals { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 12px 16px; color: var(--color-warning); background: var(--color-warning-light);
  border-left: 4px solid var(--color-warning); box-shadow: var(--shadow-sm); }
.approvals span { flex: 1; min-width: 200px; color: var(--color-ink); font-weight: 500; }
.approvals button { padding: 0; font: inherit; font-weight: 700; color: var(--color-leaf); text-decoration: underline; background: none; border: 0; cursor: pointer; }

.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.filters :deep(.dd) { flex: 1 1 160px; min-width: 0; }
.filters :deep(.trigger) { min-width: 0; }
.acts { display: flex; gap: 8px; margin-left: auto; }
.exp { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 12px; font-size: 14px; font-weight: 500; color: var(--color-ink); text-decoration: none; background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration); }
.exp:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.scope { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: -6px 0 0; font-size: 13px; color: var(--color-muted); }
.scope button { padding: 0; font: inherit; font-weight: 600; color: var(--color-leaf); text-decoration: underline; background: none; border: 0; cursor: pointer; }

.totals { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1.1fr; gap: 14px; }
.tot { display: grid; gap: 2px; align-content: start; padding: 14px 18px; font: inherit; text-align: left; color: inherit; background: var(--color-surface); border: 0; box-shadow: var(--shadow-md); }
.tot.main { border-left: 4px solid var(--color-primary); }
.tot.ok b { color: var(--color-success); }
.tot small { font-size: 13px; color: var(--color-muted); }
.tot b { font-family: var(--font-display); font-size: 26px; font-variant-numeric: tabular-nums; }
.tot.main b { font-size: 32px; }
.tot span { font-size: 13px; color: var(--color-muted); }
.tot.late { border-right: 4px solid transparent; }
.tot.late.on { border-right-color: var(--color-danger); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.tot.late.on:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); }
.tot.late.on b { color: var(--color-danger); }

/* Lista con más peso a la izquierda; la columna de categorías acompaña a la derecha */
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
.list { display: grid; gap: 14px; min-width: 0; }
.list :deep(.empty) { max-width: none; }
.table-wrap { overflow-x: auto; background: var(--color-surface); box-shadow: var(--shadow-md); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 10px 14px; font-size: 12px; font-weight: 600; text-align: left; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); border-bottom: 1px solid var(--color-line); white-space: nowrap; }
td { padding: 10px 14px; vertical-align: top; border-bottom: 1px solid var(--color-line); }
td small { display: block; margin-top: 2px; font-size: 12px; color: var(--color-muted); }
tr:hover td { background: var(--color-canvas); }
tr.off td { color: var(--color-muted); }
tr.off b { text-decoration: line-through; }
tr.late td:first-child { box-shadow: inset 3px 0 0 var(--color-danger); color: var(--color-danger); font-weight: 600; }
.vendor b { display: inline-flex; align-items: center; gap: 6px; }
.rep { color: var(--color-primary-dark); flex: none; }
.meta { display: flex !important; flex-wrap: wrap; align-items: center; gap: 0 8px; }
.file { display: inline-flex; align-items: center; gap: 3px; color: var(--color-leaf); font-weight: 600; text-decoration: none; }
.file:hover { text-decoration: underline; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.row-acts { white-space: nowrap; text-align: right; }
.row-acts > * { vertical-align: middle; }
.ico { display: inline-grid; place-items: center; width: 32px; height: 32px; margin-left: 4px; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }

.cats { display: grid; gap: 12px; padding: 16px 18px; background: var(--color-surface); border-top: 4px solid var(--color-ink); box-shadow: var(--shadow-md); }
.cats h3 { margin: 0; font-size: 16px; }
.cats ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.cats li button { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; width: 100%; padding: 8px 8px 10px; font: inherit; text-align: left; color: inherit;
  background: none; border: 0; border-left: 3px solid transparent; cursor: pointer; transition: background var(--duration); }
.cats li button:hover { background: var(--color-canvas); }
.cats li button.on { background: var(--color-canvas); border-left-color: var(--color-primary); }
.nm { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm i { width: 10px; height: 10px; flex: none; }
.cats b { font-size: 14px; font-variant-numeric: tabular-nums; }
.track { grid-column: 1 / -1; display: block; height: 6px; background: var(--color-canvas-deep); }
.fill { display: block; height: 100%; }
.cats small { grid-column: 1 / -1; font-size: 12px; color: var(--color-muted); }
.muted { margin: 0; font-size: 13px; color: var(--color-muted); }

.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

@media (max-width: 1279px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .cats ul { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
}
@media (max-width: 767px) {
  .body { padding: 14px 16px 32px; }
  .seg { width: 100%; }
  .seg button { flex: 1; justify-content: center; padding: 0 8px; }
  .filters :deep(.dd) { flex: 1 1 calc(50% - 6px); }
  .acts { width: 100%; margin-left: 0; }
  .acts > * { flex: 1; justify-content: center; }
  .totals { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .tot { padding: 12px; }
  .tot.main { grid-column: 1 / -1; }
  .tot b { font-size: 18px; }
  .tot.main b { font-size: 28px; }
  /* Tabla como fichas: sin scroll horizontal a 390 px */
  .table-wrap { overflow: visible; }
  table, tbody, tr, td { display: block; }
  thead { display: none; }
  tbody tr { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; padding: 12px 14px; border-bottom: 1px solid var(--color-line); }
  tbody td { padding: 0; border: 0; }
  tr:hover td { background: none; }
  td.vendor { grid-column: 1 / -1; order: -1; }
  td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 2px; font-size: 11px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
  .num { text-align: left; }
  .row-acts { grid-column: 1 / -1; text-align: left; white-space: normal; }
  .row-acts .ico:first-child { margin-left: 0; }
  tr.late td:first-child { box-shadow: none; }
  tr.late { box-shadow: inset 3px 0 0 var(--color-danger); }
}
</style>
