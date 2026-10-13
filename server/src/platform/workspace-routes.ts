// /w/:slug — configuración del workspace, miembros, invitaciones, departamentos y líneas. Todo con RLS (tx).
import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  Id, UpdateWorkspaceBody, UpdateMyMembershipBody, UpdateMemberBody, CreateMemberBody, SetMemberPasswordBody, CreateInvitationBody, DepartmentBody, BusinessLineBody,
  type Invitation,
} from '@agencia-hub/contracts';
import { enqueue } from '../jobs/queue.ts';
import { HttpError, parse } from './http.ts';
import { newToken, sha256, hashPassword } from './auth.ts';
import { tx, requireRole, isAdmin } from './workspace.ts';
import { toWorkspace, toDepartment, toLine, listMembers, audit, joinDefaultChannels } from './model.ts';
import { withAdmin, adminPool } from '../db.ts';
import { seedFinanceCategories } from './template.ts';
import { disconnectUser } from '../realtime/hub.ts';
import { syncDepartmentChannels } from '../chat/department-channels.ts';
import { linkAgentByEmail } from '../sales/link.ts';
import { enqueueSeatSync } from '../billing/lifecycle.ts';

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
    industry: s.industry, category_label: s.categoryLabel, sales_module: s.salesModule,
    finance_module: s.financeModule,
  }).filter(([, v]) => v !== undefined));
  res.json(await tx(req, async (db) => {
    const { rows } = await db.query(
      'update workspaces set name = coalesce($1, name), settings = settings || $2 where id = app_ws() returning *',
      [body.name ?? null, settingsPatch]);
    if (s.financeModule) await seedFinanceCategories(db, req.ws!.id);
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
  const members = await tx(req, (db) => listMembers(db));
  if (!isAdmin(req)) return res.json(members);
  // Al Admin se le dice qué cuentas también están en otra agencia (o son superadmin): esas no se editan aquí
  const { rows } = await adminPool.query(
    `select user_id from workspace_members where user_id = any($1) and workspace_id <> $2
     union select user_id from platform_admins where user_id = any($1)`, [members.map((m) => m.userId), req.ws!.id]);
  const shared = new Set(rows.map((r) => r.user_id));
  res.json(members.map((m) => ({ ...m, sharedAccount: shared.has(m.userId) })));
});

/**
 * Cuenta que un Admin puede tocar a fondo (nombre, email, contraseña, enlace de recuperación): la persona está en esta
 * agencia, no es Owner (salvo que quien pide lo sea) y su cuenta no está en otra agencia ni es superadmin. Si no, un Admin
 * de una agencia podría quedarse con la cuenta de alguien que es Owner en otra.
 */
async function ownAccount(db: pg.PoolClient, req: Request, targetId: string) {
  const t = (await db.query('select role from workspace_members where workspace_id = $1 and user_id = $2', [req.ws!.id, targetId])).rows[0];
  if (!t) throw new HttpError(404, 'member_not_found', 'Miembro no encontrado');
  if (t.role === 'owner' && req.ws!.role !== 'owner') throw new HttpError(403, 'forbidden', 'Solo un Owner cambia la cuenta de otro Owner');
  const elsewhere = await db.query(
    'select 1 from workspace_members where user_id = $1 and workspace_id <> $2 union all select 1 from platform_admins where user_id = $1', [targetId, req.ws!.id]);
  if (elsewhere.rowCount) throw new HttpError(409, 'shared_account', 'Esta cuenta también está en otra agencia: estos datos los cambia la persona');
  return t as { role: string };
}

workspaceRouter.patch('/members/:userId', async (req, res) => {
  requireRole(req, 'admin');
  const targetId = Id.parse(req.params.userId);
  const body = parse(UpdateMemberBody, req.body);
  // Nombre y email viven en la cuenta (tabla users, fuera de la agencia): solo cuentas que son únicamente de aquí
  if (body.name !== undefined || body.email !== undefined) {
    await withAdmin(async (db) => {
      await ownAccount(db, req, targetId);
      const email = body.email?.toLowerCase();
      if (email && (await db.query('select 1 from users where email = $1 and id <> $2', [email, targetId])).rowCount) {
        throw new HttpError(409, 'email_taken', 'Ese email ya es de otra cuenta');
      }
      await db.query('update users set name = coalesce($2, name), email = coalesce($3, email) where id = $1', [targetId, body.name ?? null, email ?? null]);
      await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'member.account_changed', targetType: 'user', targetId,
        meta: { name: body.name, email }, ip: req.ip });
    });
  }
  const member = await tx(req, async (db) => {
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
    if (body.modules) {
      // Se fusiona con lo que ya tenía; null quita el ajuste y vuelve al valor por defecto del rol
      const cur = (await db.query('select module_access from workspace_members where workspace_id = app_ws() and user_id = $1', [targetId])).rows[0].module_access;
      const next = Object.fromEntries(Object.entries({ ...cur, ...body.modules }).filter(([, v]) => v != null));
      await db.query('update workspace_members set module_access = $2 where workspace_id = app_ws() and user_id = $1', [targetId, next]);
      await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'member.modules_changed', targetType: 'user', targetId,
        meta: { from: cur, to: next }, ip: req.ip });
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
    if (body.role || body.isActive !== undefined || body.departments || body.lineIds) {
      await syncDepartmentChannels(db, req.ws!.id, { userId: targetId });
    }
    if (body.role && body.role !== target.role) {
      await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'member.role_changed', targetType: 'user', targetId,
        meta: { from: target.role, to: body.role }, ip: req.ip });
    }
    if (body.isActive !== undefined) {
      await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: body.isActive ? 'member.reactivated' : 'member.deactivated',
        targetType: 'user', targetId, ip: req.ip });
    }
    return (await listMembers(db, targetId))[0]!;
  });
  // Pueden cambiar los puestos facturables (activo y no invitado); el job no hace nada si la cuenta no cambió
  if (body.isActive !== undefined || body.role) {
    await enqueueSeatSync(req.ws!.id);
  }
  if (body.isActive === false) disconnectUser(req.params.userId as string, req.ws!.id);
  res.json(member);
});

// Crear la cuenta desde Ajustes (Admin), con contraseña, departamentos y líneas: sin correo ni enlace de invitación.
// La tabla users no es de la agencia (sin grant para agencia_app): va por adminPool, con el workspace fijado a mano.
workspaceRouter.post('/members', async (req, res) => {
  requireRole(req, 'admin');
  const body = parse(CreateMemberBody, req.body);
  if (body.role === 'owner' && req.ws!.role !== 'owner') throw new HttpError(403, 'forbidden', 'Solo un Owner crea otro Owner');
  const wsId = req.ws!.id;
  const passwordHash = await hashPassword(body.password);
  const out = await withAdmin(async (db) => {
    await db.query(`select set_config('app.workspace_id', $1, true)`, [wsId]);
    const email = body.email.toLowerCase();
    let user = (await db.query('select id from users where email = $1', [email])).rows[0];
    const existingAccount = !!user;
    if (user) {
      const member = await db.query('select 1 from workspace_members where workspace_id = $1 and user_id = $2', [wsId, user.id]);
      if (member.rowCount) throw new HttpError(409, 'already_member', 'Esa persona ya está en la agencia');
    } else {
      user = (await db.query('insert into users (email, name, password_hash, locale) values ($1, $2, $3, $4) returning id',
        [email, body.name, passwordHash, 'es'])).rows[0];
    }
    await db.query('insert into workspace_members (workspace_id, user_id, role, title, module_access) values ($1, $2, $3, $4, $5)',
      [wsId, user.id, body.role, body.title, body.modules]);
    // FK compuestas: un departamento o una línea de otra agencia hace fallar el insert
    for (const d of body.departments) {
      await db.query('insert into member_departments (workspace_id, user_id, department_id, is_lead) values ($1, $2, $3, $4)', [wsId, user.id, d.id, d.isLead]);
    }
    for (const l of body.lineIds) await db.query('insert into member_lines (workspace_id, user_id, line_id) values ($1, $2, $3)', [wsId, user.id, l]);
    await joinDefaultChannels(db, wsId, user.id);
    await syncDepartmentChannels(db, wsId, { userId: user.id });
    await linkAgentByEmail(db, wsId, user.id);
    await audit(db, { workspaceId: wsId, actor: req.userId!, action: 'member.created', targetType: 'user', targetId: user.id,
      meta: { role: body.role, existingAccount }, ip: req.ip });
    return { ...(await listMembers(db, user.id))[0]!, existingAccount };
  }).catch((e) => {
    if (e?.code === '23503') throw new HttpError(400, 'invalid_reference', 'Departamento o línea no válidos');
    throw e;
  });
  if (body.role !== 'guest') await enqueueSeatSync(wsId);
  res.status(201).json(out);
});

// Poner una contraseña nueva a alguien de la agencia (Admin). Solo cuentas que no están en otra agencia: así un Admin no
// toma la cuenta de alguien que también es Owner en otro lado. Cierra todas sus sesiones.
workspaceRouter.put('/members/:userId/password', async (req, res) => {
  requireRole(req, 'admin');
  const targetId = Id.parse(req.params.userId);
  const { password } = parse(SetMemberPasswordBody, req.body);
  if (targetId === req.userId) throw new HttpError(400, 'use_profile', 'Tu contraseña se cambia desde Mi perfil');
  const wsId = req.ws!.id;
  const passwordHash = await hashPassword(password);
  await withAdmin(async (db) => {
    await ownAccount(db, req, targetId);
    await db.query('update users set password_hash = $2, token_version = token_version + 1 where id = $1', [targetId, passwordHash]);
    await audit(db, { workspaceId: wsId, actor: req.userId!, action: 'member.password_set', targetType: 'user', targetId, ip: req.ip });
  });
  disconnectUser(targetId, wsId);
  res.status(204).end();
});

// Enlace de recuperación generado por el Admin (todavía no hay correo saliente): se lo pasa a la persona por WhatsApp y
// ella elige su clave en /reset. Mismas reglas que poner la contraseña. Vence en 24 h y sirve una sola vez.
workspaceRouter.post('/members/:userId/recovery-link', async (req, res) => {
  requireRole(req, 'admin');
  const targetId = Id.parse(req.params.userId);
  const token = newToken();
  const out = await withAdmin(async (db) => {
    await ownAccount(db, req, targetId);
    const { rows } = await db.query(
      "insert into password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + interval '24 hours') returning expires_at",
      [sha256(token), targetId]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'member.recovery_link', targetType: 'user', targetId, ip: req.ip });
    return { url: `${appUrl()}/reset/${token}`, expiresAt: rows[0].expires_at.toISOString() };
  });
  res.status(201).json(out);
});

// Cerrar todas sus sesiones (teléfono perdido, salida de la agencia). Un Admin no lo hace con un Owner.
workspaceRouter.post('/members/:userId/logout-all', async (req, res) => {
  requireRole(req, 'admin');
  const targetId = Id.parse(req.params.userId);
  await withAdmin(async (db) => {
    const t = (await db.query('select role from workspace_members where workspace_id = $1 and user_id = $2', [req.ws!.id, targetId])).rows[0];
    if (!t) throw new HttpError(404, 'member_not_found', 'Miembro no encontrado');
    if (t.role === 'owner' && req.ws!.role !== 'owner') throw new HttpError(403, 'forbidden', 'Solo un Owner cierra las sesiones de otro Owner');
    await db.query('update users set token_version = token_version + 1 where id = $1', [targetId]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'member.logged_out', targetType: 'user', targetId, ip: req.ip });
  });
  disconnectUser(targetId);
  res.status(204).end();
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
