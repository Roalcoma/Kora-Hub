// Estado del chat: canales, miembros, mensajes por canal/hilo, tiempo real, UI optimista y reenvío.
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import type { Channel, Member, Message, ServerEvent, FileRef } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { toast } from '@/design/toast.ts';
import { uuid } from './format.ts';

export type UiMessage = Message & { status?: 'sending' | 'failed'; pendingFileIds?: string[] };
type List = { items: UiMessage[]; nextCursor: string | null; loaded: boolean; loading: boolean };
type SendOpts = { parentId?: string; alsoInChannel?: boolean; files?: FileRef[]; ackRequired?: boolean; pinUntil?: string };

export const useChat = defineStore('chat', () => {
  const s = useSession();
  const slug = () => s.workspace!.slug;
  const me = () => s.user!.id;

  const channels = ref<Channel[]>([]);
  const members = ref<Member[]>([]);
  const lists = reactive<Record<string, List>>({});         // 'c:<channelId>' o 't:<rootId>'
  const typing = reactive<Record<string, Record<string, number>>>({});
  const activeChannelId = ref<string | null>(null);
  const connected = ref(false);
  const ready = ref(false);

  const memberById = computed(() => new Map(members.value.map((m) => [m.userId, m])));
  const nameOf = (id: string | null) => (id && memberById.value.get(id)?.name) || 'Alguien';
  const channelById = (id: string) => channels.value.find((c) => c.id === id);

  /** Nombre visible del canal: #nombre, o los otros participantes en DMs */
  function channelTitle(c: Channel) {
    if (c.kind !== 'dm' && c.kind !== 'group_dm') return c.name ?? '';
    const others = (c.memberIds ?? []).filter((id) => id !== me());
    return others.length ? others.map(nameOf).join(', ') : nameOf(me());
  }

  // Devuelve siempre el proxy reactivo (`lists[k] ??= x` devolvería el objeto crudo y Vue no vería los cambios)
  function list(key: string): List {
    if (!lists[key]) lists[key] = { items: [], nextCursor: null, loaded: false, loading: false };
    return lists[key]!;
  }

  // ─── Carga ───

  async function init() {
    ready.value = false;
    const [c, m] = await Promise.all([
      api('GET /w/:slug/channels', { params: { slug: slug() } }),
      api('GET /w/:slug/members', { params: { slug: slug() } }),
    ]);
    channels.value = c;
    members.value = m;
    ready.value = true;
    connect();
  }

  async function loadChannel(channelId: string, around?: string) {
    const l = list(`c:${channelId}`);
    if (l.loaded && !around) return;
    l.loading = true;
    try {
      const page = await api('GET /w/:slug/channels/:id/messages', { params: { slug: slug(), id: channelId }, query: { limit: 50, around } });
      // Conserva los mensajes pendientes del usuario que aún no confirma el servidor
      l.items = [...page.items, ...l.items.filter((x) => x.status)];
      l.nextCursor = page.nextCursor;
      l.loaded = true;
    } finally {
      l.loading = false;
    }
  }

  async function loadOlder(channelId: string) {
    const l = list(`c:${channelId}`);
    if (!l.nextCursor || l.loading) return false;
    l.loading = true;
    try {
      const page = await api('GET /w/:slug/channels/:id/messages', { params: { slug: slug(), id: channelId }, query: { limit: 50, before: l.nextCursor } });
      l.items = [...page.items, ...l.items];
      l.nextCursor = page.nextCursor;
      return true;
    } finally {
      l.loading = false;
    }
  }

  async function loadThread(rootId: string) {
    const l = list(`t:${rootId}`);
    l.loading = true;
    try {
      const page = await api('GET /w/:slug/messages/:id/replies', { params: { slug: slug(), id: rootId }, query: { limit: 100 } });
      l.items = [...page.items, ...l.items.filter((x) => x.status)];
      l.nextCursor = page.nextCursor;
      l.loaded = true;
    } finally {
      l.loading = false;
    }
  }

  /** Busca un mensaje en cualquier lista cargada */
  function findMessage(id: string): UiMessage | undefined {
    for (const l of Object.values(lists)) {
      const m = l.items.find((x) => x.id === id);
      if (m) return m;
    }
  }

  // ─── Mutaciones locales (las usan las respuestas HTTP y los eventos WS por igual) ───

  function upsert(m: Message) {
    const keys = m.parentId ? [`t:${m.parentId}`, ...(m.alsoInChannel ? [`c:${m.channelId}`] : [])] : [`c:${m.channelId}`];
    for (const key of keys) {
      const l = lists[key];
      if (!l) continue;
      const i = l.items.findIndex((x) => x.id === m.id || (m.clientId && x.clientId === m.clientId));
      if (i >= 0) l.items[i] = m;
      else if (l.loaded) l.items.push(m);
    }
  }

  function updateEverywhere(id: string, fn: (m: UiMessage) => void) {
    for (const l of Object.values(lists)) for (const m of l.items) if (m.id === id) fn(m);
  }

  // ─── Envío optimista ───

  async function send(channelId: string, body: string, opts: SendOpts = {}) {
    const clientId = uuid();
    const optimistic: UiMessage = {
      id: `tmp-${clientId}`, clientId, channelId, userId: me(), parentId: opts.parentId ?? null, body,
      mentions: [], files: opts.files ?? [], reactions: [], alsoInChannel: !!opts.alsoInChannel, replyCount: 0,
      lastReplyAt: null, replyUserIds: [], ackRequired: !!opts.ackRequired, pinned: !!opts.pinUntil, meta: {},
      editedAt: null, deletedAt: null, createdAt: new Date().toISOString(), status: 'sending',
    };
    const key = opts.parentId ? `t:${opts.parentId}` : `c:${channelId}`;
    list(key).items.push(optimistic);
    if (opts.parentId && opts.alsoInChannel) list(`c:${channelId}`).items.push({ ...optimistic });
    await deliver(optimistic, opts);
  }

  async function deliver(m: UiMessage, opts: SendOpts = {}) {
    updateEverywhere(m.id, (x) => { x.status = 'sending'; });
    try {
      const saved = await api('POST /w/:slug/channels/:id/messages', {
        params: { slug: slug(), id: m.channelId },
        body: {
          clientId: m.clientId!, body: m.body, parentId: m.parentId ?? undefined, alsoInChannel: m.alsoInChannel,
          fileIds: m.files.map((f) => f.id), ackRequired: opts.ackRequired ?? m.ackRequired, pinUntil: opts.pinUntil,
        },
      });
      upsert(saved);
      const c = channelById(m.channelId);
      if (c) { c.lastReadAt = saved.createdAt; c.lastMessageAt = saved.createdAt; }
    } catch (e: any) {
      updateEverywhere(m.id, (x) => { x.status = 'failed'; });
      // Errores de permisos no se reintentan solos: se avisan
      if (e?.status && e.status < 500) toast(e.message, 'error');
    }
  }

  /** Reintenta todo lo fallido (al reconectar o al tocar "Reintentar") */
  function retryFailed() {
    for (const l of Object.values(lists)) for (const m of l.items) if (m.status === 'failed') deliver(m);
  }

  function discard(m: UiMessage) {
    for (const l of Object.values(lists)) l.items = l.items.filter((x) => x.id !== m.id);
  }

  // ─── Acciones sobre mensajes ───

  const edit = async (id: string, body: string) => upsert(await api('PATCH /w/:slug/messages/:id', { params: { slug: slug(), id }, body: { body } }));
  const remove = (id: string) => api('DELETE /w/:slug/messages/:id', { params: { slug: slug(), id } });
  async function react(id: string, emoji: string) {
    const reactions = await api('POST /w/:slug/messages/:id/reactions', { params: { slug: slug(), id }, body: { emoji } });
    updateEverywhere(id, (m) => { m.reactions = reactions; });
  }
  const pin = (id: string, pinned: boolean) => pinned
    ? api('POST /w/:slug/messages/:id/pin', { params: { slug: slug(), id }, body: { expiresAt: null } })
    : api('DELETE /w/:slug/messages/:id/pin', { params: { slug: slug(), id } });
  async function ack(id: string) {
    await api('POST /w/:slug/messages/:id/ack', { params: { slug: slug(), id } });
    updateEverywhere(id, (m) => { m.ackedByMe = true; });
  }

  // ─── Canales ───

  function upsertChannel(c: Channel) {
    const i = channels.value.findIndex((x) => x.id === c.id);
    if (i >= 0) channels.value[i] = { ...channels.value[i], ...c };
    else channels.value.push(c);
  }
  async function createChannel(body: { kind: 'public' | 'private'; name: string; topic?: string; memberIds: string[] }) {
    const c = await api('POST /w/:slug/channels', { params: { slug: slug() }, body });
    upsertChannel(c);
    return c;
  }
  async function openDm(userIds: string[]) {
    const c = await api('POST /w/:slug/dms', { params: { slug: slug() }, body: { userIds } });
    upsertChannel(c);
    return c;
  }
  async function join(id: string) { upsertChannel(await api('POST /w/:slug/channels/:id/join', { params: { slug: slug(), id } })); }
  async function leave(id: string) {
    await api('POST /w/:slug/channels/:id/leave', { params: { slug: slug(), id } });
    channels.value = channels.value.filter((c) => c.id !== id || c.kind === 'public');
    const c = channelById(id);
    if (c) c.isMember = false;
  }
  async function prefs(id: string, body: { muted?: boolean; starred?: boolean; notifLevel?: 'all' | 'mentions' | 'none' | null }) {
    upsertChannel(await api('PATCH /w/:slug/channels/:id/me', { params: { slug: slug(), id }, body }));
  }

  let readTimer: ReturnType<typeof setTimeout> | undefined;
  /** Marca como leído hasta el último mensaje (con un pequeño retraso para no saturar la API) */
  function markRead(channelId: string) {
    const c = channelById(channelId);
    const last = list(`c:${channelId}`).items.filter((m) => !m.status).at(-1);
    if (!c || !last || !c.isMember) return;
    c.unreadCount = 0;
    c.mentionCount = 0;
    if (c.lastReadAt && c.lastReadAt >= last.createdAt) return;
    c.lastReadAt = last.createdAt;
    clearTimeout(readTimer);
    readTimer = setTimeout(() => api('POST /w/:slug/channels/:id/read', { params: { slug: slug(), id: channelId }, body: { lastReadAt: last.createdAt } }).catch(() => {}), 400);
  }

  const totalUnread = computed(() => channels.value.filter((c) => c.isMember && !c.muted)
    .reduce((n, c) => n + (c.kind === 'dm' || c.kind === 'group_dm' ? c.unreadCount : c.mentionCount), 0));

  // ─── Tiempo real ───

  let socket: WebSocket | null = null;
  let retries = 0;
  let closedByUs = false;
  let everConnected = false;

  async function connect() {
    closedByUs = false;
    try {
      const { ticket } = await api('POST /w/:slug/ws-ticket', { params: { slug: slug() } });
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      return scheduleReconnect();
    }
    socket.onopen = () => {
      connected.value = true;
      retries = 0;
      sendVisibility();
      if (everConnected) resync();
      everConnected = true;
      retryFailed();
    };
    socket.onmessage = (e) => onEvent(JSON.parse(e.data));
    socket.onclose = () => {
      connected.value = false;
      if (!closedByUs) scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    const wait = Math.min(30_000, 1000 * 2 ** retries++);   // 1 s, 2 s, 4 s… hasta 30 s
    setTimeout(() => { if (!closedByUs) connect(); }, wait);
  }

  /** Tras una desconexión: refresca contadores y lo que llegó al canal abierto */
  async function resync() {
    channels.value = await api('GET /w/:slug/channels', { params: { slug: slug() } });
    for (const key of Object.keys(lists)) {
      const l = lists[key]!;
      const last = l.items.filter((m) => !m.status).at(-1);
      if (!l.loaded || !last) continue;
      if (key.startsWith('c:')) {
        const page = await api('GET /w/:slug/channels/:id/messages', { params: { slug: slug(), id: key.slice(2) }, query: { after: last.id, limit: 100 } });
        page.items.forEach(upsert);
      } else {
        await loadThread(key.slice(2));
      }
    }
  }

  const sendVisibility = () => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'visibility', visible: document.visibilityState === 'visible' }));
  document.addEventListener('visibilitychange', () => {
    sendVisibility();
    if (document.visibilityState === 'visible' && !connected.value) connect();
  });
  window.addEventListener('online', () => { if (!connected.value) connect(); else retryFailed(); });

  let lastTyping = 0;
  function sendTyping(channelId: string, parentId?: string) {
    if (Date.now() - lastTyping < 2500 || socket?.readyState !== WebSocket.OPEN) return;
    lastTyping = Date.now();
    socket.send(JSON.stringify({ type: 'typing', channelId, parentId }));
  }
  const typingIn = (key: string) => Object.entries(typing[key] ?? {}).filter(([, until]) => until > Date.now()).map(([id]) => id);
  setInterval(() => { for (const k of Object.keys(typing)) for (const [u, t] of Object.entries(typing[k]!)) if (t < Date.now()) delete typing[k]![u]; }, 1000);

  function onEvent(e: ServerEvent) {
    switch (e.type) {
      case 'message.created': {
        const m = e.message;
        upsert(m);
        // Si escribía, deja de "escribir"
        delete typing[m.parentId ? `t:${m.parentId}` : `c:${m.channelId}`]?.[m.userId ?? ''];
        const c = channelById(m.channelId);
        if (c && m.userId !== me() && (!m.parentId || m.alsoInChannel)) {
          c.lastMessageAt = m.createdAt;
          const viewing = activeChannelId.value === m.channelId && document.visibilityState === 'visible';
          if (viewing) markRead(m.channelId);
          else {
            c.unreadCount++;
            if (m.mentions.some((x) => x.kind !== 'user' || x.userId === me())) c.mentionCount++;
          }
        }
        if (!c) api('GET /w/:slug/channels', { params: { slug: slug() } }).then((r) => { channels.value = r; });
        break;
      }
      case 'message.updated': upsert(e.message); break;
      case 'message.deleted':
        for (const l of Object.values(lists)) l.items = l.items.filter((x) => x.id !== e.messageId || x.replyCount > 0);
        updateEverywhere(e.messageId, (m) => { m.deletedAt = new Date().toISOString(); m.body = ''; m.files = []; m.reactions = []; });
        break;
      case 'reaction.changed': updateEverywhere(e.messageId, (m) => { m.reactions = e.reactions; }); break;
      case 'pin.changed': updateEverywhere(e.messageId, (m) => { m.pinned = e.pinned; }); break;
      case 'announcement.acked': updateEverywhere(e.messageId, (m) => { m.ackCount = e.ackCount; if (e.userId === me()) m.ackedByMe = true; }); break;
      case 'typing': (typing[e.parentId ? `t:${e.parentId}` : `c:${e.channelId}`] ??= {})[e.userId] = Date.now() + 4000; break;
      case 'presence': { const mm = memberById.value.get(e.userId); if (mm) mm.presence = e.presence; break; }
      case 'channel.updated': upsertChannel(e.channel); break;
      case 'channel.removed': channels.value = channels.value.filter((c) => c.id !== e.channelId); break;
      case 'read.updated': { const c = channelById(e.channelId); if (c) { c.lastReadAt = e.lastReadAt; c.unreadCount = 0; c.mentionCount = 0; } break; }
    }
  }

  function disconnect() {
    closedByUs = true;
    everConnected = false;
    socket?.close();
    channels.value = [];
    for (const k of Object.keys(lists)) delete lists[k];
  }

  return {
    channels, members, lists, typing, activeChannelId, connected, ready, memberById,
    nameOf, channelById, channelTitle, list, init, loadChannel, loadOlder, loadThread, findMessage,
    send, deliver, retryFailed, discard, edit, remove, react, pin, ack,
    createChannel, openDm, join, leave, prefs, markRead, totalUnread, sendTyping, typingIn, disconnect,
  };
});
