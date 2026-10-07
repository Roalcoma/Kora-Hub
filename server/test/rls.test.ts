// Aislamiento multi-tenant a nivel de base de datos: dos workspaces, y el usuario de A intenta tocar B.
// Si la app olvida un filtro, estas barreras (RLS + FK compuestas + grants) deben sostenerse solas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withWorkspace, withAdmin, appPool, adminPool } from '../src/db.ts';

type Seed = { ws: string; user: string; dept: string; channel: string; message: string };
let A: Seed, B: Seed;

async function seed(label: string): Promise<Seed> {
  return withAdmin(async (db) => {
    const suffix = randomUUID().slice(0, 8);
    const q = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0].id as string;
    const user = await q('insert into users (email, name) values ($1, $2) returning id', [`${label}-${suffix}@test.local`, label]);
    const ws = await q('insert into workspaces (slug, name) values ($1, $2) returning id', [`${label}-${suffix}`, label]);
    await db.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, user]);
    const dept = await q('insert into departments (workspace_id, name) values ($1, $2) returning id', [ws, 'Ventas']);
    const channel = await q("insert into channels (workspace_id, kind, name) values ($1, 'public', 'general') returning id", [ws]);
    await db.query('insert into channel_members (workspace_id, channel_id, user_id) values ($1, $2, $3)', [ws, channel, user]);
    const message = await q('insert into messages (workspace_id, channel_id, user_id, body) values ($1, $2, $3, $4) returning id',
      [ws, channel, user, `Póliza de ${label}`]);
    return { ws, user, dept, channel, message };
  });
}

const asA = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) => withWorkspace({ workspaceId: A.ws, userId: A.user }, fn);

before(async () => {
  A = await seed('agencia-a');
  B = await seed('agencia-b');
});

after(async () => {
  await withAdmin(async (db) => {
    for (const t of ['messages', 'channel_members', 'channels', 'departments', 'workspace_members']) {
      await db.query(`delete from ${t} where workspace_id = any($1)`, [[A.ws, B.ws]]);
    }
    await db.query('delete from workspaces where id = any($1)', [[A.ws, B.ws]]);
    await db.query('delete from users where id = any($1)', [[A.user, B.user]]);
  });
  await appPool.end();
  await adminPool.end();
});

test('solo se leen filas del workspace activo', async () => {
  const rows = await asA(async (db) => (await db.query('select workspace_id from channels')).rows);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.workspace_id === A.ws));
});

test('pedir un id de otro workspace devuelve vacío', async () => {
  const { rowCount } = await asA((db) => db.query('select 1 from messages where id = $1', [B.message]));
  assert.equal(rowCount, 0);
});

test('sin contexto no se ve nada', async () => {
  const { rowCount } = await withWorkspace({ workspaceId: null, userId: null }, (db) => db.query('select 1 from channels'));
  assert.equal(rowCount, 0);
});

test('no se puede insertar con workspace_id ajeno', async () => {
  await assert.rejects(
    asA((db) => db.query("insert into channels (workspace_id, kind, name) values ($1, 'public', 'intruso')", [B.ws])),
    /row-level security/,
  );
});

test('no se puede actualizar ni borrar datos ajenos', async () => {
  const upd = await asA((db) => db.query("update messages set body = 'x' where id = $1", [B.message]));
  const del = await asA((db) => db.query('delete from channel_members where channel_id = $1', [B.channel]));
  assert.equal(upd.rowCount, 0);
  assert.equal(del.rowCount, 0);
});

test('FK compuesta impide referenciar un canal de otro workspace', async () => {
  await assert.rejects(
    asA((db) => db.query('insert into messages (workspace_id, channel_id, user_id, body) values ($1, $2, $3, $4)',
      [A.ws, B.channel, A.user, 'mensaje cruzado'])),
    /foreign key/,
  );
});

test('FK compuesta impide asignar un usuario que no es miembro del workspace', async () => {
  await assert.rejects(
    asA((db) => db.query('insert into channel_members (workspace_id, channel_id, user_id) values ($1, $2, $3)',
      [A.ws, A.channel, B.user])),
    /foreign key/,
  );
});

test('usuarios y workspaces: solo los compartidos', async () => {
  const users = await asA(async (db) => (await db.query('select id from users')).rows.map((r) => r.id));
  const wss = await asA(async (db) => (await db.query('select id from workspaces')).rows.map((r) => r.id));
  assert.ok(users.includes(A.user) && !users.includes(B.user));
  assert.ok(wss.includes(A.ws) && !wss.includes(B.ws));
});

test('el rol de la app no lee secretos ni toca facturación ni la cola', async () => {
  await assert.rejects(asA((db) => db.query('select password_hash from users')), /permission denied/);
  await assert.rejects(asA((db) => db.query("update workspaces set plan = 'pro'")), /permission denied/);
  await assert.rejects(asA((db) => db.query('select * from jobs')), /permission denied/);
});

test('la búsqueda ignora acentos', async () => {
  const { rowCount } = await asA((db) =>
    db.query("select 1 from messages where body_tsv @@ to_tsquery('simple', immutable_unaccent('poliza'))"));
  assert.equal(rowCount, 1);
});
