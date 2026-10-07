// /w/:slug — canales, DMs, mensajes, hilos, reacciones, fijados, anuncios, menciones y búsqueda (§5.1, §5.2).
import { Router } from 'express';
import {
  Id, CreateChannelBody, UpdateChannelBody, OpenDmBody, ChannelMembersBody, MyChannelPrefsBody, MarkReadBody,
  ListMessagesQuery, PostMessageBody, EditMessageBody, ReactionBody, PinBody, SearchQuery, type SearchResult,
} from '@agencia-hub/contracts';
import { adminPool } from '../db.ts';
import { HttpError, parse } from '../platform/http.ts';
import { newToken, sha256 } from '../platform/auth.ts';
import { tx, requireRole } from '../platform/workspace.ts';
import { ROLE_RANK } from '../platform/model.ts';
import { enqueue } from '../jobs/queue.ts';
import { publish, publishToChannel, channelMemberIds } from '../realtime/hub.ts';
import { toFileRef } from '../files/routes.ts';
import { highlight } from './highlight.ts';
import {
  listChannels, getChannel, readableChannel, writableChannel, parseMentions, saveMentions, getMessage, pageMessages,
} from './model.ts';

export const chatRouter = Router({ mergeParams: true });
const isAdmin = (role: string) => ROLE_RANK[role as keyof typeof ROLE_RANK] >= ROLE_RANK.admin;

// ─── Tiempo real ───

chatRouter.post('/ws-ticket', async (req, res) => {
  const ticket = newToken();
  const { rows } = await adminPool.query(
    "insert into ws_tickets (token_hash, user_id, workspace_id, expires_at) values ($1, $2, $3, now() + interval '30 seconds') returning expires_at",
    [sha256(ticket), req.userId, req.ws!.id]);
  res.json({ ticket, expiresAt: rows[0].expires_at.toISOString() });
});

// ─── Canales ───

chatRouter.get('/channels', async (req, res) => {
  res.json(await tx(req, listChannels));
});

chatRouter.post('/channels', async (req, res) => {
  if (req.ws!.role === 'guest') throw new HttpError(403, 'forbidden', 'Los invitados no crean canales');
  const body = parse(CreateChannelBody, req.body);
  const channel = await tx(req, async (db) => {
    const exists = await db.query('select 1 from channels where workspace_id = app_ws() and lower(name) = $1', [body.name]);
    if (exists.rowCount) throw new HttpError(409, 'channel_name_taken', 'Ya existe un canal con ese nombre');
    const { rows } = await db.query(
      `insert into channels (workspace_id, kind, name, topic, description, department_id, line_id, created_by)
       values (app_ws(), $1, $2, $3, $4, $5, $6, app_user()) returning id`,
      [body.kind, body.name, body.topic ?? null, body.description ?? null, body.departmentId ?? null, body.lineId ?? null]);
    const id = rows[0].id;
    // FK compuesta: solo entran miembros del workspace
    await db.query(
      `insert into channel_members (workspace_id, channel_id, user_id)
       select app_ws(), $1, user_id from workspace_members where workspace_id = app_ws() and is_active and user_id = any($2)
       on conflict do nothing`, [id, [req.userId, ...body.memberIds]]);
    const channel = await getChannel(db, id);
    // Los demás miembros reciben el canal nuevo (con mis contadores en cero, que también son los suyos)
    await publishToChannel(db, req.ws!.id, id, { type: 'channel.updated', channel }, req.userId);
    return channel;
  });
  res.status(201).json(channel);
});

chatRouter.patch('/channels/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(UpdateChannelBody, req.body);
  res.json(await tx(req, async (db) => {
    const c = await readableChannel(db, id);
    if (['dm', 'group_dm'].includes(c.kind)) throw new HttpError(400, 'invalid_channel', 'Los mensajes directos no se editan');
    const canEdit = isAdmin(req.ws!.role) || (c.kind !== 'announcement' && c.createdBy === req.userId);
    if (!canEdit) throw new HttpError(403, 'forbidden', 'Solo quien creó el canal o un Admin puede cambiarlo');
    if (body.archived && c.kind === 'announcement') throw new HttpError(400, 'cannot_archive', 'No se puede archivar #anuncios');
    const set: string[] = [];
    const vals: unknown[] = [id];
    const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
    if (body.name !== undefined) add('name', body.name.toLowerCase());
    if (body.topic !== undefined) add('topic', body.topic);
    if (body.description !== undefined) add('description', body.description);
    if (body.departmentId !== undefined) add('department_id', body.departmentId);
    if (body.lineId !== undefined) add('line_id', body.lineId);
    if (body.archived !== undefined) add('archived_at', body.archived ? new Date() : null);
    if (set.length) await db.query(`update channels set ${set.join(', ')} where id = $1 and workspace_id = app_ws()`, vals);
    const updated = await getChannel(db, id);
    await publishToChannel(db, req.ws!.id, id, { type: 'channel.updated', channel: updated });
    return updated;
  }));
});

chatRouter.post('/channels/:id/join', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    const c = await readableChannel(db, id);
    if (c.kind !== 'public') throw new HttpError(403, 'forbidden', 'Solo puedes unirte a canales públicos');
    await db.query('insert into channel_members (workspace_id, channel_id, user_id) values (app_ws(), $1, app_user()) on conflict do nothing', [id]);
    return getChannel(db, id);
  }));
});

chatRouter.post('/channels/:id/leave', async (req, res) => {
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const c = await readableChannel(db, id);
    if (['announcement', 'dm'].includes(c.kind)) throw new HttpError(400, 'cannot_leave', 'No puedes salir de este canal');
    await db.query('delete from channel_members where channel_id = $1 and user_id = app_user()', [id]);
  });
  publish(req.ws!.id, [req.userId!], { type: 'channel.removed', channelId: id });
  res.status(204).end();
});

chatRouter.get('/channels/:id/members', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    await readableChannel(db, id);
    return channelMemberIds(db, id);
  }));
});

chatRouter.post('/channels/:id/members', async (req, res) => {
  const id = Id.parse(req.params.id);
  const { userIds } = parse(ChannelMembersBody, req.body);
  await tx(req, async (db) => {
    const c = await writableChannel(db, id, req.ws!.role);
    if (['dm', 'announcement'].includes(c.kind)) throw new HttpError(400, 'invalid_channel', 'No se pueden agregar personas a este canal');
    const { rows } = await db.query(
      `insert into channel_members (workspace_id, channel_id, user_id)
       select app_ws(), $1, user_id from workspace_members where workspace_id = app_ws() and is_active and user_id = any($2)
       on conflict do nothing returning user_id`, [id, userIds]);
    if (rows.length) publish(req.ws!.id, rows.map((r) => r.user_id), { type: 'channel.updated', channel: { ...(await getChannel(db, id)), unreadCount: 0, mentionCount: 0 } });
  });
  res.status(204).end();
});

chatRouter.delete('/channels/:id/members/:userId', async (req, res) => {
  const id = Id.parse(req.params.id);
  const userId = Id.parse(req.params.userId);
  if (userId !== req.userId && !isAdmin(req.ws!.role)) throw new HttpError(403, 'forbidden', 'Solo un Admin puede sacar a otra persona');
  await tx(req, async (db) => {
    const c = await readableChannel(db, id);
    if (['announcement', 'dm'].includes(c.kind)) throw new HttpError(400, 'invalid_channel', 'No se puede sacar a nadie de este canal');
    await db.query('delete from channel_members where channel_id = $1 and user_id = $2', [id, userId]);
  });
  publish(req.ws!.id, [userId], { type: 'channel.removed', channelId: id });
  res.status(204).end();
});

chatRouter.patch('/channels/:id/me', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(MyChannelPrefsBody, req.body);
  res.json(await tx(req, async (db) => {
    const { rowCount } = await db.query(
      `update channel_members set muted = coalesce($2, muted), starred = coalesce($3, starred),
         notif_level = case when $4 then $5 else notif_level end
       where channel_id = $1 and user_id = app_user()`,
      [id, body.muted ?? null, body.starred ?? null, body.notifLevel !== undefined, body.notifLevel ?? null]);
    if (!rowCount) throw new HttpError(404, 'channel_not_found', 'Canal no encontrado');
    return getChannel(db, id);
  }));
});

chatRouter.post('/channels/:id/read', async (req, res) => {
  const id = Id.parse(req.params.id);
  const { lastReadAt } = parse(MarkReadBody, req.body);
  const at = await tx(req, async (db) => (await db.query(
    `update channel_members set last_read_at = greatest(last_read_at, least($2::timestamptz, now()))
     where channel_id = $1 and user_id = app_user() returning last_read_at`, [id, lastReadAt])).rows[0]?.last_read_at);
  // Sincroniza no leídos entre mis dispositivos
  if (at) publish(req.ws!.id, [req.userId!], { type: 'read.updated', channelId: id, lastReadAt: at.toISOString() });
  res.status(204).end();
});

chatRouter.post('/dms', async (req, res) => {
  const { userIds } = parse(OpenDmBody, req.body);
  const all = [...new Set([req.userId!, ...userIds])].sort();
  if (all.length < 2) throw new HttpError(400, 'invalid_dm', 'Elige al menos a otra persona');
  res.json(await tx(req, async (db) => {
    const valid = await db.query('select count(*)::int as n from workspace_members where workspace_id = app_ws() and is_active and user_id = any($1)', [all]);
    if (valid.rows[0].n !== all.length) throw new HttpError(400, 'invalid_dm', 'Alguna persona no pertenece a la agencia');
    const dmKey = all.join(':');
    await db.query(
      `insert into channels (workspace_id, kind, dm_key, created_by) values (app_ws(), $1, $2, app_user())
       on conflict (workspace_id, dm_key) where dm_key is not null do nothing`,
      [all.length === 2 ? 'dm' : 'group_dm', dmKey]);
    const id = (await db.query('select id from channels where workspace_id = app_ws() and dm_key = $1', [dmKey])).rows[0].id;
    await db.query(
      'insert into channel_members (workspace_id, channel_id, user_id) select app_ws(), $1, unnest($2::uuid[]) on conflict do nothing', [id, all]);
    return getChannel(db, id);
  }));
});

// ─── Mensajes ───

chatRouter.get('/channels/:id/messages', async (req, res) => {
  const id = Id.parse(req.params.id);
  const q = parse(ListMessagesQuery, req.query);
  res.json(await tx(req, async (db) => {
    await readableChannel(db, id);
    return pageMessages(db, req.ws!.slug, 'm.channel_id = $1 and (m.parent_id is null or m.also_in_channel)', [id], q);
  }));
});

chatRouter.get('/messages/:id/replies', async (req, res) => {
  const id = Id.parse(req.params.id);
  const q = parse(ListMessagesQuery, req.query);
  res.json(await tx(req, async (db) => {
    const root = await getMessage(db, req.ws!.slug, id);
    if (!root) throw new HttpError(404, 'message_not_found', 'Mensaje no encontrado');
    await readableChannel(db, root.channelId);
    return pageMessages(db, req.ws!.slug, 'm.parent_id = $1', [id], q);
  }));
});

chatRouter.get('/channels/:id/pins', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    await readableChannel(db, id);
    const { rows } = await db.query(
      `select message_id from message_pins where channel_id = $1 and (expires_at is null or expires_at > now()) order by created_at desc`, [id]);
    return (await Promise.all(rows.map((r) => getMessage(db, req.ws!.slug, r.message_id)))).filter((m) => m && !m.deletedAt);
  }));
});

chatRouter.post('/channels/:id/messages', async (req, res) => {
  const channelId = Id.parse(req.params.id);
  const body = parse(PostMessageBody, req.body);
  const slug = req.ws!.slug;
  const { message, created } = await tx(req, async (db) => {
    const c = await writableChannel(db, channelId, req.ws!.role);
    // Reintento del mismo envío: devolvemos el mensaje ya creado
    const dup = await db.query('select id from messages where workspace_id = app_ws() and client_id = $1', [body.clientId]);
    if (dup.rows[0]) return { message: (await getMessage(db, slug, dup.rows[0].id))!, created: false };

    if (body.parentId) {
      const parent = (await db.query('select channel_id, parent_id from messages where workspace_id = app_ws() and id = $1 and deleted_at is null', [body.parentId])).rows[0];
      if (!parent || parent.channel_id !== channelId || parent.parent_id) throw new HttpError(400, 'invalid_parent', 'Hilo no válido');
    }
    const isAnnouncement = c.kind === 'announcement';
    if ((body.ackRequired || body.pinUntil) && !isAnnouncement) throw new HttpError(400, 'invalid_option', 'Solo los anuncios piden confirmación o se fijan con fecha');
    if (body.fileIds.length) {
      const ok = await db.query(
        `select count(*)::int as n from files where workspace_id = app_ws() and id = any($1) and uploader_id = app_user()
           and status = 'ready' and context = 'message'
           and not exists (select 1 from message_files mf where mf.file_id = files.id)`, [body.fileIds]);
      if (ok.rows[0].n !== body.fileIds.length) throw new HttpError(400, 'invalid_files', 'Algún archivo no es válido');
    }

    const { rows } = await db.query(
      `insert into messages (workspace_id, channel_id, user_id, parent_id, body, also_in_channel, ack_required, client_id)
       values (app_ws(), $1, app_user(), $2, $3, $4, $5, $6) returning id, created_at`,
      [channelId, body.parentId ?? null, body.body, !!body.parentId && body.alsoInChannel, body.ackRequired, body.clientId]);
    const { id, created_at } = rows[0];
    await saveMentions(db, id, await parseMentions(db, body.body));
    for (const [i, fileId] of body.fileIds.entries()) {
      await db.query('insert into message_files (workspace_id, message_id, file_id, position) values (app_ws(), $1, $2, $3)', [id, fileId, i]);
    }
    if (body.parentId) {
      await db.query('update messages set reply_count = reply_count + 1, last_reply_at = $2 where id = $1', [body.parentId, created_at]);
    }
    if (!body.parentId || body.alsoInChannel) await db.query('update channels set last_message_at = $2 where id = $1', [channelId, created_at]);
    if (body.pinUntil) {
      await db.query('insert into message_pins (workspace_id, channel_id, message_id, pinned_by, expires_at) values (app_ws(), $1, $2, app_user(), $3)',
        [channelId, id, body.pinUntil]);
    }
    // Lo que yo escribo no queda como no leído para mí
    await db.query('update channel_members set last_read_at = greatest(last_read_at, $2) where channel_id = $1 and user_id = app_user()', [channelId, created_at]);

    const message = (await getMessage(db, slug, id))!;
    await publishToChannel(db, req.ws!.id, channelId, { type: 'message.created', message, clientId: body.clientId });
    if (body.parentId) {
      const parent = (await getMessage(db, slug, body.parentId))!;
      await publishToChannel(db, req.ws!.id, channelId, { type: 'message.updated', message: parent });
    }
    return { message, created: true };
  });
  if (created) await enqueue('notify.message', { messageId: message.id }, { workspaceId: req.ws!.id, dedupeKey: `notify:${message.id}` });
  res.status(created ? 201 : 200).json(message);
});

/** Mensaje vivo de un canal que puedo leer. */
async function loadMessage(req: Parameters<typeof tx>[0], db: Parameters<Parameters<typeof tx>[1]>[0], id: string) {
  const m = await getMessage(db, req.ws!.slug, id);
  if (!m || m.deletedAt) throw new HttpError(404, 'message_not_found', 'Mensaje no encontrado');
  const channel = await readableChannel(db, m.channelId);
  return { m, channel };
}

chatRouter.patch('/messages/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const { body } = parse(EditMessageBody, req.body);
  res.json(await tx(req, async (db) => {
    const { m } = await loadMessage(req, db, id);
    if (m.userId !== req.userId) throw new HttpError(403, 'forbidden', 'Solo puedes editar tus mensajes');
    await db.query('update messages set body = $2, edited_at = now() where id = $1', [id, body]);
    await saveMentions(db, id, await parseMentions(db, body));
    const updated = (await getMessage(db, req.ws!.slug, id))!;
    await publishToChannel(db, req.ws!.id, m.channelId, { type: 'message.updated', message: updated });
    return updated;
  }));
});

chatRouter.delete('/messages/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const { m } = await loadMessage(req, db, id);
    if (m.userId !== req.userId && !isAdmin(req.ws!.role)) throw new HttpError(403, 'forbidden', 'Solo puedes borrar tus mensajes');
    await db.query("update messages set deleted_at = now(), body = '' where id = $1", [id]);
    await db.query('delete from message_mentions where message_id = $1', [id]);
    await db.query('delete from message_pins where message_id = $1', [id]);
    if (m.parentId) await db.query('update messages set reply_count = greatest(reply_count - 1, 0) where id = $1', [m.parentId]);
    if (m.userId !== req.userId) {
      await db.query(`insert into audit_log (workspace_id, actor_user_id, action, target_type, target_id) values (app_ws(), app_user(), 'message.deleted_by_admin', 'message', $1)`, [id]);
    }
    await publishToChannel(db, req.ws!.id, m.channelId, { type: 'message.deleted', channelId: m.channelId, messageId: id, parentId: m.parentId });
    if (m.parentId) {
      const parent = await getMessage(db, req.ws!.slug, m.parentId);
      if (parent) await publishToChannel(db, req.ws!.id, m.channelId, { type: 'message.updated', message: parent });
    }
  });
  res.status(204).end();
});

chatRouter.post('/messages/:id/reactions', async (req, res) => {
  const id = Id.parse(req.params.id);
  const { emoji } = parse(ReactionBody, req.body);
  res.json(await tx(req, async (db) => {
    const { m, channel } = await loadMessage(req, db, id);
    if (!channel.isMember) throw new HttpError(403, 'not_member', 'Únete al canal para reaccionar');
    const del = await db.query('delete from message_reactions where message_id = $1 and user_id = app_user() and emoji = $2', [id, emoji]);
    if (!del.rowCount) {
      await db.query('insert into message_reactions (workspace_id, message_id, user_id, emoji) values (app_ws(), $1, app_user(), $2)', [id, emoji]);
    }
    const { reactions } = (await getMessage(db, req.ws!.slug, id))!;
    await publishToChannel(db, req.ws!.id, m.channelId, { type: 'reaction.changed', channelId: m.channelId, messageId: id, reactions });
    return reactions;
  }));
});

async function setPin(req: Parameters<typeof tx>[0], id: string, pinned: boolean, expiresAt: string | null) {
  await tx(req, async (db) => {
    const { m, channel } = await loadMessage(req, db, id);
    await writableChannel(db, channel.id, req.ws!.role);
    if (pinned) {
      await db.query(
        `insert into message_pins (workspace_id, channel_id, message_id, pinned_by, expires_at) values (app_ws(), $1, $2, app_user(), $3)
         on conflict (message_id) do update set expires_at = excluded.expires_at`, [m.channelId, id, expiresAt]);
    } else {
      await db.query('delete from message_pins where message_id = $1', [id]);
    }
    await publishToChannel(db, req.ws!.id, m.channelId, { type: 'pin.changed', channelId: m.channelId, messageId: id, pinned });
  });
}

chatRouter.post('/messages/:id/pin', async (req, res) => {
  const { expiresAt } = parse(PinBody, req.body ?? {});
  await setPin(req, Id.parse(req.params.id), true, expiresAt);
  res.status(204).end();
});

chatRouter.delete('/messages/:id/pin', async (req, res) => {
  await setPin(req, Id.parse(req.params.id), false, null);
  res.status(204).end();
});

chatRouter.post('/messages/:id/ack', async (req, res) => {
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const { m } = await loadMessage(req, db, id);
    if (!m.ackRequired) throw new HttpError(400, 'ack_not_required', 'Este mensaje no pide confirmación');
    await db.query('insert into announcement_acks (workspace_id, message_id, user_id) values (app_ws(), $1, app_user()) on conflict do nothing', [id]);
    const n = (await db.query('select count(*)::int as n from announcement_acks where message_id = $1', [id])).rows[0].n;
    await publishToChannel(db, req.ws!.id, m.channelId, { type: 'announcement.acked', messageId: id, userId: req.userId!, ackCount: n });
  });
  res.status(204).end();
});

chatRouter.get('/messages/:id/acks', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    const { m } = await loadMessage(req, db, id);
    if (m.userId !== req.userId) requireRole(req, 'lead');
    const acked = (await db.query('select user_id, acked_at from announcement_acks where message_id = $1 order by acked_at', [id])).rows;
    const ackedIds = new Set(acked.map((a) => a.user_id));
    const members = await channelMemberIds(db, m.channelId);
    return {
      acked: acked.map((a) => ({ userId: a.user_id, ackedAt: a.acked_at.toISOString() })),
      pending: members.filter((u) => !ackedIds.has(u) && u !== m.userId),
    };
  }));
});

chatRouter.get('/mentions', async (req, res) => {
  const before = typeof req.query.before === 'string' ? Id.parse(req.query.before) : undefined;
  res.json(await tx(req, (db) => pageMessages(db, req.ws!.slug,
    `exists (select 1 from message_mentions mm where mm.message_id = m.id and mm.user_id = app_user())
     and m.user_id is distinct from app_user()
     and exists (select 1 from channel_members cm where cm.channel_id = m.channel_id and cm.user_id = app_user())`,
    [], { before, limit: 30 })));
});

// ─── Búsqueda (sin acentos: immutable_unaccent + tsvector + trigramas) ───

chatRouter.get('/search', async (req, res) => {
  const q = parse(SearchQuery, req.query);
  const slug = req.ws!.slug;
  res.json(await tx(req, async (db): Promise<SearchResult[]> => {
    const readable = `(c.kind in ('public', 'announcement') or exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = app_user()))`;
    const params = [q.q, q.channelId ?? null, q.userId ?? null, q.from ?? null, q.to ?? null, q.limit];
    const filters = `and ($2::uuid is null or m.channel_id = $2) and ($3::uuid is null or m.user_id = $3)
      and ($4::date is null or m.created_at >= $4::date) and ($5::date is null or m.created_at < $5::date + 1)`;
    const msgs = q.hasFiles ? [] : (await db.query(
      `select m.id, c.name as channel_name
       from messages m join channels c on c.id = m.channel_id
       where m.workspace_id = app_ws() and m.deleted_at is null and ${readable} ${filters}
         and (m.body_tsv @@ plainto_tsquery('simple', immutable_unaccent($1))
              or immutable_unaccent(m.body) ilike '%' || immutable_unaccent($1) || '%')
       order by ts_rank(m.body_tsv, plainto_tsquery('simple', immutable_unaccent($1))) desc, m.created_at desc
       limit $6`, params)).rows;
    const files = (await db.query(
      `select f.*, m.id as message_id, m.channel_id from files f
       join message_files mf on mf.file_id = f.id join messages m on m.id = mf.message_id join channels c on c.id = m.channel_id
       where f.workspace_id = app_ws() and m.deleted_at is null and ${readable} ${filters}
         and immutable_unaccent(f.name) ilike '%' || immutable_unaccent($1) || '%'
       order by m.created_at desc limit $6`, params)).rows;
    const out: SearchResult[] = [];
    for (const r of msgs) {
      const message = await getMessage(db, slug, r.id);
      if (message) out.push({ type: 'message', message, channelName: r.channel_name, highlight: highlight(message.body, q.q) });
    }
    for (const f of files) out.push({ type: 'file', file: toFileRef(slug, f), messageId: f.message_id, channelId: f.channel_id });
    return out;
  }));
});

