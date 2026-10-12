<script setup lang="ts">
// Plantillas de gastos recurrentes: tarjetas hermanas con la regla, el monto, la próxima fecha y su estado
// (activa/pausada, por aprobar/rechazada). Owner/Admin aprueban o rechazan las que cargó un Contable.
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Pencil, Pause, Play, Repeat, Check, Ban, CalendarClock } from 'lucide-vue-next';
import type { ExpenseSchedule } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toneColor } from '@/design/types.ts';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { usd, fmtDay, scheduleRule } from './format.ts';
import ScheduleModal from './ScheduleModal.vue';

const props = defineProps<{ schedules: ExpenseSchedule[] | null }>();
const emit = defineEmits<{ changed: [] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);

/** Por aprobar primero; luego activas antes que pausadas; por proveedor */
const sorted = computed(() => [...(props.schedules ?? [])].sort((a, b) =>
  Number(b.approvalStatus === 'pending') - Number(a.approvalStatus === 'pending')
  || Number(a.status === 'paused') - Number(b.status === 'paused') || a.vendor.localeCompare(b.vendor)));
/** Monto mensual aproximado de las activas aprobadas: da una idea del gasto fijo */
const monthly = computed(() => (props.schedules ?? []).filter((x) => x.status === 'active' && x.approvalStatus === 'approved' && x.nextDueDate)
  .reduce((n, x) => {
    const per = x.frequency === 'monthly' ? 1 / x.interval
      : x.frequency === 'weekly' ? (52 / 12) * (x.weekdays?.length ?? 1) / x.interval
      : (x.businessDaysOnly ? 21.7 : 30.4) / x.interval;
    return n + x.amount * per;
  }, 0));

const modal = ref(false);
const editing = ref<ExpenseSchedule | null>(null);
const openEdit = (x: ExpenseSchedule | null) => { editing.value = x; modal.value = true; };

const busy = ref<string | null>(null);
async function act(x: ExpenseSchedule, fn: () => Promise<unknown>, ok: string) {
  busy.value = x.id;
  try {
    await fn();
    toast(ok, 'success');
    emit('changed');
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = null; }
}
const params = (id: string) => ({ slug: s.workspace!.slug, id });
const toggle = (x: ExpenseSchedule) => act(x, () => api('PATCH /w/:slug/finance/expense-schedules/:id',
  { params: params(x.id), body: { status: x.status === 'active' ? 'paused' : 'active' } }), x.status === 'active' ? t('finance.schedules.pausedOk') : t('finance.schedules.resumedOk'));
const approve = (x: ExpenseSchedule) => act(x, () => api('POST /w/:slug/finance/expense-schedules/:id/approve', { params: params(x.id) }), t('finance.approval.approvedOk'));
const reject = (x: ExpenseSchedule) => act(x, () => api('POST /w/:slug/finance/expense-schedules/:id/reject', { params: params(x.id) }), t('finance.approval.rejectedOk'));
</script>

<template>
  <section class="sched">
    <header class="head">
      <div>
        <h2><Repeat :size="20" />{{ t('finance.schedules.title') }}</h2>
        <small>{{ t('finance.schedules.hint') }}</small>
      </div>
      <div v-if="schedules?.length" class="fixed"><small>{{ t('finance.schedules.monthly') }}</small><b>{{ money(Math.round(monthly * 100) / 100) }}</b></div>
      <Button variant="primary" @click="openEdit(null)"><Plus :size="17" />{{ t('finance.schedules.new') }}</Button>
    </header>

    <div v-if="!schedules" class="grid gap-3"><Skeleton v-for="n in 3" :key="n" height="120px" /></div>
    <EmptyState v-else-if="!schedules.length" :icon="CalendarClock" :title="t('finance.schedules.empty')" :text="t('finance.schedules.emptyText')">
      <Button variant="primary" @click="openEdit(null)"><Plus :size="16" />{{ t('finance.schedules.new') }}</Button>
    </EmptyState>
    <div v-else class="cards">
      <article v-for="x in sorted" :key="x.id" class="card" :class="{ paused: x.status === 'paused', off: x.approvalStatus === 'rejected' }"
        :style="{ borderLeftColor: toneColor(fin.category(x.categoryId)?.color ?? 'gray') }">
        <header>
          <div class="who"><b>{{ x.vendor }}</b><small v-if="x.concept">{{ x.concept }}</small></div>
          <b class="amt">{{ money(x.amount) }}</b>
        </header>
        <p class="rule"><Repeat :size="15" />{{ scheduleRule(x, t, locale) }}</p>
        <dl>
          <dt>{{ t('finance.schedules.next') }}</dt>
          <dd>{{ x.status === 'paused' ? t('finance.schedules.pausedShort') : x.nextDueDate ? day(x.nextDueDate) : t('finance.schedules.ended') }}</dd>
          <dt>{{ t('finance.schedules.period') }}</dt>
          <dd>{{ x.endsOn ? t('finance.schedules.fromTo', { from: day(x.startsOn), to: day(x.endsOn) }) : t('finance.schedules.fromOnly', { from: day(x.startsOn) }) }}</dd>
        </dl>
        <div class="tags">
          <Badge v-if="fin.category(x.categoryId)" :tone="fin.category(x.categoryId)!.color">{{ fin.category(x.categoryId)!.name }}</Badge>
          <Badge tone="neutral">{{ t(`finance.methods.${x.payMethod}`) }}</Badge>
          <Badge v-if="x.approvalStatus === 'pending'" tone="warning">{{ t('finance.approval.pending') }}</Badge>
          <Badge v-else-if="x.approvalStatus === 'rejected'" tone="danger">{{ t('finance.approval.rejected') }}</Badge>
          <Badge v-if="x.status === 'paused'" tone="neutral"><Pause :size="12" />{{ t('finance.schedules.paused') }}</Badge>
        </div>
        <footer>
          <template v-if="x.approvalStatus === 'pending' && fin.canApprove">
            <Button size="sm" variant="primary" :loading="busy === x.id" @click="approve(x)"><Check :size="15" />{{ t('finance.approval.approve') }}</Button>
            <Button size="sm" variant="ghost" :disabled="busy === x.id" @click="reject(x)"><Ban :size="15" />{{ t('finance.approval.reject') }}</Button>
          </template>
          <span class="sp" />
          <button v-if="x.approvalStatus === 'approved'" type="button" class="ico" :disabled="busy === x.id"
            :title="x.status === 'active' ? t('finance.schedules.pause') : t('finance.schedules.resume')"
            :aria-label="x.status === 'active' ? t('finance.schedules.pause') : t('finance.schedules.resume')" @click="toggle(x)">
            <Pause v-if="x.status === 'active'" :size="16" /><Play v-else :size="16" />
          </button>
          <button type="button" class="ico" :title="t('finance.schedules.edit')" :aria-label="t('finance.schedules.edit')" @click="openEdit(x)"><Pencil :size="16" /></button>
        </footer>
      </article>
    </div>

    <ScheduleModal v-model="modal" :schedule="editing" @saved="emit('changed')" />
  </section>
</template>

<style scoped>
.sched { display: grid; gap: 16px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; }
.head > div:first-child { flex: 1; min-width: 240px; display: grid; gap: 2px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.head small { color: var(--color-muted); }
.fixed { display: grid; justify-items: end; padding: 6px 14px; background: var(--color-surface); border-right: 4px solid var(--color-ink); box-shadow: var(--shadow-sm); }
.fixed b { font-family: var(--font-display); font-size: 20px; font-variant-numeric: tabular-nums; }
.fixed small { font-size: 12px; }

/* Tarjetas hermanas: mismo ancho y alto, acciones al pie alineadas */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; align-items: stretch; }
.card { display: grid; grid-template-rows: auto auto 1fr auto auto; gap: 10px; padding: 16px 18px 12px; background: var(--color-surface); border-left: 4px solid var(--color-line-strong);
  box-shadow: var(--shadow-md); transition: box-shadow var(--duration), transform var(--duration); }
.card:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); }
.card.paused { background: var(--color-canvas); }
.card.paused .amt, .card.off .amt { color: var(--color-muted); }
.card.off .who b { text-decoration: line-through; color: var(--color-muted); }
.card header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.who { display: grid; gap: 2px; min-width: 0; }
.who b { font-size: 16px; overflow-wrap: anywhere; }
.who small { color: var(--color-muted); font-size: 13px; }
.amt { font-family: var(--font-display); font-size: 20px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rule { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 14px; font-weight: 600; text-transform: none; }
.rule svg { color: var(--color-primary-dark); flex: none; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 13px; align-content: start; }
dt { color: var(--color-muted); }
dd { margin: 0; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
footer { display: flex; align-items: center; gap: 6px; margin: 0 -8px 0 0; padding-top: 10px; border-top: 1px solid var(--color-line); }
.sp { flex: 1; }
.ico { display: grid; place-items: center; width: 34px; height: 34px; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }
@media (max-width: 767px) {
  .cards { grid-template-columns: minmax(0, 1fr); }
  .fixed { order: 3; }
}
</style>
