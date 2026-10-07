<script setup lang="ts">
defineProps<{ width?: string; height?: string }>();
</script>

<template>
  <span class="sk" :style="{ width: width ?? '100%', height: height ?? '14px' }" aria-hidden="true" />
</template>

<style scoped>
.sk { display: block; background: linear-gradient(90deg, var(--color-canvas-deep) 0%, var(--color-canvas) 50%, var(--color-canvas-deep) 100%) 0 0 / 200% 100%; animation: sh 1.2s linear infinite; }
@keyframes sh { to { background-position: -200% 0; } }
</style>
