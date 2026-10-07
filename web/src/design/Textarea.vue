<script setup lang="ts">
import { useId } from 'vue';

const model = defineModel<string>({ default: '' });
defineProps<{ label?: string; hint?: string; error?: string | null; placeholder?: string; rows?: number }>();
const id = useId();
</script>

<template>
  <div class="field">
    <label v-if="label" :for="id">{{ label }}</label>
    <textarea :id="id" v-model="model" :rows="rows ?? 4" :placeholder="placeholder" :class="{ invalid: error }" :aria-invalid="!!error" />
    <p v-if="error || hint" :class="error ? 'error' : 'hint'">{{ error || hint }}</p>
  </div>
</template>

<style scoped>
.field { display: grid; gap: 6px; }
label { font-size: 13px; font-weight: 500; }
textarea { padding: 10px 12px; font: inherit; color: inherit; background: var(--color-surface); border: 1px solid var(--color-line-strong); resize: vertical; outline: none; transition: border-color var(--duration), box-shadow var(--duration); }
textarea:focus { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .25); }
textarea.invalid { border-color: var(--color-danger); }
.hint { margin: 0; font-size: 12px; color: var(--color-muted); }
.error { margin: 0; font-size: 12px; color: var(--color-danger); font-weight: 500; }
</style>
