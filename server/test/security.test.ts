// Regresiones de la revisión de seguridad de las Olas 0–4 (docs/seguridad/revision-olas-0-4.md):
// A1 el WebSocket no tumba el proceso · A2 IP real detrás del proxy · A3 la API no se cachea ·
// M1 sockets revocados se cierran · M3 sin simulador en producción · M4 backoffice con 2FA en producción.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { app } from '../src/index.ts';
import { attachRealtime, closeAll } from '../src/realtime/hub.ts';
import { adminPool, appPool } from '../src/db.ts';

let server: Server;
let base = '';
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slug = `seg-${run}`;

type Client = ReturnType<typeof client>;
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method, headers: { cookie, 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return Object.assign(call, {
    async socket() {
      const { body } = await call('POST', `/w/${slug}/ws-ticket`);
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${body.ticket}`);
      ws.on('error', () => {});
      await new Promise((ok, fail) => { ws.once('open', ok); ws.once('unexpected-response', fail); });
      return ws;
    },
  });
}

const owner = client(), ana = client();
let ownerId = '', anaId = '';

/** Cierre del socket (código) o null si sigue abierto pasado `ms` */
const closed = (ws: WebSocket, ms = 1500) => new Promise<number | null>((r) => {
  const t = setTimeout(() => r(null), ms);
  ws.once('close', (code) => { clearTimeout(t); r(code); });
});
/** El socket sigue sirviendo: responde ping con pong */
const pong = (ws: WebSocket) => new Promise<boolean>((r) => {
  const t = setTimeout(() => r(false), 1500);
  ws.on('message', (d) => { if (JSON.parse(String(d)).type === 'pong') { clearTimeout(t); r(true); } });
  ws.send(JSON.stringify({ type: 'ping' }));
});

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

before(async () => {
  server = createServer(app);
  attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  ownerId = (await owner('POST', '/auth/register', {
    name: 'Dueña', email: `owner-${run}@test.local`, password, locale: 'es', workspace: { name: slug, slug, template: 'blank' },
  })).body.user.id;
  const inv = await owner('POST', `/w/${slug}/invitations`, { email: null, role: 'member' });
  anaId = (await ana('POST', '/invitations/accept', {
    token: inv.body.url.split('/invite/')[1], newAccount: { name: 'Ana', password, locale: 'es', email: `ana-${run}@test.local` },
  })).body.user.id;
});

after(async () => {
  closeAll();
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = $1', [slug])).rows.map((r) => r.id);
  for (const t of ['ws_tickets', 'channel_members', 'channels', 'audit_log', 'invitations', 'workspace_members', 'jobs']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ws]);
  const users = (await adminPool.query('select id from users where email like $1', [`%-${run}@test.local`])).rows.map((r) => r.id);
  await adminPool.query('delete from platform_admins where user_id = any($1)', [users]);
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from ws_tickets where user_id = any($1)', [users]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

test('A1: mensajes hostiles por WebSocket no tumban el servidor', async () => {
  const bad = await owner.socket();
  bad.send('null');
  bad.send('42');
  bad.send('"texto"');
  bad.send('x'.repeat(32 * 1024));   // mayor que maxPayload: el servidor corta ese socket
  assert.notEqual(await closed(bad, 3000), null);
  // El proceso sigue vivo y los demás sockets siguen funcionando
  assert.equal((await owner('GET', '/health')).status, 200);
  const good = await owner.socket();
  assert.equal(await pong(good), true);
  good.close();
});

test('A2: detrás del proxy, la IP del audit_log es la del cliente', async () => {
  const c = client();
  await c('POST', '/auth/login', { email: `ana-${run}@test.local`, password }, { 'x-forwarded-for': '203.0.113.7' });
  const { rows } = await adminPool.query(
    "select ip from audit_log where actor_user_id = $1 and action = 'auth.login' order by id desc limit 1", [anaId]);
  assert.equal(rows[0].ip, '203.0.113.7');
});

test('A3: ninguna respuesta de la API se guarda en caché (tampoco el CSV)', async () => {
  const csv = await owner('GET', `/w/${slug}/goals/dashboard.csv`);
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  assert.equal((await owner('GET', '/me')).headers.get('cache-control'), 'no-store');
});

test('M1: desactivar a un miembro cierra su socket abierto', async () => {
  const ws = await ana.socket();
  assert.equal((await owner('PATCH', `/w/${slug}/members/${anaId}`, { isActive: false })).status, 200);
  assert.equal(await closed(ws), 4001);
  await owner('PATCH', `/w/${slug}/members/${anaId}`, { isActive: true });
});

test('M1: "cerrar sesión en todos" cierra los sockets', async () => {
  const c = client();
  await c('POST', '/auth/login', { email: `ana-${run}@test.local`, password });
  const ws = await c.socket();
  assert.equal((await c('POST', '/auth/logout-all')).status, 204);
  assert.equal(await closed(ws), 4001);
});

test('M3: en producción sin llaves de Stripe no hay simulador; el cobro es manual', async () => {
  await withEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: undefined, BILLING_SIMULATED: undefined }, async () => {
    assert.equal((await owner('POST', `/w/${slug}/billing/simulate`, { event: 'paid', plan: 'pro' })).status, 404);
    const co = await owner('POST', `/w/${slug}/billing/checkout`, { plan: 'pro' });
    assert.equal(co.status, 409);
    assert.equal(co.body.code, 'billing_manual');
    assert.equal((await owner('GET', `/w/${slug}/billing`)).body.simulated, false);
  });
  // Demos: se puede encender a propósito
  await withEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: undefined, BILLING_SIMULATED: 'true' }, async () => {
    assert.equal((await owner('GET', `/w/${slug}/billing`)).body.simulated, true);
  });
});

test('M4: en producción el backoffice exige 2FA al superadmin', async () => {
  await adminPool.query('insert into platform_admins (user_id) values ($1) on conflict do nothing', [ownerId]);
  assert.equal((await owner('GET', '/admin/metrics')).status, 200);   // fuera de producción basta con ser superadmin
  await withEnv({ NODE_ENV: 'production' }, async () => {
    const r = await owner('GET', '/admin/metrics');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'admin_2fa_required');
  });
});
