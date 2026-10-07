// Tareas del workspace (§5.4). Se cargan todas las abiertas + las cerradas recientes y se filtran en el cliente;
// los cambios llegan por el mismo WebSocket del chat (task.created / updated / deleted).
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { Task, Routes } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { useChat } from '@/chat/store.ts';

export type TaskDraft = Partial<Routes['POST /w/:slug/tasks']['body']> & { sourcePreview?: string };
type Patch = Routes['PATCH /w/:slug/tasks/:id']['body'];

export const useTasks = defineStore('tasks', () => {
  const s = useSession();
  const chat = useChat();
  const slug = () => s.workspace!.slug;
  const me = () => s.user!.id;

  const all = ref<Task[]>([]);
  const loaded = ref(false);
  let loadedFor = '';
  let off: (() => void) | null = null;

  async function load() {
    const forSlug = slug();
    const list = await api('GET /w/:slug/tasks', { params: { slug: forSlug } });
    if (forSlug !== slug()) return;
    all.value = list;
    loaded.value = true;
  }

  function upsert(t: Task) {
    const i = all.value.findIndex((x) => x.id === t.id);
    // Respuestas y eventos pueden llegar desordenados: no pisar una versión más nueva
    if (i >= 0 && t.updatedAt < all.value[i]!.updatedAt) return;
    if (i >= 0) all.value[i] = t;
    else all.value.push(t);
  }

  /** Idempotente: cada pantalla que usa tareas lo llama. Recarga al cambiar de workspace. */
  function init() {
    if (loadedFor === slug()) return;
    loadedFor = slug();
    loaded.value = false;
    all.value = [];
    off?.();
    off = chat.listen((e) => {
      if (e.type === 'task.created' || e.type === 'task.updated') upsert(e.task);
      else if (e.type === 'task.deleted') all.value = all.value.filter((t) => t.id !== e.taskId);
    });
    load();
  }
  // Tras una reconexión pudo perderse algún evento
  watch(() => chat.connected, (c) => { if (c && loaded.value) load(); });

  // ─── Permisos (los mismos que aplica el servidor) ───
  const isAdmin = () => s.isAdmin;
  const canCreateIn = (deptId: string) => isAdmin() || !!s.workspace?.me.departmentIds.includes(deptId);
  const creatableDepts = computed(() => (s.workspace?.departments ?? []).filter((d) => !d.archivedAt && canCreateIn(d.id)));
  const canManage = (t: Task) => isAdmin() || t.createdBy === me() || !!s.workspace?.me.leadOfDepartmentIds.includes(t.departmentId);
  const canWork = (t: Task) => canManage(t) || t.assigneeIds.includes(me());

  // ─── Acciones ───
  async function create(body: Routes['POST /w/:slug/tasks']['body']) {
    const t = await api('POST /w/:slug/tasks', { params: { slug: slug() }, body });
    upsert(t);
    return t;
  }

  /** Cambio optimista: se ve al instante; si el servidor lo rechaza, se vuelve a cargar. */
  async function update(id: string, body: Patch) {
    const cur = all.value.find((t) => t.id === id);
    if (cur) upsert({ ...cur, ...(body as Partial<Task>) });
    try {
      upsert(await api('PATCH /w/:slug/tasks/:id', { params: { slug: slug(), id }, body }));
    } catch (e) {
      await load();
      throw e;
    }
  }

  async function remove(id: string) {
    await api('DELETE /w/:slug/tasks/:id', { params: { slug: slug(), id } });
    all.value = all.value.filter((t) => t.id !== id);
  }

  // Formulario global de "Nueva tarea" (también desde un mensaje del chat)
  const draft = ref<TaskDraft | null>(null);
  const compose = (d: TaskDraft = {}) => { draft.value = d; };

  return { all, loaded, init, load, upsert, create, update, remove, canCreateIn, creatableDepts, canManage, canWork, draft, compose };
});

export const isOverdue = (t: Task) => !!t.dueAt && (t.status === 'todo' || t.status === 'doing') && new Date(t.dueAt) < new Date();

/** Fecha límite a partir de un `<input type="date">`: al final de la jornada (17:00 hora local). */
export const dueFromDate = (d: string) => (d ? new Date(`${d}T17:00`).toISOString() : null);
export const dateFromDue = (iso: string | null) => {
  if (!iso) return '';
  const x = new Date(iso);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
