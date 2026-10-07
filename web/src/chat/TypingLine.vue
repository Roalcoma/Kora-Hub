<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useChat } from './store.ts';

const props = defineProps<{ listKey: string }>();
const { t } = useI18n();
const chat = useChat();
// Reevalúa cada segundo para que el aviso caduque solo
const tick = ref(0);
const timer = setInterval(() => tick.value++, 1000);
onBeforeUnmount(() => clearInterval(timer));

const text = computed(() => {
  void tick.value;
  void chat.typing[props.listKey];
  const names = chat.typingIn(props.listKey).map(chat.nameOf);
  if (!names.length) return '';
  if (names.length === 1) return t('chat.typing1', { a: names[0] });
  if (names.length === 2) return t('chat.typing2', { a: names[0], b: names[1] });
  return t('chat.typingMany');
});
</script>

<template>
  <div class="typing" aria-live="polite"><template v-if="text"><span class="dots"><i /><i /><i /></span>{{ text }}</template></div>
</template>

<style scoped>
.typing { display: flex; align-items: center; gap: 8px; height: 22px; padding: 0 24px 2px 66px; font-size: 12px; color: var(--color-muted); }
.dots { display: inline-flex; gap: 3px; }
.dots i { width: 5px; height: 5px; background: var(--color-muted); animation: b 1s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
@keyframes b { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-3px); opacity: 1; } }
@media (max-width: 767px) { .typing { padding-left: 16px; } }
</style>
