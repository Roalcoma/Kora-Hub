<script setup lang="ts">
// Lista editable de departamentos o líneas de negocio: agregar, renombrar, archivar.
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Archive, ArchiveRestore } from 'lucide-vue-next';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import { toast } from '@/design/toast.ts';
import { errorText } from './errors.ts';

const props = defineProps<{ kind: 'departments' | 'lines' }>();
const { t } = useI18n();
const s = useSession();

const items = computed(() => (props.kind === 'departments' ? s.workspace!.departments : s.workspace!.lines));
const newName = ref('');
const busy = ref(false);
const params = computed(() => ({ slug: s.workspace!.slug }));

async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
    await s.refreshWorkspace();
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = false;
  }
}
const add = () => {
  const name = newName.value.trim();
  if (!name) return;
  run(async () => {
    if (props.kind === 'departments') await api('POST /w/:slug/departments', { params: params.value, body: { name } });
    else await api('POST /w/:slug/lines', { params: params.value, body: { name } });
    newName.value = '';
  });
};
const patch = (id: string, body: { name?: string; archived?: boolean }) => run(() =>
  props.kind === 'departments'
    ? api('PATCH /w/:slug/departments/:id', { params: { ...params.value, id }, body })
    : api('PATCH /w/:slug/lines/:id', { params: { ...params.value, id }, body }));
function rename(id: string, old: string, e: Event) {
  const name = (e.target as HTMLInputElement).value.trim();
  if (name && name !== old) patch(id, { name });
}
</script>

<template>
  <div class="ed">
    <ul>
      <li v-for="it in items" :key="it.id" :class="{ arch: it.archivedAt }">
        <input :value="it.name" :aria-label="t('settings.rename')" :disabled="!!it.archivedAt" maxlength="80"
          @change="rename(it.id, it.name, $event)" @keydown.enter="($event.target as HTMLInputElement).blur()">
        <Badge v-if="it.archivedAt">{{ t('settings.archived') }}</Badge>
        <button type="button" class="icon" :aria-label="t('settings.archive')" :disabled="busy" @click="patch(it.id, { archived: !it.archivedAt })">
          <ArchiveRestore v-if="it.archivedAt" :size="16" /><Archive v-else :size="16" />
        </button>
      </li>
    </ul>
    <form class="add" @submit.prevent="add">
      <input v-model="newName" :placeholder="kind === 'departments' ? t('onboarding.newDepartment') : t('onboarding.newLine')" maxlength="80">
      <Button type="submit" :loading="busy"><Plus :size="16" />{{ t('common.add') }}</Button>
    </form>
  </div>
</template>

<style scoped>
.ed { display: grid; gap: 10px; }
ul { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-line); background: var(--color-surface); }
li { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 4px; border-top: 1px solid var(--color-line); }
li:first-child { border-top: 0; }
li.arch input { color: var(--color-muted); text-decoration: line-through; }
input { flex: 1; min-width: 0; min-height: 38px; padding: 0 10px; font: inherit; color: inherit; background: transparent; border: 1px solid transparent; outline: none; }
input:hover:not(:disabled) { border-color: var(--color-line); }
input:focus { border-color: var(--color-ink); background: var(--color-surface); }
.icon { width: 38px; height: 38px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.icon:hover { color: var(--color-ink); background: var(--color-canvas); }
.add { display: flex; gap: 8px; }
.add input { border-color: var(--color-line-strong); background: var(--color-surface); }
</style>
