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

type Conn = { ws: WebSocket; userId: string; workspaceId: string; visible: boolean; alive: boolean; lastTyping: Map<string, number> };
const conns = new Set<Conn>();

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
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const ticket = url.searchParams.get('ticket') ?? '';
    const { rows } = await adminPool.query(
      'delete from ws_tickets where token_hash = $1 and expires_at > now() returning user_id, workspace_id', [sha256(ticket)]);
    if (!rows[0]) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, rows[0].user_id, rows[0].workspace_id));
  });

  // Latido: cierra conexiones muertas (iOS suspende la PWA sin cerrar el socket)
  const beat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000);
  beat.unref(); // no mantiene vivo el proceso por sí solo
  wss.on('close', () => clearInterval(beat));
  return wss;
}

function onConnection(ws: WebSocket, userId: string, workspaceId: string) {
  const wasOnline = isOnline(workspaceId, userId);
  const c: Conn = { ws, userId, workspaceId, visible: true, alive: true, lastTyping: new Map() };
  conns.add(c);
  if (!wasOnline) publish(workspaceId, 'all', { type: 'presence', userId, presence: 'active' }, userId);

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (raw) => {
    c.alive = true;
    let msg: ClientEvent;
    try { msg = JSON.parse(String(raw)); } catch { return; }
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
