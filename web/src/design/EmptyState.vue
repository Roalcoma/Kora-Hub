<script setup lang="ts">
import type { Component } from 'vue';
defineProps<{ icon?: Component; title: string; text?: string }>();
</script>

<template>
  <div class="empty">
    <span v-if="icon" class="ico"><component :is="icon" :size="26" /></span>
    <h3>{{ title }}</h3>
    <p v-if="text">{{ text }}</p>
    <div v-if="$slots.default" class="act"><slot /></div>
  </div>
</template>

<style scoped>
.empty { display: grid; justify-items: center; gap: 8px; padding: 40px 20px; text-align: center; }
.ico { width: 56px; height: 56px; display: grid; place-items: center; background: var(--color-primary-light); color: #8A4B00; }
h3 { margin: 6px 0 0; font-size: 18px; }
p { margin: 0; max-width: 42ch; color: var(--color-muted); line-height: 1.5; }
.act { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
</style>
