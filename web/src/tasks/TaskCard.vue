<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CalendarClock, ListChecks, MessageSquare, MessageSquareText } from 'lucide-vue-next';
import type { Task } from '@agencia-hub/contracts';
import Avatar from '@/design/Avatar.vue';
import Badge from '@/design/Badge.vue';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';
import { isOverdue } from './store.ts';

const props = defineProps<{ task: Task; showDept?: boolean }>();
defineEmits<{ open: [id: string] }>();
const { t, d } = useI18n();
const s = useSession();
const chat = useChat();

const overdue = computed(() => isOverdue(props.task));
const soon = computed(() => !overdue.value && !!props.task.dueAt && props.task.status !== 'done' && props.task.status !== 'cancelled'
  && new Date(props.task.dueAt).getTime() - Date.now() < 24 * 3600_000);
const done = computed(() => props.task.checklist.filter((i) => i.done).length);
const closed = computed(() => props.task.status === 'done' || props.task.status === 'cancelled');
</script>

<template>
  <button type="button" class="card" :class="[`p-${task.priority}`, { closed }]" @click="$emit('open', task.id)">
    <span class="top">
      <span v-if="showDept" class="dept">{{ s.deptName(task.departmentId) }}</span>
      <Badge v-if="task.priority === 'urgent' || task.priority === 'high'" :tone="task.priority === 'urgent' ? 'danger' : 'warning'">{{ t(`tasks.priority.${task.priority}`) }}</Badge>
      <Badge v-if="task.lineId" :tone="s.lineTone(task.lineId)">{{ s.lineOf(task.lineId)?.name }}</Badge>
    </span>
    <span class="title">{{ task.title }}</span>
    <span class="meta">
      <span v-if="task.dueAt" class="due" :class="{ overdue, soon }"><CalendarClock :size="14" />{{ overdue ? t('tasks.overdue') + ' · ' : '' }}{{ d(task.dueAt, 'day') }}</span>
      <span v-if="task.checklist.length" :class="{ full: done === task.checklist.length }"><ListChecks :size="14" />{{ done }}/{{ task.checklist.length }}</span>
      <span v-if="task.commentCount"><MessageSquare :size="14" />{{ task.commentCount }}</span>
      <span v-if="task.sourceMessageId" :title="t('tasks.fromMessage')"><MessageSquareText :size="14" /></span>
      <span class="who">
        <Avatar v-for="id in task.assigneeIds.slice(0, 3)" :key="id" :name="chat.nameOf(id)" :size="24" />
        <small v-if="task.assigneeIds.length > 3">+{{ task.assigneeIds.length - 3 }}</small>
      </span>
    </span>
  </button>
</template>

<style scoped>
.card {
  position: relative; display: grid; gap: 6px; width: 100%; padding: 10px 12px 10px 15px; font: inherit; text-align: left; color: inherit;
  background: var(--color-surface); border: 0; box-shadow: var(--shadow-sm), 0 0 0 1px rgb(19 36 61 / .05); cursor: pointer;
  transition: box-shadow var(--duration), transform var(--duration);
}
.card:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); }
/* Barra de prioridad a la izquierda */
.card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: transparent; }
.p-urgent::before { background: var(--color-danger); }
.p-high::before { background: var(--color-primary); }
.p-low::before { background: var(--color-line-strong); }
.closed { opacity: .72; }
.closed .title { text-decoration: line-through; text-decoration-color: var(--color-line-strong); }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.top:empty { display: none; }
.dept { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--color-muted); margin-right: auto; }
.title { font-weight: 500; line-height: 1.35; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 12px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
.meta > span { display: inline-flex; align-items: center; gap: 3px; }
.due.soon { color: var(--color-warning); font-weight: 600; }
.due.overdue { color: var(--color-danger); font-weight: 700; }
.full { color: var(--color-success); }
.who { margin-left: auto; }
.who > :deep(*) + :deep(*) { margin-left: -6px; box-shadow: 0 0 0 2px var(--color-surface); }
.who small { padding-left: 4px; }
</style>
