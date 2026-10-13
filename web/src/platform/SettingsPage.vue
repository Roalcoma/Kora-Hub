<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Building2, ShieldCheck, LogOut, UserPlus, BadgeDollarSign, Landmark, KeyRound, UserRoundPlus } from 'lucide-vue-next';
import { INDUSTRIES, type Industry, type Member, type Role } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { setLocale } from '@/i18n/index.ts';
import Tabs from '@/design/Tabs.vue';
import Avatar from '@/design/Avatar.vue';
import Badge from '@/design/Badge.vue';
import Button from '@/design/Button.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import SlideOver from '@/design/SlideOver.vue';
import Modal from '@/design/Modal.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { toneColor } from '@/design/types.ts';
import StructureEditor from './StructureEditor.vue';
import InvitePanel from './InvitePanel.vue';
import BillingPanel from './BillingPanel.vue';
import { errorText } from './errors.ts';
import { timezoneOptions } from './timezones.ts';
import PushSetup from '@/chat/PushSetup.vue';

type Tab = 'members' | 'invitations' | 'structure' | 'workspace' | 'billing' | 'profile';
const { t, d } = useI18n();
const origin = location.origin;
const tzOptions = computed(() => timezoneOptions(s.user!.locale, s.user!.timezone));
const route = useRoute();
const router = useRouter();
const s = useSession();
const slug = computed(() => s.workspace!.slug);

const tabs = computed(() => [
  ...(s.isAdmin ? [
    { value: 'members' as const, label: t('settings.members') },
    { value: 'invitations' as const, label: t('settings.invitations') },
    { value: 'structure' as const, label: t('settings.structure', s.cat) },
    { value: 'workspace' as const, label: t('settings.workspace') },
    { value: 'billing' as const, label: t('settings.billing') },
  ] : []),
  { value: 'profile' as const, label: t('settings.profile') },
]);
const tab = computed<Tab>({
  get: () => (tabs.value.some((x) => x.value === route.params.tab) ? route.params.tab as Tab : tabs.value[0]!.value),
  set: (v) => router.replace(`/w/${slug.value}/settings/${v}`),
});

async function guard(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok, 'success');
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

// ─── Miembros ───
const members = ref<Member[] | null>(null);
const loadMembers = async () => { members.value = await api('GET /w/:slug/members', { params: { slug: slug.value } }); };
watch(tab, (v) => { if (v === 'members' && !members.value) loadMembers(); }, { immediate: true });

const roleOptions = computed(() => (['owner', 'admin', 'lead', 'member', 'accountant', 'guest'] as const).map((r) => ({ value: r, label: t(`roles.${r}`) })));
const deptName = (id: string) => s.workspace!.departments.find((d) => d.id === id)?.name ?? '';

const patchMember = (m: Member, body: { role?: Role; isActive?: boolean; departments?: { id: string; isLead: boolean }[]; lineIds?: string[] }, ok?: string) =>
  guard(async () => {
    Object.assign(m, await api('PATCH /w/:slug/members/:userId', { params: { slug: slug.value, userId: m.userId }, body }));
  }, ok);

const editing = ref<Member | null>(null);
const editOpen = computed({ get: () => !!editing.value, set: (v) => { if (!v) editing.value = null; } });
const draftDepts = ref<Record<string, 'none' | 'member' | 'lead'>>({});
// Líneas de la persona: dentro de sus departamentos solo ve tareas, metas y canales de esas líneas (ninguna = todas)
const draftLines = ref<string[]>([]);
const toggleLine = (id: string) => {
  draftLines.value = draftLines.value.includes(id) ? draftLines.value.filter((x) => x !== id) : [...draftLines.value, id];
};
function editDepts(m: Member) {
  editing.value = m;
  draftLines.value = m.lineIds.filter((id) => s.activeLines.some((l) => l.id === id));
  draftDepts.value = Object.fromEntries(s.workspace!.departments.map((d) => [d.id,
    m.leadOfDepartmentIds.includes(d.id) ? 'lead' : m.departmentIds.includes(d.id) ? 'member' : 'none']));
}
const pickedDepts = () => Object.entries(draftDepts.value).filter(([, v]) => v !== 'none').map(([id, v]) => ({ id, isLead: v === 'lead' }));
async function saveDepts() {
  const m = editing.value!;
  const departments = pickedDepts();
  await patchMember(m, { departments, ...(s.activeLines.length ? { lineIds: draftLines.value } : {}) }, t('common.saved'));
  editing.value = null;
}

// ─── Crear usuario: el Admin define la contraseña (no hace falta correo ni enlace) ───
const newOpen = ref(false);
const nu = reactive({ name: '', email: '', password: '', role: 'member' as Role, title: '' });
const nuError = ref<string | null>(null);
const nuBusy = ref(false);
const newRoleOptions = computed(() => roleOptions.value.filter((o) => o.value !== 'owner' || s.isOwner));
function openNew() {
  Object.assign(nu, { name: '', email: '', password: '', role: 'member', title: '' });
  nuError.value = null;
  draftDepts.value = Object.fromEntries(s.workspace!.departments.map((d) => [d.id, 'none']));
  draftLines.value = [];
  newOpen.value = true;
}
async function createUser() {
  nuBusy.value = true;
  nuError.value = null;
  try {
    const { existingAccount, ...m } = await api('POST /w/:slug/members', { params: { slug: slug.value }, body: {
      name: nu.name.trim(), email: nu.email.trim(), password: nu.password, role: nu.role, title: nu.title.trim() || null,
      departments: pickedDepts(), lineIds: draftLines.value } });
    members.value?.push(m);
    toast(existingAccount ? t('settings.userExisting', { name: m.name }) : t('settings.userCreated', { name: m.name }), 'success');
    newOpen.value = false;
  } catch (e) {
    nuError.value = errorText(e);
  } finally {
    nuBusy.value = false;
  }
}

// ─── Contraseña nueva para alguien de la agencia ───
const pwFor = ref<Member | null>(null);
const pwOpen = computed({ get: () => !!pwFor.value, set: (v) => { if (!v) pwFor.value = null; } });
const newPw = ref('');
const pwError = ref<string | null>(null);
function openPw(m: Member) { pwFor.value = m; newPw.value = ''; pwError.value = null; }
async function savePw() {
  pwError.value = null;
  try {
    await api('PUT /w/:slug/members/:userId/password', { params: { slug: slug.value, userId: pwFor.value!.userId }, body: { password: newPw.value } });
    toast(t('settings.passwordSet', { name: pwFor.value!.name }), 'success');
    pwFor.value = null;
  } catch (e) {
    pwError.value = errorText(e);
  }
}

// ─── Agencia ───
const wsName = ref(s.workspace!.name);
const saveWorkspace = () => guard(async () => {
  await api('PATCH /w/:slug', { params: { slug: slug.value }, body: { name: wsName.value } });
  await s.refreshWorkspace();
}, t('common.saved'));

// ─── Módulos opcionales (ventas y finanzas): se encienden por agencia ───
type ModuleKey = 'salesModule' | 'financeModule';
const modules = computed(() => [
  { key: 'salesModule' as const, icon: BadgeDollarSign, on: s.workspace!.settings.salesModule },
  { key: 'financeModule' as const, icon: Landmark, on: s.workspace!.settings.financeModule },
]);
const moduleBusy = ref<ModuleKey | null>(null);
async function toggleModule(key: ModuleKey, on: boolean) {
  moduleBusy.value = key;
  await guard(async () => {
    await api('PATCH /w/:slug', { params: { slug: slug.value }, body: { settings: key === 'salesModule' ? { salesModule: on } : { financeModule: on } } });
    await s.refreshWorkspace();
  }, on ? t('settings.moduleOn') : t('settings.moduleOff'));
  moduleBusy.value = null;
}

// ─── Estructura: cómo llama la agencia a sus categorías y su rubro ───
const catForm = reactive({
  singular: s.workspace!.settings.categoryLabel?.singular ?? '', plural: s.workspace!.settings.categoryLabel?.plural ?? '',
  industry: s.workspace!.settings.industry as Industry,
});
const industryOptions = computed(() => INDUSTRIES.map((x) => ({ value: x, label: t(`settings.industries.${x}`) })));
const catError = ref<string | null>(null);
function saveCategory() {
  const singular = catForm.singular.trim();
  const plural = catForm.plural.trim();
  catError.value = null;
  // Ambos vacíos = volver al texto por defecto; uno solo no alcanza
  if (!!singular !== !!plural) { catError.value = t('settings.categoryBoth'); return; }
  return guard(async () => {
    await api('PATCH /w/:slug', { params: { slug: slug.value }, body: { settings: {
      categoryLabel: singular ? { singular, plural } : null, industry: catForm.industry } } });
    await s.refreshWorkspace();
  }, t('common.saved'));
}

// ─── Perfil ───
const profile = reactive({ name: s.user!.name, locale: s.user!.locale, timezone: s.user!.timezone, title: s.workspace!.me.title ?? '' });
const localeOptions = [{ value: 'es' as const, label: 'Español' }, { value: 'en' as const, label: 'English' }];
const saveProfile = () => guard(async () => {
  const user = await api('PATCH /me', { body: { name: profile.name, locale: profile.locale, timezone: profile.timezone } });
  await api('PATCH /w/:slug/me', { params: { slug: slug.value }, body: { title: profile.title || null } });
  s.session!.user = user;
  setLocale(user.locale);
  await s.refreshWorkspace();
}, t('common.saved'));

const totp = ref<{ secret: string } | null>(null);
const totpCode = ref('');
const startTotp = () => guard(async () => { totp.value = await api('POST /me/totp/setup'); });
const confirmTotp = () => guard(async () => {
  await api('POST /me/totp/confirm', { body: { code: totpCode.value } });
  s.session!.user.totpEnabled = true;
  totp.value = null;
  totpCode.value = '';
}, t('settings.on2fa'));
const disableTotp = () => guard(async () => {
  await api('DELETE /me/totp', { body: { code: totpCode.value } });
  s.session!.user.totpEnabled = false;
  totpCode.value = '';
}, t('settings.off2fa'));
const logoutAll = () => guard(async () => {
  await api('POST /auth/logout-all');
  router.replace('/login');
});

onMounted(() => { if (!route.params.tab) tab.value = tabs.value[0]!.value; });
</script>

<template>
  <div class="settings">
    <header class="top"><h1>{{ t('settings.title') }}</h1></header>
    <Tabs v-model="tab" :tabs="tabs" class="px-4 bg-surface" />
    <div class="content">
      <!-- Miembros -->
      <section v-if="tab === 'members'" class="grid gap-4">
        <div v-if="members" class="summary">
          <span><b>{{ members.filter((m) => m.isActive).length }}</b> {{ t('settings.activeMembers') }}</span>
          <span><b>{{ members.filter((m) => ['owner', 'admin'].includes(m.role)).length }}</b> {{ t('settings.admins') }}</span>
          <span><b>{{ members.filter((m) => m.leadOfDepartmentIds.length).length }}</b> {{ t('settings.leads') }}</span>
          <Button class="ml-auto" @click="tab = 'invitations'"><UserPlus :size="16" />{{ t('settings.invitePeople') }}</Button>
          <Button variant="primary" @click="openNew"><UserRoundPlus :size="16" />{{ t('settings.createUser') }}</Button>
        </div>
        <div v-if="!members" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="52px" /></div>
        <ul v-else class="list">
          <li v-for="m in members" :key="m.userId" :class="{ off: !m.isActive }">
            <Avatar :name="m.name" />
            <div class="who">
              <b>{{ m.name }}</b><small>{{ m.email }}{{ m.title ? ` · ${m.title}` : '' }}</small>
              <span class="flex flex-wrap gap-1">
                <Badge v-for="id in m.departmentIds" :key="id" :tone="m.leadOfDepartmentIds.includes(id) ? 'primary' : 'neutral'">
                  {{ deptName(id) }}{{ m.leadOfDepartmentIds.includes(id) ? ` · ${t('settings.lead')}` : '' }}
                </Badge>
                <Badge v-for="id in m.lineIds.filter((x) => s.lineOf(x))" :key="id" :tone="s.lineTone(id)">{{ s.lineOf(id)?.name }}</Badge>
                <Badge v-if="!m.isActive" tone="danger">{{ t('settings.inactive') }}</Badge>
              </span>
            </div>
            <Dropdown :model-value="m.role" :options="roleOptions" class="role" :disabled="m.userId === s.user!.id"
              @update:model-value="(r) => r && r !== m.role && patchMember(m, { role: r }, t('settings.roleChanged'))" />
            <Button size="sm" @click="editDepts(m)"><Building2 :size="15" />{{ t('settings.departments') }}</Button>
            <Button v-if="m.userId !== s.user!.id" size="sm" variant="ghost" :aria-label="t('settings.setPassword')" @click="openPw(m)"><KeyRound :size="15" /></Button>
            <Button v-if="m.userId !== s.user!.id" size="sm" variant="ghost" @click="patchMember(m, { isActive: !m.isActive }, t('common.saved'))">
              {{ m.isActive ? t('settings.deactivate') : t('settings.reactivate') }}
            </Button>
          </li>
        </ul>
        <SlideOver v-model="editOpen" :title="s.activeLines.length ? t('settings.deptsAndLines', s.cat) : t('settings.departments')" :subtitle="editing?.name">
          <div class="grid gap-2">
            <div v-for="dpt in s.workspace!.departments.filter((x) => !x.archivedAt)" :key="dpt.id" class="dept">
              <span class="flex-1">{{ dpt.name }}</span>
              <div class="seg" role="radiogroup" :aria-label="dpt.name">
                <button v-for="v in (['none', 'member', 'lead'] as const)" :key="v" type="button" role="radio" :aria-checked="draftDepts[dpt.id] === v"
                  @click="draftDepts[dpt.id] = v">{{ v === 'none' ? '—' : v === 'lead' ? t('settings.lead') : t('roles.member') }}</button>
              </div>
            </div>
            <template v-if="s.activeLines.length">
              <h3 class="lines-h">{{ s.cat.categories }}</h3>
              <p class="hint">{{ t('settings.memberLinesHint', s.cat) }}</p>
              <div class="line-picks">
                <button v-for="l in s.activeLines" :key="l.id" type="button" role="checkbox" :aria-checked="draftLines.includes(l.id)" @click="toggleLine(l.id)">
                  <span class="dot" :style="{ background: toneColor(s.lineTone(l.id), true) }" />{{ l.name }}
                </button>
              </div>
            </template>
            <Button variant="primary" class="mt-3" @click="saveDepts">{{ t('common.save') }}</Button>
          </div>
        </SlideOver>

        <Modal v-model="newOpen" :title="t('settings.createUser')" :subtitle="t('settings.createUserHint')" width="560px">
          <form id="new-user" class="grid gap-4" @submit.prevent="createUser">
            <div class="pair2">
              <Input v-model="nu.name" :label="t('settings.fullName')" required />
              <Input v-model="nu.email" type="email" label="Email" autocomplete="off" required />
            </div>
            <div class="pair2">
              <Input v-model="nu.password" type="text" :label="t('settings.password')" :hint="t('settings.passwordHint')" autocomplete="new-password" required />
              <Dropdown v-model="nu.role" :options="newRoleOptions" :label="t('settings.role')" />
            </div>
            <Input v-model="nu.title" :label="t('settings.jobTitle')" />
            <div class="grid gap-2">
              <h3 class="lines-h">{{ t('settings.departments') }}</h3>
              <div v-for="dpt in s.workspace!.departments.filter((x) => !x.archivedAt)" :key="dpt.id" class="dept">
                <span class="flex-1">{{ dpt.name }}</span>
                <div class="seg" role="radiogroup" :aria-label="dpt.name">
                  <button v-for="v in (['none', 'member', 'lead'] as const)" :key="v" type="button" role="radio" :aria-checked="draftDepts[dpt.id] === v"
                    @click="draftDepts[dpt.id] = v">{{ v === 'none' ? '—' : v === 'lead' ? t('settings.lead') : t('roles.member') }}</button>
                </div>
              </div>
              <template v-if="s.activeLines.length">
                <h3 class="lines-h">{{ s.cat.categories }}</h3>
                <p class="hint">{{ t('settings.memberLinesHint', s.cat) }}</p>
                <div class="line-picks">
                  <button v-for="l in s.activeLines" :key="l.id" type="button" role="checkbox" :aria-checked="draftLines.includes(l.id)" @click="toggleLine(l.id)">
                    <span class="dot" :style="{ background: toneColor(s.lineTone(l.id), true) }" />{{ l.name }}
                  </button>
                </div>
              </template>
            </div>
            <p v-if="nuError" class="text-sm text-danger">{{ nuError }}</p>
          </form>
          <template #footer>
            <Button @click="newOpen = false">{{ t('common.cancel') }}</Button>
            <Button type="submit" form="new-user" variant="primary" :loading="nuBusy" :disabled="!nu.name.trim() || !nu.email.trim() || nu.password.length < 10">{{ t('settings.createUser') }}</Button>
          </template>
        </Modal>

        <Modal v-model="pwOpen" :title="t('settings.setPassword')" :subtitle="pwFor?.name" width="440px">
          <form id="set-pw" class="grid gap-3" @submit.prevent="savePw">
            <Input v-model="newPw" type="text" :label="t('settings.newPassword')" :hint="t('settings.setPasswordHint')" autocomplete="new-password" :error="pwError" />
          </form>
          <template #footer>
            <Button @click="pwFor = null">{{ t('common.cancel') }}</Button>
            <Button type="submit" form="set-pw" variant="primary" :disabled="newPw.length < 10">{{ t('common.save') }}</Button>
          </template>
        </Modal>
      </section>

      <InvitePanel v-else-if="tab === 'invitations'" />

      <BillingPanel v-else-if="tab === 'billing'" />

      <section v-else-if="tab === 'structure'" class="stack">
        <!-- Banda con el nombre de las categorías y el rubro; debajo, las dos listas como tarjetas hermanas -->
        <form class="card naming" @submit.prevent="saveCategory">
          <div class="naming-head">
            <h2>{{ t('settings.categoryTitle') }}</h2>
            <p class="hint">{{ t('settings.categoryNameHint') }}</p>
          </div>
          <div class="naming-row">
            <Input v-model="catForm.singular" :label="`${t('settings.categoryName')} · ${t('settings.singular')}`" :placeholder="t('category.singular')" :error="catError" />
            <Input v-model="catForm.plural" :label="t('settings.plural')" :placeholder="t('category.plural')" />
            <Dropdown v-model="catForm.industry" :options="industryOptions" :label="t('settings.industry')" />
            <Button type="submit" variant="primary">{{ t('common.save') }}</Button>
          </div>
          <p class="hint">{{ t('settings.industryHint') }}</p>
        </form>
        <div class="split even">
          <div class="card accent"><h2>{{ t('onboarding.departments') }}</h2><p class="hint">{{ t('settings.deptHint') }}</p><StructureEditor kind="departments" /></div>
          <div class="card accent"><h2>{{ t('onboarding.lines', s.cat) }}</h2><p class="hint">{{ t('settings.linesHint', s.cat) }}</p><StructureEditor kind="lines" /></div>
        </div>
      </section>

      <section v-else-if="tab === 'workspace'" class="split">
        <div class="col">
        <form class="card accent" @submit.prevent="saveWorkspace">
          <h2>{{ t('settings.workspace') }}</h2>
          <Input v-model="wsName" :label="t('settings.agencyName')" />
          <p class="addr"><span>{{ t('settings.address') }}</span><code>{{ origin }}/w/{{ s.workspace!.slug }}</code></p>
          <div><Button type="submit" variant="primary">{{ t('common.save') }}</Button></div>
        </form>
        <div class="card box">
          <h2>{{ t('settings.modules') }}</h2>
          <p class="hint">{{ t('settings.modulesHint') }}</p>
          <ul class="mods">
            <li v-for="m in modules" :key="m.key" :class="{ on: m.on }">
              <span class="mi"><component :is="m.icon" :size="20" /></span>
              <div class="mt"><b>{{ t(`settings.moduleNames.${m.key}`) }}</b><small>{{ t(`settings.moduleHints.${m.key}`) }}</small></div>
              <button type="button" role="switch" class="sw" :aria-checked="m.on" :aria-label="t(`settings.moduleNames.${m.key}`)" :disabled="moduleBusy === m.key"
                @click="toggleModule(m.key, !m.on)"><span /></button>
            </li>
          </ul>
        </div>
        </div>
        <aside class="card plan">
          <h2>{{ t('settings.plan') }}</h2>
          <dl>
            <dt>{{ t('settings.planName') }}</dt><dd><Badge tone="primary">{{ t(`settings.plans.${s.workspace!.plan}`) }}</Badge></dd>
            <dt>{{ t('settings.status') }}</dt><dd>{{ t(`settings.statuses.${s.workspace!.status}`) }}</dd>
            <template v-if="s.workspace!.status === 'trialing'"><dt>{{ t('settings.trialEnds') }}</dt><dd>{{ d(s.workspace!.trialEndsAt, 'long') }}</dd></template>
            <dt>{{ t('settings.maxFile') }}</dt><dd>{{ s.workspace!.settings.maxFileMb }} MB</dd>
          </dl>
          <div><Button @click="tab = 'billing'">{{ t('settings.seeBilling') }}</Button></div>
        </aside>
      </section>

      <section v-else class="split">
        <div class="col">
        <form class="card accent" @submit.prevent="saveProfile">
          <header class="me">
            <Avatar :name="s.user!.name" :size="56" presence="active" />
            <div><h2>{{ s.user!.name }}</h2><small>{{ s.user!.email }} · {{ t(`roles.${s.workspace!.me.role}`) }}</small></div>
          </header>
          <Input v-model="profile.name" :label="t('common.name')" autocomplete="name" />
          <Input v-model="profile.title" :label="t('settings.jobTitle')" />
          <Dropdown v-model="profile.locale" :options="localeOptions" :label="t('settings.language')" />
          <Dropdown v-model="profile.timezone" :options="tzOptions" :label="t('settings.timezone')" searchable :search-placeholder="t('settings.searchTimezone')" />
          <div><Button type="submit" variant="primary">{{ t('common.save') }}</Button></div>
        </form>
        </div>
        <div class="col">
        <PushSetup />
        <div class="card box">
          <h2 class="flex items-center gap-2"><ShieldCheck :size="20" />{{ t('settings.title2fa') }}
            <Badge :tone="s.user!.totpEnabled ? 'success' : 'neutral'">{{ s.user!.totpEnabled ? t('settings.on2fa') : t('settings.off2fa') }}</Badge></h2>
          <template v-if="s.user!.totpEnabled">
            <Input v-model="totpCode" :label="t('auth.totpCode')" autocomplete="one-time-code" />
            <div><Button variant="danger" @click="disableTotp">{{ t('settings.disable2fa') }}</Button></div>
          </template>
          <template v-else-if="totp">
            <p class="m-0 text-sm">{{ t('settings.secret2fa') }}</p>
            <code class="secret">{{ totp.secret.match(/.{1,4}/g)!.join(' ') }}</code>
            <Input v-model="totpCode" :label="t('auth.totpCode')" autocomplete="one-time-code" />
            <div><Button variant="primary" @click="confirmTotp">{{ t('settings.enable2fa') }}</Button></div>
          </template>
          <div v-else><Button @click="startTotp">{{ t('settings.enable2fa') }}</Button></div>
        </div>
        <div class="card">
          <h2>{{ t('settings.sessions') }}</h2>
          <p class="hint">{{ t('settings.sessionsHint') }}</p>
          <div><Button variant="ghost" @click="logoutAll"><LogOut :size="16" />{{ t('settings.logoutAll') }}</Button></div>
        </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.top { display: flex; align-items: center; min-height: 58px; padding: 0 22px; background: var(--color-surface); }
h1 { margin: 0; font-size: 19px; }
h2 { margin: 0; font-size: 17px; }
.content { padding: 24px 32px 40px 28px; }
/* Dos columnas de distinto peso: la principal a la izquierda, el contexto a la derecha */
.split { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr); gap: 22px; align-items: start; max-width: 1320px; }
.col { display: grid; gap: 22px; }
.stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; max-width: 1320px; }
/* Banda de nombre y rubro: acento marino a la izquierda, campos en una fila de distinto peso */
.naming { border-left: 4px solid var(--color-ink); }
.naming-head { display: grid; gap: 4px; }
.naming-head .hint { margin: 0; }
.naming-row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 14px; align-items: start; }
/* El botón se alinea con los campos (debajo de la etiqueta), aunque un campo muestre error */
.naming-row > .btn { margin-top: 25px; min-height: 42px; }
.naming > .hint { margin: 0; }
/* Pares de tarjetas hermanas: mismo ancho y mismo alto */
.split.even { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
.split.even .card { grid-template-rows: auto auto 1fr; }
/* minmax(0, 1fr): la columna no crece con el contenido (si no, en el teléfono la tarjeta se sale de la pantalla) */
.card { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-content: start; padding: 20px 22px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.card.accent { border-left: 4px solid var(--color-primary); }
.hint { margin: -6px 0 0; font-size: 13px; color: var(--color-muted); }
.me { display: flex; align-items: center; gap: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--color-line); }
.me h2 { font-size: 20px; }
.me small { color: var(--color-muted); font-size: 13px; }
.addr { display: grid; gap: 6px; margin: 0; font-size: 14px; font-weight: 500; }
.addr code { padding: 8px 10px; font-size: 13px; font-weight: 400; background: var(--color-canvas); border: 1px solid var(--color-line); overflow-wrap: anywhere; }
.plan dl { display: grid; grid-template-columns: auto 1fr; gap: 10px 16px; margin: 0; font-size: 14px; }
.plan dt { color: var(--color-muted); }
.plan dd { margin: 0; }
.summary { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 26px; padding: 14px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); border-left: 4px solid var(--color-leaf); color: var(--color-muted); font-size: 14px; }
.summary b { font: 800 22px var(--font-display); color: var(--color-ink); margin-right: 4px; }
.list { margin: 0; padding: 0; list-style: none; background: var(--color-surface); box-shadow: var(--shadow-md); }
.list li { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 14px; border-top: 1px solid var(--color-line); }
.list li:first-child { border-top: 0; }
.list li.off { opacity: .6; }
.who { flex: 1; min-width: 200px; display: grid; gap: 3px; }
.who small { color: var(--color-muted); font-size: 13px; }
.role { width: 150px; }
.dept { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--color-line); }
.seg { display: flex; border: 1px solid var(--color-line-strong); }
.lines-h { margin: 18px 0 0; font-size: 14px; }
.pair2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.line-picks { display: flex; flex-wrap: wrap; gap: 8px; }
.line-picks button { display: inline-flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 14px; font: inherit; font-size: 14px; color: var(--color-ink); background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); cursor: pointer; }
.line-picks button[aria-checked="true"] { background: var(--color-ink); color: #fff; border-color: var(--color-ink); }
.line-picks .dot { width: 8px; height: 8px; }
.seg button { min-height: 36px; padding: 0 10px; font: inherit; font-size: 13px; color: var(--color-ink); background: var(--color-surface); border: 0; cursor: pointer; }
.seg button[aria-checked="true"] { background: var(--color-ink); color: #fff; }
.box { border-left: 4px solid var(--color-ink); }
/* Módulos: fila con ícono, texto y un interruptor cuadrado (sin controles nativos) */
.mods { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-line); }
.mods li { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-top: 1px solid var(--color-line); border-left: 3px solid transparent; transition: background var(--duration), border-color var(--duration); }
.mods li:first-child { border-top: 0; }
.mods li.on { border-left-color: var(--color-primary); }
.mi { width: 40px; height: 40px; display: grid; place-items: center; flex: none; color: var(--color-muted); background: var(--color-canvas); }
.mods li.on .mi { color: #8A4B00; background: var(--color-primary-light); box-shadow: var(--shadow-sm); }
.mt { flex: 1; display: grid; gap: 2px; min-width: 0; }
.mt small { font-size: 13px; color: var(--color-muted); }
.sw { position: relative; width: 48px; height: 26px; flex: none; padding: 0; background: var(--color-line-strong); border: 0; cursor: pointer; transition: background var(--duration); }
.sw span { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; background: var(--color-surface); box-shadow: var(--shadow-sm); transition: transform var(--duration); }
.sw[aria-checked="true"] { background: var(--color-ink); }
.sw[aria-checked="true"] span { transform: translateX(22px); background: var(--color-primary); }
.sw:focus-visible { outline: 0; box-shadow: 0 0 0 3px rgb(246 144 8 / .35); }
.sw:disabled { opacity: .6; cursor: wait; }
.secret { padding: 10px 12px; font-size: 16px; letter-spacing: .08em; background: var(--color-canvas); border: 1px solid var(--color-line); word-break: break-all; }
@media (max-width: 1023px) { .split, .split.even { grid-template-columns: minmax(0, 1fr); } .naming-row { grid-template-columns: 1fr 1fr; } }
@media (max-width: 767px) { .content { padding: 16px; } .role { width: 100%; } .card { padding: 16px; } .naming-row { grid-template-columns: minmax(0, 1fr); } .naming-row > .btn { margin-top: 0; } }
</style>
