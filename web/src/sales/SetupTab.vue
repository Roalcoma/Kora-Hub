<script setup lang="ts">
// Configuración del módulo (Admin): agentes (nivel de contrato por compañía, dueño de agencia, usuario de Discord) y
// compañías con sus productos, alias para el lector de Discord y tabla nivel → %.
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, Pencil, Table2, TrendingUp, Building2, Users, ChevronRight, AlertTriangle } from 'lucide-vue-next';
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

// Nivel de contrato por compañía (ADR 0006): la tabla muestra un resumen que escala a N compañías y el detalle vive en
// el modal; el formulario aplica el mismo nivel a las compañías marcadas (un ascenso general sigue siendo una acción).
const activeCarriers = computed(() => ref_.carriers.filter((c) => !c.archivedAt));
/** Resumen de la celda: rango de niveles vigentes y cuántas compañías activas no tienen nivel */
function levelSummary(userId: string) {
  const cur = activeCarriers.value.map((c) => ref_.currentLevel(userId, c.id)?.level ?? null);
  const set = cur.filter((x): x is number => x !== null);
  if (!set.length) return null;
  const lo = Math.min(...set), hi = Math.max(...set), missing = cur.length - set.length;
  const scope = lo === hi && !missing && cur.length > 1 ? t('sales.levelAllCarriers')
    : cur.length === 1 ? activeCarriers.value[0]!.name : t('sales.levelInCarriers', { n: set.length }, set.length);
  return { range: lo === hi ? String(lo) : `${lo}–${hi}`, scope, missing };
}
const levelFor = ref<string | null>(null);
const levelForm = reactive({ carrierIds: [] as string[], level: '', effectiveFrom: '' });
const levelOpen = computed({ get: () => !!levelFor.value, set: (v) => { if (!v) levelFor.value = null; } });
const historyOpen = ref(false);
/** Abre el modal: preselecciona las compañías sin nivel (o todas) y, si comparten nivel, lo propone */
function openLevel(userId: string) {
  levelFor.value = userId;
  historyOpen.value = false;
  const missing = activeCarriers.value.filter((c) => !ref_.currentLevel(userId, c.id)).map((c) => c.id);
  levelForm.carrierIds = missing.length && missing.length < activeCarriers.value.length ? missing : activeCarriers.value.map((c) => c.id);
  const lv = new Set(levelForm.carrierIds.map((id) => ref_.currentLevel(userId, id)?.level));
  levelForm.level = lv.size === 1 ? String([...lv][0] ?? '') : '';
  levelForm.effectiveFrom = today().slice(0, 8) + '01';   // los ascensos rigen desde el 1° del mes
}
/** Clic en una fila de compañía: el formulario pasa a esa compañía con su nivel actual */
function pickCarrier(carrierId: string) {
  levelForm.carrierIds = [carrierId];
  levelForm.level = String(ref_.currentLevel(levelFor.value!, carrierId)?.level ?? '');
}
const allCarriersOn = computed(() => activeCarriers.value.every((c) => levelForm.carrierIds.includes(c.id)));
const toggleAllCarriers = () => { levelForm.carrierIds = allCarriersOn.value ? [] : activeCarriers.value.map((c) => c.id); };
const toggleCarrier = (id: string) => {
  levelForm.carrierIds = levelForm.carrierIds.includes(id) ? levelForm.carrierIds.filter((x) => x !== id) : [...levelForm.carrierIds, id];
};
const levelValid = computed(() => levelForm.carrierIds.length > 0 && levelForm.level !== '' && Number(levelForm.level) >= 0 && !!levelForm.effectiveFrom);
/** Historial del agente agrupado por compañía (archivadas incluidas si tienen niveles) */
const levelHistory = computed(() => {
  const levels = levelFor.value ? ref_.agent(levelFor.value)?.levels ?? [] : [];
  return ref_.carriers.map((c) => ({ carrier: c, levels: levels.filter((l) => l.carrierId === c.id) })).filter((g) => g.levels.length);
});
const saveLevel = async () => {
  if (await guard(() => api('POST /w/:slug/agents/:userId/levels', { params: { slug: slug(), userId: levelFor.value! },
    body: { carrierIds: levelForm.carrierIds, level: Number(levelForm.level), effectiveFrom: levelForm.effectiveFrom } }))) levelFor.value = null;
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
            <thead>
              <tr>
                <th scope="col">{{ t('sales.agent') }}</th>
                <th scope="col">{{ t('sales.level') }}</th>
                <th scope="col">{{ t('sales.upline') }}</th>
                <th scope="col">{{ t('sales.discordId') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in agents" :key="m.userId">
                <th scope="row">
                  <span class="who"><Avatar :name="m.name" :size="30" /><span>{{ m.name }}
                    <Badge v-if="teamSize(m.userId)" tone="primary">{{ t('sales.ownerOf', { n: teamSize(m.userId) }, teamSize(m.userId)) }}</Badge></span></span>
                </th>
                <td class="lv">
                  <button v-for="sum in [levelSummary(m.userId)]" :key="m.userId" type="button" class="lvl" :class="{ none: !sum }"
                    :aria-label="`${t('sales.levelTitle')} · ${m.name}`" @click="openLevel(m.userId)">
                    <template v-if="sum">
                      <b>{{ sum.range }}</b><span class="scope">{{ sum.scope }}</span>
                      <span v-if="sum.missing" class="miss"><AlertTriangle :size="13" />{{ t('sales.levelMissing', { n: sum.missing }) }}</span>
                    </template>
                    <template v-else><TrendingUp :size="15" />{{ t('sales.assignLevel') }}</template>
                    <ChevronRight :size="16" class="chev" />
                  </button>
                </td>
                <td class="up" :data-label="t('sales.upline')">
                  <Dropdown :model-value="ref_.agent(m.userId)?.uplineUserId ?? ''" :options="uplineOptions(m.userId)" searchable :search-placeholder="t('sales.searchAgent')"
                    :aria-label="t('sales.upline')" @update:model-value="(v) => v !== (ref_.agent(m.userId)?.uplineUserId ?? '') && setUpline(m.userId, v ?? '')" />
                </td>
                <td :data-label="t('sales.discordId')">
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

    <Modal v-model="levelOpen" :title="levelFor ? t('sales.levelsOf', { name: ref_.memberName(levelFor) }) : ''" :subtitle="t('sales.levelsHint')" width="560px">
      <!-- Nivel vigente por compañía: cada fila lleva su compañía al formulario -->
      <section v-if="levelFor" class="cur">
        <span class="h-title">{{ t('sales.levelCurrent') }}</span>
        <ul>
          <li v-for="c in activeCarriers" :key="c.id">
            <button v-for="cur in [ref_.currentLevel(levelFor, c.id)]" :key="c.id" type="button" class="cur-row"
              :class="{ on: levelForm.carrierIds.length === 1 && levelForm.carrierIds[0] === c.id, none: !cur }" @click="pickCarrier(c.id)">
              <span class="nm">{{ c.name }}</span>
              <template v-if="cur"><b>{{ cur.level }}</b><small>{{ t('sales.since', { date: day(cur.effectiveFrom) }) }}</small></template>
              <span v-else class="miss"><AlertTriangle :size="13" />{{ t('sales.noLevel') }}</span>
              <Pencil :size="14" class="edit" />
            </button>
          </li>
        </ul>
      </section>
      <!-- Formulario de asignación -->
      <section class="assign">
        <span class="h-title">{{ t('sales.assignLevel') }}</span>
        <fieldset class="pick">
          <legend>{{ t('sales.levelCarriers') }}</legend>
          <div class="chips">
            <label class="chip all" :class="{ on: allCarriersOn }"><input type="checkbox" :checked="allCarriersOn" @change="toggleAllCarriers">{{ t('sales.allCarriersShort') }}</label>
            <label v-for="c in activeCarriers" :key="c.id" class="chip" :class="{ on: levelForm.carrierIds.includes(c.id) }">
              <input type="checkbox" :checked="levelForm.carrierIds.includes(c.id)" @change="toggleCarrier(c.id)">{{ c.name }}
            </label>
          </div>
          <p v-if="!levelForm.carrierIds.length" class="hint-sm warn">{{ t('sales.levelPickCarrier') }}</p>
        </fieldset>
        <div class="two">
          <Input v-model="levelForm.level" type="number" :label="t('sales.level')" />
          <label class="date">{{ t('sales.effectiveFrom') }}<input v-model="levelForm.effectiveFrom" type="date"></label>
        </div>
        <p class="hint-sm">{{ t('sales.levelHint') }}</p>
      </section>
      <!-- Historial plegado, agrupado por compañía -->
      <div v-if="levelHistory.length" class="history">
        <button type="button" class="h-toggle" :aria-expanded="historyOpen" @click="historyOpen = !historyOpen">
          <ChevronRight :size="15" class="chev" :class="{ open: historyOpen }" />{{ t('sales.levelHistory') }}
        </button>
        <div v-if="historyOpen" class="h-groups">
          <section v-for="g in levelHistory" :key="g.carrier.id">
            <b class="h-carrier">{{ g.carrier.name }}</b>
            <ul><li v-for="l in g.levels" :key="l.effectiveFrom"><b>{{ l.level }}</b> {{ t('sales.since', { date: day(l.effectiveFrom) }) }}</li></ul>
          </section>
        </div>
      </div>
      <template #footer>
        <Button variant="ghost" @click="levelFor = null">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :disabled="!levelValid" @click="saveLevel">{{ t('common.save') }}</Button>
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
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 360px); gap: 20px; align-items: start; }
.card { display: grid; gap: 12px; padding: 18px 20px; background: var(--color-surface); box-shadow: var(--shadow-md); }
.card.accent { border-left: 4px solid var(--color-primary); }
.head { display: grid; gap: 2px; }
.head.row { display: flex; align-items: center; justify-content: space-between; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 19px; }
.head small { color: var(--color-muted); }

.table-wrap { overflow-x: auto; margin: 0 -20px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 8px 10px; text-align: left; vertical-align: middle; border-bottom: 1px solid var(--color-line); }
thead th { font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; background: var(--color-canvas); white-space: nowrap; }
th:first-child, td:first-child { padding-left: 20px; }
tbody th { font-weight: 600; }
.who { display: flex; align-items: center; gap: 10px; }
.who > span { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
/* Resumen de niveles: un solo botón por agente, escala a N compañías; el detalle está en el modal */
.lvl { display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 0 6px 0 10px; font: inherit; font-size: 13px; color: var(--color-ink); background: var(--color-canvas);
  border: 1px solid var(--color-line); border-left: 3px solid var(--color-line-strong); cursor: pointer; white-space: nowrap; width: 100%; min-width: 200px; transition: box-shadow var(--duration), border-color var(--duration); }
.lvl:hover { border-color: var(--color-ink); box-shadow: var(--shadow-sm); }
.lvl b { font-size: 16px; font-variant-numeric: tabular-nums; }
.lvl .scope { color: var(--color-muted); }
.lvl .chev { color: var(--color-muted); margin-left: auto; flex: none; }
.miss { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; font-size: 12px; font-weight: 600; color: var(--color-warning); background: var(--color-warning-light); }
.lvl.none { color: var(--color-warning); background: var(--color-warning-light); border-color: transparent; border-left-color: var(--color-warning); font-weight: 600; }
.lvl.none .chev { color: var(--color-warning); }
.up { width: 180px; min-width: 180px; }
.up :deep(.trigger) { min-width: 0; }
.dc { width: 176px; max-width: 100%; min-height: 36px; padding: 0 10px; font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--color-ink); background: var(--color-surface); border: 1px solid var(--color-line-strong); outline: none; }
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
.pick { display: grid; gap: 8px; margin: 0; padding: 0; border: 0; min-width: 0; }
.pick legend { padding: 0; margin-bottom: 8px; font-size: 13px; font-weight: 500; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 12px 0 10px; font-size: 14px; font-weight: 500; cursor: pointer;
  background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); transition: border-color var(--duration), box-shadow var(--duration), background var(--duration); }
.chip:hover { border-color: var(--color-ink); box-shadow: var(--shadow-md); }
.chip.on { border-color: var(--color-ink); background: var(--color-canvas); }
.chip.all { border-left: 3px solid var(--color-primary); }
.hint-sm.warn { margin: 0; color: var(--color-warning); }
.h-title { font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
.cur, .assign { display: grid; gap: 10px; }
.cur ul { margin: 0; padding: 0; list-style: none; display: grid; box-shadow: var(--shadow-sm); border: 1px solid var(--color-line); }
.cur li + li { border-top: 1px solid var(--color-line); }
.cur-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 0 12px 0 14px; font: inherit; font-size: 14px; text-align: left; color: var(--color-ink);
  background: var(--color-surface); border: 0; border-left: 3px solid transparent; cursor: pointer; transition: background var(--duration), border-color var(--duration); }
.cur-row:hover { background: var(--color-canvas); }
.cur-row.on { background: var(--color-canvas); border-left-color: var(--color-primary); }
.cur-row .nm { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cur-row b { font-size: 16px; font-variant-numeric: tabular-nums; }
.cur-row small { font-size: 12px; color: var(--color-muted); white-space: nowrap; }
.cur-row .edit { color: var(--color-muted); flex: none; }
.assign { padding: 14px 16px 16px; background: var(--color-canvas); border-left: 3px solid var(--color-primary); }
.assign .hint-sm { margin: 0; }
.two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 12px; align-items: start; }
.history { display: grid; gap: 8px; font-size: 13px; color: var(--color-muted); }
.h-toggle { display: inline-flex; align-items: center; gap: 6px; justify-self: start; min-height: 32px; padding: 0 8px 0 2px; font: inherit; font-size: 12px; font-weight: 600; text-transform: uppercase;
  letter-spacing: .03em; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.h-toggle:hover { color: var(--color-ink); }
.h-toggle .chev { transition: transform var(--duration); }
.h-toggle .chev.open { transform: rotate(90deg); }
.h-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px 16px; padding: 10px 14px 12px; background: var(--color-canvas); border-left: 3px solid var(--color-line-strong); }
.history section { display: grid; gap: 2px; align-content: start; }
.history ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
.history b { color: var(--color-ink); }
.h-carrier { font-size: 13px; }

@media (max-width: 1400px) { .split { grid-template-columns: 1fr; } }
@media (max-width: 767px) {
  .body { padding: 14px 16px 32px; }
  .two { grid-template-columns: 1fr; }
  .cur-row { flex-wrap: wrap; row-gap: 2px; padding-top: 8px; padding-bottom: 8px; }
  /* Tabla de agentes como lista de fichas: sin scroll horizontal a 390 px */
  .table-wrap { overflow: visible; margin: 0; }
  table, tbody, tr, th, td { display: block; }
  thead { display: none; }
  tbody tr { display: grid; gap: 8px; padding: 12px 0 14px; border-bottom: 1px solid var(--color-line); }
  tbody th, tbody td { padding: 0 !important; border: 0; }
  .lvl { min-width: 0; white-space: normal; flex-wrap: wrap; }
  .lvl .chev { margin-left: auto; }
  .up { width: auto; min-width: 0; }
  .lvl { width: 100%; }
  .dc { width: 100%; }
  td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 4px; font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: .03em; }
}
</style>
