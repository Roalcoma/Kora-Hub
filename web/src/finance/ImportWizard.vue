<script setup lang="ts">
// Importar un estado de cuenta en CSV, en pasos (docs/plan-finanzas.md §4):
//   1. cuenta + archivo (context 'bank_statement');
//   2. columnas: solo si la cuenta no tiene mapeo guardado (o se pide "cambiar columnas"). Se muestran cabeceras y
//      filas de muestra; Kora adivina columnas y formato de fecha por los nombres y los valores;
//   3. vista previa interpretada por el servidor: válidas, duplicadas, inválidas, periodo, compañía sugerida editable;
//   4. resultado.
// El separador no lo devuelve el servidor: se deduce probando cuál reproduce el número de columnas que él detectó.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Upload, Columns3, ListChecks, CircleCheck, ArrowLeft, ArrowRight, TriangleAlert, Copy, CircleAlert, Settings2 } from 'lucide-vue-next';
import { CSV_DATE_FORMATS, type BankStatement, type CsvMapping, type ImportPreview, type ImportRow } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Pagination from '@/design/Pagination.vue';
import { usePaged } from '@/design/paged.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { usd, fmtDay } from './format.ts';
import FileField from './FileField.vue';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ accountId?: string }>();
const emit = defineEmits<{ imported: [statement: BankStatement]; view: [statementId: string] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);

type Step = 1 | 2 | 3 | 4;
const step = ref<Step>(1);
const accountId = ref('');
const fileId = ref<string | null>(null);
const uploading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
/** El paso 2 se saltó porque la cuenta ya tenía mapeo */
const usedSaved = ref(false);
/** Cabeceras y filas crudas para elegir columnas */
const raw = ref<{ headers: string[] | null; sample: string[][] }>({ headers: null, sample: [] });
const preview = ref<ImportPreview | null>(null);
const remember = ref(true);
/** Compañía elegida por línea ('' = ninguna); arranca con la sugerida */
const fixes = reactive(new Map<number, string>());
const result = ref<BankStatement | null>(null);
const resultInvalid = ref(0);

// ─── Mapeo en edición (los índices van como texto por el Dropdown) ───
type Delim = CsvMapping['delimiter'];
type DateFormat = CsvMapping['dateFormat'];
const m = reactive({
  delimiter: ',' as Delim, hasHeader: true, skipRows: 0,
  dateColumn: '', dateFormat: 'MM/DD/YYYY' as DateFormat, descriptionColumn: '', referenceColumn: '',
  mode: 'single' as 'single' | 'split', column: '', invert: false, debitColumn: '', creditColumn: '',
});
function toMapping(): CsvMapping {
  return {
    delimiter: m.delimiter, hasHeader: m.hasHeader, skipRows: Math.max(0, Math.min(50, Math.trunc(m.skipRows) || 0)),
    dateColumn: Number(m.dateColumn), dateFormat: m.dateFormat, descriptionColumn: Number(m.descriptionColumn),
    referenceColumn: m.referenceColumn === '' ? null : Number(m.referenceColumn),
    amount: m.mode === 'single'
      ? { mode: 'single', column: Number(m.column), invert: m.invert }
      : { mode: 'split', debitColumn: Number(m.debitColumn), creditColumn: Number(m.creditColumn) },
  };
}
function fromMapping(x: CsvMapping) {
  Object.assign(m, {
    delimiter: x.delimiter, hasHeader: x.hasHeader, skipRows: x.skipRows, dateColumn: String(x.dateColumn), dateFormat: x.dateFormat,
    descriptionColumn: String(x.descriptionColumn), referenceColumn: x.referenceColumn == null ? '' : String(x.referenceColumn),
    mode: x.amount.mode,
    column: x.amount.mode === 'single' ? String(x.amount.column) : '', invert: x.amount.mode === 'single' && x.amount.invert,
    debitColumn: x.amount.mode === 'split' ? String(x.amount.debitColumn) : '', creditColumn: x.amount.mode === 'split' ? String(x.amount.creditColumn) : '',
  });
}

// ─── Apertura ───
watch(open, (v) => {
  if (!v) return;
  const active = fin.accounts.filter((a) => a.isActive);
  accountId.value = props.accountId && active.some((a) => a.id === props.accountId) ? props.accountId : active[0]?.id ?? '';
  restart();
});
function restart() {
  step.value = 1; fileId.value = null; preview.value = null; result.value = null; error.value = null;
  usedSaved.value = false; remember.value = true; fixes.clear(); raw.value = { headers: null, sample: [] };
}
watch([accountId, fileId], () => { preview.value = null; error.value = null; });

const account = computed(() => fin.account(accountId.value));
const accountOptions = computed(() => fin.accounts.filter((a) => a.isActive).map((a) => ({
  value: a.id, label: a.name, hint: a.hasMapping ? t('finance.bank.import.mappingSaved') : t('finance.bank.import.mappingNone'),
})));

// ─── Llamadas ───
const callPreview = (mapping?: CsvMapping) => api('POST /w/:slug/finance/bank/import/preview', {
  params: { slug: s.workspace!.slug }, body: { accountId: accountId.value, fileId: fileId.value!, mapping },
});
async function guarded(fn: () => Promise<void>) {
  busy.value = true; error.value = null;
  try { await fn(); } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}

/** Paso 1 → 3 si la cuenta ya tiene mapeo; si no, → 2 */
const start = () => guarded(async () => {
  const p = await callPreview();
  if (p.mapping) {
    fromMapping(p.mapping);
    usedSaved.value = true;
    showPreview(p);
    return;
  }
  usedSaved.value = false;
  await detectDelimiter(p);
  guessColumns();
  step.value = 2;
});

const DELIMS: Delim[] = [',', ';', '\t', '|'];
/** Prueba separadores hasta reproducir el número de columnas que detectó el servidor */
async function detectDelimiter(p: ImportPreview) {
  const target = (p.headers ?? p.sample[0])?.length ?? 0;
  m.hasHeader = !!p.headers; m.skipRows = 0;
  raw.value = { headers: p.headers, sample: p.sample };
  if (target <= 1) { m.delimiter = ','; return; }
  for (const d of DELIMS) {
    m.delimiter = d;
    const r = await callPreview(probe());
    if (((r.headers ?? r.sample[0])?.length ?? 0) === target) { raw.value = { headers: r.headers, sample: r.sample }; return; }
  }
  m.delimiter = ',';
}
/** Mapeo mínimo válido para pedirle al servidor solo las filas crudas */
const probe = (): CsvMapping => ({ ...toMapping(), dateColumn: 0, descriptionColumn: 0, referenceColumn: null, amount: { mode: 'single', column: 0, invert: false } });

/** Cambiar separador, encabezado o filas a omitir vuelve a leer lo crudo */
let rawTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => [m.delimiter, m.hasHeader, m.skipRows], () => {
  if (step.value !== 2 || busy.value) return;
  clearTimeout(rawTimer);
  rawTimer = setTimeout(() => guarded(async () => {
    const r = await callPreview(probe());
    raw.value = { headers: r.headers, sample: r.sample };
  }), 350);
});

const colCount = computed(() => Math.max(raw.value.headers?.length ?? 0, ...raw.value.sample.map((r) => r.length), 0));
const colName = (i: number) => raw.value.headers?.[i]?.trim() || t('finance.bank.import.colN', { n: i + 1 });
const columnOptions = computed(() => Array.from({ length: colCount.value }, (_, i) => ({
  value: String(i), label: colName(i), hint: raw.value.sample.find((r) => r[i]?.trim())?.[i]?.trim().slice(0, 28),
})));
const refOptions = computed(() => [{ value: '', label: t('finance.bank.import.noReference') }, ...columnOptions.value]);
const delimOptions = computed(() => DELIMS.map((d) => ({ value: d, label: t(`finance.bank.import.delims.${d === '\t' ? 'tab' : d === ',' ? 'comma' : d === ';' ? 'semicolon' : 'pipe'}`) })));
const dateFormatOptions = CSV_DATE_FORMATS.map((f) => ({ value: f, label: f }));

/** Adivina columnas por el nombre de la cabecera y el formato de fecha por los valores */
function guessColumns() {
  const h = (raw.value.headers ?? []).map((x) => x.toLowerCase());
  const find = (re: RegExp, not?: number[]) => { const i = h.findIndex((x, j) => re.test(x) && !not?.includes(j)); return i >= 0 ? String(i) : ''; };
  const n = colCount.value;
  m.dateColumn = find(/post|fecha|date/) || (n ? '0' : '');
  m.descriptionColumn = find(/desc|concept|detalle|memo|payee|narr/) || (n > 1 ? '1' : '');
  m.referenceColumn = find(/ref|check|cheque|slip|n[uú]m|confirm/);
  const debit = find(/debit|d[eé]bito|withdraw|retiro|cargo/), credit = find(/credit|cr[eé]dito|deposit|dep[oó]sito|abono/);
  const single = find(/amount|monto|importe|valor/);
  if (!single && debit && credit) { m.mode = 'split'; m.debitColumn = debit; m.creditColumn = credit; }
  else { m.mode = 'single'; m.column = single || (n > 2 ? '2' : ''); }
  m.invert = false;
  // Formato de fecha: AAAA-MM-DD, o DD/MM si algún primer número pasa de 12; año de 2 dígitos → YY
  const vals = raw.value.sample.map((r) => r[Number(m.dateColumn)]?.trim().split(/[\sT]/)[0] ?? '').filter(Boolean);
  const parts = vals.map((v) => v.split(/[/\-.]/));
  const sep = vals[0]?.includes('-') ? '-' : '/';
  if (parts[0]?.[0]?.length === 4) m.dateFormat = 'YYYY-MM-DD';
  else {
    // Cuántas filas son fechas posibles con mes primero y con día primero; empate → mes primero (bancos de EE. UU.)
    const fits = (mi: number, di: number) => parts.filter((p) => Number(p[mi]) >= 1 && Number(p[mi]) <= 12 && Number(p[di]) >= 1 && Number(p[di]) <= 31).length;
    const dayFirst = fits(1, 0) > fits(0, 1);
    const short = parts[0]?.[2]?.length === 2;
    const f = `${dayFirst ? 'DD' : 'MM'}${sep}${dayFirst ? 'MM' : 'DD'}${sep}${short ? 'YY' : 'YYYY'}`;
    m.dateFormat = (CSV_DATE_FORMATS as readonly string[]).includes(f) ? f as DateFormat : 'MM/DD/YYYY';
  }
}

/** Qué rol cumple cada columna (para marcar la muestra) */
const roles = computed(() => {
  const out = new Map<number, string>();
  const put = (c: string, k: string) => { if (c !== '') out.set(Number(c), [out.get(Number(c)), t(`finance.bank.import.roles.${k}`)].filter(Boolean).join(' · ')); };
  put(m.dateColumn, 'date'); put(m.descriptionColumn, 'description'); put(m.referenceColumn, 'reference');
  if (m.mode === 'single') put(m.column, 'amount'); else { put(m.debitColumn, 'debit'); put(m.creditColumn, 'credit'); }
  return out;
});
const mappingValid = computed(() => m.dateColumn !== '' && m.descriptionColumn !== ''
  && (m.mode === 'single' ? m.column !== '' : m.debitColumn !== '' && m.creditColumn !== '' && m.debitColumn !== m.creditColumn));

/** Paso 2 → 3 */
const interpret = () => guarded(async () => { showPreview(await callPreview(toMapping())); });
function showPreview(p: ImportPreview) {
  preview.value = p;
  fixes.clear();
  for (const r of p.rows) fixes.set(r.line, r.carrierId ?? '');
  view.value = 'all';
  step.value = 3;
}
/** "Cambiar columnas" desde la vista previa */
function editColumns() {
  if (preview.value?.mapping) fromMapping(preview.value.mapping);
  raw.value = { headers: preview.value?.headers ?? null, sample: preview.value?.sample ?? [] };
  step.value = 2;
}

// ─── Paso 3: vista previa ───
const view = ref<'all' | 'import' | 'skip'>('all');
const importable = (r: ImportRow) => !r.error && !r.duplicate;
const rows = computed(() => (preview.value?.rows ?? []).filter((r) => view.value === 'all' || (view.value === 'import') === importable(r)));
const { page, size, rows: pageRows, total } = usePaged(rows);
const pagerLabels = computed(() => ({ prev: t('common.pager.prev'), next: t('common.pager.next'), perPage: t('common.pager.perPage'), of: t('common.pager.of') }));
const sums = computed(() => {
  const ok = (preview.value?.rows ?? []).filter(importable);
  const cents = (f: (n: number) => boolean) => ok.reduce((a, r) => a + (f(r.amount!) ? Math.round(r.amount! * 100) : 0), 0) / 100;
  return { inflow: cents((n) => n > 0), outflow: Math.abs(cents((n) => n < 0)) };
});
const carrierOptions = computed(() => [{ value: '', label: t('finance.bank.noCarrier') },
  ...fin.carriers.filter((c) => !c.archivedAt).map((c) => ({ value: c.id, label: c.name }))]);
/** Los errores de fila llegan en español desde el servidor: se traducen los conocidos */
const ROW_ERRORS: Record<string, string> = { 'Fecha ilegible': 'badDate', 'Monto ilegible': 'badAmount', 'Monto en cero': 'zeroAmount', 'Monto fuera de rango': 'outOfRange' };
const rowError = (e: string) => (ROW_ERRORS[e] ? t(`finance.bank.import.errors.${ROW_ERRORS[e]}`) : e);

const commit = () => guarded(async () => {
  const p = preview.value!;
  const changes = p.rows.filter((r) => importable(r) && (fixes.get(r.line) ?? '') !== (r.carrierId ?? ''))
    .map((r) => ({ line: r.line, carrierId: fixes.get(r.line) || null }));
  const st = await api('POST /w/:slug/finance/bank/import/commit', { params: { slug: s.workspace!.slug }, body: {
    accountId: accountId.value, fileId: fileId.value!, mapping: p.mapping!, saveMapping: remember.value,
    carriers: changes.length ? changes : undefined,
  } });
  result.value = st;
  resultInvalid.value = p.totals.invalid;
  step.value = 4;
  emit('imported', st);
});

const STEPS = [
  { n: 1, icon: Upload, key: 'file' }, { n: 2, icon: Columns3, key: 'columns' },
  { n: 3, icon: ListChecks, key: 'review' }, { n: 4, icon: CircleCheck, key: 'done' },
] as const;
const subtitle = computed(() => (account.value ? `${account.value.name}${account.value.last4 ? ` · •••• ${account.value.last4}` : ''}` : t('finance.bank.import.hint')));
</script>

<template>
  <Modal v-model="open" :title="t('finance.bank.import.title')" :subtitle="subtitle" width="1040px">
    <!-- Pasos: el actual resaltado; el 2 se marca "guardadas" si se saltó -->
    <ol class="steps">
      <li v-for="x in STEPS" :key="x.n" :class="{ on: step === x.n, done: step > x.n, skipped: x.n === 2 && usedSaved && step > 2 }">
        <span class="n"><component :is="x.icon" :size="15" /></span>
        <span class="lb">{{ t(`finance.bank.import.steps.${x.key}`) }}<small v-if="x.n === 2 && usedSaved && step > 2">{{ t('finance.bank.import.savedShort') }}</small></span>
      </li>
    </ol>

    <!-- 1 · Cuenta y archivo -->
    <section v-if="step === 1" class="s1">
      <div class="pick">
        <Dropdown v-model="accountId" :options="accountOptions" :label="t('finance.bank.account')" :placeholder="t('finance.bank.pickAccount')" />
        <FileField v-model="fileId" context="bank_statement" accept=".csv,text/csv" :label="t('finance.bank.import.file')"
          :hint="t('finance.bank.import.fileHint')" @uploading="uploading = $event" />
      </div>
      <aside class="tip">
        <b>{{ account?.hasMapping ? t('finance.bank.import.tipSavedTitle') : t('finance.bank.import.tipTitle') }}</b>
        <p>{{ account?.hasMapping ? t('finance.bank.import.tipSaved') : t('finance.bank.import.tip') }}</p>
        <p class="muted">{{ t('finance.bank.import.tipDupes') }}</p>
      </aside>
    </section>

    <!-- 2 · Columnas -->
    <section v-else-if="step === 2" class="s2">
      <div class="map">
        <Dropdown v-model="m.dateColumn" :options="columnOptions" :label="t('finance.bank.import.roles.date')" :placeholder="t('finance.bank.import.pickColumn')" />
        <Dropdown v-model="m.dateFormat" :options="dateFormatOptions" :label="t('finance.bank.import.dateFormat')" />
        <Dropdown v-model="m.descriptionColumn" :options="columnOptions" :label="t('finance.bank.import.roles.description')" :placeholder="t('finance.bank.import.pickColumn')" />
        <Dropdown v-model="m.referenceColumn" :options="refOptions" :label="t('finance.bank.import.referenceOpt')" />
        <div class="amount">
          <span class="lbl">{{ t('finance.bank.import.amountMode') }}</span>
          <div class="seg" role="radiogroup" :aria-label="t('finance.bank.import.amountMode')">
            <button type="button" role="radio" :aria-checked="m.mode === 'single'" @click="m.mode = 'single'">{{ t('finance.bank.import.single') }}</button>
            <button type="button" role="radio" :aria-checked="m.mode === 'split'" @click="m.mode = 'split'">{{ t('finance.bank.import.split') }}</button>
          </div>
          <div v-if="m.mode === 'single'" class="pair one">
            <Dropdown v-model="m.column" :options="columnOptions" :label="t('finance.bank.import.roles.amount')" :placeholder="t('finance.bank.import.pickColumn')" />
            <label class="check"><input v-model="m.invert" type="checkbox"><span>{{ t('finance.bank.import.invert') }}<small>{{ t('finance.bank.import.invertHint') }}</small></span></label>
          </div>
          <div v-else class="pair">
            <Dropdown v-model="m.debitColumn" :options="columnOptions" :label="t('finance.bank.import.roles.debit')" :placeholder="t('finance.bank.import.pickColumn')" />
            <Dropdown v-model="m.creditColumn" :options="columnOptions" :label="t('finance.bank.import.roles.credit')" :placeholder="t('finance.bank.import.pickColumn')" />
          </div>
        </div>
        <details class="adv">
          <summary><Settings2 :size="15" />{{ t('finance.bank.import.advanced') }}</summary>
          <div class="adv-body">
            <Dropdown v-model="m.delimiter" :options="delimOptions" :label="t('finance.bank.import.delimiter')" />
            <label class="skip">{{ t('finance.bank.import.skipRows') }}<input v-model.number="m.skipRows" type="number" min="0" max="50"></label>
            <label class="check"><input v-model="m.hasHeader" type="checkbox"><span>{{ t('finance.bank.import.hasHeader') }}</span></label>
          </div>
        </details>
      </div>

      <div class="sample">
        <h3>{{ t('finance.bank.import.sampleTitle') }}</h3>
        <p class="muted">{{ t('finance.bank.import.sampleHint') }}</p>
        <div class="sample-wrap">
          <table>
            <thead>
              <tr>
                <th v-for="i in colCount" :key="i" :class="{ used: roles.has(i - 1) }">
                  <span v-if="roles.has(i - 1)" class="role">{{ roles.get(i - 1) }}</span>{{ colName(i - 1) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, j) in raw.sample.slice(0, 6)" :key="j">
                <td v-for="i in colCount" :key="i" :class="{ used: roles.has(i - 1) }">{{ r[i - 1] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 3 · Vista previa -->
    <section v-else-if="step === 3 && preview" class="s3">
      <div class="stats">
        <div class="st main"><small>{{ t('finance.bank.import.valid') }}</small><b>{{ preview.totals.valid }}</b>
          <span>{{ t('finance.bank.import.ofRows', { n: preview.totals.rows }) }}</span></div>
        <div class="st"><small>{{ t('finance.bank.inflows') }}</small><b class="in">{{ money(sums.inflow) }}</b></div>
        <div class="st"><small>{{ t('finance.bank.outflows') }}</small><b>{{ money(sums.outflow) }}</b></div>
        <div class="st" :class="{ warn: preview.totals.duplicates }"><small>{{ t('finance.bank.import.duplicates') }}</small><b>{{ preview.totals.duplicates }}</b></div>
        <div class="st" :class="{ bad: preview.totals.invalid }"><small>{{ t('finance.bank.import.invalid') }}</small><b>{{ preview.totals.invalid }}</b></div>
        <div class="st per"><small>{{ t('finance.bank.import.period') }}</small>
          <b>{{ preview.period ? `${day(preview.period.from)} → ${day(preview.period.to)}` : '—' }}</b></div>
      </div>

      <div class="bar">
        <div class="seg" role="tablist">
          <button type="button" role="tab" :aria-selected="view === 'all'" @click="view = 'all'">{{ t('finance.bank.import.viewAll') }}</button>
          <button type="button" role="tab" :aria-selected="view === 'import'" @click="view = 'import'">{{ t('finance.bank.import.viewImport') }}</button>
          <button type="button" role="tab" :aria-selected="view === 'skip'" @click="view = 'skip'">{{ t('finance.bank.import.viewSkip') }}</button>
        </div>
        <button type="button" class="link" @click="editColumns"><Columns3 :size="15" />{{ t('finance.bank.import.changeColumns') }}</button>
      </div>

      <p v-if="!preview.totals.valid" class="warnbox"><TriangleAlert :size="16" />{{ !preview.totals.rows ? t('finance.bank.import.noRows') : preview.totals.duplicates ? t('finance.bank.import.allDuplicates') : t('finance.bank.import.nothing') }}</p>

      <div class="rows-wrap">
        <table class="rows">
          <thead>
            <tr>
              <th scope="col" class="ln">#</th><th scope="col">{{ t('finance.bank.date') }}</th><th scope="col">{{ t('finance.bank.description') }}</th>
              <th scope="col">{{ t('finance.bank.reference') }}</th><th scope="col" class="num">{{ t('finance.bank.amount') }}</th>
              <th v-if="fin.carriers.length" scope="col">{{ t('finance.bank.carrier') }}</th><th scope="col">{{ t('finance.bank.import.rowStatus') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in pageRows" :key="r.line" :class="{ bad: r.error, dupe: r.duplicate }">
              <td class="ln">{{ r.line }}</td>
              <td class="nowrap" :data-label="t('finance.bank.date')">{{ r.postedOn ? day(r.postedOn) : '—' }}</td>
              <td class="desc">{{ r.description || '—' }}</td>
              <td class="refc" :data-label="t('finance.bank.reference')">{{ r.reference || '—' }}</td>
              <td class="num" :data-label="t('finance.bank.amount')"><b :class="{ in: (r.amount ?? 0) > 0 }">{{ r.amount == null ? '—' : money(r.amount) }}</b></td>
              <td v-if="fin.carriers.length" class="car" :data-label="t('finance.bank.carrier')">
                <Dropdown v-if="importable(r) && (r.amount ?? 0) > 0" :model-value="fixes.get(r.line) ?? ''" :options="carrierOptions" searchable
                  :search-placeholder="t('finance.bank.searchCarrier')" :aria-label="t('finance.bank.carrier')" @update:model-value="(v) => fixes.set(r.line, v ?? '')" />
                <span v-else class="muted">—</span>
                <small v-if="importable(r) && r.carrierId && fixes.get(r.line) === r.carrierId" class="sug">{{ t('finance.bank.import.suggested') }}</small>
              </td>
              <td class="stc">
                <Badge v-if="r.error" tone="danger"><CircleAlert :size="12" />{{ rowError(r.error) }}</Badge>
                <Badge v-else-if="r.duplicate" tone="warning"><Copy :size="12" />{{ t('finance.bank.import.dupBadge') }}</Badge>
                <Badge v-else tone="success">{{ t('finance.bank.import.okBadge') }}</Badge>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!rows.length" class="muted pad">{{ t('finance.bank.import.viewEmpty') }}</p>
      </div>
      <Pagination v-if="rows.length" v-model="page" v-model:size="size" :total="total" :labels="pagerLabels" />

      <label class="check remember"><input v-model="remember" type="checkbox">
        <span>{{ t('finance.bank.import.remember', { account: account?.name ?? '' }) }}<small>{{ t('finance.bank.import.rememberHint') }}</small></span></label>
    </section>

    <!-- 4 · Resultado -->
    <section v-else-if="step === 4 && result" class="s4">
      <div class="result">
        <CircleCheck :size="30" />
        <div>
          <h3>{{ t('finance.bank.import.doneTitle', { n: result.rowsImported }, result.rowsImported) }}</h3>
          <p>{{ t('finance.bank.import.doneText', { from: day(result.periodFrom), to: day(result.periodTo), account: account?.name ?? '' }) }}</p>
          <ul>
            <li v-if="result.rowsSkipped">{{ t('finance.bank.import.doneSkipped', { n: result.rowsSkipped }, result.rowsSkipped) }}</li>
            <li v-if="resultInvalid">{{ t('finance.bank.import.doneInvalid', { n: resultInvalid }, resultInvalid) }}</li>
            <li>{{ remember ? t('finance.bank.import.doneMapping') : t('finance.bank.import.doneNoMapping') }}</li>
          </ul>
        </div>
      </div>
    </section>

    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <template #footer>
      <template v-if="step === 1">
        <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="busy" :disabled="!accountId || !fileId || uploading" @click="start">{{ t('common.continue') }}<ArrowRight :size="16" /></Button>
      </template>
      <template v-else-if="step === 2">
        <Button variant="ghost" @click="step = 1"><ArrowLeft :size="16" />{{ t('common.back') }}</Button>
        <Button variant="primary" :loading="busy" :disabled="!mappingValid" @click="interpret">{{ t('finance.bank.import.toPreview') }}<ArrowRight :size="16" /></Button>
      </template>
      <template v-else-if="step === 3">
        <Button variant="ghost" @click="usedSaved ? step = 1 : editColumns()"><ArrowLeft :size="16" />{{ t('common.back') }}</Button>
        <Button variant="primary" :loading="busy" :disabled="!preview?.totals.valid" @click="commit">
          {{ t('finance.bank.import.commit', { n: preview?.totals.valid ?? 0 }, preview?.totals.valid ?? 0) }}</Button>
      </template>
      <template v-else>
        <Button variant="ghost" @click="restart">{{ t('finance.bank.import.another') }}</Button>
        <Button @click="open = false">{{ t('common.close') }}</Button>
        <Button variant="primary" @click="emit('view', result!.id); open = false">{{ t('finance.bank.import.viewTx') }}</Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
/* Pasos: barra asimétrica con acento en el actual */
.steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; padding: 0; list-style: none; border-bottom: 1px solid var(--color-line); }
.steps li { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 8px 10px 0; font-size: 13px; color: var(--color-muted); border-bottom: 3px solid transparent; margin-bottom: -1px; }
.steps .n { display: grid; place-items: center; width: 28px; height: 28px; flex: none; background: var(--color-canvas-deep); }
.steps .lb { display: grid; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.steps .lb small { font-weight: 400; font-size: 11px; }
.steps li.on { color: var(--color-ink); border-bottom-color: var(--color-primary); }
.steps li.on .n { background: var(--color-primary); color: var(--color-ink); box-shadow: var(--shadow-sm); }
.steps li.done { color: var(--color-ink); }
.steps li.done .n { background: var(--color-ink); color: #fff; }
.steps li.skipped .n { background: var(--color-success); }

.s1 { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.pick { display: grid; gap: 18px; }
.tip { display: grid; gap: 6px; padding: 14px 16px; font-size: 14px; line-height: 1.5; background: var(--color-canvas); border-left: 4px solid var(--color-leaf); box-shadow: var(--shadow-sm); }
.tip p { margin: 0; }
.muted { margin: 0; color: var(--color-muted); font-size: 13px; }

.s2 { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(0, 1.4fr); gap: 22px; align-items: start; }
.map { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 12px; align-content: start; }
.amount { grid-column: 1 / -1; display: grid; gap: 8px; padding: 12px 14px; background: var(--color-canvas); border-left: 4px solid var(--color-primary); }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; }
.pair.one { grid-template-columns: minmax(0, 1fr); }
.lbl { font-size: 13px; font-weight: 500; }
.seg { display: flex; justify-self: start; border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.seg button { min-height: 36px; padding: 0 14px; font: inherit; font-size: 13px; font-weight: 500; color: var(--color-ink); background: none; border: 0; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--color-line); }
.seg button[aria-checked="true"], .seg button[aria-selected="true"] { color: #fff; background: var(--color-ink); }
.check { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; font-weight: 500; cursor: pointer; }
.check input { margin-top: 2px; flex: none; }
.check span { display: grid; gap: 2px; }
.check small { font-size: 12px; font-weight: 400; color: var(--color-muted); }
.adv { grid-column: 1 / -1; font-size: 14px; }
.adv summary { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--color-leaf); cursor: pointer; list-style: none; }
.adv summary::-webkit-details-marker { display: none; }
.adv-body { display: grid; grid-template-columns: 1fr 120px; gap: 12px; margin-top: 10px; align-items: end; }
.adv-body .check { grid-column: 1 / -1; }
.skip { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.skip input { min-height: 40px; padding: 0 10px; font: inherit; border: 1px solid var(--color-line-strong); background: var(--color-surface); }

.sample { display: grid; gap: 6px; min-width: 0; }
.sample h3 { margin: 0; font-size: 15px; }
/* La muestra cruda puede tener muchas columnas: desplaza dentro de su caja, nunca la página */
.sample-wrap { overflow: auto; max-height: 360px; margin-top: 4px; background: var(--color-surface); box-shadow: var(--shadow-md); border: 1px solid var(--color-line); }
.sample table { border-collapse: collapse; font-size: 13px; }
.sample th { position: sticky; top: 0; padding: 8px 10px; text-align: left; font-size: 12px; font-weight: 600; white-space: nowrap; color: var(--color-muted); background: var(--color-canvas); border-bottom: 1px solid var(--color-line); vertical-align: bottom; }
.sample td { padding: 6px 10px; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid var(--color-line); }
.sample th.used { color: var(--color-ink); background: var(--color-primary-light); box-shadow: inset 0 3px 0 var(--color-primary); }
.sample td.used { background: rgb(254 243 199 / .45); }
.role { display: block; margin-bottom: 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: #8A4B00; }

.stats { display: grid; grid-template-columns: 1.3fr repeat(4, 1fr) 1.5fr; gap: 10px; }
.st { display: grid; gap: 2px; align-content: start; padding: 10px 14px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.st small { font-size: 12px; color: var(--color-muted); }
.st b { font-family: var(--font-display); font-size: 20px; font-variant-numeric: tabular-nums; }
.st span { font-size: 12px; color: var(--color-muted); }
.st.main { border-left: 4px solid var(--color-success); }
.st.main b { font-size: 26px; color: var(--color-success); }
.st b.in { color: var(--color-success); }
.st.warn { border-bottom: 3px solid var(--color-warning); }
.st.warn b { color: var(--color-warning); }
.st.bad { border-bottom: 3px solid var(--color-danger); }
.st.bad b { color: var(--color-danger); }
.st.per b { font-size: 15px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.link { display: inline-flex; align-items: center; gap: 6px; padding: 0; font: inherit; font-size: 14px; font-weight: 600; color: var(--color-leaf); background: none; border: 0; cursor: pointer; }
.link:hover { text-decoration: underline; }
.warnbox { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 12px; font-size: 14px; background: var(--color-warning-light); border-left: 3px solid var(--color-warning); }
.warnbox svg { color: var(--color-warning); flex: none; }

.rows-wrap { background: var(--color-surface); box-shadow: var(--shadow-md); }
.rows { width: 100%; border-collapse: collapse; font-size: 13px; }
.rows th { padding: 8px 10px; font-size: 11px; font-weight: 600; text-align: left; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); border-bottom: 1px solid var(--color-line); white-space: nowrap; }
.rows td { padding: 6px 10px; vertical-align: middle; border-bottom: 1px solid var(--color-line); }
.rows tr.bad td { background: var(--color-danger-light); }
.rows tr.bad td:first-child { box-shadow: inset 4px 0 0 var(--color-danger); }
.rows tr.dupe td { color: var(--color-muted); }
.rows tr.dupe td:first-child { box-shadow: inset 4px 0 0 var(--color-warning); }
.ln { width: 44px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
.desc { min-width: 200px; }
.refc { font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace; font-size: 12px; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.num b.in { color: var(--color-success); }
.nowrap { white-space: nowrap; }
.car { width: 210px; }
.car :deep(.trigger) { min-height: 34px; box-shadow: none; }
.sug { display: block; margin-top: 2px; font-size: 11px; color: var(--color-leaf); }
.pad { padding: 14px; }
.remember { padding: 12px 14px; background: var(--color-canvas); border-left: 4px solid var(--color-leaf); }

.result { display: flex; gap: 16px; align-items: flex-start; padding: 18px 20px; background: var(--color-success-light); border-left: 5px solid var(--color-success); box-shadow: var(--shadow-sm); }
.result > svg { color: var(--color-success); flex: none; }
.result h3 { margin: 0 0 4px; font-size: 20px; }
.result p { margin: 0; }
.result ul { margin: 10px 0 0; padding-left: 18px; font-size: 14px; color: var(--color-muted); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }

@media (max-width: 900px) {
  .s1, .s2 { grid-template-columns: minmax(0, 1fr); }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .st.main, .st.per { grid-column: 1 / -1; }
}
@media (max-width: 767px) {
  /* Solo el paso actual lleva nombre; los demás quedan como íconos */
  .steps { display: flex; gap: 6px; }
  .steps li { flex: none; padding-right: 0; }
  .steps li.on { flex: 1; }
  .steps .lb { display: none; }
  .steps li.on .lb { display: grid; }
  .map, .pair { grid-template-columns: minmax(0, 1fr); }
  /* Vista previa como fichas: sin scroll horizontal a 390 px */
  .rows, .rows tbody, .rows tr, .rows td { display: block; }
  .rows thead { display: none; }
  .rows tbody tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; padding: 10px 12px; border-bottom: 1px solid var(--color-line); }
  .rows td { padding: 0; border: 0; background: none !important; box-shadow: none !important; }
  .rows tr.bad { background: var(--color-danger-light); box-shadow: inset 4px 0 0 var(--color-danger); }
  .rows tr.dupe { box-shadow: inset 4px 0 0 var(--color-warning); }
  .rows td.ln { display: none; }
  .rows td.desc { grid-column: 1 / -1; order: -1; min-width: 0; font-weight: 600; }
  .rows td.num { text-align: left; }
  .rows td.car { grid-column: 1 / -1; width: auto; }
  .rows td[data-label]::before { content: attr(data-label); display: block; font-size: 10px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
}
</style>
