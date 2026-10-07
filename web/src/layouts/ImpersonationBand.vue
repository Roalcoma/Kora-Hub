<script setup lang="ts">
// Banda roja fija mientras un superadmin ve la app "como" el Owner de una agencia (ADR 0005 §4). "Salir" vuelve
// a la sesión del superadmin y al backoffice.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Eye, LogOut } from 'lucide-vue-next';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { toast } from '@/design/toast.ts';
import { errorText } from '@/platform/errors.ts';

const { t, locale } = useI18n();
const router = useRouter();
const s = useSession();
const imp = computed(() => s.impersonation!);
const agency = computed(() => s.session!.workspaces.find((w) => w.slug === imp.value.workspaceSlug)?.name ?? imp.value.workspaceSlug);
const until = computed(() => new Date(imp.value.expiresAt).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' }));
const busy = ref(false);

async function exit() {
  busy.value = true;
  try {
    s.set(await api('POST /admin/impersonation/end'));
    s.workspace = null;
    await router.replace('/admin');
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="imp no-print" role="status">
    <span class="ico"><Eye :size="17" /></span>
    <p>{{ t('admin.impBand', { name: s.user!.name, agency, time: until }) }}</p>
    <button type="button" class="out" :disabled="busy" @click="exit"><LogOut :size="15" />{{ t('admin.impExit') }}</button>
  </div>
</template>

<style scoped>
/* Rojo de peligro con texto blanco (6.5:1); proyecta sombra sobre toda la app */
.imp { position: relative; z-index: 50; display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 4px 10px 4px 14px; padding-top: max(4px, env(safe-area-inset-top, 0px)); color: #fff; background: var(--color-danger); box-shadow: 0 4px 14px rgb(180 35 24 / .35); }
.ico { width: 26px; height: 26px; display: grid; place-items: center; flex: none; background: rgb(0 0 0 / .2); }
p { flex: 1; min-width: 0; margin: 0; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.out { display: inline-flex; align-items: center; gap: 6px; flex: none; min-height: 32px; padding: 0 12px; font: inherit; font-size: 13px; font-weight: 700; color: var(--color-danger); background: #fff; border: 0; cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.out:hover:not(:disabled) { box-shadow: 0 4px 10px rgb(0 0 0 / .25); transform: translateY(-1px); }
.out:disabled { opacity: .6; cursor: wait; }
@media (max-width: 767px) { p { white-space: normal; font-size: 13px; } }
</style>
