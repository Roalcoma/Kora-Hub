<script setup lang="ts">
// Ficha de una persona (Owner/Admin): perfil, acceso (rol, estado, contraseña, enlace de recuperación, sesiones),
// departamentos y líneas, y permiso por módulo. Perfil, estructura y módulos se guardan juntos; las acciones de acceso
// (contraseña, enlace, cerrar sesiones) se aplican al momento. Las reglas las vuelve a aplicar el servidor.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { KeyRound, Link2, LogOut, Copy, Lock, UserX, UserCheck } from 'lucide-vue-next';
import { MODULES, MODULE_DEFAULTS, type AccessLevel, type Member, type Module, type Role } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import SlideOver from '@/design/SlideOver.vue';
import Tabs from '@/design/Tabs.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { errorText } from './errors.ts';
import AccessPicker from './AccessPicker.vue';

const member = defineModel<Member | null>({ default: null });
const props = defineProps<{ members: Member[] }>();
const emit = defineEmits<{ saved: [m: Member] }>();
const { t, te, d } = useI18n();
const s = useSession();
const slug = () => s.workspace!.slug;

const open = computed({ get: () => !!member.value, set: (v) => { if (!v) member.value = null; } });
type Tab = 'profile' | 'access' | 'structure' | 'modules';
const tab = ref<Tab>('profile');
const tabs = computed(() => [
  { value: 'profile' as Tab, label: t('members.tabs.profile') },
  { value: 'access' as Tab, label: t('members.tabs.access') },
  { value: 'structure' as Tab, label: s.activeLines.length ? t('settings.deptsAndLines', s.cat) : t('settings.departments') },
  { value: 'modules' as Tab, label: t('members.tabs.modules') },
]);

type Choice = AccessLevel | 'default';
const draft = reactive({
  name: '', email: '', title: '', role: 'member' as Role, isActive: true,
  depts: {} as Record<string, 'none' | 'member' | 'lead'>, lines: [] as string[], modules: {} as Record<Module, Choice>,
});
const fromMember = (m: Member) => ({
  depts: Object.fromEntries(s.workspace!.departments.map((x) => [x.id,
    m.leadOfDepartmentIds.includes(x.id) ? 'lead' : m.departmentIds.includes(x.id) ? 'member' : 'none'])) as Record<string, 'none' | 'member' | 'lead'>,
  lines: m.lineIds.filter((id) => s.activeLines.some((l) => l.id === id)),
  modules: Object.fromEntries(MODULES.map((k) => [k, m.moduleOverrides[k] ?? 'default'])) as Record<Module, Choice>,
});
const link = ref<{ url: string; expiresAt: string } | null>(null);
const newPw = ref('');
watch(member, (m) => {
  if (!m) return;
  tab.value = 'profile';
  link.value = null;
  newPw.value = '';
  Object.assign(draft, { name: m.name, email: m.email, title: m.title ?? '', role: m.role, isActive: m.isActive, ...fromMember(m) });
}, { immediate: true });

const isSelf = computed(() => member.value?.userId === s.user!.id);
// Un Admin no toca a un Owner; la cuenta compartida con otra agencia no cambia nombre, email ni clave aquí
const locked = computed(() => member.value?.role === 'owner' && !s.isOwner);
const shared = computed(() => !!member.value?.sharedAccount);
const roleOptions = computed(() => (['owner', 'admin', 'lead', 'member', 'accountant', 'guest'] as const)
  .filter((r) => r !== 'owner' || s.isOwner).map((r) => ({ value: r, label: t(`roles.${r}`) })));
const fullAccess = computed(() => draft.role === 'owner' || draft.role === 'admin');

// ─── Módulos ───
const LEVELS: AccessLevel[] = ['none', 'view', 'edit', 'manage'];
const visibleModules = computed(() => MODULES.filter((m) => (m !== 'sales' || s.workspace!.settings.salesModule) && (m !== 'finance' || s.workspace!.settings.financeModule)));
const roleDefault = (m: Module) => MODULE_DEFAULTS[draft.role][m];
const effective = (m: Module) => (fullAccess.value ? 'manage' : draft.modules[m] === 'default' ? roleDefault(m) : draft.modules[m]);
// Copiar permisos de otra persona: módulos, departamentos y líneas (se ve antes de guardar)
const copyFrom = ref('');
const copyOptions = computed(() => props.members.filter((m) => m.userId !== member.value?.userId && m.role !== 'guest')
  .map((m) => ({ value: m.userId, label: m.name, hint: t(`roles.${m.role}`) })));
watch(copyFrom, (id) => {
  const src = props.members.find((m) => m.userId === id);
  if (!src) return;
  Object.assign(draft, fromMember(src));
  toast(t('members.copied', { name: src.name }), 'success');
  copyFrom.value = '';
});

// ─── Guardar (perfil + rol/estado + estructura + módulos) ───
const busy = ref(false);
async function save() {
  const m = member.value!;
  busy.value = true;
  try {
    const body: Record<string, unknown> = {
      title: draft.title.trim() || null,
      departments: Object.entries(draft.depts).filter(([, v]) => v !== 'none').map(([id, v]) => ({ id, isLead: v === 'lead' })),
      modules: Object.fromEntries(MODULES.map((k) => [k, draft.modules[k] === 'default' ? null : draft.modules[k]])),
    };
    if (s.activeLines.length) body.lineIds = draft.lines;
    if (!isSelf.value && draft.role !== m.role) body.role = draft.role;
    if (!isSelf.value && draft.isActive !== m.isActive) body.isActive = draft.isActive;
    if (!shared.value && draft.name.trim() !== m.name) body.name = draft.name.trim();
    if (!shared.value && draft.email.trim().toLowerCase() !== m.email) body.email = draft.email.trim();
    const updated = await api('PATCH /w/:slug/members/:userId', { params: { slug: slug(), userId: m.userId }, body });
    emit('saved', { ...updated, sharedAccount: m.sharedAccount });
    toast(t('common.saved'), 'success');
    member.value = null;
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = false;
  }
}

// ─── Acciones de acceso (al momento) ───
const acting = ref<string | null>(null);
async function act(key: string, fn: () => Promise<unknown>, ok: string) {
  acting.value = key;
  try { await fn(); toast(ok, 'success'); } catch (e) { toast(errorText(e), 'error'); } finally { acting.value = null; }
}
const params = () => ({ slug: slug(), userId: member.value!.userId });
const setPassword = () => act('pw', () => api('PUT /w/:slug/members/:userId/password', { params: params(), body: { password: newPw.value } })
  .then(() => { newPw.value = ''; }), t('settings.passwordSet', { name: member.value!.name }));
const makeLink = () => act('link', async () => { link.value = await api('POST /w/:slug/members/:userId/recovery-link', { params: params() }); },
  t('members.linkReady'));
const logoutAll = () => act('logout', () => api('POST /w/:slug/members/:userId/logout-all', { params: params() }), t('members.loggedOut'));
async function copyLink() {
  try { await navigator.clipboard.writeText(link.value!.url); toast(t('members.linkCopied'), 'success'); } catch { /* el texto queda seleccionable */ }
}
</script>

<template>
  <SlideOver v-model="open" :title="t('members.edit')" :subtitle="member ? `${member.name} · ${t(`roles.${member.role}`)}` : ''" width="580px">
    <template v-if="member">
      <p v-if="locked" class="note"><Lock :size="15" />{{ t('members.ownerLocked') }}</p>
      <Tabs v-model="tab" :tabs="tabs" />

      <fieldset class="pane" :disabled="locked">
        <!-- Perfil -->
        <div v-if="tab === 'profile'" class="grid gap-4">
          <p v-if="shared" class="note"><Lock :size="15" />{{ t('members.sharedAccount') }}</p>
          <Input v-model="draft.name" :label="t('settings.fullName')" :disabled="shared" />
          <Input v-model="draft.email" type="email" label="Email" :disabled="shared" />
          <Input v-model="draft.title" :label="t('settings.jobTitle')" />
        </div>

        <!-- Acceso -->
        <div v-else-if="tab === 'access'" class="grid gap-5">
          <div class="pair">
            <Dropdown v-model="draft.role" :options="roleOptions" :label="t('settings.role')" :disabled="isSelf" />
            <div class="state">
              <span class="lbl">{{ t('members.state') }}</span>
              <Button v-if="draft.isActive" :disabled="isSelf" @click="draft.isActive = false"><UserX :size="16" />{{ t('settings.deactivate') }}</Button>
              <Button v-else variant="primary" @click="draft.isActive = true"><UserCheck :size="16" />{{ t('settings.reactivate') }}</Button>
            </div>
          </div>
          <p class="hint">{{ draft.isActive ? t('members.activeHint') : t('members.inactiveHint') }}</p>

          <section class="box">
            <h3><KeyRound :size="17" />{{ t('members.passwordTitle') }}</h3>
            <p v-if="isSelf" class="hint">{{ t('members.selfPassword') }}</p>
            <p v-else-if="shared" class="note"><Lock :size="15" />{{ t('members.sharedAccount') }}</p>
            <template v-else>
              <div class="row">
                <Input v-model="newPw" type="text" :label="t('settings.newPassword')" :hint="t('settings.setPasswordHint')" autocomplete="new-password" class="flex-1" />
                <Button variant="primary" :disabled="newPw.length < 10" :loading="acting === 'pw'" @click="setPassword">{{ t('members.setPassword') }}</Button>
              </div>
              <div class="or"><span>{{ t('members.or') }}</span></div>
              <Button :loading="acting === 'link'" @click="makeLink"><Link2 :size="16" />{{ t('members.makeLink') }}</Button>
              <div v-if="link" class="link">
                <code>{{ link.url }}</code>
                <Button size="sm" @click="copyLink"><Copy :size="14" />{{ t('common.copy') }}</Button>
                <small>{{ t('members.linkHint', { date: d(link.expiresAt, 'short') }) }}</small>
              </div>
            </template>
          </section>

          <section v-if="!isSelf" class="box">
            <h3><LogOut :size="17" />{{ t('members.sessionsTitle') }}</h3>
            <p class="hint">{{ t('members.sessionsHint') }}</p>
            <Button :loading="acting === 'logout'" @click="logoutAll"><LogOut :size="16" />{{ t('members.logoutAll') }}</Button>
          </section>
        </div>

        <!-- Departamentos y líneas -->
        <AccessPicker v-else-if="tab === 'structure'" v-model:depts="draft.depts" v-model:lines="draft.lines" />

        <!-- Módulos -->
        <div v-else class="grid gap-4">
          <p v-if="fullAccess" class="note"><Lock :size="15" />{{ t('members.fullAccess') }}</p>
          <template v-else>
            <Dropdown v-model="copyFrom" :options="copyOptions" :label="t('members.copyFrom')" :placeholder="t('members.copyPlaceholder')" searchable />
            <p class="hint">{{ t('members.copyHint') }}</p>
          </template>
          <ul class="mods">
            <li v-for="m in visibleModules" :key="m" :class="`lv-${effective(m)}`">
              <div class="mt"><b>{{ t(`members.modules.${m}`) }}</b><small>{{ te(`members.levelHint.${m}.${effective(m)}`) ? t(`members.levelHint.${m}.${effective(m)}`) : t(`members.levelHint.${effective(m)}`) }}</small></div>
              <div class="seg" role="radiogroup" :aria-label="t(`members.modules.${m}`)">
                <button type="button" role="radio" :aria-checked="!fullAccess && draft.modules[m] === 'default'" :disabled="fullAccess"
                  :title="t('members.defaultOf', { level: t(`members.levels.${roleDefault(m)}`) })" @click="draft.modules[m] = 'default'">
                  {{ t('members.byRole') }}<small>{{ t(`members.levels.${roleDefault(m)}`) }}</small>
                </button>
                <button v-for="l in LEVELS" :key="l" type="button" role="radio" :disabled="fullAccess"
                  :aria-checked="fullAccess ? l === 'manage' : draft.modules[m] === l" @click="draft.modules[m] = l">{{ t(`members.levels.${l}`) }}</button>
              </div>
            </li>
          </ul>
        </div>
      </fieldset>

      <footer class="foot">
        <Button @click="member = null">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :loading="busy" :disabled="locked || !draft.name.trim()" @click="save">{{ t('common.save') }}</Button>
      </footer>
    </template>
  </SlideOver>
</template>

<style scoped>
.pane { display: grid; gap: 16px; margin: 18px 0 0; padding: 0; border: 0; min-width: 0; }
.note { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 12px; padding: 10px 12px; font-size: 13px; line-height: 1.45; color: var(--color-ink);
  background: var(--color-canvas-deep); border-left: 3px solid var(--color-primary); }
.note .lucide { margin-top: 2px; }
.hint { margin: -8px 0 0; font-size: 13px; color: var(--color-muted); }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; align-items: end; }
.state { display: grid; gap: 6px; }
.lbl { font-size: 13px; font-weight: 500; }
.box { display: grid; gap: 12px; padding: 16px; background: var(--color-surface); box-shadow: var(--shadow-sm); border: 1px solid var(--color-line); border-left: 3px solid var(--color-ink); }
.box h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; }
.box .hint { margin: 0; }
.row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.row > .btn { min-height: 42px; margin-bottom: 22px; }
.or { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--color-muted); text-transform: uppercase; letter-spacing: .06em; }
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--color-line); }
.link { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.link code { padding: 8px 10px; font-size: 12px; background: var(--color-canvas); border: 1px solid var(--color-line); overflow-wrap: anywhere; }
.link small { grid-column: 1 / -1; color: var(--color-muted); font-size: 12px; }
.mods { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-line); }
.mods li { display: grid; gap: 10px; padding: 14px; border-top: 1px solid var(--color-line); border-left: 3px solid var(--color-line-strong); }
.mods li:first-child { border-top: 0; }
.mods li.lv-view { border-left-color: var(--color-cta); }
.mods li.lv-edit { border-left-color: var(--color-leaf); }
.mods li.lv-manage { border-left-color: var(--color-primary); }
.mt { display: grid; gap: 2px; }
.mt small { font-size: 13px; color: var(--color-muted); }
.seg { display: flex; flex-wrap: wrap; border: 1px solid var(--color-line-strong); }
.seg button { flex: 1; display: grid; place-items: center; min-height: 38px; padding: 4px 8px; font: inherit; font-size: 13px; color: var(--color-ink); background: var(--color-surface); border: 0; border-left: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration), color var(--duration); }
.seg button:first-child { border-left: 0; }
.seg button small { font-size: 11px; color: var(--color-muted); }
.seg button[aria-checked="true"] { background: var(--color-ink); color: #fff; }
.seg button[aria-checked="true"] small { color: #C9D3E0; }
.seg button:disabled { cursor: default; }
.foot { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 10px; margin: 22px -24px -24px; padding: 14px 24px; background: var(--color-surface); border-top: 1px solid var(--color-line); box-shadow: 0 -8px 20px rgb(19 36 61 / .08); }
</style>
