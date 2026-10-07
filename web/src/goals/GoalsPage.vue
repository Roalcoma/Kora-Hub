<script setup lang="ts">
// Metas y reportes semanales (§5.5): tablero de cumplimiento con semáforo y tendencia, carga del reporte
// (Líder del depto) y definición de metas (Admin). Exporta a CSV y a PDF (impresión del navegador).
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  Target, Download, Printer, CircleCheck, TriangleAlert, CircleAlert, Clock, Plus, Pencil, Archive, ArchiveRestore,
  ChevronLeft, ArrowUp, ArrowDown, LayoutGrid, Table2,
} from 'lucide-vue-next';
import type { Goal, GoalsDashboard } from '@agencia-hub/contracts';
import Tabs from '@/design/Tabs.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import GoalChart from './GoalChart.vue';
import ReportForm from './ReportForm.vue';
import GoalModal from './GoalModal.vue';

const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const slug = () => s.workspace!.slug;

type Tab = 'dashboard' | 'report' | 'goals';
const canReport = computed(() => s.isAdmin || s.workspace!.me.leadOfDepartmentIds.length > 0);
const tab = ref<Tab>(route.query.report && canReport.value ? 'report' : 'dashboard');
const tabs = computed(() => [
  { value: 'dashboard' as Tab, label: t('goals.dashboard') },
  ...(canReport.value ? [{ value: 'report' as Tab, label: t('goals.report') }] : []),
  ...(s.isAdmin ? [{ value: 'goals' as Tab, label: t('goals.goals') }] : []),
]);

// ─── Tablero ───
const dept = ref('');
const weeksN = ref<'4' | '8' | '12' | '26'>('12');
const view = ref<'cards' | 'table'>('cards');
const deptOptions = computed(() => [{ value: '', label: t('tasks.allDepartments') },
  ...s.workspace!.departments.filter((x) => !x.archivedAt).map((x) => ({ value: x.id, label: x.name }))]);
const weekOptions = computed(() => (['4', '8', '12', '26'] as const).map((n) => ({ value: n, label: t('goals.lastWeeks', { n }) })));
const data = ref<GoalsDashboard | null>(null);
const query = computed(() => ({ weeks: Number(weeksN.value), departmentId: dept.value || undefined, lineId: s.lineId ?? undefined }));
async function load() {
  data.value = null;
  try {
    data.value = await api('GET /w/:slug/goals/dashboard', { params: { slug: slug() }, query: query.value });
  } catch (e) { toast(errorText(e), 'error'); }
}
watch(query, load, { immediate: true });

type Row = GoalsDashboard['rows'][number];
const pct = (actual: number | null, target: number) => (actual === null ? null : Math.round((actual / target) * 100));
const status = (p: number | null) => (p === null ? 'none' : p >= 100 ? 'ok' : p >= 70 ? 'near' : 'low');
const STATUS_ICON = { ok: CircleCheck, near: TriangleAlert, low: CircleAlert, none: Clock };
const last = (r: Row) => r.series.at(-1)!;
const prev = (r: Row) => r.series.at(-2);
const delta = (r: Row) => (last(r).actual !== null && prev(r)?.actual != null ? last(r).actual! - prev(r)!.actual! : null);

const sections = computed(() => {
  if (!data.value) return [];
  const byDept = new Map<string, Row[]>();
  for (const r of data.value.rows) byDept.set(r.departmentId, [...(byDept.get(r.departmentId) ?? []), r]);
  return [...byDept].map(([id, rows]) => {
    const ps = rows.map((r) => pct(last(r).actual, last(r).target)).filter((p): p is number => p !== null);
    const avg = ps.length ? Math.round(ps.reduce((a, b) => a + Math.min(b, 150), 0) / ps.length) : null;
    return { id, name: s.deptName(id), rows, avg };
  });
});
// Reportes que faltan de esta semana y la anterior (lo más accionable)
const missingRecent = computed(() => {
  const w = data.value?.weeks ?? [];
  const recent = new Set(w.slice(-2));
  return (data.value?.missingReports ?? []).filter((m) => recent.has(m.weekStart)).sort((a, b) => b.weekStart.localeCompare(a.weekStart));
});
const week = (w: string) => d(new Date(`${w}T12:00:00`), 'day');
const fmt = (n: number) => n.toLocaleString();
const csvUrl = computed(() => `/api/v1/w/${slug()}/goals/dashboard.csv?${new URLSearchParams(
  Object.entries(query.value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`);
const print = () => window.print();
const reportFor = ref<string | undefined>((route.query.report as string) || undefined);
function goReport(deptId: string) { reportFor.value = deptId; tab.value = 'report'; }

// ─── Metas (Admin) ───
const goals = ref<Goal[] | null>(null);
async function loadGoals() {
  goals.value = await api('GET /w/:slug/goals', { params: { slug: slug() }, query: { includeArchived: 'true' } });
}
watch(tab, (v) => { if (v === 'goals' && !goals.value) loadGoals(); }, { immediate: true });
const goalsByDept = computed(() => s.workspace!.departments.filter((x) => !x.archivedAt)
  .map((x) => ({ ...x, goals: (goals.value ?? []).filter((g) => g.departmentId === x.id) })));
const editing = ref<Goal | null>(null);
const newIn = ref<string | undefined>();
const modal = ref(false);
const openGoal = (g: Goal | null, deptId?: string) => { editing.value = g; newIn.value = deptId; modal.value = true; };
async function toggleArchive(g: Goal) {
  try {
    await api('PATCH /w/:slug/goals/:id', { params: { slug: slug(), id: g.id }, body: { archived: !g.archivedAt } });
    await loadGoals();
    load();
  } catch (e) { toast(errorText(e), 'error'); }
}
const afterSave = () => { loadGoals(); load(); };
</script>

<template>
  <div class="goals">
    <header class="top">
      <button type="button" class="back" :aria-label="t('common.back')" @click="router.push(`/w/${s.workspace!.slug}`)"><ChevronLeft :size="22" /></button>
      <h1>{{ t('nav.goals') }}</h1>
      <Tabs v-model="tab" :tabs="tabs" />
      <div v-if="tab === 'dashboard'" class="exports no-print">
        <a :href="csvUrl" download class="exp"><Download :size="16" />CSV</a>
        <button type="button" class="exp" @click="print"><Printer :size="16" />PDF</button>
      </div>
      <Button v-else-if="tab === 'goals'" variant="primary" @click="openGoal(null)"><Plus :size="17" />{{ t('goals.newGoal') }}</Button>
    </header>

    <!-- ═══ Tablero ═══ -->
    <div v-if="tab === 'dashboard'" class="body">
      <div class="filters no-print">
        <Dropdown v-model="dept" :options="deptOptions" :aria-label="t('tasks.department')" />
        <Dropdown v-model="weeksN" :options="weekOptions" :aria-label="t('goals.range')" />
        <Badge v-if="s.lineId" :tone="s.lineTone(s.lineId)">{{ s.lineOf(s.lineId)?.name }}</Badge>
        <div class="views" role="group" :aria-label="t('goals.viewAs')">
          <button type="button" :class="{ on: view === 'cards' }" :aria-pressed="view === 'cards'" @click="view = 'cards'"><LayoutGrid :size="16" />{{ t('goals.cards') }}</button>
          <button type="button" :class="{ on: view === 'table' }" :aria-pressed="view === 'table'" @click="view = 'table'"><Table2 :size="16" />{{ t('goals.table') }}</button>
        </div>
      </div>

      <div v-if="!data" class="grid gap-4"><Skeleton v-for="n in 3" :key="n" height="180px" /></div>
      <EmptyState v-else-if="!data.rows.length" :icon="Target" :title="t('goals.empty')" :text="s.isAdmin ? t('goals.emptyAdmin') : t('goals.emptyMember')" class="empty" />
      <template v-else>
        <div v-if="missingRecent.length" class="missing">
          <Clock :size="18" />
          <div class="miss-list">
            <span v-for="m in missingRecent" :key="m.departmentId + m.weekStart" class="miss">
              {{ t('goals.missing', { dept: s.deptName(m.departmentId), date: week(m.weekStart) }) }}
              <button v-if="s.isAdmin || s.workspace!.me.leadOfDepartmentIds.includes(m.departmentId)" type="button" class="no-print" @click="goReport(m.departmentId)">{{ t('goals.reportNow') }}</button>
            </span>
          </div>
        </div>

        <section v-for="sec in sections" :key="sec.id" class="dept">
          <header class="dept-head">
            <h2>{{ sec.name }}</h2>
            <span v-if="sec.avg !== null" class="avg" :class="status(sec.avg)">
              <component :is="STATUS_ICON[status(sec.avg)]" :size="16" />{{ t('goals.avgThisWeek', { n: sec.avg }) }}
            </span>
            <span v-else class="avg none"><Clock :size="16" />{{ t('goals.noReportYet') }}</span>
          </header>

          <div v-if="view === 'cards'" class="cards">
            <article v-for="r in sec.rows" :key="r.goalId" class="card" :class="status(pct(last(r).actual, last(r).target))">
              <header>
                <h3>{{ r.name }}</h3>
                <Badge v-if="r.lineId" :tone="s.lineTone(r.lineId)">{{ s.lineOf(r.lineId)?.name }}</Badge>
              </header>
              <div class="hero">
                <span class="big">{{ last(r).actual === null ? '—' : fmt(last(r).actual!) }}</span>
                <span class="of">/ {{ fmt(last(r).target) }} {{ r.unit }}</span>
              </div>
              <div class="state">
                <span class="chip" :class="status(pct(last(r).actual, last(r).target))">
                  <component :is="STATUS_ICON[status(pct(last(r).actual, last(r).target))]" :size="14" />
                  {{ t(`goals.status.${status(pct(last(r).actual, last(r).target))}`) }}<template v-if="last(r).actual !== null"> · {{ pct(last(r).actual, last(r).target) }}%</template>
                </span>
                <span v-if="delta(r) !== null" class="delta">
                  <ArrowUp v-if="delta(r)! > 0" :size="13" /><ArrowDown v-else-if="delta(r)! < 0" :size="13" />
                  {{ t('goals.vsLast', { n: (delta(r)! > 0 ? '+' : '') + fmt(delta(r)!) }) }}
                </span>
              </div>
              <GoalChart :series="r.series" :unit="r.unit" />
            </article>
          </div>

          <div v-else class="table-wrap">
            <table>
              <thead><tr><th scope="col">{{ t('goals.goal') }}</th><th v-for="w in data.weeks" :key="w" scope="col">{{ week(w) }}</th></tr></thead>
              <tbody>
                <tr v-for="r in sec.rows" :key="r.goalId">
                  <th scope="row">{{ r.name }}<small>{{ r.unit }}</small></th>
                  <td v-for="p in r.series" :key="p.weekStart" :class="status(pct(p.actual, p.target))">
                    <template v-if="p.actual !== null">{{ fmt(p.actual) }}<small>/ {{ fmt(p.target) }}</small></template>
                    <span v-else class="na">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </div>

    <!-- ═══ Reportar ═══ -->
    <div v-else-if="tab === 'report'" class="body">
      <p class="intro">{{ t('goals.reportIntro') }}</p>
      <ReportForm v-if="data" :weeks="data.weeks" :initial-dept="reportFor" @saved="load" />
      <Skeleton v-else height="200px" />
    </div>

    <!-- ═══ Metas (Admin) ═══ -->
    <div v-else class="body">
      <p class="intro">{{ t('goals.goalsIntro') }}</p>
      <div v-if="!goals" class="grid gap-3"><Skeleton v-for="n in 3" :key="n" height="56px" /></div>
      <section v-for="x in goalsByDept" v-else :key="x.id" class="admin-dept">
        <h2>{{ x.name }}<button type="button" class="add" @click="openGoal(null, x.id)"><Plus :size="15" />{{ t('goals.addGoal') }}</button></h2>
        <p v-if="!x.goals.length" class="muted">{{ t('goals.noGoalsDept') }}</p>
        <div v-for="g in x.goals" :key="g.id" class="goal-row" :class="{ archived: g.archivedAt }">
          <span class="g-name"><b>{{ g.name }}</b><small>{{ t('goals.perWeek', { n: fmt(g.weeklyTarget), unit: g.unit }) }}</small></span>
          <Badge v-if="g.lineId" :tone="s.lineTone(g.lineId)">{{ s.lineOf(g.lineId)?.name }}</Badge>
          <Badge v-if="g.archivedAt" tone="neutral">{{ t('settings.archived') }}</Badge>
          <span class="g-actions">
            <button type="button" :title="t('goals.editGoal')" :aria-label="t('goals.editGoal')" @click="openGoal(g)"><Pencil :size="16" /></button>
            <button type="button" :title="g.archivedAt ? t('goals.unarchive') : t('settings.archive')" :aria-label="g.archivedAt ? t('goals.unarchive') : t('settings.archive')" @click="toggleArchive(g)">
              <ArchiveRestore v-if="g.archivedAt" :size="16" /><Archive v-else :size="16" />
            </button>
          </span>
        </div>
      </section>
    </div>

    <GoalModal v-model="modal" :goal="editing" :department-id="newIn" @saved="afterSave" />
  </div>
</template>

<style scoped>
.goals { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.top { position: relative; z-index: 2; display: flex; align-items: center; gap: 18px; min-height: 64px; padding: 8px 20px 8px 28px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.back { display: none; width: var(--tap); height: var(--tap); place-items: center; background: none; border: 0; color: inherit; cursor: pointer; }
h1 { margin: 0 auto 0 0; font-size: 24px; }
.exports { display: flex; gap: 6px; }
.exp { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; font: inherit; font-size: 14px; font-weight: 500; color: var(--color-ink); text-decoration: none; background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.exp:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.body { flex: 1; overflow: auto; display: grid; gap: 22px; align-content: start; padding: 18px 32px 40px 28px; }
.intro { margin: 0; max-width: 640px; color: var(--color-muted); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.filters :deep(.dd) { width: 220px; }
.views { display: flex; margin-left: auto; padding: 3px; background: var(--color-canvas-deep); box-shadow: inset 0 1px 3px rgb(19 36 61 / .12); }
.views button { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px; font: inherit; font-size: 13px; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.views .on { color: var(--color-ink); font-weight: 600; background: var(--color-surface); box-shadow: var(--shadow-md); }
.empty { margin-top: 20px; max-width: 520px; }

.missing { display: flex; gap: 12px; padding: 12px 16px; color: var(--color-warning); background: var(--color-warning-light); border-left: 4px solid var(--color-warning); box-shadow: var(--shadow-sm); }
.miss-list { display: grid; gap: 4px; color: var(--color-ink); font-size: 14px; }
.miss button { margin-left: 8px; padding: 0; font: inherit; font-weight: 600; color: var(--color-leaf); background: none; border: 0; text-decoration: underline; cursor: pointer; }

.dept { display: grid; gap: 12px; }
.dept-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; }
.dept-head h2 { margin: 0; font-size: 20px; }
.avg { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 600; }
.avg.ok { color: var(--color-success); }
.avg.near { color: var(--color-warning); }
.avg.low { color: var(--color-danger); }
.avg.none { color: var(--color-muted); font-weight: 500; }

/* Tarjetas: superficie elevada con acento lateral del semáforo; la grilla deja la última fila a la izquierda */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
.card { position: relative; display: grid; gap: 8px; padding: 14px 16px 12px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); transition: box-shadow var(--duration), transform var(--duration); }
.card:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); z-index: 1; }
.card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-line-strong); }
.card.ok::before { background: var(--color-success); }
.card.near::before { background: var(--color-warning); }
.card.low::before { background: var(--color-danger); }
.card header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.card h3 { margin: 0; font: 600 15px/1.3 var(--font-sans); }
.hero { display: flex; align-items: baseline; gap: 6px; font-variant-numeric: tabular-nums; }
.big { font: 700 34px/1 var(--font-display); }
.of { font-size: 14px; color: var(--color-muted); }
.state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; font-size: 12px; font-weight: 600; background: var(--color-canvas); color: var(--color-muted); }
.chip.ok { background: var(--color-success-light); color: var(--color-success); }
.chip.near { background: var(--color-warning-light); color: var(--color-warning); }
.chip.low { background: var(--color-danger-light); color: var(--color-danger); }
.delta { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; color: var(--color-muted); }

.table-wrap { overflow-x: auto; background: var(--color-surface); box-shadow: var(--shadow-md); }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 10px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--color-line); }
thead th { font-weight: 600; color: var(--color-muted); background: var(--color-canvas); }
thead th:first-child { text-align: left; }
tbody th { text-align: left; font-weight: 600; position: sticky; left: 0; background: var(--color-surface); box-shadow: 4px 0 8px -6px rgb(19 36 61 / .25); }
tbody th small, td small { display: block; font-size: 11px; font-weight: 400; color: var(--color-muted); }
td.ok { box-shadow: inset 0 -3px 0 var(--color-success); }
td.near { box-shadow: inset 0 -3px 0 var(--color-warning); }
td.low { box-shadow: inset 0 -3px 0 var(--color-danger); }
.na { color: var(--color-line-strong); }

.admin-dept { display: grid; gap: 6px; max-width: 860px; }
.admin-dept h2 { display: flex; align-items: center; gap: 12px; margin: 6px 0 4px; font-size: 18px; }
.add { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font: inherit; font-size: 13px; color: var(--color-leaf); background: none; border: 1px dashed var(--color-line-strong); cursor: pointer; }
.add:hover { border-color: var(--color-primary); color: var(--color-ink); }
.muted { margin: 0; font-size: 13px; color: var(--color-muted); }
.goal-row { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 16px; background: var(--color-surface); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration); }
.goal-row:hover { box-shadow: var(--shadow-md); }
.goal-row.archived { opacity: .6; }
.g-name { flex: 1; display: grid; min-width: 0; }
.g-name small { font-size: 12px; color: var(--color-muted); }
.g-actions { display: flex; gap: 2px; }
.g-actions button { width: 34px; height: 34px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.g-actions button:hover { color: var(--color-ink); background: var(--color-canvas); }

@media (max-width: 767px) {
  .top { flex-wrap: wrap; gap: 8px; padding: 6px 12px 10px 4px; }
  .back { display: grid; }
  h1 { font-size: 21px; }
  .top :deep(.tabs) { order: 3; width: 100%; padding-left: 8px; }
  .body { padding: 14px 12px 30px; }
  .filters :deep(.dd) { width: calc(50% - 6px); }
  .views { margin-left: 0; }
}
@media print {
  .top { box-shadow: none; }
  .body { overflow: visible; }
  .card, .table-wrap { box-shadow: none; border: 1px solid #ccc; break-inside: avoid; }
}
</style>
