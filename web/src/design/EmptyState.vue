<script setup lang="ts">
import type { Component } from 'vue';
defineProps<{ icon?: Component; title: string; text?: string }>();
</script>

<template>
  <!-- Asimétrico: ícono a la izquierda, texto alineado a un lado, tarjeta elevada con acento lateral -->
  <div class="empty">
    <span v-if="icon" class="ico"><component :is="icon" :size="24" /></span>
    <div class="txt">
      <h3>{{ title }}</h3>
      <p v-if="text">{{ text }}</p>
      <div v-if="$slots.default" class="act"><slot /></div>
    </div>
  </div>
</template>

<style scoped>
.empty { display: flex; align-items: flex-start; gap: 18px; max-width: 560px; padding: 22px 26px 22px 22px; text-align: left; background: var(--color-surface); border-left: 4px solid var(--color-primary); box-shadow: var(--shadow-md); }
.ico { width: 50px; height: 50px; display: grid; place-items: center; flex: none; background: var(--color-primary-light); color: #8A4B00; box-shadow: var(--shadow-sm); }
.txt { display: grid; gap: 6px; min-width: 0; }
h3 { margin: 2px 0 0; font-size: 18px; }
p { margin: 0; max-width: 52ch; color: var(--color-muted); line-height: 1.5; }
.act { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
</style>
