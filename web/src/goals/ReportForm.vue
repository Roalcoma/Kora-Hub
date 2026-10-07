<script setup lang="ts">
// Reporte semanal (§5.5): el Líder carga lo logrado vs. la meta de su departamento.
// Semana actual o la anterior; un Admin puede corregir semanas cerradas (queda en la auditoría).
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Send, Lock } from 'lucide-vue-next';
import type { Goal, WeeklyReport } from '@agencia-hub/contracts';
import Dropdown from '@/design/Dropdown.vue';
import Textarea from '@/design/Textarea.vue';
import Button from '@/design/Button.vue';
import Skeleton from '@/design/Skeleton.vue';
import Badge from '@/design/Badge.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';
import { errorText } from '@/platform/errors.ts';

const props = defineProps<{ weeks: string[]; initialDept?: string }>();   // lunes, del más antiguo al actual
const emit = defineEmits<{ saved: [] }>();
const { t, d } = useI18n();
const s = useSession();
const chat = useChat();
const slug = () => s.workspace!.slug;

const myDepts = computed(() => s.workspace!.departments.filter((x) => !x.archivedAt && (s.isAdmin || s.workspace!.me.leadOfDepartmentIds.includes(x.id))));
const dept = ref(props.initialDept && myDepts.value.some((x) => x.id === props.initialDept) ? props.initialDept : myDepts.value[0]?.id ?? '');
const deptOptions = computed(() => myDepts.value.map((x) => ({ value: x.id, label: x.name })));
// Líder: esta semana y la anterior. Admin: las 12 del tablero.
const weekOptions = computed(() => [...props.weeks].reverse().slice(0, s.isAdmin ? 12 : 2).map((w, i) => ({
  value: w, label: i === 0 ? t('goals.thisWeekOf', { date: label(w) }) : i === 1 ? t('goals.lastWeekOf', { date: label(w) }) : t('goals.weekOf', { date: label(w) }),
})));
const week = ref(props.weeks.at(-1) ?? '');
const label = (w: string) => d(new Date(`${w}T12:00:00`), 'day');
const closed = computed(() => props.weeks.indexOf(week.value) < props.weeks.length - 2);

const goals = ref<Goal[] | null>(null);
const existing = ref<WeeklyReport | null>(null);
const values = ref<Record<string, { actual: string; note: string }>>({});
const notes = ref('');
const busy = ref(false);

async function load() {
  goals.value = null;
  if (!dept.value || !week.value) return;
  const [g, r] = await Promise.all([
    api('GET /w/:slug/goals', { params: { slug: slug() }, query: { departmentId: dept.value } }),
    api('GET /w/:slug/reports', { params: { slug: slug() }, query: { departmentId: dept.value, weekStart: week.value } }),
  ]);
  existing.value = r[0] ?? null;
  // Metas activas + las archivadas que ya estaban en este reporte
  const inReport = new Set(existing.value?.items.map((i) => i.goalId));
  goals.value = g.filter((x) => !x.archivedAt || inReport.has(x.id));
  values.value = Object.fromEntries(goals.value.map((x) => {
    const item = existing.value?.items.find((i) => i.goalId === x.id);
    return [x.id, { actual: item ? String(item.actual) : '', note: item?.note ?? '' }];
  }));
  notes.value = existing.value?.notes ?? '';
}
watch([dept, week], load, { immediate: true });

const targetOf = (g: Goal) => existing.value?.items.find((i) => i.goalId === g.id)?.target ?? g.weeklyTarget;
const pct = (g: Goal) => {
  const v = Number(values.value[g.id]?.actual);
  return values.value[g.id]?.actual === '' || Number.isNaN(v) ? null : Math.round((v / targetOf(g)) * 100);
};
const filled = computed(() => goals.value?.filter((g) => values.value[g.id]?.actual !== '') ?? []);

async function submit() {
  busy.value = true;
  try {
    await api('PUT /w/:slug/reports', { params: { slug: slug() }, body: {
      departmentId: dept.value, weekStart: week.value, notes: notes.value,
      items: filled.value.map((g) => ({ goalId: g.id, actual: Number(values.value[g.id]!.actual), note: values.value[g.id]!.note.trim() || null })),
    } });
    toast(t('goals.reportSaved'), 'success');
    await load();
    emit('saved');
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="report">
    <p v-if="!myDepts.length" class="muted">{{ t('goals.notLead') }}</p>
    <template v-else>
      <div class="pick">
        <Dropdown v-model="dept" :options="deptOptions" :label="t('tasks.department')" />
        <Dropdown v-model="week" :options="weekOptions" :label="t('goals.week')" />
      </div>
      <p v-if="existing" class="was">
        {{ t('goals.submittedBy', { name: chat.nameOf(existing.submittedBy), date: d(existing.submittedAt, 'short') }) }}
        <Badge v-if="closed" tone="warning"><Lock :size="12" />{{ t('goals.adminEdit') }}</Badge>
      </p>

      <div v-if="!goals" class="grid gap-3"><Skeleton v-for="n in 3" :key="n" height="64px" /></div>
      <p v-else-if="!goals.length" class="muted">{{ t('goals.noGoalsDept') }}</p>
      <form v-else class="form" @submit.prevent="submit">
        <div v-for="g in goals" :key="g.id" class="row">
          <label :for="`a-${g.id}`" class="name"><b>{{ g.name }}</b><small>{{ t('goals.targetIs', { n: targetOf(g).toLocaleString(), unit: g.unit }) }}</small></label>
          <div class="num">
            <input :id="`a-${g.id}`" v-model="values[g.id]!.actual" type="number" min="0" step="any" inputmode="decimal" placeholder="0">
            <span class="unit">{{ g.unit }}</span>
          </div>
          <span class="pct" :class="pct(g) === null ? '' : pct(g)! >= 100 ? 'ok' : pct(g)! >= 70 ? 'near' : 'low'">{{ pct(g) === null ? '—' : `${pct(g)}%` }}</span>
          <input v-model="values[g.id]!.note" class="note" maxlength="500" :placeholder="t('goals.itemNote')" :aria-label="t('goals.itemNote')">
        </div>
        <Textarea v-model="notes" :label="t('goals.notes')" :placeholder="t('goals.notesHint')" :rows="3" />
        <div class="foot">
          <Button type="submit" variant="primary" :loading="busy" :disabled="!filled.length"><Send :size="16" />{{ existing ? t('goals.update') : t('goals.submit') }}</Button>
        </div>
      </form>
    </template>
  </div>
</template>

<style scoped>
.report { display: grid; gap: 16px; max-width: 820px; }
.muted { color: var(--color-muted); margin: 0; }
.pick { display: grid; grid-template-columns: 1fr 1.2fr; gap: 14px; max-width: 560px; }
.was { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; font-size: 13px; color: var(--color-muted); }
.form { display: grid; gap: 10px; }
.row { display: grid; grid-template-columns: minmax(0, 1.4fr) 180px 60px; grid-template-areas: 'name num pct' 'name note note'; align-items: center; gap: 8px 14px; padding: 12px 14px 12px 18px; background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px rgb(19 36 61 / .05); border-left: 3px solid var(--color-primary); }
.name { grid-area: name; display: grid; gap: 2px; }
.name small { font-size: 12px; color: var(--color-muted); }
.num { grid-area: num; display: flex; align-items: center; border: 1px solid var(--color-line-strong); background: var(--color-surface); }
.num:focus-within { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .2); }
.num input { width: 100%; min-width: 0; min-height: 40px; padding: 0 10px; font: inherit; font-size: 17px; font-weight: 600; text-align: right; border: 0; outline: none; background: none; font-variant-numeric: tabular-nums; }
.unit { padding: 0 10px; font-size: 12px; color: var(--color-muted); white-space: nowrap; }
.pct { grid-area: pct; font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; color: var(--color-muted); }
.pct.ok { color: var(--color-success); }
.pct.near { color: var(--color-warning); }
.pct.low { color: var(--color-danger); }
.note { grid-area: note; min-height: 32px; padding: 0 8px; font: inherit; font-size: 13px; background: var(--color-canvas); border: 1px solid transparent; outline: none; }
.note:focus { background: var(--color-surface); border-color: var(--color-line-strong); }
.foot { display: flex; justify-content: flex-start; }
@media (max-width: 767px) {
  .pick { grid-template-columns: 1fr; }
  .row { grid-template-columns: minmax(0, 1fr) 70px; grid-template-areas: 'name pct' 'num num' 'note note'; }
  .num input, .note { font-size: 16px; }
}
</style>
