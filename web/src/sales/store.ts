// Datos de referencia del módulo de ventas: compañías y productos, agentes asociados y miembros (para enlazar un agente a su usuario).
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Agent, Carrier, Member, Product } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { today } from './format.ts';

export const useSales = defineStore('sales', () => {
  const s = useSession();
  const carriers = ref<Carrier[]>([]);
  const agents = ref<Agent[]>([]);
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
  const agentName = (id: string | null) => (id ? agents.value.find((a) => a.id === id)?.name ?? '—' : '—');
  /** "Americo · Instant Decision" */
  const productLabel = (id: string) => {
    const p = product(id);
    return p ? `${carrier(p.carrierId)?.name ?? ''} · ${p.name}` : '—';
  };
  const agent = (id: string) => agents.value.find((a) => a.id === id);
  /** Nivel vigente hoy del agente con esa compañía (el historial viene del más reciente al más antiguo; ADR 0006) */
  const currentLevel = (id: string, carrierId: string) => {
    const now = today();
    return agent(id)?.levels.find((l) => l.carrierId === carrierId && l.effectiveFrom <= now) ?? null;
  };
  /** Agentes activos (no archivados), por nombre: los que pueden vender */
  const sellers = computed(() => agents.value.filter((a) => !a.archivedAt).sort((a, b) => a.name.localeCompare(b.name)));

  return { carriers, agents, members, products, load, product, carrier, memberName, agentName, productLabel, agent, currentLevel, sellers };
});
