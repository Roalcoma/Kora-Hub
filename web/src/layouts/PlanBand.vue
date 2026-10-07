<script setup lang="ts">
// Banda de aviso del plan sobre el contenido (ADR 0005): prueba por vencer (≤ 3 días), pago fallido, solo lectura
// o suspendida. Texto sobre naranja en --color-ink; el Owner ve el botón que lleva a Facturación.
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Clock, CreditCard, Lock, OctagonPause, ArrowRight } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';

const { t } = useI18n();
const router = useRouter();
const s = useSession();

const band = computed(() => {
  const w = s.workspace!;
  if (w.status === 'trialing') {
    const n = Math.max(0, Math.ceil((new Date(w.trialEndsAt).getTime() - Date.now()) / 86400_000));
    if (n > 3) return null;
    return { tone: 'soft', icon: Clock, title: t('plan.trialEnds', { n }, n), hint: t('plan.trialEndsHint'), action: t('plan.choosePlan') };
  }
  if (w.status === 'past_due') return { tone: 'warn', icon: CreditCard, title: t('plan.pastDue'), hint: t('plan.pastDueHint'), action: t('plan.updatePayment') };
  if (w.status === 'read_only') return { tone: 'warn', icon: Lock, title: t('plan.readOnly'), hint: t('plan.readOnlyHint'), action: t('plan.choosePlan') };
  if (w.status === 'suspended') return { tone: 'dark', icon: OctagonPause, title: t('plan.suspended'), hint: t('plan.suspendedHint'), action: t('plan.choosePlan') };
  return null;
});
const toBilling = () => router.push(`/w/${s.workspace!.slug}/settings/billing`);
</script>

<template>
  <div v-if="band" class="band no-print" :class="band.tone" role="status">
    <span class="ico"><component :is="band.icon" :size="18" /></span>
    <p><b>{{ band.title }}</b> <span>{{ band.hint }}</span></p>
    <button v-if="s.isOwner" type="button" class="go" @click="toBilling">{{ band.action }}<ArrowRight :size="15" /></button>
    <small v-else class="ask">{{ t('plan.askOwner') }}</small>
  </div>
</template>

<style scoped>
/* Proyecta sombra sobre el contenido; acento lateral a la izquierda */
.band { position: relative; z-index: 3; display: flex; align-items: center; gap: 12px; padding: 9px 16px 9px 18px; box-shadow: 0 4px 14px rgb(19 36 61 / .16); }
.band::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; }
p { flex: 1; min-width: 0; margin: 0; font-size: 14px; line-height: 1.4; }
b { font-weight: 700; }
.ico { width: 30px; height: 30px; display: grid; place-items: center; flex: none; }
.go { display: inline-flex; align-items: center; gap: 6px; flex: none; min-height: 34px; padding: 0 12px; font: inherit; font-size: 13px; font-weight: 700; border: 0; cursor: pointer; transition: box-shadow var(--duration), transform var(--duration); }
.go:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.ask { flex: none; font-size: 12px; opacity: .85; }

/* Prueba por vencer: aviso suave, acento naranja */
.soft { background: var(--color-primary-light); color: var(--color-ink); }
.soft::before { background: var(--color-primary); }
.soft .ico { background: var(--color-primary); color: var(--color-ink); }
.soft .go { background: var(--color-ink); color: #fff; }
/* Pago fallido / solo lectura: naranja con texto marino (AA) */
.warn { background: var(--color-primary); color: var(--color-ink); }
.warn::before { background: var(--color-ink); }
.warn .ico { background: var(--color-ink); color: var(--color-primary); }
.warn .go { background: var(--color-ink); color: #fff; }
/* Suspendida: marino con acento naranja */
.dark { background: var(--color-ink); color: #fff; }
.dark::before { background: var(--color-primary); }
.dark .ico { background: var(--color-primary); color: var(--color-ink); }
.dark .go { background: var(--color-primary); color: var(--color-ink); }

@media (max-width: 767px) {
  .band { flex-wrap: wrap; padding: 8px 12px 10px 16px; }
  p { flex-basis: calc(100% - 42px); font-size: 13px; }
  .go { margin-left: 42px; }
  .ask { margin-left: 42px; }
}
</style>
