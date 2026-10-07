<script setup lang="ts">
// Diálogos del sidebar: crear/explorar canales y abrir un mensaje directo.
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Hash, Lock, X } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import Modal from '@/design/Modal.vue';
import Tabs from '@/design/Tabs.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import Avatar from '@/design/Avatar.vue';
import EmptyState from '@/design/EmptyState.vue';
import { errorText } from '@/platform/errors.ts';
import { useChat } from './store.ts';

const dialog = defineModel<'channel' | 'dm' | null>({ default: null });
const { t } = useI18n();
const router = useRouter();
const s = useSession();
const chat = useChat();
const go = (id: string) => { dialog.value = null; router.push(`/w/${s.workspace!.slug}/c/${id}`); };

// ─── Canal ───
const channelOpen = computed({ get: () => dialog.value === 'channel', set: (v) => { if (!v) dialog.value = null; } });
const tab = ref<'create' | 'browse'>('create');
const f = reactive({ name: '', topic: '', private: false });
const error = ref<string | null>(null);
const busy = ref(false);
watch(channelOpen, (v) => { if (v) { Object.assign(f, { name: '', topic: '', private: false }); error.value = null; tab.value = 'create'; } });
const browse = computed(() => chat.channels.filter((c) => c.kind === 'public' && !c.isMember));
async function create() {
  busy.value = true;
  error.value = null;
  try {
    const c = await chat.createChannel({ kind: f.private ? 'private' : 'public', name: f.name.trim().toLowerCase().replace(/\s+/g, '-'), topic: f.topic || undefined, memberIds: [] });
    go(c.id);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

// ─── DM ───
const dmOpen = computed({ get: () => dialog.value === 'dm', set: (v) => { if (!v) dialog.value = null; } });
const query = ref('');
const picked = ref<string[]>([]);
watch(dmOpen, (v) => { if (v) { query.value = ''; picked.value = []; } });
const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const people = computed(() => chat.members.filter((m) => m.isActive && m.userId !== s.user!.id && !picked.value.includes(m.userId) && fold(m.name).includes(fold(query.value))));
async function openDm() {
  busy.value = true;
  try {
    go((await chat.openDm(picked.value)).id);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-model="channelOpen" :title="t('chat.addChannel')" width="520px">
    <Tabs v-model="tab" :tabs="[{ value: 'create', label: t('chat.createChannel') }, { value: 'browse', label: t('chat.explore'), count: browse.length }]" />
    <form v-if="tab === 'create'" id="new-channel" class="grid gap-4" @submit.prevent="create">
      <Input v-model="f.name" :label="t('chat.channelName')" prefix="#" :hint="t('chat.channelNameHint')" :error="error" />
      <Input v-model="f.topic" :label="t('chat.topic')" />
      <label class="priv"><input v-model="f.private" type="checkbox"><Lock :size="16" /><span><b>{{ t('chat.private') }}</b><small>{{ t('chat.privateHint') }}</small></span></label>
    </form>
    <div v-else>
      <EmptyState v-if="!browse.length" :icon="Hash" :title="t('chat.explore')" :text="t('chat.noMoreChannels')" />
      <button v-for="c in browse" :key="c.id" type="button" class="row" @click="go(c.id)">
        <Hash :size="16" /><span><b>{{ c.name }}</b><small v-if="c.topic">{{ c.topic }}</small></span>
      </button>
    </div>
    <template v-if="tab === 'create'" #footer>
      <Button @click="dialog = null">{{ t('chat.cancel') }}</Button>
      <Button type="submit" form="new-channel" variant="primary" :loading="busy" :disabled="!f.name.trim()">{{ t('chat.create') }}</Button>
    </template>
  </Modal>

  <Modal v-model="dmOpen" :title="t('chat.newMessage')" width="480px">
    <div class="to">
      <span>{{ t('chat.to') }}</span>
      <span v-for="id in picked" :key="id" class="chip">{{ chat.nameOf(id) }}<button type="button" :aria-label="t('chat.discard')" @click="picked = picked.filter((x) => x !== id)"><X :size="13" /></button></span>
      <input v-model="query" :placeholder="t('chat.pickPeople')" :aria-label="t('chat.pickPeople')" autofocus>
    </div>
    <div class="people">
      <button v-for="m in people.slice(0, 8)" :key="m.userId" type="button" class="row" :disabled="picked.length >= 7" @click="picked.push(m.userId); query = ''">
        <Avatar :name="m.name" :size="30" :presence="m.presence" /><span><b>{{ m.name }}</b><small>{{ m.title ?? t(`roles.${m.role}`) }}</small></span>
      </button>
    </div>
    <p v-if="error" class="text-sm text-danger">{{ error }}</p>
    <template #footer>
      <Button @click="dialog = null">{{ t('chat.cancel') }}</Button>
      <Button variant="primary" :disabled="!picked.length" :loading="busy" @click="openDm">{{ t('chat.open') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.priv { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--color-line); cursor: pointer; }
.priv span { display: grid; }
.priv small { color: var(--color-muted); font-size: 12px; }
.row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 6px 10px; font: inherit; text-align: left; color: inherit; background: none; border: 0; border-bottom: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration), box-shadow var(--duration); }
.row:hover:not(:disabled) { background: var(--color-surface); box-shadow: var(--shadow-md); position: relative; }
.row span { display: grid; min-width: 0; }
.row small { color: var(--color-muted); font-size: 12px; }
.to { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .2); }
.to > span:first-child { font-size: 13px; color: var(--color-muted); }
.to input { flex: 1; min-width: 140px; min-height: 32px; font: inherit; border: 0; outline: none; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; font-size: 13px; background: var(--color-primary-light); box-shadow: var(--shadow-sm); }
.chip button { display: grid; place-items: center; width: 20px; height: 20px; background: none; border: 0; cursor: pointer; }
.people { max-height: 340px; overflow: auto; }
</style>
