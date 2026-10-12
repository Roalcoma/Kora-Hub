// Canales de departamento: un canal privado con departamento lo integran siempre su gente + Owners y Admins.
// La membresía se ajusta sola al cambiar departamentos, rol, estado o al aceptar una invitación; nadie entra ni sale a mano.
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
const slugA = `dep-a-${run}`, slugB = `dep-b-${run}`;

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

const owner = client(), ana = client(), beto = client(), outsider = client();
let ownerId = '', anaId = '', betoId = '', depVentas = '', depServicio = '', canal = '';
const members = async () => ((await owner('GET', `/w/${slugA}/channels/${canal}/members`)).body as string[]).sort();
const patchMember = (c: Client, userId: string, body: object) => c('PATCH', `/w/${slugA}/members/${userId}`, body);
const join = async (c: Client, email: string, name: string, departmentIds: string[] = []) => {
  const inv = await owner('POST', `/w/${slugA}/invitations`, { email: null, role: 'member', departmentIds });
  const r = await c('POST', '/invitations/accept', { token: inv.body.url.split('/invite/')[1], newAccount: { name, password, locale: 'es', email } });
  return r.body.user.id as string;
};

before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const reg = (c: Client, email: string, slug: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template: 'insurance_agency' } });
  ownerId = (await reg(owner, `owner-${run}@test.local`, slugA)).body.user.id;
  await reg(outsider, `intruso-${run}@test.local`, slugB);
  const deps = (await owner('GET', `/w/${slugA}`)).body.departments as { id: string; name: string }[];
  depVentas = deps[0]!.id;
  depServicio = deps[1]!.id;
  anaId = await join(ana, `ana-${run}@test.local`, 'Ana Torres');
});

after(async () => {
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB]])).rows.map((r) => r.id);
  for (const t of ['channel_members', 'channels', 'audit_log', 'member_departments', 'invitations', 'departments',
    'business_lines', 'expense_categories', 'workspace_members', 'jobs']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ws]);
  const users = (await adminPool.query('select id from users where email like $1', [`%-${run}@test.local`])).rows.map((r) => r.id);
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

test('crear un canal privado de departamento deja solo a su gente y a los Owners/Admins', async () => {
  await patchMember(owner, anaId, { departments: [{ id: depServicio, isLead: false }] });
  // Ana se pide como miembro, pero no es de Ventas: queda fuera
  const r = await owner('POST', `/w/${slugA}/channels`, { kind: 'private', name: 'ventas-equipo', departmentId: depVentas, memberIds: [anaId] });
  assert.equal(r.status, 201);
  canal = r.body.id;
  assert.deepEqual(await members(), [ownerId]);
});

test('entrar y salir del departamento agrega y saca del canal', async () => {
  assert.equal((await patchMember(owner, anaId, { departments: [{ id: depVentas, isLead: false }] })).status, 200);
  assert.deepEqual(await members(), [ownerId, anaId].sort());
  assert.ok((await ana('GET', `/w/${slugA}/channels`)).body.some((c: any) => c.id === canal));
  await patchMember(owner, anaId, { departments: [] });
  assert.deepEqual(await members(), [ownerId]);
  assert.ok(!(await ana('GET', `/w/${slugA}/channels`)).body.some((c: any) => c.id === canal));
});

test('subir a Admin agrega; volver a Miembro saca', async () => {
  await patchMember(owner, anaId, { role: 'admin' });
  assert.deepEqual(await members(), [ownerId, anaId].sort());
  await patchMember(owner, anaId, { role: 'member' });
  assert.deepEqual(await members(), [ownerId]);
});

test('aceptar una invitación con el departamento agrega; desactivar saca', async () => {
  betoId = await join(beto, `beto-${run}@test.local`, 'Beto Ruiz', [depVentas]);
  assert.deepEqual(await members(), [ownerId, betoId].sort());
  await patchMember(owner, betoId, { isActive: false });
  assert.deepEqual(await members(), [ownerId]);
  await patchMember(owner, betoId, { isActive: true });
  assert.deepEqual(await members(), [ownerId, betoId].sort());
});

test('nadie entra ni sale a mano de un canal de departamento', async () => {
  const add = await owner('POST', `/w/${slugA}/channels/${canal}/members`, { userIds: [anaId] });
  assert.equal(add.body.code, 'department_channel');
  assert.equal((await owner('DELETE', `/w/${slugA}/channels/${canal}/members/${betoId}`)).body.code, 'department_channel');
  assert.equal((await beto('POST', `/w/${slugA}/channels/${canal}/leave`)).body.code, 'department_channel');
  assert.deepEqual(await members(), [ownerId, betoId].sort());
});

test('permiso: un Miembro no puede cambiar departamentos para meterse en el canal', async () => {
  assert.equal((await patchMember(ana, anaId, { departments: [{ id: depVentas, isLead: false }] })).status, 403);
  assert.deepEqual(await members(), [ownerId, betoId].sort());
});

test('aislamiento: otra agencia no ve el canal ni puede tocar sus miembros, y su sincronización no cruza', async () => {
  // Para quien no es de la agencia, la agencia no existe (404)
  assert.equal((await outsider('GET', `/w/${slugA}/channels/${canal}/members`)).status, 404);
  assert.equal((await outsider('PATCH', `/w/${slugA}/members/${anaId}`, { role: 'admin' })).status, 404);
  const depB = (await outsider('GET', `/w/${slugB}`)).body.departments[0].id;
  const r = await outsider('POST', `/w/${slugB}/channels`, { kind: 'private', name: 'ventas-b', departmentId: depB, memberIds: [] });
  const inB = (await adminPool.query('select user_id from channel_members where channel_id = $1', [r.body.id])).rows.map((x) => x.user_id);
  assert.ok(!inB.includes(ownerId) && !inB.includes(anaId) && !inB.includes(betoId));
  assert.deepEqual(await members(), [ownerId, betoId].sort());
});
