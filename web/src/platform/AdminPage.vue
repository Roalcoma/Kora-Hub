<script setup lang="ts">
// Backoffice de plataforma (§3.6, ADR 0005 §4): métricas, agencias, suspender/reactivar e impersonar.
// Fuera del shell de agencia; solo para superadmins (platform_admins). Mismo design system que la app.
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Search, Eye, OctagonPause, PlayCircle, ChevronsUpDown, LogOut, ArrowLeftRight, Building2, DollarSign, Sparkles, UserPlus, UserMinus } from 'lucide-vue-next';
import type { AdminMetrics, AdminWorkspace, WorkspaceStatus } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import Avatar from '@/design/Avatar.vue';
import Badge from '@/design/Badge.vue';
import Button from '@/design/Button.vue';
import Dropdown from '@/design/Dropdown.vue';
import EmptyState from '@/design/EmptyState.vue';
import Modal from '@/design/Modal.vue';
import Skeleton from '@/design/Skeleton.vue';
import Textarea from '@/design/Textarea.vue';
import ContextMenu from '@/design/ContextMenu.vue';
import { toast } from '@/design/toast.ts';
import { errorText } from './errors.ts';
import { money as fmtMoney, bytes, statusTone } from './format.ts';

const { t, locale } = useI18n();
const router = useRouter();
const s = useSession();

const metrics = ref<AdminMetrics | null>(null);
const workspaces = ref<AdminWorkspace[] | null>(null);
async function load() {
  try {
    [metrics.value, workspaces.value] = await Promise.all([api('GET /admin/metrics'), api('GET /admin/workspaces')]);
  } catch (e) {
    toast(errorText(e), 'error');
    workspaces.value ??= [];
  }
}
onMounted(load);

const money = (c: number) => fmtMoney(c, locale.value);
const date = (iso: string) => new Date(iso).toLocaleDateString(locale.value, { day: 'numeric', month: 'short', year: 'numeric' });

// Métricas: tarjetas hermanas del mismo tamaño; el MRR lleva el acento naranja
const cards = computed(() => {
  const m = metrics.value;
  return [
    { key: 'mrr', icon: DollarSign, value: m ? money(m.mrrCents) : '', label: t('admin.mrr') },
    { key: 'active', icon: Building2, value: m?.activeWorkspaces ?? '', label: t('admin.active') },
    { key: 'trials', icon: Sparkles, value: m?.trials ?? '', label: t('admin.trials') },
    { key: 'signups', icon: UserPlus, value: m?.signups30d ?? '', label: t('admin.signups') },
    { key: 'churn', icon: UserMinus, value: m?.churn30d ?? '', label: t('admin.churn') },
  ];
});

// ─── Filtros ───
const q = ref('');
const status = ref<'' | WorkspaceStatus>('');
const STATUSES: WorkspaceStatus[] = ['trialing', 'active', 'past_due', 'read_only', 'suspended', 'closing'];
const statusOptions = computed(() => [{ value: '' as const, label: t('admin.allStatuses') },
  ...STATUSES.map((x) => ({ value: x, label: t(`settings.statuses.${x}`), hint: workspaces.value ? String(workspaces.value.filter((w) => w.status === x).length) : undefined }))]);
const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const shown = computed(() => (workspaces.value ?? []).filter((w) =>
  (!status.value || w.status === status.value)
  && (!q.value.trim() || fold(`${w.name} ${w.slug} ${w.ownerEmail ?? ''}`).includes(fold(q.value.trim())))));

// ─── Suspender / reactivar ───
const confirmWs = ref<AdminWorkspace | null>(null);
const confirmOpen = computed({ get: () => !!confirmWs.value, set: (v) => { if (!v) confirmWs.value = null; } });
const willSuspend = computed(() => confirmWs.value?.status !== 'suspended');
const busy = ref(false);
async function applyStatus() {
  const w = confirmWs.value!;
  busy.value = true;
  try {
    await api('POST /admin/workspaces/:id/status', { params: { id: w.id }, body: { status: willSuspend.value ? 'suspended' : 'active' } });
    toast(t(willSuspend.value ? 'admin.suspended' : 'admin.reactivated', { name: w.name }), 'success');
    confirmWs.value = null;
    await load();
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = false;
  }
}

// ─── Impersonar (motivo obligatorio; queda en audit_log) ───
const impWs = ref<AdminWorkspace | null>(null);
const impOpen = computed({ get: () => !!impWs.value, set: (v) => { if (!v) impWs.value = null; } });
const reason = ref('');
const impError = ref<string | null>(null);
function openImp(w: AdminWorkspace) {
  impWs.value = w;
  reason.value = '';
  impError.value = null;
}
async function impersonate() {
  if (reason.value.trim().length < 5) { impError.value = t('admin.reasonShort'); return; }
  busy.value = true;
  impError.value = null;
  try {
    const res = await api('POST /admin/workspaces/:id/impersonate', { params: { id: impWs.value!.id }, body: { reason: reason.value.trim() } });
    s.set(res);
    s.workspace = null;
    impWs.value = null;
    await router.push(`/w/${res.workspaceSlug}`);
  } catch (e) {
    impError.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

// ─── Mi cuenta ───
const meMenu = ref(false);
const mePos = ref({ x: 0, y: 0 });
function openMe(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  mePos.value = { x: r.right - 220, y: r.bottom + 6 };
  meMenu.value = true;
}
const meItems = computed(() => [
  ...(s.session!.workspaces.length ? [{ label: t('admin.backToApp'), icon: ArrowLeftRight, action: () => router.push('/') }] : []),
  { label: t('nav.logout'), icon: LogOut, danger: true, action: async () => { await s.logout(); router.replace('/login'); } },
]);
</script>

<template>
  <div class="admin">
    <header class="bar">
      <div class="brand"><span class="mark">K</span><span>Kora <b>{{ t('admin.title') }}</b></span></div>
      <button type="button" class="me" :aria-label="t('nav.account')" @click="openMe">
        <Avatar :name="s.user!.name" :size="32" />
        <span class="me-txt"><b>{{ s.user!.name }}</b><small>{{ t('admin.role') }}</small></span>
        <ChevronsUpDown :size="16" />
      </button>
    </header>

    <main class="content">
      <div class="head">
        <h1>{{ t('admin.heading') }}</h1>
        <p>{{ t('admin.subtitle') }}</p>
      </div>

      <section class="metrics" :aria-label="t('admin.metrics')">
        <div v-for="c in cards" :key="c.key" class="metric" :class="c.key">
          <span class="m-ico"><component :is="c.icon" :size="18" /></span>
          <Skeleton v-if="!metrics" width="60%" height="30px" />
          <b v-else>{{ c.value }}</b>
          <small>{{ c.label }}</small>
        </div>
      </section>

      <section class="card table-card">
        <div class="filters">
          <h2>{{ t('admin.agencies') }} <Badge v-if="workspaces">{{ shown.length }}</Badge></h2>
          <label class="find"><Search :size="16" /><input v-model="q" :placeholder="t('admin.search')" :aria-label="t('admin.search')"></label>
          <Dropdown v-model="status" :options="statusOptions" class="st" />
        </div>
        <div v-if="!workspaces" class="grid gap-2 p-4"><Skeleton v-for="n in 5" :key="n" height="44px" /></div>
        <div v-else-if="!shown.length" class="p-5">
          <EmptyState :icon="Building2" :title="t('admin.none')" :text="workspaces.length ? t('admin.noneFilter') : t('admin.noneYet')" />
        </div>
        <div v-else class="scroll">
          <table>
            <thead>
              <tr>
                <th>{{ t('admin.colAgency') }}</th><th>{{ t('settings.industry') }}</th><th>{{ t('settings.planName') }}</th>
                <th>{{ t('settings.status') }}</th><th class="num">{{ t('admin.colMembers') }}</th><th class="num">{{ t('admin.colStorage') }}</th>
                <th class="num">MRR</th><th>{{ t('admin.colCreated') }}</th><th>Owner</th><th><span class="sr-only">{{ t('admin.actions') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in shown" :key="w.id">
                <td class="name"><b>{{ w.name }}</b><small>/w/{{ w.slug }}</small></td>
                <td>{{ t(`settings.industries.${w.settings.industry}`) }}</td>
                <td>{{ t(`settings.plans.${w.plan}`) }}</td>
                <td><Badge :tone="statusTone(w.status)">{{ t(`settings.statuses.${w.status}`) }}</Badge></td>
                <td class="num">{{ w.members }}</td>
                <td class="num">{{ bytes(w.storageBytes, locale) }}</td>
                <td class="num">{{ money(w.mrrCents) }}</td>
                <td class="nowrap">{{ date(w.createdAt) }}</td>
                <td class="owner">{{ w.ownerEmail ?? '—' }}</td>
                <td class="acts">
                  <Button size="sm" variant="ghost" @click="confirmWs = w">
                    <template v-if="w.status === 'suspended'"><PlayCircle :size="15" />{{ t('admin.reactivate') }}</template>
                    <template v-else><OctagonPause :size="15" />{{ t('admin.suspend') }}</template>
                  </Button>
                  <Button size="sm" @click="openImp(w)"><Eye :size="15" />{{ t('admin.impersonate') }}</Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <Modal v-model="confirmOpen" :title="t(willSuspend ? 'admin.suspendTitle' : 'admin.reactivateTitle', { name: confirmWs?.name ?? '' })"
      :subtitle="t(willSuspend ? 'admin.suspendHint' : 'admin.reactivateHint')" width="460px">
      <p class="m-0 text-sm text-muted">{{ t('admin.audited') }}</p>
      <template #footer>
        <Button @click="confirmWs = null">{{ t('common.cancel') }}</Button>
        <Button :variant="willSuspend ? 'danger' : 'primary'" :loading="busy" @click="applyStatus">{{ t(willSuspend ? 'admin.suspend' : 'admin.reactivate') }}</Button>
      </template>
    </Modal>

    <Modal v-model="impOpen" :title="t('admin.impTitle', { name: impWs?.name ?? '' })" :subtitle="t('admin.impHint')" width="520px">
      <form id="imp-form" class="grid gap-3" @submit.prevent="impersonate">
        <Textarea v-model="reason" :label="t('admin.reason')" :placeholder="t('admin.reasonHint')" :rows="3" :error="impError" />
        <p class="m-0 text-sm text-muted">{{ t('admin.impRules') }}</p>
      </form>
      <template #footer>
        <Button @click="impWs = null">{{ t('common.cancel') }}</Button>
        <Button type="submit" form="imp-form" variant="primary" :loading="busy" :disabled="reason.trim().length < 5"><Eye :size="16" />{{ t('admin.impersonate') }}</Button>
      </template>
    </Modal>
    <ContextMenu v-model="meMenu" :items="meItems" :x="mePos.x" :y="mePos.y" />
  </div>
</template>

<style scoped>
.admin { min-height: 100%; background: var(--color-canvas); }
/* Barra superior marina que proyecta sombra sobre el contenido */
.bar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 16px; min-height: 60px; padding: 0 20px 0 24px; padding-top: env(safe-area-inset-top, 0px); color: #fff; background: linear-gradient(180deg, var(--color-ink) 0%, #0F1E34 100%); box-shadow: 0 6px 18px rgb(19 36 61 / .28); }
.brand { display: flex; align-items: center; gap: 10px; font-family: var(--font-display); font-size: 18px; font-weight: 700; }
.brand b { margin-left: 4px; padding: 2px 8px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--color-ink); background: var(--color-primary); vertical-align: 2px; }
.mark { width: 34px; height: 34px; display: grid; place-items: center; background: var(--color-primary); color: var(--color-ink); font-size: 15px; box-shadow: 0 3px 8px rgb(0 0 0 / .3); }
.me { display: flex; align-items: center; gap: 10px; margin-left: auto; padding: 6px 10px; font: inherit; color: var(--color-sidebar-text); text-align: left; background: rgb(255 255 255 / .06); border: 0; cursor: pointer; transition: background var(--duration); }
.me:hover { background: rgb(255 255 255 / .12); color: #fff; }
.me-txt { display: grid; }
.me-txt b { font-size: 14px; font-weight: 600; color: #fff; }
.me-txt small { font-size: 12px; }

.content { display: grid; gap: 22px; padding: 26px 32px 48px 28px; }
.head { display: grid; gap: 4px; border-left: 4px solid var(--color-primary); padding-left: 14px; }
h1 { margin: 0; font-size: 26px; }
.head p { margin: 0; color: var(--color-muted); }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 18px; }

.metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; }
.metric { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; gap: 4px 10px; align-items: center; padding: 16px 18px; background: var(--color-surface); box-shadow: var(--shadow-md); border-top: 3px solid var(--color-line-strong); transition: box-shadow var(--duration), transform var(--duration); }
.metric:hover { box-shadow: var(--shadow-lg); transform: translateY(-2px); }
.metric.mrr { border-top-color: var(--color-primary); }
.metric b { font: 800 28px/1.1 var(--font-display); font-variant-numeric: tabular-nums; }
.metric small { grid-column: 1 / -1; font-size: 13px; color: var(--color-muted); }
.m-ico { grid-column: 2; grid-row: 1; width: 34px; height: 34px; display: grid; place-items: center; color: var(--color-ink); background: var(--color-canvas); box-shadow: var(--shadow-sm); }
.metric.mrr .m-ico { background: var(--color-primary); }
.metric > :nth-child(2) { grid-column: 1; grid-row: 1; }

.card { background: var(--color-surface); box-shadow: var(--shadow-md); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--color-line); }
.filters h2 { margin-right: auto; }
.find { display: flex; align-items: center; gap: 8px; width: min(340px, 100%); padding: 0 12px; color: var(--color-muted); background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); }
.find:focus-within { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .22); }
.find input { flex: 1; min-width: 0; min-height: 40px; font: inherit; color: var(--color-ink); background: none; border: 0; outline: none; }
.st { width: 210px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 10px 14px; font-size: 12px; font-weight: 600; text-align: left; text-transform: uppercase; letter-spacing: .05em; color: var(--color-muted); background: var(--color-canvas); white-space: nowrap; }
td { padding: 10px 14px; border-top: 1px solid var(--color-line); vertical-align: middle; }
tbody tr { transition: background var(--duration), box-shadow var(--duration); }
tbody tr:hover { background: var(--color-canvas); box-shadow: inset 4px 0 0 var(--color-primary); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.name { display: grid; gap: 1px; min-width: 180px; }
.name small { font-size: 12px; color: var(--color-muted); }
.owner { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acts { white-space: nowrap; text-align: right; }
.acts > * + * { margin-left: 6px; }

@media (max-width: 1100px) { .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 767px) {
  .bar { padding: env(safe-area-inset-top, 0px) 12px 0 16px; }
  .me-txt { display: none; }
  .content { padding: 18px 16px 32px; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .metric.mrr { grid-column: 1 / -1; }
  .find, .st { width: 100%; }
}
</style>
