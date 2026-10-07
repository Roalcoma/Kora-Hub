// /w/:slug — configuración del workspace, miembros, invitaciones, departamentos y líneas. Todo con RLS (tx).
import { Router } from 'express';
import { z } from 'zod';
import {
  Id, UpdateWorkspaceBody, UpdateMyMembershipBody, UpdateMemberBody, CreateInvitationBody, DepartmentBody, BusinessLineBody,
  type Invitation,
} from '@agencia-hub/contracts';
import { enqueue } from '../jobs/queue.ts';
import { HttpError, parse } from './http.ts';
import { newToken, sha256 } from './auth.ts';
import { tx, requireRole } from './workspace.ts';
import { toWorkspace, toDepartment, toLine, listMembers, audit } from './model.ts';

// Montado en index.ts detrás de requireAuth + workspaceContext
export const workspaceRouter = Router({ mergeParams: true });

const appUrl = () => process.env.APP_URL ?? 'http://localhost:5180';
const archivedAt = (archived?: boolean) => (archived === undefined ? undefined : archived ? new Date() : null);

workspaceRouter.get('/', async (req, res) => {
  res.json(await tx(req, async (db) => {
    const [w, me, d, l] = await Promise.all([
      db.query('select * from workspaces where id = app_ws()'),
      listMembers(db, req.userId),
      db.query('select * from departments where workspace_id = app_ws() order by position, name'),
      db.query('select * from business_lines where workspace_id = app_ws() order by position, name'),
    ]);
    return { ...toWorkspace(w.rows[0]), me: me[0], departments: d.rows.map(toDepartment), lines: l.rows.map(toLine) };
  }));
});

workspaceRouter.patch('/', async (req, res) => {
  requireRole(req, 'admin');
  const body = parse(UpdateWorkspaceBody, req.body);
  const s = body.settings ?? {};
  const settingsPatch = Object.fromEntries(Object.entries({
    max_file_mb: s.maxFileMb, require_2fa: s.require2fa, weekly_summary: s.weeklySummary,
  }).filter(([, v]) => v !== undefined));
  res.json(await tx(req, async (db) => {
    const { rows } = await db.query(
      'update workspaces set name = coalesce($1, name), settings = settings || $2 where id = app_ws() returning *',
      [body.name ?? null, settingsPatch]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'workspace.updated', meta: body });
    return toWorkspace(rows[0]);
  }));
});

workspaceRouter.patch('/me', async (req, res) => {
  const body = parse(UpdateMyMembershipBody, req.body);
  res.json(await tx(req, async (db) => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (body.title !== undefined) set('title', body.title);
    if (body.statusText !== undefined) set('status_text', body.statusText);
    if (body.statusUntil !== undefined) set('status_until', body.statusUntil);
    if (body.notifPrefs !== undefined) set('notif_prefs', { channel_default: body.notifPrefs.channelDefault, dnd: body.notifPrefs.dnd });
    if (sets.length) {
      await db.query(`update workspace_members set ${sets.join(', ')} where workspace_id = app_ws() and user_id = app_user()`, vals);
    }
    return (await listMembers(db, req.userId))[0];
  }));
});

// ─── Miembros ───

workspaceRouter.get('/members', async (req, res) => {
  res.json(await tx(req, (db) => listMembers(db)));
});

workspaceRouter.patch('/members/:userId', async (req, res) => {
  requireRole(req, 'admin');
  const targetId = Id.parse(req.params.userId);
  const body = parse(UpdateMemberBody, req.body);
  res.json(await tx(req, async (db) => {
    const target = (await db.query(
      'select role from workspace_members where workspace_id = app_ws() and user_id = $1 for update', [targetId])).rows[0];
    if (!target) throw new HttpError(404, 'member_not_found', 'Miembro no encontrado');
    const touchesOwner = target.role === 'owner' || body.role === 'owner';
    if (touchesOwner && req.ws!.role !== 'owner') throw new HttpError(403, 'forbidden', 'Solo un Owner puede cambiar a otro Owner');
    if (target.role === 'owner' && (body.role && body.role !== 'owner' || body.isActive === false)) {
      const owners = await db.query("select count(*)::int as n from workspace_members where workspace_id = app_ws() and role = 'owner' and is_active");
      if (owners.rows[0].n <= 1) throw new HttpError(409, 'last_owner', 'El workspace necesita al menos un Owner');
    }

    if (body.role || body.title !== undefined || body.isActive !== undefined) {
      await db.query(
        `update workspace_members set role = coalesce($2, role), title = case when $3 then $4 else title end,
           is_active = coalesce($5, is_active)
         where workspace_id = app_ws() and user_id = $1`,
        [targetId, body.role ?? null, body.title !== undefined, body.title ?? null, body.isActive ?? null]);
    }
    if (body.departments) {
      await db.query('delete from member_departments where workspace_id = app_ws() and user_id = $1', [targetId]);
      for (const d of body.departments) {
        await db.query('insert into member_departments (workspace_id, user_id, department_id, is_lead) values (app_ws(), $1, $2, $3)',
          [targetId, d.id, d.isLead]);
      }
    }
    if (body.lineIds) {
      await db.query('delete from member_lines where workspace_id = app_ws() and user_id = $1', [targetId]);
      for (const lineId of body.lineIds) {
        await db.query('insert into member_lines (workspace_id, user_id, line_id) values (app_ws(), $1, $2)', [targetId, lineId]);
      }
    }
    if (body.role && body.role !== target.role) {
      await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'member.role_changed', targetType: 'user', targetId,
        meta: { from: target.role, to: body.role }, ip: req.ip });
    }
    if (body.isActive !== undefined) {
      await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: body.isActive ? 'member.reactivated' : 'member.deactivated',
        targetType: 'user', targetId, ip: req.ip });
    }
    return (await listMembers(db, targetId))[0];
  }));
});

// ─── Invitaciones ───

const toInvitation = (r: any): Invitation => ({
  id: r.id, email: r.email, role: r.role, expiresAt: r.expires_at.toISOString(), uses: r.uses, maxUses: r.max_uses,
});

workspaceRouter.get('/invitations', async (req, res) => {
  requireRole(req, 'admin');
  res.json(await tx(req, async (db) => (await db.query(
    `select * from invitations where workspace_id = app_ws() and revoked_at is null and expires_at > now() and uses < max_uses
     order by created_at desc`)).rows.map(toInvitation)));
});

workspaceRouter.post('/invitations', async (req, res) => {
  requireRole(req, 'admin');
  const body = parse(CreateInvitationBody, req.body);
  const token = newToken();
  const url = `${appUrl()}/invite/${token}`;
  const inv = await tx(req, async (db) => {
    const { rows } = await db.query(
      `insert into invitations (workspace_id, token_hash, email, role, invited_by, max_uses, expires_at, department_ids)
       values (app_ws(), $1, $2, $3, app_user(), $4, now() + make_interval(days => $5), $6) returning *`,
      [sha256(token), body.email, body.role, body.email ? 1 : body.maxUses, body.expiresInDays, body.departmentIds]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'invitation.created', targetType: 'invitation',
      targetId: rows[0].id, meta: { email: body.email, role: body.role }, ip: req.ip });
    return rows[0];
  });
  if (body.email) {
    await enqueue('email.send', { to: body.email, template: 'invitation', url, workspaceSlug: req.ws!.slug }, { workspaceId: req.ws!.id });
  }
  res.status(201).json({ ...toInvitation(inv), url });
});

workspaceRouter.delete('/invitations/:id', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const { rowCount } = await db.query('update invitations set revoked_at = now() where workspace_id = app_ws() and id = $1', [id]);
    if (!rowCount) throw new HttpError(404, 'invitation_not_found', 'Invitación no encontrada');
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'invitation.revoked', targetType: 'invitation', targetId: id, ip: req.ip });
  });
  res.status(204).end();
});

// ─── Departamentos y líneas de negocio (misma forma, distinta tabla) ───

const Archivable = z.object({ archived: z.boolean().optional() });

for (const [path, table, schema, map] of [
  ['/departments', 'departments', DepartmentBody, toDepartment],
  ['/lines', 'business_lines', BusinessLineBody, toLine],
] as const) {
  workspaceRouter.post(path, async (req, res) => {
    requireRole(req, 'admin');
    const body = parse(schema, req.body) as { name: string; position?: number; color?: string | null };
    res.status(201).json(await tx(req, async (db) => {
      const cols = table === 'business_lines' ? ', color' : '';
      const { rows } = await db.query(
        `insert into ${table} (workspace_id, name, position${cols})
         values (app_ws(), $1, coalesce($2, (select count(*) from ${table} where workspace_id = app_ws()))${cols ? ', $3' : ''})
         returning *`,
        cols ? [body.name, body.position ?? null, body.color ?? null] : [body.name, body.position ?? null]);
      return map(rows[0]);
    }));
  });

  workspaceRouter.patch(`${path}/:id`, async (req, res) => {
    requireRole(req, 'admin');
    const id = Id.parse(req.params.id);
    const body = parse(schema.partial().and(Archivable), req.body) as { name?: string; position?: number; color?: string | null; archived?: boolean };
    const arch = archivedAt(body.archived);
    res.json(await tx(req, async (db) => {
      const { rows } = await db.query(
        `update ${table} set name = coalesce($2, name), position = coalesce($3, position),
           archived_at = case when $4 then $5::timestamptz else archived_at end
           ${table === 'business_lines' ? ', color = case when $6 then $7 else color end' : ''}
         where workspace_id = app_ws() and id = $1 returning *`,
        [id, body.name ?? null, body.position ?? null, arch !== undefined, arch ?? null,
          ...(table === 'business_lines' ? [body.color !== undefined, body.color ?? null] : [])]);
      if (!rows[0]) throw new HttpError(404, 'not_found', 'No encontrado');
      return map(rows[0]);
    }));
  });
}
