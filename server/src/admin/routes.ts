// Backoffice de plataforma (§3.6, ADR 0005 §4): solo quien está en platform_admins. adminPool (cruza agencias)
// y todo queda en audit_log. Una sesión impersonada no entra aquí, salvo para terminar la impersonación.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { Id, AdminStatusBody, ImpersonateBody, type AdminWorkspace, type AdminMetrics } from '@agencia-hub/contracts';
import { adminPool, withAdmin } from '../db.ts';
import { HttpError, parse } from '../platform/http.ts';
import { requireAuth, setSessionCookie, IMPERSONATION_MINUTES } from '../platform/auth.ts';
import { toWorkspace, buildSession, audit } from '../platform/model.ts';
import { pricesCents } from '../billing/stripe.ts';

export const adminRouter = Router();

const adminRow = async (userId: string) => (await adminPool.query(
  'select u.totp_enabled from platform_admins a join users u on u.id = a.user_id where a.user_id = $1', [userId])).rows[0];

adminRouter.use(requireAuth, async (req: Request, _res: Response, next: NextFunction) => {
  if (req.path === '/impersonation/end') return next();
  if (req.imp) throw new HttpError(403, 'impersonation_forbidden', 'No disponible mientras ves la cuenta como otra persona');
  const admin = await adminRow(req.userId!);
  if (!admin) throw new HttpError(403, 'forbidden', 'No tienes acceso al backoffice');
  // El backoffice entra a todas las agencias: en producción exige 2FA (revisión de seguridad M4)
  if (process.env.NODE_ENV === 'production' && !admin.totp_enabled) {
    throw new HttpError(403, 'admin_2fa_required', 'Activa la verificación en dos pasos para usar el backoffice');
  }
  next();
});

const log = (req: Request, action: string, e: { workspaceId?: string | null; targetId?: string; meta?: object } = {}) =>
  withAdmin((db) => audit(db, { workspaceId: e.workspaceId ?? null, actor: req.userId!, action, targetType: e.targetId ? 'workspace' : undefined,
    targetId: e.targetId, meta: e.meta, ip: req.ip }));

// Puestos (activos no invitados) y MRR: solo cuenta lo que está `active`
const SEATS = `(select count(*)::int from workspace_members m where m.workspace_id = w.id and m.is_active and m.role <> 'guest')`;
const MRR = `case when w.status <> 'active' then 0 when w.plan = 'pro' then ${SEATS} * $1::int else ${SEATS} * $2::int end`;

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['trialing', 'active', 'past_due', 'read_only', 'suspended', 'closing']).optional(),
});

adminRouter.get('/workspaces', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const p = pricesCents();
  const { rows } = await adminPool.query(
    `select w.*, ${MRR} as mrr_cents,
       (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.is_active) as members,
       (select u.email from workspace_members m join users u on u.id = m.user_id
        where m.workspace_id = w.id and m.role = 'owner' and m.is_active order by m.joined_at limit 1) as owner_email
     from workspaces w
     where ($3::text is null or w.name ilike '%' || $3 || '%' or w.slug ilike '%' || $3 || '%')
       and ($4::text is null or w.status = $4)
     order by w.created_at desc`,
    [p.pro, p.standard, q.q || null, q.status ?? null]);
  await log(req, 'admin.workspaces_viewed', { meta: q });
  res.json(rows.map((r): AdminWorkspace => ({
    ...toWorkspace(r), members: r.members, storageBytes: Number(r.storage_bytes), mrrCents: r.mrr_cents,
    createdAt: r.created_at.toISOString(), ownerEmail: r.owner_email,
  })));
});

adminRouter.get('/metrics', async (req, res) => {
  const p = pricesCents();
  const { rows } = await adminPool.query(
    `select coalesce(sum(${MRR}), 0)::int as mrr,
       count(*) filter (where w.status = 'active')::int as active,
       count(*) filter (where w.status = 'trialing')::int as trials,
       count(*) filter (where w.created_at > now() - interval '30 days')::int as signups
     from workspaces w`, [p.pro, p.standard]);
  // Bajas: agencias que pagaban y pasaron a solo lectura en los últimos 30 días
  const churn = await adminPool.query(
    `select count(distinct workspace_id)::int as n from audit_log
     where action = 'billing.status_changed' and created_at > now() - interval '30 days'
       and meta->>'to' = 'read_only' and meta->>'from' in ('active', 'past_due')`);
  await log(req, 'admin.metrics_viewed');
  const m: AdminMetrics = {
    mrrCents: rows[0].mrr, activeWorkspaces: rows[0].active, trials: rows[0].trials,
    signups30d: rows[0].signups, churn30d: churn.rows[0].n,
  };
  res.json(m);
});

adminRouter.post('/workspaces/:id/status', async (req, res) => {
  const id = Id.parse(req.params.id);
  const { status } = parse(AdminStatusBody, req.body);
  await withAdmin(async (db) => {
    const w = (await db.query('select status from workspaces where id = $1 for update', [id])).rows[0];
    if (!w) throw new HttpError(404, 'workspace_not_found', 'Espacio de trabajo no encontrado');
    await db.query(
      `update workspaces set status = $2,
         grace_ends_at = case when $2 = 'active' then null else grace_ends_at end,
         read_only_since = case when $2 = 'active' then null else read_only_since end
       where id = $1`, [id, status]);
    await audit(db, { workspaceId: id, actor: req.userId!, action: 'admin.workspace_status', targetType: 'workspace', targetId: id,
      meta: { from: w.status, to: status }, ip: req.ip });
  });
  res.status(204).end();
});

// ─── Impersonación: entra como el Owner del workspace por 30 minutos, con motivo ───

adminRouter.post('/workspaces/:id/impersonate', async (req, res) => {
  const id = Id.parse(req.params.id);
  const { reason } = parse(ImpersonateBody, req.body);
  const { rows } = await adminPool.query(
    `select w.slug, w.settings, m.user_id as owner_id, u.token_version,
       (select totp_enabled from users where id = $2) as admin_totp
     from workspaces w
     left join workspace_members m on m.workspace_id = w.id and m.role = 'owner' and m.is_active
     left join users u on u.id = m.user_id
     where w.id = $1 order by m.joined_at limit 1`, [id, req.userId]);
  const w = rows[0];
  if (!w) throw new HttpError(404, 'workspace_not_found', 'Espacio de trabajo no encontrado');
  if (!w.owner_id) throw new HttpError(409, 'no_owner', 'El workspace no tiene un Owner activo');
  if (w.settings.require_2fa && !w.admin_totp) {
    throw new HttpError(403, 'admin_2fa_required', 'Esta agencia exige 2FA: activa tu verificación en dos pasos para entrar');
  }
  const imp = { by: req.userId!, ws: id, exp: Math.floor(Date.now() / 1000) + IMPERSONATION_MINUTES * 60 };
  await log(req, 'admin.impersonate', { workspaceId: id, targetId: id, meta: { reason, ownerId: w.owner_id, expiresAt: new Date(imp.exp * 1000) } });
  setSessionCookie(res, w.owner_id, w.token_version, imp);
  res.json({ ...(await buildSession(adminPool, w.owner_id, imp)), workspaceSlug: w.slug });
});

adminRouter.post('/impersonation/end', async (req, res) => {
  if (!req.imp) throw new HttpError(409, 'not_impersonating', 'No hay una impersonación abierta');
  const by = (await adminPool.query(
    'select u.token_version from users u join platform_admins a on a.user_id = u.id where u.id = $1', [req.imp.by])).rows[0];
  if (!by) throw new HttpError(403, 'forbidden', 'No tienes acceso al backoffice');
  await withAdmin((db) => audit(db, { workspaceId: req.imp!.ws, actor: req.imp!.by, action: 'admin.impersonate_end',
    targetType: 'workspace', targetId: req.imp!.ws, meta: { ownerId: req.userId }, ip: req.ip }));
  setSessionCookie(res, req.imp.by, by.token_version);
  res.json(await buildSession(adminPool, req.imp.by));
});
