// Backoffice de plataforma (ADR 0005 §4): acceso solo por platform_admins, auditoría, suspender/reactivar,
// impersonación (motivo, 30 min, solo ese workspace, sin /admin ni 2FA ni facturación) y su fin.
// Al final, operación: /health y el servido de estáticos de producción.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { get, type Server } from 'node:http';
import express from 'express';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';
import { signJwt } from '../src/platform/auth.ts';
import { staticSite } from '../src/static.ts';

let server: Server;
let base: string;
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slugA = `adm-a-${run}`, slugS = `adm-s-${run}`;
let wsA = '', ownerId = '', superId = '';

function client(initialCookie = '') {
  let cookie = initialCookie;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}
const owner = client(), superadmin = client();
const lastAudit = async (action: string) =>
  (await adminPool.query('select * from audit_log where action = $1 and actor_user_id = $2 order by id desc limit 1', [action, superId])).rows[0];

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const reg = (c: typeof owner, email: string, slug: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: `Agencia ${slug}`, slug, template: 'marketing_agency' } });
  const a = await reg(owner, `duena-${run}@test.local`, slugA);
  [wsA, ownerId] = [a.body.workspaces[0].id, a.body.user.id];
  superId = (await reg(superadmin, `rodrigo-${run}@test.local`, slugS)).body.user.id;
  await adminPool.query('insert into platform_admins (user_id) values ($1)', [superId]);
});

after(async () => {
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugS]])).rows.map((r) => r.id);
  for (const t of ['audit_log', 'channel_members', 'channels', 'member_departments', 'member_lines', 'invitations',
    'departments', 'business_lines', 'workspace_members', 'jobs']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ws]);
  const users = (await adminPool.query('select id from users where email like $1', [`%-${run}@test.local`])).rows.map((r) => r.id);
  await adminPool.query('delete from platform_admins where user_id = any($1)', [users]);
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

test('quien no es superadmin recibe 403 en /admin (y sin sesión 401)', async () => {
  for (const [m, p, b] of [['GET', '/admin/workspaces'], ['GET', '/admin/metrics'],
    ['POST', `/admin/workspaces/${wsA}/status`, { status: 'suspended' }],
    ['POST', `/admin/workspaces/${wsA}/impersonate`, { reason: 'curiosidad pura' }]] as const) {
    const r = await owner(m, p, b);
    assert.equal(r.status, 403, p);
    assert.equal(r.body.code, 'forbidden');
  }
  assert.equal((await client()('GET', '/admin/metrics')).status, 401);
  assert.equal((await owner('GET', '/me')).body.platformAdmin, false);
});

test('el superadmin lista agencias con rubro, dueño y MRR, y queda en la bitácora', async () => {
  assert.equal((await superadmin('GET', '/me')).body.platformAdmin, true);
  const r = await superadmin('GET', `/admin/workspaces?q=${slugA}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  const w = r.body[0];
  assert.equal(w.slug, slugA);
  assert.equal(w.settings.industry, 'marketing');
  assert.equal(w.ownerEmail, `duena-${run}@test.local`);
  assert.equal(w.members, 1);
  assert.equal(w.mrrCents, 0);   // en prueba no factura
  assert.equal(typeof w.storageBytes, 'number');
  assert.equal((await superadmin('GET', `/admin/workspaces?q=${slugA}&status=active`)).body.length, 0);
  assert.ok(await lastAudit('admin.workspaces_viewed'));
});

test('métricas: el MRR suma puestos × precio de las agencias activas', async () => {
  const before = (await superadmin('GET', '/admin/metrics')).body;
  for (const k of ['mrrCents', 'activeWorkspaces', 'trials', 'signups30d', 'churn30d']) assert.equal(typeof before[k], 'number', k);
  await adminPool.query("update workspaces set status = 'active', plan = 'pro' where id = $1", [wsA]);
  const after = (await superadmin('GET', '/admin/metrics')).body;
  assert.equal(after.mrrCents - before.mrrCents, 900);
  assert.equal(after.activeWorkspaces - before.activeWorkspaces, 1);
  const listed = (await superadmin('GET', `/admin/workspaces?q=${slugA}`)).body[0];
  assert.equal(listed.mrrCents, 900);
});

test('suspender y reactivar una agencia, con auditoría', async () => {
  assert.equal((await superadmin('POST', `/admin/workspaces/${wsA}/status`, { status: 'suspended' })).status, 204);
  assert.equal((await owner('GET', `/w/${slugA}/members`)).body.code, 'workspace_suspended');
  assert.deepEqual((await lastAudit('admin.workspace_status')).meta, { from: 'active', to: 'suspended' });
  assert.equal((await superadmin('POST', `/admin/workspaces/${wsA}/status`, { status: 'active' })).status, 204);
  assert.equal((await owner('GET', `/w/${slugA}/members`)).status, 200);
  assert.equal((await superadmin('POST', `/admin/workspaces/${wsA}/status`, { status: 'closing' })).status, 400);
  assert.equal((await superadmin('POST', `/admin/workspaces/${randomUUID()}/status`, { status: 'active' })).status, 404);
});

test('impersonar exige motivo y, si la agencia exige 2FA, que el superadmin lo tenga', async () => {
  assert.equal((await superadmin('POST', `/admin/workspaces/${wsA}/impersonate`, {})).status, 400);
  assert.equal((await superadmin('POST', `/admin/workspaces/${wsA}/impersonate`, { reason: 'x' })).status, 400);
  assert.equal((await superadmin('POST', `/admin/workspaces/${randomUUID()}/impersonate`, { reason: 'soporte técnico' })).status, 404);
  await adminPool.query(`update workspaces set settings = settings || '{"require_2fa": true}' where id = $1`, [wsA]);
  const r = await superadmin('POST', `/admin/workspaces/${wsA}/impersonate`, { reason: 'soporte técnico' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'admin_2fa_required');
  await adminPool.query(`update workspaces set settings = settings || '{"require_2fa": false}' where id = $1`, [wsA]);
});

test('impersonación: entra como el Owner, auditada, solo ese workspace y sin acciones sensibles', async () => {
  const r = await superadmin('POST', `/admin/workspaces/${wsA}/impersonate`, { reason: 'Revisar un error del tablero' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, ownerId);
  assert.equal(r.body.workspaceSlug, slugA);
  assert.deepEqual(r.body.workspaces.map((w: any) => w.slug), [slugA]);
  assert.equal(r.body.platformAdmin, false);
  assert.equal(r.body.impersonation.byUserId, superId);
  assert.equal(r.body.impersonation.workspaceSlug, slugA);
  const minutes = (new Date(r.body.impersonation.expiresAt).getTime() - Date.now()) / 60_000;
  assert.ok(minutes > 29 && minutes <= 30);
  const log = await lastAudit('admin.impersonate');
  assert.equal(log.workspace_id, wsA);
  assert.equal(log.meta.reason, 'Revisar un error del tablero');
  assert.equal(log.meta.ownerId, ownerId);

  assert.equal((await superadmin('GET', `/w/${slugA}/members`)).status, 200);
  assert.ok((await superadmin('GET', '/me')).body.impersonation);
  assert.equal((await superadmin('GET', `/w/${slugS}`)).status, 404);   // su propio workspace no
  for (const [m, p, b] of [['GET', '/admin/workspaces'], ['GET', '/admin/metrics'], ['POST', '/me/totp/setup'], ['POST', '/auth/logout-all'],
    ['POST', `/w/${slugA}/billing/checkout`, { plan: 'pro' }], ['POST', `/w/${slugA}/billing/portal`],
    ['POST', `/w/${slugA}/billing/simulate`, { event: 'canceled' }]] as const) {
    const res = await superadmin(m, p, b);
    assert.equal(res.status, 403, p);
    assert.equal(res.body.code, 'impersonation_forbidden', p);
  }
  assert.equal((await superadmin('GET', `/w/${slugA}/billing`)).status, 200);   // ver sí
});

test('terminar la impersonación vuelve a la sesión del superadmin', async () => {
  const r = await superadmin('POST', '/admin/impersonation/end');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, superId);
  assert.equal(r.body.platformAdmin, true);
  assert.equal(r.body.impersonation, null);
  assert.equal((await superadmin('GET', '/admin/metrics')).status, 200);
  assert.equal((await lastAudit('admin.impersonate_end')).workspace_id, wsA);
  assert.equal((await superadmin('POST', '/admin/impersonation/end')).body.code, 'not_impersonating');
});

test('la impersonación expira a los 30 minutos', async () => {
  const tv = (await adminPool.query('select token_version from users where id = $1', [ownerId])).rows[0].token_version;
  const expired = signJwt(ownerId, tv, { by: superId, ws: wsA, exp: Math.floor(Date.now() / 1000) - 1 });
  const c = client(`ah_session=${expired}`);
  assert.equal((await c('GET', '/me')).status, 401);
  assert.equal((await c('GET', `/w/${slugA}/members`)).status, 401);
});

// ─── Operación ───

test('health responde con el estado de la BD', async () => {
  const r = await client()('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, db: true });
});

test('estáticos: SPA con fallback a index.html y landing por hostname, sin tocar /api', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kora-static-'));
  mkdirSync(join(dir, 'web', 'assets'), { recursive: true });
  mkdirSync(join(dir, 'landing'));
  writeFileSync(join(dir, 'web', 'index.html'), '<p>spa</p>');
  writeFileSync(join(dir, 'web', 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(dir, 'landing', 'index.html'), '<p>landing</p>');
  Object.assign(process.env, { WEB_DIST: join(dir, 'web'), LANDING_DIR: join(dir, 'landing'), LANDING_HOST: 'kora.test' });
  const mini = express();
  mini.use(staticSite()!);
  mini.use((_req, res) => { res.status(418).end(); });
  const s = mini.listen(0);
  const url = `http://localhost:${(s.address() as AddressInfo).port}`;
  try {
    const deep = await fetch(`${url}/w/agencia/chat/123`);
    assert.equal(await deep.text(), '<p>spa</p>');
    assert.equal(deep.headers.get('cache-control'), 'no-cache');
    const asset = await fetch(`${url}/assets/app-abc.js`);
    assert.match(asset.headers.get('cache-control')!, /immutable/);
    assert.equal((await fetch(`${url}/api/v1/nada`)).status, 418);   // /api sigue de largo
    // fetch no deja fijar Host: petición cruda con node:http
    const landing = await new Promise<string>((resolve, reject) => {
      get(`${url}/`, { headers: { host: 'kora.test' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c)).on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.equal(landing, '<p>landing</p>');
  } finally {
    s.close();
    for (const k of ['WEB_DIST', 'LANDING_DIR', 'LANDING_HOST']) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
});
