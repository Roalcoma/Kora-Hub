<script setup lang="ts">
// Componentes de pago de una persona: sueldo, por hora, comisión de ventas, % de ventas, bono y deducciones.
// Cada uno con vigencia: un aumento se registra cerrando el vigente y creando otro, así las corridas pasadas no cambian.
// En una corrida se usan los vigentes a la fecha de FIN del periodo (sin prorrateo).
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Pencil, Trash2, TriangleAlert, Info } from 'lucide-vue-next';
import { COMPONENT_KINDS, RATE_KINDS, type ComponentKind, type PayrollComponent, type PayrollPerson } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import EmptyState from '@/design/EmptyState.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { usd, fmtDay, today, cents } from './format.ts';

const props = defineProps<{ person: PayrollPerson | null }>();
const emit = defineEmits<{ close: []; saved: [person: PayrollPerson] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const money = (n: number) => usd(n, locale.value);
const day = (x: string) => fmtDay(x, locale.value);

const open = computed({ get: () => !!props.person, set: (v) => { if (!v) emit('close'); } });
/** La persona se refresca con cada respuesta del servidor (devuelve la persona completa) */
const current = ref<PayrollPerson | null>(null);
watch(() => props.person, (p) => { current.value = p; reset(); });

const SALES_KINDS: ComponentKind[] = ['sales_commission', 'sales_percent'];
const isRate = (k: ComponentKind) => RATE_KINDS.includes(k);
const isDeduction = (k: ComponentKind) => k === 'deduction_fixed' || k === 'deduction_percent';

// ─── Formulario (crear o editar) ───
const editing = ref<PayrollComponent | null>(null);
const f = reactive({ kind: 'salary' as ComponentKind, label: '', value: '', effectiveFrom: '', effectiveTo: '' });
function reset(c: PayrollComponent | null = null) {
  editing.value = c;
  Object.assign(f, {
    kind: c?.kind ?? 'salary', label: c?.label ?? '', value: c ? String((isRate(c.kind) ? c.rate : c.amount) ?? '') : '',
    effectiveFrom: c?.effectiveFrom ?? today(), effectiveTo: c?.effectiveTo ?? '',
  });
  error.value = null;
}
const kindOptions = computed(() => COMPONENT_KINDS.map((k) => ({ value: k, label: t(`finance.payroll.kinds.${k}`), hint: t(`finance.payroll.kindHints.${k}`) })));
const needsValue = computed(() => f.kind !== 'sales_commission');
const valueBad = computed(() => needsValue.value && !!f.value && (Number(f.value) <= 0 || (isRate(f.kind) && Number(f.value) > 100)));
const endsBad = computed(() => !!f.effectiveTo && !!f.effectiveFrom && f.effectiveTo < f.effectiveFrom);
const valid = computed(() => f.effectiveFrom && !endsBad.value && (!needsValue.value || (Number(f.value) > 0 && !valueBad.value)));
const noUserWarn = computed(() => SALES_KINDS.includes(f.kind) && !current.value?.userId);

const busy = ref(false);
const error = ref<string | null>(null);
async function save() {
  const p = current.value!;
  busy.value = true;
  error.value = null;
  const v = needsValue.value ? cents(f.value) : null;
  const amount = needsValue.value && !isRate(f.kind) ? v : null;
  const rate = isRate(f.kind) ? Math.round(Number(f.value) * 1000) / 1000 : null;
  const base = { label: f.label.trim(), amount, rate, effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo || null };
  try {
    const slug = s.workspace!.slug;
    current.value = editing.value
      ? await api('PATCH /w/:slug/finance/payroll/components/:id', { params: { slug, id: editing.value.id }, body: base })
      : await api('POST /w/:slug/finance/payroll/people/:id/components', { params: { slug, id: p.id }, body: { ...base, kind: f.kind } });
    toast(t('common.saved'), 'success');
    emit('saved', current.value);
    reset();
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}

/** Quitar pide confirmar en el mismo botón (segundo clic) */
const confirming = ref<string | null>(null);
async function remove(c: PayrollComponent) {
  if (confirming.value !== c.id) { confirming.value = c.id; return; }
  busy.value = true;
  try {
    current.value = await api('DELETE /w/:slug/finance/payroll/components/:id', { params: { slug: s.workspace!.slug, id: c.id } });
    toast(t('finance.payroll.comp.removedOk'), 'success');
    emit('saved', current.value);
    if (editing.value?.id === c.id) reset();
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; confirming.value = null; }
}

/** Vigente hoy, futuro o terminado */
function state(c: PayrollComponent): { tone: 'success' | 'primary' | 'neutral'; label: string } {
  const now = today();
  if (c.effectiveFrom > now) return { tone: 'primary', label: t('finance.payroll.comp.future') };
  if (c.effectiveTo && c.effectiveTo < now) return { tone: 'neutral', label: t('finance.payroll.comp.ended') };
  return { tone: 'success', label: t('finance.payroll.comp.current') };
}
const valueText = (c: PayrollComponent) => c.kind === 'sales_commission' ? t('finance.payroll.comp.fromSales')
  : isRate(c.kind) ? `${c.rate} %` : c.kind === 'hourly' ? t('finance.payroll.comp.perHour', { amount: money(c.amount ?? 0) })
  : t('finance.payroll.comp.perPeriod', { amount: money(c.amount ?? 0) });
const vigencia = (c: PayrollComponent) => c.effectiveTo
  ? t('finance.schedules.fromTo', { from: day(c.effectiveFrom), to: day(c.effectiveTo) })
  : t('finance.schedules.fromOnly', { from: day(c.effectiveFrom) });
const subtitle = computed(() => {
  const p = current.value;
  if (!p) return '';
  return [p.jobTitle, fin.calendar(p.calendarId)?.name, p.userId ? fin.memberName(p.userId) : t('finance.payroll.people.noUserShort')].filter(Boolean).join(' · ');
});
</script>

<template>
  <Modal v-model="open" :title="t('finance.payroll.comp.title', { name: current?.name ?? '' })" :subtitle="subtitle" width="760px">
    <div class="wrap">
      <p class="info"><Info :size="16" />{{ t('finance.payroll.comp.commissionHint') }}</p>

      <EmptyState v-if="!current?.components.length" :title="t('finance.payroll.comp.empty')" :text="t('finance.payroll.comp.emptyText')" />
      <ul v-else class="list">
        <li v-for="c in current.components" :key="c.id" :class="{ ded: isDeduction(c.kind), on: editing?.id === c.id, old: state(c).tone === 'neutral' }">
          <div class="what">
            <b>{{ c.label || t(`finance.payroll.kinds.${c.kind}`) }}</b>
            <small><template v-if="c.label">{{ t(`finance.payroll.kinds.${c.kind}`) }} · </template>{{ vigencia(c) }}</small>
          </div>
          <span class="val">{{ isDeduction(c.kind) ? '−' : '' }}{{ valueText(c) }}</span>
          <Badge :tone="state(c).tone">{{ state(c).label }}</Badge>
          <span class="acts">
            <button type="button" class="ico" :title="t('finance.payroll.comp.edit')" :aria-label="t('finance.payroll.comp.edit')" @click="reset(c)"><Pencil :size="16" /></button>
            <button type="button" class="ico" :class="{ confirm: confirming === c.id }" :disabled="busy" :title="t('finance.payroll.comp.remove')"
              :aria-label="t('finance.payroll.comp.remove')" @click="remove(c)" @blur="confirming = null">
              <Trash2 :size="16" /><span v-if="confirming === c.id">{{ t('finance.payroll.comp.confirmRemove') }}</span>
            </button>
          </span>
        </li>
      </ul>

      <form id="pcomp-form" class="form" novalidate @submit.prevent="valid && save()">
        <h3>{{ editing ? t('finance.payroll.comp.edit') : t('finance.payroll.comp.add') }}</h3>
        <div class="row">
          <Dropdown v-model="f.kind" :options="kindOptions" :disabled="!!editing" :label="t('finance.payroll.comp.kind')" />
          <Input v-model="f.label" :label="t('finance.payroll.comp.label')" :placeholder="t(`finance.payroll.kinds.${f.kind}`)" />
        </div>
        <div class="row three">
          <Input v-if="needsValue" v-model="f.value" type="number" :prefix="isRate(f.kind) ? '%' : '$'"
            :label="isRate(f.kind) ? t('finance.payroll.comp.rate') : f.kind === 'hourly' ? t('finance.payroll.comp.hourRate') : t('finance.payroll.comp.amount')"
            :error="valueBad ? t('finance.payroll.comp.valueBad') : null" />
          <p v-else class="auto">{{ t('finance.payroll.comp.autoCommission') }}</p>
          <label class="date">{{ t('finance.payroll.comp.from') }}<input v-model="f.effectiveFrom" type="date"></label>
          <label class="date" :class="{ invalid: endsBad }">{{ t('finance.payroll.comp.to') }}<input v-model="f.effectiveTo" type="date" :min="f.effectiveFrom || undefined">
            <small>{{ endsBad ? t('finance.schedules.endsBad') : t('finance.schedules.endsHint') }}</small></label>
        </div>
        <p v-if="noUserWarn" class="warn"><TriangleAlert :size="16" />{{ t('finance.payroll.comp.noUserWarn') }}</p>
        <p v-if="editing" class="note">{{ t('finance.payroll.comp.editNote') }}</p>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
        <div class="fbtns">
          <Button v-if="editing" variant="ghost" @click="reset()">{{ t('common.cancel') }}</Button>
          <Button variant="primary" type="submit" :loading="busy" :disabled="!valid"><Plus v-if="!editing" :size="16" />{{ editing ? t('common.save') : t('common.add') }}</Button>
        </div>
      </form>
    </div>
    <template #footer>
      <Button variant="ghost" @click="emit('close')">{{ t('common.close') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.wrap { display: grid; gap: 16px; }
.info { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 13px; line-height: 1.45; color: var(--color-muted); }
.info svg { flex: none; margin-top: 1px; color: var(--color-primary-dark); }
.wrap :deep(.empty) { max-width: none; box-shadow: none; background: var(--color-canvas); }
.list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.list li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: 4px 14px; padding: 8px 6px 8px 12px;
  border-top: 1px solid var(--color-line); border-left: 3px solid var(--color-success); transition: background var(--duration); }
.list li:first-child { border-top: 0; }
.list li.ded { border-left-color: var(--color-danger); }
.list li.old { border-left-color: var(--color-line-strong); color: var(--color-muted); }
.list li.on, .list li:hover { background: var(--color-canvas); }
.what { display: grid; gap: 1px; min-width: 0; }
.what b { font-size: 14px; overflow-wrap: anywhere; }
.what small { font-size: 12px; color: var(--color-muted); }
.val { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.acts { display: flex; }
.ico { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 34px; height: 34px; padding: 0 6px; font: inherit; font-size: 12px; font-weight: 600; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }
.ico.confirm { color: #fff; background: var(--color-danger); }
.form { display: grid; gap: 12px; padding: 14px 16px 16px; background: var(--color-canvas); border-left: 3px solid var(--color-primary); }
h3 { margin: 0; font-size: 15px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.row.three { grid-template-columns: 1fr 1fr 1fr; }
.auto { margin: 24px 0 0; padding: 10px 12px; font-size: 13px; line-height: 1.4; background: var(--color-surface); box-shadow: var(--shadow-sm); }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.date small { font-size: 12px; font-weight: 400; color: var(--color-muted); }
.date.invalid input { border-color: var(--color-danger); }
.date.invalid small { color: var(--color-danger); }
.fbtns { display: flex; justify-content: flex-end; gap: 8px; }
.warn { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; font-size: 13px; line-height: 1.45; color: var(--color-ink); background: var(--color-warning-light); border-left: 3px solid var(--color-warning); }
.warn svg { flex: none; margin-top: 1px; color: var(--color-warning); }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-muted); background: var(--color-surface); border-left: 3px solid var(--color-cta); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 600px) {
  .row, .row.three { grid-template-columns: 1fr; }
  .auto { margin-top: 0; }
  .list li { grid-template-columns: minmax(0, 1fr) auto; }
  .what { grid-column: 1 / -1; }
  .acts { justify-self: end; grid-column: 2; grid-row: 3; }
  .list li .val { grid-row: 2; }
  .list li :deep(.badge) { grid-row: 2; justify-self: end; }
}
</style>
