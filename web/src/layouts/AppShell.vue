<script setup lang="ts">
// Shell tipo Slack (§7.2). Escritorio: riel + sidebar + contenido. Móvil: pantallas apiladas + barra inferior;
// en Inicio el sidebar ocupa la pantalla; dentro de un canal la barra se oculta para dejar el compositor junto al teclado.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ChevronDown, Search, BookOpen, SquareKanban, Target, Settings, House, MessageCircle, AtSign, SquareCheck, CircleUser, LogOut } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';
import Dropdown from '@/design/Dropdown.vue';
import Kbd from '@/design/Kbd.vue';
import Tooltip from '@/design/Tooltip.vue';
import ContextMenu from '@/design/ContextMenu.vue';
import ChannelList from '@/chat/ChannelList.vue';
import QuickSwitcher from '@/chat/QuickSwitcher.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const chat = useChat();

// El chat se reinicia al cambiar de workspace
watch(() => s.workspace?.slug, (slug, old) => {
  if (old) chat.disconnect();
  if (slug) chat.init();
}, { immediate: true });
onBeforeUnmount(() => chat.disconnect());

const base = computed(() => `/w/${s.workspace!.slug}`);
const lineOptions = computed(() => [
  { value: '', label: t('nav.allLines') },
  ...s.workspace!.lines.filter((l) => !l.archivedAt).map((l) => ({ value: l.id, label: l.name })),
]);
const line = computed({ get: () => s.lineId ?? '', set: (v: string) => { s.lineId = v || null; } });

const agencyNav = computed(() => [
  { to: `${base.value}/manuals`, icon: BookOpen, label: t('nav.manuals') },
  { to: `${base.value}/tasks`, icon: SquareKanban, label: t('nav.tasks') },
  { to: `${base.value}/goals`, icon: Target, label: t('nav.goals') },
  ...(s.isAdmin ? [{ to: `${base.value}/settings`, icon: Settings, label: t('nav.settings') }] : []),
]);

const dmUnread = computed(() => chat.channels.filter((c) => (c.kind === 'dm' || c.kind === 'group_dm') && c.isMember).reduce((n, c) => n + c.unreadCount, 0));
const mentionUnread = computed(() => chat.channels.filter((c) => c.isMember && c.kind !== 'dm' && c.kind !== 'group_dm').reduce((n, c) => n + c.mentionCount, 0));
const tabs = computed(() => [
  { to: base.value, icon: House, label: t('nav.home'), on: route.name === 'home', badge: 0 },
  { to: `${base.value}/dms`, icon: MessageCircle, label: t('nav.messages'), on: route.path.endsWith('/dms'), badge: dmUnread.value },
  { to: `${base.value}/mentions`, icon: AtSign, label: t('nav.mentions'), on: route.path.endsWith('/mentions'), badge: mentionUnread.value },
  { to: `${base.value}/tasks`, icon: SquareCheck, label: t('nav.tasks'), on: route.path.includes('/tasks'), badge: 0 },
  { to: `${base.value}/settings/profile`, icon: CircleUser, label: t('nav.you'), on: route.path.includes('/settings'), badge: 0 },
]);
const onHome = computed(() => route.name === 'home');
const inConversation = computed(() => ['channel', 'thread'].includes(route.name as string));

// Título de la pestaña con no leídos
watch(() => chat.totalUnread, (n) => { document.title = n ? `(${n}) Agencia Hub` : 'Agencia Hub'; }, { immediate: true });

const switcher = ref(false);
const onKey = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); switcher.value = true; }
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const wsMenu = ref(false);
const menuPos = ref({ x: 0, y: 0 });
function openWsMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = { x: r.left, y: r.bottom + 4 };
  wsMenu.value = true;
}
const wsMenuItems = computed(() => [
  { label: t('nav.settings'), icon: Settings, action: () => router.push(`${base.value}/settings`) },
  { label: t('nav.logout'), icon: LogOut, danger: true, action: async () => { chat.disconnect(); await s.logout(); router.replace('/login'); } },
]);
const initials = (n: string) => n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
</script>

<template>
  <div class="shell" :class="{ 'on-home': onHome, 'in-conv': inConversation }">
    <nav class="rail" :aria-label="t('nav.agency')">
      <Tooltip v-for="w in s.session!.workspaces" :key="w.id" :text="w.name" side="right">
        <RouterLink :to="`/w/${w.slug}`" class="ws" :class="{ active: w.slug === s.workspace!.slug }" :aria-label="w.name">{{ initials(w.name) }}</RouterLink>
      </Tooltip>
    </nav>

    <aside class="sidebar">
      <div class="sb-head">
        <button class="sb-ws" type="button" @click="openWsMenu">{{ s.workspace!.name }}<ChevronDown :size="16" /></button>
        <Dropdown v-model="line" :options="lineOptions" dark :aria-label="t('nav.line')" />
        <button class="sb-search" type="button" @click="switcher = true"><Search :size="15" />{{ t('nav.search') }}<Kbd class="ml-auto">Ctrl K</Kbd></button>
      </div>
      <div class="sb-scroll">
        <ChannelList />
        <h4>{{ t('nav.agency') }}</h4>
        <RouterLink v-for="n in agencyNav" :key="n.to" :to="n.to" class="sb-item" :class="{ active: route.path.startsWith(n.to) }">
          <component :is="n.icon" :size="16" />{{ n.label }}
        </RouterLink>
      </div>
    </aside>

    <main class="main"><RouterView :key="route.name === 'thread' || route.name === 'channel' ? 'conv' : route.fullPath" /></main>

    <nav class="tabbar" :aria-label="t('nav.home')">
      <RouterLink v-for="tb in tabs" :key="tb.label" :to="tb.to" :class="{ on: tb.on }">
        <span class="tab-ico"><component :is="tb.icon" :size="22" /><span v-if="tb.badge" class="tab-badge">{{ tb.badge }}</span></span>{{ tb.label }}
      </RouterLink>
    </nav>
    <ContextMenu v-model="wsMenu" :items="wsMenuItems" :x="menuPos.x" :y="menuPos.y" />
    <QuickSwitcher v-model="switcher" />
  </div>
</template>

<style scoped>
.shell { height: 100%; display: grid; grid-template-columns: 64px 264px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.rail { position: relative; z-index: 6; background: var(--color-ink-soft); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 14px 0; box-shadow: 2px 0 8px rgb(0 0 0 / .25); }
.ws { position: relative; width: 40px; height: 40px; display: grid; place-items: center; font-family: var(--font-display); font-weight: 700; font-size: 15px; background: #2B4467; color: #fff; text-decoration: none; box-shadow: 0 3px 8px rgb(0 0 0 / .3); transition: transform var(--duration), box-shadow var(--duration); }
.ws:hover { transform: translateY(-1px); box-shadow: 0 6px 14px rgb(0 0 0 / .35); }
.ws.active { background: var(--color-primary); color: var(--color-ink); }
.ws.active::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 4px; background: #fff; }
/* El sidebar proyecta sombra sobre el área de trabajo */
.sidebar { position: relative; z-index: 5; background: linear-gradient(180deg, var(--color-ink) 0%, #0F1E34 100%); color: var(--color-sidebar-text); display: flex; flex-direction: column; min-height: 0; box-shadow: 6px 0 22px rgb(19 36 61 / .28); }
.sb-head { padding: 14px 16px 12px; display: grid; gap: 10px; border-bottom: 1px solid rgb(255 255 255 / .08); box-shadow: 0 6px 12px -8px rgb(0 0 0 / .5); }
.sb-ws { display: flex; align-items: center; gap: 6px; padding: 0; font: 700 18px var(--font-display); color: #fff; background: none; border: 0; cursor: pointer; text-align: left; }
.sb-search { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 10px; font: inherit; font-size: 14px; color: var(--color-sidebar-text); background: rgb(0 0 0 / .22); border: 0; box-shadow: inset 0 1px 3px rgb(0 0 0 / .35); cursor: pointer; }
.sb-search:hover { color: #fff; }
.sb-scroll { overflow: auto; padding: 6px 0 20px; display: grid; align-content: start; gap: 2px; }
h4 { margin: 16px 0 2px; padding: 0 16px; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: #8FA0B8; }
.sb-item { position: relative; display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 16px; font-size: 15px; color: var(--color-sidebar-text); text-decoration: none; transition: background var(--duration), color var(--duration); }
.sb-item:hover { background: var(--color-ink-soft); color: #fff; }
.sb-item.active { background: var(--color-ink-soft); color: #fff; font-weight: 500; box-shadow: 0 6px 16px rgb(0 0 0 / .28); }
.sb-item.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-primary); }
.main { min-width: 0; min-height: 0; overflow: auto; background: var(--color-canvas); }
.tabbar { display: none; }

@media (max-width: 767px) {
  .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  .rail { display: none; }
  .sidebar { display: none; padding-top: env(safe-area-inset-top, 0px); box-shadow: none; }
  .on-home .sidebar { display: flex; }
  .on-home .main { display: none; }
  .main { padding-top: env(safe-area-inset-top, 0px); overflow: hidden; }
  .sb-item { min-height: var(--tap); font-size: 16px; }
  .tabbar { position: relative; z-index: 6; display: grid; grid-template-columns: repeat(5, 1fr); background: var(--color-surface); border-top: 1px solid var(--color-line); padding-bottom: env(safe-area-inset-bottom, 0px); box-shadow: 0 -6px 18px rgb(19 36 61 / .10); }
  .in-conv { grid-template-rows: minmax(0, 1fr); }
  .in-conv .tabbar { display: none; }
  .tabbar a { position: relative; display: grid; justify-items: center; align-content: center; gap: 3px; min-height: 54px; font-size: 11px; color: var(--color-muted); text-decoration: none; }
  .tabbar a.on { color: var(--color-ink); font-weight: 700; }
  .tabbar a.on::before { content: ''; position: absolute; top: -1px; left: 22%; right: 22%; height: 3px; background: var(--color-primary); }
  .tab-ico { position: relative; display: grid; }
  .tab-badge { position: absolute; top: -5px; left: 14px; min-width: 18px; padding: 0 4px; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; color: var(--color-ink); background: var(--color-primary); box-shadow: var(--shadow-sm); }
}
</style>
