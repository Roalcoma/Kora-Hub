<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name: string; src?: string | null; size?: number; presence?: 'active' | 'away' | null; square?: boolean }>(), { size: 36 });
// Color estable por nombre, de una paleta que pasa AA con texto blanco (salvo naranja: texto marino)
const PALETTE = [['#2F5D8A', '#fff'], ['#F69008', '#13243D'], ['#5B4B8A', '#fff'], ['#1E7F4F', '#fff'], ['#1C3150', '#fff'], ['#A3412A', '#fff']] as const;
const initials = computed(() => props.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join(''));
const colors = computed(() => PALETTE[[...props.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length]!);
</script>

<template>
  <span class="av" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px`, background: colors[0], color: colors[1] }" :title="name">
    <img v-if="src" :src="src" :alt="name">
    <template v-else>{{ initials }}</template>
    <span v-if="presence" class="presence" :class="presence" :aria-label="presence === 'active' ? 'Conectado' : 'Ausente'" />
  </span>
</template>

<style scoped>
.av { position: relative; display: inline-grid; place-items: center; flex: none; font-weight: 700; user-select: none; }
img { width: 100%; height: 100%; object-fit: cover; }
.presence { position: absolute; right: -3px; bottom: -3px; width: 10px; height: 10px; border: 2px solid var(--color-surface); }
.presence.active { background: var(--color-presence); }
.presence.away { background: var(--color-surface); box-shadow: inset 0 0 0 1.5px var(--color-muted); }
</style>
