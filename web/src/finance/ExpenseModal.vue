<script setup lang="ts">
// Registrar o editar un gasto: fecha, categoría, proveedor (con sugerencias), concepto, monto, método, referencia, notas
// y comprobante. Al crearlo se puede marcar "ya pagado". Si lo guarda un Contable, queda por aprobar (ADR 0007).
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { TriangleAlert } from 'lucide-vue-next';
import { EXPENSE_PAY_METHODS, type Expense, type ExpensePayMethod } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Textarea from '@/design/Textarea.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toneColor } from '@/design/types.ts';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { today, cents } from './format.ts';
import VendorInput from './VendorInput.vue';
import FileField from './FileField.vue';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ expense?: Expense | null }>();
const emit = defineEmits<{ saved: [expense: Expense] }>();
const { t } = useI18n();
const s = useSession();
const fin = useFinance();

const f = reactive({
  dueDate: '', categoryId: '', vendor: '', concept: '', amount: '', payMethod: 'card' as ExpensePayMethod,
  reference: '', notes: '', fileId: null as string | null,
  paid: false, paidAt: '', paidAmount: '',
});
const error = ref<string | null>(null);
const busy = ref(false);
const uploading = ref(false);
watch(open, (v) => {
  if (!v) return;
  const x = props.expense;
  Object.assign(f, {
    dueDate: x?.dueDate ?? today(), categoryId: x?.categoryId ?? fin.activeCategories[0]?.id ?? '', vendor: x?.vendor ?? '',
    concept: x?.concept ?? '', amount: x ? String(x.amount) : '', payMethod: x?.payMethod ?? 'card', reference: x?.reference ?? '',
    notes: x?.notes ?? '', fileId: x?.file?.id ?? null, paid: false, paidAt: today(), paidAmount: '',
  });
  error.value = null;
});

const categoryOptions = computed(() => {
  // Una categoría archivada sigue apareciendo si es la del gasto que se edita
  const list = fin.categories.filter((c) => !c.archivedAt || c.id === props.expense?.categoryId);
  return list.map((c) => ({ value: c.id, label: c.name, swatch: toneColor(c.color) }));
});
const methodOptions = computed(() => EXPENSE_PAY_METHODS.map((m) => ({ value: m, label: t(`finance.methods.${m}`) })));
const valid = computed(() => f.categoryId && f.vendor.trim() && Number(f.amount) > 0 && f.dueDate
  && (!f.paid || (f.paidAt && (!f.paidAmount || Number(f.paidAmount) > 0))) && !uploading.value);
/** El Contable ve antes de guardar que quedará por aprobar: siempre al crear; al editar, si cambia el monto de uno aprobado */
const willNeedApproval = computed(() => fin.isAccountant
  && (!props.expense || (props.expense.approvalStatus === 'approved' && Number(f.amount) !== props.expense.amount)));

async function save() {
  busy.value = true;
  error.value = null;
  const body = {
    categoryId: f.categoryId, vendor: f.vendor.trim(), concept: f.concept.trim(), dueDate: f.dueDate, amount: cents(f.amount),
    payMethod: f.payMethod, reference: f.reference.trim(), notes: f.notes, fileId: f.fileId,
  };
  try {
    const params = { slug: s.workspace!.slug };
    const saved = props.expense
      ? await api('PATCH /w/:slug/finance/expenses/:id', { params: { ...params, id: props.expense.id }, body })
      : await api('POST /w/:slug/finance/expenses', { params, body: {
        ...body, paid: f.paid ? { paidAt: f.paidAt, paidAmount: f.paidAmount ? cents(f.paidAmount) : undefined } : undefined,
      } });
    toast(saved.approvalStatus === 'pending' ? t('finance.expenses.savedPending') : t('common.saved'), 'success');
    open.value = false;
    emit('saved', saved);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-model="open" :title="expense ? t('finance.expenses.edit') : t('finance.expenses.new')" :subtitle="expense?.scheduleId ? t('finance.expenses.fromSchedule') : t('finance.expenses.newHint')" width="600px">
    <form id="expense-form" class="grid gap-4" novalidate @submit.prevent="valid && save()">
      <div class="row wide">
        <VendorInput v-model="f.vendor" :label="t('finance.expenses.vendor')" :placeholder="t('finance.expenses.vendorPh')" />
        <label class="date">{{ t('finance.expenses.dueDate') }}<input v-model="f.dueDate" type="date"></label>
      </div>
      <Input v-model="f.concept" :label="t('finance.expenses.concept')" :placeholder="t('finance.expenses.conceptPh')" />
      <div class="row">
        <Dropdown v-model="f.categoryId" :options="categoryOptions" :label="t('finance.expenses.category')" :placeholder="t('finance.expenses.pickCategory')" />
        <Input v-model="f.amount" type="number" prefix="$" :label="expense?.scheduleId ? t('finance.expenses.estimated') : t('finance.expenses.amount')" />
      </div>
      <div class="row">
        <Dropdown v-model="f.payMethod" :options="methodOptions" :label="t('finance.expenses.method')" />
        <Input v-model="f.reference" :label="t('finance.expenses.reference')" :placeholder="t('finance.expenses.referencePh')" />
      </div>
      <Textarea v-model="f.notes" :label="t('finance.expenses.notes')" :rows="2" />
      <FileField v-model="f.fileId" :file="expense?.file" :label="t('finance.expenses.receipt')" :hint="t('finance.expenses.receiptHint')" @uploading="uploading = $event" />

      <!-- Ya pagado: solo al registrarlo; después se paga desde la lista -->
      <fieldset v-if="!expense && fin.canApprove" class="paid" :class="{ on: f.paid }">
        <label class="check"><input v-model="f.paid" type="checkbox">{{ t('finance.expenses.alreadyPaid') }}</label>
        <div v-if="f.paid" class="row">
          <label class="date">{{ t('finance.expenses.paidAt') }}<input v-model="f.paidAt" type="date" :max="today()"></label>
          <Input v-model="f.paidAmount" type="number" prefix="$" :label="t('finance.expenses.paidAmount')" :placeholder="f.amount" :hint="t('finance.expenses.paidAmountHint')" />
        </div>
      </fieldset>

      <p v-if="willNeedApproval" class="warn"><TriangleAlert :size="16" />{{ expense ? t('finance.approval.willNeedEdit') : t('finance.approval.willNeed') }}</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="expense-form" :loading="busy" :disabled="!valid">{{ t('common.save') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.row.wide { grid-template-columns: 1.5fr 1fr; }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.paid { display: grid; gap: 12px; margin: 0; padding: 12px 14px; border: 0; border-left: 3px solid var(--color-line-strong); background: var(--color-canvas); min-width: 0; }
.paid.on { border-left-color: var(--color-success); }
.check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; cursor: pointer; }
.warn { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; font-size: 13px; line-height: 1.45; color: var(--color-ink); background: var(--color-warning-light); border-left: 3px solid var(--color-warning); }
.warn svg { flex: none; margin-top: 1px; color: var(--color-warning); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 520px) { .row, .row.wide { grid-template-columns: 1fr; } }
</style>
