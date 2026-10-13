<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ToastHost from '@/design/ToastHost.vue';
import ImpersonationBand from '@/layouts/ImpersonationBand.vue';
import MaintenanceBand from '@/layouts/MaintenanceBand.vue';
import UpdateBand from '@/layouts/UpdateBand.vue';
import { useSession } from '@/stores/session.ts';
import { publicConfig } from '@/platform/config.ts';
import { updateReady } from '@/platform/update.ts';

const s = useSession();
const route = useRoute();
// El aviso del respaldo se ve dentro de la app (shell de agencia y backoffice), no en login ni onboarding
const inApp = computed(() => !!s.session && (route.path.startsWith('/admin')
  || (route.path.startsWith('/w/') && !route.path.endsWith('/onboarding'))));
const showMaint = computed(() => inApp.value && !!publicConfig.value?.maintenance);
</script>

<template>
  <!-- Las bandas (impersonación, respaldo) quedan fijas arriba y empujan el resto de la app hacia abajo. Con alguna
       banda arriba, ella toma el safe-area del iPhone y el shell deja de sumarlo (--safe-top) -->
  <div class="app">
    <div class="app-top">
      <ImpersonationBand v-if="s.impersonation" />
      <MaintenanceBand v-if="showMaint" :edge="!s.impersonation" />
      <UpdateBand v-if="updateReady" :edge="!s.impersonation && !showMaint" />
    </div>
    <div class="app-body"><RouterView /></div>
  </div>
  <ToastHost />
</template>

<style scoped>
.app { --safe-top: env(safe-area-inset-top, 0px); height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); }
/* La franja del respaldo puede ocultarse sola (cerrada o fuera de hora): entonces .app-top queda vacío y vuelve el safe-area */
.app:has(> .app-top > *) { --safe-top: 0px; }
.app-top { position: relative; z-index: 50; }
/* Fila 2 explícita: sin banda, el cuerpo no debe caer en la fila automática */
.app-body { grid-row: 2; min-height: 0; }
</style>
