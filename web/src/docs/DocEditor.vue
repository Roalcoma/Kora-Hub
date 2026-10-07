<script setup lang="ts">
// Editor de manuales con Tiptap: títulos, listas, tablas, imágenes (subidas a la agencia) y enlaces.
// Solo lectura usa el mismo esquema, así el contenido nunca se pinta como HTML libre.
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import {
  Heading2, Heading3, Bold, Italic, Strikethrough, List, ListOrdered, Quote, Link2, ImagePlus, Table2, Undo2, Redo2,
  Rows3, Columns3, Trash2,
} from 'lucide-vue-next';
import Popover from '@/design/Popover.vue';
import { toast } from '@/design/toast.ts';
import { useSession } from '@/stores/session.ts';
import { uploadFile } from '@/chat/upload.ts';

const props = defineProps<{ content: unknown; editable: boolean }>();
const emit = defineEmits<{ change: [content: object] }>();
const { t } = useI18n();
const s = useSession();

const editor = useEditor({
  content: props.content as object,
  editable: props.editable,
  extensions: [
    StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: !props.editable, autolink: true, defaultProtocol: 'https' } }),
    Image,
    TableKit.configure({ table: { resizable: false } }),
  ],
  onUpdate: ({ editor: e }) => emit('change', e.getJSON()),
});
// ponytail: el padre recrea el editor (key) al entrar o salir de edición; así también cambia "abrir enlace al clic"
onBeforeUnmount(() => editor.value?.destroy());

const chain = () => editor.value!.chain().focus();
const active = (name: string, attrs?: object) => !!editor.value?.isActive(name, attrs);

// ─── Enlace (sin prompt nativo) ───
const linkOpen = ref(false);
const href = ref('');
watch(linkOpen, (v) => { if (v) href.value = editor.value?.getAttributes('link').href ?? ''; });
function applyLink() {
  const url = href.value.trim();
  if (!url) chain().extendMarkRange('link').unsetLink().run();
  else chain().extendMarkRange('link').setLink({ href: /^(https?:|mailto:|tel:|\/)/i.test(url) ? url : `https://${url}` }).run();
  linkOpen.value = false;
}

// ─── Imagen: se sube como archivo de la agencia y se inserta con su URL interna ───
const picker = ref<HTMLInputElement>();
async function onImage(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  const u = uploadFile(s.workspace!.slug, f, s.workspace!.settings.maxFileMb, { tooBig: t('chat.tooBig'), failed: t('chat.uploadFailed') }, 'document');
  await u.done;
  if (u.error || !u.file) return toast(u.error ?? t('common.error'), 'error');
  chain().setImage({ src: u.file.url, alt: u.file.name }).run();
}
</script>

<template>
  <div class="ed" :class="{ editing: editable }">
    <div v-if="editable && editor" class="bar" role="toolbar" :aria-label="t('docs.toolbar')">
      <div class="grp">
        <button type="button" :class="{ on: active('heading', { level: 2 }) }" :title="t('docs.h2')" :aria-label="t('docs.h2')" @click="chain().toggleHeading({ level: 2 }).run()"><Heading2 :size="18" /></button>
        <button type="button" :class="{ on: active('heading', { level: 3 }) }" :title="t('docs.h3')" :aria-label="t('docs.h3')" @click="chain().toggleHeading({ level: 3 }).run()"><Heading3 :size="18" /></button>
      </div>
      <div class="grp">
        <button type="button" :class="{ on: active('bold') }" :title="t('docs.bold')" :aria-label="t('docs.bold')" @click="chain().toggleBold().run()"><Bold :size="17" /></button>
        <button type="button" :class="{ on: active('italic') }" :title="t('docs.italic')" :aria-label="t('docs.italic')" @click="chain().toggleItalic().run()"><Italic :size="17" /></button>
        <button type="button" :class="{ on: active('strike') }" :title="t('docs.strike')" :aria-label="t('docs.strike')" @click="chain().toggleStrike().run()"><Strikethrough :size="17" /></button>
        <Popover v-model="linkOpen" placement="bottom-start">
          <template #trigger>
            <button type="button" :class="{ on: active('link') }" :title="t('docs.link')" :aria-label="t('docs.link')" @click="linkOpen = !linkOpen"><Link2 :size="17" /></button>
          </template>
          <form class="link-pop" @submit.prevent="applyLink">
            <input v-model="href" :placeholder="t('docs.linkPlaceholder')" :aria-label="t('docs.link')" autofocus>
            <button type="submit">{{ t('docs.apply') }}</button>
          </form>
        </Popover>
      </div>
      <div class="grp">
        <button type="button" :class="{ on: active('bulletList') }" :title="t('docs.bullets')" :aria-label="t('docs.bullets')" @click="chain().toggleBulletList().run()"><List :size="18" /></button>
        <button type="button" :class="{ on: active('orderedList') }" :title="t('docs.numbers')" :aria-label="t('docs.numbers')" @click="chain().toggleOrderedList().run()"><ListOrdered :size="18" /></button>
        <button type="button" :class="{ on: active('blockquote') }" :title="t('docs.quote')" :aria-label="t('docs.quote')" @click="chain().toggleBlockquote().run()"><Quote :size="17" /></button>
      </div>
      <div class="grp">
        <button type="button" :title="t('docs.image')" :aria-label="t('docs.image')" @click="picker?.click()"><ImagePlus :size="18" /></button>
        <button type="button" :title="t('docs.table')" :aria-label="t('docs.table')" @click="chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()"><Table2 :size="18" /></button>
        <template v-if="active('table')">
          <button type="button" :title="t('docs.addRow')" :aria-label="t('docs.addRow')" @click="chain().addRowAfter().run()"><Rows3 :size="17" /></button>
          <button type="button" :title="t('docs.addCol')" :aria-label="t('docs.addCol')" @click="chain().addColumnAfter().run()"><Columns3 :size="17" /></button>
          <button type="button" :title="t('docs.deleteTable')" :aria-label="t('docs.deleteTable')" @click="chain().deleteTable().run()"><Trash2 :size="16" /></button>
        </template>
      </div>
      <div class="grp end">
        <button type="button" :title="t('docs.undo')" :aria-label="t('docs.undo')" :disabled="!editor.can().undo()" @click="chain().undo().run()"><Undo2 :size="17" /></button>
        <button type="button" :title="t('docs.redo')" :aria-label="t('docs.redo')" :disabled="!editor.can().redo()" @click="chain().redo().run()"><Redo2 :size="17" /></button>
      </div>
      <input ref="picker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden @change="onImage">
    </div>
    <EditorContent :editor="editor" class="content" />
  </div>
</template>

<style scoped>
.ed { display: grid; }
/* Barra flotante y pegajosa: proyecta sombra sobre el texto al desplazarse */
.bar { position: sticky; top: 0; z-index: 3; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px 8px; margin-bottom: 18px; background: var(--color-surface); box-shadow: var(--shadow-md), 0 0 0 1px rgb(19 36 61 / .05); }
.grp { display: flex; gap: 2px; padding-right: 6px; margin-right: 2px; border-right: 1px solid var(--color-line); }
.grp.end { margin-left: auto; border-right: 0; padding-right: 0; }
.bar button { width: 34px; height: 34px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration), box-shadow var(--duration); }
.bar button:hover:not(:disabled) { color: var(--color-ink); background: var(--color-canvas); }
.bar button.on { color: var(--color-ink); background: var(--color-primary-light); box-shadow: inset 0 -2px 0 var(--color-primary); }
.bar button:disabled { opacity: .35; cursor: default; }
.link-pop { display: flex; gap: 6px; width: 320px; padding: 8px; background: var(--color-surface); box-shadow: var(--shadow-lg), 0 0 0 1px rgb(19 36 61 / .06); }
.link-pop input { flex: 1; min-height: 36px; padding: 0 10px; font: inherit; border: 1px solid var(--color-line-strong); outline: none; }
.link-pop input:focus { border-color: var(--color-ink); }
.link-pop button { width: auto; padding: 0 12px; font: inherit; font-size: 14px; font-weight: 600; color: var(--color-ink); background: var(--color-primary); }

/* Tipografía del manual: columna de lectura cómoda, alineada a la izquierda */
.content :deep(.tiptap) { max-width: 760px; outline: none; font-size: 16px; line-height: 1.65; color: var(--color-ink); }
.editing .content :deep(.tiptap) { min-height: 50vh; }
.content :deep(h2) { margin: 1.6em 0 .5em; font-size: 23px; line-height: 1.25; }
.content :deep(h3) { margin: 1.4em 0 .4em; font-size: 18px; }
.content :deep(p) { margin: 0 0 .8em; }
.content :deep(ul), .content :deep(ol) { margin: 0 0 .9em; padding-left: 1.4em; }
.content :deep(ul) { list-style: disc; }
.content :deep(ol) { list-style: decimal; }
.content :deep(ol li::marker) { font-weight: 600; color: var(--color-muted); }
.content :deep(li > p) { margin: 0 0 .25em; }
.content :deep(ul li::marker) { color: var(--color-primary); }
.content :deep(blockquote) { margin: 1em 0; padding: 10px 16px; background: var(--color-surface); border-left: 4px solid var(--color-cta); box-shadow: var(--shadow-sm); }
.content :deep(blockquote p:last-child) { margin: 0; }
.content :deep(code) { padding: 1px 5px; font-size: .9em; background: var(--color-canvas-deep); }
.content :deep(a) { color: var(--color-leaf); text-underline-offset: 2px; }
.content :deep(img) { display: block; max-width: 100%; height: auto; margin: 1em 0; box-shadow: var(--shadow-md); }
.content :deep(img.ProseMirror-selectednode) { outline: 3px solid var(--color-primary); }
.content :deep(.tableWrapper) { overflow-x: auto; margin: 1em 0; box-shadow: var(--shadow-sm); }
.content :deep(table) { width: 100%; border-collapse: collapse; background: var(--color-surface); font-size: 15px; }
.content :deep(th), .content :deep(td) { position: relative; min-width: 90px; padding: 8px 10px; text-align: left; vertical-align: top; border: 1px solid var(--color-line); }
.content :deep(th) { background: var(--color-canvas-deep); font-weight: 600; }
.content :deep(td p), .content :deep(th p) { margin: 0; }
.content :deep(.selectedCell)::after { content: ''; position: absolute; inset: 0; background: rgb(246 144 8 / .14); pointer-events: none; }
.content :deep(p.is-editor-empty:first-child)::before { content: attr(data-placeholder); float: left; height: 0; color: var(--color-muted); pointer-events: none; }
@media (max-width: 767px) { .bar { margin: 0 -12px 14px; } .grp.end { display: none; } }
</style>
