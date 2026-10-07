<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  block?: boolean;
}>(), { variant: 'secondary', size: 'md', type: 'button' });
</script>

<template>
  <button :type="type" class="btn" :class="[variant, size, { block }]" :disabled="disabled || loading" :aria-busy="loading">
    <span v-if="loading" class="spin" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-weight: 700; font-size: 14px; cursor: pointer; white-space: nowrap;
  border: 1px solid transparent; transition: background var(--duration), border-color var(--duration), box-shadow var(--duration);
}
.sm { min-height: 32px; padding: 0 10px; font-size: 13px; }
.md { min-height: 38px; padding: 0 14px; }
.lg { min-height: var(--tap); padding: 0 18px; font-size: 15px; }
.block { width: 100%; }
/* Texto marino sobre naranja: blanco no pasa AA */
.primary { background: var(--color-primary); color: var(--color-ink); }
.primary:hover:not(:disabled) { background: var(--color-primary-dark); }
.secondary { background: var(--color-surface); color: var(--color-ink); border-color: var(--color-line-strong); }
.secondary:hover:not(:disabled) { border-color: var(--color-ink); box-shadow: var(--shadow-sm); }
.ghost { background: transparent; color: var(--color-ink); }
.ghost:hover:not(:disabled) { background: rgb(19 36 61 / .06); }
.danger { background: var(--color-danger); color: #fff; }
.danger:hover:not(:disabled) { background: #8F1C13; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.spin { width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50% !important; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
