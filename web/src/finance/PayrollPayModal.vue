<script setup lang="ts">
// Marcar pagada una línea o todas las pendientes de una corrida aprobada: fecha y referencia (opcional).
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PayrollLine, PayrollRunDetail } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { usd, today } from './format.ts';

/** `lines` null = cerrado; vacío no se usa: para "todas" se pasan las pendientes */
const props = defineProps<{ run: PayrollRunDetail; lines: PayrollLine[] | null; all?: boolean }>();
const emit = defineEmits<{ close: []; saved: [run: PayrollRunDetail] }>();
const { t, locale } = useI18n();
const s = useSession();

const open = computed({ get: () => !!props.lines, set: (v) => { if (!v) emit('close'); } });
const f = reactive({ paidAt: '', reference: '' });
const busy = ref(false);
const error = ref<string | null>(null);
watch(() => props.lines, (l) => {
  if (!l) return;
  // Por defecto la fecha de pago de la corrida si ya llegó; si no, hoy
  Object.assign(f, { paidAt: props.run.payDate <= today() ? props.run.payDate : today(), reference: '' });
  error.value = null;
});
const total = computed(() => (props.lines ?? []).reduce((n, l) => n + l.net, 0));
const subtitle = computed(() => {
  const l = props.lines ?? [];
  const who = props.all ? t('finance.payroll.run.nLines', { n: l.length }, l.length) : l[0]?.personName ?? '';
  return `${who} · ${usd(Math.round(total.value * 100) / 100, locale.value)}`;
});

async function pay() {
  busy.value = true;
  error.value = null;
  try {
    const saved = await api('POST /w/:slug/finance/payroll/runs/:id/pay', { params: { slug: s.workspace!.slug, id: props.run.id }, body: {
      lineIds: props.all ? undefined : props.lines!.map((l) => l.id), paidAt: f.paidAt, reference: f.reference.trim() || undefined,
    } });
    toast(t('finance.payroll.run.paidOk'), 'success');
    emit('saved', saved);
    emit('close');
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="all ? t('finance.payroll.run.payAllTitle') : t('finance.payroll.run.payTitle')" :subtitle="subtitle" width="480px">
    <form id="ppay-form" class="grid gap-4" novalidate @submit.prevent="f.paidAt && pay()">
      <div class="row">
        <label class="date">{{ t('finance.expenses.paidAt') }}<input v-model="f.paidAt" type="date" :max="today()"></label>
        <Input v-model="f.reference" :label="t('finance.expenses.reference')" :placeholder="t('finance.expenses.referencePh')" />
      </div>
      <p v-if="all" class="note">{{ t('finance.payroll.run.payAllNote') }}</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="ppay-form" :loading="busy" :disabled="!f.paidAt">{{ t('finance.expenses.markPaid') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 520px) { .row { grid-template-columns: 1fr; } }
</style>
