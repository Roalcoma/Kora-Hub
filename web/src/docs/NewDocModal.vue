<script setup lang="ts">
// Nueva página de manual (en la raíz de un departamento o como subpágina).
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useDocs } from './store.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ departmentId: string; parentId?: string | null; parentTitle?: string }>();
const { t } = useI18n();
const router = useRouter();
const s = useSession();
const docs = useDocs();

const title = ref('');
const lineId = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
watch(open, (v) => { if (v) { title.value = ''; lineId.value = s.lineId ?? ''; error.value = null; } });
const lineOptions = computed(() => [{ value: '', label: t('docs.allLines') },
  ...s.workspace!.lines.filter((l) => !l.archivedAt).map((l) => ({ value: l.id, label: l.name }))]);

async function create() {
  busy.value = true;
  error.value = null;
  try {
    const doc = await api('POST /w/:slug/documents', { params: { slug: s.workspace!.slug }, body: {
      departmentId: props.departmentId, parentId: props.parentId ?? null, title: title.value.trim(), lineId: lineId.value || null } });
    docs.upsert(doc);
    open.value = false;
    router.push({ path: `/w/${s.workspace!.slug}/manuals/${doc.id}`, query: { edit: '1' } });
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-model="open" :title="parentId ? t('docs.newSubpage') : t('docs.newPage')"
    :subtitle="parentTitle ? t('docs.inside', { title: parentTitle }) : s.deptName(departmentId)" width="480px">
    <form id="new-doc" class="grid gap-4" @submit.prevent="create">
      <Input v-model="title" :label="t('docs.pageTitle')" :placeholder="t('docs.pageTitleHint')" :error="error" required />
      <Dropdown v-model="lineId" :options="lineOptions" :label="t('docs.lineLabel')" />
    </form>
    <template #footer>
      <Button @click="open = false">{{ t('common.cancel') }}</Button>
      <Button type="submit" form="new-doc" variant="primary" :loading="busy" :disabled="!title.trim()">{{ t('docs.create') }}</Button>
    </template>
  </Modal>
</template>
