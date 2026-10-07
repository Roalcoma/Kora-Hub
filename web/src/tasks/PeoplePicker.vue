<script setup lang="ts">
// Responsables de una tarea: fichas con avatar + buscador flotante de miembros activos.
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, X } from 'lucide-vue-next';
import Avatar from '@/design/Avatar.vue';
import Popover from '@/design/Popover.vue';
import { useChat } from '@/chat/store.ts';

const model = defineModel<string[]>({ default: () => [] });
defineProps<{ label?: string; disabled?: boolean }>();
const { t } = useI18n();
const chat = useChat();

const open = ref(false);
const q = ref('');
const input = ref<HTMLInputElement>();
const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const options = computed(() => chat.members
  .filter((m) => m.isActive && m.role !== 'guest' && !model.value.includes(m.userId) && fold(m.name).includes(fold(q.value)))
  .slice(0, 8));
watch(open, async (v) => { if (v) { q.value = ''; await nextTick(); input.value?.focus(); } });

function add(id: string) {
  model.value = [...model.value, id];
  q.value = '';
  if (!options.value.length) open.value = false;
}
const removeId = (id: string) => { model.value = model.value.filter((x) => x !== id); };
</script>

<template>
  <div class="pp">
    <span v-if="label" class="lbl">{{ label }}</span>
    <div class="chips">
      <span v-for="id in model" :key="id" class="chip">
        <Avatar :name="chat.nameOf(id)" :size="22" />{{ chat.nameOf(id) }}
        <button v-if="!disabled" type="button" :aria-label="t('tasks.removePerson', { name: chat.nameOf(id) })" @click="removeId(id)"><X :size="13" /></button>
      </span>
      <Popover v-if="!disabled" v-model="open" placement="bottom-start">
        <template #trigger>
          <button type="button" class="add" :aria-expanded="open" @click="open = !open"><Plus :size="15" />{{ t('tasks.addPerson') }}</button>
        </template>
        <div class="menu">
          <input ref="input" v-model="q" :placeholder="t('tasks.searchPeople')" :aria-label="t('tasks.searchPeople')" @keydown.enter.prevent="options[0] && add(options[0].userId)">
          <button v-for="m in options" :key="m.userId" type="button" class="opt" @click="add(m.userId)">
            <Avatar :name="m.name" :size="26" :presence="m.presence" /><span><b>{{ m.name }}</b><small>{{ m.title ?? t(`roles.${m.role}`) }}</small></span>
          </button>
          <p v-if="!options.length" class="none">{{ t('tasks.noPeople') }}</p>
        </div>
      </Popover>
    </div>
  </div>
</template>

<style scoped>
.pp { display: grid; gap: 6px; }
.lbl { font-size: 14px; font-weight: 500; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 3px; font-size: 13px; background: var(--color-surface); box-shadow: var(--shadow-sm), inset 0 0 0 1px var(--color-line); }
.chip button { width: 22px; height: 22px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.chip button:hover { color: var(--color-ink); background: var(--color-canvas-deep); }
.add { display: inline-flex; align-items: center; gap: 4px; min-height: 30px; padding: 0 10px; font: inherit; font-size: 13px; color: var(--color-leaf); background: none; border: 1px dashed var(--color-line-strong); cursor: pointer; transition: border-color var(--duration), color var(--duration); }
.add:hover { border-color: var(--color-primary); color: var(--color-ink); }
.menu { width: 280px; display: grid; padding: 6px; background: var(--color-surface); box-shadow: var(--shadow-lg), 0 0 0 1px rgb(19 36 61 / .06); }
.menu input { min-height: 38px; padding: 0 10px; margin-bottom: 4px; font: inherit; border: 1px solid var(--color-line-strong); outline: none; }
.menu input:focus { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .2); }
.opt { position: relative; display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 4px 8px; font: inherit; text-align: left; color: inherit; background: none; border: 0; cursor: pointer; }
.opt:hover, .opt:focus-visible { background: var(--color-canvas); box-shadow: inset 3px 0 0 var(--color-primary); outline: none; }
.opt span { display: grid; min-width: 0; }
.opt small { font-size: 12px; color: var(--color-muted); }
.none { margin: 6px 8px; font-size: 13px; color: var(--color-muted); }
</style>
