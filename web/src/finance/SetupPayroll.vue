<script setup lang="ts">
// Configuración de nómina (fase B): calendarios de pago y personas con sus componentes.
// Marcador: lo rellena el agente de Nómina. Se muestra a todo el ancho bajo categorías y cuentas.
import { useI18n } from 'vue-i18n';
import { CalendarClock } from 'lucide-vue-next';
import EmptyState from '@/design/EmptyState.vue';

const { t } = useI18n();
</script>

<template>
  <section class="card">
    <header class="head"><h2><CalendarClock :size="20" />{{ t('finance.setup.payroll') }}</h2><small>{{ t('finance.setup.payrollHint') }}</small></header>
    <EmptyState :title="t('finance.soon.payroll')" :text="t('finance.soon.payrollText')" />
  </section>
</template>

<style scoped>
.card { display: grid; gap: 14px; align-content: start; padding: 18px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); border-left: 4px solid var(--color-ink); }
.head { display: grid; gap: 2px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.head small { color: var(--color-muted); }
.card :deep(.empty) { box-shadow: none; background: var(--color-canvas); }
</style>
