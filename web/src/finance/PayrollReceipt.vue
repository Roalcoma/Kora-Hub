<script setup lang="ts">
// Recibo de nómina de una persona: vista limpia a pantalla completa (fuera del layout, en <body>) que se imprime o
// guarda como PDF con el diálogo del navegador. Al imprimir solo sale el recibo (@media print oculta el resto).
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Printer, X } from 'lucide-vue-next';
import type { PayrollLine, PayrollRunDetail } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import { useSession } from '@/stores/session.ts';
import { useFinance } from './store.ts';
import { usd, fmtDay } from './format.ts';
import PayrollBreakdown from './PayrollBreakdown.vue';

const props = defineProps<{ run: PayrollRunDetail; line: PayrollLine }>();
const emit = defineEmits<{ close: [] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const day = (x: string) => fmtDay(x, locale.value);

const person = computed(() => fin.person(props.line.personId));
const ws = computed(() => s.workspace!);
const status = computed(() => props.line.paidAt ? t('finance.payroll.status.paid') : t(`finance.payroll.status.${props.run.status}`));
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') emit('close'); };
onMounted(() => { document.addEventListener('keydown', onKey); document.body.classList.add('pr-open'); });
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); document.body.classList.remove('pr-open'); });
const print = () => window.print();
</script>

<template>
  <Teleport to="body">
    <div class="pr-receipt" role="dialog" aria-modal="true" :aria-label="t('finance.payroll.receipt.title')">
      <div class="pr-bar">
        <span>{{ t('finance.payroll.receipt.title') }} · {{ line.personName }}</span>
        <Button variant="primary" @click="print"><Printer :size="16" />{{ t('finance.payroll.receipt.print') }}</Button>
        <button type="button" class="pr-x" :aria-label="t('common.close')" @click="emit('close')"><X :size="20" /></button>
      </div>
      <article class="pr-paper">
        <header class="pr-head">
          <div class="pr-org">
            <img v-if="ws.logoUrl" :src="ws.logoUrl" alt="" class="pr-logo">
            <div><b>{{ ws.name }}</b><small>{{ t('finance.payroll.receipt.title') }}</small></div>
          </div>
          <div class="pr-net">
            <small>{{ t('finance.payroll.run.net') }}</small>
            <b :class="{ neg: line.net < 0 }">{{ usd(line.net, locale) }}</b>
          </div>
        </header>
        <dl class="pr-meta">
          <div><dt>{{ t('finance.payroll.receipt.employee') }}</dt><dd>{{ line.personName }}<small v-if="person?.jobTitle">{{ person.jobTitle }}</small></dd></div>
          <div><dt>{{ t('finance.payroll.run.period') }}</dt><dd>{{ day(run.periodStart) }} – {{ day(run.periodEnd) }}<small>{{ fin.calendar(run.calendarId)?.name }}</small></dd></div>
          <div><dt>{{ t('finance.payroll.run.payDate') }}</dt><dd>{{ day(line.paidAt ?? run.payDate) }}<small>{{ status }}</small></dd></div>
          <div><dt>{{ t('finance.payroll.people.method') }}</dt><dd>{{ t(`finance.methods.${line.payMethod}`) }}<small v-if="person?.accountLast4">•••• {{ person.accountLast4 }}</small></dd></div>
          <div v-if="line.hours != null"><dt>{{ t('finance.payroll.run.hours') }}</dt><dd>{{ line.hours }}</dd></div>
          <div v-if="line.reference"><dt>{{ t('finance.expenses.reference') }}</dt><dd>{{ line.reference }}</dd></div>
        </dl>
        <PayrollBreakdown :line="line" />
        <footer class="pr-foot">{{ t('finance.payroll.receipt.footer', { date: day(run.periodEnd) }) }}</footer>
      </article>
    </div>
  </Teleport>
</template>

<style>
/* Sin scoped: la vista vive en <body> y el @media print tiene que ocultar todo lo demás */
body.pr-open { overflow: hidden; }
.pr-receipt { position: fixed; inset: 0; z-index: 1000; overflow: auto; background: var(--color-canvas); color: var(--color-ink); }
.pr-bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 10px 16px 10px 24px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.pr-bar > span { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-x { width: 40px; height: 40px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.pr-x:hover { color: var(--color-ink); background: var(--color-canvas); }
.pr-paper { display: grid; gap: 22px; max-width: 820px; margin: 28px auto 48px; padding: 36px 40px; background: #fff; box-shadow: var(--shadow-lg); border-top: 6px solid var(--color-ink); }
.pr-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; }
.pr-org { display: flex; align-items: center; gap: 14px; }
.pr-org b { display: block; font-family: var(--font-display); font-size: 22px; }
.pr-org small { font-size: 13px; color: var(--color-muted); text-transform: uppercase; letter-spacing: .04em; }
.pr-logo { width: 52px; height: 52px; object-fit: contain; }
.pr-net { display: grid; justify-items: end; padding: 8px 14px; border-right: 4px solid var(--color-primary); background: var(--color-canvas); }
.pr-net small { font-size: 12px; color: var(--color-muted); }
.pr-net b { font-family: var(--font-display); font-size: 30px; font-variant-numeric: tabular-nums; }
.pr-net b.neg { color: var(--color-danger); }
.pr-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 20px; margin: 0; padding: 16px 0; border-top: 1px solid var(--color-line); border-bottom: 1px solid var(--color-line); }
.pr-meta dt { font-size: 11px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .04em; }
.pr-meta dd { margin: 2px 0 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.pr-meta dd small { display: block; font-weight: 400; font-size: 12px; color: var(--color-muted); }
.pr-foot { font-size: 12px; color: var(--color-muted); }
@media (max-width: 640px) {
  .pr-bar { padding-left: 16px; }
  .pr-paper { margin: 0; padding: 22px 16px; box-shadow: none; }
  .pr-meta { grid-template-columns: 1fr 1fr; }
}
@media print {
  @page { margin: 14mm; }
  body > *:not(.pr-receipt) { display: none !important; }
  body.pr-open { overflow: visible; }
  .pr-receipt { position: static; overflow: visible; background: #fff; }
  .pr-bar { display: none; }
  .pr-paper { max-width: none; margin: 0; padding: 0; box-shadow: none; }
  .pr-receipt * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>
