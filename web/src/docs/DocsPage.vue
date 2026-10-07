<script setup lang="ts">
// Manuales (§5.3): biblioteca por departamento a la izquierda (árbol + búsqueda sin acentos), página a la derecha.
// En el teléfono son dos pantallas: la biblioteca y, al elegir, la página.
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Search, Plus, ChevronLeft, X } from 'lucide-vue-next';
import type { DocumentNode } from '@agencia-hub/contracts';
import Skeleton from '@/design/Skeleton.vue';
import Badge from '@/design/Badge.vue';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { renderBody } from '@/chat/format.ts';
import DocTree from './DocTree.vue';
import DocView from './DocView.vue';
import NewDocModal from './NewDocModal.vue';
import DocsHome from './DocsHome.vue';
import { useDocs } from './store.ts';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const docs = useDocs();
docs.init();

const id = computed(() => (route.params.id as string) || '');

// Filtro global de línea: páginas de esa línea y las generales (sin línea)
const shown = computed(() => docs.nodes.filter((n) => !s.lineId || !n.lineId || n.lineId === s.lineId));
const children = computed(() => {
  const ids = new Set(shown.value.map((n) => n.id));
  const map = new Map<string, DocumentNode[]>();
  for (const n of shown.value) {
    // Si el padre quedó oculto por el filtro, la página sube a la raíz de su departamento
    const key = n.parentId && ids.has(n.parentId) ? n.parentId : `dept:${n.departmentId}`;
    map.set(key, [...(map.get(key) ?? []), n]);
  }
  for (const list of map.values()) list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  return map;
});
const depts = computed(() => s.workspace!.departments.filter((d) => !d.archivedAt
  && (children.value.has(`dept:${d.id}`) || docs.canEditDept(d.id))));
// Ancestros de la página abierta: sus ramas aparecen desplegadas
const openIds = computed(() => new Set(id.value ? docs.trail(id.value).map((n) => n.id) : []));

// ─── Búsqueda ───
const q = ref('');
const results = ref<DocumentNode[] | null>(null);
let seq = 0;
watch(q, async (v) => {
  const term = v.trim();
  if (term.length < 2) { results.value = null; return; }
  const mine = ++seq;
  await new Promise((r) => setTimeout(r, 220));
  if (mine !== seq) return;
  const r = await api('GET /w/:slug/documents', { params: { slug: s.workspace!.slug }, query: { q: term, lineId: s.lineId ?? undefined } });
  if (mine === seq) results.value = r;
});
const snippet = (h: string) => renderBody(h, () => undefined);

const newIn = ref<string | null>(null);
const newOpen = computed({ get: () => !!newIn.value, set: (v) => { if (!v) newIn.value = null; } });
</script>

<template>
  <div class="docs" :class="{ reading: !!id }">
    <aside class="lib">
      <header class="lib-head">
        <button type="button" class="back" :aria-label="t('common.back')" @click="router.push(`/w/${s.workspace!.slug}`)"><ChevronLeft :size="22" /></button>
        <h1>{{ t('nav.manuals') }}</h1>
        <Badge v-if="s.lineId" :tone="s.lineTone(s.lineId)">{{ s.lineOf(s.lineId)?.name }}</Badge>
      </header>
      <label class="find">
        <Search :size="16" /><input v-model="q" :placeholder="t('docs.search')" :aria-label="t('docs.search')">
        <button v-if="q" type="button" :aria-label="t('common.close')" @click="q = ''"><X :size="15" /></button>
      </label>

      <div class="scroll">
        <template v-if="results">
          <p class="count">{{ t('docs.results', { n: results.length }, results.length) }}</p>
          <RouterLink v-for="r in results" :key="r.id" :to="`/w/${s.workspace!.slug}/manuals/${r.id}`" class="hit" @click="q = ''">
            <b>{{ r.title }}</b><small>{{ s.deptName(r.departmentId) }}</small>
            <!-- eslint-disable-next-line vue/no-v-html -- renderBody escapa el texto y solo marca «coincidencias» -->
            <p v-if="r.snippet" v-html="snippet(r.snippet)" />
          </RouterLink>
        </template>
        <div v-else-if="!docs.loaded" class="grid gap-2 p-3"><Skeleton v-for="n in 6" :key="n" height="28px" /></div>
        <template v-else>
          <section v-for="d in depts" :key="d.id" class="dept">
            <h2>{{ d.name }}<button v-if="docs.canEditDept(d.id)" type="button" :title="t('docs.newPage')" :aria-label="`${t('docs.newPage')} · ${d.name}`" @click="newIn = d.id"><Plus :size="16" /></button></h2>
            <DocTree v-if="children.get(`dept:${d.id}`)" :items="children.get(`dept:${d.id}`)!" :children="children" :active-id="id" :open-ids="openIds" />
            <p v-else class="none">{{ t('docs.emptyDept') }}</p>
          </section>
          <p v-if="!depts.length" class="none pad">{{ t('docs.emptyLibrary') }}</p>
        </template>
      </div>
    </aside>

    <main class="page">
      <DocView v-if="id" :id="id" />
      <DocsHome v-else @create="newIn = $event" />
    </main>
    <NewDocModal v-if="newIn" v-model="newOpen" :department-id="newIn" />
  </div>
</template>

<style scoped>
/* Biblioteca angosta y elevada sobre el fondo; la página ocupa el resto con su columna de lectura a la izquierda */
.docs { height: 100%; display: grid; grid-template-columns: 300px minmax(0, 1fr); min-height: 0; }
.lib { position: relative; z-index: 2; display: flex; flex-direction: column; min-height: 0; background: var(--color-surface); box-shadow: 6px 0 18px rgb(19 36 61 / .08); }
.lib-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px 10px 22px; }
.back { display: none; width: var(--tap); height: var(--tap); place-items: center; background: none; border: 0; color: inherit; cursor: pointer; }
h1 { margin: 0; font-size: 24px; }
.find { display: flex; align-items: center; gap: 8px; margin: 0 14px 10px 18px; min-height: 38px; padding: 0 6px 0 10px; color: var(--color-muted); background: var(--color-canvas); border: 1px solid transparent; box-shadow: inset 0 1px 3px rgb(19 36 61 / .08); }
.find:focus-within { background: var(--color-surface); border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .2); }
.find input { flex: 1; min-width: 0; font: inherit; color: var(--color-ink); background: none; border: 0; outline: none; }
.find button { width: 28px; height: 28px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.scroll { flex: 1; overflow: auto; padding-bottom: 24px; }
.dept { padding: 8px 0 6px; }
.dept h2 { display: flex; align-items: center; justify-content: space-between; margin: 0; padding: 6px 12px 6px 22px; font: 600 12px var(--font-sans); text-transform: uppercase; letter-spacing: .07em; color: var(--color-muted); }
.dept h2 button { width: 28px; height: 28px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.dept h2 button:hover { color: var(--color-ink); background: var(--color-primary); }
.none { margin: 0; padding: 4px 22px 8px; font-size: 13px; color: var(--color-muted); }
.none.pad { padding: 16px 22px; }
.count { margin: 4px 22px 8px; font-size: 12px; color: var(--color-muted); }
.hit { display: grid; gap: 2px; margin: 0 10px 6px; padding: 10px 12px; color: inherit; text-decoration: none; background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px rgb(19 36 61 / .05); border-left: 3px solid transparent; transition: box-shadow var(--duration), border-color var(--duration); }
.hit:hover { box-shadow: var(--shadow-md); border-left-color: var(--color-primary); }
.hit small { font-size: 12px; color: var(--color-muted); }
.hit p { margin: 4px 0 0; font-size: 13px; line-height: 1.45; color: var(--color-muted); }
.hit p :deep(mark) { background: var(--color-primary-light); box-shadow: inset 0 -2px 0 var(--color-primary); color: var(--color-ink); }
.page { min-width: 0; overflow: auto; }
@media (max-width: 767px) {
  .docs { grid-template-columns: minmax(0, 1fr); }
  .back { display: grid; margin-left: -14px; }
  .lib-head { padding: 6px 12px 8px 18px; }
  .find input { font-size: 16px; }
  .reading .lib { display: none; }
  .docs:not(.reading) .page { display: none; }
}
</style>
