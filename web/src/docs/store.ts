// Biblioteca de manuales (§5.3): el árbol de páginas del workspace (sin contenido) y helpers de permisos.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { DocumentNode } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';

export const useDocs = defineStore('docs', () => {
  const s = useSession();
  const nodes = ref<DocumentNode[]>([]);
  const loaded = ref(false);
  let loadedFor = '';

  async function load() {
    const slug = s.workspace!.slug;
    const list = await api('GET /w/:slug/documents', { params: { slug } });
    if (slug !== s.workspace!.slug) return;
    nodes.value = list;
    loaded.value = true;
  }
  /** Idempotente; recarga al cambiar de workspace. */
  function init() {
    if (loadedFor === s.workspace!.slug) return;
    loadedFor = s.workspace!.slug;
    loaded.value = false;
    nodes.value = [];
    load();
  }

  function upsert(n: DocumentNode) {
    const i = nodes.value.findIndex((x) => x.id === n.id);
    const node: DocumentNode = { id: n.id, parentId: n.parentId, title: n.title, position: n.position, lineId: n.lineId, departmentId: n.departmentId, updatedAt: n.updatedAt };
    if (i >= 0) nodes.value[i] = node;
    else nodes.value.push(node);
  }
  /** Quita la página y sus subpáginas (archivar es recursivo en el servidor) */
  function removeTree(id: string) {
    const gone = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of nodes.value) if (n.parentId && gone.has(n.parentId) && !gone.has(n.id)) { gone.add(n.id); grew = true; }
    }
    nodes.value = nodes.value.filter((n) => !gone.has(n.id));
  }

  const canEditDept = (deptId: string) => s.isAdmin || !!s.workspace?.me.leadOfDepartmentIds.includes(deptId);
  const byId = (id: string) => nodes.value.find((n) => n.id === id);
  /** Ruta de ancestros (para las migas de pan) */
  function trail(id: string): DocumentNode[] {
    const out: DocumentNode[] = [];
    for (let n = byId(id); n; n = n.parentId ? byId(n.parentId) : undefined) out.unshift(n);
    return out;
  }

  return { nodes, loaded, init, load, upsert, removeTree, canEditDept, byId, trail };
});
