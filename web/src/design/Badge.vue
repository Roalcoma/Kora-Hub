<script setup lang="ts">
defineProps<{ tone?: 'primary' | 'neutral' | 'success' | 'warning' | 'danger' | 'salud' | 'vida' | 'medicare' }>();
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
.salud { background: var(--color-success-light); border-color: #B7DCC6; color: var(--color-success); }
.vida { background: #EAF1F8; border-color: #C3D5E8; color: var(--color-leaf); }
.medicare { background: #F1ECF8; border-color: #D5CAE8; color: #5B4B8A; }
</style>
