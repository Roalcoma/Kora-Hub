<script setup lang="ts">
// "Nueva tarea": un solo formulario para toda la app. Lo abre el tablero o el menú de un mensaje (tasks.compose).
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { MessageSquareText } from 'lucide-vue-next';
import { TASK_PRIORITY, type TaskPriority } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Textarea from '@/design/Textarea.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import PeoplePicker from './PeoplePicker.vue';
import { useTasks, dueFromDate } from './store.ts';

const { t } = useI18n();
const router = useRouter();
const s = useSession();
const tasks = useTasks();

const open = computed({ get: () => !!tasks.draft, set: (v) => { if (!v) tasks.draft = null; } });
const f = reactive({ title: '', description: '', departmentId: '', lineId: '', priority: 'normal' as TaskPriority, due: '', assigneeIds: [] as string[] });
const error = ref<string | null>(null);
const busy = ref(false);

watch(() => tasks.draft, (d) => {
  if (!d) return;
  const depts = tasks.creatableDepts;
  // Por defecto: el departamento pedido, si no el primero mío
  const dept = depts.find((x) => x.id === d.departmentId) ?? depts.find((x) => s.workspace!.me.departmentIds.includes(x.id)) ?? depts[0];
  Object.assign(f, {
    title: d.title ?? '', description: d.description ?? '', departmentId: dept?.id ?? '', lineId: d.lineId ?? s.lineId ?? '',
    priority: d.priority ?? 'normal', due: '', assigneeIds: d.assigneeIds ?? [],
  });
  error.value = null;
});

const deptOptions = computed(() => tasks.creatableDepts.map((d) => ({ value: d.id, label: d.name })));
const lineOptions = computed(() => [{ value: '', label: t('tasks.noLine', s.cat) },
  ...s.workspace!.lines.filter((l) => !l.archivedAt).map((l) => ({ value: l.id, label: l.name }))]);
const priorityOptions = computed(() => TASK_PRIORITY.map((p) => ({ value: p, label: t(`tasks.priority.${p}`) })));

async function submit() {
  if (!f.title.trim() || !f.departmentId) return;
  busy.value = true;
  error.value = null;
  try {
    const task = await tasks.create({
      departmentId: f.departmentId, lineId: f.lineId || null, title: f.title.trim(), description: f.description,
      priority: f.priority, dueAt: dueFromDate(f.due), assigneeIds: f.assigneeIds, sourceMessageId: tasks.draft?.sourceMessageId,
    });
    tasks.draft = null;
    toast(t('tasks.created'), 'success');
    router.push({ path: `/w/${s.workspace!.slug}/tasks`, query: { t: task.id } });
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-model="open" :title="t('tasks.new')" :subtitle="t('tasks.newHint')" width="560px">
    <p v-if="!deptOptions.length" class="warn">{{ t('tasks.noDepartments') }}</p>
    <form v-else id="new-task" class="grid gap-4" @submit.prevent="submit">
      <blockquote v-if="tasks.draft?.sourcePreview" class="src"><MessageSquareText :size="15" /><span>{{ tasks.draft.sourcePreview }}</span></blockquote>
      <Input v-model="f.title" :label="t('tasks.title')" :error="error" required />
      <div class="row">
        <Dropdown v-model="f.departmentId" :options="deptOptions" :label="t('tasks.department')" />
        <Dropdown v-model="f.priority" :options="priorityOptions" :label="t('tasks.priorityLabel')" />
      </div>
      <div class="row" :class="{ single: !s.activeLines.length }">
        <label class="date"><span>{{ t('tasks.due') }}</span><input v-model="f.due" type="date"></label>
        <Dropdown v-if="s.activeLines.length" v-model="f.lineId" :options="lineOptions" :label="t('tasks.line', s.cat)" />
      </div>
      <PeoplePicker v-model="f.assigneeIds" :label="t('tasks.assignees')" />
      <Textarea v-model="f.description" :label="t('tasks.description')" :rows="3" />
    </form>
    <template #footer>
      <Button @click="open = false">{{ t('common.cancel') }}</Button>
      <Button v-if="deptOptions.length" type="submit" form="new-task" variant="primary" :loading="busy" :disabled="!f.title.trim()">{{ t('tasks.create') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; align-items: end; }
.row.single { grid-template-columns: 1fr; }
.date { display: grid; gap: 6px; font-size: 14px; font-weight: 500; }
.date input { min-height: 42px; }
.src { display: flex; gap: 8px; margin: 0; padding: 10px 12px; font-size: 14px; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.src span { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.warn { margin: 0; color: var(--color-muted); }
@media (max-width: 520px) { .row { grid-template-columns: 1fr; } }
</style>
