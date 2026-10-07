<script setup lang="ts">
// Ctrl/⌘ + K: saltar a un canal o persona, o buscar en mensajes.
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Hash, Lock, Megaphone, Search, CornerDownLeft } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import Avatar from '@/design/Avatar.vue';
import Kbd from '@/design/Kbd.vue';
import { useChat } from './store.ts';

const open = defineModel<boolean>({ default: false });
const { t } = useI18n();
const router = useRouter();
const s = useSession();
const chat = useChat();
const q = ref('');
const index = ref(0);
const input = ref<HTMLInputElement>();
const dlg = ref<HTMLDialogElement>();
const base = () => `/w/${s.workspace!.slug}`;

watch(open, async (v) => {
  if (v) { q.value = ''; index.value = 0; dlg.value?.showModal(); await nextTick(); input.value?.focus(); }
  else if (dlg.value?.open) dlg.value.close();
});

const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
type Item = { key: string; label: string; hint?: string; kind: 'channel' | 'person' | 'search'; icon?: unknown; name?: string; presence?: 'active' | 'away'; run: () => void };
const items = computed<Item[]>(() => {
  const f = fold(q.value.trim());
  const channels = chat.channels.filter((c) => c.kind !== 'dm' && c.kind !== 'group_dm' && fold(chat.channelTitle(c)).includes(f))
    .slice(0, 6).map((c): Item => ({
      key: c.id, label: c.kind === 'announcement' ? t('chat.announcements') : chat.channelTitle(c), hint: c.topic ?? undefined, kind: 'channel',
      icon: c.kind === 'announcement' ? Megaphone : c.kind === 'private' ? Lock : Hash,
      run: () => router.push(`${base()}/c/${c.id}`),
    }));
  const people = chat.members.filter((m) => m.isActive && m.userId !== s.user!.id && fold(m.name).includes(f)).slice(0, 6).map((m): Item => ({
    key: m.userId, label: m.name, hint: m.title ?? undefined, kind: 'person', name: m.name, presence: m.presence,
    run: async () => router.push(`${base()}/c/${(await chat.openDm([m.userId])).id}`),
  }));
  const search: Item[] = f.length >= 2 ? [{ key: 'search', label: t('chat.searchIn', { q: q.value.trim() }), kind: 'search', run: () => router.push({ path: `${base()}/search`, query: { q: q.value.trim() } }) }] : [];
  return [...channels, ...people, ...search];
});
watch(q, () => { index.value = 0; });

function pick(i: number) {
  const it = items.value[i];
  if (!it) return;
  open.value = false;
  it.run();
}
function onKey(e: KeyboardEvent) {
  const n = items.value.length;
  if (e.key === 'ArrowDown') { index.value = (index.value + 1) % n; e.preventDefault(); }
  else if (e.key === 'ArrowUp') { index.value = (index.value - 1 + n) % n; e.preventDefault(); }
  else if (e.key === 'Enter') { pick(index.value); e.preventDefault(); }
}
</script>

<template>
  <dialog ref="dlg" class="qs" @close="open = false" @click.self="open = false">
    <div class="box">
      <label class="field"><Search :size="18" /><input ref="input" v-model="q" :placeholder="t('chat.switcher')" :aria-label="t('chat.switcher')" @keydown="onKey"><Kbd>Esc</Kbd></label>
      <ul role="listbox">
        <li v-for="(it, i) in items" :key="it.key" role="option" :aria-selected="i === index" :class="{ on: i === index }" @mousedown.prevent="pick(i)" @mousemove="index = i">
          <Avatar v-if="it.kind === 'person'" :name="it.name!" :size="24" :presence="it.presence" />
          <component :is="it.icon" v-else-if="it.icon" :size="17" />
          <Search v-else :size="17" />
          <b>{{ it.label }}</b><small v-if="it.hint">{{ it.hint }}</small>
          <CornerDownLeft v-if="i === index" :size="15" class="enter" />
        </li>
      </ul>
    </div>
  </dialog>
</template>

<style scoped>
/* Centrado horizontal, en el tercio superior (como los buscadores de comandos) */
.qs { margin: 14vh auto auto; width: min(560px, calc(100vw - 32px)); padding: 0; border: 0; background: var(--color-surface); box-shadow: var(--shadow-lg), 0 0 0 1px var(--color-line); }
.qs::backdrop { background: rgb(19 36 61 / .42); backdrop-filter: blur(3px); }
.qs[open] { animation: pop 200ms cubic-bezier(.2, .8, .2, 1); }
@keyframes pop { from { opacity: 0; transform: translateY(-8px) scale(.98); } }
.field { display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 2px solid var(--color-primary); color: var(--color-muted); }
input { flex: 1; min-height: 54px; font: inherit; font-size: 17px; color: var(--color-ink); border: 0; outline: none; background: transparent; }
ul { margin: 0; padding: 6px 0; list-style: none; max-height: 380px; overflow: auto; }
li { display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 0 14px; cursor: pointer; }
li.on { background: var(--color-ink); color: #fff; }
small { color: var(--color-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
li.on small { color: var(--color-sidebar-text); }
.enter { margin-left: auto; }
@media (max-width: 767px) { .qs { margin: calc(12px + env(safe-area-inset-top, 0px)) auto auto; } }
</style>
