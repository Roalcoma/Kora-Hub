<script setup lang="ts">
// Configuración del banco (fase C): cuentas bancarias y su mapeo de CSV.
// Marcador: lo rellena el agente de Banco. Va en la columna derecha, junto a las categorías.
import { useI18n } from 'vue-i18n';
import { Landmark } from 'lucide-vue-next';
import EmptyState from '@/design/EmptyState.vue';

const { t } = useI18n();
</script>

<template>
  <section class="card">
    <header class="head"><h2><Landmark :size="20" />{{ t('finance.setup.bank') }}</h2><small>{{ t('finance.setup.bankHint') }}</small></header>
    <EmptyState :title="t('finance.soon.bank')" :text="t('finance.soon.bankText')" />
  </section>
</template>

<style scoped>
.card { display: grid; gap: 14px; align-content: start; padding: 18px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); border-left: 4px solid var(--color-leaf); }
.head { display: grid; gap: 2px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.head small { color: var(--color-muted); }
.card :deep(.empty) { box-shadow: none; background: var(--color-canvas); }
</style>
