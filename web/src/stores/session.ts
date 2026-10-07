// Sesión del usuario y workspace activo.
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Session, Routes } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { setLocale } from '@/i18n/index.ts';

type WorkspaceDetail = Routes['GET /w/:slug']['res'];

export const useSession = defineStore('session', () => {
  const session = ref<Session | null>(null);
  const workspace = ref<WorkspaceDetail | null>(null);
  const loaded = ref(false);
  /** Filtro global de línea de negocio (null = todas) */
  const lineId = ref<string | null>(null);

  const user = computed(() => session.value?.user ?? null);
  const isAdmin = computed(() => ['owner', 'admin'].includes(workspace.value?.me.role ?? ''));

  function set(s: Session) {
    session.value = s;
    setLocale(s.user.locale);
  }

  async function load() {
    try {
      set(await api('GET /me'));
    } catch {
      session.value = null;
    }
    loaded.value = true;
  }

  async function openWorkspace(slug: string) {
    if (workspace.value?.slug === slug) return workspace.value;
    workspace.value = await api('GET /w/:slug', { params: { slug } });
    lineId.value = null;
    return workspace.value;
  }

  async function refreshWorkspace() {
    if (workspace.value) workspace.value = await api('GET /w/:slug', { params: { slug: workspace.value.slug } });
  }

  async function logout() {
    await api('POST /auth/logout');
    session.value = null;
    workspace.value = null;
  }

  return { session, workspace, loaded, lineId, user, isAdmin, set, load, openWorkspace, refreshWorkspace, logout };
});
