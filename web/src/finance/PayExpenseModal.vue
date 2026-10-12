<script setup lang="ts">
// Registrar el pago de un gasto aprobado: monto real (por defecto el estimado), fecha, método, referencia y comprobante.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { EXPENSE_PAY_METHODS, type Expense, type ExpensePayMethod } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { today, usd, fmtDay, cents } from './format.ts';
import FileField from './FileField.vue';

const props = defineProps<{ expense: Expense | null }>();
const emit = defineEmits<{ close: []; saved: [expense: Expense] }>();
const { t, locale } = useI18n();
const s = useSession();

const open = computed({ get: () => !!props.expense, set: (v) => { if (!v) emit('close'); } });
const f = reactive({ paidAt: '', paidAmount: '', payMethod: 'card' as ExpensePayMethod, reference: '', fileId: null as string | null });
const busy = ref(false);
const uploading = ref(false);
const error = ref<string | null>(null);
watch(() => props.expense, (x) => {
  if (!x) return;
  // Un gasto que vence en el futuro se suele pagar hoy; uno vencido, también
  Object.assign(f, { paidAt: today(), paidAmount: String(x.amount), payMethod: x.payMethod, reference: x.reference, fileId: x.file?.id ?? null });
  error.value = null;
});
const methodOptions = computed(() => EXPENSE_PAY_METHODS.map((m) => ({ value: m, label: t(`finance.methods.${m}`) })));
const valid = computed(() => f.paidAt && Number(f.paidAmount) > 0 && !uploading.value);
const differs = computed(() => props.expense && Number(f.paidAmount) > 0 && Number(f.paidAmount) !== props.expense.amount);

async function pay() {
  const x = props.expense!;
  busy.value = true;
  error.value = null;
  try {
    const saved = await api('POST /w/:slug/finance/expenses/:id/pay', { params: { slug: s.workspace!.slug, id: x.id }, body: {
      paidAt: f.paidAt, paidAmount: cents(f.paidAmount), payMethod: f.payMethod, reference: f.reference.trim(), fileId: f.fileId,
    } });
    toast(t('finance.expenses.paidOk'), 'success');
    emit('saved', saved);
    emit('close');
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="t('finance.expenses.payTitle')"
    :subtitle="expense ? `${expense.vendor} · ${usd(expense.amount, locale)} · ${t('finance.expenses.due', { date: fmtDay(expense.dueDate, locale) })}` : ''" width="520px">
    <form id="pay-form" class="grid gap-4" novalidate @submit.prevent="valid && pay()">
      <div class="row">
        <Input v-model="f.paidAmount" type="number" prefix="$" :label="t('finance.expenses.paidAmount')"
          :hint="differs ? t('finance.expenses.differs', { amount: usd(expense!.amount, locale) }) : undefined" />
        <label class="date">{{ t('finance.expenses.paidAt') }}<input v-model="f.paidAt" type="date" :max="today()"></label>
      </div>
      <div class="row">
        <Dropdown v-model="f.payMethod" :options="methodOptions" :label="t('finance.expenses.method')" />
        <Input v-model="f.reference" :label="t('finance.expenses.reference')" :placeholder="t('finance.expenses.referencePh')" />
      </div>
      <FileField v-model="f.fileId" :file="expense?.file" :label="t('finance.expenses.receipt')" @uploading="uploading = $event" />
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="pay-form" :loading="busy" :disabled="!valid">{{ t('finance.expenses.markPaid') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 520px) { .row { grid-template-columns: 1fr; } }
</style>
