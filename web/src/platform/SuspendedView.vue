<script setup lang="ts">
// Pantalla de agencia suspendida (ADR 0005): explica qué pasó, qué se conserva y, al Owner, cómo reactivarla.
// Composición asimétrica: explicación a la izquierda (EmptyState) y lo que se conserva como contexto a la derecha.
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { OctagonPause, CreditCard, Check, ArrowLeftRight } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import EmptyState from '@/design/EmptyState.vue';
import Button from '@/design/Button.vue';

const { t, tm, rt } = useI18n();
const router = useRouter();
const s = useSession();
const keep = computed(() => (tm('plan.suspendedKeepList') as unknown as string[]).map((x) => rt(x)));
const other = computed(() => s.session!.workspaces.find((w) => w.slug !== s.workspace!.slug));
</script>

<template>
  <div class="susp">
    <EmptyState :icon="OctagonPause" :title="t('plan.suspendedTitle')" :text="`${t('plan.suspendedText')} ${s.isOwner ? t('plan.suspendedOwner') : t('plan.suspendedMember')}`">
      <Button v-if="s.isOwner" variant="primary" @click="router.push(`/w/${s.workspace!.slug}/settings/billing`)"><CreditCard :size="16" />{{ t('plan.goBilling') }}</Button>
      <Button v-if="other" @click="router.push(`/w/${other.slug}`)"><ArrowLeftRight :size="16" />{{ t('plan.otherWorkspace') }}</Button>
    </EmptyState>
    <aside class="keep">
      <h3>{{ t('plan.suspendedKeep') }}</h3>
      <ul><li v-for="(x, i) in keep" :key="i"><Check :size="16" />{{ x }}</li></ul>
    </aside>
  </div>
</template>

<style scoped>
.susp { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .7fr); gap: 22px; align-items: stretch; max-width: 1320px; padding: 32px 32px 40px 28px; }
.susp :deep(.empty) { max-width: none; }
.keep { display: grid; gap: 10px; align-content: start; padding: 18px 20px; background: var(--color-surface); box-shadow: var(--shadow-sm); border-top: 3px solid var(--color-ink); }
h3 { margin: 0; font-size: 16px; }
ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; font-size: 14px; color: var(--color-muted); }
li { display: flex; gap: 8px; align-items: flex-start; }
li .lucide { color: var(--color-success); margin-top: 2px; }
@media (max-width: 900px) { .susp { grid-template-columns: minmax(0, 1fr); padding: 16px; } }
</style>
