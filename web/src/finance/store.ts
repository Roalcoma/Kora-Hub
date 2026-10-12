// Datos de referencia de Finanzas compartidos por todas las pestañas: categorías de gasto, cuentas bancarias,
// calendarios y personas de nómina, compañías (si el módulo de ventas está activo) y nombres de miembros.
// Cada lista se carga por separado: si un endpoint falla (o aún no existe), las demás pestañas siguen funcionando.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { BankAccount, Carrier, ExpenseCategory, Member, PayrollCalendar, PayrollPerson } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';

type SessionStore = ReturnType<typeof useSession>;
/** Owner, Admin y Contable ven Finanzas (con el módulo activo); el resto ni el menú */
export const canUseFinance = (s: SessionStore) =>
  !!s.workspace?.settings.financeModule && ['owner', 'admin', 'accountant'].includes(s.workspace.me.role);

export const useFinance = defineStore('finance', () => {
  const s = useSession();
  const categories = ref<ExpenseCategory[]>([]);
  const accounts = ref<BankAccount[]>([]);
  const calendars = ref<PayrollCalendar[]>([]);
  const people = ref<PayrollPerson[]>([]);
  const carriers = ref<Carrier[]>([]);
  const members = ref<Member[]>([]);
  /** Gastos por aprobar (solo se cuentan para Owner/Admin): número de la pestaña Gastos y del aviso */
  const pendingApprovals = ref(0);
  const loadedFor = ref('');

  const params = () => ({ slug: s.workspace!.slug });
  /** Solo Owner/Admin aprueban o rechazan lo que carga un Contable (ADR 0007) */
  const canApprove = computed(() => s.isAdmin);
  const isAccountant = computed(() => s.workspace?.me.role === 'accountant');

  const loadCategories = async () => { categories.value = await api('GET /w/:slug/finance/expense-categories', { params: params() }); };
  const loadAccounts = async () => { accounts.value = await api('GET /w/:slug/finance/bank/accounts', { params: params() }); };
  const loadCalendars = async () => { calendars.value = await api('GET /w/:slug/finance/payroll/calendars', { params: params() }); };
  const loadPeople = async () => { people.value = await api('GET /w/:slug/finance/payroll/people', { params: params() }); };
  const loadCarriers = async () => {
    carriers.value = s.workspace!.settings.salesModule ? await api('GET /w/:slug/carriers', { params: params() }) : [];
  };
  const loadMembers = async () => { members.value = await api('GET /w/:slug/members', { params: params() }); };
  async function countApprovals() {
    if (!canApprove.value) { pendingApprovals.value = 0; return; }
    const list = await api('GET /w/:slug/finance/expenses', { params: params(), query: { approvalStatus: 'pending' } });
    pendingApprovals.value = list.items.length;
  }

  /** Carga todo; devuelve los errores para que la página avise sin bloquear las pestañas que sí cargaron */
  async function load(force = false) {
    const slug = s.workspace!.slug;
    if (!force && loadedFor.value === slug) return [];
    const res = await Promise.allSettled([loadCategories(), loadAccounts(), loadCalendars(), loadPeople(), loadCarriers(), loadMembers(), countApprovals()]);
    loadedFor.value = slug;
    return res.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as unknown);
  }

  const category = (id: string) => categories.value.find((c) => c.id === id);
  /** Categorías vigentes, por posición (las archivadas siguen resolviendo nombre y color en los gastos viejos) */
  const activeCategories = computed(() => categories.value.filter((c) => !c.archivedAt).sort((a, b) => a.position - b.position));
  const memberName = (id: string | null) => (id ? members.value.find((m) => m.userId === id)?.name ?? '—' : '—');
  const carrierName = (id: string | null) => (id ? carriers.value.find((c) => c.id === id)?.name ?? '—' : '—');
  const account = (id: string) => accounts.value.find((a) => a.id === id);
  const person = (id: string) => people.value.find((p) => p.id === id);
  const calendar = (id: string) => calendars.value.find((c) => c.id === id);

  return {
    categories, accounts, calendars, people, carriers, members, pendingApprovals, canApprove, isAccountant, activeCategories,
    load, loadCategories, loadAccounts, loadCalendars, loadPeople, loadCarriers, loadMembers, countApprovals,
    category, memberName, carrierName, account, person, calendar,
  };
});
