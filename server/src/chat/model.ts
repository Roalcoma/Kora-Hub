// Consultas compartidas del chat. Todas corren dentro de withWorkspace (RLS activo).
import type pg from 'pg';
import type { Channel, Message, Mention, Role } from '@agencia-hub/contracts';
import { HttpError } from '../platform/http.ts';
import { toFileRef } from '../files/routes.ts';

// ─── Canales ───

const CHANNEL_SELECT = `
  select c.*, cm.user_id is not null as is_member, cm.muted, cm.starred, cm.notif_level, cm.last_read_at,
    case when cm.user_id is null then 0 else (
      select count(*) from (select 1 from messages m
        where m.channel_id = c.id and (m.parent_id is null or m.also_in_channel) and m.deleted_at is null
          and m.created_at > cm.last_read_at and m.user_id is distinct from app_user() limit 100) x
    ) end::int as unread,
    case when cm.user_id is null then 0 else (
      select count(*) from (select 1 from message_mentions mm join messages m on m.id = mm.message_id
        where m.channel_id = c.id and m.deleted_at is null and m.created_at > cm.last_read_at
          and m.user_id is distinct from app_user() and (mm.user_id = app_user() or mm.kind in ('channel', 'here')) limit 100) x
    ) end::int as mentions,
    case when c.kind in ('dm', 'group_dm') then (select array_agg(x.user_id) from channel_members x where x.channel_id = c.id) end as member_ids
  from channels c
  left join channel_members cm on cm.channel_id = c.id and cm.user_id = app_user()`;

export const toChannel = (r: any): Channel => ({
  id: r.id, kind: r.kind, name: r.name, topic: r.topic, description: r.description,
  departmentId: r.department_id, lineId: r.line_id, archivedAt: r.archived_at?.toISOString() ?? null,
  memberIds: r.member_ids ?? undefined,
  isMember: r.is_member, muted: r.muted ?? false, starred: r.starred ?? false, notifLevel: r.notif_level ?? null,
  unreadCount: r.unread, mentionCount: r.mentions, lastReadAt: r.last_read_at?.toISOString() ?? null,
  lastMessageAt: r.last_message_at?.toISOString() ?? null,
});

/** Canales visibles para mí: los míos + públicos no archivados. */
export async function listChannels(db: pg.PoolClient): Promise<Channel[]> {
  const { rows } = await db.query(`${CHANNEL_SELECT}
    where c.workspace_id = app_ws() and (cm.user_id is not null or (c.kind = 'public' and c.archived_at is null))
    order by c.kind = 'announcement' desc, lower(c.name), c.last_message_at desc nulls last`);
  return rows.map(toChannel);
}

export async function getChannel(db: pg.PoolClient, id: string): Promise<Channel> {
  return toChannel((await db.query(`${CHANNEL_SELECT} where c.workspace_id = app_ws() and c.id = $1`, [id])).rows[0]);
}

type Access = { id: string; kind: Channel['kind']; archived: boolean; isMember: boolean; createdBy: string | null };

/**
 * Canal que el usuario puede LEER: públicos y #anuncios del workspace, o privados/DMs donde es miembro.
 * Un canal privado ajeno responde 404, igual que uno inexistente.
 */
export async function readableChannel(db: pg.PoolClient, channelId: string): Promise<Access> {
  const { rows } = await db.query(
    `select c.id, c.kind, c.archived_at is not null as archived, c.created_by,
       exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = app_user()) as is_member
     from channels c where c.workspace_id = app_ws() and c.id = $1`, [channelId]);
  const c = rows[0];
  if (!c || (!['public', 'announcement'].includes(c.kind) && !c.is_member)) throw new HttpError(404, 'channel_not_found', 'Canal no encontrado');
  return { id: c.id, kind: c.kind, archived: c.archived, isMember: c.is_member, createdBy: c.created_by };
}

/** Canal donde el usuario puede ESCRIBIR: miembro, no archivado; en #anuncios solo Owner/Admin/Líder. */
export async function writableChannel(db: pg.PoolClient, channelId: string, role: Role): Promise<Access> {
  const c = await readableChannel(db, channelId);
  if (!c.isMember) throw new HttpError(403, 'not_member', 'Únete al canal para escribir');
  if (c.archived) throw new HttpError(403, 'channel_archived', 'El canal está archivado');
  if (c.kind === 'announcement' && !['owner', 'admin', 'lead'].includes(role)) {
    throw new HttpError(403, 'forbidden', 'Solo Owner, Admin y Líderes publican anuncios');
  }
  return c;
}

// ─── Menciones ───

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Extrae <@userId>, <!channel> y <!here> del texto. Los ids que no son miembros del workspace se descartan. */
export async function parseMentions(db: pg.PoolClient, body: string): Promise<Mention[]> {
  const ids = [...new Set([...body.matchAll(new RegExp(`<@(${UUID})>`, 'g'))].map((m) => m[1]!))];
  const valid = ids.length
    ? (await db.query('select user_id from workspace_members where workspace_id = app_ws() and user_id = any($1) and is_active', [ids])).rows.map((r) => r.user_id)
    : [];
  return [
    ...valid.map((userId): Mention => ({ kind: 'user', userId })),
    ...(body.includes('<!channel>') ? [{ kind: 'channel' } as const] : []),
    ...(body.includes('<!here>') ? [{ kind: 'here' } as const] : []),
  ];
}

export async function saveMentions(db: pg.PoolClient, messageId: string, mentions: Mention[]) {
  await db.query('delete from message_mentions where message_id = $1', [messageId]);
  for (const m of mentions) {
    await db.query('insert into message_mentions (workspace_id, message_id, kind, user_id) values (app_ws(), $1, $2, $3)',
      [messageId, m.kind, m.kind === 'user' ? m.userId : null]);
  }
}

// ─── Mensajes ───

const MESSAGE_SELECT = `
  select m.*,
    coalesce((select json_agg(json_build_object('emoji', r.emoji, 'count', r.n, 'userIds', r.users) order by r.first)
      from (select emoji, count(*)::int as n, array_agg(user_id order by created_at) as users, min(created_at) as first
            from message_reactions where message_id = m.id group by emoji) r), '[]') as reactions,
    coalesce((select json_agg(f order by mf.position) from message_files mf join files f on f.id = mf.file_id
      where mf.message_id = m.id), '[]') as files,
    coalesce((select json_agg(json_build_object('kind', mm.kind, 'userId', mm.user_id)) from message_mentions mm
      where mm.message_id = m.id), '[]') as mention_list,
    exists (select 1 from message_pins p where p.message_id = m.id and (p.expires_at is null or p.expires_at > now())) as pinned,
    coalesce((select array_agg(u) from (select r.user_id as u, max(r.created_at) as t from messages r
      where r.parent_id = m.id and r.deleted_at is null group by r.user_id order by t desc limit 3) x), '{}') as reply_users,
    case when m.ack_required then (select count(*)::int from announcement_acks a where a.message_id = m.id) end as ack_count,
    case when m.ack_required then exists (select 1 from announcement_acks a where a.message_id = m.id and a.user_id = app_user()) end as acked
  from messages m`;

export function toMessage(slug: string, r: any): Message {
  const deleted = !!r.deleted_at;
  return {
    id: r.id, clientId: r.client_id, channelId: r.channel_id, userId: r.user_id, parentId: r.parent_id,
    body: deleted ? '' : r.body,
    mentions: deleted ? [] : r.mention_list.map((m: any) => (m.kind === 'user' ? { kind: 'user', userId: m.userId } : { kind: m.kind })),
    files: deleted ? [] : r.files.map((f: any) => toFileRef(slug, f)),
    reactions: deleted ? [] : r.reactions,
    alsoInChannel: r.also_in_channel, replyCount: r.reply_count, lastReplyAt: r.last_reply_at?.toISOString() ?? null,
    replyUserIds: r.reply_users,
    ackRequired: r.ack_required, ackCount: r.ack_count ?? undefined, ackedByMe: r.acked ?? undefined,
    pinned: r.pinned, meta: r.meta,
    editedAt: r.edited_at?.toISOString() ?? null, deletedAt: r.deleted_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function getMessage(db: pg.PoolClient, slug: string, id: string): Promise<Message | null> {
  const { rows } = await db.query(`${MESSAGE_SELECT} where m.workspace_id = app_ws() and m.id = $1`, [id]);
  return rows[0] ? toMessage(slug, rows[0]) : null;
}

/**
 * Página de mensajes por cursor (el cursor es el id de un mensaje: comparamos (created_at, id) en SQL
 * para no perder los microsegundos de Postgres). `where` filtra canal o hilo.
 * Devuelve items en orden cronológico; nextCursor = cargar más antiguos, prevCursor = cargar más nuevos.
 */
export async function pageMessages(
  db: pg.PoolClient, slug: string, where: string, params: unknown[],
  q: { before?: string; after?: string; around?: string; limit: number },
) {
  const p = params.length;
  const fetch = async (dir: 'older' | 'newer', cursor: string | undefined, inclusive: boolean, limit: number) => {
    const op = dir === 'older' ? (inclusive ? '<=' : '<') : (inclusive ? '>=' : '>');
    const cond = cursor ? `and (m.created_at, m.id) ${op} (select created_at, id from messages where id = $${p + 1})` : '';
    const order = dir === 'older' ? 'desc' : 'asc';
    const { rows } = await db.query(
      `${MESSAGE_SELECT} where m.workspace_id = app_ws() and ${where} and (m.deleted_at is null or m.reply_count > 0) ${cond}
       order by m.created_at ${order}, m.id ${order} limit ${limit + 1}`,
      cursor ? [...params, cursor] : params);
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => toMessage(slug, r));
    return { items: dir === 'older' ? items.reverse() : items, more };
  };

  if (q.around) {
    const half = Math.floor(q.limit / 2);
    const [older, newer] = await Promise.all([fetch('older', q.around, true, half), fetch('newer', q.around, false, half)]);
    const items = [...older.items, ...newer.items];
    return { items, nextCursor: older.more ? items[0]!.id : null, prevCursor: newer.more ? items.at(-1)!.id : null };
  }
  if (q.after) {
    const r = await fetch('newer', q.after, false, q.limit);
    return { items: r.items, nextCursor: r.items[0]?.id ?? q.after, prevCursor: r.more ? r.items.at(-1)!.id : null };
  }
  const r = await fetch('older', q.before, false, q.limit);
  return { items: r.items, nextCursor: r.more ? r.items[0]!.id : null, prevCursor: null };
}
