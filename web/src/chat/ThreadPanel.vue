<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { X, ArrowLeft } from 'lucide-vue-next';
import type { Channel } from '@agencia-hub/contracts';
import { useChat } from './store.ts';
import MessageItem from './MessageItem.vue';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import TypingLine from './TypingLine.vue';

const props = defineProps<{ rootId: string; channel: Channel; canWrite: boolean }>();
const emit = defineEmits<{ close: []; acks: [id: string]; image: [url: string, name: string] }>();
const { t } = useI18n();
const chat = useChat();

const root = computed(() => chat.findMessage(props.rootId));
watch(() => props.rootId, async (id) => {
  if (!chat.findMessage(id)) {
    // Abierto desde un enlace o notificación: trae el mensaje raíz con su contexto
    await chat.loadChannel(props.channel.id, id);
  }
  chat.loadThread(id);
}, { immediate: true });
const title = computed(() => props.channel.name ? `#${props.channel.name}` : chat.channelTitle(props.channel));
</script>

<template>
  <aside class="thread">
    <header>
      <button type="button" class="back" :aria-label="t('common.back')" @click="emit('close')"><ArrowLeft :size="20" /></button>
      <div class="ttl"><h2>{{ t('chat.thread') }}</h2><small>{{ title }}</small></div>
      <button type="button" class="x" :aria-label="t('common.close')" @click="emit('close')"><X :size="18" /></button>
    </header>
    <div class="root">
      <MessageItem v-if="root" :m="root" in-thread :channel="channel" :can-write="canWrite" @acks="emit('acks', $event)" @image="(u, n) => emit('image', u, n)" />
      <div v-if="root?.replyCount" class="sep">{{ t('chat.replies', { n: root.replyCount }, root.replyCount) }}</div>
    </div>
    <MessageList :list-key="`t:${rootId}`" :channel="channel" :can-write="canWrite" in-thread @acks="emit('acks', $event)" @image="(u, n) => emit('image', u, n)" />
    <TypingLine :list-key="`t:${rootId}`" />
    <Composer v-if="canWrite" :key="rootId" :channel="channel" :parent-id="rootId" :placeholder="t('chat.replyPlaceholder')" />
  </aside>
</template>

<style scoped>
/* El panel se apoya sobre el canal: sombra hacia la izquierda */
.thread { display: flex; flex-direction: column; min-height: 0; background: var(--color-surface); border-left: 1px solid var(--color-line); box-shadow: -10px 0 28px rgb(19 36 61 / .10); position: relative; z-index: 3; }
header { display: flex; align-items: center; gap: 8px; min-height: 58px; padding: 0 10px 0 20px; border-bottom: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.ttl { flex: 1; min-width: 0; }
h2 { margin: 0; font-size: 17px; }
small { color: var(--color-muted); font-size: 12px; }
.x, .back { width: var(--tap); height: var(--tap); display: grid; place-items: center; background: none; border: 0; cursor: pointer; color: inherit; }
.x:hover { background: var(--color-canvas); }
.back { display: none; }
.root { padding-top: 10px; max-height: 45%; overflow: auto; }
.sep { display: flex; align-items: center; gap: 10px; padding: 4px 20px; font-size: 12px; color: var(--color-muted); }
.sep::after { content: ''; flex: 1; height: 1px; background: var(--color-line); }
.thread :deep(.inner) { justify-content: flex-start; }
@media (max-width: 1023px) {
  .thread { position: fixed; inset: 0; z-index: 40; padding-top: env(safe-area-inset-top, 0px); box-shadow: none; }
  .back { display: grid; margin-left: -12px; }
  .x { display: none; }
}
</style>
