<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bell, BellRing, Send, ShieldAlert, Smartphone } from 'lucide-vue-next';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { errorText } from '@/platform/errors.ts';
import { pushState, enablePush, sendTestPush, type PushState } from './push.ts';

const { t } = useI18n();
const state = ref<PushState | null>(null);
const busy = ref(false);
onMounted(async () => { state.value = await pushState(); });

async function enable() {
  busy.value = true;
  try { state.value = await enablePush(); } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
async function test() {
  busy.value = true;
  try { await sendTestPush(); toast(t('chat.notifTestSent'), 'success'); } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
const notes: Partial<Record<PushState, string>> = {
  insecure: 'chat.notifInsecure', unsupported: 'chat.notifUnsupported', 'install-first': 'chat.notifInstallFirst', denied: 'chat.notifDenied',
};
</script>

<template>
  <div v-if="state" class="push" :class="state">
    <span class="ico"><BellRing v-if="state === 'on'" :size="22" /><Smartphone v-else-if="state === 'install-first'" :size="22" /><ShieldAlert v-else-if="notes[state]" :size="22" /><Bell v-else :size="22" /></span>
    <div class="body">
      <b>{{ state === 'on' ? t('chat.notifOn') : t('chat.notifTitle') }}</b>
      <p v-if="notes[state]">{{ t(notes[state]!) }}</p>
      <div class="acts">
        <Button v-if="state === 'off'" variant="primary" size="lg" :loading="busy" @click="enable"><Bell :size="17" />{{ t('chat.notifEnable') }}</Button>
        <Button v-if="state === 'on'" size="lg" :loading="busy" @click="test"><Send :size="17" />{{ t('chat.notifTest') }}</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.push { display: flex; gap: 14px; align-items: flex-start; padding: 16px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); border-left: 4px solid var(--color-line-strong); }
.push.on { border-left-color: var(--color-presence); }
.push.off { border-left-color: var(--color-primary); }
.push.denied, .push.unsupported, .push.insecure { border-left-color: var(--color-warning); }
.ico { width: 44px; height: 44px; display: grid; place-items: center; flex: none; background: var(--color-ink); color: var(--color-cta); box-shadow: var(--shadow-sm); }
.body { display: grid; gap: 8px; min-width: 0; }
p { margin: 0; color: var(--color-muted); line-height: 1.5; }
.acts { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
