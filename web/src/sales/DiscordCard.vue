<script setup lang="ts">
// Conexión con el canal de ventas de Discord (Admin): ID del canal y desde qué día leer. El token del bot vive en el
// servidor (DISCORD_BOT_TOKEN); aquí solo se ve si está configurado.
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { MessageSquareShare, TriangleAlert, CircleCheck } from 'lucide-vue-next';
import type { DiscordFeed } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Input from '@/design/Input.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { today } from './format.ts';

const { t, d } = useI18n();
const s = useSession();
const params = () => ({ slug: s.workspace!.slug });
const feed = ref<DiscordFeed | null>(null);
const form = reactive({ channelId: '', importSince: today() });
const busy = ref(false);

async function load() {
  feed.value = await api('GET /w/:slug/discord-feed', { params: params() });
  form.channelId = feed.value.channelId ?? '';
}
onMounted(() => load().catch((e) => toast(errorText(e), 'error')));

async function connect() {
  busy.value = true;
  try {
    feed.value = await api('PUT /w/:slug/discord-feed', { params: params(), body: { channelId: form.channelId.trim(), importSince: form.importSince } });
    toast(t('sales.discordConnected'), 'success');
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
async function disconnect() {
  busy.value = true;
  try {
    await api('DELETE /w/:slug/discord-feed', { params: params() });
    await load();
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
</script>

<template>
  <section class="card">
    <header><h2><MessageSquareShare :size="20" />{{ t('sales.discordTitle') }}</h2></header>
    <p v-if="feed && !feed.botConfigured" class="warn"><TriangleAlert :size="16" />{{ t('sales.discordNoBot') }}</p>
    <p v-else-if="feed?.lastError" class="warn"><TriangleAlert :size="16" />{{ t('sales.discordError', { error: feed.lastError }) }}</p>
    <p v-else-if="feed?.channelId" class="ok"><CircleCheck :size="16" />
      {{ feed.lastPolledAt ? t('sales.discordLastRead', { date: d(feed.lastPolledAt, 'long') }) : t('sales.discordWaiting') }}</p>
    <p class="hint">{{ t('sales.discordHint') }}</p>
    <form class="grid gap-3" @submit.prevent="connect">
      <Input v-model="form.channelId" :label="t('sales.discordChannel')" :placeholder="t('sales.discordPlaceholder')" />
      <label class="date">{{ t('sales.discordSince') }}<input v-model="form.importSince" type="date"></label>
      <div class="acts">
        <Button type="submit" variant="primary" :loading="busy" :disabled="!/^\d{15,25}$/.test(form.channelId.trim()) || !form.importSince">
          {{ feed?.channelId ? t('sales.discordReconnect') : t('sales.discordConnect') }}</Button>
        <Button v-if="feed?.channelId" variant="ghost" :disabled="busy" @click="disconnect">{{ t('sales.discordDisconnect') }}</Button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.card { display: grid; gap: 10px; padding: 18px 20px; background: var(--color-surface); border-left: 4px solid var(--color-cat-purple); box-shadow: var(--shadow-md); }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.hint { margin: 0; font-size: 13px; line-height: 1.5; color: var(--color-muted); }
.warn, .ok { display: flex; gap: 8px; margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.45; }
.warn { color: var(--color-warning); background: var(--color-warning-light); }
.ok { color: var(--color-success); background: var(--color-success-light); }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.acts { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
