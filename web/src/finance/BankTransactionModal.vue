<script setup lang="ts">
// Carga manual rápida de movimientos y edición. Pensado para cargar varios seguidos: "Guardar y otro" conserva cuenta,
// fecha, dirección y compañía, limpia el resto y vuelve al monto. El monto se escribe en positivo y la dirección va en
// un selector (entrada/salida), nunca con signo. Si el servidor avisa `possibleDuplicate`, se muestra un aviso amarillo
// con la opción de borrar lo recién guardado (ADR 0007: la carga manual no se bloquea).
// En los importados de CSV solo se editan compañía, notas y estado de cruce.
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { TriangleAlert, ArrowDownLeft, ArrowUpRight, Hash, Lock } from 'lucide-vue-next';
import { MATCH_STATUS, type BankTransaction, type MatchStatus } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Textarea from '@/design/Textarea.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { today, cents, usd, fmtDay } from './format.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ transaction?: BankTransaction | null; accountId?: string }>();
/** `saved` en cada guardado (también con "Guardar y otro") para que la lista se refresque */
const emit = defineEmits<{ saved: [] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const money = (n: number) => usd(n, locale.value);

const f = reactive({
  accountId: '', postedOn: '', direction: 'in' as 'in' | 'out', amount: '', reference: '', description: '',
  carrierId: '', notes: '', matchStatus: 'unmatched' as MatchStatus,
});
const error = ref<string | null>(null);
const busy = ref(false);
/** Movimientos cargados en esta tanda y el último que parece duplicado */
const batch = ref(0);
const dup = ref<(BankTransaction & { possibleDuplicate: boolean }) | null>(null);
/** "Guardar" con duplicado: el modal se queda abierto para decidir si se borra */
const dupHold = ref(false);
const form = ref<HTMLFormElement>();

const editing = computed(() => props.transaction ?? null);
const imported = computed(() => editing.value?.source === 'csv');
const activeAccounts = computed(() => fin.accounts.filter((a) => a.isActive || a.id === f.accountId));

watch(open, (v) => {
  if (!v) return;
  const x = props.transaction;
  const firstActive = fin.accounts.find((a) => a.isActive)?.id ?? '';
  Object.assign(f, {
    accountId: x?.accountId ?? (props.accountId && fin.account(props.accountId)?.isActive ? props.accountId : firstActive),
    postedOn: x?.postedOn ?? today(), direction: x && x.amount < 0 ? 'out' : 'in', amount: x ? String(Math.abs(x.amount)) : '',
    reference: x?.reference ?? '', description: x?.description ?? '', carrierId: x?.carrierId ?? '', notes: x?.notes ?? '',
    matchStatus: x?.matchStatus ?? 'unmatched',
  });
  error.value = null; batch.value = 0; dup.value = null; dupHold.value = false;
});

const accountOptions = computed(() => activeAccounts.value.map((a) => ({ value: a.id, label: a.name, hint: a.last4 ? `•••• ${a.last4}` : undefined })));
const carrierOptions = computed(() => [{ value: '', label: t('finance.bank.noCarrier') },
  ...fin.carriers.filter((c) => !c.archivedAt || c.id === f.carrierId).map((c) => ({ value: c.id, label: c.name }))]);
const matchOptions = computed(() => MATCH_STATUS.map((m) => ({ value: m, label: t(`finance.bank.match.${m}`) })));
const valid = computed(() => !!f.accountId && !!f.postedOn && Number(f.amount) > 0 && !busy.value);

function resetForNext() {
  Object.assign(f, { amount: '', reference: '', description: '', notes: '' });
  nextTick(() => form.value?.querySelector<HTMLInputElement>('.amt input')?.focus());
}

async function save(another: boolean) {
  if (!valid.value) return;
  busy.value = true;
  error.value = null;
  const params = { slug: s.workspace!.slug };
  const signed = cents(f.amount) * (f.direction === 'out' ? -1 : 1);
  try {
    if (editing.value) {
      const common = { carrierId: f.carrierId || null, notes: f.notes, matchStatus: f.matchStatus };
      await api('PATCH /w/:slug/finance/bank/transactions/:id', { params: { ...params, id: editing.value.id },
        body: imported.value ? common : { ...common, postedOn: f.postedOn, amount: signed, reference: f.reference.trim(), description: f.description.trim() } });
      toast(t('common.saved'), 'success');
      emit('saved');
      open.value = false;
      return;
    }
    const saved = await api('POST /w/:slug/finance/bank/transactions', { params, body: {
      accountId: f.accountId, postedOn: f.postedOn, amount: signed, reference: f.reference.trim(), description: f.description.trim(),
      carrierId: f.carrierId || null, notes: f.notes,
    } });
    batch.value++;
    emit('saved');
    dup.value = saved.possibleDuplicate ? saved : null;
    if (another) { resetForNext(); toast(t('finance.bank.manual.savedNext', { n: batch.value }), 'success'); }
    else if (saved.possibleDuplicate) dupHold.value = true;
    else { toast(t('common.saved'), 'success'); open.value = false; }
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

/** Borra el movimiento recién guardado que parece duplicado */
async function removeDup() {
  const x = dup.value;
  if (!x) return;
  busy.value = true;
  try {
    await api('DELETE /w/:slug/finance/bank/transactions/:id', { params: { slug: s.workspace!.slug, id: x.id } });
    batch.value = Math.max(0, batch.value - 1);
    dup.value = null;
    toast(t('finance.bank.manual.dupRemoved'), 'success');
    emit('saved');
    if (dupHold.value) open.value = false;
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="editing ? t('finance.bank.manual.edit') : t('finance.bank.manual.title')"
    :subtitle="editing ? (imported ? t('finance.bank.manual.importedHint') : '') : t('finance.bank.manual.hint')" width="620px">
    <!-- Aviso de posible duplicado: lo recién guardado coincide en fecha, monto y referencia (o descripción) -->
    <div v-if="dup" class="dup" role="alert">
      <TriangleAlert :size="18" />
      <div>
        <b>{{ t('finance.bank.manual.dupTitle') }}</b>
        <span>{{ t('finance.bank.manual.dupText', { date: fmtDay(dup.postedOn, locale), amount: money(dup.amount), ref: dup.reference || dup.description }) }}</span>
      </div>
      <Button size="sm" variant="danger" :loading="busy" @click="removeDup">{{ t('finance.bank.manual.dupRemove') }}</Button>
    </div>

    <form v-if="!dupHold" id="bank-tx-form" ref="form" class="grid gap-4" novalidate @submit.prevent="save(!editing)">
      <!-- Movimiento importado: lo del banco no se toca -->
      <div v-if="imported && editing" class="locked">
        <Lock :size="15" />
        <span><b>{{ fmtDay(editing.postedOn, locale) }}</b> · {{ editing.description || '—' }}</span>
        <b class="m" :class="editing.amount > 0 ? 'in' : 'out'">{{ money(editing.amount) }}</b>
        <small v-if="editing.reference">{{ t('finance.bank.reference') }}: {{ editing.reference }}</small>
      </div>
      <template v-else>
        <div class="row">
          <Dropdown v-if="!editing" v-model="f.accountId" :options="accountOptions" :label="t('finance.bank.account')" :placeholder="t('finance.bank.pickAccount')" />
          <label class="date">{{ t('finance.bank.date') }}<input v-model="f.postedOn" type="date"></label>
        </div>
        <!-- Dirección + monto: el selector manda el signo -->
        <div class="money">
          <div class="dir" role="radiogroup" :aria-label="t('finance.bank.direction')">
            <button type="button" role="radio" class="in" :aria-checked="f.direction === 'in'" @click="f.direction = 'in'"><ArrowDownLeft :size="17" />{{ t('finance.bank.inflow') }}</button>
            <button type="button" role="radio" class="out" :aria-checked="f.direction === 'out'" @click="f.direction = 'out'"><ArrowUpRight :size="17" />{{ t('finance.bank.outflow') }}</button>
          </div>
          <Input v-model="f.amount" class="amt" :class="f.direction" type="number" prefix="$" :label="t('finance.bank.amount')" placeholder="0.00" />
        </div>
        <div class="ref">
          <span class="ref-ico"><Hash :size="18" /></span>
          <Input v-model="f.reference" :label="t('finance.bank.reference')" :placeholder="t('finance.bank.referencePh')" :hint="t('finance.bank.referenceHint')" />
        </div>
        <Input v-model="f.description" :label="t('finance.bank.description')" :placeholder="t('finance.bank.descriptionPh')" />
      </template>

      <div class="row">
        <Dropdown v-if="fin.carriers.length" v-model="f.carrierId" :options="carrierOptions" searchable :search-placeholder="t('finance.bank.searchCarrier')" :label="t('finance.bank.carrier')" />
        <div v-if="editing" class="match">
          <span class="lbl">{{ t('finance.bank.matchLabel') }}</span>
          <div class="seg3" role="radiogroup" :aria-label="t('finance.bank.matchLabel')">
            <button v-for="m in matchOptions" :key="m.value" type="button" role="radio" :aria-checked="f.matchStatus === m.value" @click="f.matchStatus = m.value">{{ m.label }}</button>
          </div>
        </div>
      </div>
      <Textarea v-if="editing" v-model="f.notes" :label="t('finance.bank.notes')" :rows="2" />
      <p v-if="!editing && batch" class="batch">{{ t('finance.bank.manual.batch', { n: batch }, batch) }}</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <!-- Enter dentro del formulario = "Guardar y otro" al crear -->
      <button type="submit" hidden />
    </form>
    <template #footer>
      <template v-if="dupHold">
        <Button variant="primary" @click="open = false">{{ t('finance.bank.manual.dupKeep') }}</Button>
      </template>
      <template v-else>
        <Button variant="ghost" @click="open = false">{{ batch && !editing ? t('common.close') : t('common.cancel') }}</Button>
        <Button v-if="!editing" :loading="busy" :disabled="!valid" @click="save(false)">{{ t('common.save') }}</Button>
        <Button variant="primary" :loading="busy" :disabled="!valid" @click="save(!editing)">{{ editing ? t('common.save') : t('finance.bank.manual.saveNext') }}</Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.money { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: end; }
.dir { display: flex; border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); }
.dir button { display: inline-flex; align-items: center; gap: 6px; min-height: 42px; padding: 0 14px; font: inherit; font-size: 14px; font-weight: 600; color: var(--color-muted);
  background: var(--color-surface); border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.dir button + button { border-left: 1px solid var(--color-line); }
.dir button.in[aria-checked="true"] { color: #fff; background: var(--color-success); }
.dir button.out[aria-checked="true"] { color: #fff; background: var(--color-ink); }
.amt :deep(input) { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.amt.in :deep(.box) { border-left: 4px solid var(--color-success); }
.amt.out :deep(.box) { border-left: 4px solid var(--color-ink); }
/* Referencia destacada: es lo que después cruza con el depósito de la compañía */
.ref { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; padding: 12px 14px 10px 0; background: var(--color-primary-light); border-left: 4px solid var(--color-primary); }
.ref-ico { display: grid; place-items: center; width: 36px; height: 36px; margin-top: 22px; color: #8A4B00; }
.ref :deep(input:not(:placeholder-shown)) { font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace; letter-spacing: .02em; }
.match { display: grid; gap: 6px; }
.lbl { font-size: 13px; font-weight: 500; }
.seg3 { display: flex; border: 1px solid var(--color-line-strong); }
.seg3 button { flex: 1; min-height: 40px; padding: 0 8px; font: inherit; font-size: 13px; font-weight: 500; color: var(--color-ink); background: var(--color-surface); border: 0; cursor: pointer; }
.seg3 button + button { border-left: 1px solid var(--color-line); }
.seg3 button[aria-checked="true"] { color: #fff; background: var(--color-ink); }
.locked { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 12px 14px; font-size: 14px; background: var(--color-canvas); border-left: 3px solid var(--color-line-strong); }
.locked svg { color: var(--color-muted); flex: none; }
.locked span { flex: 1; min-width: 0; }
.locked small { flex-basis: 100%; color: var(--color-muted); }
.m { font-variant-numeric: tabular-nums; }
.m.in { color: var(--color-success); }
.dup { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 12px; margin-bottom: 16px; padding: 12px 14px; color: var(--color-warning); background: var(--color-warning-light); border-left: 4px solid var(--color-warning); box-shadow: var(--shadow-sm); }
.dup svg { flex: none; margin-top: 2px; }
.dup div { flex: 1; min-width: 220px; display: grid; gap: 2px; color: var(--color-ink); font-size: 14px; line-height: 1.45; }
.batch { margin: 0; font-size: 13px; color: var(--color-success); font-weight: 600; }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 560px) {
  .row, .money { grid-template-columns: 1fr; }
  .dir button { flex: 1; justify-content: center; }
}
</style>
