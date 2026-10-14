<script setup lang="ts">
// Registrar o editar una venta pendiente de ISSUE (Admin). Con `prefill` se completa un mensaje de la bandeja de Discord.
import { computed, reactive, ref, watch } from 'vue';
import { Plus, X } from 'lucide-vue-next';
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
import { today, nyDay } from './format.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ sale?: Sale | null; inbox?: InboxItem | null }>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n();
const s = useSession();
const sales = useSales();

const f = reactive({ agentId: '', productId: '', amount: '', clientName: '', clientState: '', soldOn: '', expectedIssueDate: '', notes: '' });
// Split: otros agentes con su %; el principal se queda con el resto
const splits = ref<{ agentId: string; percent: string }[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);
watch(open, (v) => {
  if (!v) return;
  const x = props.sale ?? props.inbox?.parsed ?? {};
  Object.assign(f, {
    agentId: x.agentId ?? '', productId: x.productId ?? '', amount: x.amount ? String(x.amount) : '',
    clientName: x.clientName ?? '', clientState: x.clientState ?? '', expectedIssueDate: x.expectedIssueDate ?? today(),
    soldOn: props.sale?.soldOn ?? (props.inbox ? nyDay(props.inbox.postedAt) : today()),
    notes: props.sale?.notes ?? '',
  });
  splits.value = (props.sale?.splits ?? []).map((x) => ({ agentId: x.agentId, percent: String(x.percent) }));
  error.value = null;
});

const agentOptions = computed(() => sales.sellers.map((a) => ({ value: a.id, label: a.name, hint: a.email ?? undefined })));
const productOptions = computed(() => sales.carriers.filter((c) => !c.archivedAt).flatMap((c) =>
  c.products.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: `${c.name} · ${p.name}` }))));
const stateOptions = computed(() => [{ value: '', label: '—' }, ...US_STATES.map((x) => ({ value: x, label: x }))]);
const mainShare = computed(() => Math.round((100 - splits.value.reduce((t, x) => t + (Number(x.percent) || 0), 0)) * 100) / 100);
const splitOk = computed(() => splits.value.every((x) => x.agentId && x.agentId !== f.agentId && Number(x.percent) > 0)
  && new Set(splits.value.map((x) => x.agentId)).size === splits.value.length && mainShare.value > 0);
const addSplit = () => { splits.value.push({ agentId: '', percent: splits.value.length ? '' : '50' }); };
const splitOptions = (current: string) => agentOptions.value.filter((o) => o.value === current
  || (o.value !== f.agentId && !splits.value.some((x) => x.agentId === o.value)));
const valid = computed(() => splitOk.value && f.agentId && f.productId && Number(f.amount) > 0 && f.clientName.trim() && f.soldOn && f.expectedIssueDate);

async function save() {
  busy.value = true;
  error.value = null;
  const body = {
    agentId: f.agentId, productId: f.productId, amount: Number(f.amount), clientName: f.clientName.trim(),
    clientState: (f.clientState || null) as (typeof US_STATES)[number] | null, soldOn: f.soldOn, expectedIssueDate: f.expectedIssueDate, notes: f.notes,
    splits: splits.value.map((x) => ({ agentId: x.agentId, percent: Number(x.percent) })),
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
        <Dropdown v-model="f.agentId" :options="agentOptions" :label="t('sales.agent')" :placeholder="t('sales.pickAgent')" searchable :search-placeholder="t('sales.searchAgent')" />
        <Dropdown v-model="f.productId" :options="productOptions" :label="t('sales.product')" :placeholder="t('sales.pickProduct')" />
      </div>
      <div class="split">
        <div v-for="(x, n) in splits" :key="n" class="split-row">
          <Dropdown v-model="x.agentId" :options="splitOptions(x.agentId)" :placeholder="t('sales.pickAgent')" searchable :search-placeholder="t('sales.searchAgent')" :aria-label="t('sales.splitWith')" />
          <Input v-model="x.percent" type="number" placeholder="%" :aria-label="t('sales.splitPercent')" />
          <button type="button" class="rm" :aria-label="t('sales.splitRemove')" @click="splits.splice(n, 1)"><X :size="16" /></button>
        </div>
        <p v-if="splits.length" class="split-note" :class="{ bad: !splitOk }">{{ t('sales.splitMain', { name: sales.agentName(f.agentId || null), n: mainShare }) }}</p>
        <button v-if="splits.length < 4" type="button" class="add" @click="addSplit"><Plus :size="15" />{{ t('sales.splitAdd') }}</button>
      </div>
      <div class="row">
        <Input v-model="f.amount" type="number" prefix="$" :label="t('sales.amount')" :hint="t('sales.amountHint')" />
      </div>
      <div class="row">
        <label class="date">{{ t('sales.soldOn') }}<input v-model="f.soldOn" type="date"></label>
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
.split { display: grid; gap: 8px; }
.split-row { display: grid; grid-template-columns: 1fr 110px 36px; gap: 8px; align-items: center; }
.split-note { margin: 0; font-size: 13px; color: var(--color-muted); }
.split-note.bad { color: var(--color-danger); }
.add, .rm { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 14px; color: var(--color-ink); background: none; border: 0; cursor: pointer; }
.add { justify-self: start; padding: 4px 0; font-weight: 500; }
.rm { justify-content: center; width: 36px; height: 36px; border: 1px solid var(--color-line-strong); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 520px) { .row, .row.wide { grid-template-columns: 1fr; } }
</style>
