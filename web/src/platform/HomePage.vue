<script setup lang="ts">
// En escritorio, Inicio abre el último canal visitado (o #general). En móvil, el shell muestra la lista de canales.
import { watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';
import Skeleton from '@/design/Skeleton.vue';

const router = useRouter();
const s = useSession();
const chat = useChat();

watch(() => chat.ready, (ready) => {
  if (!ready || !matchMedia('(min-width: 768px)').matches) return;
  let last: string | null = null;
  try { last = localStorage.getItem(`last-channel:${s.workspace!.slug}`); } catch { /* idem */ }
  const target = chat.channels.find((c) => c.id === last && c.isMember)
    ?? chat.channels.find((c) => c.kind === 'public' && c.name === 'general')
    ?? chat.channels.find((c) => c.isMember);
  if (target) router.replace(`/w/${s.workspace!.slug}/c/${target.id}`);
}, { immediate: true });
</script>

<template>
  <div class="grid gap-4 p-6 max-w-xl"><Skeleton height="56px" /><Skeleton v-for="n in 4" :key="n" height="44px" /></div>
</template>
