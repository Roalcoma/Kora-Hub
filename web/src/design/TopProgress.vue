<script setup lang="ts">
// Barra fina naranja arriba, indeterminada, mientras algo tarda (design/progress.ts). Debajo de la barra de estado del iPhone.
import { progressVisible } from './progress.ts';
</script>

<template>
  <Transition name="tp">
    <div v-if="progressVisible" class="tp" role="progressbar" aria-busy="true" aria-label="Cargando"><span /></div>
  </Transition>
</template>

<style scoped>
.tp { position: fixed; z-index: 200; top: env(safe-area-inset-top, 0px); left: 0; right: 0; height: 3px; overflow: hidden; pointer-events: none; background: rgb(246 144 8 / .18); }
.tp span { position: absolute; top: 0; bottom: 0; left: -40%; width: 40%; background: linear-gradient(90deg, transparent, var(--color-primary) 30%, var(--color-cta, var(--color-primary)) 70%, transparent); box-shadow: 0 0 10px rgb(246 144 8 / .7); animation: tp 1s cubic-bezier(.4, 0, .2, 1) infinite; }
@keyframes tp { to { left: 100%; } }
.tp-enter-active { transition: opacity 120ms; }
.tp-leave-active { transition: opacity 300ms 80ms; }
.tp-enter-from, .tp-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .tp span { animation-duration: 2.4s; } }
</style>
