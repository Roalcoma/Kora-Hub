<script setup lang="ts">
// Pestañas móviles "Mensajes" (lista de DMs) y "Menciones". En escritorio también son accesibles por URL.
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { AtSign, MessageCircle, Hash, Plus } from 'lucide-vue-next';
import type { Message } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import Avatar from '@/design/Avatar.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { useChat } from './store.ts';
import { renderBody } from './format.ts';
import ChannelDialogs from './ChannelDialogs.vue';

const { t, d } = useI18n();
const route = useRoute();
const s = useSession();
const chat = useChat();
const base = computed(() => `/w/${s.workspace!.slug}`);
const mode = computed(() => (route.path.endsWith('/mentions') ? 'mentions' : 'dms'));
const dialog = ref<'channel' | 'dm' | null>(null);

const dms = computed(() => chat.channels.filter((c) => (c.kind === 'dm' || c.kind === 'group_dm') && c.isMember)
  .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')));
const peer = (ids: string[] | undefined) => chat.memberById.get((ids ?? []).find((id) => id !== s.user!.id) ?? s.user!.id);

const mentions = ref<Message[] | null>(null);
onMounted(async () => {
  if (mode.value === 'mentions') mentions.value = (await api('GET /w/:slug/mentions', { params: { slug: s.workspace!.slug } })).items.reverse();
});
const html = (b: string) => renderBody(b, (id) => chat.memberById.get(id)?.name, s.user!.id);
</script>

<template>
  <div class="inbox">
    <header class="top">
      <h1>{{ mode === 'dms' ? t('chat.dmsTitle') : t('chat.mentionsTitle') }}</h1>
      <button v-if="mode === 'dms'" type="button" class="new" :aria-label="t('chat.newMessage')" @click="dialog = 'dm'"><Plus :size="20" /></button>
    </header>

    <div v-if="mode === 'dms'" class="items">
      <EmptyState v-if="!dms.length" :icon="MessageCircle" :title="t('chat.dmsTitle')" :text="t('chat.noDms')" />
      <RouterLink v-for="c in dms" :key="c.id" :to="`${base}/c/${c.id}`" class="row" :class="{ unread: c.unreadCount }">
        <Avatar :name="peer(c.memberIds)?.name ?? '?'" :size="40" :presence="peer(c.memberIds)?.presence" />
        <span class="txt"><b>{{ chat.channelTitle(c) }}</b><small v-if="c.lastMessageAt">{{ d(c.lastMessageAt, 'short') }}</small></span>
        <span v-if="c.unreadCount" class="badge">{{ c.unreadCount }}</span>
      </RouterLink>
    </div>

    <div v-else class="items">
      <div v-if="!mentions" class="grid gap-3 p-4"><Skeleton v-for="n in 4" :key="n" height="64px" /></div>
      <EmptyState v-else-if="!mentions.length" :icon="AtSign" :title="t('chat.mentionsTitle')" :text="t('chat.noMentions')" />
      <RouterLink v-for="m in mentions ?? []" :key="m.id" :to="`${base}/c/${m.channelId}${m.parentId ? `/t/${m.parentId}` : ''}?m=${m.id}`" class="row mention">
        <Avatar :name="chat.nameOf(m.userId)" :size="36" />
        <span class="txt">
          <span class="meta"><b>{{ chat.nameOf(m.userId) }}</b><span><Hash :size="12" />{{ chat.channelById(m.channelId) ? chat.channelTitle(chat.channelById(m.channelId)!) : '' }}</span><time>{{ d(m.createdAt, 'short') }}</time></span>
          <!-- eslint-disable-next-line vue/no-v-html -- renderBody escapa el texto -->
          <span class="body" v-html="html(m.body)" />
        </span>
      </RouterLink>
    </div>
    <ChannelDialogs v-model="dialog" />
  </div>
</template>

<style scoped>
.inbox { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.top { display: flex; align-items: center; justify-content: space-between; min-height: 56px; padding: 0 10px 0 20px; background: var(--color-surface); box-shadow: var(--shadow-md); position: relative; z-index: 2; }
h1 { margin: 0; font-size: 21px; }
.new { width: var(--tap); height: var(--tap); display: grid; place-items: center; color: var(--color-ink); background: var(--color-primary); border: 0; box-shadow: var(--shadow-md); cursor: pointer; }
.items { flex: 1; overflow: auto; padding: 10px 12px 20px 10px; display: grid; gap: 6px; align-content: start; }
.row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; color: inherit; text-decoration: none; background: var(--color-surface); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration); }
.row:hover { box-shadow: var(--shadow-md); transform: translateX(2px); }
.row.unread { box-shadow: var(--shadow-sm), inset 3px 0 0 var(--color-primary); }
.row.unread b { font-weight: 700; }
.row.mention { align-items: flex-start; }
.txt { flex: 1; min-width: 0; display: grid; gap: 2px; }
.txt b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.txt small, .meta time { color: var(--color-muted); font-size: 12px; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: 13px; }
.meta > span { display: inline-flex; align-items: center; gap: 2px; color: var(--color-muted); }
.body { line-height: 1.45; overflow-wrap: anywhere; }
.body :deep(.mention) { padding: 0 3px; background: var(--color-primary); color: var(--color-ink); font-weight: 500; }
.badge { min-width: 22px; padding: 0 6px; font-size: 12px; font-weight: 700; line-height: 20px; text-align: center; color: var(--color-ink); background: var(--color-primary); box-shadow: var(--shadow-sm); }
</style>
