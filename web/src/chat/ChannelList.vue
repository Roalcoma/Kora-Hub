<script setup lang="ts">
// Secciones del sidebar: Anuncios, Destacados, Canales y Mensajes directos. Filtra por la línea de negocio activa.
// Canales en cascada: bajo el canal general de un departamento (sin línea) cuelgan los de sus líneas; cada grupo se
// despliega o contrae (se recuerda por agencia en este navegador). Contraído, el general suma los avisos de sus líneas.
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Hash, Lock, Megaphone, Plus, ChevronDown, ChevronRight, BellOff, Users } from 'lucide-vue-next';
import type { Channel } from '@agencia-hub/contracts';
import { useSession } from '@/stores/session.ts';
import Avatar from '@/design/Avatar.vue';
import { useChat } from './store.ts';
import ChannelDialogs from './ChannelDialogs.vue';

const { t } = useI18n();
const route = useRoute();
const s = useSession();
const chat = useChat();
const base = computed(() => `/w/${s.workspace!.slug}`);
const dialog = ref<'channel' | 'dm' | null>(null);
const collapsed = ref<Record<string, boolean>>({});

const mine = computed(() => chat.channels.filter((c) => c.isMember && !c.archivedAt));
const byLine = (c: Channel) => !s.lineId || !c.lineId || c.lineId === s.lineId;
const isDm = (c: Channel) => c.kind === 'dm' || c.kind === 'group_dm';
const announcement = computed(() => mine.value.find((c) => c.kind === 'announcement'));
const starred = computed(() => mine.value.filter((c) => c.starred && c.kind !== 'announcement' && byLine(c)));
const tree = computed(() => {
  const flat = mine.value.filter((c) => !c.starred && !isDm(c) && c.kind !== 'announcement' && byLine(c));
  // Un solo canal general por departamento (el privado, si hay público y privado): de él cuelgan los de línea
  const general = new Map<string, Channel>();
  for (const c of flat) {
    if (c.departmentId && !c.lineId && (!general.has(c.departmentId) || c.kind === 'private')) general.set(c.departmentId, c);
  }
  const linePos = (c: Channel) => s.workspace!.lines.findIndex((l) => l.id === c.lineId);
  const sub = new Set<string>();
  const kids = new Map<string, Channel[]>();
  const parentOf = new Map<string, string>();
  const out: Channel[] = [];
  for (const c of flat) {
    if (c.lineId && c.departmentId && general.has(c.departmentId)) continue;   // va debajo de su canal general
    out.push(c);
    if (c.departmentId && general.get(c.departmentId) === c) {
      const ks = flat.filter((x) => x.departmentId === c.departmentId && x.lineId).sort((a, b) => linePos(a) - linePos(b));
      if (ks.length) kids.set(c.id, ks);
      for (const k of ks) {
        sub.add(k.id);
        parentOf.set(k.id, c.id);
        out.push(k);
      }
    }
  }
  return { out, sub, kids, parentOf };
});

// Grupos contraídos (ids de los canales generales), por agencia
const foldKey = computed(() => `kora.folded.${s.workspace!.slug}`);
const readFolded = () => { try { return JSON.parse(localStorage.getItem(foldKey.value) ?? '[]') as string[]; } catch { return []; } };
const folded = ref<string[]>(readFolded());
watch(foldKey, () => { folded.value = readFolded(); });
function toggleFold(id: string) {
  folded.value = folded.value.includes(id) ? folded.value.filter((x) => x !== id) : [...folded.value, id];
  try { localStorage.setItem(foldKey.value, JSON.stringify(folded.value)); } catch { /* sin almacenamiento: solo esta sesión */ }
}
const isFolded = (c: Channel) => folded.value.includes(c.id) && tree.value.kids.has(c.id);
// Contraído, el canal que estás viendo sigue visible aunque sea de una línea
const channels = computed(() => tree.value.out.filter((c) => {
  const parent = tree.value.parentOf.get(c.id);
  return !parent || !folded.value.includes(parent) || active(c);
}));
const hidden = (c: Channel) => (isFolded(c) ? tree.value.kids.get(c.id)!.filter((k) => !active(k)) : []);
const dms = computed(() => mine.value.filter((c) => isDm(c) && !c.starred)
  .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')).slice(0, 15));

const active = (c: Channel) => route.params.id === c.id;
const peer = (c: Channel) => chat.memberById.get((c.memberIds ?? []).find((id) => id !== s.user!.id) ?? s.user!.id);
const ownBadge = (c: Channel) => (isDm(c) || c.kind === 'announcement' ? c.unreadCount : c.mentionCount);
const badge = (c: Channel) => ownBadge(c) + hidden(c).reduce((n, k) => n + (k.muted ? 0 : k.mentionCount), 0);
const unread = (c: Channel) => (c.unreadCount && !c.muted) || hidden(c).some((k) => k.unreadCount && !k.muted);
const icon = (c: Channel) => (c.kind === 'private' ? Lock : Hash);
const sections = computed(() => [
  { key: 'starred', title: t('chat.starred'), items: starred.value, add: null },
  { key: 'channels', title: t('chat.channels'), items: channels.value, add: 'channel' as const },
  { key: 'dms', title: t('chat.directMessages'), items: dms.value, add: 'dm' as const },
].filter((x) => x.items.length || x.add));
</script>

<template>
  <nav class="list">
    <RouterLink v-if="announcement" :to="`${base}/c/${announcement.id}`" class="item ann" :class="{ active: active(announcement), unread: announcement.unreadCount }">
      <Megaphone :size="16" /><span class="name">{{ t('chat.announcements') }}</span>
      <span v-if="announcement.unreadCount" class="badge">{{ announcement.unreadCount }}</span>
    </RouterLink>

    <section v-for="sec in sections" :key="sec.key">
      <h4>
        <button type="button" class="sec" :aria-expanded="!collapsed[sec.key]" @click="collapsed[sec.key] = !collapsed[sec.key]">
          <ChevronDown :size="14" :class="{ rot: collapsed[sec.key] }" />{{ sec.title }}
        </button>
        <button v-if="sec.add" type="button" class="plus" :aria-label="sec.add === 'channel' ? t('chat.addChannel') : t('chat.newMessage')" @click="dialog = sec.add"><Plus :size="15" /></button>
      </h4>
      <template v-if="!collapsed[sec.key]">
        <div v-for="c in sec.items" :key="c.id" class="it">
        <RouterLink :to="`${base}/c/${c.id}`" class="item"
          :class="{ active: active(c), unread: unread(c), muted: c.muted, sub: sec.key === 'channels' && tree.sub.has(c.id), parent: sec.key === 'channels' && tree.kids.has(c.id) }">
          <template v-if="isDm(c)">
            <Avatar v-if="c.kind === 'dm'" :name="peer(c)?.name ?? '?'" :size="20" :presence="peer(c)?.presence" />
            <span v-else class="grp"><Users :size="13" /></span>
          </template>
          <component :is="icon(c)" v-else :size="16" />
          <span class="name">{{ chat.channelTitle(c) }}<small v-if="c.kind === 'dm' && peer(c)?.userId === s.user!.id"> ({{ t('chat.you') }})</small></span>
          <BellOff v-if="c.muted" :size="13" class="mute" />
          <span v-else-if="badge(c)" class="badge">{{ badge(c) }}</span>
        </RouterLink>
        <button v-if="sec.key === 'channels' && tree.kids.has(c.id)" type="button" class="fold" :aria-expanded="!isFolded(c)"
          :aria-label="`${isFolded(c) ? t('chat.expandGroup') : t('chat.collapseGroup')} · ${c.name}`" @click="toggleFold(c.id)">
          <ChevronRight v-if="isFolded(c)" :size="16" /><ChevronDown v-else :size="16" />
        </button>
        </div>
        <button v-if="sec.add" type="button" class="item add" @click="dialog = sec.add">
          <Plus :size="16" />{{ sec.add === 'channel' ? t('chat.addChannel') : t('chat.newMessage') }}
        </button>
      </template>
    </section>
    <ChannelDialogs v-model="dialog" />
  </nav>
</template>

<style scoped>
.list { display: grid; gap: 6px; }
h4 { display: flex; align-items: center; margin: 10px 0 2px; padding: 0 8px 0 10px; }
.sec { flex: 1; display: flex; align-items: center; gap: 4px; padding: 4px 6px; font: inherit; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: #8FA0B8; background: none; border: 0; cursor: pointer; text-align: left; }
.sec:hover { color: #fff; }
.sec .rot { transform: rotate(-90deg); }
.plus { width: 26px; height: 26px; display: grid; place-items: center; color: #8FA0B8; background: none; border: 0; cursor: pointer; opacity: 0; transition: opacity var(--duration), background var(--duration); }
h4:hover .plus, .plus:focus-visible { opacity: 1; }
.plus:hover { background: var(--color-ink-soft); color: #fff; }
.item { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 32px; padding: 0 12px 0 16px; font: inherit; font-size: 15px; text-align: left; color: var(--color-sidebar-text); text-decoration: none; background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration), box-shadow var(--duration); }
.item:hover { background: var(--color-ink-soft); color: #fff; }
.item.unread { color: #fff; font-weight: 700; }
.item.muted { opacity: .55; }
/* Ítem activo: se eleva respecto del sidebar, con barra naranja a la izquierda */
.item.active { background: var(--color-ink-soft); color: #fff; font-weight: 500; box-shadow: 0 6px 16px rgb(0 0 0 / .28); z-index: 1; }
.item.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-primary); }
.item.ann { margin-top: 4px; }
.it { position: relative; }
/* Canal general con líneas: flecha a la derecha para desplegar o contraer el grupo */
.item.parent { padding-right: 44px; }
.fold { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); z-index: 2; width: 32px; height: 28px; display: grid; place-items: center; color: #8FA0B8; background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration); }
.fold:hover { background: rgb(255 255 255 / .08); color: #fff; }
.fold:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
/* Canal de una línea bajo el general de su departamento: sangría y guía vertical */
.item.sub { padding-left: 38px; font-size: 14px; }
.item.sub::after { content: ''; position: absolute; left: 23px; top: 0; bottom: 0; width: 1px; background: rgb(255 255 255 / .14); }
.item.add { color: #8FA0B8; font-size: 14px; }
.item.add:hover { color: var(--color-cta); }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name small { font-weight: 400; color: #8FA0B8; }
.badge { min-width: 20px; padding: 0 6px; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; color: var(--color-ink); background: var(--color-primary); box-shadow: 0 2px 6px rgb(0 0 0 / .3); font-variant-numeric: tabular-nums; }
.mute { color: #8FA0B8; }
.grp { width: 20px; height: 20px; display: grid; place-items: center; background: #2B4467; color: #fff; }
.item :deep(.av .presence) { border-color: var(--color-ink); }
@media (max-width: 767px) { .item { min-height: var(--tap); font-size: 16px; } .fold { width: var(--tap); height: var(--tap); right: 0; } .plus { opacity: 1; width: 36px; height: 36px; } }
</style>
