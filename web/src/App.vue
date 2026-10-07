<script setup lang="ts">
import ToastHost from '@/design/ToastHost.vue';
import ImpersonationBand from '@/layouts/ImpersonationBand.vue';
import { useSession } from '@/stores/session.ts';

const s = useSession();
</script>

<template>
  <!-- La banda de impersonación queda fija arriba y empuja el resto de la app hacia abajo -->
  <div class="app">
    <ImpersonationBand v-if="s.impersonation" />
    <div class="app-body"><RouterView /></div>
  </div>
  <ToastHost />
</template>

<style scoped>
.app { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); }
/* Fila 2 explícita: sin banda, el cuerpo no debe caer en la fila automática */
.app-body { grid-row: 2; min-height: 0; }
</style>
