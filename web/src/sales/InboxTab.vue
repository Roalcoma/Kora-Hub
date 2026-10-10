<script setup lang="ts">
// Bandeja de Discord (Admin): mensajes del canal de ventas que el lector no pudo completar. Se enlaza al autor con su
// cuenta de Kora (y sus mensajes pendientes se vuelven ventas), se completa a mano o se descarta.
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Inbox, RefreshCw, PenLine, X, Link2 } from 'lucide-vue-next';
import type { InboxItem } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';
import Dropdown from '@/design/Dropdown.vue';
import EmptyState from '@/design/EmptyState.vue';
import Pagination from '@/design/Pagination.vue';
import { usePaged } from '@/design/paged.ts';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useSales } from './store.ts';
import { usd, fmtDay } from './format.ts';
import SaleModal from './SaleModal.vue';

const emit = defineEmits<{ changed: [] }>();
const { t, locale, d } = useI18n();
const s = useSession();
const ref_ = useSales();
const slug = () => s.workspace!.slug;

const items = ref<InboxItem[] | null>(null);
async function load() {
  try { items.value = await api('GET /w/:slug/sales-inbox', { params: { slug: slug() } }); } catch (e) { toast(errorText(e), 'error'); }
  emit('changed');
}
onMounted(load);

const { page, size, rows: pageItems, total } = usePaged(computed(() => items.value ?? []));
const pagerLabels = computed(() => ({ prev: t('common.pager.prev'), next: t('common.pager.next'), perPage: t('common.pager.perPage'), of: t('common.pager.of') }));
const busy = ref(false);
async function run(fn: () => Promise<unknown>, ok?: (r: any) => string) {
  busy.value = true;
  try {
    const r = await fn();
    if (ok) toast(ok(r), 'success');
    await Promise.all([load(), ref_.load(true)]);
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
const created = (r: { created: number }) => t('sales.inboxCreated', { n: r.created }, r.created);
const retry = () => run(() => api('POST /w/:slug/sales-inbox/retry', { params: { slug: slug() } }), created);
const link = (it: InboxItem, userId: string) => userId && run(() => api('POST /w/:slug/sales-inbox/:id/link', { params: { slug: slug(), id: it.id }, body: { userId } }), created);
const dismiss = (it: InboxItem) => run(() => api('POST /w/:slug/sales-inbox/:id/dismiss', { params: { slug: slug(), id: it.id } }), () => t('sales.inboxDismissed'));

const memberOptions = computed(() => ref_.sellers.map((m) => ({ value: m.userId, label: m.name })));
const completing = ref<InboxItem | null>(null);
const modal = computed({ get: () => !!completing.value, set: (v) => { if (!v) completing.value = null; } });
/** Lo que sí se entendió del mensaje, para mostrarlo junto al original */
const understood = (it: InboxItem) => [
  it.parsed.amount ? usd(it.parsed.amount, locale.value) : null,
  it.parsed.productId ? ref_.productLabel(it.parsed.productId) : it.parsed.carrierId ? ref_.carrier(it.parsed.carrierId)?.name : null,
  it.parsed.expectedIssueDate ? fmtDay(it.parsed.expectedIssueDate, locale.value) : null,
  it.parsed.clientName, it.parsed.clientState,
].filter(Boolean).join(' · ');
</script>

<template>
  <div class="body">
    <div class="head">
      <p class="intro">{{ t('sales.inboxIntro') }}</p>
      <Button :loading="busy" @click="retry"><RefreshCw :size="16" />{{ t('sales.inboxRetry') }}</Button>
    </div>
    <div v-if="!items" class="grid gap-3"><Skeleton v-for="n in 3" :key="n" height="90px" /></div>
    <EmptyState v-else-if="!items.length" :icon="Inbox" :title="t('sales.inboxEmpty')" :text="t('sales.inboxEmptyText')" />
    <article v-for="it in pageItems" v-else :key="it.id" class="msg">
      <header>
        <b>{{ it.authorName }}</b><small>{{ d(it.postedAt, 'long') }}</small>
        <span class="probs"><Badge v-for="p in it.problems" :key="p" tone="warning">{{ t(`sales.problems.${p}`) }}</Badge></span>
      </header>
      <blockquote>{{ it.content }}</blockquote>
      <p v-if="understood(it)" class="got">{{ t('sales.inboxUnderstood') }}: {{ understood(it) }}</p>
      <footer>
        <div v-if="it.problems.includes('agent')" class="link">
          <Link2 :size="16" /><span>{{ t('sales.inboxWho', { name: it.authorName }) }}</span>
          <Dropdown :model-value="''" :options="memberOptions" :placeholder="t('sales.pickAgent')" searchable :search-placeholder="t('sales.searchAgent')"
            :aria-label="t('sales.inboxWho', { name: it.authorName })" @update:model-value="(v) => link(it, v ?? '')" />
        </div>
        <span class="acts">
          <Button size="sm" variant="primary" @click="completing = it"><PenLine :size="15" />{{ t('sales.inboxComplete') }}</Button>
          <Button size="sm" variant="ghost" :disabled="busy" @click="dismiss(it)"><X :size="15" />{{ t('sales.inboxDismiss') }}</Button>
        </span>
      </footer>
    </article>
    <Pagination v-if="items?.length" v-model="page" v-model:size="size" :total="total" :labels="pagerLabels" />
    <SaleModal v-model="modal" :inbox="completing" @saved="load" />
  </div>
</template>

<style scoped>
.body { flex: 1; overflow: auto; display: grid; grid-auto-rows: max-content; gap: 14px; align-content: start; padding: 18px 32px 40px 28px; }
.head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.intro { margin: 0; max-width: 680px; color: var(--color-muted); line-height: 1.5; }
.msg { display: grid; gap: 10px; padding: 16px 20px; background: var(--color-surface); border-left: 4px solid var(--color-cat-purple); box-shadow: var(--shadow-md); }
.msg header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.msg header small { color: var(--color-muted); font-size: 13px; }
.probs { display: flex; gap: 6px; margin-left: auto; }
blockquote { margin: 0; padding: 10px 14px; font-size: 15px; background: var(--color-canvas); border-left: 3px solid var(--color-line-strong); }
.got { margin: 0; font-size: 13px; color: var(--color-muted); }
.msg footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.link { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; }
.link :deep(.dd) { width: 240px; }
.acts { display: flex; gap: 6px; margin-left: auto; }
@media (max-width: 767px) { .body { padding: 14px 16px 32px; } .probs { margin-left: 0; } }
</style>
