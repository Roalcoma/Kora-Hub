// Flujo de plataforma por HTTP: registro → invitar → aceptar → login → cambio de rol,
// con permiso denegado y aislamiento entre dos agencias.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';
import { totpCode } from '../src/platform/auth.ts';

let server: Server;
let base: string;
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';

/** Cliente con su propia cookie de sesión, como un navegador */
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

const owner = client(), invited = client(), outsider = client();
const slugA = `agencia-a-${run}`, slugB = `agencia-b-${run}`;
const slugMk = `mk-${run}`, slugTr = `viajes-${run}`, slugBl = `blanco-${run}`;
const emailOwner = `owner-${run}@test.local`, emailInvited = `ana-${run}@test.local`;

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  // Limpieza: borra todo lo creado por esta corrida (adminPool ignora RLS)
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB, slugMk, slugTr, slugBl]])).rows.map((r) => r.id);
  for (const t of ['audit_log', 'channel_members', 'channels', 'member_departments', 'member_lines', 'invitations',
    'departments', 'business_lines', 'workspace_members', 'jobs']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ws]);
  const users = (await adminPool.query("select id from users where email like $1", [`%-${run}@test.local`])).rows.map((r) => r.id);
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from password_resets where user_id = any($1)', [users]);
  await adminPool.query('delete from jobs where payload->>\'to\' like $1', [`%-${run}@test.local`]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

const register = (c: ReturnType<typeof client>, email: string, slug: string) => c('POST', '/auth/register', {
  name: 'Dueña', email, password, locale: 'es', workspace: { name: `Agencia ${slug}`, slug, template: 'insurance_agency' },
});

let inviteUrl = '';
let invitedId = '';

test('registro crea workspace con plantilla de seguros', async () => {
  const r = await register(owner, emailOwner, slugA);
  assert.equal(r.status, 201);
  assert.equal(r.body.workspaceSlug, slugA);
  const ws = await owner('GET', `/w/${slugA}`);
  assert.equal(ws.status, 200);
  assert.equal(ws.body.me.role, 'owner');
  assert.deepEqual(ws.body.lines.map((l: any) => l.name), ['Salud', 'Vida', 'Medicare']);
  assert.equal(ws.body.departments.length, 4);
  assert.equal(ws.body.status, 'trialing');
  assert.deepEqual(ws.body.lines.map((l: any) => l.color), ['green', 'blue', 'purple']);
  assert.equal(ws.body.settings.industry, 'insurance');
  assert.deepEqual(ws.body.settings.categoryLabel, { singular: 'Línea', plural: 'Líneas' });
  assert.equal(r.body.platformAdmin, false);
  assert.equal(r.body.impersonation, null);
});

test('plantillas por rubro: departamentos, categorías y etiqueta en el idioma del registro', async () => {
  const reg = async (slug: string, template: string, locale: 'es' | 'en') => {
    const c = client();
    const r = await c('POST', '/auth/register', {
      name: 'Dueño', email: `${slug}@test.local`, password, locale,
      workspace: { name: slug, slug, template } });
    assert.equal(r.status, 201);
    return (await c('GET', `/w/${slug}`)).body;
  };
  const mk = await reg(slugMk, 'marketing_agency', 'en');
  assert.equal(mk.settings.industry, 'marketing');
  assert.deepEqual(mk.settings.categoryLabel, { singular: 'Client', plural: 'Clients' });
  assert.deepEqual(mk.departments.map((d: any) => d.name), ['Accounts', 'Creative', 'Media', 'Administration']);
  assert.equal(mk.lines.length, 0);

  const tr = await reg(slugTr, 'travel_agency', 'es');
  assert.equal(tr.settings.industry, 'travel');
  assert.deepEqual(tr.settings.categoryLabel, { singular: 'Producto', plural: 'Productos' });
  assert.deepEqual(tr.lines.map((l: any) => [l.name, l.color]), [['Vuelos', 'blue'], ['Paquetes', 'orange'], ['Cruceros', 'teal']]);
  assert.equal(tr.departments[2].name, 'Atención al viajero');

  const bl = await reg(slugBl, 'blank', 'es');
  assert.equal(bl.settings.industry, 'other');
  assert.equal(bl.settings.categoryLabel, null);
  assert.equal(bl.departments.length + bl.lines.length, 0);
});

test('registro rechaza email o slug repetidos y datos inválidos', async () => {
  assert.equal((await register(client(), emailOwner, `otro-${run}`)).body.code, 'email_taken');
  assert.equal((await register(client(), `x-${run}@test.local`, slugA)).body.code, 'slug_taken');
  const bad = await client()('POST', '/auth/register', { email: 'no-es-email' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_input');
});

test('el owner invita por enlace y la persona invitada crea su cuenta', async () => {
  const ws = await owner('GET', `/w/${slugA}`);
  const ventas = ws.body.departments.find((d: any) => d.name === 'Ventas').id;
  const inv = await owner('POST', `/w/${slugA}/invitations`, { email: null, role: 'member', departmentIds: [ventas], maxUses: 5 });
  assert.equal(inv.status, 201);
  inviteUrl = inv.body.url;
  const token = inviteUrl.split('/invite/')[1]!;

  const info = await invited('GET', `/invitations/${token}`);
  assert.equal(info.body.workspaceName, `Agencia ${slugA}`);

  const acc = await invited('POST', '/invitations/accept', {
    token, newAccount: { name: 'Ana Torres', password, locale: 'es', email: emailInvited },
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.workspaceSlug, slugA);
  invitedId = acc.body.user.id;

  const me = await invited('GET', `/w/${slugA}`);
  assert.equal(me.body.me.role, 'member');
  assert.deepEqual(me.body.me.departmentIds, [ventas]);
});

test('la persona invitada inicia sesión con su contraseña', async () => {
  await invited('POST', '/auth/logout');
  assert.equal((await invited('GET', '/me')).status, 401);
  const bad = await invited('POST', '/auth/login', { email: emailInvited, password: 'incorrecta-123' });
  assert.equal(bad.status, 401);
  const ok = await invited('POST', '/auth/login', { email: emailInvited, password });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.workspaces.map((w: any) => w.slug), [slugA]);
});

test('un miembro no puede cambiar roles ni invitar', async () => {
  const r = await invited('PATCH', `/w/${slugA}/members/${invitedId}`, { role: 'admin' });
  assert.equal(r.status, 403);
  assert.equal((await invited('POST', `/w/${slugA}/invitations`, { email: null, role: 'admin' })).status, 403);
});

test('el owner cambia el rol y queda en la bitácora', async () => {
  const r = await owner('PATCH', `/w/${slugA}/members/${invitedId}`, { role: 'lead', title: 'Líder de Vida' });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'lead');
  assert.equal(r.body.title, 'Líder de Vida');
  const log = await adminPool.query("select meta from audit_log where action = 'member.role_changed' and target_id = $1", [invitedId]);
  assert.deepEqual(log.rows[0].meta, { from: 'member', to: 'lead' });
});

test('el admin cambia rubro y nombre de la categoría; color solo de la paleta', async () => {
  const r = await owner('PATCH', `/w/${slugA}`, { settings: { industry: 'real_estate', categoryLabel: { singular: 'Sede', plural: 'Sedes' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.industry, 'real_estate');
  assert.deepEqual(r.body.settings.categoryLabel, { singular: 'Sede', plural: 'Sedes' });
  assert.equal(r.body.settings.maxFileMb, 25);   // el merge no pisa lo demás
  const reset = await owner('PATCH', `/w/${slugA}`, { settings: { industry: 'insurance', categoryLabel: null } });
  assert.equal(reset.body.settings.categoryLabel, null);
  assert.equal((await owner('POST', `/w/${slugA}/lines`, { name: 'Dental', color: 'salud' })).status, 400);
  const ok = await owner('POST', `/w/${slugA}/lines`, { name: 'Dental', color: 'teal' });
  assert.equal(ok.body.color, 'teal');
  assert.equal((await invited('PATCH', `/w/${slugA}`, { settings: { industry: 'travel' } })).status, 403);
});

test('no se puede quitar al único owner', async () => {
  const me = (await owner('GET', '/me')).body.user.id;
  const r = await owner('PATCH', `/w/${slugA}/members/${me}`, { role: 'admin' });
  assert.equal(r.body.code, 'last_owner');
});

test('aislamiento: el owner de otra agencia no ve ni toca la agencia A', async () => {
  await register(outsider, `owner-b-${run}@test.local`, slugB);
  assert.equal((await outsider('GET', `/w/${slugA}`)).status, 404);
  assert.equal((await outsider('GET', `/w/${slugA}/members`)).status, 404);
  assert.equal((await outsider('PATCH', `/w/${slugA}/members/${invitedId}`, { role: 'guest' })).status, 404);
  // Usar su propio workspace con un userId ajeno tampoco funciona
  assert.equal((await outsider('PATCH', `/w/${slugB}/members/${invitedId}`, { role: 'guest' })).status, 404);
  const deptA = (await owner('GET', `/w/${slugA}`)).body.departments[0].id;
  const r = await outsider('PATCH', `/w/${slugB}/departments/${deptA}`, { name: 'hackeado' });
  assert.equal(r.status, 404);
});

test('invitación revocada deja de funcionar', async () => {
  const inv = await owner('POST', `/w/${slugA}/invitations`, { email: `nadie-${run}@test.local`, role: 'member' });
  await owner('DELETE', `/w/${slugA}/invitations/${inv.body.id}`);
  const token = inv.body.url.split('/invite/')[1];
  assert.equal((await client()('GET', `/invitations/${token}`)).status, 404);
});

test('2FA: login pide código y lo valida', async () => {
  const setup = await invited('POST', '/me/totp/setup');
  await invited('POST', '/me/totp/confirm', { code: totpCode(setup.body.secret) });
  const c = client();
  assert.deepEqual((await c('POST', '/auth/login', { email: emailInvited, password })).body, { totpRequired: true });
  assert.equal((await c('POST', '/auth/login', { email: emailInvited, password, totp: '000000' })).status, 401);
  assert.equal((await c('POST', '/auth/login', { email: emailInvited, password, totp: totpCode(setup.body.secret) })).status, 200);
});

test('cerrar sesión en todos los dispositivos revoca la cookie anterior', async () => {
  const other = client();
  await other('POST', '/auth/login', { email: emailOwner, password });
  await owner('POST', '/auth/logout-all');
  assert.equal((await other('GET', '/me')).status, 401);
});
