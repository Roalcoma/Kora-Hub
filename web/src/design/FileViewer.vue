<script setup lang="ts">
// Visor de adjuntos sin descargar. Excel, Word y PowerPoint se abren en el servidor de oficina (OnlyOffice/Euro-Office,
// solo lectura) tal como se ven en Office; si no está configurado o falla, Excel/CSV se ven como tabla por hojas y Word
// con docx-preview. Imagen, PDF (visor del navegador) y texto plano se ven directo. El archivo se pide por la misma ruta
// protegida de siempre. Word local se pinta dentro de un iframe sandbox sin scripts: un enlace javascript: no se ejecuta.
import { computed, nextTick, ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { Download, ExternalLink, FileText, CircleAlert, Search } from 'lucide-vue-next';
import type { FileRef, OfficeView } from '@agencia-hub/contracts';
import Modal from './Modal.vue';
import Tabs from './Tabs.vue';
import Skeleton from './Skeleton.vue';

const file = defineModel<FileRef | null>({ default: null });
const { t } = useI18n();
const open = computed({ get: () => !!file.value, set: (v) => { if (!v) file.value = null; } });

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type Kind = 'image' | 'pdf' | 'sheet' | 'csv' | 'word' | 'text' | 'other';
const viewKind =(f: Pick<FileRef, 'mime' | 'name'>): Kind => {
  const ext = f.name.split('.').pop()?.toLowerCase();
  if (f.mime.startsWith('image/') && f.mime !== 'image/heic') return 'image';
  if (f.mime === 'application/pdf') return 'pdf';
  if (f.mime === XLSX || ext === 'xlsx') return 'sheet';
  if (f.mime === 'text/csv' || ext === 'csv') return 'csv';
  if (f.mime === DOCX || ext === 'docx') return 'word';
  if (f.mime === 'text/plain') return 'text';
  return 'other';
};
const kind = computed(() => (file.value ? viewKind(file.value) : 'other'));
const OFFICE_EXT = /\.(xlsx|xls|csv|docx|doc|pptx|ppt)$/i;

// ─── Servidor de oficina ───
type DocsApi = { DocEditor: new (id: string, config: object) => { destroyEditor(): void } };
const scripts = new Map<string, Promise<void>>();
const loadScript = (src: string) => {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise<void>((ok, fail) => {
      const el = Object.assign(document.createElement('script'), { src, async: true, onload: () => ok(), onerror: () => { scripts.delete(src); fail(new Error('api.js')); } });
      document.head.append(el);
    }));
  }
  return scripts.get(src)!;
};
const office = ref(false);
const officeBox = ref<HTMLDivElement>();
let editor: { destroyEditor(): void } | null = null;
async function openOffice(f: FileRef, my: number): Promise<boolean> {
  try {
    const res = await fetch(`${f.url}/office`);
    if (!res.ok) return false;
    const view: OfficeView = await res.json();
    await loadScript(view.apiUrl);
    if (my !== token) return true;
    office.value = true;
    loading.value = false;
    await nextTick();
    const host = officeBox.value;
    if (!host || my !== token) return true;
    const ph = document.createElement('div');   // DocEditor reemplaza este nodo por su iframe
    ph.id = `kora-office-${my}`;
    host.replaceChildren(ph);
    const api = (window as unknown as { DocsAPI: DocsApi }).DocsAPI;
    editor = new api.DocEditor(ph.id, {
      ...view.config, width: '100%', height: '100%', type: window.innerWidth < 768 ? 'mobile' : 'desktop',
      events: { onError: () => { if (my === token) { closeOffice(); renderLocal(f, my); } } },
    });
    return true;
  } catch {
    return false;
  }
}
function closeOffice() {
  try { editor?.destroyEditor(); } catch { /* el iframe ya no existe */ }
  editor = null;
  office.value = false;
}

const loading = ref(false);
const failed = ref(false);
const pdfUrl = ref('');
const sheets = ref<{ name: string; rows: string[][] }[]>([]);
const sheet = ref('0');
const text = ref('');
const query = ref('');
const frame = ref<HTMLIFrameElement>();
let token = 0;

function reset() {
  closeOffice();
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = ''; sheets.value = []; sheet.value = '0'; text.value = ''; query.value = ''; failed.value = false;
}
onBeforeUnmount(reset);

// Excel guarda la fecha sin zona: se lee como medianoche UTC y se muestra en UTC para que no retroceda un día
const cell = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toLocaleDateString(undefined, { timeZone: 'UTC' }) : String(v));
// CSV con comillas ("a, b" y "" escapadas); detecta ; como separador si la primera línea no tiene comas
function parseCsv(src: string) {
  const sep = !src.split('\n', 1)[0]!.includes(',') && src.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

watch(file, async (f) => {
  reset();
  const my = ++token;
  if (!f) return;
  if (OFFICE_EXT.test(f.name)) {
    loading.value = true;
    if (await openOffice(f, my)) return;
    if (my !== token) return;
  }
  await renderLocal(f, my);
}, { immediate: true });

async function renderLocal(f: FileRef, my: number) {
  if (kind.value === 'image' || kind.value === 'other') { loading.value = false; return; }
  loading.value = true;
  try {
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    if (my !== token) return;
    if (kind.value === 'pdf') pdfUrl.value = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    else if (kind.value === 'csv') sheets.value = [{ name: f.name, rows: parseCsv(await blob.text()) }];
    else if (kind.value === 'text') text.value = await blob.text();
    else if (kind.value === 'sheet') {
      const { default: readXlsx } = await import('read-excel-file/browser');
      const all = await readXlsx(blob);
      if (my !== token) return;
      sheets.value = all.map((s) => ({ name: s.sheet, rows: s.data.map((r) => r.map(cell)) }));
    } else if (kind.value === 'word') {
      const { renderAsync } = await import('docx-preview');
      loading.value = false;
      await nextTick();
      const doc = frame.value?.contentDocument;
      if (!doc || my !== token) return;
      doc.body.innerHTML = '';
      doc.body.style.cssText = 'margin:0;background:#E9ECF0';
      await renderAsync(blob, doc.body, doc.head, { inWrapper: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, breakPages: true });
    }
  } catch {
    if (my === token) failed.value = true;
  } finally {
    if (my === token) loading.value = false;
  }
}

const MAX_ROWS = 2000;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const current = computed(() => sheets.value[Number(sheet.value)]);
const width = computed(() => Math.max(0, ...(current.value?.rows.map((r) => r.length) ?? [0])));
// Encabezado como en Excel (A, B, … AA): la fila 1 no siempre es la de títulos
const col = (i: number): string => (i < 26 ? '' : col(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));
const body = computed(() => {
  const rows = (current.value?.rows ?? []).map((r, i) => ({ n: i + 1, r }));
  const q = fold(query.value.trim());
  return q ? rows.filter((x) => x.r.some((c) => fold(c).includes(q))) : rows;
});
const sheetTabs = computed(() => sheets.value.map((s, i) => ({ value: String(i), label: s.name })));
</script>

<template>
  <Modal v-model="open" :title="file?.name ?? ''" width="min(1560px, 98vw)">
    <div v-if="file" class="fv">
      <img v-if="kind === 'image'" :src="file.url" :alt="file.name" class="img">
      <div v-else-if="office" ref="officeBox" class="frame office" />
      <div v-else-if="loading" class="grid gap-3"><Skeleton height="36px" width="40%" /><Skeleton v-for="n in 8" :key="n" height="22px" /></div>
      <div v-else-if="failed" class="msg"><CircleAlert :size="20" /><span>{{ t('viewer.failed') }}</span></div>
      <div v-else-if="kind === 'other'" class="msg"><FileText :size="20" /><span>{{ t('viewer.noPreview') }}</span></div>
      <iframe v-else-if="kind === 'pdf' && pdfUrl" :src="pdfUrl" :title="file.name" class="frame" />
      <iframe v-else-if="kind === 'word'" ref="frame" sandbox="allow-same-origin" :title="file.name" class="frame" />
      <pre v-else-if="kind === 'text'" class="txt">{{ text }}</pre>
      <template v-else-if="current">
        <div class="bar">
          <Tabs v-if="sheets.length > 1" v-model="sheet" :tabs="sheetTabs" class="tabs" />
          <label class="find"><Search :size="15" /><input v-model="query" type="search" :placeholder="t('viewer.search')" :aria-label="t('viewer.search')"></label>
        </div>
        <div class="sheet">
          <table>
            <thead><tr><th class="rn" /><th v-for="c in width" :key="c" class="cl">{{ col(c - 1) }}</th></tr></thead>
            <tbody>
              <tr v-for="x in body.slice(0, MAX_ROWS)" :key="x.n"><td class="rn">{{ x.n }}</td><td v-for="c in width" :key="c">{{ x.r[c - 1] ?? '' }}</td></tr>
            </tbody>
          </table>
          <p v-if="!body.length" class="none">{{ t('viewer.noRows') }}</p>
        </div>
        <p v-if="body.length > MAX_ROWS" class="cap">{{ t('viewer.capped', { n: MAX_ROWS, total: body.length }) }}</p>
      </template>
    </div>
    <template #actions>
      <a v-if="file && (kind === 'image' || kind === 'pdf')" class="fv-btn" :href="file.url" target="_blank" rel="noopener" :title="t('viewer.newTab')"><ExternalLink :size="15" /><span>{{ t('viewer.newTab') }}</span></a>
      <a v-if="file" class="fv-btn primary" :href="`${file.url}?download`" :download="file.name" :title="t('chat.download')"><Download :size="15" /><span>{{ t('chat.download') }}</span></a>
    </template>
  </Modal>
</template>

<style scoped>
.fv { display: grid; gap: 12px; min-width: 0; }
.img { display: block; max-width: 100%; max-height: calc(100dvh - 150px); margin-right: auto; box-shadow: var(--shadow-md); }
.office { overflow: hidden; }
.office :deep(iframe) { display: block; position: static !important; width: 100% !important; max-width: 100%; }   /* en móvil el editor se pone position: fixed */
.frame { width: 100%; height: calc(100dvh - 150px); border: 0; background: var(--color-canvas); box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-line); }
.msg { display: flex; align-items: center; gap: 10px; padding: 18px 20px; color: var(--color-muted); background: var(--color-canvas); border-left: 4px solid var(--color-primary); }
.txt { max-height: 72dvh; margin: 0; padding: 16px; overflow: auto; font: 13px/1.5 ui-monospace, monospace; white-space: pre-wrap; background: var(--color-canvas); box-shadow: inset 0 2px 6px rgb(19 36 61 / .08); }
.bar { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 10px; }
.tabs { flex: 1; min-width: 0; }
.find { display: inline-flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 12px; margin-left: auto; color: var(--color-muted); background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); }
.find input { width: 200px; font: inherit; font-size: 14px; color: var(--color-ink); background: none; border: 0; outline: none; }
.find:focus-within { border-color: var(--color-primary); }
.sheet { max-height: calc(100dvh - 210px); overflow: auto; background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-line); }
table { border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 10px; text-align: left; white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; border: 1px solid var(--color-line); }
thead th { position: sticky; top: 0; z-index: 1; font-weight: 700; background: var(--color-canvas); box-shadow: 0 2px 4px rgb(19 36 61 / .08); }
td { user-select: text; }
.rn { position: sticky; left: 0; color: var(--color-muted); font-size: 12px; text-align: right; background: var(--color-canvas); }
thead .rn { z-index: 2; }
thead .cl { font-weight: 500; font-size: 12px; color: var(--color-muted); text-align: center; }
tbody tr:hover td { background: var(--color-primary-light); }
tbody tr:hover .rn { background: var(--color-primary-light); }
.none, .cap { margin: 0; padding: 10px 12px; font-size: 13px; color: var(--color-muted); }
.fv-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; white-space: nowrap; font-weight: 700; font-size: 14px; color: var(--color-ink); text-decoration: none; border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), border-color var(--duration); }
.fv-btn:hover { border-color: var(--color-ink); box-shadow: var(--shadow-md); }
.fv-btn.primary { background: var(--color-primary); border-color: var(--color-primary); }
@media (max-width: 767px) {
  .frame { height: calc(100dvh - 130px); }
  .fv-btn span { display: none; }
  .find, .find input { width: 100%; }
}
</style>
