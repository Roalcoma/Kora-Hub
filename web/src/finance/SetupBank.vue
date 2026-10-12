<script setup lang="ts">
// Configuración del banco: cuentas de la agencia (nombre, banco, últimos 4), si ya tienen mapeo CSV guardado y hasta
// dónde llega el último estado importado. Crear, editar y desactivar (no hay borrado: los movimientos la necesitan).
// Va en la columna derecha de Configuración, junto a las categorías.
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Landmark, Plus, Pencil, Power, FileSpreadsheet } from 'lucide-vue-next';
import type { BankAccount } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { fmtDay } from './format.ts';
import BankAccountModal from './BankAccountModal.vue';

const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();

/** Activas primero (el servidor ya las ordena así; se repite por si el store se tocó en local) */
const accounts = computed(() => [...fin.accounts].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name)));

const modal = ref(false);
const editing = ref<BankAccount | null>(null);
const openAccount = (a: BankAccount | null) => { editing.value = a; modal.value = true; };

const busy = ref<string | null>(null);
async function toggle(a: BankAccount) {
  busy.value = a.id;
  try {
    await api('PATCH /w/:slug/finance/bank/accounts/:id', { params: { slug: s.workspace!.slug, id: a.id }, body: { isActive: !a.isActive } });
    await fin.loadAccounts();
    toast(a.isActive ? t('finance.bank.accounts.deactivatedOk') : t('finance.bank.accounts.activatedOk'), 'success');
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = null; }
}
</script>

<template>
  <section class="card">
    <header class="head">
      <div><h2><Landmark :size="20" />{{ t('finance.setup.bank') }}</h2><small>{{ t('finance.setup.bankHint') }}</small></div>
      <Button size="sm" @click="openAccount(null)"><Plus :size="15" />{{ t('finance.bank.accounts.new') }}</Button>
    </header>
    <EmptyState v-if="!accounts.length" :title="t('finance.bank.accounts.empty')" :text="t('finance.bank.accounts.emptyText')">
      <Button variant="primary" @click="openAccount(null)"><Plus :size="16" />{{ t('finance.bank.accounts.new') }}</Button>
    </EmptyState>
    <ul v-else class="accts">
      <li v-for="a in accounts" :key="a.id" :class="{ off: !a.isActive }">
        <div class="main">
          <b>{{ a.name }}</b>
          <small>{{ [a.bankName, a.last4 ? `•••• ${a.last4}` : ''].filter(Boolean).join(' · ') || t('finance.bank.accounts.noBank') }}</small>
          <span class="tags">
            <Badge v-if="!a.isActive">{{ t('finance.bank.accounts.inactive') }}</Badge>
            <Badge :tone="a.hasMapping ? 'success' : 'neutral'"><FileSpreadsheet :size="12" />{{ a.hasMapping ? t('finance.bank.accounts.hasMapping') : t('finance.bank.accounts.noMapping') }}</Badge>
            <span class="last">{{ a.lastStatementTo ? t('finance.bank.accounts.lastTo', { date: fmtDay(a.lastStatementTo, locale) }) : t('finance.bank.accounts.noStatements') }}</span>
          </span>
        </div>
        <div class="acts">
          <button type="button" class="ico" :title="t('finance.bank.accounts.edit')" :aria-label="t('finance.bank.accounts.edit')" @click="openAccount(a)"><Pencil :size="16" /></button>
          <button type="button" class="ico" :class="{ on: a.isActive }" :disabled="busy === a.id"
            :title="a.isActive ? t('finance.bank.accounts.deactivate') : t('finance.bank.accounts.activate')"
            :aria-label="a.isActive ? t('finance.bank.accounts.deactivate') : t('finance.bank.accounts.activate')" @click="toggle(a)"><Power :size="16" /></button>
        </div>
      </li>
    </ul>
    <p class="hint">{{ t('finance.bank.accounts.mappingHint') }}</p>
    <BankAccountModal v-model="modal" :account="editing" />
  </section>
</template>

<style scoped>
.card { display: grid; gap: 14px; align-content: start; padding: 18px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); border-left: 4px solid var(--color-leaf); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.head > div { display: grid; gap: 2px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.head small { color: var(--color-muted); }
.card :deep(.empty) { box-shadow: none; background: var(--color-canvas); }

.accts { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.accts li { display: flex; align-items: flex-start; gap: 8px; padding: 12px 8px 12px 14px; border-top: 1px solid var(--color-line); border-left: 3px solid var(--color-leaf); transition: background var(--duration); }
.accts li:first-child { border-top: 0; }
.accts li:hover { background: var(--color-canvas); }
.accts li.off { border-left-color: var(--color-line-strong); }
.accts li.off b, .accts li.off small { color: var(--color-muted); }
.main { flex: 1; min-width: 0; display: grid; gap: 2px; }
.main b { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main small { font-size: 13px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
.tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 4px; }
.last { font-size: 12px; color: var(--color-muted); }
.acts { display: flex; flex: none; }
.ico { width: 36px; height: 36px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }
.ico.on { color: var(--color-success); }
.hint { margin: -4px 0 0; font-size: 13px; color: var(--color-muted); }
@media (max-width: 767px) { .card { padding: 16px; } }
</style>
