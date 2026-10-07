// Suscripciones push por dispositivo (no dependen del workspace: push es por origen).
import { Router } from 'express';
import { z } from 'zod';
import { withWorkspace } from '../db.ts';
import { requireAuth, rateLimit } from '../platform/auth.ts';
import { HttpError, parse } from '../platform/http.ts';
import { sendToUser } from './push.ts';

export const pushRouter = Router();

const Subscription = z.object({
  endpoint: z.url().max(2000).refine((u) => u.startsWith('https://'), 'El endpoint debe ser https'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }),
});

pushRouter.get('/push/vapid-key', (_req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) throw new HttpError(503, 'push_disabled', 'Las notificaciones no están configuradas');
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

pushRouter.post('/me/push-subscriptions', requireAuth, async (req, res) => {
  const s = parse(Subscription, req.body);
  await withWorkspace({ workspaceId: null, userId: req.userId! }, (db) => db.query(
    // Si el mismo navegador cambia de cuenta, el endpoint pasa a la cuenta actual
    `delete from push_subscriptions where endpoint = $1 and user_id <> app_user()`, [s.endpoint]));
  await withWorkspace({ workspaceId: null, userId: req.userId! }, (db) => db.query(
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) values (app_user(), $1, $2, $3, $4)
     on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    [s.endpoint, s.keys.p256dh, s.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 300)]));
  res.status(204).end();
});

pushRouter.delete('/me/push-subscriptions', requireAuth, async (req, res) => {
  const { endpoint } = parse(z.object({ endpoint: z.string().max(2000) }), req.body);
  await withWorkspace({ workspaceId: null, userId: req.userId! }, (db) =>
    db.query('delete from push_subscriptions where endpoint = $1 and user_id = app_user()', [endpoint]));
  res.status(204).end();
});

pushRouter.post('/me/push-test', requireAuth, async (req, res) => {
  rateLimit(`push-test:${req.userId}`, 5, 60_000);
  const sent = await sendToUser(req.userId!, { title: 'Agencia Hub', body: 'Las notificaciones funcionan en este dispositivo.', url: '/', tag: 'test' });
  if (!sent) throw new HttpError(404, 'no_subscriptions', 'Este dispositivo no tiene notificaciones activas');
  res.status(204).end();
});
