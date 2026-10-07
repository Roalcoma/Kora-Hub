<script setup lang="ts">
// Shell tipo Slack (§7.2). Escritorio: riel + sidebar + contenido. Móvil: pantallas apiladas + barra inferior;
// en la pestaña Inicio el sidebar ocupa la pantalla completa.
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  ChevronDown, Search, House, BookOpen, SquareKanban, Target, Settings, MessageCircle, AtSign, SquareCheck, CircleUser, LogOut, Megaphone,
} from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import Dropdown from '@/design/Dropdown.vue';
import Kbd from '@/design/Kbd.vue';
import Tooltip from '@/design/Tooltip.vue';
import ContextMenu from '@/design/ContextMenu.vue';
import { toast } from '@/design/toast.ts';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();

const base = computed(() => `/w/${s.workspace!.slug}`);
const lineOptions = computed(() => [
  { value: '', label: t('nav.allLines') },
  ...s.workspace!.lines.filter((l) => !l.archivedAt).map((l) => ({ value: l.id, label: l.name })),
]);
const line = computed({ get: () => s.lineId ?? '', set: (v: string) => { s.lineId = v || null; } });

const nav = computed(() => [
  { to: base.value, icon: House, label: t('nav.home'), exact: true },
  { to: `${base.value}/manuals`, icon: BookOpen, label: t('nav.manuals') },
  { to: `${base.value}/tasks`, icon: SquareKanban, label: t('nav.tasks') },
  { to: `${base.value}/goals`, icon: Target, label: t('nav.goals') },
  ...(s.isAdmin ? [{ to: `${base.value}/settings`, icon: Settings, label: t('nav.settings') }] : []),
]);
const isActive = (to: string, exact?: boolean) => (exact ? route.path === to : route.path.startsWith(to));

const tabs = computed(() => [
  { to: base.value, icon: House, label: t('nav.home') },
  { to: base.value, icon: MessageCircle, label: t('nav.messages') },
  { to: base.value, icon: AtSign, label: t('nav.mentions') },
  { to: `${base.value}/tasks`, icon: SquareCheck, label: t('nav.tasks') },
  { to: `${base.value}/settings/profile`, icon: CircleUser, label: t('nav.you') },
]);
const onHome = computed(() => route.name === 'home');

const wsMenu = ref(false);
const menuPos = ref({ x: 0, y: 0 });
function openWsMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = { x: r.left, y: r.bottom + 4 };
  wsMenu.value = true;
}
const wsMenuItems = computed(() => [
  { label: t('nav.settings'), icon: Settings, action: () => router.push(`${base.value}/settings`) },
  { label: t('nav.logout'), icon: LogOut, danger: true, action: async () => { await s.logout(); router.replace('/login'); } },
]);
const initials = (n: string) => n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
</script>

<template>
  <div class="shell" :class="{ 'on-home': onHome }">
    <nav class="rail" :aria-label="t('nav.agency')">
      <Tooltip v-for="w in s.session!.workspaces" :key="w.id" :text="w.name" side="right">
        <RouterLink :to="`/w/${w.slug}`" class="ws" :class="{ active: w.slug === s.workspace!.slug }" :aria-label="w.name">{{ initials(w.name) }}</RouterLink>
      </Tooltip>
    </nav>

    <aside class="sidebar">
      <div class="sb-head">
        <button class="sb-ws" type="button" @click="openWsMenu">{{ s.workspace!.name }}<ChevronDown :size="16" /></button>
        <Dropdown v-model="line" :options="lineOptions" dark :aria-label="t('nav.line')" />
        <button class="sb-search" type="button" @click="toast(t('soon.text'))"><Search :size="15" />{{ t('nav.search') }}<Kbd class="ml-auto">Ctrl K</Kbd></button>
      </div>
      <div class="sb-scroll">
        <RouterLink :to="base" class="sb-item" :class="{ active: false }" @click.prevent="toast(t('soon.text'))"><Megaphone :size="16" />{{ t('nav.announcements') }}</RouterLink>
        <h4>{{ t('nav.agency') }}</h4>
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" class="sb-item" :class="{ active: isActive(n.to, n.exact) }">
          <component :is="n.icon" :size="16" />{{ n.label }}
        </RouterLink>
      </div>
    </aside>

    <main class="main"><RouterView /></main>

    <nav class="tabbar" :aria-label="t('nav.home')">
      <RouterLink v-for="(tb, i) in tabs" :key="i" :to="tb.to" :class="{ on: i === 0 ? onHome : i === 3 ? route.path.includes('/tasks') : i === 4 ? route.path.includes('/settings') : false }">
        <component :is="tb.icon" :size="22" />{{ tb.label }}
      </RouterLink>
    </nav>
    <ContextMenu v-model="wsMenu" :items="wsMenuItems" :x="menuPos.x" :y="menuPos.y" />
  </div>
</template>

<style scoped>
.shell { height: 100%; display: grid; grid-template-columns: 64px 260px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.rail { background: var(--color-ink-soft); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 14px 0; }
.ws { position: relative; width: 40px; height: 40px; display: grid; place-items: center; font-family: var(--font-display); font-weight: 700; font-size: 15px; background: #2B4467; color: #fff; text-decoration: none; transition: background var(--duration); }
.ws.active { background: var(--color-primary); color: var(--color-ink); }
.ws.active::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 4px; background: #fff; }
.sidebar { background: linear-gradient(180deg, var(--color-ink) 0%, #0F1E34 100%); color: var(--color-sidebar-text); display: flex; flex-direction: column; min-height: 0; }
.sb-head { padding: 14px 16px 12px; display: grid; gap: 10px; border-bottom: 1px solid rgb(255 255 255 / .08); }
.sb-ws { display: flex; align-items: center; gap: 6px; padding: 0; font: 700 17px var(--font-display); color: #fff; background: none; border: 0; cursor: pointer; text-align: left; }
.sb-search { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 10px; font: inherit; font-size: 14px; color: var(--color-sidebar-text); background: rgb(0 0 0 / .18); border: 0; cursor: pointer; }
.sb-search:hover { color: #fff; }
.sb-scroll { overflow: auto; padding: 8px 0 16px; display: grid; align-content: start; gap: 2px; }
h4 { margin: 12px 0 2px; padding: 0 16px; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: #8FA0B8; }
.sb-item { position: relative; display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 16px; font-size: 15px; color: var(--color-sidebar-text); text-decoration: none; transition: background var(--duration), color var(--duration); }
.sb-item:hover { background: var(--color-ink-soft); color: #fff; }
.sb-item.active { background: var(--color-ink-soft); color: #fff; font-weight: 500; }
.sb-item.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-primary); }
.main { min-width: 0; min-height: 0; overflow: auto; background: var(--color-canvas); }
.tabbar { display: none; }

@media (max-width: 767px) {
  .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  .rail { display: none; }
  .sidebar { display: none; padding-top: env(safe-area-inset-top, 0px); }
  .on-home .sidebar { display: flex; }
  .on-home .main { display: none; }
  .main { padding-top: env(safe-area-inset-top, 0px); }
  .sb-item { min-height: var(--tap); font-size: 16px; }
  .tabbar { display: grid; grid-template-columns: repeat(5, 1fr); background: var(--color-surface); border-top: 1px solid var(--color-line); padding-bottom: env(safe-area-inset-bottom, 0px); }
  .tabbar a { position: relative; display: grid; justify-items: center; align-content: center; gap: 3px; min-height: 54px; font-size: 11px; color: var(--color-muted); text-decoration: none; }
  .tabbar a.on { color: var(--color-ink); font-weight: 700; }
  .tabbar a.on::before { content: ''; position: absolute; top: -1px; left: 25%; right: 25%; height: 3px; background: var(--color-primary); }
}
</style>
