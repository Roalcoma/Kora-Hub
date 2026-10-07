<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Building2, ShieldCheck, LogOut } from 'lucide-vue-next';
import type { Member, Role } from '@agencia-hub/contracts';
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
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import StructureEditor from './StructureEditor.vue';
import InvitePanel from './InvitePanel.vue';
import { errorText } from './errors.ts';
import PushSetup from '@/chat/PushSetup.vue';

type Tab = 'members' | 'invitations' | 'structure' | 'workspace' | 'profile';
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const slug = computed(() => s.workspace!.slug);

const tabs = computed(() => [
  ...(s.isAdmin ? [
    { value: 'members' as const, label: t('settings.members') },
    { value: 'invitations' as const, label: t('settings.invitations') },
    { value: 'structure' as const, label: t('settings.structure') },
    { value: 'workspace' as const, label: t('settings.workspace') },
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

const roleOptions = computed(() => (['owner', 'admin', 'lead', 'member', 'guest'] as const).map((r) => ({ value: r, label: t(`roles.${r}`) })));
const deptName = (id: string) => s.workspace!.departments.find((d) => d.id === id)?.name ?? '';

const patchMember = (m: Member, body: { role?: Role; isActive?: boolean; departments?: { id: string; isLead: boolean }[] }, ok?: string) =>
  guard(async () => {
    Object.assign(m, await api('PATCH /w/:slug/members/:userId', { params: { slug: slug.value, userId: m.userId }, body }));
  }, ok);

const editing = ref<Member | null>(null);
const editOpen = computed({ get: () => !!editing.value, set: (v) => { if (!v) editing.value = null; } });
const draftDepts = ref<Record<string, 'none' | 'member' | 'lead'>>({});
function editDepts(m: Member) {
  editing.value = m;
  draftDepts.value = Object.fromEntries(s.workspace!.departments.map((d) => [d.id,
    m.leadOfDepartmentIds.includes(d.id) ? 'lead' : m.departmentIds.includes(d.id) ? 'member' : 'none']));
}
async function saveDepts() {
  const m = editing.value!;
  const departments = Object.entries(draftDepts.value).filter(([, v]) => v !== 'none').map(([id, v]) => ({ id, isLead: v === 'lead' }));
  await patchMember(m, { departments }, t('common.saved'));
  editing.value = null;
}

// ─── Agencia ───
const wsName = ref(s.workspace!.name);
const saveWorkspace = () => guard(async () => {
  await api('PATCH /w/:slug', { params: { slug: slug.value }, body: { name: wsName.value } });
  await s.refreshWorkspace();
}, t('common.saved'));

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
      <section v-if="tab === 'members'">
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
                <Badge v-if="!m.isActive" tone="danger">{{ t('settings.inactive') }}</Badge>
              </span>
            </div>
            <Dropdown :model-value="m.role" :options="roleOptions" class="role" :disabled="m.userId === s.user!.id"
              @update:model-value="(r) => r && r !== m.role && patchMember(m, { role: r }, t('settings.roleChanged'))" />
            <Button size="sm" @click="editDepts(m)"><Building2 :size="15" />{{ t('settings.departments') }}</Button>
            <Button v-if="m.userId !== s.user!.id" size="sm" variant="ghost" @click="patchMember(m, { isActive: !m.isActive }, t('common.saved'))">
              {{ m.isActive ? t('settings.deactivate') : t('settings.reactivate') }}
            </Button>
          </li>
        </ul>
        <SlideOver v-model="editOpen" :title="t('settings.departments')" :subtitle="editing?.name">
          <div class="grid gap-2">
            <div v-for="dpt in s.workspace!.departments.filter((x) => !x.archivedAt)" :key="dpt.id" class="dept">
              <span class="flex-1">{{ dpt.name }}</span>
              <div class="seg" role="radiogroup" :aria-label="dpt.name">
                <button v-for="v in (['none', 'member', 'lead'] as const)" :key="v" type="button" role="radio" :aria-checked="draftDepts[dpt.id] === v"
                  @click="draftDepts[dpt.id] = v">{{ v === 'none' ? '—' : v === 'lead' ? t('settings.lead') : t('roles.member') }}</button>
              </div>
            </div>
            <Button variant="primary" class="mt-3" @click="saveDepts">{{ t('common.save') }}</Button>
          </div>
        </SlideOver>
      </section>

      <InvitePanel v-else-if="tab === 'invitations'" class="narrow" />

      <section v-else-if="tab === 'structure'" class="narrow grid gap-6">
        <div class="grid gap-2"><h2>{{ t('onboarding.departments') }}</h2><StructureEditor kind="departments" /></div>
        <div class="grid gap-2"><h2>{{ t('onboarding.lines') }}</h2><StructureEditor kind="lines" /></div>
      </section>

      <form v-else-if="tab === 'workspace'" class="narrow grid gap-4" @submit.prevent="saveWorkspace">
        <Input v-model="wsName" :label="t('settings.agencyName')" />
        <div><Button type="submit" variant="primary">{{ t('common.save') }}</Button></div>
      </form>

      <section v-else class="narrow grid gap-8">
        <form class="grid gap-4" @submit.prevent="saveProfile">
          <Input v-model="profile.name" :label="t('common.name')" autocomplete="name" />
          <Input v-model="profile.title" :label="t('settings.jobTitle')" />
          <Dropdown v-model="profile.locale" :options="localeOptions" :label="t('settings.language')" />
          <Input v-model="profile.timezone" :label="t('settings.timezone')" placeholder="America/New_York" />
          <div><Button type="submit" variant="primary">{{ t('common.save') }}</Button></div>
        </form>
        <PushSetup />
        <div class="grid gap-3 box">
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
        <div><Button variant="ghost" @click="logoutAll"><LogOut :size="16" />{{ t('settings.logoutAll') }}</Button></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.top { display: flex; align-items: center; min-height: 58px; padding: 0 22px; background: var(--color-surface); }
h1 { margin: 0; font-size: 19px; }
h2 { margin: 0; font-size: 17px; }
.content { padding: 20px; }
.narrow { max-width: 640px; }
.list { margin: 0; padding: 0; list-style: none; background: var(--color-surface); box-shadow: var(--shadow-md); max-width: 1000px; }
.list li { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 14px; border-top: 1px solid var(--color-line); }
.list li:first-child { border-top: 0; }
.list li.off { opacity: .6; }
.who { flex: 1; min-width: 200px; display: grid; gap: 3px; }
.who small { color: var(--color-muted); font-size: 13px; }
.role { width: 150px; }
.dept { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--color-line); }
.seg { display: flex; border: 1px solid var(--color-line-strong); }
.seg button { min-height: 36px; padding: 0 10px; font: inherit; font-size: 13px; color: var(--color-ink); background: var(--color-surface); border: 0; cursor: pointer; }
.seg button[aria-checked="true"] { background: var(--color-ink); color: #fff; }
.box { padding: 16px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); border-left: 4px solid var(--color-ink); }
.secret { padding: 10px 12px; font-size: 16px; letter-spacing: .08em; background: var(--color-canvas); border: 1px solid var(--color-line); word-break: break-all; }
@media (max-width: 767px) { .content { padding: 16px; } .role { width: 100%; } }
</style>
