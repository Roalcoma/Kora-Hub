<script setup lang="ts">
// <dialog> nativo: foco atrapado, Esc y fondo inerte sin código propio.
import { ref, watch, onMounted } from 'vue';
import { X } from 'lucide-vue-next';

const open = defineModel<boolean>({ default: false });
defineProps<{ title: string; width?: string }>();
const dlg = ref<HTMLDialogElement>();

const sync = () => {
  if (open.value && !dlg.value?.open) dlg.value?.showModal();
  if (!open.value && dlg.value?.open) dlg.value.close();
};
onMounted(sync);
watch(open, sync);
</script>

<template>
  <dialog ref="dlg" class="modal" :style="{ width: width ?? '480px' }" @close="open = false" @click.self="open = false">
    <div class="inner">
      <header>
        <h2>{{ title }}</h2>
        <button class="x" type="button" aria-label="Cerrar" @click="open = false"><X :size="18" /></button>
      </header>
      <div class="body"><slot /></div>
      <footer v-if="$slots.footer"><slot name="footer" /></footer>
    </div>
  </dialog>
</template>

<style scoped>
.modal { max-width: calc(100vw - 32px); padding: 0; border: 0; background: var(--color-surface); color: var(--color-ink); box-shadow: var(--shadow-lg); }
.modal::backdrop { background: rgb(19 36 61 / .45); }
.modal[open] { animation: pop var(--duration) ease-out; }
@keyframes pop { from { opacity: 0; transform: translateY(8px); } }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 16px 12px 20px; border-bottom: 1px solid var(--color-line); }
h2 { margin: 0; font-size: 19px; }
.x { width: 36px; height: 36px; display: grid; place-items: center; background: none; border: 0; cursor: pointer; color: inherit; }
.x:hover { background: var(--color-canvas); }
.body { padding: 20px; display: grid; gap: 14px; }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid var(--color-line); background: #FBFAF7; }
</style>
