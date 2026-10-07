import { createRouter, createWebHistory } from 'vue-router';
import { useSession } from '@/stores/session.ts';
import { onUnauthenticated } from '@/api.ts';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // Sin pantalla propia: beforeEach manda al primer workspace o al login.
    // Debe existir; si no, el comodín de abajo redirige '/' a '/' en bucle.
    { path: '/', component: { render: () => null } },
    { path: '/login', component: () => import('@/platform/LoginPage.vue'), meta: { public: true, guestOnly: true } },
    { path: '/register', component: () => import('@/platform/RegisterPage.vue'), meta: { public: true, guestOnly: true } },
    { path: '/forgot', component: () => import('@/platform/ForgotPage.vue'), meta: { public: true } },
    { path: '/reset/:token', component: () => import('@/platform/ResetPage.vue'), meta: { public: true } },
    { path: '/invite/:token', component: () => import('@/platform/InvitePage.vue'), meta: { public: true } },
    { path: '/_design', component: () => import('@/design/DesignPage.vue'), meta: { public: true } },
    { path: '/w/:slug/onboarding', component: () => import('@/platform/OnboardingPage.vue') },
    {
      path: '/w/:slug',
      component: () => import('@/layouts/AppShell.vue'),
      children: [
        { path: '', name: 'home', component: () => import('@/platform/HomePage.vue') },
        { path: 'c/:id', name: 'channel', component: () => import('@/chat/ChannelPage.vue') },
        { path: 'c/:id/t/:threadId', name: 'thread', component: () => import('@/chat/ChannelPage.vue') },
        { path: 'search', component: () => import('@/chat/SearchPage.vue') },
        { path: 'dms', component: () => import('@/chat/InboxPage.vue') },
        { path: 'mentions', component: () => import('@/chat/InboxPage.vue') },
        { path: 'settings/:tab?', name: 'settings', component: () => import('@/platform/SettingsPage.vue') },
        { path: 'manuals', component: () => import('@/platform/ComingSoon.vue') },
        { path: 'tasks', component: () => import('@/tasks/TasksPage.vue') },
        { path: 'goals', component: () => import('@/platform/ComingSoon.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const s = useSession();
  if (!s.loaded) await s.load();
  if (!s.session) return to.meta.public ? true : { path: '/login', query: { next: to.fullPath } };
  if (to.meta.guestOnly) return '/';
  if (to.path === '/') {
    const first = s.session.workspaces[0];
    return first ? `/w/${first.slug}` : '/register';
  }
  if (to.params.slug) {
    try {
      await s.openWorkspace(to.params.slug as string);
    } catch {
      return '/';
    }
  }
  return true;
});

onUnauthenticated.handler = () => {
  const s = useSession();
  if (!s.loaded) return; // la carga inicial de sesión resuelve su propia redirección en beforeEach
  s.session = null;
  if (!router.currentRoute.value.meta.public) router.push({ path: '/login', query: { next: router.currentRoute.value.fullPath } });
};
