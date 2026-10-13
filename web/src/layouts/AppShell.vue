<script setup lang="ts">
// Shell tipo Slack (§7.2). Escritorio: riel + sidebar + contenido. Móvil: pantallas apiladas + barra inferior;
// en Inicio el sidebar ocupa la pantalla; dentro de un canal la barra se oculta para dejar el compositor junto al teclado.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ChevronDown, Search, BookOpen, SquareKanban, Target, Settings, House, MessageCircle, AtSign, SquareCheck, CircleUser, LogOut, Megaphone, PanelLeftClose, PanelLeftOpen, ChevronsUpDown, BellRing, ShieldCheck, BadgeDollarSign, Landmark, ExternalLink, X, ArrowLeftRight } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';
import { canUseFinance } from '@/finance/store.ts';
import Kbd from '@/design/Kbd.vue';
import Tooltip from '@/design/Tooltip.vue';
import ContextMenu from '@/design/ContextMenu.vue';
import Avatar from '@/design/Avatar.vue';
import { toneColor } from '@/design/types.ts';
import ChannelList from '@/chat/ChannelList.vue';
import QuickSwitcher from '@/chat/QuickSwitcher.vue';
import TaskCompose from '@/tasks/TaskCompose.vue';
import PlanBand from './PlanBand.vue';
import SuspendedView from '@/platform/SuspendedView.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const s = useSession();
const chat = useChat();

// El chat se reinicia al cambiar de workspace. Una agencia suspendida no abre el chat (el servidor lo rechaza).
const suspended = computed(() => s.workspace?.status === 'suspended');
watch(() => [s.workspace?.slug, suspended.value] as const, ([slug, susp], old) => {
  if (old?.[0]) chat.disconnect();
  if (slug && !susp) chat.init();
}, { immediate: true });
// Suspendida: solo queda abierta la pestaña de Facturación para el Owner
const showSuspended = computed(() => suspended.value && !(s.isOwner && route.name === 'settings' && route.params.tab === 'billing'));
onBeforeUnmount(() => chat.disconnect());

const base = computed(() => `/w/${s.workspace!.slug}`);
const line = computed({ get: () => s.lineId ?? '', set: (v: string) => { s.lineId = v || null; } });
const lines = computed(() => s.workspace!.lines.filter((l) => !l.archivedAt));
// Segunda línea bajo el nombre de la agencia: días de prueba o plan
const wsSub = computed(() => {
  const w = s.workspace!;
  if (w.status !== 'trialing') return t(`settings.plans.${w.plan}`);
  const days = Math.max(0, Math.ceil((new Date(w.trialEndsAt).getTime() - Date.now()) / 86400_000));
  return t('nav.trialDays', { n: days }, days);
});

// Cada módulo aparece solo si la persona tiene acceso (Ajustes → Miembros → Módulos)
const agencyNav = computed(() => [
  ...(s.can('manuals') ? [{ to: `${base.value}/manuals`, icon: BookOpen, label: t('nav.manuals') }] : []),
  ...(s.can('tasks') ? [{ to: `${base.value}/tasks`, icon: SquareKanban, label: t('nav.tasks') }] : []),
  ...(s.can('goals') ? [{ to: `${base.value}/goals`, icon: Target, label: t('nav.goals') }] : []),
  ...(s.workspace!.settings.salesModule && s.can('sales') ? [{ to: `${base.value}/sales`, icon: BadgeDollarSign, label: t('nav.sales') }] : []),
  ...(canUseFinance(s) ? [{ to: `${base.value}/finance`, icon: Landmark, label: t('nav.finance') }] : []),
  ...(s.isAdmin ? [{ to: `${base.value}/settings`, icon: Settings, label: t('nav.settings') }] : []),
]);

// Acceso a Rocco CRM (otra app de Árbol Áureo): lo activa el superadmin por agencia; lo ven todos los miembros
const crmUrl = computed(() => s.workspace!.crmUrl);

const dmUnread = computed(() => chat.channels.filter((c) => (c.kind === 'dm' || c.kind === 'group_dm') && c.isMember).reduce((n, c) => n + c.unreadCount, 0));
const mentionUnread = computed(() => chat.channels.filter((c) => c.isMember && c.kind !== 'dm' && c.kind !== 'group_dm').reduce((n, c) => n + c.mentionCount, 0));
// Barra inferior del teléfono: todo el menú vive aquí. Los mensajes directos están en la lista de Inicio;
// lo que no cabe (Manuales, Ventas, Finanzas, Ajustes, cuenta) va en «Más», que muestra el avatar de quien está conectado.
const tabs = computed(() => [
  { to: base.value, icon: House, label: t('nav.home'), on: route.name === 'home', badge: dmUnread.value },
  { to: `${base.value}/mentions`, icon: AtSign, label: t('nav.mentions'), on: route.path.endsWith('/mentions'), badge: mentionUnread.value },
  ...(s.can('tasks') ? [{ to: `${base.value}/tasks`, icon: SquareCheck, label: t('nav.tasks'), on: route.path.includes('/tasks'), badge: 0 }] : []),
  ...(s.can('goals') ? [{ to: `${base.value}/goals`, icon: Target, label: t('nav.goals'), on: route.path.includes('/goals'), badge: 0 }] : []),
]);
const moreNav = computed(() => agencyNav.value.filter((n) => !/\/(tasks|goals)$/.test(n.to)));
const moreOn = computed(() => ['/manuals', '/sales', '/finance', '/settings'].some((p) => route.path.includes(p)));
const moreOpen = ref(false);
watch(() => route.fullPath, () => { moreOpen.value = false; });
const otherWorkspaces = computed(() => s.session!.workspaces.filter((w) => w.slug !== s.workspace!.slug));
async function logout() { chat.disconnect(); await s.logout(); router.replace('/login'); }
const onHome = computed(() => route.name === 'home');
// Misma clave = la pantalla no se vuelve a montar (cambiar de canal, de manual o abrir una tarea)
const viewKey = computed(() => (route.name === 'thread' || route.name === 'channel' ? 'conv' : (route.meta.view as string) ?? route.fullPath));
const inConversation = computed(() => ['channel', 'thread'].includes(route.name as string));

// Título de la pestaña con no leídos
watch(() => chat.totalUnread, (n) => { document.title = n ? `(${n}) Kora` : 'Kora'; }, { immediate: true });

const switcher = ref(false);

// ─── Sidebar contraíble (Ctrl/⌘ + Shift + D, como Slack). Se recuerda por navegador. ───
const collapsed = ref((() => { try { return localStorage.getItem('sidebar-collapsed') === '1'; } catch { return false; } })());
watch(collapsed, (v) => { try { localStorage.setItem('sidebar-collapsed', v ? '1' : '0'); } catch { /* idem */ } });
// En el teléfono no existe el modo contraído: Inicio ya es la lista completa
const desktopMq = matchMedia('(min-width: 768px)');
const isDesktop = ref(desktopMq.matches);
desktopMq.addEventListener('change', (e) => { isDesktop.value = e.matches; });
const sidebarHidden = computed(() => collapsed.value && isDesktop.value);

// ─── Teléfono, estilo Discord: Inicio = riel + canales; cada pantalla es una capa que entra desde la derecha ───
// y se descarta deslizándola hacia la derecha. La capa tiene su propio scroll.
const mobileHome = computed(() => !isDesktop.value && onHome.value);
const pageTrans = ref('none');
let swiped = false;
let lastHome = route.name === 'home';
// Se mira la pantalla (viewKey), no el nombre de la ruta: Tareas, Metas o Ventas no tienen nombre y el cambio entre
// ellas no se detectaba
watch(viewKey, () => {
  const to = route.name === 'home', from = lastHome;
  lastHome = to;
  // Teléfono: Inicio ↔ pantalla entra de lado (capa); entre pestañas, un fundido corto con leve subida
  pageTrans.value = isDesktop.value || swiped ? 'none' : to || from ? 'layer' : 'fade';
  swiped = false;
}, { flush: 'pre' });

let sx = 0, sy = 0, dx = 0;
let drag: 'idle' | 'maybe' | 'on' = 'idle';
let layer: HTMLElement | null = null;
// No se roba el gesto a lo que se desplaza en horizontal (fichas, tablas, tablero) ni a los campos de texto
function claimsX(el: Element | null, stop: Element) {
  for (; el && el !== stop; el = el.parentElement) {
    if (el.matches('input, textarea, [contenteditable="true"]')) return true;
    if (el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}
function onTouchStart(e: TouchEvent) {
  drag = 'idle';
  if (isDesktop.value || onHome.value || e.touches.length > 1) return;
  layer = (e.target as Element).closest('.layer');
  if (!layer || claimsX(e.target as Element, layer)) return;
  sx = e.touches[0]!.clientX; sy = e.touches[0]!.clientY; dx = 0;
  drag = 'maybe';
}
function onTouchMove(e: TouchEvent) {
  if (drag === 'idle' || !layer) return;
  dx = e.touches[0]!.clientX - sx;
  const dy = e.touches[0]!.clientY - sy;
  if (drag === 'maybe') {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    if (dx <= 0 || dx < Math.abs(dy) * 1.5) { drag = 'idle'; return; }
    drag = 'on';
    layer.style.transition = 'none';
  }
  layer.style.transform = `translateX(${Math.max(0, dx)}px)`;
}
function onTouchEnd() {
  if (drag !== 'on' || !layer) { drag = 'idle'; return; }
  drag = 'idle';
  const el = layer;
  el.style.transition = 'transform 200ms cubic-bezier(.2, .8, .2, 1)';
  if (dx > el.clientWidth * 0.28) {
    el.style.transform = 'translateX(100%)';
    setTimeout(() => { swiped = true; router.push(base.value); }, 190);
  } else {
    el.style.transform = '';
    el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
  }
}
const announcement = computed(() => chat.channels.find((c) => c.kind === 'announcement'));
// Con el sidebar contraído, el riel muestra los accesos principales
const railNav = computed(() => [
  { to: announcement.value ? `${base.value}/c/${announcement.value.id}` : base.value, icon: Megaphone, label: t('chat.announcements'), badge: announcement.value?.unreadCount ?? 0 },
  { to: `${base.value}/dms`, icon: MessageCircle, label: t('chat.directMessages'), badge: dmUnread.value },
  { to: `${base.value}/mentions`, icon: AtSign, label: t('nav.mentions'), badge: mentionUnread.value },
  ...agencyNav.value.map((n) => ({ ...n, badge: 0 })),
]);

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && moreOpen.value) { moreOpen.value = false; return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); switcher.value = true; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); collapsed.value = !collapsed.value; }
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
// El nombre de la agencia es donde se busca cambiar de agencia (en el teléfono no hay riel): las demás van primero
const wsMenuItems = computed(() => [
  ...otherWorkspaces.value.map((w) => ({ label: w.name, icon: ArrowLeftRight, action: () => router.push(`/w/${w.slug}`) })),
  { label: t('nav.settings'), icon: Settings, action: () => router.push(`${base.value}/settings`) },
  { label: t('nav.logout'), icon: LogOut, danger: true, action: async () => { chat.disconnect(); await s.logout(); router.replace('/login'); } },
]);
// ─── Mi cuenta: quién está conectado y acceso al perfil (pie del sidebar o riel contraído) ───
const meMenu = ref(false);
const mePos = ref({ x: 0, y: 0 });
const meLabel = computed(() => s.workspace!.me.title || t(`roles.${s.workspace!.me.role}`));
function openMe(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // El menú abre hacia arriba: el botón está al pie de la pantalla
  mePos.value = { x: r.left + (collapsed.value ? r.width + 8 : 0), y: Math.max(8, r.top - meItems.value.length * 44 - 12) };
  meMenu.value = true;
}
const meItems = computed(() => [
  { label: t('nav.profile'), icon: CircleUser, action: () => router.push(`${base.value}/settings/profile`) },
  { label: t('nav.notifications'), icon: BellRing, action: () => router.push(`${base.value}/settings/profile`) },
  // Acceso al backoffice solo para superadmins (y nunca desde una sesión impersonada)
  ...(s.platformAdmin && !s.impersonation ? [{ label: t('nav.backoffice'), icon: ShieldCheck, action: () => router.push('/admin') }] : []),
  { label: t('nav.logout'), icon: LogOut, danger: true, action: async () => { chat.disconnect(); await s.logout(); router.replace('/login'); } },
]);

const initials = (n: string) => n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
</script>

<template>
  <div class="shell" :class="{ 'on-home': onHome, 'in-conv': inConversation, collapsed: sidebarHidden }">
    <nav class="rail" :aria-label="t('nav.agency')" :inert="!isDesktop && !onHome">
      <Tooltip v-for="w in s.session!.workspaces" :key="w.id" :text="w.name" side="right">
        <RouterLink :to="`/w/${w.slug}`" class="ws" :class="{ active: w.slug === s.workspace!.slug }" :aria-label="w.name">{{ initials(w.name) }}</RouterLink>
      </Tooltip>
      <Transition name="rail-nav">
        <div v-if="sidebarHidden" class="rail-nav">
          <Tooltip :text="`${t('nav.search')} · Ctrl K`" side="right">
            <button type="button" class="rail-btn" :aria-label="t('nav.search')" @click="switcher = true"><Search :size="19" /></button>
          </Tooltip>
          <Tooltip v-for="n in railNav" :key="n.to" :text="n.label" side="right">
            <RouterLink :to="n.to" class="rail-btn" :class="{ active: route.path.startsWith(n.to) }" :aria-label="n.label">
              <component :is="n.icon" :size="19" /><span v-if="n.badge" class="rail-badge">{{ n.badge }}</span>
            </RouterLink>
          </Tooltip>
          <Tooltip v-if="crmUrl" :text="t('nav.crmHint')" side="right">
            <a :href="crmUrl" target="_blank" rel="noopener noreferrer" class="rail-btn" :aria-label="t('nav.crmHint')"><ExternalLink :size="19" /></a>
          </Tooltip>
        </div>
      </Transition>
      <Tooltip v-if="sidebarHidden" :text="s.user!.name" side="right" class="rail-me">
        <button type="button" class="me-av" :aria-label="t('nav.account')" @click="openMe"><Avatar :name="s.user!.name" :size="34" presence="active" /></button>
      </Tooltip>
      <Tooltip :text="`${collapsed ? t('nav.expand') : t('nav.collapse')} · Ctrl Shift D`" side="right" :class="{ 'rail-toggle': !sidebarHidden }">
        <button type="button" class="rail-btn" :aria-label="collapsed ? t('nav.expand') : t('nav.collapse')" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
          <PanelLeftOpen v-if="collapsed" :size="19" /><PanelLeftClose v-else :size="19" />
          <span v-if="collapsed && chat.totalUnread" class="rail-dot" />
        </button>
      </Tooltip>
    </nav>

    <aside class="sidebar" :inert="sidebarHidden || (!isDesktop && !onHome)">
      <div class="sb-head">
        <button class="sb-ws" type="button" :aria-label="`${s.workspace!.name} · ${t('nav.agencyMenu')}`" @click="openWsMenu">
          <span class="ws-txt"><b>{{ s.workspace!.name }}</b><small><span class="ws-dot" />{{ wsSub }}</small></span>
          <span class="ws-chev"><ChevronDown :size="15" /></span>
        </button>
        <!-- Filtro de línea: fichas de un clic (si la agencia usa líneas) -->
        <div v-if="lines.length" class="lines" role="radiogroup" :aria-label="t('nav.line', s.cat)">
          <button type="button" role="radio" :aria-checked="!line" :class="{ on: !line }" @click="line = ''">{{ t('nav.allLines') }}</button>
          <button v-for="l in lines" :key="l.id" type="button" role="radio" :aria-checked="line === l.id" :class="{ on: line === l.id }" @click="line = l.id">
            <span class="dot" :style="{ background: toneColor(s.lineTone(l.id), true) }" />{{ l.name }}
          </button>
        </div>
        <button class="sb-search" type="button" @click="switcher = true"><Search :size="15" />{{ t('nav.search') }}<Kbd class="ml-auto">Ctrl K</Kbd></button>
      </div>
      <div class="sb-scroll">
        <ChannelList />
        <template v-if="isDesktop">
          <h4>{{ t('nav.agency') }}</h4>
          <RouterLink v-for="n in agencyNav" :key="n.to" :to="n.to" class="sb-item" :class="{ active: route.path.startsWith(n.to) }">
            <component :is="n.icon" :size="16" />{{ n.label }}
          </RouterLink>
          <a v-if="crmUrl" :href="crmUrl" target="_blank" rel="noopener noreferrer" class="sb-item" :title="t('nav.crmHint')">
            <ExternalLink :size="16" />{{ t('nav.crm') }}
          </a>
        </template>
      </div>
      <button type="button" class="sb-me" :aria-label="t('nav.account')" @click="openMe">
        <Avatar :name="s.user!.name" :size="36" presence="active" />
        <span class="me-txt"><b>{{ s.user!.name }}</b><small>{{ meLabel }}</small></span>
        <ChevronsUpDown :size="16" class="me-chev" />
      </button>
    </aside>

    <div class="main-col" :inert="mobileHome">
      <PlanBand v-if="!mobileHome" />
      <main class="main" @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove" @touchend="onTouchEnd" @touchcancel="onTouchEnd">
        <div v-if="showSuspended" class="layer"><SuspendedView /></div>
        <RouterView v-else v-slot="{ Component }">
          <Transition :name="pageTrans" :css="pageTrans !== 'none'">
            <div v-if="!mobileHome" :key="viewKey" class="layer"><component :is="Component" /></div>
          </Transition>
        </RouterView>
      </main>
    </div>

    <nav class="tabbar" :aria-label="t('nav.home')">
      <RouterLink v-for="tb in tabs" :key="tb.label" :to="tb.to" :class="{ on: tb.on && !moreOpen }">
        <span class="tab-ico"><component :is="tb.icon" :size="22" /><span v-if="tb.badge" class="tab-badge">{{ tb.badge }}</span></span>{{ tb.label }}
      </RouterLink>
      <button type="button" :class="{ on: moreOn || moreOpen }" :aria-label="t('nav.moreMenu')" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">
        <span class="tab-ico"><Avatar :name="s.user!.name" :size="24" presence="active" /></span>{{ t('nav.more') }}
      </button>
    </nav>

    <!-- Panel «Más» (teléfono): sube desde la barra inferior -->
    <Transition name="sheet">
      <div v-if="moreOpen && !isDesktop" class="sheet-wrap" @click.self="moreOpen = false">
        <section class="sheet" role="dialog" :aria-label="t('nav.moreMenu')">
          <header class="sheet-me">
            <Avatar :name="s.user!.name" :size="44" presence="active" />
            <span class="me-txt"><b>{{ s.user!.name }}</b><small>{{ meLabel }} · {{ s.workspace!.name }}</small></span>
            <button type="button" class="sheet-x" :aria-label="t('nav.close')" @click="moreOpen = false"><X :size="20" /></button>
          </header>
          <!-- Las otras agencias, arriba: así no quedan fuera de la pantalla en teléfonos bajos -->
          <div v-if="otherWorkspaces.length" class="sheet-list">
            <h4>{{ t('nav.agencies') }}</h4>
            <RouterLink v-for="w in otherWorkspaces" :key="w.id" :to="`/w/${w.slug}`" class="row"><span class="ws-mini">{{ initials(w.name) }}</span>{{ w.name }}</RouterLink>
          </div>
          <div class="sheet-grid">
            <RouterLink v-for="n in moreNav" :key="n.to" :to="n.to" class="tile" :class="{ active: route.path.startsWith(n.to) }">
              <component :is="n.icon" :size="22" />{{ n.label }}
            </RouterLink>
            <a v-if="crmUrl" :href="crmUrl" target="_blank" rel="noopener noreferrer" class="tile"><ExternalLink :size="22" />{{ t('nav.crm') }}</a>
          </div>
          <div class="sheet-list">
            <RouterLink :to="`${base}/settings/profile`" class="row"><CircleUser :size="19" />{{ t('nav.profile') }}</RouterLink>
            <RouterLink v-if="s.platformAdmin && !s.impersonation" to="/admin" class="row"><ShieldCheck :size="19" />{{ t('nav.backoffice') }}</RouterLink>
            <button type="button" class="row danger" @click="logout"><LogOut :size="19" />{{ t('nav.logout') }}</button>
          </div>
        </section>
      </div>
    </Transition>
    <ContextMenu v-model="wsMenu" :items="wsMenuItems" :x="menuPos.x" :y="menuPos.y" />
    <ContextMenu v-model="meMenu" :items="meItems" :x="mePos.x" :y="mePos.y" />
    <QuickSwitcher v-model="switcher" />
    <TaskCompose />
  </div>
</template>

<style scoped>
.shell { height: 100%; display: grid; grid-template-columns: 64px 264px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); transition: grid-template-columns 220ms cubic-bezier(.2, .8, .2, 1); }
.shell.collapsed { grid-template-columns: 64px 0 minmax(0, 1fr); }
/* El contenido del sidebar conserva su ancho mientras se contrae (se desliza en vez de aplastarse) */
.sidebar { overflow: hidden; }
.sidebar > * { min-width: 264px; }
.collapsed .sidebar { box-shadow: none; visibility: hidden; transition: visibility 0s 220ms; }
.rail-nav { display: grid; gap: 6px; padding-top: 10px; margin-top: 2px; border-top: 1px solid rgb(255 255 255 / .1); }
.rail-btn { position: relative; width: 40px; height: 40px; display: grid; place-items: center; color: var(--color-sidebar-text); background: none; border: 0; text-decoration: none; cursor: pointer; transition: background var(--duration), color var(--duration), box-shadow var(--duration); }
.rail-btn:hover { background: var(--color-ink); color: #fff; box-shadow: 0 4px 12px rgb(0 0 0 / .3); }
.rail-btn.active { background: var(--color-ink); color: #fff; }
.rail-btn.active::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 4px; background: var(--color-primary); }
.rail-badge { position: absolute; top: 2px; right: 0; min-width: 16px; padding: 0 3px; font-size: 10px; font-weight: 700; line-height: 15px; text-align: center; color: var(--color-ink); background: var(--color-primary); box-shadow: 0 2px 5px rgb(0 0 0 / .35); }
.rail-dot { position: absolute; top: 7px; right: 7px; width: 8px; height: 8px; background: var(--color-primary); box-shadow: 0 0 0 2px var(--color-ink-soft); }
.rail-toggle, .rail-me { margin-top: auto; }
.me-av { padding: 0; background: none; border: 0; cursor: pointer; box-shadow: 0 3px 8px rgb(0 0 0 / .35); transition: transform var(--duration); }
.me-av:hover { transform: translateY(-1px); }
/* Mi cuenta: tarjeta al pie del sidebar, elevada sobre la lista */
.sb-me { display: flex; align-items: center; gap: 10px; margin: 0; padding: 12px 14px 12px 16px; font: inherit; text-align: left; color: #fff; background: rgb(0 0 0 / .22); border: 0; border-top: 1px solid rgb(255 255 255 / .08); box-shadow: 0 -8px 16px -10px rgb(0 0 0 / .6); cursor: pointer; transition: background var(--duration); }
.sb-me:hover { background: var(--color-ink-soft); }
.me-txt { flex: 1; min-width: 0; display: grid; }
.me-txt b { font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-txt small { font-size: 12px; color: var(--color-sidebar-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-chev { color: var(--color-sidebar-text); }
.rail-nav-enter-active, .rail-nav-leave-active { transition: opacity 180ms, transform 180ms; }
.rail-nav-enter-from, .rail-nav-leave-to { opacity: 0; transform: translateX(-6px); }
.rail { position: relative; z-index: 6; background: var(--color-ink-soft); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 14px 0; box-shadow: 2px 0 8px rgb(0 0 0 / .25); }
.ws { position: relative; width: 40px; height: 40px; display: grid; place-items: center; font-family: var(--font-display); font-weight: 800; font-size: 15px; background: #2B4467; color: #fff; text-decoration: none; box-shadow: 0 3px 8px rgb(0 0 0 / .3); transition: transform var(--duration), box-shadow var(--duration); }
.ws:hover { transform: translateY(-1px); box-shadow: 0 6px 14px rgb(0 0 0 / .35); }
.ws.active { background: var(--color-primary); color: var(--color-ink); }
.ws.active::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 4px; background: #fff; }
/* El sidebar proyecta sombra sobre el área de trabajo */
.sidebar { position: relative; z-index: 5; background: linear-gradient(180deg, var(--color-ink) 0%, #0F1E34 100%); color: var(--color-sidebar-text); display: flex; flex-direction: column; min-height: 0; box-shadow: 6px 0 22px rgb(19 36 61 / .28); }
.sb-head { padding: 16px 16px 14px; display: grid; gap: 12px; border-bottom: 1px solid rgb(255 255 255 / .08); box-shadow: 0 6px 12px -8px rgb(0 0 0 / .5); }
.sb-ws { display: flex; align-items: center; gap: 10px; margin: -6px -8px 0; padding: 6px 8px; font: inherit; color: #fff; text-align: left; background: none; border: 0; cursor: pointer; transition: background var(--duration); }
.sb-ws:hover { background: rgb(255 255 255 / .06); }
.ws-txt { flex: 1; min-width: 0; display: grid; gap: 2px; }
.ws-txt b { font: 700 17px/1.25 var(--font-display); letter-spacing: -.005em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-txt small { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-sidebar-text); }
.ws-dot { width: 6px; height: 6px; background: var(--color-primary); box-shadow: 0 0 0 3px rgb(246 144 8 / .18); }
.ws-chev { width: 26px; height: 26px; display: grid; place-items: center; flex: none; color: var(--color-sidebar-text); background: rgb(255 255 255 / .07); box-shadow: inset 0 0 0 1px rgb(255 255 255 / .08); transition: transform var(--duration); }
.sb-ws:hover .ws-chev { color: #fff; }
.lines { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(max-content, 1fr); padding: 3px; overflow-x: auto; scrollbar-width: none; background: rgb(0 0 0 / .25); box-shadow: inset 0 1px 3px rgb(0 0 0 / .4); }
.lines button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 28px; padding: 0 5px; font: inherit; font-size: 12.5px; white-space: nowrap; color: var(--color-sidebar-text); background: none; border: 0; cursor: pointer; transition: background var(--duration), color var(--duration), box-shadow var(--duration); }
.lines button:hover:not(.on) { color: #fff; background: rgb(255 255 255 / .07); }
.lines button.on { color: var(--color-ink); font-weight: 600; background: var(--color-primary); box-shadow: 0 3px 8px rgb(0 0 0 / .4); }
.dot { width: 6px; height: 6px; flex: none; }
.lines .on .dot { box-shadow: 0 0 0 1.5px var(--color-ink); }
.sb-search { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 10px; font: inherit; font-size: 14px; color: var(--color-sidebar-text); background: rgb(0 0 0 / .22); border: 0; box-shadow: inset 0 1px 3px rgb(0 0 0 / .35); cursor: pointer; }
.sb-search:hover { color: #fff; }
.sb-scroll { flex: 1; overflow: auto; padding: 6px 0 20px; display: grid; align-content: start; gap: 2px; }
h4 { margin: 16px 0 2px; padding: 0 16px; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: #8FA0B8; }
.sb-item { position: relative; display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 16px; font-size: 15px; color: var(--color-sidebar-text); text-decoration: none; transition: background var(--duration), color var(--duration); }
.sb-item:hover { background: var(--color-ink-soft); color: #fff; }
.sb-item.active { background: var(--color-ink-soft); color: #fff; font-weight: 500; box-shadow: 0 6px 16px rgb(0 0 0 / .28); }
.sb-item.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-primary); }
.main-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.main { flex: 1; min-width: 0; min-height: 0; overflow: auto; background: var(--color-canvas); }
.layer { height: 100%; }
.tabbar { display: none; }

/* Teléfono, estilo Discord. Inicio: lista de canales a todo el ancho; el menú completo vive en la barra inferior.
   El resto de pantallas son capas que cubren la lista, con scroll propio, y se deslizan desde/hacia la derecha. */
@media (max-width: 767px) {
  .shell { position: relative; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; background: #0B1729; }
  .rail { display: none; }
  .sidebar { grid-area: 1 / 1; padding-top: var(--safe-top, env(safe-area-inset-top, 0px)); box-shadow: none; }
  .sidebar > * { min-width: 0; }
  .sb-head { padding: 14px 16px 12px; gap: 10px; }
  .ws-txt b { font-size: 20px; }
  .sb-search { min-height: 42px; font-size: 15px; }
  .sb-search :deep(kbd), .sb-search .ml-auto { display: none; }
  .sb-scroll { overscroll-behavior: contain; padding-bottom: 12px; }
  .sb-me { display: none; }

  .main-col { grid-area: 1 / 1; z-index: 7; padding-top: var(--safe-top, env(safe-area-inset-top, 0px)); pointer-events: none; }
  .main-col > * { pointer-events: auto; }
  .main { position: relative; overflow: hidden; background: transparent; touch-action: pan-y; }
  .layer { position: absolute; inset: 0; height: auto; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; background: var(--color-canvas); box-shadow: -14px 0 30px rgb(0 0 0 / .35); will-change: transform; }
  .layer-enter-active { transition: transform 260ms cubic-bezier(.2, .8, .2, 1); }
  .layer-leave-active { transition: transform 220ms cubic-bezier(.4, 0, 1, 1); }
  .layer-enter-from, .layer-leave-to { transform: translateX(100%); }
  .fade-enter-active { transition: opacity 200ms ease-out, transform 240ms cubic-bezier(.2, .8, .2, 1); }
  .fade-leave-active { transition: opacity 120ms ease-in; }
  .fade-enter-from { opacity: 0; transform: translateY(10px); }
  .fade-leave-to { opacity: 0; }
  .fade-enter-active, .fade-leave-active { box-shadow: none; }

  .tabbar { grid-area: 2 / 1; position: relative; z-index: 10; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; padding-bottom: env(safe-area-inset-bottom, 0px); background: #0B1729; border-top: 1px solid rgb(255 255 255 / .06); box-shadow: 0 -8px 20px rgb(0 0 0 / .25); }
  .in-conv { grid-template-rows: minmax(0, 1fr); }
  .in-conv .tabbar { display: none; }
  .tabbar > * { position: relative; display: grid; justify-items: center; align-content: center; gap: 4px; min-height: 56px; padding: 0; font: inherit; font-size: 11px; color: #8FA0B8; text-decoration: none; background: none; border: 0; cursor: pointer; transition: color var(--duration); }
  .tabbar > .on { color: #fff; font-weight: 700; }
  .tabbar > .on::before { content: ''; position: absolute; top: -1px; left: 26%; right: 26%; height: 3px; background: var(--color-primary); animation: tab-line 260ms cubic-bezier(.2, .8, .2, 1); }
  .tabbar > .on .tab-ico { animation: tab-pop 320ms cubic-bezier(.3, 1.6, .5, 1); }
  @keyframes tab-line { from { transform: scaleX(0); } }
  @keyframes tab-pop { 40% { transform: translateY(-3px) scale(1.12); } }
  .tab-ico { position: relative; display: grid; place-items: center; height: 24px; }
  .tab-ico :deep(.presence) { border-color: #0B1729; }
  .tabbar > :not(.on) .tab-ico :deep(.av) { opacity: .8; }
  .tabbar > .on .tab-ico :deep(.av) { box-shadow: 0 0 0 2px var(--color-primary); }
  .tab-badge { position: absolute; top: -5px; left: 14px; min-width: 18px; padding: 0 4px; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; color: var(--color-ink); background: var(--color-primary); box-shadow: 0 2px 6px rgb(0 0 0 / .4); }

  /* Panel «Más»: sube sobre el contenido y deja la barra visible (otro toque en «Más» lo cierra) */
  .sheet-wrap { grid-area: 1 / 1; z-index: 9; display: flex; flex-direction: column; justify-content: flex-end; background: rgb(6 13 24 / .55); }
  .sheet { max-height: calc(100% - 48px - var(--safe-top, env(safe-area-inset-top, 0px))); overflow-y: auto; overscroll-behavior: contain; padding: 0 0 8px; color: var(--color-sidebar-text); background: linear-gradient(180deg, #1A2E4C 0%, var(--color-ink) 100%); border-top: 3px solid var(--color-primary); box-shadow: 0 -16px 40px rgb(0 0 0 / .45); }
  .sheet-me { display: flex; align-items: center; gap: 12px; padding: 16px 12px 16px 18px; border-bottom: 1px solid rgb(255 255 255 / .08); }
  .sheet-me .me-txt b { color: #fff; font-size: 16px; }
  .sheet-x { width: var(--tap); height: var(--tap); display: grid; place-items: center; flex: none; color: var(--color-sidebar-text); background: rgb(255 255 255 / .06); border: 0; cursor: pointer; }
  .sheet-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 16px 18px 18px 16px; }
  .tile { position: relative; display: grid; justify-items: start; align-content: space-between; gap: 10px; min-height: 76px; padding: 12px; font-size: 14px; font-weight: 600; color: #fff; text-decoration: none; background: var(--color-ink-soft); box-shadow: 0 6px 14px rgb(0 0 0 / .3); transition: background var(--duration), transform var(--duration); }
  .tile:last-child:nth-child(odd) { grid-column: span 2; }
  .tile :deep(svg) { color: var(--color-cta); }
  .tile:active { transform: translateY(1px); background: #24406A; }
  .tile.active { background: var(--color-primary); color: var(--color-ink); }
  .tile.active :deep(svg) { color: var(--color-ink); }
  .sheet-list { display: grid; padding: 4px 0; border-top: 1px solid rgb(255 255 255 / .08); }
  .sheet-list h4 { margin: 12px 0 4px; padding: 0 18px; }
  .row { display: flex; align-items: center; gap: 14px; min-height: 50px; padding: 0 18px; font: inherit; font-size: 16px; text-align: left; color: var(--color-sidebar-text); text-decoration: none; background: none; border: 0; cursor: pointer; }
  .row:active { background: rgb(255 255 255 / .06); }
  .row.danger { color: #F27A6E; }
  .ws-mini { width: 26px; height: 26px; display: grid; place-items: center; font: 800 11px var(--font-display); color: #fff; background: #2B4467; }
  .sheet-enter-active, .sheet-leave-active { transition: background 220ms; }
  .sheet-enter-active .sheet, .sheet-leave-active .sheet { transition: transform 240ms cubic-bezier(.2, .8, .2, 1); }
  .sheet-enter-from, .sheet-leave-to { background: transparent; }
  .sheet-enter-from .sheet, .sheet-leave-to .sheet { transform: translateY(100%); }
}
</style>
