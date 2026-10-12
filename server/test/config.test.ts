// Configuración pública: registro abierto/cerrado (REGISTRATION_OPEN), GET /config sin sesión y cálculo de la
// ventana diaria del respaldo (MAINTENANCE_*).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';
import { maintenanceWindow } from '../src/platform/config.ts';

let server: Server;
let base: string;
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slug = `cfg-${run}`, slugClosed = `cfg-cerrado-${run}`;
const ENV_KEYS = ['REGISTRATION_OPEN', 'MAINTENANCE_DAILY_UTC', 'MAINTENANCE_MINUTES', 'MAINTENANCE_NOTICE_MINUTES'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function client() {
  let cookie = '';
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
const owner = client(), invited = client(), anon = client();
const register = (c: ReturnType<typeof client>, email: string, s: string) => c('POST', '/auth/register', {
  name: 'Dueña', email, password, locale: 'es', workspace: { name: `Agencia ${s}`, slug: s, template: 'blank' },
});

before(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const k of ENV_KEYS) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slug, slugClosed]])).rows.map((r) => r.id);
  for (const t of ['audit_log', 'channel_members', 'channels', 'member_departments', 'member_lines', 'invitations',
    'departments', 'business_lines', 'expense_categories', 'workspace_members', 'jobs']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ws]);
  const users = (await adminPool.query('select id from users where email like $1', [`%-${run}@test.local`])).rows.map((r) => r.id);
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

test('por defecto el registro está abierto y /config responde sin sesión', async () => {
  const cfg = await anon('GET', '/config');
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.body, { registrationOpen: true, maintenance: null });
  const reg = await register(owner, `owner-${run}@test.local`, slug);
  assert.equal(reg.status, 201);
});

test('registro cerrado: 403 registration_closed y /config lo refleja', async () => {
  process.env.REGISTRATION_OPEN = 'false';
  try {
    const reg = await register(anon, `nuevo-${run}@test.local`, slugClosed);
    assert.equal(reg.status, 403);
    assert.equal(reg.body.code, 'registration_closed');
    assert.match(reg.body.error, /invitación/);
    assert.equal((await adminPool.query('select 1 from workspaces where slug = $1', [slugClosed])).rowCount, 0);
    assert.equal((await anon('GET', '/config')).body.registrationOpen, false);
  } finally {
    delete process.env.REGISTRATION_OPEN;
  }
});

test('registro cerrado: aceptar una invitación creando la cuenta sigue funcionando', async () => {
  const inv = await owner('POST', `/w/${slug}/invitations`, { email: null, role: 'member', departmentIds: [], maxUses: 1 });
  assert.equal(inv.status, 201);
  const token = inv.body.url.split('/invite/')[1]!;
  process.env.REGISTRATION_OPEN = 'false';
  try {
    const acc = await invited('POST', '/invitations/accept', {
      token, newAccount: { name: 'Ana Invitada', password, locale: 'es', email: `ana-${run}@test.local` },
    });
    assert.equal(acc.status, 200);
    assert.equal(acc.body.workspaceSlug, slug);
    assert.equal((await invited('GET', `/w/${slug}`)).body.me.role, 'member');
  } finally {
    delete process.env.REGISTRATION_OPEN;
  }
});

test('/config devuelve la ventana del respaldo según MAINTENANCE_*', async () => {
  process.env.MAINTENANCE_DAILY_UTC = '06:00';
  process.env.MAINTENANCE_MINUTES = '20';
  process.env.MAINTENANCE_NOTICE_MINUTES = '45';
  try {
    const { body } = await anon('GET', '/config');
    const start = new Date(body.maintenance.startsAt);
    assert.equal(start.getUTCHours(), 6);
    assert.equal(start.getUTCMinutes(), 0);
    assert.equal(new Date(body.maintenance.endsAt).getTime() - start.getTime(), 20 * 60_000);
    assert.equal(body.maintenance.noticeMinutes, 45);
    assert.ok(new Date(body.maintenance.endsAt).getTime() > Date.now());
  } finally {
    for (const k of ENV_KEYS) delete process.env[k];
  }
});

test('ventana del respaldo: antes, durante, después y sin configurar', () => {
  const at = (iso: string) => new Date(iso);
  const iso = (w: ReturnType<typeof maintenanceWindow>) => w && [w.startsAt.toISOString(), w.endsAt.toISOString()];
  // Antes: la de hoy
  assert.deepEqual(iso(maintenanceWindow(at('2026-10-12T05:40:00Z'), '06:00', 15)),
    ['2026-10-12T06:00:00.000Z', '2026-10-12T06:15:00.000Z']);
  // Durante: la que está en curso
  assert.deepEqual(iso(maintenanceWindow(at('2026-10-12T06:07:00Z'), '06:00', 15)),
    ['2026-10-12T06:00:00.000Z', '2026-10-12T06:15:00.000Z']);
  // Después (justo al terminar): la de mañana
  assert.deepEqual(iso(maintenanceWindow(at('2026-10-12T06:15:00Z'), '06:00', 15)),
    ['2026-10-13T06:00:00.000Z', '2026-10-13T06:15:00.000Z']);
  // Cruza la medianoche UTC: a las 00:05 sigue en curso la de ayer
  assert.deepEqual(iso(maintenanceWindow(at('2026-10-13T00:05:00Z'), '23:55', 15)),
    ['2026-10-12T23:55:00.000Z', '2026-10-13T00:10:00.000Z']);
  // Vacío, mal formado o sin duración: sin aviso
  assert.equal(maintenanceWindow(at('2026-10-12T05:40:00Z'), '', 15), null);
  assert.equal(maintenanceWindow(at('2026-10-12T05:40:00Z'), undefined, 15), null);
  assert.equal(maintenanceWindow(at('2026-10-12T05:40:00Z'), '25:00', 15), null);
  assert.equal(maintenanceWindow(at('2026-10-12T05:40:00Z'), '06:00', 0), null);
});
