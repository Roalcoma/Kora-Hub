<script setup lang="ts">
import { computed, nextTick, onBeforeUpdate, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Hash, Megaphone, Lock } from 'lucide-vue-next';
import type { Channel } from '@agencia-hub/contracts';
import { useSession } from '@/stores/session.ts';
import Skeleton from '@/design/Skeleton.vue';
import { useChat, type UiMessage } from './store.ts';
import { sameDay } from './format.ts';
import MessageItem from './MessageItem.vue';

const props = defineProps<{ listKey: string; channel: Channel; canWrite: boolean; newSince?: string | null; jumpTo?: string | null; inThread?: boolean }>();
const emit = defineEmits<{ thread: [id: string]; acks: [id: string]; image: [url: string, name: string] }>();
const { t, locale } = useI18n();
const s = useSession();
const chat = useChat();
const scroller = ref<HTMLDivElement>();

const list = computed(() => chat.lists[props.listKey]);
const items = computed<UiMessage[]>(() => list.value?.items ?? []);
const firstNew = computed(() => props.newSince
  ? items.value.find((m) => m.createdAt > props.newSince! && m.userId !== s.user!.id && !m.status)?.id : undefined);

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return t('chat.today');
  if (d.toDateString() === yesterday.toDateString()) return t('chat.yesterday');
  return new Intl.DateTimeFormat(locale.value, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

/** Filas con divisores y agrupación: mismo autor, menos de 5 minutos, mismo día, sin cortes en medio */
const rows = computed(() => items.value.map((m, i) => {
  const prev = items.value[i - 1];
  const day = !prev || !sameDay(prev.createdAt, m.createdAt);
  const isNew = m.id === firstNew.value;
  const compact = !!prev && !day && !isNew && prev.userId === m.userId && !prev.deletedAt && !m.ackRequired && !prev.ackRequired
    && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
  return { m, day, isNew, compact };
}));

// ─── Scroll ───
let stick = true;
const nearBottom = () => { const el = scroller.value!; return el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
onBeforeUpdate(() => { if (scroller.value) stick = nearBottom(); });
const toBottom = () => { const el = scroller.value; if (el) el.scrollTop = el.scrollHeight; };

async function place() {
  await nextTick();
  const el = scroller.value;
  if (!el) return;
  const target = (props.jumpTo && el.querySelector(`[data-id="${props.jumpTo}"]`)) || el.querySelector('.newline');
  if (target) {
    target.scrollIntoView({ block: 'center' });
    if (props.jumpTo) target.classList.add('flash');
  } else toBottom();
}
onMounted(place);
watch(() => list.value?.loaded, (v) => v && place());
watch(() => props.jumpTo, place);
watch(() => items.value.length, async () => {
  await nextTick();
  if (stick) toBottom();
  if (!props.inThread && nearBottom()) chat.markRead(props.channel.id);
});

async function onScroll() {
  const el = scroller.value!;
  stick = nearBottom();
  if (!props.inThread && nearBottom()) chat.markRead(props.channel.id);
  if (el.scrollTop < 300 && props.listKey.startsWith('c:')) {
    const before = el.scrollHeight;
    if (await chat.loadOlder(props.channel.id)) {
      await nextTick();
      el.scrollTop += el.scrollHeight - before;   // mantiene la vista donde estaba
    }
  }
}
defineExpose({ toBottom });
const intro = computed(() => props.channel.kind === 'announcement' ? Megaphone : props.channel.kind === 'private' ? Lock : Hash);
</script>

<template>
  <!-- Las imágenes cambian la altura al cargar: si estabas al final, sigues al final -->
  <div ref="scroller" class="scroller" @scroll.passive="onScroll" @load.capture="stick && toBottom()">
    <div class="inner">
      <div v-if="!list?.loaded" class="loading">
        <div v-for="n in 5" :key="n" class="sk"><Skeleton width="38px" height="38px" /><div class="grid gap-2 flex-1"><Skeleton width="30%" /><Skeleton :width="`${50 + n * 8}%`" /></div></div>
      </div>
      <template v-else>
        <div v-if="!list.nextCursor && !inThread" class="intro">
          <span class="intro-ico"><component :is="intro" :size="26" /></span>
          <div>
            <h3>{{ t('chat.emptyChannel', { name: channel.kind === 'dm' || channel.kind === 'group_dm' ? chat.channelTitle(channel) : `#${channel.name}` }) }}</h3>
            <p>{{ channel.topic || t('chat.emptyChannelHint') }}</p>
          </div>
        </div>
        <template v-for="r in rows" :key="r.m.id">
          <div v-if="r.day && !inThread" class="day"><span>{{ dayLabel(r.m.createdAt) }}</span></div>
          <div v-if="r.isNew" class="newline"><span>{{ t('chat.newMessages') }}</span></div>
          <MessageItem :m="r.m" :compact="r.compact" :in-thread="inThread" :channel="channel" :can-write="canWrite"
            @thread="emit('thread', $event)" @acks="emit('acks', $event)" @image="(u, n) => emit('image', u, n)" />
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.inner { min-height: 100%; display: flex; flex-direction: column; justify-content: flex-end; padding: 8px 0 10px; }
.loading { display: grid; gap: 18px; padding: 16px 24px; }
.sk { display: flex; gap: 12px; }
/* Intro del canal: alineada a la izquierda con acento lateral, no centrada */
.intro { display: flex; gap: 16px; align-items: flex-start; margin: 24px 24px 18px 18px; padding: 18px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); border-left: 4px solid var(--color-primary); max-width: 560px; }
.intro-ico { width: 52px; height: 52px; display: grid; place-items: center; flex: none; background: var(--color-ink); color: var(--color-cta); box-shadow: var(--shadow-sm); }
.intro h3 { margin: 2px 0 4px; font-size: 19px; }
.intro p { margin: 0; color: var(--color-muted); line-height: 1.5; }
/* Divisor de día: píldora que flota con sombra sobre la línea */
.day { position: sticky; top: 6px; z-index: 2; display: flex; align-items: center; margin: 10px 0 4px; padding-left: 74px; pointer-events: none; }
.day::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: var(--color-line); z-index: -1; }
.day span { padding: 3px 12px; font-size: 12px; font-weight: 700; text-transform: capitalize; background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.newline { display: flex; align-items: center; gap: 10px; margin: 6px 0; padding-right: 24px; }
.newline::before { content: ''; flex: 1; height: 2px; background: var(--color-danger); order: 2; }
.newline span { padding: 2px 10px 2px 18px; font-size: 12px; font-weight: 700; color: #fff; background: var(--color-danger); box-shadow: var(--shadow-sm); }
.inner :deep(.flash) { animation: flash 1.6s ease-out; }
@keyframes flash { 0%, 40% { background: var(--color-primary-light); box-shadow: var(--shadow-md), inset 4px 0 0 var(--color-primary); } }
@media (max-width: 767px) { .day { padding-left: 52px; } .intro { margin: 16px 12px 12px 10px; } }
</style>
