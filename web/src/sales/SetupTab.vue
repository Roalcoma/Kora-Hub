<script setup lang="ts">
// Configuración del módulo (Admin): agentes (nivel de contrato, dueño de agencia, usuario de Discord) y
// compañías con sus productos, alias para el lector de Discord y tabla nivel → %.
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Pencil, Table2, TrendingUp, Building2, Users } from 'lucide-vue-next';
import type { Carrier, Product } from '@agencia-hub/contracts';
import Dropdown from '@/design/Dropdown.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Modal from '@/design/Modal.vue';
import Input from '@/design/Input.vue';
import Avatar from '@/design/Avatar.vue';
import EmptyState from '@/design/EmptyState.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useSales } from './store.ts';
import { fmtDay, today } from './format.ts';
import GridModal from './GridModal.vue';
import DiscordCard from './DiscordCard.vue';

const { t, locale } = useI18n();
const s = useSession();
const ref_ = useSales();
const slug = () => s.workspace!.slug;
const day = (x: string) => fmtDay(x, locale.value);
const reload = () => ref_.load(true);

async function guard(fn: () => Promise<unknown>, ok = t('common.saved')) {
  try {
    await fn();
    toast(ok, 'success');
    await reload();
    return true;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  }
}

// ─── Agentes ───
const uplineOptions = (userId: string) => [{ value: '', label: t('sales.noUpline') },
  ...ref_.sellers.filter((m) => m.userId !== userId).map((m) => ({ value: m.userId, label: m.name }))];
const setUpline = (userId: string, v: string) =>
  guard(() => api('PATCH /w/:slug/agents/:userId', { params: { slug: slug(), userId }, body: { uplineUserId: v || null } }));
const discordDraft = reactive<Record<string, string>>({});
const discordOf = (userId: string) => discordDraft[userId] ?? ref_.agent(userId)?.discordUserId ?? '';
function saveDiscord(userId: string) {
  const v = (discordDraft[userId] ?? '').trim();
  if (discordDraft[userId] === undefined || v === (ref_.agent(userId)?.discordUserId ?? '')) return;
  if (v && !/^\d{5,25}$/.test(v)) { toast(t('sales.discordInvalid'), 'error'); return; }
  guard(() => api('PATCH /w/:slug/agents/:userId', { params: { slug: slug(), userId }, body: { discordUserId: v || null } }))
    .then(() => { delete discordDraft[userId]; });
}
/** Dueños de agencia primero, luego por nombre */
const agents = computed(() => [...ref_.sellers].sort((a, b) => {
  const owners = (id: string) => ref_.agents.some((x) => x.uplineUserId === id) ? 0 : 1;
  return owners(a.userId) - owners(b.userId) || a.name.localeCompare(b.name);
}));
const teamSize = (id: string) => ref_.agents.filter((x) => x.uplineUserId === id).length;

const levelFor = ref<string | null>(null);
const levelForm = reactive({ level: '', effectiveFrom: '' });
const levelOpen = computed({ get: () => !!levelFor.value, set: (v) => { if (!v) levelFor.value = null; } });
function openLevel(userId: string) {
  levelFor.value = userId;
  levelForm.level = String(ref_.currentLevel(userId)?.level ?? '');
  levelForm.effectiveFrom = today().slice(0, 8) + '01';   // los ascensos rigen desde el 1° del mes
}
const saveLevel = async () => {
  if (await guard(() => api('POST /w/:slug/agents/:userId/levels', { params: { slug: slug(), userId: levelFor.value! },
    body: { level: Number(levelForm.level), effectiveFrom: levelForm.effectiveFrom } }))) levelFor.value = null;
};

// ─── Compañías y productos ───
type Edit = { kind: 'carrier'; carrier: Carrier | null } | { kind: 'product'; carrier: Carrier; product: Product | null };
const edit = ref<Edit | null>(null);
const editOpen = computed({ get: () => !!edit.value, set: (v) => { if (!v) edit.value = null; } });
const form = reactive({ name: '', aliases: '', advanceMonths: '9', defaultProductId: '' });
function openCarrier(c: Carrier | null) {
  edit.value = { kind: 'carrier', carrier: c };
  Object.assign(form, { name: c?.name ?? '', aliases: c?.aliases.join(', ') ?? '', advanceMonths: String(c?.advanceMonths ?? 9), defaultProductId: c?.defaultProductId ?? '' });
}
function openProduct(c: Carrier, p: Product | null) {
  edit.value = { kind: 'product', carrier: c, product: p };
  Object.assign(form, { name: p?.name ?? '', aliases: p?.aliases.join(', ') ?? '' });
}
async function saveEdit() {
  const e = edit.value!;
  const aliases = form.aliases.split(',').map((x) => x.trim()).filter(Boolean);
  const params = { slug: slug() };
  const ok = await guard(() => {
    if (e.kind === 'carrier') {
      const body = { name: form.name.trim(), aliases, advanceMonths: Number(form.advanceMonths) };
      return e.carrier ? api('PATCH /w/:slug/carriers/:id', { params: { ...params, id: e.carrier.id }, body: { ...body, defaultProductId: form.defaultProductId || null } })
        : api('POST /w/:slug/carriers', { params, body });
    }
    const body = { name: form.name.trim(), aliases };
    return e.product ? api('PATCH /w/:slug/products/:id', { params: { ...params, id: e.product.id }, body })
      : api('POST /w/:slug/carriers/:id/products', { params: { ...params, id: e.carrier.id }, body });
  });
  if (ok) edit.value = null;
}
const editValid = computed(() => form.name.trim() && (edit.value?.kind !== 'carrier' || (Number(form.advanceMonths) >= 0 && Number(form.advanceMonths) <= 12)));

const gridProduct = ref<Product | null>(null);
const gridOpen = computed({ get: () => !!gridProduct.value, set: (v) => { if (!v) gridProduct.value = null; } });
/** Resumen de la revisión vigente: cantidad de niveles y extremos (el detalle está en el modal) */
const gridSummary = (p: Product) => {
  const rows = p.grids[0]?.rows ?? [];
  const lo = rows[rows.length - 1], hi = rows[0];
  return lo && hi ? t('sales.gridSummary', { n: rows.length, lo: `${lo.level} → ${lo.rate}%`, hi: `${hi.level} → ${hi.rate}%` }) : '';
};
</script>

<template>
  <div class="body">
    <p class="intro">{{ t('sales.setupIntro') }}</p>
    <div class="split">
      <!-- Agentes: la columna con más peso -->
      <section class="card accent">
        <header class="head"><h2><Users :size="20" />{{ t('sales.agents') }}</h2><small>{{ t('sales.agentsHint') }}</small></header>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">{{ t('sales.agent') }}</th><th scope="col">{{ t('sales.level') }}</th>
              <th scope="col">{{ t('sales.upline') }}</th><th scope="col">{{ t('sales.discordId') }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="m in agents" :key="m.userId">
                <th scope="row">
                  <span class="who"><Avatar :name="m.name" :size="30" /><span>{{ m.name }}
                    <Badge v-if="teamSize(m.userId)" tone="primary">{{ t('sales.ownerOf', { n: teamSize(m.userId) }, teamSize(m.userId)) }}</Badge></span></span>
                </th>
                <td>
                  <button type="button" class="lvl" :class="{ none: !ref_.currentLevel(m.userId) }" @click="openLevel(m.userId)">
                    <template v-if="ref_.currentLevel(m.userId)"><b>{{ ref_.currentLevel(m.userId)!.level }}</b><small>{{ t('sales.since', { date: day(ref_.currentLevel(m.userId)!.effectiveFrom) }) }}</small></template>
                    <template v-else>{{ t('sales.setLevel') }}</template>
                    <TrendingUp :size="15" />
                  </button>
                </td>
                <td class="up">
                  <Dropdown :model-value="ref_.agent(m.userId)?.uplineUserId ?? ''" :options="uplineOptions(m.userId)" searchable :search-placeholder="t('sales.searchAgent')"
                    :aria-label="t('sales.upline')" @update:model-value="(v) => v !== (ref_.agent(m.userId)?.uplineUserId ?? '') && setUpline(m.userId, v ?? '')" />
                </td>
                <td>
                  <input class="dc" :value="discordOf(m.userId)" inputmode="numeric" :placeholder="t('sales.discordPlaceholder')" :aria-label="`${t('sales.discordId')} · ${m.name}`"
                    @input="discordDraft[m.userId] = ($event.target as HTMLInputElement).value" @blur="saveDiscord(m.userId)" @keydown.enter="saveDiscord(m.userId)">
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Compañías y productos; arriba, la conexión con Discord -->
      <section class="carriers">
        <DiscordCard />
        <header class="head row"><h2><Building2 :size="20" />{{ t('sales.carriers') }}</h2>
          <Button size="sm" variant="primary" @click="openCarrier(null)"><Plus :size="15" />{{ t('sales.newCarrier') }}</Button></header>
        <EmptyState v-if="!ref_.carriers.length" :icon="Building2" :title="t('sales.noCarriers')" :text="t('sales.noCarriersText')" />
        <article v-for="c in ref_.carriers" :key="c.id" class="card carrier" :class="{ archived: c.archivedAt }">
          <header>
            <div><h3>{{ c.name }}</h3>
              <small>{{ t('sales.advance', { n: c.advanceMonths }) }}<template v-if="c.aliases.length"> · Discord: {{ c.aliases.join(', ') }}</template></small></div>
            <button type="button" class="ico" :aria-label="t('sales.editCarrier')" :title="t('sales.editCarrier')" @click="openCarrier(c)"><Pencil :size="16" /></button>
          </header>
          <ul>
            <li v-for="p in c.products" :key="p.id">
              <div class="p">
                <b>{{ p.name }} <Badge v-if="c.defaultProductId === p.id" tone="neutral">{{ t('sales.default') }}</Badge></b><small v-if="p.aliases.length">Discord: {{ p.aliases.join(', ') }}</small>
                <span v-if="p.grids.length" class="g">{{ gridSummary(p) }}<em>{{ t('sales.since', { date: day(p.grids[0]!.effectiveFrom) }) }}</em></span>
                <Badge v-else tone="warning">{{ t('sales.noGrid') }}</Badge>
              </div>
              <button type="button" class="ico" :aria-label="t('sales.editGrid')" :title="t('sales.editGrid')" @click="gridProduct = p"><Table2 :size="16" /></button>
              <button type="button" class="ico" :aria-label="t('sales.editProduct')" :title="t('sales.editProduct')" @click="openProduct(c, p)"><Pencil :size="16" /></button>
            </li>
          </ul>
          <div><Button size="sm" variant="ghost" @click="openProduct(c, null)"><Plus :size="15" />{{ t('sales.newProduct') }}</Button></div>
        </article>
      </section>
    </div>

    <Modal v-model="levelOpen" :title="t('sales.levelTitle')" :subtitle="levelFor ? ref_.memberName(levelFor) : ''" width="420px">
      <Input v-model="levelForm.level" type="number" :label="t('sales.level')" :hint="t('sales.levelHint')" />
      <label class="date">{{ t('sales.effectiveFrom') }}<input v-model="levelForm.effectiveFrom" type="date"></label>
      <ul v-if="levelFor && ref_.agent(levelFor)?.levels.length" class="history">
        <li v-for="l in ref_.agent(levelFor)!.levels" :key="l.effectiveFrom"><b>{{ l.level }}</b> {{ t('sales.since', { date: day(l.effectiveFrom) }) }}</li>
      </ul>
      <template #footer>
        <Button variant="ghost" @click="levelFor = null">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :disabled="!(Number(levelForm.level) >= 0 && levelForm.level !== '' && levelForm.effectiveFrom)" @click="saveLevel">{{ t('common.save') }}</Button>
      </template>
    </Modal>

    <Modal v-model="editOpen" :title="edit?.kind === 'carrier' ? (edit.carrier ? t('sales.editCarrier') : t('sales.newCarrier')) : (edit?.product ? t('sales.editProduct') : t('sales.newProduct'))"
      :subtitle="edit?.kind === 'product' ? edit.carrier.name : undefined" width="440px">
      <Input v-model="form.name" :label="t('common.name')" />
      <Input v-model="form.aliases" :label="t('sales.aliases')" :hint="t('sales.aliasesHint')" />
      <Input v-if="edit?.kind === 'carrier'" v-model="form.advanceMonths" type="number" :label="t('sales.advanceMonths')" :hint="t('sales.advanceMonthsHint')" />
      <template v-if="edit?.kind === 'carrier' && edit.carrier?.products.length">
        <Dropdown v-model="form.defaultProductId" :label="t('sales.defaultProduct')"
          :options="[{ value: '', label: t('sales.noDefaultProduct') }, ...edit.carrier.products.map((p) => ({ value: p.id, label: p.name }))]" />
        <p class="hint-sm">{{ t('sales.defaultProductHint') }}</p>
      </template>
      <template #footer>
        <Button variant="ghost" @click="edit = null">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :disabled="!editValid" @click="saveEdit">{{ t('common.save') }}</Button>
      </template>
    </Modal>

    <GridModal v-model="gridOpen" :product="gridProduct" :title="gridProduct ? `${t('sales.grid')} · ${ref_.productLabel(gridProduct.id)}` : ''" @saved="reload" />
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 18px; align-content: start; padding: 18px 32px 40px 28px; }
.intro { margin: 0; max-width: 720px; color: var(--color-muted); line-height: 1.5; }
.split { display: grid; grid-template-columns: 1.7fr 1fr; gap: 20px; align-items: start; }
.card { display: grid; gap: 12px; padding: 18px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.card.accent { border-left: 4px solid var(--color-primary); }
.head { display: grid; gap: 2px; }
.head.row { display: flex; align-items: center; justify-content: space-between; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.head small { color: var(--color-muted); }

.table-wrap { overflow-x: auto; margin: 0 -20px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 8px 12px; text-align: left; vertical-align: middle; border-bottom: 1px solid var(--color-line); }
thead th { font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); white-space: nowrap; }
th:first-child, td:first-child { padding-left: 20px; }
tbody th { font-weight: 600; }
.who { display: flex; align-items: center; gap: 10px; }
.who > span { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.lvl { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 10px; font: inherit; color: var(--color-ink); background: var(--color-canvas); border: 1px solid var(--color-line); cursor: pointer; white-space: nowrap; transition: box-shadow var(--duration), border-color var(--duration); }
.lvl:hover { border-color: var(--color-ink); box-shadow: var(--shadow-sm); }
.lvl b { font-size: 16px; font-variant-numeric: tabular-nums; }
.lvl small { font-size: 12px; color: var(--color-muted); }
.lvl.none { color: var(--color-warning); background: var(--color-warning-light); border-color: transparent; font-weight: 600; }
.up { min-width: 200px; }
.dc { width: 150px; min-height: 36px; padding: 0 10px; font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--color-ink); background: var(--color-surface); border: 1px solid var(--color-line-strong); outline: none; }
.dc:focus { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .22); }

.carriers { display: grid; gap: 14px; }
.carrier header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.carrier h3 { margin: 0; font-size: 17px; }
.carrier header small { color: var(--color-muted); font-size: 13px; }
.carrier.archived { opacity: .6; }
.carrier ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.carrier li { display: flex; align-items: center; gap: 4px; padding: 8px 0; border-top: 1px solid var(--color-line); }
.p { flex: 1; display: grid; gap: 3px; min-width: 0; }
.p small { font-size: 12px; color: var(--color-muted); }
.g { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--color-ink); }
.g em { display: block; font-style: normal; color: var(--color-muted); }
.ico { display: grid; place-items: center; width: 32px; height: 32px; flex: none; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.ico:hover { color: var(--color-ink); background: var(--color-canvas-deep); }

.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.hint-sm { margin: -8px 0 0; font-size: 12px; color: var(--color-muted); }
.history { margin: 0; padding: 10px 14px; list-style: none; display: grid; gap: 4px; font-size: 13px; color: var(--color-muted); background: var(--color-canvas); }
.history b { color: var(--color-ink); }

@media (max-width: 1200px) { .split { grid-template-columns: 1fr; } }
@media (max-width: 767px) { .body { padding: 14px 16px 32px; } }
</style>
