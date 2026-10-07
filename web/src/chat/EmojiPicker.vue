<script setup lang="ts">
// Selector de emoji compacto (los emojis son contenido, no interfaz). En iPhone el teclado ya trae los suyos.
const emit = defineEmits<{ pick: [emoji: string] }>();
const QUICK = ['👍', '✅', '👀', '🙏', '🎉', '🔥'];
const ALL = [
  '😀', '😂', '😊', '😍', '🤔', '😅', '😎', '🙌', '👏', '💪', '🤝', '👋',
  '❤️', '💯', '⭐', '🚀', '📌', '📎', '📅', '⏰', '📞', '📧', '💼', '📈',
  '😢', '😮', '😬', '🙈', '❗', '❓', '⚠️', '❌', '🏥', '💊', '👴', '👶',
];
</script>

<template>
  <div class="picker" role="dialog" aria-label="Emoji">
    <div class="quick">
      <button v-for="e in QUICK" :key="e" type="button" @click="emit('pick', e)">{{ e }}</button>
    </div>
    <div class="grid">
      <button v-for="e in ALL" :key="e" type="button" @click="emit('pick', e)">{{ e }}</button>
    </div>
  </div>
</template>

<style scoped>
.picker { width: 296px; padding: 8px; background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-lg); display: grid; gap: 6px; }
.quick { display: flex; gap: 2px; padding-bottom: 6px; border-bottom: 1px solid var(--color-line); }
.grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; }
button { width: 34px; height: 34px; display: grid; place-items: center; font-size: 20px; background: none; border: 0; cursor: pointer; transition: background var(--duration), transform var(--duration); }
button:hover, button:focus-visible { background: var(--color-primary-light); transform: translateY(-1px); }
</style>
