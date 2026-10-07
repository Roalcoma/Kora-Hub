<script setup lang="ts">
// Detalle de una tarea en el panel derecho: estado, campos, responsables, checklist y comentarios.
// Quien gestiona (Admin, Líder del depto, autor) edita todo; los responsables cambian estado y checklist.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Trash2, X, Plus, MessageSquareText, SendHorizontal } from 'lucide-vue-next';
import { TASK_STATUS, TASK_PRIORITY, type TaskComment, type TaskPriority } from '@agencia-hub/contracts';
import SlideOver from '@/design/SlideOver.vue';
import Dropdown from '@/design/Dropdown.vue';
import Avatar from '@/design/Avatar.vue';
import Button from '@/design/Button.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';
import { errorText } from '@/platform/errors.ts';
import PeoplePicker from './PeoplePicker.vue';
import { useTasks, dueFromDate, dateFromDue, isOverdue } from './store.ts';

const id = defineModel<string | null>({ default: null });
const { t, d } = useI18n();
const s = useSession();
const chat = useChat();
const tasks = useTasks();
const slug = () => s.workspace!.slug;

const open = computed({ get: () => !!id.value, set: (v) => { if (!v) id.value = null; } });
const task = computed(() => tasks.all.find((x) => x.id === id.value));
const manage = computed(() => !!task.value && tasks.canManage(task.value));
const work = computed(() => !!task.value && tasks.canWork(task.value));

const title = ref('');
const description = ref('');

// Comentarios: se cargan al abrir y otra vez cuando cambia el contador (llegó uno por WebSocket)
const comments = ref<TaskComment[] | null>(null);
const missing = ref(false);
async function loadDetail() {
  if (!id.value) return;
  try {
    const { comments: list, ...full } = await api('GET /w/:slug/tasks/:id', { params: { slug: slug(), id: id.value } });
    comments.value = list;
    tasks.upsert(full);
    missing.value = false;
  } catch {
    missing.value = true;
  }
}
watch(id, (v) => { comments.value = null; title.value = ''; if (v) loadDetail(); }, { immediate: true });
watch(() => task.value?.commentCount, (n, old) => { if (old !== undefined && n !== comments.value?.length) loadDetail(); });

// ─── Campos ───
watch(task, (x) => {
  if (!x) return;
  if (document.activeElement?.id !== 'task-title') title.value = x.title;
  if (document.activeElement?.id !== 'task-desc') description.value = x.description;
}, { immediate: true });

async function save(body: Parameters<typeof tasks.update>[1]) {
  try { await tasks.update(id.value!, body); } catch (e) { toast(errorText(e), 'error'); }
}
const saveTitle = () => { const v = title.value.trim(); if (v && v !== task.value?.title) save({ title: v }); };
const saveDesc = () => { if (description.value !== task.value?.description) save({ description: description.value }); };

const priority = computed({ get: () => task.value?.priority ?? 'normal', set: (v: TaskPriority) => save({ priority: v }) });
const lineId = computed({ get: () => task.value?.lineId ?? '', set: (v: string) => save({ lineId: v || null }) });
const due = computed({ get: () => dateFromDue(task.value?.dueAt ?? null), set: (v: string) => save({ dueAt: dueFromDate(v) }) });
const assignees = computed({ get: () => task.value?.assigneeIds ?? [], set: (v: string[]) => save({ assigneeIds: v }) });
const priorityOptions = computed(() => TASK_PRIORITY.map((p) => ({ value: p, label: t(`tasks.priority.${p}`) })));
const lineOptions = computed(() => [{ value: '', label: t('tasks.noLine') },
  ...s.workspace!.lines.filter((l) => !l.archivedAt).map((l) => ({ value: l.id, label: l.name }))]);

// ─── Checklist ───
const newItem = ref('');
const call = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { toast(errorText(e), 'error'); } };
const addItem = () => {
  const text = newItem.value.trim();
  if (!text) return;
  newItem.value = '';
  call(() => api('POST /w/:slug/tasks/:id/checklist', { params: { slug: slug(), id: id.value! }, body: { text } }));
};
const toggleItem = (itemId: string, done: boolean) =>
  call(() => api('PATCH /w/:slug/tasks/:id/checklist/:itemId', { params: { slug: slug(), id: id.value!, itemId }, body: { done } }));
const removeItem = (itemId: string) =>
  call(() => api('DELETE /w/:slug/tasks/:id/checklist/:itemId', { params: { slug: slug(), id: id.value!, itemId } }));
const progress = computed(() => task.value?.checklist.length ? task.value.checklist.filter((i) => i.done).length / task.value.checklist.length : 0);

// ─── Comentarios ───
const comment = ref('');
const sending = ref(false);
async function sendComment() {
  const body = comment.value.trim();
  if (!body) return;
  sending.value = true;
  try {
    const c = await api('POST /w/:slug/tasks/:id/comments', { params: { slug: slug(), id: id.value! }, body: { body } });
    comments.value = [...(comments.value ?? []), c];
    comment.value = '';
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    sending.value = false;
  }
}

// ─── Borrar (dos pasos, sin confirm() nativo) ───
const confirmDelete = ref(false);
watch(id, () => { confirmDelete.value = false; });
async function remove() {
  try {
    await tasks.remove(id.value!);
    id.value = null;
    toast(t('tasks.deleted'), 'success');
  } catch (e) {
    toast(errorText(e), 'error');
  }
}
</script>

<template>
  <SlideOver v-model="open" :title="t('tasks.task')" :subtitle="task ? s.deptName(task.departmentId) : ''" width="500px">
    <p v-if="missing && !task" class="gone">{{ t('tasks.notFound') }}</p>
    <div v-else-if="!task" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="44px" /></div>
    <div v-else class="detail">
      <textarea v-if="manage" id="task-title" v-model="title" class="ttl" rows="1" :aria-label="t('tasks.title')"
        @blur="saveTitle" @keydown.enter.prevent="($event.target as HTMLTextAreaElement).blur()" />
      <h3 v-else class="ttl ro">{{ task.title }}</h3>

      <!-- Estado: segmentado, el activo se eleva -->
      <div class="status" role="radiogroup" :aria-label="t('tasks.statusLabel')">
        <button v-for="st in TASK_STATUS" :key="st" type="button" role="radio" :aria-checked="task.status === st" :disabled="!work"
          :class="[st, { on: task.status === st }]" @click="save({ status: st })">{{ t(`tasks.status.${st}`) }}</button>
      </div>

      <dl class="fields">
        <dt>{{ t('tasks.priorityLabel') }}</dt>
        <dd><Dropdown v-model="priority" :options="priorityOptions" :disabled="!manage" /></dd>
        <dt>{{ t('tasks.due') }}</dt>
        <dd>
          <input v-if="manage" type="date" :value="due" :aria-label="t('tasks.due')" @change="due = ($event.target as HTMLInputElement).value">
          <span v-else-if="task.dueAt">{{ d(task.dueAt, 'day') }}</span>
          <span v-else class="muted">—</span>
          <span v-if="isOverdue(task)" class="late">{{ t('tasks.overdue') }}</span>
        </dd>
        <dt>{{ t('tasks.line') }}</dt>
        <dd><Dropdown v-model="lineId" :options="lineOptions" :disabled="!manage" /></dd>
        <dt>{{ t('tasks.createdBy') }}</dt>
        <dd class="by"><Avatar :name="chat.nameOf(task.createdBy)" :size="22" />{{ chat.nameOf(task.createdBy) }} · {{ d(task.createdAt, 'short') }}</dd>
      </dl>

      <PeoplePicker v-model="assignees" :label="t('tasks.assignees')" :disabled="!manage" />

      <RouterLink v-if="task.sourceMessageId && task.sourceChannelId" class="source"
        :to="`/w/${s.workspace!.slug}/c/${task.sourceChannelId}?m=${task.sourceMessageId}`">
        <MessageSquareText :size="16" />{{ t('tasks.openMessage') }}
      </RouterLink>

      <section>
        <h4>{{ t('tasks.description') }}</h4>
        <textarea v-if="manage" id="task-desc" v-model="description" class="desc" rows="4" :placeholder="t('tasks.descriptionHint')" @blur="saveDesc" />
        <p v-else-if="task.description" class="desc ro">{{ task.description }}</p>
        <p v-else class="muted">—</p>
      </section>

      <section>
        <h4>{{ t('tasks.checklist') }} <small v-if="task.checklist.length">{{ task.checklist.filter((i) => i.done).length }}/{{ task.checklist.length }}</small></h4>
        <div v-if="task.checklist.length" class="bar"><span :style="{ width: `${progress * 100}%` }" /></div>
        <ul class="check">
          <li v-for="i in task.checklist" :key="i.id" :class="{ done: i.done }">
            <label><input type="checkbox" :checked="i.done" :disabled="!work" @change="toggleItem(i.id, !i.done)">{{ i.text }}</label>
            <button v-if="work" type="button" :aria-label="t('tasks.removeItem')" @click="removeItem(i.id)"><X :size="14" /></button>
          </li>
        </ul>
        <form v-if="work" class="add-item" @submit.prevent="addItem">
          <Plus :size="16" /><input v-model="newItem" :placeholder="t('tasks.addItem')" :aria-label="t('tasks.addItem')" maxlength="300">
        </form>
      </section>

      <section>
        <h4>{{ t('tasks.comments') }}</h4>
        <ol class="comments">
          <li v-for="c in comments ?? []" :key="c.id">
            <Avatar :name="chat.nameOf(c.userId)" :size="30" />
            <div><p class="who"><b>{{ chat.nameOf(c.userId) }}</b><time>{{ d(c.createdAt, 'short') }}</time></p><p class="txt">{{ c.body }}</p></div>
          </li>
        </ol>
        <form class="reply" @submit.prevent="sendComment">
          <textarea v-model="comment" rows="2" :placeholder="t('tasks.writeComment')" :aria-label="t('tasks.writeComment')"
            @keydown.enter.exact.prevent="sendComment" />
          <button type="submit" :disabled="!comment.trim() || sending" :aria-label="t('tasks.send')"><SendHorizontal :size="18" /></button>
        </form>
      </section>

      <footer v-if="manage" class="danger-zone">
        <template v-if="confirmDelete">
          <span>{{ t('tasks.deleteConfirm') }}</span>
          <Button size="sm" @click="confirmDelete = false">{{ t('common.cancel') }}</Button>
          <Button size="sm" variant="danger" @click="remove">{{ t('tasks.delete') }}</Button>
        </template>
        <Button v-else size="sm" variant="ghost" @click="confirmDelete = true"><Trash2 :size="15" />{{ t('tasks.delete') }}</Button>
      </footer>
    </div>
  </SlideOver>
</template>

<style scoped>
.detail { display: grid; gap: 18px; }
.gone, .muted { color: var(--color-muted); margin: 0; }
.ttl { width: 100%; margin: 0; padding: 4px 0; font: 700 22px/1.25 var(--font-display); color: var(--color-ink); background: none; border: 0; border-bottom: 2px solid transparent; resize: none; field-sizing: content; outline: none; transition: border-color var(--duration); }
.ttl:not(.ro):hover { border-bottom-color: var(--color-line); }
.ttl:not(.ro):focus { border-bottom-color: var(--color-primary); }
.status { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--color-canvas-deep); padding: 3px; box-shadow: inset 0 1px 3px rgb(19 36 61 / .12); }
.status button { min-height: 36px; padding: 0 4px; font: inherit; font-size: 13px; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), box-shadow var(--duration), color var(--duration); }
.status button:not(:disabled):hover { color: var(--color-ink); }
.status button:disabled { cursor: default; }
.status .on { color: var(--color-ink); font-weight: 600; background: var(--color-surface); box-shadow: var(--shadow-md); }
.status .on.doing { box-shadow: var(--shadow-md), inset 0 -3px 0 var(--color-primary); }
.status .on.done { box-shadow: var(--shadow-md), inset 0 -3px 0 var(--color-success); }
.status .on.cancelled { box-shadow: var(--shadow-md), inset 0 -3px 0 var(--color-line-strong); }
.fields { display: grid; grid-template-columns: 110px minmax(0, 1fr); align-items: center; gap: 10px 14px; margin: 0; }
dt { font-size: 13px; color: var(--color-muted); }
dd { margin: 0; display: flex; align-items: center; gap: 8px; min-width: 0; }
dd :deep(.dd) { flex: 1; }
.late { font-size: 12px; font-weight: 700; color: var(--color-danger); }
.by { font-size: 13px; }
.source { display: inline-flex; align-items: center; gap: 8px; justify-self: start; padding: 8px 12px; font-size: 14px; text-decoration: none; background: var(--color-canvas); border-left: 3px solid var(--color-cta); box-shadow: var(--shadow-sm); }
.source:hover { box-shadow: var(--shadow-md); }
section { display: grid; gap: 8px; }
h4 { margin: 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--color-muted); }
h4 small { font-weight: 500; letter-spacing: 0; }
.desc { width: 100%; padding: 10px 12px; font: inherit; line-height: 1.5; color: inherit; background: var(--color-canvas); border: 1px solid transparent; resize: vertical; outline: none; white-space: pre-wrap; margin: 0; }
.desc:not(.ro):hover { border-color: var(--color-line); }
.desc:not(.ro):focus { background: var(--color-surface); border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .2); }
.bar { height: 5px; background: var(--color-canvas-deep); }
.bar span { display: block; height: 100%; background: var(--color-success); transition: width 240ms; }
.check { list-style: none; margin: 0; padding: 0; display: grid; }
.check li { display: flex; align-items: center; gap: 6px; min-height: 38px; border-bottom: 1px solid var(--color-line); }
.check label { flex: 1; display: flex; align-items: center; gap: 10px; cursor: pointer; overflow-wrap: anywhere; }
.check li.done label { color: var(--color-muted); text-decoration: line-through; }
.check button { width: 30px; height: 30px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; opacity: 0; }
.check li:hover button, .check button:focus-visible { opacity: 1; }
.add-item { display: flex; align-items: center; gap: 8px; color: var(--color-muted); }
.add-item input { flex: 1; min-height: 36px; font: inherit; background: none; border: 0; border-bottom: 1px dashed var(--color-line-strong); outline: none; }
.add-item input:focus { border-bottom: 1px solid var(--color-primary); }
.comments { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.comments li { display: flex; gap: 10px; }
.comments .who { margin: 0; display: flex; align-items: baseline; gap: 8px; font-size: 14px; }
.comments time { font-size: 12px; color: var(--color-muted); }
.comments .txt { margin: 2px 0 0; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.reply { display: flex; align-items: flex-end; gap: 8px; padding: 8px; background: var(--color-surface); box-shadow: var(--shadow-md), 0 0 0 1px rgb(19 36 61 / .06); }
.reply textarea { flex: 1; min-height: 40px; font: inherit; border: 0; outline: none; resize: none; field-sizing: content; max-height: 160px; }
.reply button { width: 40px; height: 40px; display: grid; place-items: center; color: var(--color-ink); background: var(--color-primary); border: 0; box-shadow: var(--shadow-sm); cursor: pointer; }
.reply button:disabled { background: var(--color-canvas-deep); color: var(--color-muted); box-shadow: none; cursor: default; }
.danger-zone { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 12px; border-top: 1px solid var(--color-line); font-size: 14px; }
@media (max-width: 767px) { .reply textarea, .add-item input { font-size: 16px; } }
</style>
