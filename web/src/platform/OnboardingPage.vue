<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Check, ArrowRight, Smartphone } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import StructureEditor from './StructureEditor.vue';
import InvitePanel from './InvitePanel.vue';

const { t, tm, rt } = useI18n();
const router = useRouter();
const s = useSession();

// ponytail: el paso "Activar notificaciones" se agrega cuando exista push (Ola 2)
const steps = computed(() => [
  { key: 'departments', title: t('onboarding.departments'), hint: t('onboarding.departmentsHint') },
  { key: 'lines', title: t('onboarding.lines'), hint: t('onboarding.linesHint') },
  { key: 'invite', title: t('onboarding.invite'), hint: t('onboarding.inviteHint') },
  { key: 'phone', title: t('onboarding.phoneTitle'), hint: t('onboarding.phoneHint') },
] as const);
const i = ref(0);
const step = computed(() => steps.value[i.value]!);
const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const appUrl = location.origin;
const phoneSteps = computed(() => (tm('onboarding.phoneSteps') as unknown as string[]).map((x) => rt(x)));

function next() {
  if (i.value < steps.value.length - 1) i.value++;
  else router.replace(`/w/${s.workspace!.slug}`);
}
</script>

<template>
  <div class="onb">
    <div class="card">
      <nav class="steps" aria-label="Onboarding">
        <div class="ws">{{ s.workspace!.name }}</div>
        <button v-for="(st, n) in steps" :key="st.key" type="button" class="s" :class="{ ok: n < i, on: n === i }" :aria-current="n === i ? 'step' : undefined" @click="i = n">
          <span class="k"><Check v-if="n < i" :size="13" /><template v-else>{{ n + 1 }}</template></span>{{ st.title }}
        </button>
      </nav>
      <section class="body">
        <Badge class="self-start">{{ t('onboarding.step', { n: i + 1, total: steps.length }) }}</Badge>
        <h1>{{ step.title }}</h1>
        <p class="hint">{{ step.hint }}</p>
        <StructureEditor v-if="step.key === 'departments'" kind="departments" />
        <StructureEditor v-else-if="step.key === 'lines'" kind="lines" />
        <InvitePanel v-else-if="step.key === 'invite'" />
        <div v-else class="grid gap-3">
          <p v-if="installed" class="ok-msg"><Check :size="18" />{{ t('onboarding.installed') }}</p>
          <template v-else>
            <div class="url"><Smartphone :size="20" /><b>{{ appUrl }}</b></div>
            <ol class="how">
              <li v-for="(txt, n) in phoneSteps" :key="n"><span class="k">{{ n + 1 }}</span>{{ txt }}</li>
            </ol>
          </template>
        </div>
        <footer>
          <Button v-if="i < steps.length - 1" variant="ghost" @click="router.replace(`/w/${s.workspace!.slug}`)">{{ t('common.later') }}</Button>
          <Button variant="primary" size="lg" @click="next">{{ i < steps.length - 1 ? t('common.continue') : t('onboarding.finish') }}<ArrowRight :size="16" /></Button>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.onb { min-height: 100%; display: grid; place-items: center; padding: 24px 16px; }
.card { width: min(860px, 100%); display: grid; grid-template-columns: 240px minmax(0, 1fr); background: var(--color-surface); box-shadow: var(--shadow-lg); }
.steps { background: var(--color-ink); color: var(--color-sidebar-text); padding: 20px 0; display: grid; align-content: start; gap: 2px; }
.ws { padding: 0 20px 14px; font: 700 17px var(--font-display); color: #fff; }
.s { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 20px; font: inherit; font-size: 14px; text-align: left; color: inherit; background: none; border: 0; cursor: pointer; }
.s:hover { color: #fff; }
.k { width: 22px; height: 22px; display: grid; place-items: center; flex: none; border: 1.5px solid #5B7193; font-size: 11px; font-weight: 700; }
.s.ok .k { background: var(--color-presence); border-color: var(--color-presence); color: var(--color-ink); }
.s.on { background: var(--color-ink-soft); color: #fff; font-weight: 500; box-shadow: inset 4px 0 0 var(--color-primary); }
.s.on .k { border-color: var(--color-primary); color: var(--color-primary); }
.body { padding: 28px 32px; display: grid; gap: 14px; align-content: start; min-width: 0; }
h1 { margin: 0; font-size: 24px; }
.hint { margin: -6px 0 4px; color: var(--color-muted); line-height: 1.5; }
footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding-top: 12px; border-top: 1px solid var(--color-line); margin-top: 6px; }
.url { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px dashed var(--color-line-strong); word-break: break-all; }
.how { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.how li { display: flex; align-items: center; gap: 12px; }
.how .k { width: 28px; height: 28px; background: var(--color-primary); color: var(--color-ink); border: 0; font-size: 13px; }
.ok-msg { display: flex; align-items: center; gap: 8px; padding: 12px; background: var(--color-success-light); color: var(--color-success); font-weight: 500; margin: 0; }
@media (max-width: 767px) {
  .onb { padding: 0; place-items: stretch; }
  .card { grid-template-columns: minmax(0, 1fr); box-shadow: none; }
  .steps { display: none; }
  .body { padding: calc(20px + env(safe-area-inset-top, 0px)) 16px calc(20px + env(safe-area-inset-bottom, 0px)); }
  footer .btn { flex: 1; }
}
</style>
