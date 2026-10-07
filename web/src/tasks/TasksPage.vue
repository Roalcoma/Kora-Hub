<script setup lang="ts">
// Tareas (§5.4): tablero kanban por departamento (arrastrar entre columnas), vista lista y "Mis tareas".
// Filtros: departamento, línea de negocio (selector global del sidebar) y texto. `?t=<id>` abre el detalle.
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Plus, SquareKanban, Search, ChevronLeft } from 'lucide-vue-next';
import { TASK_STATUS, type Task, type TaskStatus } from '@agencia-hub/contracts';
import Tabs from '@/design/Tabs.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Avatar from '@/design/Avatar.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';
import { errorText } from '@/platform/errors.ts';
import TaskCard from './TaskCard.vue';
import TaskPanel from './TaskPanel.vue';
import { useTasks, isOverdue } from './store.ts';

const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const chat = useChat();
const tasks = useTasks();
tasks.init();

type View = 'board' | 'list' | 'mine';
const remember = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* modo privado */ } };
const recall = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
// En el teléfono lo útil es lo mío; en escritorio, el tablero
const view = ref<View>((recall('tasks-view') as View) || (matchMedia('(max-width: 767px)').matches ? 'mine' : 'board'));
watch(view, (v) => remember('tasks-view', v));

// Departamento: por defecto el primero mío (los Admin ven todos)
const mineDept = s.workspace!.me.departmentIds[0];
const dept = ref(recall('tasks-dept') ?? (s.isAdmin || !mineDept ? '' : mineDept));
watch(dept, (v) => remember('tasks-dept', v));
const deptOptions = computed(() => [{ value: '', label: t('tasks.allDepartments') },
  ...s.workspace!.departments.filter((x) => !x.archivedAt).map((x) => ({ value: x.id, label: x.name }))]);
const q = ref('');

const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const visible = computed(() => tasks.all.filter((x) =>
  (view.value === 'mine' ? x.assigneeIds.includes(s.user!.id) : !dept.value || x.departmentId === dept.value)
  && (!s.lineId || x.lineId === s.lineId)
  && (!q.value || fold(x.title).includes(fold(q.value)))));
const columns = computed(() => TASK_STATUS.map((st) => ({
  status: st, items: visible.value.filter((x) => x.status === st).sort((a, b) => a.position - b.position),
})));

// Lista y "Mis tareas": abiertas primero, luego por fecha límite
const rank: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2, cancelled: 3 };
const listed = computed(() => [...visible.value].sort((a, b) =>
  rank[a.status] - rank[b.status] || (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9') || a.position - b.position));
const overdueCount = computed(() => visible.value.filter(isOverdue).length);

// ─── Detalle por query (?t=) para que los avisos y push abran la tarea ───
const openId = computed({
  get: () => (route.query.t as string) || null,
  set: (v) => router.replace({ query: { ...route.query, t: v || undefined } }),
});

// ─── Arrastrar y soltar (escritorio). En móvil el estado se cambia en el detalle. ───
const dragging = ref<string | null>(null);
const overCol = ref<TaskStatus | null>(null);
const dropIndex = ref(-1);
function onDragStart(e: DragEvent, task: Task) {
  if (!tasks.canWork(task)) return e.preventDefault();
  dragging.value = task.id;
  e.dataTransfer!.effectAllowed = 'move';
  e.dataTransfer!.setData('text/plain', task.id);
}
function onDragOver(e: DragEvent, st: TaskStatus) {
  if (!dragging.value) return;
  e.preventDefault();
  overCol.value = st;
  // Índice de inserción según la mitad de cada tarjeta
  const cards = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-card]')].filter((c) => c.dataset.card !== dragging.value);
  dropIndex.value = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
  if (dropIndex.value < 0) dropIndex.value = cards.length;
}
async function onDrop(st: TaskStatus) {
  const id = dragging.value;
  const i = dropIndex.value;
  dragging.value = null;
  overCol.value = null;
  if (!id) return;
  const items = columns.value.find((c) => c.status === st)!.items.filter((x) => x.id !== id);
  const before = items[i - 1]?.position;
  const after = items[i]?.position;
  // Posición entre vecinos (fracciones: no hay que renumerar la columna)
  const position = before === undefined ? (after ?? 0) - 1 : after === undefined ? before + 1 : (before + after) / 2;
  const cur = tasks.all.find((x) => x.id === id);
  if (cur && cur.status === st && cur.position === position) return;
  try { await tasks.update(id, { status: st, position }); } catch (e) { toast(errorText(e), 'error'); }
}
const onDragEnd = () => { dragging.value = null; overCol.value = null; };

const newTask = () => tasks.compose({ departmentId: dept.value || undefined });
</script>

<template>
  <div class="tasks">
    <header class="top">
      <button type="button" class="back" :aria-label="t('common.back')" @click="router.push(`/w/${s.workspace!.slug}`)"><ChevronLeft :size="22" /></button>
      <div class="heading">
        <h1>{{ t('nav.tasks') }}</h1>
        <p v-if="overdueCount" class="late">{{ t('tasks.overdueCount', { n: overdueCount }, overdueCount) }}</p>
      </div>
      <Tabs v-model="view" :tabs="[{ value: 'board', label: t('tasks.board') }, { value: 'list', label: t('tasks.list') }, { value: 'mine', label: t('tasks.mine') }]" />
      <Button variant="primary" class="new" @click="newTask()"><Plus :size="17" />{{ t('tasks.new') }}</Button>
    </header>

    <div class="filters">
      <Dropdown v-if="view !== 'mine'" v-model="dept" :options="deptOptions" :aria-label="t('tasks.department')" />
      <label class="find"><Search :size="16" /><input v-model="q" :placeholder="t('tasks.filter')" :aria-label="t('tasks.filter')"></label>
      <span v-if="s.lineId" class="line-note">{{ t('tasks.lineFilter') }} <Badge :tone="s.lineTone(s.lineId)">{{ s.lineOf(s.lineId)?.name }}</Badge></span>
    </div>

    <div v-if="!tasks.loaded" class="board">
      <div v-for="n in 4" :key="n" class="col"><Skeleton v-for="m in 3" :key="m" height="84px" /></div>
    </div>

    <EmptyState v-else-if="!visible.length && !q" :icon="SquareKanban" :title="view === 'mine' ? t('tasks.noMine') : t('tasks.empty')" :text="t('tasks.emptyHint')" class="empty" />

    <!-- Tablero -->
    <div v-else-if="view === 'board'" class="board">
      <section v-for="c in columns" :key="c.status" class="col" :class="[c.status, { over: overCol === c.status }]"
        @dragover="onDragOver($event, c.status)" @dragleave.self="overCol = null" @drop.prevent="onDrop(c.status)">
        <h2><span class="dot" />{{ t(`tasks.status.${c.status}`) }}<small>{{ c.items.length }}</small></h2>
        <div class="cards">
          <div v-for="task in c.items" :key="task.id" :data-card="task.id" :draggable="tasks.canWork(task)" :class="{ ghost: dragging === task.id }"
            @dragstart="onDragStart($event, task)" @dragend="onDragEnd">
            <TaskCard :task="task" :show-dept="!dept" @open="openId = $event" />
          </div>
          <button v-if="c.status === 'todo'" type="button" class="add" @click="newTask()"><Plus :size="15" />{{ t('tasks.new') }}</button>
        </div>
      </section>
    </div>

    <!-- Lista / Mis tareas -->
    <div v-else class="list">
      <button v-for="task in listed" :key="task.id" type="button" class="row" :class="[task.status, `p-${task.priority}`]" @click="openId = task.id">
        <span class="st">{{ t(`tasks.status.${task.status}`) }}</span>
        <span class="name">{{ task.title }}<small>{{ s.deptName(task.departmentId) }}</small></span>
        <span class="due" :class="{ overdue: isOverdue(task) }">{{ task.dueAt ? d(task.dueAt, 'day') : '' }}</span>
        <span class="who"><Avatar v-for="id in task.assigneeIds.slice(0, 3)" :key="id" :name="chat.nameOf(id)" :size="24" /></span>
      </button>
      <p v-if="!listed.length" class="none">{{ t('tasks.noMatches') }}</p>
    </div>

    <TaskPanel v-model="openId" />
  </div>
</template>

<style scoped>
.tasks { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.top { position: relative; z-index: 2; display: flex; align-items: center; gap: 18px; min-height: 64px; padding: 8px 20px 8px 28px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.back { display: none; width: var(--tap); height: var(--tap); place-items: center; background: none; border: 0; color: inherit; cursor: pointer; }
.heading { display: grid; margin-right: auto; }
h1 { margin: 0; font-size: 24px; }
.late { margin: 0; font-size: 13px; font-weight: 600; color: var(--color-danger); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 16px 28px 6px; }
.filters :deep(.dd) { width: 230px; }
.find { display: flex; align-items: center; gap: 8px; width: 260px; min-height: 38px; padding: 0 10px; color: var(--color-muted); background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.find:focus-within { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .2); }
.find input { flex: 1; min-width: 0; font: inherit; border: 0; outline: none; background: none; color: var(--color-ink); }
.line-note { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--color-muted); }
.empty { margin: 40px 28px; }

/* Kanban: columnas de distinto peso (la de "En curso" un poco más ancha), fondo hundido y tarjetas elevadas */
.board { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(250px, 1fr) minmax(270px, 1.15fr) minmax(250px, 1fr) minmax(220px, .85fr); gap: 16px; padding: 12px 28px 24px; overflow: auto; align-items: start; }
.col { display: grid; gap: 10px; align-content: start; min-height: 200px; padding: 12px 10px 14px; background: var(--color-canvas-deep); box-shadow: inset 0 2px 6px rgb(19 36 61 / .07); transition: background var(--duration), box-shadow var(--duration); }
.col.over { background: #FFF6E8; box-shadow: inset 0 0 0 2px var(--color-primary); }
.col h2 { display: flex; align-items: center; gap: 8px; margin: 0 2px 2px; font: 600 13px var(--font-sans); text-transform: uppercase; letter-spacing: .06em; color: var(--color-muted); }
.col h2 small { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--color-ink); background: var(--color-surface); padding: 0 7px; box-shadow: var(--shadow-sm); }
.dot { width: 8px; height: 8px; background: var(--color-line-strong); }
.doing .dot { background: var(--color-primary); }
.done .dot { background: var(--color-success); }
.cancelled { opacity: .85; }
.cards { display: grid; gap: 8px; }
.ghost { opacity: .35; }
[draggable="true"] { cursor: grab; }
.add { display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px; font: inherit; font-size: 14px; color: var(--color-muted); background: none; border: 1px dashed var(--color-line-strong); cursor: pointer; }
.add:hover { color: var(--color-ink); border-color: var(--color-primary); background: var(--color-surface); }

/* Lista */
.list { flex: 1; overflow: auto; display: grid; align-content: start; gap: 6px; padding: 12px 28px 24px; max-width: 1000px; }
.row { position: relative; display: grid; grid-template-columns: 96px minmax(0, 1fr) 90px 90px; align-items: center; gap: 12px; min-height: 54px; padding: 6px 14px 6px 16px; font: inherit; text-align: left; color: inherit; background: var(--color-surface); border: 0; box-shadow: var(--shadow-sm); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.row:hover { box-shadow: var(--shadow-md); transform: translateX(3px); }
.row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; }
.row.p-urgent::before { background: var(--color-danger); }
.row.p-high::before { background: var(--color-primary); }
.st { font-size: 12px; font-weight: 600; color: var(--color-muted); }
.row.doing .st { color: var(--color-warning); }
.row.done .st { color: var(--color-success); }
.row.done .name, .row.cancelled .name { color: var(--color-muted); text-decoration: line-through; }
.name { display: grid; font-weight: 500; overflow-wrap: anywhere; }
.name small { font-weight: 400; font-size: 12px; color: var(--color-muted); }
.due { font-size: 13px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
.due.overdue { color: var(--color-danger); font-weight: 700; }
.who { display: flex; justify-content: flex-end; }
.who > :deep(*) + :deep(*) { margin-left: -6px; box-shadow: 0 0 0 2px var(--color-surface); }
.none { color: var(--color-muted); }

@media (max-width: 767px) {
  .top { flex-wrap: wrap; gap: 8px; padding: 6px 12px 10px 4px; }
  .back { display: grid; }
  h1 { font-size: 21px; }
  .new { order: 2; }
  .top :deep(.tabs) { order: 3; width: 100%; padding-left: 8px; }
  .filters { padding: 12px 12px 4px; }
  .filters :deep(.dd), .find { width: 100%; }
  .find input { font-size: 16px; }
  /* En el teléfono el tablero se desliza columna por columna */
  .board { grid-template-columns: repeat(4, 84vw); padding: 10px 12px 20px; scroll-snap-type: x mandatory; }
  .col { scroll-snap-align: start; }
  .list { padding: 10px 12px 20px; }
  .row { grid-template-columns: minmax(0, 1fr) auto; }
  .row .st { grid-column: 1 / -1; grid-row: 1; }
  .row .who { display: none; }
}
</style>
