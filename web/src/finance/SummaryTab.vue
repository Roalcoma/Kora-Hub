<script setup lang="ts">
// Resumen de Finanzas (fase D): periodo con DateFilter + financeRange, entradas del banco, gastos pagados, nómina pagada, resultado, gastos por categoría, próximos pagos y vencidos.
// Por ahora es un marcador: lo rellena el agente de esa fase sobre la base de FinancePage (store, format, DateFilter).
import { useI18n } from 'vue-i18n';
import { LayoutDashboard } from 'lucide-vue-next';
import EmptyState from '@/design/EmptyState.vue';

defineEmits<{ go: [tab: 'summary' | 'expenses' | 'payroll' | 'bank' | 'setup'] }>();
const { t } = useI18n();
</script>

<template>
  <div class="body">
    <EmptyState :icon="LayoutDashboard" :title="t('finance.soon.summary')" :text="t('finance.soon.summaryText')" />
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
@media (max-width: 767px) { .body { padding: 14px 16px 32px; } }
</style>
