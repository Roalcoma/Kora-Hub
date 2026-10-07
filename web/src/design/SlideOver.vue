<script setup lang="ts">
// Panel lateral derecho (hilos, perfiles, detalle de tarea). En móvil ocupa toda la pantalla.
import { ref, watch, onMounted } from 'vue';
import { X } from 'lucide-vue-next';

const open = defineModel<boolean>({ default: false });
defineProps<{ title: string; subtitle?: string }>();
const dlg = ref<HTMLDialogElement>();
const sync = () => {
  if (open.value && !dlg.value?.open) dlg.value?.showModal();
  if (!open.value && dlg.value?.open) dlg.value.close();
};
onMounted(sync);
watch(open, sync);
</script>

<template>
  <dialog ref="dlg" class="slide" @close="open = false" @click.self="open = false">
    <div class="inner">
      <header>
        <div><h2>{{ title }}</h2><small v-if="subtitle">{{ subtitle }}</small></div>
        <button class="x" type="button" aria-label="Cerrar" @click="open = false"><X :size="18" /></button>
      </header>
      <div class="body"><slot /></div>
    </div>
  </dialog>
</template>

<style scoped>
.slide { margin: 0 0 0 auto; height: 100dvh; max-height: 100dvh; width: 400px; max-width: 100vw; padding: 0; border: 0; background: var(--color-surface); color: var(--color-ink); box-shadow: var(--shadow-lg); }
.slide::backdrop { background: rgb(19 36 61 / .25); }
.slide[open] { animation: in 180ms ease-out; }
@keyframes in { from { transform: translateX(24px); opacity: 0; } }
.inner { display: flex; flex-direction: column; height: 100%; padding-top: env(safe-area-inset-top, 0px); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 56px; padding: 0 12px 0 20px; border-bottom: 1px solid var(--color-line); }
h2 { margin: 0; font-size: 17px; }
small { color: var(--color-muted); font-size: 12px; }
.x { width: var(--tap); height: var(--tap); display: grid; place-items: center; background: none; border: 0; cursor: pointer; color: inherit; }
.body { flex: 1; overflow: auto; padding: 16px 20px calc(16px + env(safe-area-inset-bottom, 0px)); }
@media (max-width: 767px) { .slide { width: 100vw; } }
</style>
