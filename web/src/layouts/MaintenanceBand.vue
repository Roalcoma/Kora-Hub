<script setup lang="ts">
// Franja del respaldo diario (GET /config → maintenance): aparece `noticeMinutes` antes del inicio con la hora local
// y la cuenta regresiva, y sigue durante la ventana. Se puede cerrar; se recuerda por ventana (localStorage).
// Mismo lenguaje que PlanBand en su tono suave: naranja claro, acento lateral, sombra sobre el contenido.
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { DatabaseBackup, X } from 'lucide-vue-next';
import { publicConfig } from '@/platform/config.ts';

defineProps<{ edge?: boolean }>();   // edge: es lo primero arriba de la pantalla → respeta el safe-area del iPhone
const { t, locale } = useI18n();

const KEY = 'kora.maintenance.dismissed';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const dismissed = ref(read());

// Reloj local: el servidor solo dice cuándo es la ventana; la cuenta regresiva se calcula aquí
const now = ref(Date.now());
const tick = setInterval(() => { now.value = Date.now(); }, 15_000);
onBeforeUnmount(() => clearInterval(tick));

const band = computed(() => {
  const m = publicConfig.value?.maintenance;
  if (!m || dismissed.value === m.startsAt) return null;
  const start = new Date(m.startsAt).getTime(), end = new Date(m.endsAt).getTime();
  if (now.value >= end || now.value < start - m.noticeMinutes * 60_000) return null;
  if (now.value >= start) return { during: true, title: t('maintenance.during'), hint: t('maintenance.duringHint'), count: '' };
  const n = Math.ceil((start - now.value) / 60_000);
  const time = new Date(start).toLocaleTimeString(locale.value, { hour: 'numeric', minute: '2-digit' });
  return { during: false, title: t('maintenance.before', { time }), hint: t('maintenance.beforeHint'), count: t('maintenance.startsIn', { n }, n) };
});

function close() {
  const id = publicConfig.value?.maintenance?.startsAt ?? null;
  dismissed.value = id;
  try { if (id) localStorage.setItem(KEY, id); } catch { /* sin almacenamiento: se cierra solo en esta pestaña */ }
}
</script>

<template>
  <div v-if="band" class="mband no-print" :class="{ during: band.during, edge }" role="status" aria-live="polite">
    <span class="ico"><DatabaseBackup :size="18" /></span>
    <p><b>{{ band.title }}</b> <span>{{ band.hint }}</span></p>
    <span v-if="band.count" class="count">{{ band.count }}</span>
    <button type="button" class="x" :aria-label="t('maintenance.close')" :title="t('maintenance.close')" @click="close"><X :size="16" /></button>
  </div>
</template>

<style scoped>
/* Proyecta sombra sobre el contenido; acento lateral a la izquierda (como PlanBand) */
.mband { position: relative; z-index: 4; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 18px; background: var(--color-primary-light); color: var(--color-ink); box-shadow: 0 4px 14px rgb(19 36 61 / .16); }
.mband.edge { padding-top: max(8px, env(safe-area-inset-top, 0px)); }
.mband::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-primary); }
.ico { width: 30px; height: 30px; display: grid; place-items: center; flex: none; background: var(--color-primary); color: var(--color-ink); }
p { flex: 1; min-width: 0; margin: 0; font-size: 14px; line-height: 1.4; }
b { font-weight: 700; }
/* Cuenta regresiva: etiqueta marina a la derecha, elevada */
.count { flex: none; padding: 4px 10px; font-size: 13px; font-weight: 700; color: #fff; background: var(--color-ink); box-shadow: var(--shadow-sm); font-variant-numeric: tabular-nums; }
.x { width: 34px; height: 34px; display: grid; place-items: center; flex: none; color: var(--color-ink); background: transparent; border: 0; cursor: pointer; transition: background var(--duration), box-shadow var(--duration), transform var(--duration); }
.x:hover { background: var(--color-surface); box-shadow: var(--shadow-md); transform: translateY(-1px); }
.x:focus-visible { outline: 2px solid var(--color-ink); outline-offset: -2px; }
/* En curso: naranja pleno con texto marino (AA), como el tono de aviso de PlanBand */
.during { background: var(--color-primary); }
.during::before { background: var(--color-ink); }
.during .ico { background: var(--color-ink); color: var(--color-primary); }

@media (max-width: 767px) {
  .mband { flex-wrap: wrap; gap: 8px 12px; padding: 8px 4px 10px 16px; }
  .mband.edge { padding-top: max(8px, env(safe-area-inset-top, 0px)); }
  p { flex-basis: calc(100% - 96px); font-size: 13px; }
  .x { order: 2; }
  .count { order: 3; margin-left: 42px; }
}
</style>
