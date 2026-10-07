<script setup lang="ts">
// Una página de manual: lectura para todos; Admin y Líder del departamento editan con guardado automático.
// Historial de versiones con vista previa y "Restaurar", adjuntos (PDF/Office) y enlace para compartir en el chat.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  Pencil, Check, History, Link2, Archive, FilePlus2, Paperclip, FileText, ChevronLeft, ChevronRight, RotateCcw, CircleAlert, X,
} from 'lucide-vue-next';
import type { Document, DocumentVersion, DocumentVersionDetail, Routes } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Dropdown from '@/design/Dropdown.vue';
import Modal from '@/design/Modal.vue';
import SlideOver from '@/design/SlideOver.vue';
import Skeleton from '@/design/Skeleton.vue';
import Avatar from '@/design/Avatar.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';
import { uploadFile, type Upload } from '@/chat/upload.ts';
import { errorText } from '@/platform/errors.ts';
import DocEditor from './DocEditor.vue';
import NewDocModal from './NewDocModal.vue';
import { useDocs } from './store.ts';

const props = defineProps<{ id: string }>();
const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const chat = useChat();
const docs = useDocs();
const slug = () => s.workspace!.slug;
const params = () => ({ slug: slug(), id: props.id });

const doc = ref<Document | null>(null);
const missing = ref(false);
const editing = ref(false);
const rev = ref(0);   // fuerza a recrear el editor (restaurar versión, entrar/salir de edición)

async function load() {
  doc.value = null;
  missing.value = false;
  try {
    doc.value = await api('GET /w/:slug/documents/:id', { params: params() });
    editing.value = doc.value.canEdit && route.query.edit === '1';
  } catch {
    missing.value = true;
  }
}
watch(() => props.id, load, { immediate: true });

const trail = computed(() => docs.trail(props.id).slice(0, -1));

// ─── Guardado automático ───
const state = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
let pending: object | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
async function patch(body: Routes['PATCH /w/:slug/documents/:id']['body']) {
  state.value = 'saving';
  try {
    const updated = await api('PATCH /w/:slug/documents/:id', { params: params(), body });
    if (doc.value && updated.id === doc.value.id) Object.assign(doc.value, { title: updated.title, lineId: updated.lineId, updatedAt: updated.updatedAt, updatedBy: updated.updatedBy, files: updated.files });
    docs.upsert(updated);
    state.value = 'saved';
  } catch (e) {
    state.value = 'error';
    toast(errorText(e), 'error');
  }
}
async function flush() {
  clearTimeout(timer);
  if (!pending) return;
  const content = pending;
  pending = null;
  await patch({ content });
}
function onChange(content: object) {
  pending = content;
  if (doc.value) doc.value.content = content;
  state.value = 'saving';
  clearTimeout(timer);
  timer = setTimeout(flush, 1200);
}
onBeforeRouteLeave(flush);
onBeforeRouteUpdate(flush);
onBeforeUnmount(flush);
window.addEventListener('beforeunload', flush);
onBeforeUnmount(() => window.removeEventListener('beforeunload', flush));

async function toggleEdit() {
  if (editing.value) await flush();
  editing.value = !editing.value;
  rev.value++;
  if (route.query.edit) router.replace({ query: {} });
}
const title = ref('');
watch(doc, (v) => { title.value = v?.title ?? ''; });
const saveTitle = () => { const v = title.value.trim(); if (v && v !== doc.value?.title) patch({ title: v }); else title.value = doc.value?.title ?? ''; };
const lineOptions = computed(() => [{ value: '', label: t('docs.allLines') },
  ...s.workspace!.lines.filter((l) => !l.archivedAt).map((l) => ({ value: l.id, label: l.name }))]);
const lineId = computed({ get: () => doc.value?.lineId ?? '', set: (v: string) => patch({ lineId: v || null }) });

// ─── Adjuntos ───
const uploads = ref<Upload[]>([]);
const filePicker = ref<HTMLInputElement>();
async function onFiles(e: Event) {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  (e.target as HTMLInputElement).value = '';
  const ups = files.map((f) => uploadFile(slug(), f, s.workspace!.settings.maxFileMb, { tooBig: t('chat.tooBig'), failed: t('chat.uploadFailed') }, 'document'));
  uploads.value.push(...ups);
  await Promise.all(ups.map((u) => u.done));
  const ok = ups.filter((u) => u.file).map((u) => u.file!.id);
  for (const u of ups) if (u.error) toast(`${u.name}: ${u.error}`, 'error');
  uploads.value = uploads.value.filter((u) => !ups.includes(u));
  if (ok.length && doc.value) await patch({ fileIds: [...doc.value.files.map((f) => f.id), ...ok] });
}
const detach = (fileId: string) => patch({ fileIds: doc.value!.files.filter((f) => f.id !== fileId).map((f) => f.id) });
const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// ─── Compartir ───
async function copyLink() {
  try {
    await navigator.clipboard.writeText(`${location.origin}/w/${slug()}/manuals/${props.id}`);
    toast(t('docs.linkCopied'), 'success');
  } catch { toast(t('common.error'), 'error'); }
}

// ─── Versiones ───
const versionsOpen = ref(false);
const versions = ref<DocumentVersion[] | null>(null);
const preview = ref<DocumentVersionDetail | null>(null);
watch(versionsOpen, async (v) => {
  if (!v) return;
  await flush();
  versions.value = null;
  preview.value = null;
  versions.value = await api('GET /w/:slug/documents/:id/versions', { params: params() });
});
const showVersion = async (versionId: string) => {
  preview.value = await api('GET /w/:slug/documents/:id/versions/:versionId', { params: { ...params(), versionId } });
};
async function restore() {
  try {
    doc.value = await api('POST /w/:slug/documents/:id/versions/:versionId/restore', { params: { ...params(), versionId: preview.value!.id } });
    docs.upsert(doc.value);
    rev.value++;
    versionsOpen.value = false;
    toast(t('docs.restored'), 'success');
  } catch (e) { toast(errorText(e), 'error'); }
}

// ─── Archivar y subpágina ───
const archiveOpen = ref(false);
async function archive() {
  try {
    await api('PATCH /w/:slug/documents/:id', { params: params(), body: { archived: true } });
    docs.removeTree(props.id);
    archiveOpen.value = false;
    toast(t('docs.archived'), 'success');
    router.push(`/w/${slug()}/manuals`);
  } catch (e) { toast(errorText(e), 'error'); }
}
const subOpen = ref(false);
const childCount = computed(() => docs.nodes.filter((n) => n.parentId === props.id).length);
</script>

<template>
  <article class="view">
    <div v-if="missing" class="gone"><CircleAlert :size="20" />{{ t('docs.notFound') }}</div>
    <div v-else-if="!doc" class="grid gap-4" style="max-width: 760px"><Skeleton height="40px" width="60%" /><Skeleton v-for="n in 5" :key="n" height="18px" /></div>
    <template v-else>
      <header class="head">
        <nav class="crumbs" :aria-label="t('docs.breadcrumbs')">
          <RouterLink :to="`/w/${s.workspace!.slug}/manuals`" class="back"><ChevronLeft :size="18" /></RouterLink>
          <span>{{ s.deptName(doc.departmentId) }}</span>
          <template v-for="n in trail" :key="n.id"><ChevronRight :size="13" /><RouterLink :to="`/w/${s.workspace!.slug}/manuals/${n.id}`">{{ n.title }}</RouterLink></template>
        </nav>
        <div class="actions">
          <span v-if="editing" class="state" :class="state">{{ state === 'saving' ? t('docs.saving') : state === 'error' ? t('docs.saveError') : state === 'saved' ? t('docs.saved') : '' }}</span>
          <Button v-if="doc.canEdit" :variant="editing ? 'primary' : 'secondary'" size="sm" @click="toggleEdit">
            <Check v-if="editing" :size="15" /><Pencil v-else :size="15" />{{ editing ? t('docs.done') : t('docs.edit') }}
          </Button>
          <button type="button" class="ico" :title="t('docs.versions')" :aria-label="t('docs.versions')" @click="versionsOpen = true"><History :size="18" /></button>
          <button type="button" class="ico" :title="t('docs.share')" :aria-label="t('docs.share')" @click="copyLink"><Link2 :size="18" /></button>
          <template v-if="doc.canEdit">
            <button type="button" class="ico" :title="t('docs.newSubpage')" :aria-label="t('docs.newSubpage')" @click="subOpen = true"><FilePlus2 :size="18" /></button>
            <button type="button" class="ico" :title="t('docs.archive')" :aria-label="t('docs.archive')" @click="archiveOpen = true"><Archive :size="18" /></button>
          </template>
        </div>
      </header>

      <textarea v-if="editing" v-model="title" class="title" rows="1" :aria-label="t('docs.pageTitle')" @blur="saveTitle" @keydown.enter.prevent="($event.target as HTMLElement).blur()" />
      <h1 v-else class="title">{{ doc.title }}</h1>
      <div class="meta">
        <Dropdown v-if="editing" v-model="lineId" :options="lineOptions" class="line-dd" />
        <Badge v-else-if="doc.lineId" :tone="s.lineTone(doc.lineId)">{{ s.lineOf(doc.lineId)?.name }}</Badge>
        <span class="by"><Avatar :name="chat.nameOf(doc.updatedBy)" :size="20" />{{ t('docs.updatedBy', { name: chat.nameOf(doc.updatedBy), date: d(doc.updatedAt, 'short') }) }}</span>
      </div>

      <DocEditor :key="`${doc.id}-${editing}-${rev}`" :content="doc.content" :editable="editing" @change="onChange" />

      <section v-if="doc.files.length || editing || uploads.length" class="files">
        <h2><Paperclip :size="16" />{{ t('docs.attachments') }}</h2>
        <div class="file-list">
          <div v-for="f in doc.files" :key="f.id" class="file">
            <a :href="f.url" target="_blank" rel="noopener"><span class="fi"><FileText :size="18" /></span><span><b>{{ f.name }}</b><small>{{ size(f.size) }}</small></span></a>
            <button v-if="editing" type="button" :aria-label="t('docs.detach', { name: f.name })" @click="detach(f.id)"><X :size="15" /></button>
          </div>
          <div v-for="u in uploads" :key="u.key" class="file uploading"><span class="fi"><FileText :size="18" /></span><span><b>{{ u.name }}</b><small>{{ Math.round(u.progress * 100) }}%</small></span></div>
          <button v-if="editing" type="button" class="attach" @click="filePicker?.click()"><Paperclip :size="16" />{{ t('docs.attach') }}</button>
        </div>
        <input ref="filePicker" type="file" multiple hidden
          accept="application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,image/*" @change="onFiles">
      </section>

      <p v-if="childCount && !editing" class="children">{{ t('docs.subpages', { n: childCount }, childCount) }}</p>
    </template>

    <SlideOver v-model="versionsOpen" :title="t('docs.versions')" :subtitle="doc?.title" width="520px">
      <div class="versions">
        <div v-if="!versions" class="grid gap-2"><Skeleton v-for="n in 4" :key="n" height="48px" /></div>
        <button v-for="(v, i) in versions ?? []" :key="v.id" type="button" class="ver" :class="{ on: preview?.id === v.id }" @click="showVersion(v.id)">
          <Avatar :name="chat.nameOf(v.editedBy)" :size="28" />
          <span class="info"><b>{{ chat.nameOf(v.editedBy) }}</b><small>{{ d(v.createdAt, 'long') }}</small></span>
          <Badge v-if="i === 0" tone="success">{{ t('docs.current') }}</Badge>
        </button>
        <div v-if="preview" class="preview">
          <div class="pv-head">
            <h3>{{ preview.title }}</h3>
            <Button v-if="doc?.canEdit && preview.id !== versions?.[0]?.id" variant="primary" size="sm" @click="restore"><RotateCcw :size="15" />{{ t('docs.restore') }}</Button>
          </div>
          <DocEditor :key="preview.id" :content="preview.content" :editable="false" />
        </div>
      </div>
    </SlideOver>

    <Modal v-model="archiveOpen" :title="t('docs.archiveTitle')" :subtitle="t('docs.archiveHint')" width="440px">
      <p class="m-0">{{ doc?.title }}</p>
      <template #footer>
        <Button @click="archiveOpen = false">{{ t('common.cancel') }}</Button>
        <Button variant="danger" @click="archive">{{ t('docs.archive') }}</Button>
      </template>
    </Modal>
    <NewDocModal v-if="doc" v-model="subOpen" :department-id="doc.departmentId" :parent-id="doc.id" :parent-title="doc.title" />
  </article>
</template>

<style scoped>
.view { display: grid; gap: 14px; align-content: start; padding: 22px 40px 60px 48px; }
.gone { display: flex; align-items: center; gap: 8px; color: var(--color-muted); }
.head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 13px; color: var(--color-muted); }
.crumbs a { color: var(--color-muted); text-decoration: none; }
.crumbs a:hover { color: var(--color-ink); text-decoration: underline; }
.crumbs .back { display: none; }
.actions { display: flex; align-items: center; gap: 4px; }
.state { margin-right: 8px; font-size: 12px; color: var(--color-muted); }
.state.saved { color: var(--color-success); }
.state.error { color: var(--color-danger); }
.ico { width: 36px; height: 36px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration), box-shadow var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-md); }
.title { max-width: 760px; width: 100%; margin: 6px 0 0; padding: 0; font: 700 34px/1.15 var(--font-display); color: var(--color-ink); background: none; border: 0; resize: none; field-sizing: content; outline: none; text-wrap: balance; }
textarea.title { border-bottom: 2px dashed var(--color-line-strong); }
textarea.title:focus { border-bottom: 2px solid var(--color-primary); }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-bottom: 10px; font-size: 13px; color: var(--color-muted); }
.line-dd { width: 200px; }
.by { display: inline-flex; align-items: center; gap: 6px; }
.files { display: grid; gap: 10px; max-width: 760px; margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--color-line); }
.files h2 { display: flex; align-items: center; gap: 8px; margin: 0; font: 600 13px var(--font-sans); text-transform: uppercase; letter-spacing: .06em; color: var(--color-muted); }
.file-list { display: flex; flex-wrap: wrap; gap: 10px; }
.file { position: relative; display: flex; align-items: center; background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px rgb(19 36 61 / .05); transition: box-shadow var(--duration), transform var(--duration); }
.file:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.file a, .file.uploading { display: flex; align-items: center; gap: 10px; padding: 8px 14px 8px 8px; color: inherit; text-decoration: none; }
.file span:last-child, .file a > span:last-child { display: grid; }
.file small { font-size: 12px; color: var(--color-muted); }
.file > button { width: 30px; height: 30px; margin-right: 4px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.fi { width: 34px; height: 40px; display: grid; place-items: center; color: #fff; background: var(--color-leaf); }
.uploading { opacity: .7; }
.attach { display: inline-flex; align-items: center; gap: 6px; min-height: 56px; padding: 0 16px; font: inherit; font-size: 14px; color: var(--color-leaf); background: none; border: 1px dashed var(--color-line-strong); cursor: pointer; }
.attach:hover { border-color: var(--color-primary); color: var(--color-ink); }
.children { font-size: 13px; color: var(--color-muted); }
.versions { display: grid; gap: 6px; }
.ver { display: flex; align-items: center; gap: 10px; padding: 8px 10px; font: inherit; text-align: left; color: inherit; background: var(--color-surface); border: 0; box-shadow: inset 0 -1px 0 var(--color-line); cursor: pointer; }
.ver .info { flex: 1; display: grid; }
.ver small { font-size: 12px; color: var(--color-muted); }
.ver:hover { background: var(--color-canvas); }
.ver.on { box-shadow: var(--shadow-md), inset 4px 0 0 var(--color-primary); position: relative; z-index: 1; }
.preview { margin-top: 14px; padding: 16px; background: var(--color-canvas); box-shadow: inset 0 2px 6px rgb(19 36 61 / .08); }
.pv-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.pv-head h3 { margin: 0; font-size: 18px; }
.preview :deep(.tiptap) { font-size: 14px; }
@media (max-width: 767px) {
  .view { padding: 10px 14px 40px; }
  .crumbs .back { display: grid; width: var(--tap); height: var(--tap); place-items: center; margin-left: -12px; color: var(--color-ink); }
  .title { font-size: 26px; }
  .actions { width: 100%; justify-content: flex-end; }
}
</style>
