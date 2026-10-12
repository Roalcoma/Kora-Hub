<script setup lang="ts">
// Finanzas (docs/plan-finanzas.md, ADR 0007): Resumen, Gastos, Nómina, Banco y Configuración. Solo Owner, Admin y
// Contable con el módulo activo; cualquier otro que llegue por URL vuelve al inicio.
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ChevronLeft } from 'lucide-vue-next';
import Tabs from '@/design/Tabs.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { canUseFinance, useFinance } from './store.ts';
import SummaryTab from './SummaryTab.vue';
import ExpensesTab from './ExpensesTab.vue';
import PayrollTab from './PayrollTab.vue';
import BankTab from './BankTab.vue';
import SetupTab from './SetupTab.vue';

type Tab = 'summary' | 'expenses' | 'payroll' | 'bank' | 'setup';
const TABS: Tab[] = ['summary', 'expenses', 'payroll', 'bank', 'setup'];
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const fin = useFinance();

const tabs = computed(() => TABS.map((v) => ({
  value: v, label: t(`finance.tabs.${v}`), count: v === 'expenses' ? fin.pendingApprovals || undefined : undefined,
})));
const tab = computed<Tab>({
  get: () => (TABS.includes(route.params.tab as Tab) ? route.params.tab as Tab : 'expenses'),
  set: (v) => router.replace(`/w/${s.workspace!.slug}/finance/${v}`),
});
/** Las pestañas hijas piden ir a otra (p. ej. del Resumen a Gastos) */
const go = (v: Tab) => { tab.value = v; };

const ready = ref(false);
onMounted(async () => {
  if (!canUseFinance(s)) { router.replace(`/w/${s.workspace!.slug}`); return; }
  const errors = await fin.load(true);
  if (errors.length) toast(errorText(errors[0]), 'error');
  ready.value = true;
});
</script>

<template>
  <div class="page">
    <header class="top">
      <button type="button" class="back" :aria-label="t('common.back')" @click="router.push(`/w/${s.workspace!.slug}`)"><ChevronLeft :size="22" /></button>
      <h1>{{ t('nav.finance') }}</h1>
      <Tabs v-model="tab" :tabs="tabs" />
    </header>
    <div v-if="!ready" class="grid gap-3 p-7"><Skeleton v-for="n in 4" :key="n" height="52px" /></div>
    <SummaryTab v-else-if="tab === 'summary'" @go="go" />
    <ExpensesTab v-else-if="tab === 'expenses'" />
    <PayrollTab v-else-if="tab === 'payroll'" @go="go" />
    <BankTab v-else-if="tab === 'bank'" @go="go" />
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
  .top :deep(.tabs) { width: 100%; border-bottom: 0; overflow-x: auto; }
}
</style>
