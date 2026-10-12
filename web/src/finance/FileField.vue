<script setup lang="ts">
// Adjunto único de Finanzas (comprobante de un gasto; el CSV de un estado de cuenta con context="bank_statement").
// Usa el flujo normal de archivos (POST /files → PUT → complete). El modelo es el fileId; `file` muestra el ya guardado.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Paperclip, X, FileText, LoaderCircle } from 'lucide-vue-next';
import type { FileRef } from '@agencia-hub/contracts';
import { useSession } from '@/stores/session.ts';
import { uploadFile, type Upload } from '@/chat/upload.ts';

const fileId = defineModel<string | null>({ default: null });
const props = withDefaults(defineProps<{
  file?: FileRef | null; label?: string; hint?: string;
  context?: 'expense' | 'bank_statement'; accept?: string;
}>(), { file: null, context: 'expense', accept: 'application/pdf,image/jpeg,image/png,image/webp,image/heic' });
/** `uploading` avisa al formulario para que no guarde a mitad de la subida */
const emit = defineEmits<{ uploaded: [file: FileRef]; uploading: [busy: boolean] }>();
const { t } = useI18n();
const s = useSession();

const input = ref<HTMLInputElement>();
const up = ref<Upload | null>(null);
/** Archivo visible: el recién subido o el guardado (si el modelo sigue apuntando a él) */
const shown = computed<FileRef | null>(() => up.value?.file ?? (props.file && props.file.id === fileId.value ? props.file : null));
watch(() => props.file, () => { up.value = null; });

async function pick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  const maxMb = s.workspace!.settings.maxFileMb;
  const u = uploadFile(s.workspace!.slug, f, maxMb,
    { tooBig: t('chat.tooBig', { name: f.name, mb: maxMb }), failed: t('chat.uploadFailed', { name: f.name }) }, props.context);
  up.value = u;
  emit('uploading', true);
  await u.done;
  emit('uploading', false);
  if (u.file) { fileId.value = u.file.id; emit('uploaded', u.file); }
}
function clear() {
  up.value = null;
  fileId.value = null;
}
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
</script>

<template>
  <div class="ff">
    <span v-if="label" class="lbl">{{ label }}</span>
    <div v-if="shown" class="chip">
      <FileText :size="18" />
      <a :href="shown.url" target="_blank" rel="noopener">{{ shown.name }}</a>
      <small>{{ kb(shown.size) }}</small>
      <button type="button" class="x" :aria-label="t('finance.file.remove')" :title="t('finance.file.remove')" @click="clear"><X :size="15" /></button>
    </div>
    <div v-else-if="up && !up.error" class="chip busy">
      <LoaderCircle :size="18" class="spin" /><span>{{ up.name }}</span><small>{{ Math.round(up.progress * 100) }} %</small>
    </div>
    <template v-else>
      <button type="button" class="pick" @click="input?.click()"><Paperclip :size="16" />{{ t('finance.file.attach') }}</button>
      <p v-if="up?.error" class="err" role="alert">{{ up.error }}</p>
    </template>
    <small v-if="hint" class="hint">{{ hint }}</small>
    <input ref="input" type="file" :accept="accept" hidden @change="pick">
  </div>
</template>

<style scoped>
.ff { display: grid; gap: 6px; justify-items: start; }
.lbl { font-size: 13px; font-weight: 500; }
.pick { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 14px; font: inherit; font-size: 14px; font-weight: 500; color: var(--color-ink); cursor: pointer;
  background: var(--color-surface); border: 1px dashed var(--color-line-strong); box-shadow: var(--shadow-sm); transition: border-color var(--duration), box-shadow var(--duration); }
.pick:hover { border-color: var(--color-ink); box-shadow: var(--shadow-md); }
.chip { display: flex; align-items: center; gap: 8px; max-width: 100%; min-height: 40px; padding: 0 4px 0 12px; font-size: 14px; background: var(--color-canvas); border-left: 3px solid var(--color-leaf); box-shadow: var(--shadow-sm); }
.chip a, .chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-leaf); font-weight: 500; }
.chip small { flex: none; color: var(--color-muted); font-size: 12px; }
.chip.busy { border-left-color: var(--color-primary); }
.chip.busy span { color: var(--color-ink); }
.x { display: grid; place-items: center; width: 32px; height: 32px; flex: none; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.x:hover { color: var(--color-danger); background: var(--color-surface); }
.spin { animation: spin 1s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.err { margin: 0; font-size: 13px; color: var(--color-danger); }
.hint { font-size: 12px; color: var(--color-muted); }
</style>
