<script setup lang="ts">
import type { CategoryTone } from './types.ts';
// Tonos semánticos + los 8 colores de categoría (la paleta fija de tokens --color-cat-*)
defineProps<{ tone?: 'primary' | 'neutral' | 'success' | 'warning' | 'danger' | CategoryTone }>();
</script>

<template>
  <span class="badge" :class="tone ?? 'neutral'"><slot /></span>
</template>

<style scoped>
.badge { display: inline-flex; align-items: center; gap: 4px; min-width: 20px; justify-content: center; padding: 1px 7px; font-size: 12px; font-weight: 600; line-height: 18px; border: 1px solid transparent; font-variant-numeric: tabular-nums; white-space: nowrap; }
.primary { background: var(--color-primary); color: var(--color-ink); font-weight: 700; }
.neutral { background: var(--color-canvas); border-color: var(--color-line); color: var(--color-ink); }
.success { background: var(--color-success-light); color: var(--color-success); }
.warning { background: var(--color-warning-light); color: var(--color-warning); }
.danger { background: var(--color-danger-light); color: var(--color-danger); }
.green { background: var(--color-cat-green-light); border-color: var(--color-cat-green-line); color: var(--color-cat-green); }
.blue { background: var(--color-cat-blue-light); border-color: var(--color-cat-blue-line); color: var(--color-cat-blue); }
.purple { background: var(--color-cat-purple-light); border-color: var(--color-cat-purple-line); color: var(--color-cat-purple); }
.orange { background: var(--color-cat-orange-light); border-color: var(--color-cat-orange-line); color: var(--color-cat-orange); }
.red { background: var(--color-cat-red-light); border-color: var(--color-cat-red-line); color: var(--color-cat-red); }
.teal { background: var(--color-cat-teal-light); border-color: var(--color-cat-teal-line); color: var(--color-cat-teal); }
.pink { background: var(--color-cat-pink-light); border-color: var(--color-cat-pink-line); color: var(--color-cat-pink); }
.gray { background: var(--color-cat-gray-light); border-color: var(--color-cat-gray-line); color: var(--color-cat-gray); }
</style>
