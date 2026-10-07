// Manuales, tareas y metas por HTTP: permisos por departamento (Admin / Líder / Miembro), histórico de reportes
// y aislamiento: la agencia B no ve ni toca nada de la A aunque conozca los ids.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';
import { sanitizeDoc } from '../src/docs/content.ts';
import { CURRENT_WEEK } from '../src/goals/routes.ts';

let server: Server;
let base = '';
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slugA = `mod-a-${run}`, slugB = `mod-b-${run}`;

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}
type Client = ReturnType<typeof client>;

const owner = client(), lead = client(), seller = client(), other = client(), outsider = client();
let ventas = '', servicio = '', salud = '', leadId = '', sellerId = '', otherId = '';
const A = (p: string) => `/w/${slugA}${p}`;
let week = '', lastWeek = '', oldWeek = '';

before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const reg = (c: Client, email: string, slug: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template: 'insurance_agency' } });
  await reg(owner, `owner-${run}@test.local`, slugA);
  await reg(outsider, `intruso-${run}@test.local`, slugB);
  const join = async (c: Client, name: string) => {
    const inv = await owner('POST', A('/invitations'), { email: null, role: 'member' });
    const acc = await c('POST', '/invitations/accept', {
      token: inv.body.url.split('/invite/')[1], newAccount: { name, password, locale: 'es', email: `${name.toLowerCase()}-${run}@test.local` } });
    return acc.body.user.id as string;
  };
  leadId = await join(lead, 'Lucia');
  sellerId = await join(seller, 'Vero');
  otherId = await join(other, 'Omar');

  const ws = (await owner('GET', A(''))).body;
  ventas = ws.departments.find((d: any) => d.name === 'Ventas').id;
  servicio = ws.departments.find((d: any) => d.name === 'Servicio al cliente').id;
  salud = ws.lines.find((l: any) => l.name === 'Salud').id;
  // Lucía lidera Ventas; Vero es vendedora en Ventas; Omar está en Servicio al cliente
  await owner('PATCH', A(`/members/${leadId}`), { role: 'lead', departments: [{ id: ventas, isLead: true }] });
  await owner('PATCH', A(`/members/${sellerId}`), { departments: [{ id: ventas, isLead: false }] });
  await owner('PATCH', A(`/members/${otherId}`), { departments: [{ id: servicio, isLead: false }] });

  const w = (await adminPool.query(
    `select to_char(${CURRENT_WEEK}, 'YYYY-MM-DD') a, to_char(${CURRENT_WEEK} - 7, 'YYYY-MM-DD') b, to_char(${CURRENT_WEEK} - 21, 'YYYY-MM-DD') c`)).rows[0];
  [week, lastWeek, oldWeek] = [w.a, w.b, w.c];
});

after(async () => {
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB]])).rows.map((r) => r.id);
  for (const t of ['weekly_report_items', 'weekly_reports', 'goals', 'task_checklist_items', 'task_comments', 'task_assignees', 'tasks',
    'document_files', 'document_versions']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('update documents set parent_id = null where workspace_id = any($1)', [ws]);
  for (const t of ['documents', 'messages', 'channel_members', 'channels', 'audit_log', 'member_departments', 'member_lines', 'invitations',
    'departments', 'business_lines', 'workspace_members', 'jobs']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ws]);
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ws]);
  const users = (await adminPool.query('select id from users where email like $1', [`%-${run}@test.local`])).rows.map((r) => r.id);
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

// ═══ Manuales ═══

test('sanitizeDoc quita imágenes externas y enlaces peligrosos, y extrae el texto', () => {
  const { content, text } = sanitizeDoc({ type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'Ver ', marks: [] },
      { type: 'text', text: 'aquí', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'bold' }] },
      { type: 'text', text: ' y web', marks: [{ type: 'link', attrs: { href: 'https://cms.gov' } }] }] },
    { type: 'image', attrs: { src: 'https://rastreo.example/p.gif' } },
    { type: 'image', attrs: { src: '/api/v1/w/x/files/1' } },
    { type: 'heading', content: [{ type: 'text', text: 'Medicare' }] },
  ] }, '/api/v1/w/x/files/');
  const c = content as any;
  assert.deepEqual(c.content[0].content[1].marks, [{ type: 'bold' }]);
  assert.equal(c.content[0].content[2].marks[0].attrs.href, 'https://cms.gov');
  assert.equal(c.content.length, 3);
  assert.equal(text, 'Ver aquí y web\nMedicare');
  assert.throws(() => sanitizeDoc({ type: 'paragraph' }, '/'));
  assert.throws(() => sanitizeDoc({ type: 'doc', content: ['texto suelto'] }, '/'));
});

let manual = '', sub = '';
test('manuales: el Líder crea en su depto, la vendedora solo lee, versiones y restaurar', async () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pasos para cotizar una póliza de Vida' }] }] };
  const r = await lead('POST', A('/documents'), { departmentId: ventas, title: 'Cotización Vida', content: doc, lineId: null });
  assert.equal(r.status, 201);
  assert.equal(r.body.canEdit, true);
  manual = r.body.id;
  sub = (await lead('POST', A('/documents'), { departmentId: ventas, parentId: manual, title: 'Anexos' })).body.id;

  assert.equal((await lead('POST', A('/documents'), { departmentId: servicio, title: 'Ajeno' })).status, 403);
  assert.equal((await seller('POST', A('/documents'), { departmentId: ventas, title: 'Mío' })).status, 403);
  const read = await seller('GET', A(`/documents/${manual}`));
  assert.equal(read.status, 200);
  assert.equal(read.body.canEdit, false);
  assert.equal((await seller('PATCH', A(`/documents/${manual}`), { title: 'Cambiado' })).status, 403);

  // Una página no puede colgar de su propia subpágina
  assert.equal((await lead('PATCH', A(`/documents/${manual}`), { parentId: sub })).body.code, 'invalid_parent');

  // Ediciones seguidas de la misma persona se juntan; la de otra persona crea versión nueva
  await lead('PATCH', A(`/documents/${manual}`), { title: 'Cotización Vida v2' });
  await lead('PATCH', A(`/documents/${manual}`), { title: 'Cotización Vida v3' });
  await owner('PATCH', A(`/documents/${manual}`), { title: 'Cotización de pólizas Vida' });
  const versions = (await seller('GET', A(`/documents/${manual}/versions`))).body;
  assert.deepEqual(versions.map((v: any) => v.title), ['Cotización de pólizas Vida', 'Cotización Vida v3']);
  const old = (await seller('GET', A(`/documents/${manual}/versions/${versions[1].id}`))).body;
  assert.equal(old.content.content[0].content[0].text, 'Pasos para cotizar una póliza de Vida');

  assert.equal((await seller('POST', A(`/documents/${manual}/versions/${versions[1].id}/restore`))).status, 403);
  const restored = await lead('POST', A(`/documents/${manual}/versions/${versions[1].id}/restore`));
  assert.equal(restored.body.title, 'Cotización Vida v3');
  assert.equal((await lead('GET', A(`/documents/${manual}/versions`))).body.length, 3);
});

test('manuales: búsqueda sin acentos con fragmento marcado; archivar oculta las subpáginas', async () => {
  const hits = (await seller('GET', A('/documents?q=poliza'))).body;
  assert.equal(hits[0].id, manual);
  assert.match(hits[0].snippet, /«póliza»/);
  assert.equal((await lead('PATCH', A(`/documents/${manual}`), { archived: true })).status, 200);
  const tree = (await seller('GET', A('/documents'))).body.map((d: any) => d.id);
  assert.ok(!tree.includes(manual) && !tree.includes(sub));
  assert.equal((await seller('GET', A(`/documents/${sub}`))).status, 404);
});

// ═══ Tareas ═══

let task = '';
test('tareas: crear en mi depto con responsables avisa; fuera de mi depto no', async () => {
  const r = await seller('POST', A('/tasks'), {
    departmentId: ventas, title: 'Llamar a la Sra. Pérez', assigneeIds: [leadId, sellerId], checklist: ['Revisar póliza', 'Enviar cotización'],
    dueAt: new Date(Date.now() + 3 * 86400_000).toISOString(), priority: 'high', lineId: salud });
  assert.equal(r.status, 201);
  task = r.body.id;
  assert.deepEqual(r.body.assigneeIds.sort(), [leadId, sellerId].sort());
  assert.equal(r.body.checklist.length, 2);
  assert.equal((await seller('POST', A('/tasks'), { departmentId: servicio, title: 'Ajena' })).status, 403);

  const jobs = (await adminPool.query("select kind, payload, run_at from jobs where payload->>'taskId' = $1 order by run_at", [task])).rows;
  // Aviso de asignación solo a Lucía (quien crea no se avisa a sí misma) + recordatorio 24 h antes
  assert.deepEqual(jobs[0].payload.userIds, [leadId]);
  assert.equal(jobs[1].payload.event, 'due');
});

test('tareas: el responsable cambia estado y checklist, pero no el título; los demás miran', async () => {
  const lucia = await lead('PATCH', A(`/tasks/${task}`), { status: 'doing' });
  assert.equal(lucia.body.status, 'doing');
  assert.equal((await other('PATCH', A(`/tasks/${task}`), { status: 'done' })).status, 403);
  assert.equal((await other('GET', A(`/tasks/${task}`))).status, 200);   // todo el workspace la ve
  assert.equal((await seller('PATCH', A(`/tasks/${task}`), { title: 'Otro título' })).status, 200); // la creó ella

  const item = (await lead('GET', A(`/tasks/${task}`))).body.checklist[0];
  assert.equal((await lead('PATCH', A(`/tasks/${task}/checklist/${item.id}`), { done: true })).body.done, true);
  assert.equal((await other('POST', A(`/tasks/${task}/checklist`), { text: 'Intruso' })).status, 403);

  const done = await lead('PATCH', A(`/tasks/${task}`), { status: 'done' });
  assert.ok(done.body.completedAt);
  const mine = (await lead('GET', A('/tasks?mine=true'))).body.map((t: any) => t.id);
  assert.ok(mine.includes(task));
  assert.ok(!(await other('GET', A('/tasks?mine=true'))).body.length);
  assert.ok((await other('GET', A('/tasks?mine=false'))).body.length);
});

test('tareas: comentar avisa a responsables y a quien la creó; borrar solo quien gestiona', async () => {
  const c = await other('POST', A(`/tasks/${task}/comments`), { body: 'La clienta pidió que la llamen mañana' });
  assert.equal(c.status, 201);
  const job = (await adminPool.query("select payload from jobs where payload->>'taskId' = $1 and payload->>'event' = 'comment'", [task])).rows[0];
  assert.deepEqual(job.payload.userIds.sort(), [leadId, sellerId].sort());
  assert.equal((await lead('GET', A(`/tasks/${task}`))).body.comments.length, 1);
  assert.equal((await other('DELETE', A(`/tasks/${task}`))).status, 403);
});

test('tareas: crear desde un mensaje que puedo leer', async () => {
  const general = (await seller('GET', A('/channels'))).body.find((c: any) => c.name === 'general').id;
  const msg = (await seller('POST', A(`/channels/${general}/messages`), { clientId: randomUUID(), body: 'Renovar Medicare de Juan' })).body;
  const t = await seller('POST', A('/tasks'), { departmentId: ventas, title: 'Renovar Medicare de Juan', sourceMessageId: msg.id });
  assert.equal(t.body.sourceChannelId, general);
  assert.equal((await seller('POST', A('/tasks'), { departmentId: ventas, title: 'x', sourceMessageId: randomUUID() })).status, 404);
});

// ═══ Metas y reportes ═══

let goal = '';
test('metas: solo Admin define; el Líder reporta y el objetivo queda copiado', async () => {
  assert.equal((await lead('POST', A('/goals'), { departmentId: ventas, name: 'Pólizas Vida', unit: 'pólizas', weeklyTarget: 15 })).status, 403);
  const g = await owner('POST', A('/goals'), { departmentId: ventas, name: 'Pólizas Vida', unit: 'pólizas', weeklyTarget: 15 });
  assert.equal(g.status, 201);
  goal = g.body.id;

  assert.equal((await seller('PUT', A('/reports'), { departmentId: ventas, weekStart: week, items: [{ goalId: goal, actual: 3 }] })).status, 403);
  const r = await lead('PUT', A('/reports'), { departmentId: ventas, weekStart: lastWeek, notes: 'Buena semana', items: [{ goalId: goal, actual: 12 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items[0], { goalId: goal, target: 15, actual: 12, note: null });

  // Cambiar la meta no mueve el histórico
  await owner('PATCH', A(`/goals/${goal}`), { weeklyTarget: 20 });
  const again = await lead('PUT', A('/reports'), { departmentId: ventas, weekStart: lastWeek, items: [{ goalId: goal, actual: 13 }] });
  assert.equal(again.body.items[0].target, 15);
  assert.equal(again.body.items[0].actual, 13);
});

test('reportes: semanas viejas solo Admin (con auditoría), futuras nunca, lunes obligatorio', async () => {
  const old = { departmentId: ventas, weekStart: oldWeek, items: [{ goalId: goal, actual: 9 }] };
  assert.equal((await lead('PUT', A('/reports'), old)).body.code, 'report_locked');
  assert.equal((await owner('PUT', A('/reports'), old)).status, 200);
  assert.equal((await owner('PUT', A('/reports'), { ...old, items: [{ goalId: goal, actual: 10 }] })).status, 200);
  const logged = await adminPool.query("select 1 from audit_log where action = 'report.edited' and meta->>'weekStart' = $1", [oldWeek]);
  assert.equal(logged.rowCount, 1);

  const next = new Date(Date.parse(week) + 7 * 86400_000).toISOString().slice(0, 10);
  assert.equal((await owner('PUT', A('/reports'), { ...old, weekStart: next })).body.code, 'future_week');
  const tuesday = new Date(Date.parse(week) + 86400_000).toISOString().slice(0, 10);
  assert.equal((await owner('PUT', A('/reports'), { ...old, weekStart: tuesday })).status, 400);
  // Meta de otro departamento
  assert.equal((await owner('PUT', A('/reports'), { departmentId: servicio, weekStart: week, items: [{ goalId: goal, actual: 1 }] })).body.code, 'invalid_goal');
});

test('tablero: serie por semana, reportes faltantes y CSV a prueba de fórmulas', async () => {
  const d = (await seller('GET', A(`/goals/dashboard?weeks=4&departmentId=${ventas}`))).body;
  assert.equal(d.weeks.length, 4);
  assert.equal(d.weeks.at(-1), week);
  const s = d.rows.find((r: any) => r.goalId === goal).series;
  assert.deepEqual(s.at(-2), { weekStart: lastWeek, target: 15, actual: 13 });
  assert.deepEqual(s.at(-1), { weekStart: week, target: 20, actual: null });
  assert.ok(d.missingReports.some((m: any) => m.weekStart === week && m.departmentId === ventas));

  await owner('PATCH', A(`/goals/${goal}`), { name: '=HYPERLINK("http://x")' });
  const csv = await seller('GET', A('/goals/dashboard.csv?weeks=2'));
  assert.match(csv.headers.get('content-type')!, /text\/csv/);
  assert.match(csv.body, /"'=HYPERLINK\(""http:\/\/x""\)"/);
});

// ═══ Aislamiento ═══

test('aislamiento: la agencia B no ve ni toca manuales, tareas ni metas de la A', async () => {
  const B = (p: string) => `/w/${slugB}${p}`;
  assert.equal((await outsider('GET', A('/tasks'))).status, 404);   // no es miembro de A
  assert.equal((await outsider('GET', B(`/tasks/${task}`))).status, 404);
  assert.equal((await outsider('PATCH', B(`/tasks/${task}`), { title: 'hackeado' })).status, 404);
  assert.equal((await outsider('GET', B(`/documents/${sub}`))).status, 404);
  assert.equal((await outsider('GET', B('/documents?q=poliza'))).body.length, 0);
  assert.equal((await outsider('PATCH', B(`/goals/${goal}`), { weeklyTarget: 1 })).status, 404);
  assert.equal((await outsider('GET', B('/reports'))).body.length, 0);
  assert.equal((await outsider('GET', B('/tasks'))).body.length, 0);
  // Con un depto de A en el cuerpo: la FK compuesta lo rechaza
  assert.equal((await outsider('POST', B('/goals'), { departmentId: ventas, name: 'x', unit: 'x', weeklyTarget: 1 })).status, 400);
  assert.equal((await outsider('POST', B('/tasks'), { departmentId: ventas, title: 'x' })).status, 400);
});
