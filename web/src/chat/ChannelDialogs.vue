<script setup lang="ts">
// Diálogos del sidebar: crear/explorar canales y abrir un mensaje directo.
// Un canal privado se liga a un departamento (y a una línea): sus miembros se mantienen solos. Si no, se eligen personas
// filtrando por departamento, línea o nombre. Puede ser subcanal de otro: cuelga de él en el sidebar.
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Hash, Lock, X, Check, Building2 } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import Modal from '@/design/Modal.vue';
import Tabs from '@/design/Tabs.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import Avatar from '@/design/Avatar.vue';
import Dropdown from '@/design/Dropdown.vue';
import EmptyState from '@/design/EmptyState.vue';
import { errorText } from '@/platform/errors.ts';
import { api } from '@/api.ts';
import { useChat } from './store.ts';

const dialog = defineModel<'channel' | 'dm' | null>({ default: null });
const { t } = useI18n();
const router = useRouter();
const s = useSession();
const chat = useChat();
const go = (id: string) => { dialog.value = null; router.push(`/w/${s.workspace!.slug}/c/${id}`); };

// ─── Canal ───
const channelOpen = computed({ get: () => dialog.value === 'channel', set: (v) => { if (!v) dialog.value = null; } });
const tab = ref<'create' | 'browse'>('create');
const f = reactive({ name: '', topic: '', private: false, departmentId: '', lineId: '', parentId: '' });
const pick = reactive({ dept: '', line: '', q: '', ids: [] as string[], parentOnly: false });
// Nombre sugerido: se reemplaza mientras nadie lo cambie a mano
const suggested = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
watch(channelOpen, (v) => {
  if (!v) return;
  Object.assign(f, { name: '', topic: '', private: false, departmentId: '', lineId: '', parentId: '' });
  Object.assign(pick, { dept: '', line: '', q: '', ids: [], parentOnly: false });
  suggested.value = ''; error.value = null; tab.value = 'create';
});
const browse = computed(() => chat.channels.filter((c) => c.kind === 'public' && !c.isMember));

// ─── Canal superior (subcanal): uno de mis canales que no cuelgue de otro (un solo nivel) ───
const parents = computed(() => chat.channels.filter((c) => c.isMember && !c.archivedAt && (c.kind === 'public' || c.kind === 'private')
  && !c.parentId && !c.lineId).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')));
const parentOptions = computed(() => [{ value: '', label: t('chat.noParent') }, ...parents.value.map((c) => ({ value: c.id, label: `# ${c.name}` }))]);
const parent = computed(() => parents.value.find((c) => c.id === f.parentId));
const parentMembers = ref<string[]>([]);
watch(() => f.parentId, async (id) => {
  parentMembers.value = [];
  pick.parentOnly = false;
  const p = parent.value;
  if (!p) return;
  if (p.kind === 'private') f.private = true;   // de un privado solo cuelgan privados
  if (!f.name || f.name === suggested.value) f.name = suggested.value = `${p.name}-`;
  parentMembers.value = await api('GET /w/:slug/channels/:id/members', { params: { slug: s.workspace!.slug, id: p.id } });
  pick.parentOnly = p.kind === 'private';
});

const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const slugify = (x: string) => fold(x).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const depts = computed(() => s.workspace!.departments.filter((d) => !d.archivedAt));
const me = computed(() => chat.memberById.get(s.user!.id));
// Ligar a un departamento: Admin cualquiera; Líder, los suyos (el servidor lo vuelve a comprobar)
const ownDepts = computed(() => depts.value.filter((d) => s.isAdmin || me.value?.leadOfDepartmentIds.includes(d.id)));
const deptOptions = computed(() => [{ value: '', label: t('chat.noDepartment') }, ...ownDepts.value.map((d) => ({ value: d.id, label: d.name }))]);
const lineOptions = (all: string) => [{ value: '', label: all }, ...s.activeLines.map((l) => ({ value: l.id, label: l.name }))];
const filterDeptOptions = computed(() => [{ value: '', label: t('chat.allDepartments') }, ...depts.value.map((d) => ({ value: d.id, label: d.name }))]);
// Nombre sugerido a partir del departamento y la línea, mientras no lo hayan escrito a mano
watch(() => [f.departmentId, f.lineId], () => {
  if ((f.name && f.name !== suggested.value) || !f.departmentId) return;
  f.name = suggested.value = slugify([s.deptName(f.departmentId), f.lineId ? s.lineOf(f.lineId)?.name : t('chat.general')].join(' '));
});

const active = computed(() => chat.members.filter((m) => m.isActive && m.role !== 'guest'));
// Misma regla que el servidor (deptLineRule): Owners/Admins + gente del departamento de esa línea, su Líder o sin líneas
const managedPeople = computed(() => !f.departmentId ? [] : active.value.filter((m) => ['owner', 'admin'].includes(m.role)
  || (m.departmentIds.includes(f.departmentId) && (m.leadOfDepartmentIds.includes(f.departmentId) || !f.lineId || !m.lineIds.length || m.lineIds.includes(f.lineId)))));
const candidates = computed(() => active.value.filter((m) => m.userId !== s.user!.id
  && (!pick.parentOnly || parentMembers.value.includes(m.userId))
  && (!pick.dept || m.departmentIds.includes(pick.dept)) && (!pick.line || m.lineIds.includes(pick.line)) && fold(m.name).includes(fold(pick.q))));
const allPicked = computed(() => candidates.value.length > 0 && candidates.value.every((m) => pick.ids.includes(m.userId)));
const toggle = (id: string) => { pick.ids = pick.ids.includes(id) ? pick.ids.filter((x) => x !== id) : [...pick.ids, id]; };
function toggleAll() {
  const ids = candidates.value.map((m) => m.userId);
  pick.ids = allPicked.value ? pick.ids.filter((x) => !ids.includes(x)) : [...new Set([...pick.ids, ...ids])];
}
const managed = computed(() => f.private && !!f.departmentId);

async function create() {
  busy.value = true;
  error.value = null;
  try {
    const c = await chat.createChannel({
      kind: f.private ? 'private' : 'public', name: f.name.trim().toLowerCase().replace(/\s+/g, '-'), topic: f.topic || undefined,
      ...(managed.value ? { departmentId: f.departmentId, lineId: f.lineId || undefined } : {}),
      ...(f.parentId ? { parentId: f.parentId } : {}),
      memberIds: f.private && !managed.value ? pick.ids : [],
    });
    go(c.id);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

// ─── DM ───
const dmOpen = computed({ get: () => dialog.value === 'dm', set: (v) => { if (!v) dialog.value = null; } });
const query = ref('');
const picked = ref<string[]>([]);
watch(dmOpen, (v) => { if (v) { query.value = ''; picked.value = []; } });
const people = computed(() => chat.members.filter((m) => m.isActive && m.userId !== s.user!.id && !picked.value.includes(m.userId) && fold(m.name).includes(fold(query.value))));
async function openDm() {
  busy.value = true;
  try {
    go((await chat.openDm(picked.value)).id);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-model="channelOpen" :title="t('chat.addChannel')" width="520px">
    <Tabs v-model="tab" :tabs="[{ value: 'create', label: t('chat.createChannel') }, { value: 'browse', label: t('chat.explore'), count: browse.length }]" />
    <form v-if="tab === 'create'" id="new-channel" class="grid gap-4" @submit.prevent="create">
      <Dropdown v-if="parents.length" v-model="f.parentId" :options="parentOptions" :label="t('chat.parentChannel')" searchable />
      <label class="priv" :class="{ locked: parent?.kind === 'private' }"><input v-model="f.private" type="checkbox" :disabled="parent?.kind === 'private'"><Lock :size="16" /><span><b>{{ t('chat.private') }}</b><small>{{ t('chat.privateHint') }}</small></span></label>
      <template v-if="f.private && ownDepts.length">
        <div class="pair">
          <Dropdown v-model="f.departmentId" :options="deptOptions" :label="t('chat.linkDepartment')" />
          <Dropdown v-if="f.departmentId && s.activeLines.length" v-model="f.lineId" :options="lineOptions(t('chat.generalAllLines', s.cat))" :label="s.cat.category" />
        </div>
      </template>
      <Input v-model="f.name" :label="t('chat.channelName')" prefix="#" :hint="t('chat.channelNameHint')" :error="error" />
      <Input v-model="f.topic" :label="t('chat.topic')" />

      <!-- Ligado a un departamento: la membresía es automática; se muestra quién quedaría -->
      <div v-if="managed" class="auto">
        <p><Building2 :size="15" />{{ t('chat.autoMembers', { n: managedPeople.length }) }}</p>
        <span class="faces"><Avatar v-for="m in managedPeople.slice(0, 12)" :key="m.userId" :name="m.name" :size="26" /></span>
      </div>
      <!-- Sin departamento: se eligen personas, con filtros -->
      <div v-else-if="f.private" class="picker">
        <label v-if="parent" class="only"><input v-model="pick.parentOnly" type="checkbox">{{ t('chat.onlyParentMembers', { name: parent.name }) }}</label>
        <div class="filters">
          <Dropdown v-model="pick.dept" :options="filterDeptOptions" :label="t('chat.filterDepartment')" />
          <Dropdown v-if="s.activeLines.length" v-model="pick.line" :options="lineOptions(t('chat.allLines', s.cat))" :label="s.cat.category" />
        </div>
        <div class="pick-head">
          <input v-model="pick.q" :placeholder="t('chat.pickPeople')" :aria-label="t('chat.pickPeople')">
          <button type="button" class="all" :disabled="!candidates.length" @click="toggleAll">{{ allPicked ? t('chat.unselectAll') : t('chat.selectAll', { n: candidates.length }) }}</button>
        </div>
        <div class="people">
          <button v-for="m in candidates" :key="m.userId" type="button" class="row" role="checkbox" :aria-checked="pick.ids.includes(m.userId)" @click="toggle(m.userId)">
            <span class="box"><Check v-if="pick.ids.includes(m.userId)" :size="13" /></span>
            <Avatar :name="m.name" :size="28" /><span><b>{{ m.name }}</b><small>{{ m.departmentIds.map((d) => s.deptName(d)).join(' · ') || (m.title ?? t(`roles.${m.role}`)) }}</small></span>
          </button>
          <p v-if="!candidates.length" class="none">{{ t('chat.noPeopleMatch') }}</p>
        </div>
        <small class="count">{{ t('chat.pickedCount', { n: pick.ids.length }, pick.ids.length) }}</small>
      </div>
    </form>
    <div v-else>
      <EmptyState v-if="!browse.length" :icon="Hash" :title="t('chat.explore')" :text="t('chat.noMoreChannels')" />
      <button v-for="c in browse" :key="c.id" type="button" class="row" @click="go(c.id)">
        <Hash :size="16" /><span><b>{{ c.name }}</b><small v-if="c.topic">{{ c.topic }}</small></span>
      </button>
    </div>
    <template v-if="tab === 'create'" #footer>
      <Button @click="dialog = null">{{ t('chat.cancel') }}</Button>
      <Button type="submit" form="new-channel" variant="primary" :loading="busy" :disabled="!f.name.trim()">{{ t('chat.create') }}</Button>
    </template>
  </Modal>

  <Modal v-model="dmOpen" :title="t('chat.newMessage')" width="480px">
    <div class="to">
      <span>{{ t('chat.to') }}</span>
      <span v-for="id in picked" :key="id" class="chip">{{ chat.nameOf(id) }}<button type="button" :aria-label="t('chat.discard')" @click="picked = picked.filter((x) => x !== id)"><X :size="13" /></button></span>
      <input v-model="query" :placeholder="t('chat.pickPeople')" :aria-label="t('chat.pickPeople')" autofocus>
    </div>
    <div class="people">
      <button v-for="m in people.slice(0, 8)" :key="m.userId" type="button" class="row" :disabled="picked.length >= 7" @click="picked.push(m.userId); query = ''">
        <Avatar :name="m.name" :size="30" :presence="m.presence" /><span><b>{{ m.name }}</b><small>{{ m.title ?? t(`roles.${m.role}`) }}</small></span>
      </button>
    </div>
    <p v-if="error" class="text-sm text-danger">{{ error }}</p>
    <template #footer>
      <Button @click="dialog = null">{{ t('chat.cancel') }}</Button>
      <Button variant="primary" :disabled="!picked.length" :loading="busy" @click="openDm">{{ t('chat.open') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.priv { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--color-line); cursor: pointer; }
.priv span { display: grid; }
.priv small { color: var(--color-muted); font-size: 12px; }
.priv.locked { cursor: default; opacity: .7; }
.only { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 6px 10px; font: inherit; text-align: left; color: inherit; background: none; border: 0; border-bottom: 1px solid var(--color-line); cursor: pointer; transition: background var(--duration), box-shadow var(--duration); }
.row:hover:not(:disabled) { background: var(--color-surface); box-shadow: var(--shadow-md); position: relative; }
.row span { display: grid; min-width: 0; }
.row small { color: var(--color-muted); font-size: 12px; }
.to { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .2); }
.to > span:first-child { font-size: 13px; color: var(--color-muted); }
.to input { flex: 1; min-width: 140px; min-height: 32px; font: inherit; border: 0; outline: none; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; font-size: 13px; background: var(--color-primary-light); box-shadow: var(--shadow-sm); }
.chip button { display: grid; place-items: center; width: 20px; height: 20px; background: none; border: 0; cursor: pointer; }
.people { max-height: 340px; overflow: auto; }
.pair, .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.auto { display: grid; gap: 8px; padding: 12px 14px; background: var(--color-canvas-deep); border-left: 3px solid var(--color-primary); }
.auto p { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; line-height: 1.45; }
.faces { display: flex; flex-wrap: wrap; gap: 4px; }
.picker { display: grid; gap: 10px; }
.pick-head { display: flex; gap: 8px; }
.pick-head input { flex: 1; min-width: 0; min-height: 40px; padding: 0 12px; font: inherit; border: 1px solid var(--color-line-strong); outline: none; }
.pick-head input:focus { border-color: var(--color-ink); }
.all { flex: none; padding: 0 12px; font: inherit; font-size: 13px; color: var(--color-ink); background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); cursor: pointer; }
.all:disabled { opacity: .5; cursor: default; }
.picker .people { max-height: 260px; border: 1px solid var(--color-line); }
.box { flex: none; width: 18px; height: 18px; display: grid !important; place-items: center; border: 1px solid var(--color-line-strong); }
.row[aria-checked="true"] .box { background: var(--color-ink); border-color: var(--color-ink); color: #fff; }
.none { margin: 0; padding: 14px 12px; font-size: 13px; color: var(--color-muted); }
.count { color: var(--color-muted); font-size: 12px; }
</style>
