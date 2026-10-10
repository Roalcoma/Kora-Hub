// Datos de referencia del módulo de ventas: compañías y productos, perfiles de agente y nombres de miembros.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AgentProfile, Carrier, Member, Product } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';

export const useSales = defineStore('sales', () => {
  const s = useSession();
  const carriers = ref<Carrier[]>([]);
  const agents = ref<AgentProfile[]>([]);
  const members = ref<Member[]>([]);
  const loadedFor = ref('');

  async function load(force = false) {
    const slug = s.workspace!.slug;
    if (!force && loadedFor.value === slug) return;
    const params = { slug };
    [carriers.value, agents.value, members.value] = await Promise.all([
      api('GET /w/:slug/carriers', { params }), api('GET /w/:slug/agents', { params }), api('GET /w/:slug/members', { params }),
    ]);
    loadedFor.value = slug;
  }

  const products = computed(() => carriers.value.flatMap((c) => c.products));
  const product = (id: string): Product | undefined => products.value.find((p) => p.id === id);
  const carrier = (id: string) => carriers.value.find((c) => c.id === id);
  const memberName = (id: string | null) => (id ? members.value.find((m) => m.userId === id)?.name ?? '—' : '—');
  /** "Americo · Instant Decision" */
  const productLabel = (id: string) => {
    const p = product(id);
    return p ? `${carrier(p.carrierId)?.name ?? ''} · ${p.name}` : '—';
  };
  const agent = (id: string) => agents.value.find((a) => a.userId === id);
  /** Nivel vigente hoy (el historial viene del más reciente al más antiguo) */
  const currentLevel = (id: string) => {
    const today = new Date().toISOString().slice(0, 10);
    return agent(id)?.levels.find((l) => l.effectiveFrom <= today) ?? null;
  };
  /** Miembros activos que pueden vender (sin invitados), por nombre */
  const sellers = computed(() => members.value.filter((m) => m.isActive && m.role !== 'guest'));

  return { carriers, agents, members, products, load, product, carrier, memberName, productLabel, agent, currentLevel, sellers };
});
