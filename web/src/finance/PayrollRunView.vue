<script setup lang="ts">
// Detalle de una corrida de nómina dentro de la pestaña: una línea por persona (bruto, deducciones, neto) con su
// desglose expandible. En borrador: horas, ajustes puntuales, recalcular, cambiar fechas, borrar y aprobar (solo
// Owner/Admin; el Contable la deja lista). Aprobada: reabrir (sin pagos), pagar por línea o todas, deshacer pagos.
// Siempre: CSV y recibo imprimible por persona.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ArrowLeft, Download, RefreshCw, Check, Undo2, CircleCheck, Trash2, ChevronDown, Plus, Printer, CalendarDays, TriangleAlert, ShieldCheck,
} from 'lucide-vue-next';
import type { PayrollLine, PayrollRunDetail } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Modal from '@/design/Modal.vue';
import Skeleton from '@/design/Skeleton.vue';
import EmptyState from '@/design/EmptyState.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { usd, fmtDay } from './format.ts';
import PayrollBreakdown from './PayrollBreakdown.vue';
import PayrollRunModal from './PayrollRunModal.vue';
import PayrollPayModal from './PayrollPayModal.vue';
import PayrollAdjustModal from './PayrollAdjustModal.vue';
import PayrollReceipt from './PayrollReceipt.vue';

const props = defineProps<{ runId: string }>();
const emit = defineEmits<{ back: []; changed: [] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);
const slug = () => s.workspace!.slug;
const p = () => ({ params: { slug: slug(), id: props.runId } });

const run = ref<PayrollRunDetail | null>(null);
async function load() {
  try { run.value = await api('GET /w/:slug/finance/payroll/runs/:id', p()); }
  catch (e) { toast(errorText(e), 'error'); emit('back'); }
}
watch(() => props.runId, () => { run.value = null; load(); }, { immediate: true });
/** Toda acción devuelve la corrida completa: se reemplaza y la lista de corridas se entera */
const set = (r: PayrollRunDetail) => { run.value = r; emit('changed'); };

const draft = computed(() => run.value?.status === 'draft');
const paidLines = computed(() => run.value?.lines.filter((l) => l.paidAt).length ?? 0);
const unpaid = computed(() => run.value?.lines.filter((l) => !l.paidAt) ?? []);
const negatives = computed(() => run.value?.lines.filter((l) => l.net < 0) ?? []);
const calendar = computed(() => (run.value ? fin.calendar(run.value.calendarId) : undefined));
const title = computed(() => run.value ? `${calendar.value?.name ?? '—'} · ${day(run.value.periodStart)} – ${day(run.value.periodEnd)}` : '');
const statusTone = (st: string) => (st === 'paid' ? 'success' : st === 'approved' ? 'primary' : 'neutral');
const csvUrl = computed(() => `/api/v1/w/${slug()}/finance/payroll/runs/${props.runId}/export.csv`);

const busy = ref<string | null>(null);
async function act(key: string, fn: () => Promise<PayrollRunDetail>, ok?: string) {
  busy.value = key;
  try {
    set(await fn());
    if (ok) toast(ok, 'success');
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = null; }
}
const recalc = () => act('recalc', () => api('POST /w/:slug/finance/payroll/runs/:id/recalculate', p()), t('finance.payroll.run.recalculatedOk'));
const approve = () => act('approve', () => api('POST /w/:slug/finance/payroll/runs/:id/approve', p()), t('finance.payroll.run.approvedOk'));
const reopen = () => act('reopen', () => api('POST /w/:slug/finance/payroll/runs/:id/reopen', p()), t('finance.payroll.run.reopenedOk'));
const unpay = (lineIds?: string[]) => act(lineIds ? lineIds[0] : 'unpay', () => api('POST /w/:slug/finance/payroll/runs/:id/pay', { ...p(), body: { lineIds, paidAt: null } }), t('finance.payroll.run.unpaidOk'));
const removeAdj = (adjustmentId: string) => act('adj', () => api('DELETE /w/:slug/finance/payroll/runs/:id/adjustments/:adjustmentId', { params: { slug: slug(), id: props.runId, adjustmentId } }));
/** Horas: se guardan al salir del campo; vacío = sin horas cargadas */
function saveHours(l: PayrollLine, e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim();
  const hours = raw === '' ? null : Math.round(Number(raw) * 100) / 100;
  if (hours === l.hours || (hours != null && (Number.isNaN(hours) || hours < 0 || hours > 1000))) { (e.target as HTMLInputElement).value = l.hours == null ? '' : String(l.hours); return; }
  act(l.id, () => api('PATCH /w/:slug/finance/payroll/runs/:id/lines/:lineId', { params: { slug: slug(), id: props.runId, lineId: l.id }, body: { hours } }));
}

// ─── Expandir desglose ───
const open = ref(new Set<string>());
const toggle = (id: string) => { const n = new Set(open.value); n.has(id) ? n.delete(id) : n.add(id); open.value = n; };
const allOpen = computed(() => !!run.value?.lines.length && run.value.lines.every((l) => open.value.has(l.id)));
const toggleAll = () => { open.value = allOpen.value ? new Set() : new Set(run.value?.lines.map((l) => l.id)); };

// ─── Modales ───
const datesModal = ref(false);
const paying = ref<PayrollLine[] | null>(null);
const payingAll = ref(false);
const payLine = (l: PayrollLine) => { payingAll.value = false; paying.value = [l]; };
const payAll = () => { payingAll.value = true; paying.value = unpaid.value; };
const adjusting = ref<PayrollLine | null>(null);
const receipt = ref<PayrollLine | null>(null);
/** Confirmación para lo que no se deshace fácil: borrar el borrador o deshacer todos los pagos */
const confirm = ref<'delete' | 'unpayAll' | null>(null);
const confirmOpen = computed({ get: () => !!confirm.value, set: (v) => { if (!v) confirm.value = null; } });
async function confirmed() {
  if (confirm.value === 'unpayAll') { await unpay(); confirm.value = null; return; }
  busy.value = 'delete';
  try {
    await api('DELETE /w/:slug/finance/payroll/runs/:id', p());
    toast(t('finance.payroll.run.deletedOk'), 'success');
    confirm.value = null;
    emit('changed');
    emit('back');
    fin.loadCalendars().catch(() => {});
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = null; }
}
</script>

<template>
  <div v-if="!run" class="grid gap-3"><Skeleton height="64px" /><Skeleton v-for="n in 3" :key="n" height="52px" /></div>
  <div v-else class="detail">
    <header class="top">
      <button type="button" class="back" @click="emit('back')"><ArrowLeft :size="16" />{{ t('finance.payroll.runs') }}</button>
      <div class="ttl">
        <h2>{{ title }}</h2>
        <Badge :tone="statusTone(run.status)">{{ t(`finance.payroll.status.${run.status}`) }}</Badge>
        <span v-if="run.status === 'approved' && paidLines" class="partial">{{ t('finance.payroll.run.paidOfLines', { n: paidLines, total: run.lines.length }) }}</span>
      </div>
      <div class="acts">
        <a :href="csvUrl" download class="exp"><Download :size="16" />CSV</a>
        <template v-if="draft">
          <Button :loading="busy === 'recalc'" @click="recalc"><RefreshCw :size="16" />{{ t('finance.payroll.run.recalculate') }}</Button>
          <Button v-if="fin.canApprove" variant="primary" :loading="busy === 'approve'" :disabled="!run.lines.length" @click="approve"><Check :size="16" />{{ t('finance.payroll.run.approve') }}</Button>
        </template>
        <template v-else>
          <Button v-if="run.status === 'approved' && !paidLines && fin.canApprove" :loading="busy === 'reopen'" @click="reopen"><Undo2 :size="16" />{{ t('finance.payroll.run.reopen') }}</Button>
          <Button v-if="paidLines" variant="ghost" :loading="busy === 'unpay'" @click="confirm = 'unpayAll'"><Undo2 :size="16" />{{ t('finance.payroll.run.unpayAll') }}</Button>
          <Button v-if="unpaid.length" variant="primary" @click="payAll"><CircleCheck :size="16" />{{ t('finance.payroll.run.payAll') }}</Button>
        </template>
      </div>
    </header>

    <!-- Quién aprueba: el Contable prepara, Owner/Admin aprueba (ADR 0007) -->
    <p v-if="draft && !fin.canApprove" class="banner info"><ShieldCheck :size="18" />{{ t('finance.payroll.run.accountantNote') }}</p>
    <p v-if="negatives.length" class="banner neg" role="status"><TriangleAlert :size="18" />
      {{ t('finance.payroll.run.negativeBanner', { names: negatives.map((l) => l.personName).join(', ') }, negatives.length) }}</p>

    <div class="totals">
      <div class="tot main"><small>{{ t('finance.payroll.run.net') }}</small><b>{{ money(run.totals.net) }}</b>
        <span>{{ t('finance.payroll.run.nLines', { n: run.totals.people }, run.totals.people) }}</span></div>
      <div class="tot"><small>{{ t('finance.payroll.run.gross') }}</small><b>{{ money(run.totals.gross) }}</b></div>
      <div class="tot ded"><small>{{ t('finance.payroll.run.deductions') }}</small><b>{{ money(run.totals.deductions) }}</b></div>
      <div class="tot ok"><small>{{ t('finance.expenses.paid') }}</small><b>{{ money(run.totals.paid) }}</b>
        <span>{{ t('finance.payroll.run.paidOfLines', { n: paidLines, total: run.lines.length }) }}</span></div>
    </div>

    <div class="cols">
      <section class="lines">
        <EmptyState v-if="!run.lines.length" :title="t('finance.payroll.run.noLines')" :text="t('finance.payroll.run.noLinesText')" />
        <template v-else>
          <div class="lhead">
            <span>{{ t('finance.payroll.receipt.employee') }}</span><span class="num">{{ t('finance.payroll.run.hours') }}</span>
            <span class="num">{{ t('finance.payroll.run.gross') }}</span><span class="num">{{ t('finance.payroll.run.deductions') }}</span>
            <span class="num">{{ t('finance.payroll.run.net') }}</span><span>{{ t('finance.expenses.status') }}</span>
            <button type="button" class="all" @click="toggleAll">{{ allOpen ? t('finance.payroll.run.collapseAll') : t('finance.payroll.run.expandAll') }}</button>
          </div>
          <article v-for="l in run.lines" :key="l.id" class="line" :class="{ neg: l.net < 0, paid: l.paidAt, open: open.has(l.id) }">
            <div class="row">
              <button type="button" class="who" :aria-expanded="open.has(l.id)" @click="toggle(l.id)">
                <ChevronDown :size="16" class="chev" />
                <span><b>{{ l.personName }}</b><small>{{ t(`finance.methods.${l.payMethod}`) }}<template v-if="fin.person(l.personId)?.accountLast4"> •••• {{ fin.person(l.personId)!.accountLast4 }}</template>
                  <template v-if="l.adjustments.length"> · {{ t('finance.payroll.run.nAdjustments', { n: l.adjustments.length }, l.adjustments.length) }}</template></small></span>
              </button>
              <span class="num hours" :data-label="t('finance.payroll.run.hours')">
                <input v-if="draft && l.hasHourly" type="number" min="0" max="1000" step="0.25" :value="l.hours ?? ''" :placeholder="t('finance.payroll.run.hoursPh')"
                  :aria-label="t('finance.payroll.run.hoursOf', { name: l.personName })" :disabled="busy === l.id" @change="saveHours(l, $event)" @keydown.enter="($event.target as HTMLInputElement).blur()">
                <template v-else>{{ l.hours ?? '—' }}</template>
              </span>
              <span class="num" :data-label="t('finance.payroll.run.gross')">{{ money(l.gross) }}</span>
              <span class="num" :class="{ ded: l.deductions }" :data-label="t('finance.payroll.run.deductions')">{{ l.deductions ? `−${money(l.deductions)}` : money(0) }}</span>
              <span class="num net" :data-label="t('finance.payroll.run.net')"><b>{{ money(l.net) }}</b></span>
              <span class="st" :data-label="t('finance.expenses.status')">
                <Badge v-if="l.paidAt" tone="success">{{ t('finance.payroll.run.paidOn', { date: day(l.paidAt) }) }}</Badge>
                <Badge v-else-if="l.net < 0" tone="danger">{{ t('finance.payroll.run.negative') }}</Badge>
                <Badge v-else :tone="draft ? 'neutral' : 'warning'">{{ draft ? t('finance.payroll.status.draft') : t('finance.payroll.run.toPay') }}</Badge>
                <small v-if="l.reference">{{ l.reference }}</small>
              </span>
              <span class="row-acts">
                <button v-if="draft" type="button" class="ico" :title="t('finance.payroll.run.adjust')" :aria-label="t('finance.payroll.run.adjust')" @click="adjusting = l"><Plus :size="16" /></button>
                <button type="button" class="ico" :title="t('finance.payroll.receipt.open')" :aria-label="t('finance.payroll.receipt.open')" @click="receipt = l"><Printer :size="16" /></button>
                <Button v-if="!draft && !l.paidAt" size="sm" variant="primary" @click="payLine(l)"><CircleCheck :size="15" />{{ t('finance.expenses.pay') }}</Button>
                <button v-if="l.paidAt" type="button" class="ico" :disabled="busy === l.id" :title="t('finance.payroll.run.unpay')" :aria-label="t('finance.payroll.run.unpay')" @click="unpay([l.id])"><Undo2 :size="16" /></button>
              </span>
            </div>
            <div v-if="open.has(l.id)" class="bdw">
              <PayrollBreakdown :line="l" :removable="draft" :busy="busy === 'adj'" @remove-adjustment="removeAdj" />
              <Button v-if="draft" size="sm" variant="ghost" class="addadj" @click="adjusting = l"><Plus :size="15" />{{ t('finance.payroll.run.adjust') }}</Button>
            </div>
          </article>
        </template>
      </section>

      <!-- Columna de contexto: fechas, flujo y notas -->
      <aside class="info">
        <h3>{{ t('finance.payroll.run.info') }}</h3>
        <dl>
          <dt>{{ t('finance.payroll.run.payDate') }}</dt><dd><b>{{ day(run.payDate) }}</b></dd>
          <dt>{{ t('finance.payroll.run.period') }}</dt><dd>{{ day(run.periodStart) }} – {{ day(run.periodEnd) }}</dd>
          <dt>{{ t('finance.payroll.people.calendar') }}</dt><dd>{{ calendar?.name ?? '—' }}<small v-if="calendar">{{ t(`finance.payroll.freq.${calendar.frequency}`) }}</small></dd>
          <template v-if="run.approvedAt"><dt>{{ t('finance.payroll.run.approvedBy') }}</dt><dd>{{ fin.memberName(run.approvedBy) }}<small>{{ day(run.approvedAt.slice(0, 10)) }}</small></dd></template>
          <template v-if="run.paidAt"><dt>{{ t('finance.payroll.run.paidAt') }}</dt><dd>{{ day(run.paidAt) }}</dd></template>
        </dl>
        <p v-if="run.notes" class="notes">{{ run.notes }}</p>
        <ol class="flow">
          <li v-for="st in (['draft', 'approved', 'paid'] as const)" :key="st" :class="{ on: run.status === st, done: ['draft', 'approved', 'paid'].indexOf(run.status) > ['draft', 'approved', 'paid'].indexOf(st) }">
            <b>{{ t(`finance.payroll.status.${st}`) }}</b><small>{{ t(`finance.payroll.flow.${st}`) }}</small>
          </li>
        </ol>
        <div v-if="draft" class="iacts">
          <Button size="sm" @click="datesModal = true"><CalendarDays :size="15" />{{ t('finance.payroll.run.editDates') }}</Button>
          <Button size="sm" variant="ghost" @click="confirm = 'delete'"><Trash2 :size="15" />{{ t('finance.payroll.run.delete') }}</Button>
        </div>
      </aside>
    </div>

    <PayrollRunModal v-model="datesModal" :run="run" @saved="set" />
    <PayrollPayModal :run="run" :lines="paying" :all="payingAll" @close="paying = null" @saved="set" />
    <PayrollAdjustModal :run="run" :line="adjusting" @close="adjusting = null" @saved="set" />
    <PayrollReceipt v-if="receipt" :run="run" :line="run.lines.find((l) => l.id === receipt!.id) ?? receipt" @close="receipt = null" />
    <Modal v-model="confirmOpen" :title="confirm === 'delete' ? t('finance.payroll.run.deleteTitle') : t('finance.payroll.run.unpayAllTitle')" :subtitle="title">
      <p class="note">{{ confirm === 'delete' ? t('finance.payroll.run.deleteNote') : t('finance.payroll.run.unpayAllNote') }}</p>
      <template #footer>
        <Button variant="ghost" @click="confirm = null">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="!!busy" @click="confirmed">{{ confirm === 'delete' ? t('finance.payroll.run.delete') : t('finance.payroll.run.unpayAll') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.detail { display: grid; gap: 16px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.back { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 12px 0 8px; font: inherit; font-size: 14px; font-weight: 600; color: var(--color-ink);
  background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.back:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.ttl { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; flex: 1; min-width: 240px; }
.ttl h2 { margin: 0; font-size: 20px; }
.partial { font-size: 13px; color: var(--color-muted); }
.acts { display: flex; flex-wrap: wrap; gap: 8px; }
.exp { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 12px; font-size: 14px; font-weight: 500; color: var(--color-ink); text-decoration: none; background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration); }
.exp:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }

.banner { display: flex; align-items: flex-start; gap: 10px; margin: 0; padding: 12px 16px; font-size: 14px; font-weight: 500; box-shadow: var(--shadow-sm); }
.banner svg { flex: none; margin-top: 1px; }
.banner.info { background: var(--color-surface); border-left: 4px solid var(--color-leaf); }
.banner.info svg { color: var(--color-leaf); }
.banner.neg { background: var(--color-danger-light); border-left: 4px solid var(--color-danger); }
.banner.neg svg { color: var(--color-danger); }

.totals { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1.1fr; gap: 14px; }
.tot { display: grid; gap: 2px; align-content: start; padding: 14px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.tot.main { border-left: 4px solid var(--color-primary); }
.tot.ok b { color: var(--color-success); }
.tot.ded b { color: var(--color-danger); }
.tot small, .tot span { font-size: 13px; color: var(--color-muted); }
.tot b { font-family: var(--font-display); font-size: 24px; font-variant-numeric: tabular-nums; }
.tot.main b { font-size: 32px; }

.cols { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
.lines { display: grid; min-width: 0; background: var(--color-surface); box-shadow: var(--shadow-md); }
.lines :deep(.empty) { max-width: none; box-shadow: none; }
/* Misma rejilla para encabezado y filas */
.lhead, .row { display: grid; grid-template-columns: minmax(180px, 1.6fr) 90px repeat(3, minmax(96px, 1fr)) minmax(120px, 1fr) 132px; align-items: center; gap: 10px; }
.lhead { padding: 10px 14px; font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); border-bottom: 1px solid var(--color-line); }
.all { justify-self: end; padding: 0; font: inherit; font-size: 12px; font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--color-leaf); background: none; border: 0; cursor: pointer; }
.all:hover { text-decoration: underline; }
.line { border-bottom: 1px solid var(--color-line); border-left: 3px solid transparent; transition: background var(--duration); }
.line:last-child { border-bottom: 0; }
.line:hover, .line.open { background: var(--color-canvas); }
.line.paid { border-left-color: var(--color-success); }
.line.neg { border-left-color: var(--color-danger); }
.line.neg .net b { color: var(--color-danger); }
.row { padding: 8px 14px 8px 11px; font-size: 14px; }
.who { display: flex; align-items: flex-start; gap: 8px; min-width: 0; padding: 4px 0; font: inherit; text-align: left; color: inherit; background: none; border: 0; cursor: pointer; }
.who > span { display: grid; min-width: 0; }
.who b { overflow-wrap: anywhere; }
.who small { font-size: 12px; color: var(--color-muted); }
.chev { flex: none; margin-top: 3px; color: var(--color-muted); transition: transform var(--duration); }
.line.open .chev { transform: rotate(180deg); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.lhead .num { text-align: right; }
.num.ded { color: var(--color-danger); }
.hours input { width: 78px; min-height: 34px; padding: 0 8px; font: inherit; text-align: right; color: inherit; background: var(--color-surface); border: 1px solid var(--color-line-strong); outline: none; }
.hours input:focus { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .22); }
.st { display: grid; justify-items: start; gap: 2px; min-width: 0; }
.st small { font-size: 12px; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.row-acts { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.ico { display: inline-grid; place-items: center; width: 32px; height: 32px; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }
.bdw { display: grid; gap: 10px; padding: 6px 14px 16px 38px; }
.addadj { justify-self: start; }

.info { display: grid; gap: 14px; padding: 16px 18px; background: var(--color-surface); border-top: 4px solid var(--color-ink); box-shadow: var(--shadow-md); }
.info h3 { margin: 0; font-size: 16px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; font-size: 14px; }
dt { color: var(--color-muted); font-size: 13px; }
dd { margin: 0; text-align: right; }
dd small { display: block; font-size: 12px; color: var(--color-muted); }
.notes { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; background: var(--color-canvas); border-left: 3px solid var(--color-line-strong); }
.flow { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; counter-reset: st; }
.flow li { position: relative; display: grid; gap: 1px; padding: 6px 0 10px 30px; color: var(--color-muted); counter-increment: st; }
.flow li::before { content: counter(st); position: absolute; left: 0; top: 6px; width: 20px; height: 20px; display: grid; place-items: center; font-size: 11px; font-weight: 700; background: var(--color-canvas); border: 1px solid var(--color-line-strong); }
.flow li:not(:last-child)::after { content: ''; position: absolute; left: 10px; top: 27px; bottom: -6px; width: 1px; background: var(--color-line-strong); }
.flow li b { font-size: 14px; }
.flow li small { font-size: 12px; }
.flow li.on { color: var(--color-ink); }
.flow li.on::before { background: var(--color-primary); border-color: var(--color-primary); color: var(--color-ink); }
.flow li.done::before { content: '✓'; background: var(--color-ink); border-color: var(--color-ink); color: #fff; }
.iacts { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 12px; border-top: 1px solid var(--color-line); }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }

@media (max-width: 1279px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .info { grid-template-columns: 1fr 1fr; align-items: start; }
  .info h3 { grid-column: 1 / -1; }
  .iacts { grid-column: 1 / -1; }
}
@media (max-width: 1100px) {
  /* Filas como fichas: sin scroll horizontal */
  .lhead { display: flex; justify-content: flex-end; }
  .lhead > span { display: none; }
  .row { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; padding: 12px 14px 12px 11px; }
  .who { grid-column: 1 / -1; }
  .row > [data-label]::before { content: attr(data-label); display: block; margin-bottom: 2px; font-size: 11px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; text-align: left; }
  .num { text-align: left; }
  .hours input { text-align: left; }
  .row-acts { grid-column: 1 / -1; justify-content: flex-start; }
  .bdw { padding-left: 14px; }
}
@media (max-width: 767px) {
  .totals { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .tot { padding: 12px; }
  .tot.main, .tot.ok { grid-column: 1 / -1; }
  .tot b { font-size: 18px; }
  .tot.main b { font-size: 28px; }
  .acts { width: 100%; }
  .acts > * { flex: 1; justify-content: center; }
  .info { grid-template-columns: 1fr; }
}
@media (max-width: 420px) { .row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
