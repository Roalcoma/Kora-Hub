<script setup lang="ts">
// Solo CSS: aparece al pasar el mouse o al enfocar con teclado. Lo esencial nunca vive solo en un tooltip.
defineProps<{ text: string; side?: 'top' | 'bottom' | 'right' }>();
</script>

<template>
  <span class="tt" :data-side="side ?? 'top'">
    <slot />
    <span class="tip" role="tooltip">{{ text }}</span>
  </span>
</template>

<style scoped>
.tt { position: relative; display: inline-flex; }
.tip { position: absolute; z-index: 50; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); padding: 5px 8px; font-size: 12px; font-weight: 500; white-space: nowrap; background: var(--color-ink); color: #fff; box-shadow: var(--shadow-md); opacity: 0; pointer-events: none; transition: opacity var(--duration); }
[data-side="bottom"] .tip { bottom: auto; top: calc(100% + 6px); }
[data-side="right"] .tip { left: calc(100% + 8px); bottom: auto; top: 50%; transform: translateY(-50%); }
.tt:hover .tip, .tt:focus-within .tip { opacity: 1; transition-delay: 300ms; }
@media (hover: none) { .tip { display: none; } }
</style>
