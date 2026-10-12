<script setup lang="ts">
// Crear o editar una cuenta bancaria: nombre, banco, últimos 4 y (al editar) activa. No hay borrado: una cuenta con
// movimientos se desactiva para que deje de aparecer en la carga manual y en la importación.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BankAccount } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ account?: BankAccount | null }>();
const emit = defineEmits<{ saved: [account: BankAccount] }>();
const { t } = useI18n();
const s = useSession();
const fin = useFinance();

const f = reactive({ name: '', bankName: '', last4: '', isActive: true });
const error = ref<string | null>(null);
const busy = ref(false);
watch(open, (v) => {
  if (!v) return;
  const a = props.account;
  Object.assign(f, { name: a?.name ?? '', bankName: a?.bankName ?? '', last4: a?.last4 ?? '', isActive: a?.isActive ?? true });
  error.value = null;
});

const last4Bad = computed(() => !!f.last4 && !/^\d{4}$/.test(f.last4));
const valid = computed(() => f.name.trim() && !last4Bad.value);

async function save() {
  busy.value = true;
  error.value = null;
  const body = { name: f.name.trim(), bankName: f.bankName.trim(), last4: f.last4 || null };
  try {
    const params = { slug: s.workspace!.slug };
    const saved = props.account
      ? await api('PATCH /w/:slug/finance/bank/accounts/:id', { params: { ...params, id: props.account.id }, body: { ...body, isActive: f.isActive } })
      : await api('POST /w/:slug/finance/bank/accounts', { params, body });
    await fin.loadAccounts();
    toast(t('common.saved'), 'success');
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
  <Modal v-model="open" :title="account ? t('finance.bank.accounts.edit') : t('finance.bank.accounts.new')" :subtitle="t('finance.bank.accounts.modalHint')" width="520px">
    <form id="bank-account-form" class="grid gap-4" novalidate @submit.prevent="valid && save()">
      <Input v-model="f.name" :label="t('finance.bank.accounts.name')" :placeholder="t('finance.bank.accounts.namePh')" />
      <div class="row">
        <Input v-model="f.bankName" :label="t('finance.bank.accounts.bankName')" :placeholder="t('finance.bank.accounts.bankNamePh')" />
        <Input v-model="f.last4" :label="t('finance.bank.accounts.last4')" placeholder="1234" :error="last4Bad ? t('finance.bank.accounts.last4Bad') : null" />
      </div>
      <label v-if="account" class="check"><input v-model="f.isActive" type="checkbox">{{ t('finance.bank.accounts.active') }}</label>
      <p v-if="account && !f.isActive" class="note">{{ t('finance.bank.accounts.inactiveNote') }}</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="bank-account-form" :loading="busy" :disabled="!valid">{{ t('common.save') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; align-items: start; }
.check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; cursor: pointer; }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 520px) { .row { grid-template-columns: 1fr; } }
</style>
