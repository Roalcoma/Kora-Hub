<script setup lang="ts">
// Franja «activa las notificaciones en este dispositivo»: aparece mientras el navegador no haya dado ni negado el permiso
// (cada dispositivo se activa por separado: la PC no hereda lo del teléfono). Se puede cerrar; se recuerda en el navegador.
// Con el permiso ya dado, syncPush deja la suscripción registrada sin preguntar.
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { BellRing, X } from 'lucide-vue-next';
import { toast } from '@/design/toast.ts';
import { errorText } from '@/platform/errors.ts';
import { pushState, enablePush, syncPush, isIos } from '@/chat/push.ts';

defineProps<{ edge?: boolean }>();
const { t } = useI18n();
const KEY = 'kora.notif.dismissed';
const show = ref(false);
const busy = ref(false);

onMounted(async () => {
  await syncPush();
  let dismissed = false;
  try { dismissed = localStorage.getItem(KEY) === '1'; } catch { /* sin almacenamiento */ }
  show.value = !dismissed && (await pushState()) === 'off' && Notification.permission === 'default';
});

async function enable() {
  busy.value = true;
  try {
    const st = await enablePush();
    show.value = false;
    toast(st === 'on' ? t('chat.notifEnabledHere') : t(isIos() ? 'chat.notifDenied' : 'chat.notifDeniedPc'), st === 'on' ? 'success' : 'error');
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
function close() {
  show.value = false;
  try { localStorage.setItem(KEY, '1'); } catch { /* idem */ }
}
</script>

<template>
  <div v-if="show" class="nband no-print" :class="{ edge }" role="status">
    <span class="ico"><BellRing :size="18" /></span>
    <p><b>{{ t('chat.notifBandTitle') }}</b> <span>{{ t('chat.notifBandHint') }}</span></p>
    <button type="button" class="go" :disabled="busy" @click="enable">{{ t('chat.notifEnable') }}</button>
    <button type="button" class="x" :aria-label="t('nav.close')" @click="close"><X :size="16" /></button>
  </div>
</template>

<style scoped>
.nband { position: relative; z-index: 4; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 18px; background: var(--color-primary-light); color: var(--color-ink); box-shadow: 0 4px 14px rgb(19 36 61 / .16); }
.nband.edge { padding-top: max(8px, env(safe-area-inset-top, 0px)); }
.nband::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-primary); }
.ico { width: 30px; height: 30px; display: grid; place-items: center; flex: none; background: var(--color-primary); color: var(--color-ink); }
p { flex: 1; min-width: 0; margin: 0; font-size: 14px; line-height: 1.4; }
b { font-weight: 700; }
.go { flex: none; min-height: 34px; padding: 0 14px; font: inherit; font-size: 13px; font-weight: 700; color: #fff; background: var(--color-ink); border: 0; box-shadow: var(--shadow-sm); cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.go:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.x { width: 34px; height: 34px; display: grid; place-items: center; flex: none; color: var(--color-ink); background: transparent; border: 0; cursor: pointer; }
.x:hover { background: var(--color-surface); box-shadow: var(--shadow-md); }
@media (max-width: 767px) { p { font-size: 13px; } p span { display: none; } }
</style>
