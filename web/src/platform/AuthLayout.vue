<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <div class="auth">
    <aside class="brand">
      <div class="logo"><span class="mark">K</span>Kora</div>
      <p class="pitch">Chat, anuncios, manuales, tareas y metas de tu agencia de seguros, en una sola app.</p>
      <ul class="lines"><li>Salud</li><li>Vida</li><li>Medicare</li></ul>
    </aside>
    <main class="panel">
      <div class="logo m"><span class="mark">K</span>Kora</div>
      <div class="card">
        <h1>{{ title }}</h1>
        <p v-if="subtitle" class="sub">{{ subtitle }}</p>
        <slot />
      </div>
      <div v-if="$slots.footer" class="foot"><slot name="footer" /></div>
    </main>
  </div>
</template>

<style scoped>
.auth { min-height: 100%; display: grid; grid-template-columns: minmax(320px, 440px) minmax(0, 1fr); }
.brand { background: linear-gradient(180deg, var(--color-ink) 0%, #0F1E34 100%); color: var(--color-sidebar-text); padding: 40px; display: flex; flex-direction: column; gap: 20px; }
.logo { display: flex; align-items: center; gap: 10px; font-family: var(--font-display); font-weight: 700; font-size: 20px; color: #fff; }
.mark { width: 36px; height: 36px; display: grid; place-items: center; background: var(--color-primary); color: var(--color-ink); font-size: 15px; }
.pitch { margin: auto 0 0; font-family: var(--font-display); font-size: 26px; line-height: 1.25; color: #fff; text-wrap: balance; }
.lines { display: flex; gap: 8px; margin: 0; padding: 0; list-style: none; }
.lines li { padding: 4px 10px; border: 1px solid rgb(255 255 255 / .2); font-size: 13px; color: var(--color-cta); }
.panel { display: grid; align-content: center; justify-items: center; gap: 16px; padding: 32px 16px calc(32px + env(safe-area-inset-bottom, 0px)); }
.card { width: min(420px, 100%); display: grid; gap: 16px; background: var(--color-surface); padding: 28px; box-shadow: var(--shadow-md); }
h1 { margin: 0; font-size: 26px; }
.sub { margin: -8px 0 0; color: var(--color-muted); line-height: 1.5; }
.foot { font-size: 14px; color: var(--color-muted); text-align: center; }
.logo.m { display: none; color: var(--color-ink); }
@media (max-width: 767px) {
  .auth { grid-template-columns: minmax(0, 1fr); }
  .brand { display: none; }
  .logo.m { display: flex; }
  .panel { align-content: start; padding-top: calc(32px + env(safe-area-inset-top, 0px)); }
  .card { padding: 20px; }
}
</style>
