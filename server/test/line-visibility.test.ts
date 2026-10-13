// Visibilidad por departamento y línea en tareas, metas y canales privados de departamento.
// Regla: Owner/Admin todo; Líder todo su departamento; Miembro lo de sus departamentos, solo de sus líneas
// (sin líneas asignadas, todas). En tareas también lo que creó o le asignaron. Manuales no se restringen.
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
const slugA = `lin-a-${run}`, slugB = `lin-b-${run}`;

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

// ana: Ventas · Vida · beto: Ventas sin líneas · carla: Líder de Ventas con Salud · dani: Servicio
const owner = client(), ana = client(), beto = client(), carla = client(), dani = client(), outsider = client();
const id: Record<string, string> = {};
const task: Record<string, string> = {};
const goal: Record<string, string> = {};

const join = async (inviter: Client, slug: string, c: Client, email: string, name: string) => {
  const inv = await inviter('POST', `/w/${slug}/invitations`, { email: null, role: 'member', departmentIds: [] });
  const token = inv.body.url.split('/invite/')[1];
  const r = await c('POST', '/invitations/accept', name ? { token, newAccount: { name, password, locale: 'es', email } } : { token });
  return r.body.user?.id as string;
};
const setMember = (userId: string, body: object) => owner('PATCH', `/w/${slugA}/members/${userId}`, body);
const taskIds = async (c: Client) => ((await c('GET', `/w/${slugA}/tasks`)).body as { id: string }[]).map((t) => t.id);
const seen = async (c: Client) => {
  const ids = await taskIds(c);
  return Object.keys(task).filter((k) => ids.includes(task[k]!)).sort();
};

before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const reg = (c: Client, email: string, slug: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template: 'insurance_agency' } });
  id.owner = (await reg(owner, `owner-${run}@test.local`, slugA)).body.user.id;
  await reg(outsider, `intruso-${run}@test.local`, slugB);
  const ws = (await owner('GET', `/w/${slugA}`)).body;
  id.ventas = ws.departments[0].id;
  id.servicio = ws.departments[1].id;
  id.salud = ws.lines.find((l: any) => l.name === 'Salud').id;
  id.vida = ws.lines.find((l: any) => l.name === 'Vida').id;
  id.ana = await join(owner, slugA, ana, `ana-${run}@test.local`, 'Ana Torres');
  id.beto = await join(owner, slugA, beto, `beto-${run}@test.local`, 'Beto Ruiz');
  id.carla = await join(owner, slugA, carla, `carla-${run}@test.local`, 'Carla Díaz');
  id.dani = await join(owner, slugA, dani, `dani-${run}@test.local`, 'Dani León');
  await setMember(id.ana!, { departments: [{ id: id.ventas, isLead: false }], lineIds: [id.vida] });
  await setMember(id.beto!, { departments: [{ id: id.ventas, isLead: false }] });
  await setMember(id.carla!, { departments: [{ id: id.ventas, isLead: true }], lineIds: [id.salud] });
  await setMember(id.dani!, { departments: [{ id: id.servicio, isLead: false }] });

  const mk = async (title: string, departmentId: string, lineId: string | null) =>
    (await owner('POST', `/w/${slugA}/tasks`, { title, departmentId, lineId })).body.id as string;
  task.salud = await mk('Ventas Salud', id.ventas!, id.salud!);
  task.vida = await mk('Ventas Vida', id.ventas!, id.vida!);
  task.ventas = await mk('Ventas general', id.ventas!, null);
  task.servicio = await mk('Servicio', id.servicio!, null);
  const mkGoal = async (name: string, lineId: string) =>
    (await owner('POST', `/w/${slugA}/goals`, { departmentId: id.ventas, lineId, name, unit: 'pólizas', weeklyTarget: 10 })).body.id as string;
  goal.salud = await mkGoal('Pólizas de Salud', id.salud!);
  goal.vida = await mkGoal('Pólizas de Vida', id.vida!);
});

after(async () => {
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB]])).rows.map((r) => r.id);
  for (const t of ['weekly_report_items', 'weekly_reports', 'goals', 'task_checklist_items', 'task_comments', 'task_assignees', 'tasks',
    'channel_members', 'channels', 'audit_log', 'member_departments', 'member_lines', 'invitations',
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

test('tareas: cada quien ve su departamento y sus líneas; el Líder y el Owner todo', async () => {
  assert.deepEqual(await seen(owner), ['salud', 'servicio', 'ventas', 'vida']);
  assert.deepEqual(await seen(ana), ['ventas', 'vida']);
  assert.deepEqual(await seen(beto), ['salud', 'ventas', 'vida']);   // sin líneas: todas las de su departamento
  assert.deepEqual(await seen(carla), ['salud', 'ventas', 'vida']);  // Líder con Salud: igual ve Vida
  assert.deepEqual(await seen(dani), ['servicio']);
});

test('tareas: una de otra línea no se abre, no se edita ni se comenta (404)', async () => {
  assert.equal((await ana('GET', `/w/${slugA}/tasks/${task.salud}`)).status, 404);
  assert.equal((await ana('PATCH', `/w/${slugA}/tasks/${task.salud}`, { status: 'doing' })).status, 404);
  assert.equal((await ana('POST', `/w/${slugA}/tasks/${task.salud}/comments`, { body: 'hola' })).status, 404);
  assert.equal((await dani('GET', `/w/${slugA}/tasks/${task.vida}`)).status, 404);
  assert.equal((await ana('GET', `/w/${slugA}/tasks/${task.vida}`)).status, 200);
});

test('tareas: lo que te asignan o creaste se ve aunque sea de otra línea', async () => {
  await owner('PATCH', `/w/${slugA}/tasks/${task.salud}`, { assigneeIds: [id.ana] });
  assert.deepEqual(await seen(ana), ['salud', 'ventas', 'vida']);
  assert.equal((await ana('PATCH', `/w/${slugA}/tasks/${task.salud}`, { status: 'doing' })).status, 200);
  await owner('PATCH', `/w/${slugA}/tasks/${task.salud}`, { assigneeIds: [] });
  assert.deepEqual(await seen(ana), ['ventas', 'vida']);
  // Ana crea una de Salud en su departamento: es suya, la ve
  const mine = (await ana('POST', `/w/${slugA}/tasks`, { title: 'Mía de Salud', departmentId: id.ventas, lineId: id.salud })).body.id;
  assert.ok((await taskIds(ana)).includes(mine));
  assert.ok(!(await taskIds(dani)).includes(mine));
});

test('metas y reportes: solo las metas de su línea, también dentro del reporte', async () => {
  const goals = async (c: Client) => ((await c('GET', `/w/${slugA}/goals`)).body as { id: string }[]).map((g) => g.id).sort();
  assert.deepEqual(await goals(ana), [goal.vida]);
  assert.deepEqual(await goals(carla), [goal.salud, goal.vida].sort());
  assert.deepEqual(await goals(dani), []);
  const dash = (c: Client) => c('GET', `/w/${slugA}/goals/dashboard?weeks=1`);
  assert.deepEqual((await dash(ana)).body.rows.map((r: any) => r.goalId), [goal.vida]);

  const weekStart = (await dash(owner)).body.weeks[0];
  const put = await carla('PUT', `/w/${slugA}/reports`, {
    departmentId: id.ventas, weekStart, items: [{ goalId: goal.salud, actual: 4 }, { goalId: goal.vida, actual: 7 }] });
  assert.equal(put.status, 200);
  const reports = async (c: Client) => (await c('GET', `/w/${slugA}/reports`)).body as { items: { goalId: string }[] }[];
  assert.deepEqual((await reports(ana))[0]!.items.map((i) => i.goalId), [goal.vida]);
  assert.equal((await reports(carla))[0]!.items.length, 2);
  assert.equal((await reports(dani)).length, 0);
});

test('canal privado de departamento con línea: lo integran los de esa línea, los sin líneas, el Líder y el Owner', async () => {
  const r = await owner('POST', `/w/${slugA}/channels`, { kind: 'private', name: 'ventas-vida', departmentId: id.ventas, lineId: id.vida });
  assert.equal(r.status, 201);
  const members = async () => ((await owner('GET', `/w/${slugA}/channels/${r.body.id}/members`)).body as string[]).sort();
  assert.deepEqual(await members(), [id.owner, id.ana, id.beto, id.carla].sort());
  // Ana pasa a Salud: sale del canal; vuelve a Vida: entra
  await setMember(id.ana!, { lineIds: [id.salud] });
  assert.deepEqual(await members(), [id.owner, id.beto, id.carla].sort());
  await setMember(id.ana!, { lineIds: [id.vida] });
  assert.deepEqual(await members(), [id.owner, id.ana, id.beto, id.carla].sort());
});

test('permiso: un Miembro no puede cambiarse las líneas para ver más', async () => {
  assert.equal((await ana('PATCH', `/w/${slugA}/members/${id.ana}`, { lineIds: [id.salud, id.vida] })).status, 403);
  assert.deepEqual(await seen(ana), ['ventas', 'vida']);
});

test('aislamiento: otra agencia no ve las tareas, y las líneas de otra agencia no cuentan aquí', async () => {
  assert.equal((await outsider('GET', `/w/${slugA}/tasks`)).status, 404);
  assert.equal((await outsider('GET', `/w/${slugA}/tasks/${task.vida}`)).status, 404);
  // Beto entra a la agencia B y allí le asignan Vida: en A sigue sin líneas, así que sigue viendo Salud
  await join(outsider, slugB, beto, '', '');
  const lineB = (await outsider('GET', `/w/${slugB}`)).body.lines.find((l: any) => l.name === 'Vida').id;
  assert.equal((await outsider('PATCH', `/w/${slugB}/members/${id.beto}`, { lineIds: [lineB] })).status, 200);
  assert.deepEqual(await seen(beto), ['salud', 'ventas', 'vida']);
  assert.deepEqual(((await outsider('GET', `/w/${slugB}/tasks`)).body as unknown[]).length, 0);
});
