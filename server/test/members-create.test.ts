// Admin crea cuentas con contraseña, departamentos y líneas desde Ajustes, y puede ponerles una contraseña nueva.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';

let server: Server;
let base = '';
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slugA = `mem-a-${run}`, slugB = `mem-b-${run}`, slugC = `mem-c-${run}`;

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}
type Client = ReturnType<typeof client>;
const login = (email: string, pw: string) => client()('POST', '/auth/login', { email, password: pw });

const owner = client(), outsider = client(), stranger = client();
let ventas = '', vida = '', deptB = '', outsiderId = '';
const mail = (n: string) => `${n}-${run}@test.local`;

before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const reg = (c: Client, email: string, slug: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template: 'insurance_agency' } });
  await reg(owner, mail('owner'), slugA);
  outsiderId = (await reg(outsider, mail('intruso'), slugB)).body.user.id;
  await reg(stranger, mail('ajeno'), slugC);
  const ws = (await owner('GET', `/w/${slugA}`)).body;
  ventas = ws.departments[0].id;
  vida = ws.lines.find((l: any) => l.name === 'Vida').id;
  deptB = (await outsider('GET', `/w/${slugB}`)).body.departments[0].id;
});

after(async () => {
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB, slugC]])).rows.map((r) => r.id);
  for (const t of ['channel_members', 'channels', 'audit_log', 'member_departments', 'member_lines', 'invitations',
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

let anaId = '';

test('Admin crea una cuenta con contraseña, departamento y línea; entra con esa clave', async () => {
  const r = await owner('POST', `/w/${slugA}/members`, {
    name: 'Ana Torres', email: mail('ana'), password: 'Postventa2026', departments: [{ id: ventas, isLead: false }], lineIds: [vida] });
  assert.equal(r.status, 201);
  assert.equal(r.body.existingAccount, false);
  assert.deepEqual(r.body.departmentIds, [ventas]);
  assert.deepEqual(r.body.lineIds, [vida]);
  assert.equal(r.body.role, 'member');
  anaId = r.body.userId;
  assert.equal((await login(mail('ana'), 'Postventa2026')).status, 200);
  assert.equal((await owner('POST', `/w/${slugA}/members`, { name: 'Ana', email: mail('ana'), password: 'otra-clave-123' })).status, 409);
});

test('si el email ya tiene cuenta, se suma a la agencia sin tocar su contraseña', async () => {
  const r = await owner('POST', `/w/${slugA}/members`, { name: 'X', email: mail('intruso'), password: 'no-se-usa-123' });
  assert.equal(r.status, 201);
  assert.equal(r.body.existingAccount, true);
  assert.equal((await login(mail('intruso'), password)).status, 200);
  assert.equal((await login(mail('intruso'), 'no-se-usa-123')).status, 401);
});

test('Admin pone una contraseña nueva: la vieja deja de servir', async () => {
  assert.equal((await owner('PUT', `/w/${slugA}/members/${anaId}/password`, { password: 'nueva-clave-456' })).status, 204);
  assert.equal((await login(mail('ana'), 'Postventa2026')).status, 401);
  assert.equal((await login(mail('ana'), 'nueva-clave-456')).status, 200);
  // Cuenta que también está en otra agencia: no se le cambia desde aquí
  assert.equal((await owner('PUT', `/w/${slugA}/members/${outsiderId}/password`, { password: 'robada-12345' })).status, 409);
  assert.equal((await login(mail('intruso'), password)).status, 200);
});

test('permiso: un Miembro no crea cuentas ni cambia contraseñas; un Admin no crea Owners', async () => {
  const ana = client();
  await ana('POST', '/auth/login', { email: mail('ana'), password: 'nueva-clave-456' });
  assert.equal((await ana('POST', `/w/${slugA}/members`, { name: 'Y', email: mail('y'), password: 'clave-larga-123' })).status, 403);
  assert.equal((await ana('PUT', `/w/${slugA}/members/${outsiderId}/password`, { password: 'clave-larga-123' })).status, 403);
  const admin = await owner('POST', `/w/${slugA}/members`, { name: 'Admin', email: mail('admin'), password: 'clave-admin-123', role: 'admin' });
  const adm = client();
  await adm('POST', '/auth/login', { email: mail('admin'), password: 'clave-admin-123' });
  assert.equal(admin.status, 201);
  assert.equal((await adm('POST', `/w/${slugA}/members`, { name: 'Z', email: mail('z'), password: 'clave-larga-123', role: 'owner' })).status, 403);
});

test('aislamiento: otra agencia no crea gente aquí y no se cuelan departamentos ajenos', async () => {
  assert.equal((await stranger('POST', `/w/${slugA}/members`, { name: 'W', email: mail('w'), password: 'clave-larga-123' })).status, 404);
  assert.equal((await stranger('PUT', `/w/${slugA}/members/${anaId}/password`, { password: 'clave-larga-123' })).status, 404);
  const r = await owner('POST', `/w/${slugA}/members`, { name: 'V', email: mail('v'), password: 'clave-larga-123', departments: [{ id: deptB, isLead: false }] });
  assert.equal(r.status, 400);
  assert.equal((await adminPool.query('select 1 from users where email = $1', [mail('v')])).rowCount, 0);   // todo o nada
});
