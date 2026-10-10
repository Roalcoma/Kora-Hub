<script setup lang="ts">
// Ventas y comisiones por agente (docs/plan-comisiones.md). Pestañas: Ventas, Comisiones y, para el Admin, Configuración.
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ChevronLeft } from 'lucide-vue-next';
import Tabs from '@/design/Tabs.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { api } from '@/api.ts';
import { useSales } from './store.ts';
import SalesTab from './SalesTab.vue';
import CommissionsTab from './CommissionsTab.vue';
import SetupTab from './SetupTab.vue';
import InboxTab from './InboxTab.vue';

type Tab = 'sales' | 'commissions' | 'inbox' | 'setup';
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const sales = useSales();

/** Mensajes de Discord por revisar (solo Admin) */
const inboxCount = ref(0);
const countInbox = async () => {
  if (s.isAdmin) inboxCount.value = (await api('GET /w/:slug/discord-feed', { params: { slug: s.workspace!.slug } })).pendingInbox;
};
const tabs = computed(() => [
  { value: 'sales' as const, label: t('sales.tabs.sales') },
  { value: 'commissions' as const, label: t('sales.tabs.commissions') },
  ...(s.isAdmin ? [
    { value: 'inbox' as const, label: t('sales.tabs.inbox'), count: inboxCount.value || undefined },
    { value: 'setup' as const, label: t('sales.tabs.setup') },
  ] : []),
]);
const tab = computed<Tab>({
  get: () => (tabs.value.some((x) => x.value === route.params.tab) ? route.params.tab as Tab : 'sales'),
  set: (v) => router.replace(`/w/${s.workspace!.slug}/sales/${v}`),
});

const ready = ref(false);
onMounted(async () => {
  try {
    await Promise.all([sales.load(true), countInbox()]);
    ready.value = true;
  } catch (e) { toast(errorText(e), 'error'); }
});
</script>

<template>
  <div class="page">
    <header class="top">
      <button type="button" class="back" :aria-label="t('common.back')" @click="router.push(`/w/${s.workspace!.slug}`)"><ChevronLeft :size="22" /></button>
      <h1>{{ t('nav.sales') }}</h1>
      <Tabs v-model="tab" :tabs="tabs" />
    </header>
    <div v-if="!ready" class="grid gap-3 p-7"><Skeleton v-for="n in 4" :key="n" height="52px" /></div>
    <SalesTab v-else-if="tab === 'sales'" />
    <CommissionsTab v-else-if="tab === 'commissions'" />
    <InboxTab v-else-if="tab === 'inbox'" @changed="countInbox" />
    <SetupTab v-else />
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.top { position: relative; z-index: 2; display: flex; align-items: center; gap: 18px; min-height: 64px; padding: 8px 20px 8px 28px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.back { display: none; width: var(--tap); height: var(--tap); place-items: center; background: none; border: 0; color: inherit; cursor: pointer; }
h1 { margin: 0 auto 0 0; font-size: 24px; }
@media (max-width: 767px) {
  .top { flex-wrap: wrap; gap: 4px 8px; padding: 6px 12px 0 4px; }
  .back { display: grid; }
  .top :deep(.tabs) { width: 100%; border-bottom: 0; }
}
</style>
