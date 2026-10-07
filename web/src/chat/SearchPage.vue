<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Search, Hash, FileText, ChevronLeft } from 'lucide-vue-next';
import type { SearchResult } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import Dropdown from '@/design/Dropdown.vue';
import Avatar from '@/design/Avatar.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { useChat } from './store.ts';
import { renderBody } from './format.ts';

const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const chat = useChat();
const base = computed(() => `/w/${s.workspace!.slug}`);

const q = ref((route.query.q as string) ?? '');
const channelId = ref('');
const userId = ref('');
const hasFiles = ref(false);
const from = ref('');
const to = ref('');
const results = ref<SearchResult[] | null>(null);
const loading = ref(false);

const channelOptions = computed(() => [{ value: '', label: t('chat.anyChannel') },
  ...chat.channels.filter((c) => c.kind !== 'dm' && c.kind !== 'group_dm').map((c) => ({ value: c.id, label: `#${chat.channelTitle(c)}` }))]);
const personOptions = computed(() => [{ value: '', label: t('chat.anyone') }, ...chat.members.map((m) => ({ value: m.userId, label: m.name }))]);

async function run() {
  if (q.value.trim().length < 2) return;
  router.replace({ query: { q: q.value.trim() } });
  loading.value = true;
  try {
    results.value = await api('GET /w/:slug/search', { params: { slug: s.workspace!.slug }, query: {
      q: q.value.trim(), channelId: channelId.value || undefined, userId: userId.value || undefined,
      hasFiles: hasFiles.value || undefined, from: from.value || undefined, to: to.value || undefined, limit: 30 } });
  } finally {
    loading.value = false;
  }
}
watch([channelId, userId, hasFiles, from, to], run);
if (q.value) run();
const html = (h: string) => renderBody(h, (id) => chat.memberById.get(id)?.name, s.user!.id);
</script>

<template>
  <div class="search">
    <header class="top">
      <button type="button" class="back" :aria-label="t('common.back')" @click="router.back()"><ChevronLeft :size="22" /></button>
      <form class="q" @submit.prevent="run"><Search :size="18" /><input v-model="q" :placeholder="t('chat.searchPlaceholder')" :aria-label="t('chat.search')" autofocus></form>
    </header>
    <div class="filters">
      <Dropdown v-model="channelId" :options="channelOptions" />
      <Dropdown v-model="userId" :options="personOptions" />
      <label class="chk"><input v-model="hasFiles" type="checkbox">{{ t('chat.hasFiles') }}</label>
      <label class="date">{{ t('chat.from') }} <input v-model="from" type="date"></label>
      <label class="date">{{ t('chat.until') }} <input v-model="to" type="date"></label>
    </div>
    <div class="results">
      <div v-if="loading" class="grid gap-3"><Skeleton v-for="n in 4" :key="n" height="72px" /></div>
      <EmptyState v-else-if="results && !results.length" :icon="Search" :title="t('chat.noResults', { q })" />
      <template v-else-if="results">
        <RouterLink v-for="r in results" :key="r.type === 'message' ? r.message.id : r.file.id" class="hit"
          :to="r.type === 'message' ? `${base}/c/${r.message.channelId}${r.message.parentId ? `/t/${r.message.parentId}` : ''}?m=${r.message.id}` : `${base}/c/${r.channelId}?m=${r.messageId}`">
          <template v-if="r.type === 'message'">
            <Avatar :name="chat.nameOf(r.message.userId)" :size="34" />
            <div class="txt">
              <div class="meta"><b>{{ chat.nameOf(r.message.userId) }}</b><span><Hash :size="12" />{{ r.channelName ?? chat.channelTitle(chat.channelById(r.message.channelId)!) }}</span><time>{{ d(r.message.createdAt, 'short') }}</time></div>
              <!-- eslint-disable-next-line vue/no-v-html -- renderBody escapa el texto -->
              <p v-html="html(r.highlight)" />
            </div>
          </template>
          <template v-else>
            <span class="file-ico"><FileText :size="18" /></span>
            <div class="txt"><b>{{ r.file.name }}</b><small>{{ (r.file.size / 1024).toFixed(0) }} KB</small></div>
          </template>
        </RouterLink>
      </template>
    </div>
  </div>
</template>

<style scoped>
.search { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.top { display: flex; align-items: center; gap: 8px; padding: 10px 18px 10px 22px; background: var(--color-surface); box-shadow: var(--shadow-md); position: relative; z-index: 2; }
.back { display: none; width: var(--tap); height: var(--tap); place-items: center; background: none; border: 0; cursor: pointer; color: inherit; }
.q { flex: 1; max-width: 720px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border: 1px solid var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .2); }
.q input { flex: 1; min-height: 42px; font: inherit; font-size: 16px; border: 0; outline: none; background: transparent; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 22px; }
.filters .dd { width: 200px; }
.chk, .date { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--color-muted); }
.date input { font: inherit; padding: 6px 8px; border: 1px solid var(--color-line-strong); background: var(--color-surface); }
.results { flex: 1; overflow: auto; padding: 4px 22px 24px; display: grid; gap: 10px; align-content: start; max-width: 900px; }
.hit { display: flex; gap: 12px; padding: 12px 14px; color: inherit; text-decoration: none; background: var(--color-surface); border-left: 3px solid transparent; box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration), border-color var(--duration); }
.hit:hover { box-shadow: var(--shadow-md); transform: translateX(3px); border-left-color: var(--color-primary); }
.txt { min-width: 0; display: grid; gap: 2px; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 13px; }
.meta span { display: inline-flex; align-items: center; gap: 2px; color: var(--color-muted); }
.meta time { color: var(--color-muted); font-size: 12px; }
.txt p { margin: 0; line-height: 1.45; overflow-wrap: anywhere; }
.txt p :deep(mark) { background: var(--color-primary-light); box-shadow: inset 0 -2px 0 var(--color-primary); color: inherit; }
.file-ico { width: 36px; height: 40px; display: grid; place-items: center; background: var(--color-leaf); color: #fff; flex: none; }
input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--color-ink); }
@media (max-width: 767px) { .back { display: grid; } .top { padding: 8px 12px 8px 4px; } .filters, .results { padding-left: 12px; padding-right: 12px; } .filters .dd { width: calc(50% - 6px); } }
</style>
