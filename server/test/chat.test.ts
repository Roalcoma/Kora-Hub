// Chat completo por HTTP + WebSocket: dos personas de la agencia A conversan en tiempo real;
// una persona de la agencia B no ve ni recibe nada. Incluye permisos, anuncios, búsqueda y archivos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { ServerEvent } from '@agencia-hub/contracts';
import { app } from '../src/index.ts';
import { attachRealtime, closeAll } from '../src/realtime/hub.ts';
import { ensureBucket } from '../src/files/s3.ts';
import { runOnce } from '../src/jobs/worker.ts';
import { adminPool, appPool } from '../src/db.ts';

let server: Server;
let base = '';
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slugA = `chat-a-${run}`, slugB = `chat-b-${run}`;

type Client = ReturnType<typeof client>;
function client() {
  let cookie = '';
  const events: ServerEvent[] = [];
  let socket: WebSocket | null = null;
  const call = async (method: string, path: string, body?: unknown, raw?: { data: string; type: string }) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method, redirect: 'manual',
      headers: { cookie, 'content-type': raw?.type ?? 'application/json' },
      body: raw ? raw.data : body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  return Object.assign(call, {
    events,
    async connect(slug: string) {
      const { body } = await call('POST', `/w/${slug}/ws-ticket`);
      socket = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${body.ticket}`);
      socket.on('message', (d) => events.push(JSON.parse(String(d))));
      await new Promise((ok, fail) => { socket!.once('open', ok); socket!.once('error', fail); });
    },
    send(e: object) { socket!.send(JSON.stringify(e)); },
    /** Espera un evento que cumpla `fn` (o falla a los 2 s) */
    async waitFor(fn: (e: ServerEvent) => boolean, ms = 2000): Promise<ServerEvent> {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const e = events.find(fn);
        if (e) return e;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('Evento no recibido');
    },
  });
}

const owner = client(), ana = client(), outsider = client();
let general = '', anuncios = '', ventas = '', privado = '', anaId = '', ownerId = '';
const post = (c: Client, ch: string, body: string, extra: object = {}) =>
  c('POST', `/w/${slugA}/channels/${ch}/messages`, { clientId: randomUUID(), body, ...extra });

before(async () => {
  server = createServer(app);
  attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await ensureBucket();

  const reg = (c: Client, email: string, slug: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template: 'insurance_agency' } });
  ownerId = (await reg(owner, `owner-${run}@test.local`, slugA)).body.user.id;
  await reg(outsider, `intruso-${run}@test.local`, slugB);
  const inv = await owner('POST', `/w/${slugA}/invitations`, { email: null, role: 'member' });
  const acc = await ana('POST', '/invitations/accept', {
    token: inv.body.url.split('/invite/')[1], newAccount: { name: 'Ana Torres', password, locale: 'es', email: `ana-${run}@test.local` } });
  anaId = acc.body.user.id;

  const chans = (await owner('GET', `/w/${slugA}/channels`)).body;
  general = chans.find((c: any) => c.name === 'general').id;
  anuncios = chans.find((c: any) => c.kind === 'announcement').id;

  await owner.connect(slugA);
  await ana.connect(slugA);
  await outsider.connect(slugB);
});

after(async () => {
  closeAll();
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB]])).rows.map((r) => r.id);
  for (const t of ['announcement_acks', 'message_reactions', 'message_pins', 'message_mentions', 'message_files', 'files']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('update messages set parent_id = null where workspace_id = any($1)', [ws]);
  for (const t of ['messages', 'channel_members', 'channels', 'audit_log', 'member_departments', 'invitations', 'departments',
    'business_lines', 'workspace_members', 'jobs']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ws]);
  const users = (await adminPool.query('select id from users where email like $1', [`%-${run}@test.local`])).rows.map((r) => r.id);
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from ws_tickets where user_id = any($1)', [users]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

test('WebSocket rechaza tickets inválidos o reutilizados', async () => {
  const { body } = await owner('POST', `/w/${slugA}/ws-ticket`);
  const open = (t: string) => new Promise<boolean>((r) => {
    const s = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${t}`);
    s.once('open', () => { s.close(); r(true); });
    s.once('error', () => r(false));
  });
  assert.equal(await open('inventado'), false);
  assert.equal(await open(body.ticket), true);
  assert.equal(await open(body.ticket), false);
});

test('crear canal con una persona: le llega en tiempo real', async () => {
  const r = await owner('POST', `/w/${slugA}/channels`, { kind: 'public', name: 'ventas-vida', memberIds: [anaId] });
  assert.equal(r.status, 201);
  ventas = r.body.id;
  await ana.waitFor((e) => e.type === 'channel.updated' && e.channel.id === ventas);
  assert.equal((await owner('POST', `/w/${slugA}/channels`, { kind: 'public', name: 'Ventas-Vida' })).body.code, 'channel_name_taken');
});

test('mensaje con mención: llega a Ana, no al intruso, y cuenta como no leído', async () => {
  const r = await post(owner, ventas, `Hola <@${anaId}>, revisa la **póliza** Hernández`);
  assert.equal(r.status, 201);
  const e = await ana.waitFor((e) => e.type === 'message.created' && e.message.id === r.body.id);
  assert.deepEqual((e as any).message.mentions, [{ kind: 'user', userId: anaId }]);
  const ch = (await ana('GET', `/w/${slugA}/channels`)).body.find((c: any) => c.id === ventas);
  assert.equal(ch.unreadCount, 1);
  assert.equal(ch.mentionCount, 1);
  await ana('POST', `/w/${slugA}/channels/${ventas}/read`, { lastReadAt: r.body.createdAt });
  assert.equal((await ana('GET', `/w/${slugA}/channels`)).body.find((c: any) => c.id === ventas).unreadCount, 0);
  assert.equal(outsider.events.filter((e) => e.type === 'message.created').length, 0);
});

test('reintentar con el mismo clientId no duplica', async () => {
  const clientId = randomUUID();
  const a = await owner('POST', `/w/${slugA}/channels/${ventas}/messages`, { clientId, body: 'una vez' });
  const b = await owner('POST', `/w/${slugA}/channels/${ventas}/messages`, { clientId, body: 'una vez' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.body.id, b.body.id);
});

test('hilos, reacciones, edición y borrado en tiempo real', async () => {
  const root = (await post(owner, ventas, '¿Quién cubre Medicare mañana?')).body;
  const reply = (await ana(`POST`, `/w/${slugA}/channels/${ventas}/messages`, { clientId: randomUUID(), body: 'Yo', parentId: root.id })).body;
  const upd = await owner.waitFor((e) => e.type === 'message.updated' && e.message.id === root.id);
  assert.equal((upd as any).message.replyCount, 1);
  const replies = (await owner('GET', `/w/${slugA}/messages/${root.id}/replies`)).body;
  assert.deepEqual(replies.items.map((m: any) => m.id), [reply.id]);

  const react = await ana('POST', `/w/${slugA}/messages/${root.id}/reactions`, { emoji: '👍' });
  assert.deepEqual(react.body, [{ emoji: '👍', count: 1, userIds: [anaId] }]);
  await owner.waitFor((e) => e.type === 'reaction.changed' && e.messageId === root.id);
  assert.deepEqual((await ana('POST', `/w/${slugA}/messages/${root.id}/reactions`, { emoji: '👍' })).body, []);

  assert.equal((await ana('PATCH', `/w/${slugA}/messages/${root.id}`, { body: 'hackeado' })).status, 403);
  const edited = await owner('PATCH', `/w/${slugA}/messages/${root.id}`, { body: '¿Quién cubre Medicare el viernes?' });
  assert.ok(edited.body.editedAt);
  assert.equal((await ana('DELETE', `/w/${slugA}/messages/${root.id}`)).status, 403);
  assert.equal((await ana('DELETE', `/w/${slugA}/messages/${reply.id}`)).status, 204);
  await owner.waitFor((e) => e.type === 'message.deleted' && e.messageId === reply.id);
});

test('paginación por cursor sin huecos ni repetidos', async () => {
  const ch = (await owner('POST', `/w/${slugA}/channels`, { kind: 'public', name: `pag-${run}` })).body.id;
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push((await post(owner, ch, `m${i}`)).body.id);
  const p1 = (await owner('GET', `/w/${slugA}/channels/${ch}/messages?limit=3`)).body;
  const p2 = (await owner('GET', `/w/${slugA}/channels/${ch}/messages?limit=3&before=${p1.nextCursor}`)).body;
  const p3 = (await owner('GET', `/w/${slugA}/channels/${ch}/messages?limit=3&before=${p2.nextCursor}`)).body;
  assert.deepEqual([...p3.items, ...p2.items, ...p1.items].map((m: any) => m.id), ids);
  assert.equal(p3.nextCursor, null);
  const around = (await owner('GET', `/w/${slugA}/channels/${ch}/messages?limit=4&around=${ids[3]}`)).body;
  assert.ok(around.items.some((m: any) => m.id === ids[3]));
});

test('canal privado: quien no es miembro no lo ve ni lo encuentra', async () => {
  privado = (await owner('POST', `/w/${slugA}/channels`, { kind: 'private', name: 'gerencia' })).body.id;
  await post(owner, privado, 'Comisiones confidenciales de octubre');
  assert.equal((await ana('GET', `/w/${slugA}/channels/${privado}/messages`)).status, 404);
  assert.equal((await ana('POST', `/w/${slugA}/channels/${privado}/join`)).status, 404);
  assert.ok(!(await ana('GET', `/w/${slugA}/channels`)).body.some((c: any) => c.id === privado));
  assert.equal((await ana('GET', `/w/${slugA}/search?q=confidenciales`)).body.length, 0);
  assert.equal((await owner('GET', `/w/${slugA}/search?q=confidenciales`)).body.length, 1);
});

test('aislamiento: el intruso no puede tocar nada de la agencia A', async () => {
  assert.equal((await outsider('GET', `/w/${slugA}/channels`)).status, 404);
  // Desde su propio workspace, con ids de A
  assert.equal((await outsider('GET', `/w/${slugB}/channels/${ventas}/messages`)).status, 404);
  assert.equal((await outsider('POST', `/w/${slugB}/channels/${ventas}/messages`, { clientId: randomUUID(), body: 'x' })).status, 404);
  assert.equal((await outsider('POST', `/w/${slugB}/dms`, { userIds: [anaId] })).status, 400);
  assert.equal((await outsider('GET', `/w/${slugB}/search?q=poliza`)).body.length, 0);
  outsider.send({ type: 'typing', channelId: ventas });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!ana.events.some((e) => e.type === 'typing' && e.userId !== ownerId));
  assert.ok(!outsider.events.some((e) => ['message.created', 'reaction.changed', 'typing'].includes(e.type)));
});

test('"escribiendo…" llega a los miembros del canal', async () => {
  owner.send({ type: 'typing', channelId: ventas });
  const e = await ana.waitFor((e) => e.type === 'typing' && e.channelId === ventas);
  assert.equal((e as any).userId, ownerId);
});

test('anuncios: solo Owner/Admin/Líder publican; confirmación de lectura', async () => {
  assert.equal((await post(ana, anuncios, 'yo también')).body.code, 'forbidden');
  const a = (await post(owner, anuncios, 'AEP empieza el 15 de octubre', { ackRequired: true, pinUntil: '2030-01-01T00:00:00Z' })).body;
  assert.equal(a.ackRequired, true);
  assert.equal(a.pinned, true);
  assert.equal((await ana('POST', `/w/${slugA}/messages/${a.id}/ack`)).status, 204);
  await owner.waitFor((e) => e.type === 'announcement.acked' && e.messageId === a.id);
  const acks = (await owner('GET', `/w/${slugA}/messages/${a.id}/acks`)).body;
  assert.deepEqual(acks.acked.map((x: any) => x.userId), [anaId]);
  assert.equal((await ana('GET', `/w/${slugA}/messages/${a.id}/acks`)).status, 403);
  assert.equal((await post(owner, general, 'x', { ackRequired: true })).body.code, 'invalid_option');
});

test('mensajes directos: abrir dos veces devuelve el mismo canal', async () => {
  const a = await owner('POST', `/w/${slugA}/dms`, { userIds: [anaId] });
  const b = await ana('POST', `/w/${slugA}/dms`, { userIds: [ownerId] });
  assert.equal(a.body.id, b.body.id);
  assert.equal(a.body.kind, 'dm');
});

test('búsqueda sin acentos y menciones', async () => {
  const r = (await ana('GET', `/w/${slugA}/search?q=poliza`)).body;
  assert.ok(r.some((x: any) => x.type === 'message' && x.highlight.includes('«')));
  const mentions = (await ana('GET', `/w/${slugA}/mentions`)).body;
  assert.ok(mentions.items.length >= 1);
});

test('archivos: suben por la API, se adjuntan y solo los ve quien puede leer el canal', async () => {
  const data = 'Reporte semanal: 11 pólizas';
  const size = Buffer.byteLength(data);
  const up = (await owner('POST', `/w/${slugA}/files`, { name: 'reporte.txt', mime: 'text/plain', size, context: 'message' })).body;
  assert.equal((await owner('PUT', up.uploadUrl.replace('/api/v1', ''), undefined, { data, type: 'text/plain' })).status, 204);
  const ref = (await owner('POST', `/w/${slugA}/files/${up.fileId}/complete`)).body;
  const msg = (await post(owner, ventas, '', { fileIds: [ref.id] })).body;
  assert.equal(msg.files[0].name, 'reporte.txt');
  assert.equal((await ana('GET', ref.url.replace('/api/v1', ''))).body, data);
  assert.equal((await outsider('GET', `/w/${slugB}/files/${ref.id}`)).status, 404);
  // Reusar el archivo en otro mensaje no se permite
  assert.equal((await post(owner, ventas, 'otra vez', { fileIds: [ref.id] })).body.code, 'invalid_files');

  const big = await owner('POST', `/w/${slugA}/files`, { name: 'video.pdf', mime: 'application/pdf', size: 30 * 1024 * 1024, context: 'message' });
  assert.equal(big.body.code, 'file_too_large');
  // Archivo de un canal privado: Ana no lo descarga
  const up2 = (await owner('POST', `/w/${slugA}/files`, { name: 'secreto.txt', mime: 'text/plain', size: 4, context: 'message' })).body;
  await owner('PUT', up2.uploadUrl.replace('/api/v1', ''), undefined, { data: 'abcd', type: 'text/plain' });
  await owner('POST', `/w/${slugA}/files/${up2.fileId}/complete`);
  await post(owner, privado, 'adjunto', { fileIds: [up2.fileId] });
  assert.equal((await ana('GET', `/w/${slugA}/files/${up2.fileId}`)).status, 404);
});

test('el worker procesa las notificaciones encoladas', async () => {
  while (await runOnce());
  const pending = await adminPool.query(
    "select count(*)::int as n from jobs j join workspaces w on w.id = j.workspace_id where w.slug = $1 and j.done_at is null", [slugA]);
  assert.equal(pending.rows[0].n, 0);
});
