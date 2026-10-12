<script setup lang="ts">
// Configuración de Finanzas: categorías de gasto (crear, renombrar, color de la paleta, archivar), cuentas bancarias
// (SetupBank, fase C) y, a todo el ancho, calendarios y personas de nómina (SetupPayroll, fase B).
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Archive, ArchiveRestore, Tags } from 'lucide-vue-next';
import { CATEGORY_COLORS, type CategoryColor } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Dropdown from '@/design/Dropdown.vue';
import EmptyState from '@/design/EmptyState.vue';
import { toneColor } from '@/design/types.ts';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import SetupBank from './SetupBank.vue';
import SetupPayroll from './SetupPayroll.vue';

const { t } = useI18n();
const s = useSession();
const fin = useFinance();
const params = () => ({ slug: s.workspace!.slug });

/** Vigentes primero (por posición), las archivadas al final */
const categories = computed(() => [...fin.categories].sort((a, b) =>
  Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.position - b.position));
const colorOptions = computed(() => CATEGORY_COLORS.map((c) => ({ value: c, label: t(`settings.colors.${c}`), swatch: toneColor(c) })));

const busy = ref(false);
async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
    await fin.loadCategories();
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
const patch = (id: string, body: { name?: string; color?: CategoryColor; archived?: boolean }) =>
  run(() => api('PATCH /w/:slug/finance/expense-categories/:id', { params: { ...params(), id }, body }));
function rename(id: string, old: string, e: Event) {
  const name = (e.target as HTMLInputElement).value.trim();
  if (name && name !== old) patch(id, { name });
  else (e.target as HTMLInputElement).value = old;
}

const newName = ref('');
const newColor = ref<CategoryColor>('blue');
const add = () => {
  const name = newName.value.trim();
  if (!name) return;
  run(async () => {
    await api('POST /w/:slug/finance/expense-categories', { params: params(), body: { name, color: newColor.value } });
    newName.value = '';
  });
};
</script>

<template>
  <div class="body">
    <div class="split">
      <section class="card accent">
        <header class="head"><h2><Tags :size="20" />{{ t('finance.setup.categories') }}</h2><small>{{ t('finance.setup.categoriesHint') }}</small></header>
        <EmptyState v-if="!categories.length" :title="t('finance.setup.noCategories')" :text="t('finance.setup.noCategoriesText')" />
        <ul v-else class="cats">
          <li v-for="c in categories" :key="c.id" :class="{ arch: c.archivedAt }">
            <span class="sw" :style="{ background: toneColor(c.color) }" />
            <input :value="c.name" :aria-label="t('settings.rename')" :disabled="!!c.archivedAt" maxlength="60"
              @change="rename(c.id, c.name, $event)" @keydown.enter="($event.target as HTMLInputElement).blur()">
            <Badge v-if="c.archivedAt">{{ t('settings.archived') }}</Badge>
            <Dropdown v-else class="color" :model-value="c.color" :options="colorOptions" :aria-label="t('settings.color')"
              @update:model-value="(v) => v && v !== c.color && patch(c.id, { color: v })" />
            <button type="button" class="ico" :disabled="busy" :title="c.archivedAt ? t('finance.setup.restore') : t('settings.archive')"
              :aria-label="c.archivedAt ? t('finance.setup.restore') : t('settings.archive')" @click="patch(c.id, { archived: !c.archivedAt })">
              <ArchiveRestore v-if="c.archivedAt" :size="16" /><Archive v-else :size="16" />
            </button>
          </li>
        </ul>
        <form class="add" @submit.prevent="add">
          <input v-model="newName" :placeholder="t('finance.setup.newCategory')" :aria-label="t('finance.setup.newCategory')" maxlength="60">
          <Dropdown v-model="newColor" class="color" :options="colorOptions" :aria-label="t('settings.color')" />
          <Button type="submit" :loading="busy" :disabled="!newName.trim()"><Plus :size="16" />{{ t('common.add') }}</Button>
        </form>
        <p class="hint">{{ t('finance.setup.archiveHint') }}</p>
      </section>
      <SetupBank />
    </div>
    <SetupPayroll />
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 20px; align-content: start; padding: 18px 32px 40px 28px; }
/* Categorías pesan más que las cuentas del banco */
.split { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr); gap: 20px; align-items: start; }
.card { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: 14px; align-content: start; padding: 18px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.card.accent { border-left: 4px solid var(--color-primary); }
.head { display: grid; gap: 2px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.head small { color: var(--color-muted); }
.card :deep(.empty) { box-shadow: none; background: var(--color-canvas); }

.cats { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.cats li { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 0; border-top: 1px solid var(--color-line); transition: background var(--duration); }
.cats li:first-child { border-top: 0; }
.cats li:hover { background: var(--color-canvas); }
.sw { align-self: stretch; width: 5px; flex: none; }
.cats li.arch .sw { opacity: .35; }
.cats li.arch input { color: var(--color-muted); text-decoration: line-through; }
input { flex: 1; min-width: 0; min-height: 38px; padding: 0 10px; font: inherit; color: inherit; background: transparent; border: 1px solid transparent; outline: none; }
input:hover:not(:disabled) { border-color: var(--color-line); }
input:focus { border-color: var(--color-ink); background: var(--color-surface); }
.color { width: 150px; flex: none; }
.color :deep(.trigger) { width: 100%; min-width: 0; min-height: 36px; box-shadow: none; border-color: var(--color-line); }
.ico { width: 36px; height: 36px; display: grid; place-items: center; flex: none; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }
.add { display: flex; gap: 8px; }
.add input { border-color: var(--color-line-strong); background: var(--color-surface); }
.hint { margin: -4px 0 0; font-size: 13px; color: var(--color-muted); }

@media (max-width: 1100px) { .split { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 767px) {
  .body { padding: 14px 16px 32px; }
  .card { padding: 16px; }
  .add { flex-wrap: wrap; }
  .add input { flex-basis: 100%; }
  .add .color { flex: 1; }
}
@media (max-width: 420px) { .cats .color { width: 140px; } }
</style>
