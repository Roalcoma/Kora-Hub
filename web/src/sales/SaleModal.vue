<script setup lang="ts">
// Registrar o editar una venta pendiente de ISSUE (Admin). Con `prefill` se completa un mensaje de la bandeja de Discord.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { US_STATES, type InboxItem, type Sale } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Textarea from '@/design/Textarea.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useSales } from './store.ts';
import { today } from './format.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ sale?: Sale | null; inbox?: InboxItem | null }>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n();
const s = useSession();
const sales = useSales();

const f = reactive({ agentUserId: '', productId: '', amount: '', clientName: '', clientState: '', expectedIssueDate: '', notes: '' });
const error = ref<string | null>(null);
const busy = ref(false);
watch(open, (v) => {
  if (!v) return;
  const x = props.sale ?? props.inbox?.parsed ?? {};
  Object.assign(f, {
    agentUserId: x.agentUserId ?? '', productId: x.productId ?? '', amount: x.amount ? String(x.amount) : '',
    clientName: x.clientName ?? '', clientState: x.clientState ?? '', expectedIssueDate: x.expectedIssueDate ?? today(),
    notes: props.sale?.notes ?? '',
  });
  error.value = null;
});

const agentOptions = computed(() => sales.sellers.map((m) => ({ value: m.userId, label: m.name, hint: m.email })));
const productOptions = computed(() => sales.carriers.filter((c) => !c.archivedAt).flatMap((c) =>
  c.products.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: `${c.name} · ${p.name}` }))));
const stateOptions = computed(() => [{ value: '', label: '—' }, ...US_STATES.map((x) => ({ value: x, label: x }))]);
const valid = computed(() => f.agentUserId && f.productId && Number(f.amount) > 0 && f.clientName.trim() && f.expectedIssueDate);

async function save() {
  busy.value = true;
  error.value = null;
  const body = {
    agentUserId: f.agentUserId, productId: f.productId, amount: Number(f.amount), clientName: f.clientName.trim(),
    clientState: (f.clientState || null) as (typeof US_STATES)[number] | null, expectedIssueDate: f.expectedIssueDate, notes: f.notes,
  };
  try {
    const params = { slug: s.workspace!.slug };
    if (props.sale) await api('PATCH /w/:slug/sales/:id', { params: { ...params, id: props.sale.id }, body });
    else await api('POST /w/:slug/sales', { params, body: { ...body, inboxId: props.inbox?.id } });
    toast(t('common.saved'), 'success');
    open.value = false;
    emit('saved');
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-model="open" :title="sale ? t('sales.editSale') : t('sales.newSale')" :subtitle="inbox ? `${inbox.authorName}: ${inbox.content}` : t('sales.newSaleHint')" width="560px">
    <form id="sale-form" class="grid gap-4" @submit.prevent="valid && save()">
      <div class="row">
        <Dropdown v-model="f.agentUserId" :options="agentOptions" :label="t('sales.agent')" :placeholder="t('sales.pickAgent')" searchable :search-placeholder="t('sales.searchAgent')" />
        <Dropdown v-model="f.productId" :options="productOptions" :label="t('sales.product')" :placeholder="t('sales.pickProduct')" />
      </div>
      <div class="row">
        <Input v-model="f.amount" type="number" prefix="$" :label="t('sales.amount')" :hint="t('sales.amountHint')" />
        <label class="date">{{ t('sales.expectedIssue') }}<input v-model="f.expectedIssueDate" type="date"><small>{{ t('sales.expectedIssueHint') }}</small></label>
      </div>
      <div class="row wide">
        <Input v-model="f.clientName" :label="t('sales.client')" />
        <Dropdown v-model="f.clientState" :options="stateOptions" :label="t('sales.state')" searchable search-placeholder="FL" />
      </div>
      <Textarea v-model="f.notes" :label="t('sales.notes')" :rows="2" />
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="sale-form" :loading="busy" :disabled="!valid">{{ t('common.save') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.row.wide { grid-template-columns: 2fr 1fr; }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.date small { font-size: 12px; font-weight: 400; color: var(--color-muted); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 520px) { .row, .row.wide { grid-template-columns: 1fr; } }
</style>
