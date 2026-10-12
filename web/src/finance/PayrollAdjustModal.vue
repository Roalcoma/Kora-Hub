<script setup lang="ts">
// Ajuste puntual de una línea en borrador: un bono o una deducción con su concepto, solo para esta corrida.
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
import { cents } from './format.ts';

const props = defineProps<{ run: PayrollRunDetail; line: PayrollLine | null }>();
const emit = defineEmits<{ close: []; saved: [run: PayrollRunDetail] }>();
const { t } = useI18n();
const s = useSession();

const open = computed({ get: () => !!props.line, set: (v) => { if (!v) emit('close'); } });
const f = reactive({ kind: 'bonus' as 'bonus' | 'deduction', label: '', amount: '' });
const busy = ref(false);
const error = ref<string | null>(null);
watch(() => props.line, (l) => { if (l) { Object.assign(f, { kind: 'bonus', label: '', amount: '' }); error.value = null; } });
const valid = computed(() => f.label.trim() && Number(f.amount) > 0);

async function save() {
  busy.value = true;
  error.value = null;
  try {
    const saved = await api('POST /w/:slug/finance/payroll/runs/:id/adjustments', { params: { slug: s.workspace!.slug, id: props.run.id }, body: {
      personId: props.line!.personId, kind: f.kind, label: f.label.trim(), amount: cents(f.amount),
    } });
    toast(t('finance.payroll.run.adjustedOk'), 'success');
    emit('saved', saved);
    emit('close');
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="t('finance.payroll.run.adjustTitle')" :subtitle="line ? `${line.personName} · ${t('finance.payroll.run.adjustHint')}` : ''" width="480px">
    <form id="padj-form" class="grid gap-4" novalidate @submit.prevent="valid && save()">
      <div class="seg" role="radiogroup" :aria-label="t('finance.payroll.run.adjustKind')">
        <button type="button" role="radio" :aria-checked="f.kind === 'bonus'" @click="f.kind = 'bonus'">{{ t('finance.payroll.run.adjBonus') }}</button>
        <button type="button" role="radio" :aria-checked="f.kind === 'deduction'" @click="f.kind = 'deduction'">{{ t('finance.payroll.run.adjDeduction') }}</button>
      </div>
      <div class="row">
        <Input v-model="f.label" :label="t('finance.payroll.run.adjConcept')" :placeholder="f.kind === 'bonus' ? t('finance.payroll.run.adjBonusPh') : t('finance.payroll.run.adjDeductionPh')" />
        <Input v-model="f.amount" type="number" prefix="$" :label="t('finance.expenses.amount')" />
      </div>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="padj-form" :loading="busy" :disabled="!valid">{{ t('common.add') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1.5fr 1fr; gap: 12px; align-items: start; }
.seg { display: flex; width: max-content; max-width: 100%; border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.seg button { min-height: 38px; padding: 0 16px; font: inherit; font-size: 14px; font-weight: 500; color: var(--color-ink); background: none; border: 0; border-left: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration); }
.seg button:first-child { border-left: 0; }
.seg button:hover { background: var(--color-canvas); }
.seg button[aria-checked="true"] { color: #fff; background: var(--color-ink); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 520px) { .row { grid-template-columns: 1fr; } .seg { width: 100%; } .seg button { flex: 1; } }
</style>
