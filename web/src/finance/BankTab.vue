<script setup lang="ts">
// Banco (fase C, docs/plan-finanzas.md §4): movimientos por cuenta con filtros (fecha, cuenta, compañía, entradas/salidas,
// cruce, búsqueda), totales del servidor (entradas, salidas, neto) y entradas por compañía; carga manual rápida,
// importación de CSV en pasos (ImportWizard) y estados de cuenta importados (BankStatements, con deshacer).
// Las cuentas se configuran en SetupBank.vue; si no hay ninguna, aquí mismo se crea la primera.
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Download, Upload, Pencil, Trash2, Landmark, FileSpreadsheet, ArrowLeftRight, Search, X, StickyNote } from 'lucide-vue-next';
import { MATCH_STATUS, type BankStatement, type BankTransaction, type BankTransactionsList, type MatchStatus } from '@agencia-hub/contracts';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Modal from '@/design/Modal.vue';
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
import { usd, fmtDay, financeRange, qs, FINANCE_PERIODS, type DateFilterValue } from './format.ts';
import BankTransactionModal from './BankTransactionModal.vue';
import ImportWizard from './ImportWizard.vue';
import BankStatements from './BankStatements.vue';
import BankAccountModal from './BankAccountModal.vue';

defineEmits<{ go: [tab: 'summary' | 'expenses' | 'payroll' | 'bank' | 'setup'] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const slug = () => s.workspace!.slug;
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);

// ─── Sub-vista: movimientos o estados de cuenta ───
const view = ref<'list' | 'statements'>('list');
const statements = ref<BankStatement[] | null>(null);
async function loadStatements() {
  try { statements.value = await api('GET /w/:slug/finance/bank/statements', { params: { slug: slug() } }); }
  catch (e) { statements.value = []; toast(errorText(e), 'error'); }
}

// ─── Filtros (fecha del movimiento) ───
const date = ref<DateFilterValue>({ period: 'month', from: '', to: '' });
const f = reactive({ account: '', carrier: '', direction: '' as '' | 'in' | 'out', match: '' as '' | MatchStatus, q: '', statement: '' });
const periodOptions = computed(() => FINANCE_PERIODS.filter((p) => p !== 'next30').map((v) => ({ value: v, label: t(`finance.periods.${v}`) })));
const accountOptions = computed(() => [{ value: '', label: t('finance.bank.allAccounts') },
  ...fin.accounts.map((a) => ({ value: a.id, label: a.name, hint: a.isActive ? (a.last4 ? `•••• ${a.last4}` : undefined) : t('finance.bank.accounts.inactive') }))]);
const carrierOptions = computed(() => [{ value: '', label: t('finance.bank.allCarriers') },
  ...fin.carriers.map((c) => ({ value: c.id, label: c.name }))]);
const directionOptions = computed(() => [{ value: '' as const, label: t('finance.bank.allDirections') },
  { value: 'in' as const, label: t('finance.bank.inflows') }, { value: 'out' as const, label: t('finance.bank.outflows') }]);
const matchOptions = computed(() => [{ value: '' as const, label: t('finance.bank.allMatch') },
  ...MATCH_STATUS.map((m) => ({ value: m, label: t(`finance.bank.match.${m}`) }))]);

/** La búsqueda espera a que se deje de escribir */
const search = ref('');
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, (v) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { f.q = v.trim(); }, 300); });

/** Filtrar por un estado de cuenta ignora el periodo: muestra todo lo que trajo ese archivo */
const query = computed(() => ({
  ...(f.statement ? { from: undefined, to: undefined } : financeRange(date.value)),
  accountId: f.account || undefined, carrierId: f.carrier || undefined, direction: f.direction || undefined,
  matchStatus: f.match || undefined, q: f.q || undefined, statementId: f.statement || undefined,
}));
const data = ref<BankTransactionsList | null>(null);
async function load() {
  data.value = null;
  try { data.value = await api('GET /w/:slug/finance/bank/transactions', { params: { slug: slug() }, query: query.value }); }
  catch (e) { data.value = { items: [], totals: { count: 0, inflow: 0, outflow: 0, net: 0 } }; toast(errorText(e), 'error'); }
}
watch(query, load, { immediate: true });
onMounted(loadStatements);
/** Tras importar o deshacer: lista, estados y cuentas (mapeo y último estado cambian) */
const refreshAll = () => Promise.all([load(), loadStatements(), fin.loadAccounts().catch(() => {})]);

const rows = computed(() => data.value?.items ?? []);
const { page, size, rows: pageRows, total } = usePaged(rows);
const pagerLabels = computed(() => ({ prev: t('common.pager.prev'), next: t('common.pager.next'), perPage: t('common.pager.perPage'), of: t('common.pager.of') }));
const csvUrl = computed(() => `/api/v1/w/${slug()}/finance/bank/transactions.csv?${qs(query.value)}`);
const multiAccount = computed(() => fin.accounts.length > 1);
const hasActive = computed(() => fin.accounts.some((a) => a.isActive));

/** Entradas por compañía del filtro actual (de los movimientos cargados), de mayor a menor; "sin compañía" al final */
const byCarrier = computed(() => {
  const sums = new Map<string, { amount: number; count: number }>();
  for (const x of rows.value) {
    if (x.amount <= 0) continue;
    const k = x.carrierId ?? '';
    const cur = sums.get(k) ?? { amount: 0, count: 0 };
    cur.amount += Math.round(x.amount * 100); cur.count++;
    sums.set(k, cur);
  }
  const list = [...sums].map(([id, v]) => ({ id, name: id ? fin.carrierName(id) : t('finance.bank.noCarrier'), amount: v.amount / 100, count: v.count }));
  const max = Math.max(1, ...list.map((x) => x.amount));
  return list.sort((a, b) => Number(!a.id) - Number(!b.id) || b.amount - a.amount).map((x) => ({ ...x, width: `${(x.amount / max) * 100}%` }));
});
const pickCarrier = (id: string) => { if (id) f.carrier = f.carrier === id ? '' : id; };

const statementLabel = computed(() => {
  const st = statements.value?.find((x) => x.id === f.statement);
  return st ? `${fin.account(st.accountId)?.name ?? ''} · ${day(st.periodFrom)} → ${day(st.periodTo)}` : '';
});
function viewStatement(id: string) { f.statement = id; view.value = 'list'; }

const matchTone = (m: MatchStatus) => (m === 'matched' ? 'success' : m === 'ignored' ? 'gray' : 'neutral');

// ─── Modales ───
const txModal = ref(false);
const editing = ref<BankTransaction | null>(null);
const openTx = (x: BankTransaction | null) => { editing.value = x; txModal.value = true; };
const importOpen = ref(false);
const accountModal = ref(false);
const deleting = ref<BankTransaction | null>(null);
const deleteOpen = computed({ get: () => !!deleting.value, set: (v) => { if (!v) deleting.value = null; } });
const busy = ref(false);
async function remove() {
  const x = deleting.value!;
  busy.value = true;
  try {
    await api('DELETE /w/:slug/finance/bank/transactions/:id', { params: { slug: slug(), id: x.id } });
    toast(t('finance.bank.deletedOk'), 'success');
    deleting.value = null;
    await load();
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
</script>

<template>
  <div class="body">
    <div class="bar">
      <div class="seg" role="tablist" :aria-label="t('finance.tabs.bank')">
        <button type="button" role="tab" :aria-selected="view === 'list'" @click="view = 'list'"><ArrowLeftRight :size="16" />{{ t('finance.bank.title') }}</button>
        <button type="button" role="tab" :aria-selected="view === 'statements'" @click="view = 'statements'">
          <FileSpreadsheet :size="16" />{{ t('finance.bank.statements.title') }}<span v-if="statements?.length" class="n">{{ statements.length }}</span>
        </button>
      </div>
      <div v-if="hasActive" class="acts">
        <a v-if="view === 'list'" :href="csvUrl" download class="exp"><Download :size="16" />CSV</a>
        <Button @click="importOpen = true"><Upload :size="16" />{{ t('finance.bank.import.short') }}</Button>
        <Button variant="primary" @click="openTx(null)"><Plus :size="17" />{{ t('finance.bank.manual.new') }}</Button>
      </div>
    </div>

    <!-- Sin cuentas activas: se crea la primera aquí mismo -->
    <EmptyState v-if="!hasActive" :icon="Landmark" :title="fin.accounts.length ? t('finance.bank.noActive') : t('finance.bank.noAccounts')" :text="t('finance.bank.noAccountsText')">
      <Button variant="primary" @click="accountModal = true"><Plus :size="16" />{{ t('finance.bank.accounts.new') }}</Button>
      <Button variant="ghost" @click="$emit('go', 'setup')">{{ t('finance.bank.goSetup') }}</Button>
    </EmptyState>

    <BankStatements v-if="view === 'statements'" :statements="statements" @view="viewStatement" @undone="refreshAll" @import="importOpen = true" />

    <template v-else-if="fin.accounts.length">
      <div class="filters">
        <DateFilter v-if="!f.statement" v-model="date" :presets="periodOptions" :label="t('finance.bank.date')" />
        <Dropdown v-if="multiAccount" v-model="f.account" :options="accountOptions" :aria-label="t('finance.bank.account')" />
        <Dropdown v-if="fin.carriers.length" v-model="f.carrier" :options="carrierOptions" searchable :search-placeholder="t('finance.bank.searchCarrier')" :aria-label="t('finance.bank.carrier')" />
        <Dropdown v-model="f.direction" :options="directionOptions" :aria-label="t('finance.bank.direction')" />
        <Dropdown v-model="f.match" :options="matchOptions" :aria-label="t('finance.bank.matchLabel')" />
        <label class="search">
          <Search :size="16" />
          <input v-model="search" type="search" :placeholder="t('finance.bank.searchPh')" :aria-label="t('finance.bank.searchPh')" maxlength="100">
        </label>
      </div>
      <p v-if="f.statement" class="scope">
        <FileSpreadsheet :size="15" />{{ t('finance.bank.statementFilter', { label: statementLabel }) }}
        <button type="button" @click="f.statement = ''"><X :size="14" />{{ t('finance.expenses.clear') }}</button>
      </p>

      <!-- Totales asimétricos: el neto pesa más; entradas en verde -->
      <div class="totals">
        <div class="tot main" :class="{ neg: (data?.totals.net ?? 0) < 0 }"><small>{{ t('finance.bank.net') }}</small><b>{{ money(data?.totals.net ?? 0) }}</b>
          <span>{{ t('finance.bank.nTx', { n: data?.totals.count ?? 0 }, data?.totals.count ?? 0) }}</span></div>
        <button type="button" class="tot in" :class="{ on: f.direction === 'in' }" @click="f.direction = f.direction === 'in' ? '' : 'in'">
          <small>{{ t('finance.bank.inflows') }}</small><b>+{{ money(data?.totals.inflow ?? 0) }}</b></button>
        <button type="button" class="tot out" :class="{ on: f.direction === 'out' }" @click="f.direction = f.direction === 'out' ? '' : 'out'">
          <small>{{ t('finance.bank.outflows') }}</small><b>−{{ money(data?.totals.outflow ?? 0) }}</b></button>
      </div>

      <div class="cols">
        <div class="list">
          <div v-if="!data" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="52px" /></div>
          <EmptyState v-else-if="!rows.length" :icon="ArrowLeftRight" :title="t('finance.bank.empty')" :text="t('finance.bank.emptyText')">
            <Button v-if="hasActive" variant="primary" @click="importOpen = true"><Upload :size="16" />{{ t('finance.bank.import.title') }}</Button>
            <Button v-if="hasActive" variant="ghost" @click="openTx(null)"><Plus :size="16" />{{ t('finance.bank.manual.new') }}</Button>
          </EmptyState>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{{ t('finance.bank.date') }}</th><th scope="col">{{ t('finance.bank.description') }}</th>
                  <th scope="col">{{ t('finance.bank.reference') }}</th><th v-if="fin.carriers.length" scope="col">{{ t('finance.bank.carrier') }}</th>
                  <th scope="col" class="num">{{ t('finance.bank.amount') }}</th><th scope="col">{{ t('finance.bank.matchLabel') }}</th>
                  <th scope="col"><span class="sr-only">{{ t('finance.expenses.actions') }}</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="x in pageRows" :key="x.id" :class="{ off: x.matchStatus === 'ignored', 'is-in': x.amount > 0 }">
                  <td class="nowrap" :data-label="t('finance.bank.date')">{{ day(x.postedOn) }}</td>
                  <td class="desc">
                    <b>{{ x.description || '—' }}</b>
                    <small class="meta">
                      <span class="src" :class="x.source">{{ t(`finance.bank.source.${x.source}`) }}</span>
                      <template v-if="multiAccount"> · {{ fin.account(x.accountId)?.name }}</template>
                      <span v-if="x.notes" class="nt" :title="x.notes"><StickyNote :size="12" />{{ x.notes }}</span>
                    </small>
                  </td>
                  <td class="refc" :data-label="t('finance.bank.reference')">{{ x.reference || '—' }}</td>
                  <td v-if="fin.carriers.length" :data-label="t('finance.bank.carrier')">
                    <button v-if="x.carrierId" type="button" class="carrier" :class="{ on: f.carrier === x.carrierId }" @click="pickCarrier(x.carrierId)">{{ fin.carrierName(x.carrierId) }}</button>
                    <span v-else class="none">—</span>
                  </td>
                  <td class="num amt" :class="x.amount > 0 ? 'in' : 'out'" :data-label="t('finance.bank.amount')">{{ x.amount > 0 ? '+' : '' }}{{ money(x.amount) }}</td>
                  <td :data-label="t('finance.bank.matchLabel')"><Badge :tone="matchTone(x.matchStatus)">{{ t(`finance.bank.match.${x.matchStatus}`) }}</Badge></td>
                  <td class="row-acts">
                    <button type="button" class="ico" :title="t('finance.bank.edit')" :aria-label="t('finance.bank.edit')" @click="openTx(x)"><Pencil :size="16" /></button>
                    <button v-if="x.source === 'manual'" type="button" class="ico" :title="t('finance.bank.delete')" :aria-label="t('finance.bank.delete')" @click="deleting = x"><Trash2 :size="16" /></button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <Pagination v-if="data && rows.length" v-model="page" v-model:size="size" :total="total" :labels="pagerLabels" />
        </div>

        <!-- Columna de contexto: entradas por compañía del filtro actual; tocar una filtra la lista -->
        <aside class="side">
          <h3>{{ t('finance.bank.byCarrier') }}</h3>
          <p v-if="!byCarrier.length" class="muted">{{ t('finance.bank.byCarrierEmpty') }}</p>
          <ul v-else>
            <li v-for="c in byCarrier" :key="c.id || 'none'">
              <button type="button" :class="{ on: c.id && f.carrier === c.id, none: !c.id }" :disabled="!c.id" @click="pickCarrier(c.id)">
                <span class="nm">{{ c.name }}</span>
                <b>{{ money(c.amount) }}</b>
                <span class="track"><span class="fill" :style="{ width: c.width }" /></span>
                <small>{{ t('finance.bank.nDeposits', { n: c.count }, c.count) }}</small>
              </button>
            </li>
          </ul>
          <p v-if="!fin.carriers.length" class="muted">{{ t('finance.bank.noCarriersHint') }}</p>
        </aside>
      </div>
    </template>

    <BankTransactionModal v-model="txModal" :transaction="editing" :account-id="f.account" @saved="load" />
    <ImportWizard v-model="importOpen" :account-id="f.account" @imported="refreshAll" @view="viewStatement" />
    <BankAccountModal v-model="accountModal" />
    <Modal v-model="deleteOpen" :title="t('finance.bank.deleteTitle')" :subtitle="deleting ? `${deleting.description || deleting.reference} · ${money(deleting.amount)} · ${day(deleting.postedOn)}` : ''">
      <p class="note">{{ t('finance.bank.deleteNote') }}</p>
      <template #footer>
        <Button variant="ghost" @click="deleting = null">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="busy" @click="remove">{{ t('finance.bank.delete') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
.body > :deep(.empty) { max-width: none; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.seg { display: flex; border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.seg button { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px; font: inherit; font-size: 14px; font-weight: 500; color: var(--color-ink);
  background: none; border: 0; border-left: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration); }
.seg button:first-child { border-left: 0; }
.seg button:hover { background: var(--color-canvas); }
.seg button[aria-selected="true"] { color: #fff; background: var(--color-ink); }
.seg .n { font-size: 12px; padding: 0 6px; font-variant-numeric: tabular-nums; background: rgb(255 255 255 / .16); }
.seg button[aria-selected="false"] .n { background: var(--color-canvas); border: 1px solid var(--color-line); }
.acts { display: flex; gap: 8px; margin-left: auto; }
.exp { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 12px; font-size: 14px; font-weight: 500; color: var(--color-ink); text-decoration: none; background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration); }
.exp:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }

.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.filters :deep(.dd) { flex: 1 1 160px; min-width: 0; }
.filters :deep(.trigger) { min-width: 0; }
.search { flex: 1.4 1 220px; display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 12px; color: var(--color-muted); background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: border-color var(--duration); }
.search:focus-within { border-color: var(--color-ink); }
.search input { flex: 1; width: 0; min-width: 0; font: inherit; color: var(--color-ink); background: none; border: 0; outline: none; }
.scope { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: -6px 0 0; padding: 8px 12px; font-size: 13px; color: var(--color-ink); background: var(--color-cat-blue-light); border-left: 3px solid var(--color-leaf); }
.scope svg { color: var(--color-leaf); flex: none; }
.scope button { display: inline-flex; align-items: center; gap: 4px; padding: 0; font: inherit; font-weight: 600; color: var(--color-leaf); text-decoration: underline; background: none; border: 0; cursor: pointer; }

.totals { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 14px; }
.tot { display: grid; gap: 2px; align-content: start; padding: 14px 18px; font: inherit; text-align: left; color: inherit; background: var(--color-surface); border: 0; box-shadow: var(--shadow-md); }
button.tot { cursor: pointer; border-bottom: 3px solid transparent; transition: box-shadow var(--duration), transform var(--duration); }
button.tot:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); }
.tot.main { border-left: 4px solid var(--color-primary); }
.tot small { font-size: 13px; color: var(--color-muted); }
.tot b { font-family: var(--font-display); font-size: 26px; font-variant-numeric: tabular-nums; }
.tot.main b { font-size: 32px; }
.tot.main.neg b { color: var(--color-danger); }
.tot span { font-size: 13px; color: var(--color-muted); }
.tot.in b { color: var(--color-success); }
.tot.in.on { border-bottom-color: var(--color-success); }
.tot.out.on { border-bottom-color: var(--color-ink); }

/* Lista con más peso a la izquierda; entradas por compañía acompaña a la derecha */
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
tr.is-in td:first-child { box-shadow: inset 3px 0 0 var(--color-success); }
.desc { min-width: 260px; }
.desc b { font-weight: 500; word-break: break-word; }
.meta { display: flex !important; flex-wrap: wrap; align-items: center; gap: 2px 8px; }
.src { padding: 0 5px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; border: 1px solid var(--color-line); background: var(--color-canvas); }
.src.csv { color: var(--color-leaf); border-color: var(--color-cat-blue-line); background: var(--color-cat-blue-light); }
.nt { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nt svg { flex: none; }
.refc { font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace; font-size: 13px; white-space: nowrap; }
.carrier { padding: 2px 8px; font: inherit; font-size: 13px; font-weight: 600; color: var(--color-leaf); background: var(--color-cat-blue-light); border: 1px solid var(--color-cat-blue-line); cursor: pointer; white-space: nowrap; }
.carrier:hover, .carrier.on { color: #fff; background: var(--color-leaf); border-color: var(--color-leaf); }
.none { color: var(--color-muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.amt { font-weight: 700; }
.amt.in { color: var(--color-success); }
.nowrap { white-space: nowrap; }
.row-acts { white-space: nowrap; text-align: right; }
.ico { display: inline-grid; place-items: center; width: 32px; height: 32px; margin-left: 4px; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }

.side { display: grid; gap: 12px; padding: 16px 18px; background: var(--color-surface); border-top: 4px solid var(--color-success); box-shadow: var(--shadow-md); }
.side h3 { margin: 0; font-size: 16px; }
.side ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.side li button { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; width: 100%; padding: 8px 8px 10px; font: inherit; text-align: left; color: inherit;
  background: none; border: 0; border-left: 3px solid transparent; cursor: pointer; transition: background var(--duration); }
.side li button:hover:not(:disabled) { background: var(--color-canvas); }
.side li button.on { background: var(--color-canvas); border-left-color: var(--color-success); }
.side li button.none { cursor: default; color: var(--color-muted); }
.nm { min-width: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side b { font-size: 14px; font-variant-numeric: tabular-nums; color: var(--color-success); }
.side button.none b { color: var(--color-muted); }
.track { grid-column: 1 / -1; display: block; height: 6px; background: var(--color-canvas-deep); }
.fill { display: block; height: 100%; background: var(--color-success); }
.side button.none .fill { background: var(--color-line-strong); }
.side small { grid-column: 1 / -1; font-size: 12px; color: var(--color-muted); }
.muted { margin: 0; font-size: 13px; color: var(--color-muted); }

.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

@media (max-width: 1279px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .side ul { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
}
@media (max-width: 767px) {
  .body { padding: 14px 16px 32px; }
  .seg { width: 100%; }
  .seg button { flex: 1; justify-content: center; padding: 0 8px; }
  .filters :deep(.dd) { flex: 1 1 calc(50% - 6px); }
  .search { flex-basis: 100%; }
  /* Tres acciones no caben en una fila: la principal baja a todo el ancho */
  .acts { width: 100%; margin-left: 0; flex-wrap: wrap; }
  .acts > * { flex: 1; justify-content: center; }
  .acts .exp { flex: none; }
  .acts > .primary { flex-basis: 100%; order: 3; }
  .totals { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .tot { padding: 12px; }
  .tot.main { grid-column: 1 / -1; }
  .tot b { font-size: 18px; }
  .tot.main b { font-size: 28px; }
  /* Tabla como fichas: sin scroll horizontal a 390 px */
  .table-wrap { overflow: visible; }
  table, tbody, tr, td { display: block; }
  thead { display: none; }
  tbody tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; padding: 12px 14px; border-bottom: 1px solid var(--color-line); }
  tbody td { padding: 0; border: 0; }
  tr:hover td { background: none; }
  tr.is-in td:first-child { box-shadow: none; }
  tr.is-in { box-shadow: inset 3px 0 0 var(--color-success); }
  td.desc { grid-column: 1 / -1; order: -1; min-width: 0; }
  td.amt { order: -1; grid-column: 1 / -1; font-size: 18px; }
  td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 2px; font-size: 11px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
  td.amt::before { display: none !important; }
  .num { text-align: left; }
  .refc { white-space: normal; word-break: break-all; }
  .row-acts { grid-column: 1 / -1; text-align: left; white-space: normal; }
  .row-acts .ico:first-child { margin-left: 0; }
}
</style>
