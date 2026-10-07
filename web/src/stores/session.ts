// Sesión del usuario y workspace activo.
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Session, Routes, CategoryColor } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { i18n, setLocale } from '@/i18n/index.ts';

type WorkspaceDetail = Routes['GET /w/:slug']['res'];

export const useSession = defineStore('session', () => {
  const session = ref<Session | null>(null);
  const workspace = ref<WorkspaceDetail | null>(null);
  const loaded = ref(false);
  /** Filtro global de categoría (antes "línea de negocio"; null = todas) */
  const lineId = ref<string | null>(null);

  const user = computed(() => session.value?.user ?? null);
  const isAdmin = computed(() => ['owner', 'admin'].includes(workspace.value?.me.role ?? ''));
  const isOwner = computed(() => workspace.value?.me.role === 'owner');
  const platformAdmin = computed(() => !!session.value?.platformAdmin);
  const impersonation = computed(() => session.value?.impersonation ?? null);
  const lineOf = (id: string | null) => (id ? workspace.value?.lines.find((l) => l.id === id) : undefined);
  const deptName = (id: string) => workspace.value?.departments.find((d) => d.id === id)?.name ?? '';
  /** Color de la categoría para Badge y puntos (paleta fija CATEGORY_COLORS); 'neutral' si no tiene */
  const lineTone = (id: string | null): CategoryColor | 'neutral' => lineOf(id)?.color ?? 'neutral';
  /** Categorías vigentes (sin archivar): si no hay, los selectores de categoría se ocultan */
  const activeLines = computed(() => workspace.value?.lines.filter((l) => !l.archivedAt) ?? []);

  // ─── Rubro y nombre de las categorías (cada agencia decide: "Línea", "Producto", "Sede"…) ───
  const industry = computed(() => workspace.value?.settings.industry ?? 'other');
  /** Los avisos de PHI/HIPAA solo aplican a las agencias de seguros */
  const isInsurance = computed(() => industry.value === 'insurance');
  const categoryLabel = computed(() => {
    const own = workspace.value?.settings.categoryLabel;
    // Leer el locale hace que el texto por defecto cambie con el idioma
    void i18n.global.locale.value;
    return own ?? { singular: i18n.global.t('category.singular'), plural: i18n.global.t('category.plural') };
  });
  /** Variables para interpolar en i18n: {category}, {categories} y sus versiones en minúscula para mitad de frase */
  const cat = computed(() => ({
    category: categoryLabel.value.singular, categories: categoryLabel.value.plural,
    categoryLc: categoryLabel.value.singular.toLocaleLowerCase(), categoriesLc: categoryLabel.value.plural.toLocaleLowerCase(),
  }));

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

  return {
    session, workspace, loaded, lineId, user, isAdmin, isOwner, platformAdmin, impersonation, lineOf, deptName, lineTone, activeLines,
    industry, isInsurance, categoryLabel, cat, set, load, openWorkspace, refreshWorkspace, logout,
  };
});
