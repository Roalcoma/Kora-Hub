<script setup lang="ts">
// Crear o editar una meta semanal (solo Admin). Ej.: "Pólizas Vida vendidas — 15 por semana".
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Goal } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ goal?: Goal | null; departmentId?: string }>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n();
const s = useSession();

const f = reactive({ departmentId: '', lineId: '', name: '', unit: '', target: '' });
const error = ref<string | null>(null);
const busy = ref(false);
watch(open, (v) => {
  if (!v) return;
  const g = props.goal;
  Object.assign(f, {
    departmentId: g?.departmentId ?? props.departmentId ?? s.workspace!.departments.find((x) => !x.archivedAt)?.id ?? '',
    lineId: g?.lineId ?? '', name: g?.name ?? '', unit: g?.unit ?? '', target: g ? String(g.weeklyTarget) : '',
  });
  error.value = null;
});
const deptOptions = computed(() => s.workspace!.departments.filter((x) => !x.archivedAt).map((x) => ({ value: x.id, label: x.name })));
const lineOptions = computed(() => [{ value: '', label: t('tasks.noLine') },
  ...s.workspace!.lines.filter((l) => !l.archivedAt).map((l) => ({ value: l.id, label: l.name }))]);
const valid = computed(() => f.name.trim() && f.unit.trim() && Number(f.target) > 0);

async function save() {
  busy.value = true;
  error.value = null;
  const body = { departmentId: f.departmentId, lineId: f.lineId || null, name: f.name.trim(), unit: f.unit.trim(), weeklyTarget: Number(f.target) };
  try {
    if (props.goal) await api('PATCH /w/:slug/goals/:id', { params: { slug: s.workspace!.slug, id: props.goal.id }, body });
    else await api('POST /w/:slug/goals', { params: { slug: s.workspace!.slug }, body });
    toast(t('goals.goalSaved'), 'success');
    open.value = false;
    emit('saved');
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-model="open" :title="goal ? t('goals.editGoal') : t('goals.newGoal')" :subtitle="t('goals.goalHint')" width="520px">
    <form id="goal-form" class="grid gap-4" @submit.prevent="save">
      <Input v-model="f.name" :label="t('goals.goalName')" :placeholder="t('goals.goalNameHint')" :error="error" required />
      <div class="row">
        <Input v-model="f.target" type="number" :label="t('goals.weeklyTarget')" required />
        <Input v-model="f.unit" :label="t('goals.unit')" :placeholder="t('goals.unitHint')" required />
      </div>
      <div class="row">
        <Dropdown v-model="f.departmentId" :options="deptOptions" :label="t('tasks.department')" />
        <Dropdown v-model="f.lineId" :options="lineOptions" :label="t('tasks.line')" />
      </div>
      <p v-if="goal" class="note">{{ t('goals.historyKept') }}</p>
    </form>
    <template #footer>
      <Button @click="open = false">{{ t('common.cancel') }}</Button>
      <Button type="submit" form="goal-form" variant="primary" :loading="busy" :disabled="!valid">{{ t('common.save') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; }
.note { margin: 0; padding: 8px 12px; font-size: 13px; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
@media (max-width: 520px) { .row { grid-template-columns: 1fr; } }
</style>
