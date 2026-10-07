<script setup lang="ts">
// Paneles laterales del canal: confirmaciones de un anuncio, mensajes fijados y miembros.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { UserPlus } from 'lucide-vue-next';
import type { AckStatus, Channel, Message } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import SlideOver from '@/design/SlideOver.vue';
import Tabs from '@/design/Tabs.vue';
import Avatar from '@/design/Avatar.vue';
import Button from '@/design/Button.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { useChat } from './store.ts';
import MessageItem from './MessageItem.vue';

const panel = defineModel<'acks' | 'pins' | 'members' | null>({ default: null });
const props = defineProps<{ channel: Channel; ackMessageId?: string | null; canWrite: boolean }>();
const emit = defineEmits<{ jump: [id: string] }>();
const { t, d } = useI18n();
const s = useSession();
const chat = useChat();
const slug = () => s.workspace!.slug;

const open = (p: typeof panel.value) => computed({ get: () => panel.value === p, set: (v) => { if (!v) panel.value = null; } });
const acksOpen = open('acks');
const pinsOpen = open('pins');
const membersOpen = open('members');

// ─── Confirmaciones ───
const acks = ref<AckStatus | null>(null);
const ackTab = ref<'pending' | 'done'>('pending');
watch(() => [panel.value, props.ackMessageId], async () => {
  if (panel.value === 'acks' && props.ackMessageId) {
    acks.value = null;
    acks.value = await api('GET /w/:slug/messages/:id/acks', { params: { slug: slug(), id: props.ackMessageId } });
  }
});

// ─── Fijados ───
const pins = ref<Message[] | null>(null);
watch(panel, async (p) => {
  if (p === 'pins') { pins.value = null; pins.value = await api('GET /w/:slug/channels/:id/pins', { params: { slug: slug(), id: props.channel.id } }); }
});

// ─── Miembros ───
const memberIds = ref<string[]>([]);
const filter = ref('');
const loadMembers = async () => { memberIds.value = await api('GET /w/:slug/channels/:id/members', { params: { slug: slug(), id: props.channel.id } }); };
watch(panel, (p) => { if (p === 'members') { filter.value = ''; loadMembers(); } });
const match = (name: string) => name.toLowerCase().includes(filter.value.toLowerCase());
const inChannel = computed(() => chat.members.filter((m) => memberIds.value.includes(m.userId) && match(m.name)));
const outside = computed(() => props.canWrite && props.channel.kind === 'private'
  ? chat.members.filter((m) => m.isActive && !memberIds.value.includes(m.userId) && match(m.name)) : []);
async function add(userId: string) {
  try {
    await api('POST /w/:slug/channels/:id/members', { params: { slug: slug(), id: props.channel.id }, body: { userIds: [userId] } });
    await loadMembers();
  } catch (e: any) { toast(e.message, 'error'); }
}
</script>

<template>
  <SlideOver v-model="acksOpen" :title="t('chat.acks')">
    <div v-if="!acks" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="40px" /></div>
    <template v-else>
      <Tabs v-model="ackTab" :tabs="[{ value: 'pending', label: t('chat.acksPending'), count: acks.pending.length }, { value: 'done', label: t('chat.acksDone'), count: acks.acked.length }]" />
      <ul class="people">
        <li v-for="id in (ackTab === 'pending' ? acks.pending : acks.acked.map((a) => a.userId))" :key="id">
          <Avatar :name="chat.nameOf(id)" :size="32" :presence="chat.memberById.get(id)?.presence" />
          <b>{{ chat.nameOf(id) }}</b>
          <small v-if="ackTab === 'done'">{{ d(acks.acked.find((a) => a.userId === id)!.ackedAt, 'short') }}</small>
        </li>
      </ul>
    </template>
  </SlideOver>

  <SlideOver v-model="pinsOpen" :title="t('chat.pins')" :subtitle="channel.name ? `#${channel.name}` : ''">
    <div v-if="!pins" class="grid gap-3"><Skeleton v-for="n in 3" :key="n" height="60px" /></div>
    <EmptyState v-else-if="!pins.length" :title="t('chat.pins')" :text="t('chat.noPins')" />
    <div v-else class="pins">
      <button v-for="m in pins" :key="m.id" type="button" class="pin" @click="emit('jump', m.id); panel = null">
        <MessageItem :m="m" :channel="channel" :can-write="false" in-thread />
      </button>
    </div>
  </SlideOver>

  <SlideOver v-model="membersOpen" :title="t('chat.members')" :subtitle="channel.name ? `#${channel.name}` : ''">
    <input v-model="filter" class="filter" :placeholder="t('chat.pickPeople')" :aria-label="t('chat.pickPeople')">
    <ul class="people">
      <li v-for="m in inChannel" :key="m.userId">
        <Avatar :name="m.name" :size="32" :presence="m.presence" />
        <span class="who"><b>{{ m.name }}</b><small>{{ m.title ?? t(`roles.${m.role}`) }}</small></span>
      </li>
    </ul>
    <template v-if="outside.length">
      <h3 class="add-h">{{ t('chat.addPeople') }}</h3>
      <ul class="people">
        <li v-for="m in outside" :key="m.userId">
          <Avatar :name="m.name" :size="32" />
          <span class="who"><b>{{ m.name }}</b><small>{{ m.title ?? t(`roles.${m.role}`) }}</small></span>
          <Button size="sm" @click="add(m.userId)"><UserPlus :size="15" />{{ t('common.add') }}</Button>
        </li>
      </ul>
    </template>
  </SlideOver>
</template>

<style scoped>
.people { margin: 8px 0 0; padding: 0; list-style: none; }
.people li { display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-bottom: 1px solid var(--color-line); }
.people small { margin-left: auto; color: var(--color-muted); font-size: 12px; }
.who { display: grid; flex: 1; min-width: 0; }
.who small { margin: 0; }
.pins { display: grid; gap: 10px; }
.pin { display: block; width: 100%; padding: 6px 0; text-align: left; font: inherit; color: inherit; background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.pin:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.pin :deep(.toolbar) { display: none !important; }
.add-h { margin: 20px 0 0; font-size: 14px; }
.filter { width: 100%; min-height: 40px; padding: 0 12px; font: inherit; border: 1px solid var(--color-line-strong); outline: none; }
.filter:focus { border-color: var(--color-ink); }
</style>
