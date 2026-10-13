<script setup lang="ts">
// Franja «hay una versión nueva»: aparece cuando se publicó un cambio mientras la app estaba abierta (platform/update.ts).
// Mismo lenguaje que MaintenanceBand: naranja claro, acento lateral, sombra sobre el contenido.
import { useI18n } from 'vue-i18n';
import { RefreshCw } from 'lucide-vue-next';

defineProps<{ edge?: boolean }>();
const { t } = useI18n();
const reload = () => location.reload();
</script>

<template>
  <div class="uband no-print" :class="{ edge }" role="status" aria-live="polite">
    <span class="ico"><RefreshCw :size="18" /></span>
    <p><b>{{ t('update.title') }}</b> <span>{{ t('update.hint') }}</span></p>
    <button type="button" class="go" @click="reload">{{ t('update.action') }}</button>
  </div>
</template>

<style scoped>
.uband { position: relative; z-index: 4; display: flex; align-items: center; gap: 12px; padding: 8px 10px 8px 18px; background: var(--color-primary-light); color: var(--color-ink); box-shadow: 0 4px 14px rgb(19 36 61 / .16); }
.uband.edge { padding-top: max(8px, env(safe-area-inset-top, 0px)); }
.uband::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-primary); }
.ico { width: 30px; height: 30px; display: grid; place-items: center; flex: none; background: var(--color-primary); color: var(--color-ink); }
p { flex: 1; min-width: 0; margin: 0; font-size: 14px; line-height: 1.4; }
b { font-weight: 700; }
.go { flex: none; min-height: 34px; padding: 0 14px; font: inherit; font-size: 13px; font-weight: 700; color: #fff; background: var(--color-ink); border: 0; box-shadow: var(--shadow-sm); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.go:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
@media (max-width: 767px) { p { font-size: 13px; } p span { display: none; } }
</style>
