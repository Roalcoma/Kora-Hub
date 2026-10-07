<script setup lang="ts">
// <dialog> nativo: foco atrapado, Esc y fondo inerte sin código propio. Siempre centrado.
import { nextTick, ref, watch, onMounted } from 'vue';
import { X } from 'lucide-vue-next';

const open = defineModel<boolean>({ default: false });
defineProps<{ title: string; subtitle?: string; width?: string }>();
const dlg = ref<HTMLDialogElement>();

const sync = async () => {
  if (open.value && !dlg.value?.open) {
    dlg.value?.showModal();
    // El foco va al primer campo del contenido, no al botón de cerrar
    await nextTick();
    const body = dlg.value?.querySelector('.body');
    (body?.querySelector<HTMLElement>('input:not([type="checkbox"]), textarea') ?? body?.querySelector<HTMLElement>('button'))?.focus();
  }
  if (!open.value && dlg.value?.open) dlg.value.close();
};
onMounted(sync);
watch(open, sync);
</script>

<template>
  <dialog ref="dlg" class="modal" :style="{ width: width ?? '480px' }" @close="open = false" @click.self="open = false">
    <div class="inner">
      <header>
        <div class="ttl">
          <h2>{{ title }}</h2>
          <p v-if="subtitle">{{ subtitle }}</p>
        </div>
        <button class="x" type="button" aria-label="Cerrar" @click="open = false"><X :size="18" /></button>
      </header>
      <div class="body"><slot /></div>
      <footer v-if="$slots.footer"><slot name="footer" /></footer>
    </div>
  </dialog>
</template>

<style scoped>
/* margin:auto lo centra; el reset de Tailwind lo pone en 0 y por eso se fija aquí */
.modal {
  margin: auto; max-width: calc(100vw - 32px); max-height: calc(100dvh - 48px); padding: 0; border: 0; overflow: visible;
  background: var(--color-surface); color: var(--color-ink);
  box-shadow: 0 28px 70px rgb(19 36 61 / .30), 0 6px 18px rgb(19 36 61 / .14), 0 0 0 1px rgb(19 36 61 / .06);
}
.modal::backdrop { background: rgb(19 36 61 / .42); backdrop-filter: blur(3px); }
.modal[open] { animation: pop 220ms cubic-bezier(.2, .8, .2, 1); }
.modal[open]::backdrop { animation: fade 220ms ease-out; }
@keyframes pop { from { opacity: 0; transform: translateY(14px) scale(.97); } }
@keyframes fade { from { opacity: 0; } }
.inner { display: flex; flex-direction: column; max-height: calc(100dvh - 48px); }
/* Encabezado asimétrico: acento naranja a la izquierda, cierre arriba a la derecha */
header { position: relative; display: flex; align-items: flex-start; gap: 12px; padding: 22px 14px 16px 28px; }
header::before { content: ''; position: absolute; left: 0; top: 22px; width: 5px; height: 30px; background: var(--color-primary); }
.ttl { flex: 1; min-width: 0; }
h2 { margin: 0; font-size: 22px; line-height: 1.2; }
.ttl p { margin: 6px 0 0; font-size: 14px; color: var(--color-muted); line-height: 1.45; }
.x { width: 38px; height: 38px; display: grid; place-items: center; flex: none; margin-top: -6px; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.x:hover { background: var(--color-canvas); color: var(--color-ink); }
.body { padding: 4px 28px 24px; display: grid; gap: 16px; overflow: auto; }
footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; padding: 14px 28px; background: var(--color-canvas); border-top: 1px solid var(--color-line); box-shadow: inset 0 6px 10px -10px rgb(19 36 61 / .25); }
@media (max-width: 767px) {
  .modal { max-height: calc(100dvh - 24px); }
  header { padding: 18px 10px 12px 22px; }
  .body { padding: 4px 22px 20px; }
  footer { padding: 12px 22px calc(12px + env(safe-area-inset-bottom, 0px)); }
}
@media (prefers-reduced-motion: reduce) { .modal[open], .modal[open]::backdrop { animation: none; } }
</style>
