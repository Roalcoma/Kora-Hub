<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Hash, Lock, Megaphone, Star, Bell, BellOff, Pin, Users, ChevronLeft, EllipsisVertical, LogOut, Upload } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import Avatar from '@/design/Avatar.vue';
import Button from '@/design/Button.vue';
import Modal from '@/design/Modal.vue';
import ContextMenu from '@/design/ContextMenu.vue';
import { toast } from '@/design/toast.ts';
import { useChat } from './store.ts';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import ThreadPanel from './ThreadPanel.vue';
import TypingLine from './TypingLine.vue';
import ChannelPanels from './ChannelPanels.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const chat = useChat();

const channelId = computed(() => route.params.id as string);
const threadId = computed(() => (route.params.threadId as string | undefined) ?? null);
const jumpTo = computed(() => (route.query.m as string | undefined) ?? null);
const channel = computed(() => chat.channelById(channelId.value));
const base = computed(() => `/w/${s.workspace!.slug}`);

// La línea "Nuevos mensajes" se fija al abrir el canal (no se mueve mientras lo lees)
const newSince = ref<string | null>(null);
watch([channelId, () => chat.ready], async ([id, ready]) => {
  if (!ready) return;
  const c = chat.channelById(id);
  if (!c) {
    // No está en mi lista (p. ej. enlace a un canal público): intenta cargarlo
    try { await chat.loadChannel(id, jumpTo.value ?? undefined); } catch { router.replace(base.value); }
    return;
  }
  newSince.value = c.unreadCount ? c.lastReadAt : null;
  chat.activeChannelId = id;
  try { localStorage.setItem(`last-channel:${s.workspace!.slug}`, id); } catch { /* idem */ }
  await chat.loadChannel(id, jumpTo.value ?? undefined);
}, { immediate: true });
onBeforeUnmount(() => { chat.activeChannelId = null; });

const isDm = computed(() => channel.value?.kind === 'dm' || channel.value?.kind === 'group_dm');
const dmPeer = computed(() => isDm.value ? chat.memberById.get((channel.value!.memberIds ?? []).find((id) => id !== s.user!.id) ?? '') : undefined);
const title = computed(() => channel.value ? chat.channelTitle(channel.value) : '');
const icon = computed(() => channel.value?.kind === 'announcement' ? Megaphone : channel.value?.kind === 'private' ? Lock : Hash);
const isLead = computed(() => ['owner', 'admin', 'lead'].includes(s.workspace!.me.role));
const canWrite = computed(() => !!channel.value?.isMember && !channel.value.archivedAt && (channel.value.kind !== 'announcement' || isLead.value));
const placeholder = computed(() => channel.value?.kind === 'announcement' ? t('chat.announcePlaceholder')
  : t('chat.messageTo', { name: isDm.value ? title.value : `#${title.value}` }));

const panel = ref<'acks' | 'pins' | 'members' | null>(null);
const ackMessageId = ref<string | null>(null);
const openAcks = (id: string) => { ackMessageId.value = id; panel.value = 'acks'; };
const image = ref<{ url: string; name: string } | null>(null);
const imageOpen = computed({ get: () => !!image.value, set: (v) => { if (!v) image.value = null; } });

const openThread = (id: string) => router.push(`${base.value}/c/${channelId.value}/t/${id}`);
const closeThread = () => router.push(`${base.value}/c/${channelId.value}`);
const jump = (id: string) => router.replace({ query: { m: id } });

const run = (p: Promise<unknown>) => p.catch((e) => toast(e.message, 'error'));
const menu = ref(false);
const menuPos = ref({ x: 0, y: 0 });
function openMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = { x: r.right - 220, y: r.bottom + 4 };
  menu.value = true;
}
const menuItems = computed(() => {
  const c = channel.value!;
  const level = c.notifLevel;
  return [
    { label: `${level === 'all' ? '● ' : ''}${t('chat.notifAll')}`, icon: Bell, action: () => run(chat.prefs(c.id, { notifLevel: 'all' })) },
    { label: `${level === 'mentions' || !level ? '● ' : ''}${t('chat.notifMentions')}`, icon: Bell, action: () => run(chat.prefs(c.id, { notifLevel: 'mentions' })) },
    { label: c.muted ? t('chat.unmute') : t('chat.mute'), icon: BellOff, action: () => run(chat.prefs(c.id, { muted: !c.muted })) },
    ...(c.kind === 'public' || c.kind === 'private' ? [{ label: t('chat.leave'), icon: LogOut, danger: true, action: () => run(chat.leave(c.id).then(() => router.push(base.value))) }] : []),
  ];
});

// Arrastrar archivos sobre cualquier parte del canal
const composer = ref<InstanceType<typeof Composer>>();
const dragging = ref(false);
let dragDepth = 0;
const onDragEnter = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files') && canWrite.value) { dragDepth++; dragging.value = true; } };
const onDragLeave = () => { if (--dragDepth <= 0) { dragDepth = 0; dragging.value = false; } };
function onDrop(e: DragEvent) {
  dragDepth = 0;
  dragging.value = false;
  if (e.dataTransfer?.files.length) composer.value?.addFiles(e.dataTransfer.files);
}
</script>

<template>
  <div v-if="channel" class="page" :class="{ 'with-thread': threadId }">
    <section class="channel" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
      <header class="top">
        <button type="button" class="back" :aria-label="t('common.back')" @click="router.push(base)"><ChevronLeft :size="22" /></button>
        <div class="ttl">
          <h1>
            <Avatar v-if="dmPeer" :name="dmPeer.name" :size="26" :presence="dmPeer.presence" />
            <component :is="icon" v-else :size="19" />
            <span>{{ title }}</span>
            <button type="button" class="star" :class="{ on: channel.starred }" :aria-label="channel.starred ? t('chat.unstar') : t('chat.star')"
              @click="run(chat.prefs(channel.id, { starred: !channel.starred }))"><Star :size="16" /></button>
          </h1>
          <p v-if="channel.topic || dmPeer?.title" class="topic">{{ channel.topic || dmPeer?.title }}</p>
        </div>
        <div class="actions">
          <BellOff v-if="channel.muted" :size="16" class="muted-ico" :aria-label="t('chat.muted')" />
          <button v-if="!isDm" type="button" class="act" :aria-label="t('chat.members')" @click="panel = 'members'"><Users :size="18" /></button>
          <button type="button" class="act" :aria-label="t('chat.pins')" @click="panel = 'pins'"><Pin :size="18" /></button>
          <button v-if="channel.isMember" type="button" class="act" :aria-label="t('chat.more')" @click="openMenu"><EllipsisVertical :size="18" /></button>
        </div>
      </header>

      <div v-if="!chat.connected && chat.ready" class="offline">{{ t('chat.connecting') }}</div>
      <MessageList :list-key="`c:${channel.id}`" :channel="channel" :can-write="canWrite" :new-since="newSince" :jump-to="jumpTo"
        @thread="openThread" @acks="openAcks" @image="(url, name) => (image = { url, name })" />
      <TypingLine :list-key="`c:${channel.id}`" />

      <Composer v-if="canWrite" ref="composer" :key="channel.id" :channel="channel" :placeholder="placeholder" />
      <div v-else-if="!channel.isMember && channel.kind === 'public'" class="bar">
        <span>{{ t('chat.joinHint', { name: channel.name }) }}</span>
        <Button variant="primary" @click="run(chat.join(channel.id))">{{ t('chat.join') }}</Button>
      </div>
      <div v-else-if="channel.archivedAt" class="bar">{{ t('chat.archived') }}</div>
      <div v-else-if="channel.kind === 'announcement'" class="bar"><Megaphone :size="16" />{{ t('chat.onlyLeadsPost') }}</div>

      <div v-if="dragging" class="drop"><Upload :size="30" /><b>{{ t('chat.dropFiles') }}</b></div>
    </section>

    <ThreadPanel v-if="threadId" :root-id="threadId" :channel="channel" :can-write="canWrite"
      @close="closeThread" @acks="openAcks" @image="(url, name) => (image = { url, name })" />

    <ChannelPanels v-model="panel" :channel="channel" :ack-message-id="ackMessageId" :can-write="canWrite" @jump="jump" />
    <ContextMenu v-model="menu" :items="menuItems" :x="menuPos.x" :y="menuPos.y" />
    <Modal v-model="imageOpen" :title="image?.name ?? ''" width="min(1100px, 96vw)">
      <img v-if="image" :src="image.url" :alt="image.name" class="viewer">
      <template #footer><a v-if="image" class="dl-link" :href="`${image.url}?download`" :download="image.name">{{ t('chat.download') }}</a></template>
    </Modal>
  </div>
</template>

<style scoped>
.page { height: 100%; display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
.page.with-thread { grid-template-columns: minmax(0, 1fr) 400px; }
.channel { position: relative; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
/* Encabezado elevado sobre el lienzo, con el título desplazado y las acciones agrupadas a la derecha */
.top { position: relative; z-index: 4; display: flex; align-items: center; gap: 10px; min-height: 58px; padding: 6px 14px 6px 22px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.back { display: none; width: var(--tap); height: var(--tap); place-items: center; margin-left: -14px; background: none; border: 0; color: inherit; cursor: pointer; }
.ttl { flex: 1; min-width: 0; }
h1 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
h1 span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topic { margin: 1px 0 0; font-size: 13px; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.star { width: 28px; height: 28px; display: grid; place-items: center; color: var(--color-line-strong); background: none; border: 0; cursor: pointer; }
.star:hover { color: var(--color-muted); }
.star.on { color: var(--color-primary); }
.star.on :deep(svg) { fill: currentColor; }
.actions { display: flex; align-items: center; gap: 2px; }
.act { width: 38px; height: 38px; display: grid; place-items: center; color: var(--color-ink); background: none; border: 1px solid transparent; cursor: pointer; transition: background var(--duration), box-shadow var(--duration), border-color var(--duration); }
.act:hover { background: var(--color-surface); border-color: var(--color-line); box-shadow: var(--shadow-sm); }
.muted-ico { color: var(--color-muted); margin-right: 4px; }
.offline { padding: 6px 22px; font-size: 13px; font-weight: 500; color: var(--color-warning); background: var(--color-warning-light); box-shadow: var(--shadow-sm); }
.bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 20px 16px 16px; padding: 14px 16px; background: var(--color-surface); border-left: 4px solid var(--color-primary); box-shadow: var(--shadow-md); color: var(--color-muted); }
.bar span { flex: 1; }
.drop { position: absolute; inset: 70px 16px 16px; z-index: 20; display: grid; place-content: center; justify-items: center; gap: 10px; background: rgb(254 243 199 / .92); border: 2px dashed var(--color-primary); box-shadow: var(--shadow-lg); pointer-events: none; color: #8A4B00; }
.dl-link { display: inline-flex; align-items: center; min-height: 38px; padding: 0 14px; font-weight: 700; font-size: 14px; color: var(--color-ink); text-decoration: none; border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.dl-link:hover { border-color: var(--color-ink); box-shadow: var(--shadow-md); }
.viewer { display: block; max-width: 100%; max-height: 75vh; margin: 0 auto; box-shadow: var(--shadow-md); }
@media (max-width: 1023px) { .page.with-thread { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 767px) {
  .back { display: grid; }
  .top { padding-left: 14px; min-height: 54px; }
  h1 { font-size: 17px; }
  .bar { margin: 0 8px calc(8px + env(safe-area-inset-bottom, 0px)); }
}
</style>
