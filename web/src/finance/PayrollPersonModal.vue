<script setup lang="ts">
// Crear o editar una persona en nómina. No necesita usuario de Kora: se enlaza solo si cobra comisión o % de ventas
// (el Dropdown buscable lista a los miembros; los ya enlazados a otra persona se marcan).
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Link2 } from 'lucide-vue-next';
import { PAYROLL_PAY_METHODS, type PayrollPayMethod, type PayrollPerson } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ person?: PayrollPerson | null }>();
const emit = defineEmits<{ saved: [person: PayrollPerson, created: boolean] }>();
const { t } = useI18n();
const s = useSession();
const fin = useFinance();

const f = reactive({
  name: '', jobTitle: '', email: '', phone: '', calendarId: '', payMethod: 'ach' as PayrollPayMethod, accountLast4: '',
  userId: '', hiredOn: '', terminatedOn: '', isActive: true,
});
const busy = ref(false);
const error = ref<string | null>(null);
watch(open, (v) => {
  if (!v) return;
  const p = props.person;
  Object.assign(f, {
    name: p?.name ?? '', jobTitle: p?.jobTitle ?? '', email: p?.email ?? '', phone: p?.phone ?? '',
    calendarId: p?.calendarId ?? fin.calendars.find((c) => !c.archivedAt)?.id ?? '', payMethod: p?.payMethod ?? 'ach',
    accountLast4: p?.accountLast4 ?? '', userId: p?.userId ?? '', hiredOn: p?.hiredOn ?? '', terminatedOn: p?.terminatedOn ?? '',
    isActive: p?.isActive ?? true,
  });
  error.value = null;
});

const calendarOptions = computed(() => fin.calendars.filter((c) => !c.archivedAt || c.id === props.person?.calendarId)
  .map((c) => ({ value: c.id, label: c.name, hint: t(`finance.payroll.freq.${c.frequency}`) })));
const methodOptions = computed(() => PAYROLL_PAY_METHODS.map((m) => ({ value: m, label: t(`finance.methods.${m}`) })));
/** Miembros activos; el hint avisa si ya están enlazados a otra persona (el servidor lo rechazaría) */
const userOptions = computed(() => [{ value: '', label: t('finance.payroll.people.noUser') },
  ...fin.members.filter((m) => m.isActive || m.userId === props.person?.userId).map((m) => {
    const other = fin.people.find((p) => p.userId === m.userId && p.id !== props.person?.id);
    return { value: m.userId, label: m.name, hint: other ? t('finance.payroll.people.linkedTo', { name: other.name }) : m.email };
  })]);

const last4Bad = computed(() => !!f.accountLast4 && !/^\d{4}$/.test(f.accountLast4));
const emailBad = computed(() => !!f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()));
const datesBad = computed(() => !!f.hiredOn && !!f.terminatedOn && f.terminatedOn < f.hiredOn);
const valid = computed(() => f.name.trim() && f.calendarId && !last4Bad.value && !emailBad.value && !datesBad.value);
const orNull = (v: string) => v.trim() || null;

async function save() {
  busy.value = true;
  error.value = null;
  const body = {
    name: f.name.trim(), jobTitle: orNull(f.jobTitle), email: orNull(f.email), phone: orNull(f.phone), calendarId: f.calendarId,
    payMethod: f.payMethod, accountLast4: orNull(f.accountLast4), userId: f.userId || null, hiredOn: f.hiredOn || null,
    terminatedOn: f.terminatedOn || null, isActive: f.isActive,
  };
  try {
    const params = { slug: s.workspace!.slug };
    const saved = props.person
      ? await api('PATCH /w/:slug/finance/payroll/people/:id', { params: { ...params, id: props.person.id }, body })
      : await api('POST /w/:slug/finance/payroll/people', { params, body });
    toast(t('common.saved'), 'success');
    open.value = false;
    emit('saved', saved, !props.person);
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="person ? t('finance.payroll.people.edit') : t('finance.payroll.people.new')" :subtitle="t('finance.payroll.people.newHint')" width="640px">
    <form id="pperson-form" class="grid gap-4" novalidate @submit.prevent="valid && save()">
      <div class="row wide">
        <Input v-model="f.name" :label="t('finance.payroll.people.name')" />
        <Input v-model="f.jobTitle" :label="t('finance.payroll.people.jobTitle')" :placeholder="t('finance.payroll.people.jobTitlePh')" />
      </div>
      <div class="row">
        <Input v-model="f.email" type="email" :label="t('common.email')" :error="emailBad ? t('finance.payroll.people.emailBad') : null" />
        <Input v-model="f.phone" :label="t('finance.payroll.people.phone')" />
      </div>
      <div class="row">
        <Dropdown v-model="f.calendarId" :options="calendarOptions" :label="t('finance.payroll.people.calendar')" :placeholder="t('finance.payroll.people.pickCalendar')" />
        <div class="row tight">
          <Dropdown v-model="f.payMethod" :options="methodOptions" :label="t('finance.payroll.people.method')" />
          <Input v-model="f.accountLast4" :label="t('finance.payroll.people.last4')" placeholder="1234" :error="last4Bad ? t('finance.payroll.people.last4Bad') : null" />
        </div>
      </div>
      <fieldset class="link">
        <Dropdown v-model="f.userId" :options="userOptions" searchable :search-placeholder="t('finance.payroll.people.searchUser')" :label="t('finance.payroll.people.user')" />
        <p class="hint"><Link2 :size="15" />{{ t('finance.payroll.people.userHint') }}</p>
      </fieldset>
      <div class="row">
        <label class="date">{{ t('finance.payroll.people.hiredOn') }}<input v-model="f.hiredOn" type="date"></label>
        <label class="date" :class="{ invalid: datesBad }">{{ t('finance.payroll.people.terminatedOn') }}<input v-model="f.terminatedOn" type="date" :min="f.hiredOn || undefined">
          <small>{{ datesBad ? t('finance.payroll.people.datesBad') : t('finance.payroll.people.terminatedHint') }}</small></label>
      </div>
      <label v-if="person" class="check"><input v-model="f.isActive" type="checkbox">{{ t('finance.payroll.people.activeLabel') }}</label>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
      <Button variant="primary" type="submit" form="pperson-form" :loading="busy" :disabled="!valid">{{ t('common.save') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
.row.wide { grid-template-columns: 1.4fr 1fr; }
.row.tight { grid-template-columns: 1fr 96px; }
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.date small { font-size: 12px; font-weight: 400; color: var(--color-muted); }
.date.invalid input { border-color: var(--color-danger); }
.date.invalid small { color: var(--color-danger); }
.link { display: grid; gap: 8px; margin: 0; padding: 12px 14px; min-width: 0; border: 0; border-left: 3px solid var(--color-primary); background: var(--color-canvas); }
.hint { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 13px; line-height: 1.45; color: var(--color-muted); }
.hint svg { flex: none; margin-top: 2px; color: var(--color-primary-dark); }
.check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; cursor: pointer; }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 560px) { .row, .row.wide { grid-template-columns: 1fr; } }
</style>
