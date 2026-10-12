<script setup lang="ts">
// Nómina (fase B): corridas por calendario, borrador → aprobada → pagada, recibos y CSV. Personas y calendarios se configuran en SetupPayroll.vue.
// Por ahora es un marcador: lo rellena el agente de esa fase sobre la base de FinancePage (store, format, DateFilter).
import { useI18n } from 'vue-i18n';
import { Users } from 'lucide-vue-next';
import EmptyState from '@/design/EmptyState.vue';

defineEmits<{ go: [tab: 'summary' | 'expenses' | 'payroll' | 'bank' | 'setup'] }>();
const { t } = useI18n();
</script>

<template>
  <div class="body">
    <EmptyState :icon="Users" :title="t('finance.soon.payroll')" :text="t('finance.soon.payrollText')" />
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
@media (max-width: 767px) { .body { padding: 14px 16px 32px; } }
</style>
