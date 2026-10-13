// Ficha de cada persona (Admin/Owner): permiso por módulo (Sin acceso / Ver / Editar / Gestionar), nombre y email,
// enlace de recuperación y cerrar sesiones. Caso feliz, permiso denegado y aislamiento entre agencias.
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
const slugA = `adm-a-${run}`, slugB = `adm-b-${run}`, slugC = `adm-c-${run}`;
const mail = (n: string) => `${n}-${run}@test.local`;

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
const A = (p: string) => `/w/${slugA}${p}`;

const owner = client(), ana = client(), outsider = client();
let anaId = '', ownerId = '', outsiderId = '', ventas = '', servicio = '';
const patch = (c: Client, id: string, body: object) => c('PATCH', A(`/members/${id}`), body);

before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const reg = (c: Client, email: string, slug: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template: 'insurance_agency' } });
  ownerId = (await reg(owner, mail('owner'), slugA)).body.user.id;
  outsiderId = (await reg(outsider, mail('intruso'), slugB)).body.user.id;
  await owner('PATCH', A(''), { settings: { financeModule: true } });
  const ws = (await owner('GET', A(''))).body;
  ventas = ws.departments[0].id;
  servicio = ws.departments[1].id;
  anaId = (await owner('POST', A('/members'), { name: 'Ana Torres', email: mail('ana'), password, departments: [{ id: ventas, isLead: false }] })).body.userId;
  await ana('POST', '/auth/login', { email: mail('ana'), password });
});

after(async () => {
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB, slugC]])).rows.map((r) => r.id);
  await adminPool.query('update carriers set default_product_id = null where workspace_id = any($1)', [ws]);
  const tables = (await adminPool.query(
    `select table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
     where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE' and table_name <> 'workspaces'`,
  )).rows.map((r) => r.table_name as string);
  let pending = tables;
  for (let pass = 0; pass < 10 && pending.length; pass++) {
    const failed: string[] = [];
    for (const t of pending) {
      try { await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]); } catch { failed.push(t); }
    }
    pending = failed;
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ws]);
  const users = (await adminPool.query('select id from users where email like $1', [`%-${run}@test.local`])).rows.map((r) => r.id);
  for (const t of ['audit_log']) await adminPool.query(`delete from ${t} where actor_user_id = any($1)`, [users]);
  await adminPool.query('delete from password_resets where user_id = any($1)', [users]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

const newDoc = (c: Client, departmentId: string) => c('POST', A('/documents'), { departmentId, lineId: null, parentId: null, title: `Doc ${randomUUID().slice(0, 4)}` });

test('por defecto un Miembro tiene lo de siempre: Manuales ver, Tareas editar, Finanzas sin acceso', async () => {
  const me = (await ana('GET', A(''))).body.me;
  assert.deepEqual(me.modules, { manuals: 'view', tasks: 'edit', goals: 'view', sales: 'view', finance: 'none' });
  assert.deepEqual(me.moduleOverrides, {});
  assert.equal((await ana('GET', A('/documents'))).status, 200);
  assert.equal((await newDoc(ana, ventas)).status, 403);
  assert.equal((await ana('GET', A('/finance/summary'))).status, 404);
  assert.equal((await ana('POST', A('/tasks'), { departmentId: ventas, title: 'Llamar' })).status, 201);
});

test('Manuales: «Editar» crea en sus departamentos; «Gestionar», en cualquiera', async () => {
  await patch(owner, anaId, { modules: { manuals: 'edit' } });
  assert.equal((await newDoc(ana, ventas)).status, 201);
  assert.equal((await newDoc(ana, servicio)).status, 403);
  await patch(owner, anaId, { modules: { manuals: 'manage' } });
  assert.equal((await newDoc(ana, servicio)).status, 201);
});

test('Finanzas: «Ver» solo lee, «Editar» escribe; Tareas en «Sin acceso» desaparece; null vuelve al rol', async () => {
  await patch(owner, anaId, { modules: { finance: 'view', tasks: 'none' } });
  assert.equal((await ana('GET', A('/finance/summary'))).status, 200);
  assert.equal((await ana('POST', A('/finance/expenses'), {})).status, 403);
  assert.equal((await ana('GET', A('/tasks'))).status, 404);
  await patch(owner, anaId, { modules: { finance: 'edit' } });
  assert.notEqual((await ana('POST', A('/finance/expenses'), {})).status, 403);   // pasa el permiso (falla la validación)
  const r = await patch(owner, anaId, { modules: { finance: null, tasks: null, manuals: null } });
  assert.deepEqual(r.body.moduleOverrides, {});
  assert.equal(r.body.modules.finance, 'none');
  assert.equal((await ana('GET', A('/tasks'))).status, 200);
});

test('nombre y email de la cuenta; enlace de recuperación; cerrar sesiones', async () => {
  const r = await patch(owner, anaId, { name: 'Ana María Torres', email: mail('ana2') });
  assert.deepEqual([r.body.name, r.body.email], ['Ana María Torres', mail('ana2')]);
  assert.equal((await patch(owner, anaId, { email: mail('owner') })).body.code, 'email_taken');
  // Enlace de recuperación: la persona elige su clave con él
  const link = await owner('POST', A(`/members/${anaId}/recovery-link`));
  assert.equal(link.status, 201);
  const token = link.body.url.split('/reset/')[1];
  assert.equal((await client()('POST', '/auth/reset-password', { token, password: 'nueva-clave-789' })).status, 204);
  const again = client();
  assert.equal((await again('POST', '/auth/login', { email: mail('ana2'), password: 'nueva-clave-789' })).status, 200);
  // Cerrar sesiones: la sesión abierta deja de servir
  assert.equal((await again('GET', A(''))).status, 200);
  assert.equal((await owner('POST', A(`/members/${anaId}/logout-all`))).status, 204);
  assert.equal((await again('GET', A(''))).status, 401);
});

test('permiso: un Miembro no edita a nadie; un Admin no toca a un Owner ni cuentas de otra agencia', async () => {
  const ana2 = client();
  await ana2('POST', '/auth/login', { email: mail('ana2'), password: 'nueva-clave-789' });
  assert.equal((await patch(ana2, anaId, { modules: { finance: 'manage' } })).status, 403);
  assert.equal((await ana2('POST', A(`/members/${ownerId}/recovery-link`))).status, 403);
  // Ana pasa a Admin: no puede con el Owner
  await patch(owner, anaId, { role: 'admin' });
  assert.equal((await patch(ana2, ownerId, { name: 'Otro' })).status, 403);
  assert.equal((await ana2('POST', A(`/members/${ownerId}/logout-all`))).status, 403);
  // Cuenta compartida con otra agencia: ni nombre, ni email, ni enlace de recuperación
  await owner('POST', A('/members'), { name: 'x', email: mail('intruso'), password: 'no-se-usa-123' });
  assert.equal((await patch(owner, outsiderId, { name: 'Robada' })).body.code, 'shared_account');
  assert.equal((await owner('POST', A(`/members/${outsiderId}/recovery-link`))).body.code, 'shared_account');
  const list = (await owner('GET', A('/members'))).body;
  assert.equal(list.find((m: any) => m.userId === outsiderId).sharedAccount, true);
  assert.equal(list.find((m: any) => m.userId === anaId).sharedAccount, false);
  // Los Miembros no ven ese dato
  await patch(owner, anaId, { role: 'member' });
  assert.equal((await ana2('GET', A('/members'))).body[0].sharedAccount, undefined);
});

test('aislamiento: otra agencia no edita, no genera enlaces ni cierra sesiones aquí', async () => {
  const stranger = client();
  await stranger('POST', '/auth/register', { name: 'z', email: mail('ajeno'), password, locale: 'es',
    workspace: { name: slugC, slug: slugC, template: 'blank' } });
  assert.equal((await stranger('PATCH', A(`/members/${anaId}`), { modules: { finance: 'manage' } })).status, 404);
  assert.equal((await stranger('POST', A(`/members/${anaId}/recovery-link`))).status, 404);
  assert.equal((await stranger('POST', A(`/members/${anaId}/logout-all`))).status, 404);
});
