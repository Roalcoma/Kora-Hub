<script setup lang="ts">
// Portada de la biblioteca: qué hay por departamento y lo último que se actualizó, para no abrir en una pantalla vacía.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { BookOpen, FilePlus2, Clock, FileText } from 'lucide-vue-next';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { useSession } from '@/stores/session.ts';
import { useDocs } from './store.ts';

const emit = defineEmits<{ create: [departmentId: string] }>();
const { t, d } = useI18n();
const s = useSession();
const docs = useDocs();

const shown = computed(() => docs.nodes.filter((n) => !s.lineId || !n.lineId || n.lineId === s.lineId));
const recent = computed(() => [...shown.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8));
const depts = computed(() => s.workspace!.departments.filter((x) => !x.archivedAt).map((x) => {
  const mine = shown.value.filter((n) => n.departmentId === x.id);
  const last = mine.reduce<string | null>((m, n) => (!m || n.updatedAt > m ? n.updatedAt : m), null);
  return { ...x, count: mine.length, last, canEdit: docs.canEditDept(x.id) };
}));
const editable = computed(() => depts.value.filter((x) => x.canEdit));
const parentOf = (id: string) => docs.trail(id).slice(-2, -1)[0]?.title;
</script>

<template>
  <div class="home">
    <header class="hero">
      <div>
        <p class="kicker"><BookOpen :size="16" />{{ t('docs.library') }}</p>
        <h2>{{ t('docs.libraryOf', { name: s.workspace!.name }) }}</h2>
        <p class="sub">{{ t('docs.libraryCount', { n: shown.length }, shown.length) }}</p>
      </div>
      <button v-if="editable.length" type="button" class="new" @click="emit('create', editable[0]!.id)"><FilePlus2 :size="18" />{{ t('docs.newPage') }}</button>
    </header>

    <div v-if="!docs.loaded" class="grid gap-3"><Skeleton v-for="n in 3" :key="n" height="80px" /></div>
    <template v-else>
      <!-- Departamentos: una fila de tarjetas con conteo; las vacías invitan a crear (si puedo) -->
      <section class="depts">
        <article v-for="x in depts" :key="x.id" class="dept" :class="{ empty: !x.count }">
          <span class="dname">{{ x.name }}</span>
          <span class="count">{{ x.count }}</span>
          <small v-if="x.last">{{ t('docs.lastUpdate', { date: d(x.last, 'day') }) }}</small>
          <button v-else-if="x.canEdit" type="button" class="first" @click="emit('create', x.id)">{{ t('docs.writeFirst') }}</button>
          <small v-else>{{ t('docs.emptyDept') }}</small>
        </article>
      </section>

      <section v-if="recent.length" class="recent">
        <h3><Clock :size="16" />{{ t('docs.recent') }}</h3>
        <div class="grid-cards">
          <RouterLink v-for="n in recent" :key="n.id" :to="`/w/${s.workspace!.slug}/manuals/${n.id}`" class="doc">
            <span class="fi"><FileText :size="18" /></span>
            <span class="info">
              <small>{{ s.deptName(n.departmentId) }}<template v-if="parentOf(n.id)"> › {{ parentOf(n.id) }}</template></small>
              <b>{{ n.title }}</b>
              <span class="meta"><Badge v-if="n.lineId" :tone="s.lineTone(n.lineId)">{{ s.lineOf(n.lineId)?.name }}</Badge>{{ d(n.updatedAt, 'short') }}</span>
            </span>
          </RouterLink>
        </div>
      </section>
      <EmptyState v-else :icon="BookOpen" :title="t('docs.pick')" :text="t('docs.emptyLibrary')" />
    </template>
  </div>
</template>

<style scoped>
.home { display: grid; gap: 26px; align-content: start; padding: 28px 36px 48px 40px; }
.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding-bottom: 18px; border-bottom: 1px solid var(--color-line); }
.kicker { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--color-primary-dark); }
h2 { margin: 0; font-size: 30px; line-height: 1.15; }
.sub { margin: 6px 0 0; color: var(--color-muted); }
.new { display: inline-flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 16px; font: inherit; font-weight: 600; color: var(--color-ink); background: var(--color-primary); border: 0; box-shadow: var(--shadow-md); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.new:hover { box-shadow: var(--shadow-lg); transform: translateY(-1px); }

.depts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.dept { position: relative; display: grid; gap: 2px; padding: 14px 16px 14px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.dept::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-leaf); }
.dept.empty { background: transparent; box-shadow: inset 0 0 0 1px var(--color-line-strong); }
.dept.empty::before { background: var(--color-line-strong); }
.dname { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--color-muted); }
.count { font: 800 30px/1.1 var(--font-display); font-variant-numeric: tabular-nums; }
.dept small { font-size: 12px; color: var(--color-muted); }
.first { justify-self: start; padding: 0; font: inherit; font-size: 13px; font-weight: 600; color: var(--color-leaf); background: none; border: 0; text-decoration: underline; cursor: pointer; }

.recent h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font: 600 13px var(--font-sans); text-transform: uppercase; letter-spacing: .06em; color: var(--color-muted); }
.grid-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.doc { display: flex; gap: 12px; padding: 14px; color: inherit; text-decoration: none; background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px rgb(19 36 61 / .05); border-left: 3px solid transparent; transition: box-shadow var(--duration), transform var(--duration), border-color var(--duration); }
.doc:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); border-left-color: var(--color-primary); }
.fi { width: 36px; height: 42px; display: grid; place-items: center; flex: none; color: #fff; background: var(--color-leaf); box-shadow: var(--shadow-sm); }
.info { display: grid; gap: 3px; min-width: 0; }
.info small { font-size: 12px; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.info b { font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-muted); }
@media (max-width: 767px) { .home { padding: 18px 14px 32px; } .hero { flex-wrap: wrap; } h2 { font-size: 24px; } }
</style>
