<script setup lang="ts">
import { useId } from 'vue';

const model = defineModel<string>({ default: '' });
defineProps<{ label?: string; hint?: string; error?: string | null; type?: string; placeholder?: string; autocomplete?: string; required?: boolean; prefix?: string }>();
const id = useId();
</script>

<template>
  <div class="field">
    <label v-if="label" :for="id">{{ label }}</label>
    <div class="box" :class="{ invalid: error }">
      <span v-if="prefix" class="prefix">{{ prefix }}</span>
      <input :id="id" v-model="model" :type="type ?? 'text'" :placeholder="placeholder" :autocomplete="autocomplete"
        :required="required" :aria-invalid="!!error" :aria-describedby="error || hint ? `${id}-help` : undefined">
    </div>
    <p v-if="error || hint" :id="`${id}-help`" :class="error ? 'error' : 'hint'">{{ error || hint }}</p>
  </div>
</template>

<style scoped>
.field { display: grid; gap: 6px; }
label { font-size: 13px; font-weight: 500; }
.box { display: flex; align-items: center; background: var(--color-surface); border: 1px solid var(--color-line-strong); transition: border-color var(--duration), box-shadow var(--duration); }
.box:focus-within { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .25); }
.box.invalid { border-color: var(--color-danger); }
.prefix { padding-left: 12px; color: var(--color-muted); font-size: 14px; white-space: nowrap; }
input { flex: 1; min-width: 0; min-height: 40px; padding: 0 12px; border: 0; background: transparent; font: inherit; color: inherit; outline: none; }
.prefix + input { padding-left: 2px; }
.hint { margin: 0; font-size: 12px; color: var(--color-muted); }
.error { margin: 0; font-size: 12px; color: var(--color-danger); font-weight: 500; }
</style>
