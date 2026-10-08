// WebSocket /ws: autenticación con ticket de un solo uso, presencia, "escribiendo…" y entrega de eventos.
// Un socket solo recibe eventos de SU workspace y, para eventos de canal, solo si es miembro del canal.
// ponytail: bus en memoria (una instancia en el piloto). Con varias instancias, publish() pasa por
// Postgres LISTEN/NOTIFY enviando ids y cada instancia recarga el evento (ADR 0004).
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type pg from 'pg';
import type { ServerEvent, ClientEvent } from '@agencia-hub/contracts';
import { adminPool, withWorkspace } from '../db.ts';
import { sha256 } from '../platform/auth.ts';

type Conn = {
  ws: WebSocket; userId: string; workspaceId: string; visible: boolean; alive: boolean; lastTyping: Map<string, number>;
  until: number | null;   // ms: fin de la sesión impersonada que pidió el ticket
};
const conns = new Set<Conn>();

// Tickets emitidos por una sesión impersonada → hasta cuándo vale el socket (mismo proceso: bus en memoria, ADR 0004)
const ticketLimits = new Map<string, number>();
export function limitTicket(tokenHash: string, untilMs: number) {
  ticketLimits.set(tokenHash, untilMs);
  setTimeout(() => ticketLimits.delete(tokenHash), 60_000).unref();
}

/** Cierra los sockets de un usuario (en un workspace o en todos): logout-all, reset, baja del miembro. */
export function disconnectUser(userId: string, workspaceId?: string) {
  for (const c of conns) {
    if (c.userId === userId && (!workspaceId || c.workspaceId === workspaceId)) c.ws.close(4001, 'session_revoked');
  }
}

const send = (c: Conn, e: ServerEvent) => { if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(e)); };

/** Entrega `event` a los usuarios indicados dentro del workspace. */
export function publish(workspaceId: string, userIds: Iterable<string> | 'all', event: ServerEvent, exceptUserId?: string) {
  const set = userIds === 'all' ? null : new Set(userIds);
  for (const c of conns) {
    if (c.workspaceId !== workspaceId || c.userId === exceptUserId) continue;
    if (set && !set.has(c.userId)) continue;
    send(c, event);
  }
}

/** Miembros del canal (para dirigir eventos). Corre en la transacción de la petición. */
export async function channelMemberIds(db: pg.PoolClient, channelId: string): Promise<string[]> {
  return (await db.query('select user_id from channel_members where channel_id = $1', [channelId])).rows.map((r) => r.user_id);
}

export async function publishToChannel(db: pg.PoolClient, workspaceId: string, channelId: string, event: ServerEvent, exceptUserId?: string) {
  publish(workspaceId, await channelMemberIds(db, channelId), event, exceptUserId);
}

// ─── Presencia (la consultan miembros y el motor de push) ───

export const isOnline = (workspaceId: string, userId: string) =>
  [...conns].some((c) => c.workspaceId === workspaceId && c.userId === userId);
/** ¿Tiene la app abierta y visible en algún dispositivo? (en cualquier workspace: es la misma app) */
export const isVisibleAnywhere = (userId: string) => [...conns].some((c) => c.userId === userId && c.visible);
export const onlineUserIds = (workspaceId: string) =>
  new Set([...conns].filter((c) => c.workspaceId === workspaceId).map((c) => c.userId));

// ─── Servidor ───

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Un error aquí no puede tumbar el proceso (revisión de seguridad A1)
    socket.on('error', () => socket.destroy());
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') return socket.destroy();
      const hash = sha256(url.searchParams.get('ticket') ?? '');
      const { rows } = await adminPool.query(
        'delete from ws_tickets where token_hash = $1 and expires_at > now() returning user_id, workspace_id', [hash]);
      if (!rows[0]) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      const until = ticketLimits.get(hash) ?? null;
      ticketLimits.delete(hash);
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, rows[0].user_id, rows[0].workspace_id, until));
    } catch {
      socket.destroy();
    }
  });

  // Latido: cierra conexiones muertas (iOS suspende la PWA sin cerrar el socket)
  const beat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive || (c.until && c.until < Date.now())) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
    revalidate().catch(() => {});
  }, 30_000);
  beat.unref(); // no mantiene vivo el proceso por sí solo
  wss.on('close', () => clearInterval(beat));
  return wss;
}

/** Cierra los sockets de quien ya no es miembro activo (desactivado, agencia suspendida): red de seguridad cada 30 s */
async function revalidate() {
  if (!conns.size) return;
  const list = [...conns];
  const { rows } = await adminPool.query(
    `select m.user_id, m.workspace_id from workspace_members m join workspaces w on w.id = m.workspace_id
     where m.is_active and w.status <> 'suspended'
       and (m.user_id, m.workspace_id) in (select * from unnest($1::uuid[], $2::uuid[]))`,
    [list.map((c) => c.userId), list.map((c) => c.workspaceId)]);
  const ok = new Set(rows.map((r) => `${r.user_id}|${r.workspace_id}`));
  for (const c of list) if (!ok.has(`${c.userId}|${c.workspaceId}`)) c.ws.close(4001, 'session_revoked');
}

function onConnection(ws: WebSocket, userId: string, workspaceId: string, until: number | null) {
  const wasOnline = isOnline(workspaceId, userId);
  const c: Conn = { ws, userId, workspaceId, visible: true, alive: true, lastTyping: new Map(), until };
  conns.add(c);
  if (!wasOnline) publish(workspaceId, 'all', { type: 'presence', userId, presence: 'active' }, userId);

  ws.on('pong', () => { c.alive = true; });
  // Sin este manejador, un mensaje mayor que maxPayload emite 'error' y tumba el proceso (revisión de seguridad A1)
  ws.on('error', () => ws.terminate());
  ws.on('message', (raw) => {
    c.alive = true;
    let msg: ClientEvent;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') send(c, { type: 'pong' });
    else if (msg.type === 'visibility') c.visible = !!msg.visible;
    else if (msg.type === 'typing' && typeof msg.channelId === 'string') onTyping(c, msg.channelId, msg.parentId ?? null).catch(() => {});
  });
  ws.on('close', () => {
    conns.delete(c);
    if (!isOnline(workspaceId, userId)) publish(workspaceId, 'all', { type: 'presence', userId, presence: 'away' });
  });
}

async function onTyping(c: Conn, channelId: string, parentId: string | null) {
  const now = Date.now();
  if (now - (c.lastTyping.get(channelId) ?? 0) < 2500) return; // como mucho un aviso cada 2,5 s por canal
  c.lastTyping.set(channelId, now);
  await withWorkspace({ workspaceId: c.workspaceId, userId: c.userId }, async (db) => {
    const members = await channelMemberIds(db, channelId);  // RLS: un canal de otro workspace devuelve vacío
    if (!members.includes(c.userId)) return;
    publish(c.workspaceId, members, { type: 'typing', channelId, parentId, userId: c.userId }, c.userId);
  });
}

/** Cierra todo (pruebas) */
export function closeAll() {
  for (const c of conns) c.ws.terminate();
  conns.clear();
}
