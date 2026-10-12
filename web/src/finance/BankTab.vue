<script setup lang="ts">
// Banco (fase C): movimientos por cuenta, carga manual, importación CSV con mapeo y estados de cuenta. Las cuentas se configuran en SetupBank.vue.
// Por ahora es un marcador: lo rellena el agente de esa fase sobre la base de FinancePage (store, format, DateFilter).
import { useI18n } from 'vue-i18n';
import { Landmark } from 'lucide-vue-next';
import EmptyState from '@/design/EmptyState.vue';

defineEmits<{ go: [tab: 'summary' | 'expenses' | 'payroll' | 'bank' | 'setup'] }>();
const { t } = useI18n();
</script>

<template>
  <div class="body">
    <EmptyState :icon="Landmark" :title="t('finance.soon.bank')" :text="t('finance.soon.bankText')" />
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
@media (max-width: 767px) { .body { padding: 14px 16px 32px; } }
</style>
