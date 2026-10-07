<script setup lang="ts">
// Ajustes → Facturación (§3.4, §3.5, ADR 0005). La ven Admin y Owner; solo el Owner elige plan o administra el pago.
// En modo simulado (sin llaves de Stripe) el checkout vuelve aquí con ?simulated=<plan> y un modal confirma el pago.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Check, CreditCard, CalendarClock, Users, Receipt, FlaskConical, Info } from 'lucide-vue-next';
import type { BillingInfo } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import Badge from '@/design/Badge.vue';
import Button from '@/design/Button.vue';
import Modal from '@/design/Modal.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { errorText } from './errors.ts';
import { money as fmtMoney, statusTone, daysUntil } from './format.ts';

type PaidPlan = 'standard' | 'pro';
const PLANS: PaidPlan[] = ['standard', 'pro'];

const { t, d, tm, rt, locale } = useI18n();
const list = (key: string) => (tm(key) as unknown as string[]).map((x) => rt(x));
const route = useRoute();
const router = useRouter();
const s = useSession();
const slug = computed(() => s.workspace!.slug);

const billing = ref<BillingInfo | null>(null);
const busy = ref<string | null>(null);
async function load() {
  try {
    billing.value = await api('GET /w/:slug/billing', { params: { slug: slug.value } });
  } catch (e) {
    toast(errorText(e), 'error');
  }
}
onMounted(load);

const money = (cents: number) => fmtMoney(cents, locale.value);

// Lo destacado de la tarjeta del plan: días de prueba, días de gracia o próxima renovación
const headline = computed(() => {
  const b = billing.value!;
  if (b.status === 'trialing') { const n = daysUntil(b.trialEndsAt); return { n, text: t('billing.trialLeft', { n }, n), date: b.trialEndsAt }; }
  if (b.status === 'past_due') { const n = daysUntil(b.graceEndsAt); return { n, text: t('billing.graceLeft', { n }, n), date: b.graceEndsAt }; }
  return null;
});
const isCurrent = (p: PaidPlan) => billing.value?.plan === p && billing.value.status === 'active';

async function go(url: string) {
  // La URL del checkout simulado es de la propia app: se navega sin recargar
  const u = new URL(url, location.origin);
  if (u.origin === location.origin) await router.push(u.pathname + u.search);
  else location.assign(url);
}
async function choose(plan: PaidPlan) {
  busy.value = plan;
  try {
    const { url } = await api('POST /w/:slug/billing/checkout', { params: { slug: slug.value }, body: { plan } });
    await go(url);
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = null;
  }
}
async function portal() {
  busy.value = 'portal';
  try {
    const { url } = await api('POST /w/:slug/billing/portal', { params: { slug: slug.value } });
    await go(url);
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = null;
  }
}

// ─── Modo simulado ───
const simPlan = ref<PaidPlan | null>(null);
const simOpen = computed({ get: () => !!simPlan.value, set: (v) => { if (!v) closeSim(); } });
watch(() => route.query.simulated, (v) => { if (v === 'standard' || v === 'pro') simPlan.value = v; }, { immediate: true });
function closeSim() {
  simPlan.value = null;
  if (route.query.simulated) router.replace({ query: {} });
}
async function simulate(event: 'paid' | 'payment_failed' | 'canceled', plan?: PaidPlan) {
  busy.value = event;
  try {
    billing.value = await api('POST /w/:slug/billing/simulate', { params: { slug: slug.value }, body: { event, plan } });
    await s.refreshWorkspace();
    toast(t(`billing.simulated.${event}`), event === 'paid' ? 'success' : 'info');
    if (event === 'paid') closeSim();
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div v-if="!billing" class="grid gap-4"><Skeleton height="180px" /><Skeleton height="260px" /></div>
  <div v-else class="billing">
    <div class="top">
      <!-- Plan actual: columna principal -->
      <section class="card current" :class="billing.status">
        <header class="cur-head">
          <span class="cur-ico"><CreditCard :size="22" /></span>
          <div class="cur-ttl">
            <small>{{ t('billing.current') }}</small>
            <h2>{{ t(`settings.plans.${billing.plan}`) }}</h2>
          </div>
          <Badge :tone="statusTone(billing.status)">{{ t(`settings.statuses.${billing.status}`) }}</Badge>
        </header>
        <div class="cur-body">
          <div v-if="headline" class="big">
            <b>{{ headline.n }}</b>
            <span>{{ headline.text }}<small v-if="headline.date">{{ t('billing.until', { date: d(headline.date, 'day') }) }}</small></span>
          </div>
          <div v-else-if="billing.status === 'active' && billing.currentPeriodEnd" class="big">
            <CalendarClock :size="30" class="big-ico" />
            <span>{{ t('billing.renews') }}<small>{{ d(billing.currentPeriodEnd, 'day') }}</small></span>
          </div>
          <p class="explain">{{ t(`billing.explain.${billing.status}`) }}</p>
        </div>
        <dl class="facts">
          <div><dt><Users :size="15" />{{ t('billing.seats') }}</dt><dd>{{ billing.seats }}</dd><small>{{ t('billing.seatsHint') }}</small></div>
          <div><dt><Receipt :size="15" />{{ t('billing.estimated') }}</dt><dd>{{ money(billing.estimatedMonthlyCents) }}</dd><small>{{ t('billing.perMonth') }}</small></div>
        </dl>
        <footer v-if="billing.hasSubscription" class="cur-foot">
          <Button :disabled="!s.isOwner" :loading="busy === 'portal'" @click="portal"><CreditCard :size="16" />{{ t('billing.portal') }}</Button>
          <small v-if="!s.isOwner">{{ t('billing.ownerOnly') }}</small>
        </footer>
      </section>

      <!-- Contexto: cómo se cobra y, en modo simulado, las herramientas de prueba -->
      <aside class="side">
        <div class="card how">
          <h3><Info :size="17" />{{ t('billing.howTitle') }}</h3>
          <ul><li v-for="(x, i) in list('billing.how')" :key="i">{{ x }}</li></ul>
        </div>
        <div v-if="billing.simulated && s.isOwner" class="card tools">
          <h3><FlaskConical :size="17" />{{ t('billing.toolsTitle') }}</h3>
          <p>{{ t('billing.toolsHint') }}</p>
          <div class="tools-row">
            <Button size="sm" :loading="busy === 'payment_failed'" @click="simulate('payment_failed')">{{ t('billing.simFailed') }}</Button>
            <Button size="sm" :loading="busy === 'canceled'" @click="simulate('canceled')">{{ t('billing.simCanceled') }}</Button>
          </div>
        </div>
      </aside>
    </div>

    <!-- Comparativa: tarjetas hermanas del mismo ancho y alto, acciones alineadas al pie -->
    <h2 class="cmp-title">{{ t('billing.compare') }}</h2>
    <div class="plans">
      <article v-for="p in PLANS" :key="p" class="card plan" :class="[p, { now: isCurrent(p) }]">
        <header>
          <h3>{{ t(`settings.plans.${p}`) }}</h3>
          <Badge v-if="isCurrent(p)" tone="success">{{ t('billing.yourPlan') }}</Badge>
        </header>
        <p class="price"><b>{{ money(billing.pricesCents[p]) }}</b><span>{{ t('billing.perUser') }}</span></p>
        <p class="tagline">{{ t(`billing.tagline.${p}`) }}</p>
        <ul class="feats">
          <li v-for="(x, i) in list(`billing.features.${p}`)" :key="i"><Check :size="16" />{{ x }}</li>
        </ul>
        <p class="for-seats">{{ t('billing.forSeats', { n: billing.seats, total: money(billing.seats * billing.pricesCents[p]) }, billing.seats) }}</p>
        <div class="act">
          <Button v-if="isCurrent(p)" disabled block>{{ t('billing.currentPlan') }}</Button>
          <Button v-else variant="primary" block :disabled="!s.isOwner" :loading="busy === p" @click="choose(p)">{{ t('billing.choose') }}</Button>
          <small v-if="!s.isOwner">{{ t('billing.ownerOnly') }}</small>
        </div>
      </article>
    </div>

    <Modal v-model="simOpen" :title="t('billing.simTitle')" :subtitle="t('billing.simSubtitle')" width="460px">
      <dl v-if="simPlan" class="sim">
        <dt>{{ t('settings.planName') }}</dt><dd>{{ t(`settings.plans.${simPlan}`) }}</dd>
        <dt>{{ t('billing.seats') }}</dt><dd>{{ billing.seats }}</dd>
        <dt>{{ t('billing.total') }}</dt><dd><b>{{ money(billing.seats * billing.pricesCents[simPlan]) }}</b> {{ t('billing.perMonth') }}</dd>
      </dl>
      <template #footer>
        <Button @click="closeSim">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="busy === 'paid'" @click="simulate('paid', simPlan!)">{{ t('billing.simConfirm') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.billing { display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; max-width: 1320px; }
.card { background: var(--color-surface); box-shadow: var(--shadow-md); }
h2, h3 { margin: 0; }
/* Columna principal ancha + contexto angosto */
.top { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(300px, .7fr); gap: 22px; align-items: stretch; }

.current { display: grid; grid-template-rows: auto 1fr auto auto; border-left: 4px solid var(--color-primary); }
.current.past_due, .current.read_only { border-left-color: var(--color-warning); }
.current.suspended, .current.closing { border-left-color: var(--color-danger); }
.current.active { border-left-color: var(--color-success); }
.cur-head { display: flex; align-items: center; gap: 14px; padding: 20px 22px 0; }
.cur-ico { width: 46px; height: 46px; display: grid; place-items: center; flex: none; background: var(--color-ink); color: var(--color-primary); box-shadow: var(--shadow-sm); }
.cur-ttl { flex: 1; display: grid; }
.cur-ttl small { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--color-muted); }
.cur-ttl h2 { font-size: 24px; }
.cur-body { display: grid; gap: 10px; align-content: center; padding: 18px 22px; }
.big { display: flex; align-items: center; gap: 14px; }
.big b { font: 800 46px/1 var(--font-display); color: var(--color-ink); font-variant-numeric: tabular-nums; }
.big span { display: grid; font-weight: 600; font-size: 16px; }
.big small { font-weight: 400; font-size: 13px; color: var(--color-muted); }
.big-ico { color: var(--color-success); }
.explain { margin: 0; max-width: 62ch; color: var(--color-muted); line-height: 1.5; }
.facts { display: grid; grid-template-columns: 1fr 1fr; margin: 0; border-top: 1px solid var(--color-line); }
.facts > div { display: grid; gap: 2px; padding: 14px 22px; }
.facts > div + div { border-left: 1px solid var(--color-line); }
.facts dt { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--color-muted); }
.facts dd { margin: 0; font: 800 24px var(--font-display); font-variant-numeric: tabular-nums; }
.facts small { font-size: 12px; color: var(--color-muted); }
.cur-foot { display: flex; align-items: center; gap: 12px; padding: 14px 22px; background: var(--color-canvas); border-top: 1px solid var(--color-line); }
.cur-foot small, .act small { font-size: 12px; color: var(--color-muted); }

.side { display: grid; gap: 22px; align-content: start; }
.how, .tools { display: grid; gap: 10px; padding: 18px 20px; }
.how h3, .tools h3 { display: flex; align-items: center; gap: 8px; font-size: 16px; }
.how ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 14px; color: var(--color-muted); line-height: 1.45; }
/* Herramientas de prueba: discretas, sobre el fondo del área y con borde punteado */
.tools { background: var(--color-canvas); box-shadow: none; border: 1px dashed var(--color-line-strong); }
.tools p { margin: 0; font-size: 13px; color: var(--color-muted); }
.tools-row { display: flex; flex-wrap: wrap; gap: 8px; }

.cmp-title { font-size: 18px; margin-top: 4px; }
.plans { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; align-items: stretch; }
.plan { display: grid; grid-template-rows: auto auto auto 1fr auto auto; gap: 12px; padding: 22px 24px; border-top: 4px solid var(--color-line-strong); transition: box-shadow var(--duration), transform var(--duration); }
.plan:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); }
.plan.pro { border-top-color: var(--color-primary); }
.plan.now { border-top-color: var(--color-success); }
.plan header { display: flex; align-items: center; gap: 10px; }
.plan h3 { font-size: 20px; }
.price { display: flex; align-items: baseline; gap: 8px; margin: 0; }
.price b { font: 800 38px/1 var(--font-display); font-variant-numeric: tabular-nums; }
.price span { color: var(--color-muted); font-size: 14px; }
.tagline { margin: 0; color: var(--color-muted); font-size: 14px; }
.feats { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; align-content: start; font-size: 14px; }
.feats li { display: flex; gap: 8px; align-items: flex-start; }
.feats .lucide { color: var(--color-success); margin-top: 2px; }
.for-seats { margin: 0; padding: 10px 12px; font-size: 14px; background: var(--color-canvas); border-left: 3px solid var(--color-leaf); }
.act { display: grid; gap: 6px; }

.sim { display: grid; grid-template-columns: auto 1fr; gap: 10px 18px; margin: 0; font-size: 15px; }
.sim dt { color: var(--color-muted); }
.sim dd { margin: 0; }

@media (max-width: 1023px) { .top, .plans { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 520px) {
  .facts { grid-template-columns: 1fr; }
  .facts > div + div { border-left: 0; border-top: 1px solid var(--color-line); }
  .big b { font-size: 38px; }
}
</style>
