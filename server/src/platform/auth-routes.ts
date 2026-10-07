// /auth, /me e /invitations: rutas sin workspace activo.
import { Router } from 'express';
import {
  RegisterBody, LoginBody, ForgotPasswordBody, ResetPasswordBody, TotpConfirmBody, UpdateProfileBody, AcceptInvitationBody,
} from '@agencia-hub/contracts';
import { withAdmin, withWorkspace, adminPool } from '../db.ts';
import { enqueue } from '../jobs/queue.ts';
import { HttpError, parse } from './http.ts';
import {
  hashPassword, verifyPassword, setSessionCookie, clearSessionCookie, requireAuth, loadSession,
  newToken, sha256, newTotpSecret, verifyTotp, rateLimit,
} from './auth.ts';
import { buildSession, audit, joinDefaultChannels } from './model.ts';
import { seedWorkspace } from './template.ts';

export const authRouter = Router();
const appUrl = () => process.env.APP_URL ?? 'http://localhost:5180';

authRouter.post('/auth/register', async (req, res) => {
  const body = parse(RegisterBody, req.body);
  rateLimit(`register:${req.ip}`, 10, 3600_000);
  const passwordHash = await hashPassword(body.password);
  const userId = await withAdmin(async (db) => {
    const taken = await db.query(
      'select (select 1 from users where email = $1) as email, (select 1 from workspaces where slug = $2) as slug',
      [body.email, body.workspace.slug]);
    if (taken.rows[0].email) throw new HttpError(409, 'email_taken', 'Ese email ya tiene cuenta; inicia sesión');
    if (taken.rows[0].slug) throw new HttpError(409, 'slug_taken', 'Esa dirección ya está en uso');
    const u = await db.query('insert into users (email, name, password_hash, locale) values ($1, $2, $3, $4) returning id',
      [body.email, body.name, passwordHash, body.locale]);
    const w = await db.query('insert into workspaces (slug, name) values ($1, $2) returning id', [body.workspace.slug, body.workspace.name]);
    const [userId, wsId] = [u.rows[0].id, w.rows[0].id];
    await db.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [wsId, userId]);
    await seedWorkspace(db, wsId, userId, body.workspace.template);
    await joinDefaultChannels(db, wsId, userId);
    await audit(db, { workspaceId: wsId, actor: userId, action: 'workspace.created', ip: req.ip });
    return userId;
  });
  setSessionCookie(res, userId, 0);
  res.status(201).json({ ...(await buildSession(adminPool, userId)), workspaceSlug: body.workspace.slug });
});

authRouter.post('/auth/login', async (req, res) => {
  const body = parse(LoginBody, req.body);
  rateLimit(`login:${req.ip}:${body.email.toLowerCase()}`, 10, 15 * 60_000);
  const { rows } = await adminPool.query(
    'select id, password_hash, totp_enabled, totp_secret, token_version from users where email = $1', [body.email]);
  const u = rows[0];
  if (!(await verifyPassword(body.password, u?.password_hash ?? null))) {
    throw new HttpError(401, 'invalid_credentials', 'Email o contraseña incorrectos');
  }
  if (u.totp_enabled) {
    if (!body.totp) return res.json({ totpRequired: true });
    if (!verifyTotp(u.totp_secret, body.totp)) throw new HttpError(401, 'invalid_totp', 'Código de verificación incorrecto');
  }
  await withAdmin((db) => audit(db, { workspaceId: null, actor: u.id, action: 'auth.login', ip: req.ip }));
  setSessionCookie(res, u.id, u.token_version);
  res.json(await buildSession(adminPool, u.id));
});

authRouter.post('/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.post('/auth/logout-all', requireAuth, async (req, res) => {
  await adminPool.query('update users set token_version = token_version + 1 where id = $1', [req.userId]);
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.post('/auth/forgot-password', async (req, res) => {
  const { email } = parse(ForgotPasswordBody, req.body);
  rateLimit(`forgot:${req.ip}`, 5, 3600_000);
  const { rows } = await adminPool.query('select id, locale from users where email = $1', [email]);
  // Siempre 204: no revela si el email tiene cuenta
  if (rows[0]) {
    const token = newToken();
    await adminPool.query("insert into password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')",
      [sha256(token), rows[0].id]);
    await enqueue('email.send', { to: email, template: 'password_reset', locale: rows[0].locale, url: `${appUrl()}/reset/${token}` });
  }
  res.status(204).end();
});

authRouter.post('/auth/reset-password', async (req, res) => {
  const body = parse(ResetPasswordBody, req.body);
  const passwordHash = await hashPassword(body.password);
  await withAdmin(async (db) => {
    const { rows } = await db.query(
      'update password_resets set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id',
      [sha256(body.token)]);
    if (!rows[0]) throw new HttpError(400, 'invalid_token', 'El enlace expiró o ya se usó');
    // Cambiar la contraseña cierra todas las sesiones abiertas
    await db.query('update users set password_hash = $1, token_version = token_version + 1 where id = $2', [passwordHash, rows[0].user_id]);
    await audit(db, { workspaceId: null, actor: rows[0].user_id, action: 'auth.password_reset', ip: req.ip });
  });
  res.status(204).end();
});

// ─── Perfil ───

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json(await buildSession(adminPool, req.userId!));
});

authRouter.patch('/me', requireAuth, async (req, res) => {
  const body = parse(UpdateProfileBody, req.body);
  const session = await withWorkspace({ workspaceId: null, userId: req.userId! }, async (db) => {
    await db.query(
      `update users set name = coalesce($1, name), locale = coalesce($2, locale), timezone = coalesce($3, timezone)
       where id = app_user()`,
      [body.name ?? null, body.locale ?? null, body.timezone ?? null]);
    // ponytail: avatarFileId se aplica cuando exista el módulo de archivos (Ola 2)
    return buildSession(db, req.userId!);
  });
  res.json(session.user);
});

authRouter.post('/me/totp/setup', requireAuth, async (req, res) => {
  const secret = newTotpSecret();
  const { rows } = await adminPool.query(
    'update users set totp_secret = $1 where id = $2 and not totp_enabled returning email', [secret, req.userId]);
  if (!rows[0]) throw new HttpError(409, 'totp_already_enabled', 'La verificación en dos pasos ya está activa');
  const label = encodeURIComponent(`Kora:${rows[0].email}`);
  res.json({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Agencia%20Hub` });
});

async function checkTotp(userId: string, code: string) {
  const { rows } = await adminPool.query('select totp_secret from users where id = $1', [userId]);
  if (!rows[0]?.totp_secret || !verifyTotp(rows[0].totp_secret, code)) {
    throw new HttpError(400, 'invalid_totp', 'Código de verificación incorrecto');
  }
}

authRouter.post('/me/totp/confirm', requireAuth, async (req, res) => {
  const { code } = parse(TotpConfirmBody, req.body);
  rateLimit(`totp:${req.userId}`, 10, 15 * 60_000);
  await checkTotp(req.userId!, code);
  await withAdmin(async (db) => {
    await db.query('update users set totp_enabled = true where id = $1', [req.userId]);
    await audit(db, { workspaceId: null, actor: req.userId!, action: 'auth.totp_enabled', ip: req.ip });
  });
  res.status(204).end();
});

authRouter.delete('/me/totp', requireAuth, async (req, res) => {
  const { code } = parse(TotpConfirmBody, req.body);
  rateLimit(`totp:${req.userId}`, 10, 15 * 60_000);
  await checkTotp(req.userId!, code);
  await withAdmin(async (db) => {
    await db.query('update users set totp_enabled = false, totp_secret = null where id = $1', [req.userId]);
    await audit(db, { workspaceId: null, actor: req.userId!, action: 'auth.totp_disabled', ip: req.ip });
  });
  res.status(204).end();
});

// ─── Invitaciones (por token, cruzan workspaces → adminPool) ───

const VALID_INVITE = 'revoked_at is null and expires_at > now() and uses < max_uses';

authRouter.get('/invitations/:token', async (req, res) => {
  rateLimit(`invite:${req.ip}`, 30, 15 * 60_000);
  const { rows } = await adminPool.query(
    `select w.name, i.role, i.email, exists (select 1 from users u where u.email = i.email) as has_account
     from invitations i join workspaces w on w.id = i.workspace_id
     where i.token_hash = $1 and ${VALID_INVITE}`, [sha256(req.params.token)]);
  if (!rows[0]) throw new HttpError(404, 'invalid_invitation', 'La invitación no existe o expiró');
  res.json({ workspaceName: rows[0].name, role: rows[0].role, email: rows[0].email, hasAccount: rows[0].has_account });
});

authRouter.post('/invitations/accept', async (req, res) => {
  const body = parse(AcceptInvitationBody, req.body);
  rateLimit(`invite:${req.ip}`, 30, 15 * 60_000);
  const sessionUser = await loadSession(req);
  const passwordHash = body.newAccount ? await hashPassword(body.newAccount.password) : null;

  const result = await withAdmin(async (db) => {
    const { rows } = await db.query(
      `select i.*, w.slug from invitations i join workspaces w on w.id = i.workspace_id
       where i.token_hash = $1 and ${VALID_INVITE} for update of i`, [sha256(body.token)]);
    const inv = rows[0];
    if (!inv) throw new HttpError(404, 'invalid_invitation', 'La invitación no existe o expiró');

    let userId: string;
    let tokenVersion = 0;
    if (sessionUser) {
      const u = (await db.query('select email, token_version from users where id = $1', [sessionUser])).rows[0];
      if (inv.email && inv.email.toLowerCase() !== u.email.toLowerCase()) {
        throw new HttpError(403, 'invitation_email_mismatch', 'Esta invitación es para otro email');
      }
      userId = sessionUser;
      tokenVersion = u.token_version;
    } else if (body.newAccount) {
      const email = inv.email ?? body.newAccount.email;
      if (!email) throw new HttpError(400, 'email_required', 'Escribe tu email');
      if ((await db.query('select 1 from users where email = $1', [email])).rowCount) {
        throw new HttpError(409, 'email_taken', 'Ese email ya tiene cuenta; inicia sesión para aceptar');
      }
      userId = (await db.query('insert into users (email, name, password_hash, locale) values ($1, $2, $3, $4) returning id',
        [email, body.newAccount.name, passwordHash, body.newAccount.locale])).rows[0].id;
    } else {
      throw new HttpError(401, 'unauthenticated', 'Inicia sesión o crea tu cuenta para aceptar');
    }

    const joined = await db.query(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do nothing`, [inv.workspace_id, userId, inv.role]);
    if (joined.rowCount) {
      await db.query('update invitations set uses = uses + 1 where id = $1', [inv.id]);
      await db.query(
        `insert into member_departments (workspace_id, user_id, department_id)
         select $1, $2, id from departments where workspace_id = $1 and id = any($3)`,
        [inv.workspace_id, userId, inv.department_ids]);
      await joinDefaultChannels(db, inv.workspace_id, userId);
      await audit(db, { workspaceId: inv.workspace_id, actor: userId, action: 'member.joined', targetType: 'invitation', targetId: inv.id, ip: req.ip });
    }
    return { userId, tokenVersion, slug: inv.slug };
  });
  setSessionCookie(res, result.userId, result.tokenVersion);
  res.json({ ...(await buildSession(adminPool, result.userId)), workspaceSlug: result.slug });
});
