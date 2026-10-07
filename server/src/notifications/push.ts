// Envío de Web Push (VAPID) y armado de notificaciones de mensajes según las reglas de §6.
import webpush from 'web-push';
import { adminPool } from '../db.ts';
import { isVisibleAnywhere, isOnline } from '../realtime/hub.ts';
import { pushReason, inDnd, plainText, type Recipient } from './rules.ts';

let configured = false;
function configure() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subject } = process.env;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject ?? 'mailto:soporte@agencia-hub.local', pub, priv);
  return (configured = true);
}

export type PushPayload = { title: string; body: string; url: string; tag: string };

/** Envía a todos los dispositivos del usuario. Borra suscripciones vencidas (404/410). */
export async function sendToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!configure()) return 0;
  const subs = (await adminPool.query('select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1', [userId])).rows;
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      // Nunca push silencioso: iOS revoca la suscripción si no se muestra una notificación
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload),
        { TTL: 3600, urgency: 'high', topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) });
      sent++;
      await adminPool.query('update push_subscriptions set last_used_at = now() where id = $1', [s.id]);
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await adminPool.query('delete from push_subscriptions where id = $1', [s.id]);
      else console.error(JSON.stringify({ level: 'warn', msg: 'push fallido', status: err?.statusCode }));
    }
  }));
  return sent;
}

/** Job `notify.message`: decide destinatarios y envía. Idempotente por dedupe_key del job. */
export async function notifyMessage(messageId: string) {
  const m = (await adminPool.query(
    `select m.*, c.kind, c.name as channel_name, w.slug, u.name as author
     from messages m join channels c on c.id = m.channel_id join workspaces w on w.id = m.workspace_id
     join users u on u.id = m.user_id
     where m.id = $1 and m.deleted_at is null`, [messageId])).rows[0];
  if (!m) return;

  const recipients = (await adminPool.query(
    `select cm.user_id, cm.muted, cm.notif_level, wm.notif_prefs, u.timezone,
       exists (select 1 from message_mentions mm where mm.message_id = $1 and mm.user_id = cm.user_id) as mentioned,
       ($2::uuid is not null and (
         exists (select 1 from messages r where r.parent_id = $2 and r.user_id = cm.user_id and r.id <> $1)
         or exists (select 1 from messages p where p.id = $2 and p.user_id = cm.user_id))) as in_thread
     from channel_members cm
     join workspace_members wm on wm.workspace_id = cm.workspace_id and wm.user_id = cm.user_id and wm.is_active
     join users u on u.id = cm.user_id
     where cm.channel_id = $3 and cm.user_id <> $4`,
    [messageId, m.parent_id, m.channel_id, m.user_id])).rows;
  const mentions = (await adminPool.query('select kind from message_mentions where message_id = $1', [messageId])).rows.map((r) => r.kind);
  const names = new Map((await adminPool.query(
    'select u.id, u.name from users u join message_mentions mm on mm.user_id = u.id where mm.message_id = $1', [messageId])).rows.map((r) => [r.id, r.name]));

  const facts = { kind: m.kind, isReply: !!m.parent_id, alsoInChannel: m.also_in_channel, channelMention: mentions.includes('channel'), hereMention: mentions.includes('here') };
  const isDm = m.kind === 'dm' || m.kind === 'group_dm';
  const title = isDm ? m.author : m.kind === 'announcement' ? `Anuncio de ${m.author}` : `${m.author} en #${m.channel_name}`;
  const url = `/w/${m.slug}/c/${m.channel_id}${m.parent_id ? `/t/${m.parent_id}` : ''}?m=${m.id}`;
  const body = plainText(m.body, names) || 'Envió un archivo';

  for (const r of recipients) {
    const rec: Recipient = {
      userId: r.user_id, visible: isVisibleAnywhere(r.user_id), online: isOnline(m.workspace_id, r.user_id),
      muted: r.muted, level: r.notif_level ?? r.notif_prefs.channel_default ?? 'mentions',
      inDnd: inDnd(r.notif_prefs.dnd, r.timezone), mentioned: r.mentioned, threadParticipant: r.in_thread,
    };
    if (pushReason(facts, rec)) await sendToUser(r.user_id, { title, body, url, tag: m.channel_id });
  }
}
