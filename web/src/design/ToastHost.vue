<script setup lang="ts">
import { CircleCheck, CircleAlert, Info, X } from 'lucide-vue-next';
import { toasts, dismiss } from './toast.ts';
const icons = { success: CircleCheck, error: CircleAlert, info: Info };
</script>

<template>
  <div class="host" aria-live="polite">
    <TransitionGroup name="t">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.tone" :role="t.tone === 'error' ? 'alert' : 'status'">
        <component :is="icons[t.tone]" :size="18" />
        <span>{{ t.text }}</span>
        <button type="button" aria-label="Cerrar" @click="dismiss(t.id)"><X :size="16" /></button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.host { position: fixed; z-index: 100; left: 50%; transform: translateX(-50%); bottom: calc(24px + env(safe-area-inset-bottom, 0px)); display: grid; gap: 8px; width: min(420px, calc(100vw - 32px)); }
.toast { display: flex; align-items: center; gap: 10px; padding: 10px 8px 10px 14px; background: var(--color-ink); color: #fff; box-shadow: var(--shadow-lg); border-left: 4px solid var(--color-cta); font-size: 14px; }
.toast.success { border-left-color: var(--color-presence); }
.toast.error { border-left-color: var(--color-primary); }
.toast span { flex: 1; }
button { width: 32px; height: 32px; display: grid; place-items: center; background: none; border: 0; color: var(--color-sidebar-text); cursor: pointer; }
.t-enter-active, .t-leave-active { transition: opacity 180ms, transform 180ms; }
.t-enter-from, .t-leave-to { opacity: 0; transform: translateY(8px); }
</style>
