// Finanzas (docs/plan-finanzas.md, ADR 0007): permisos (guardián 404 + rol Contable), gastos con aprobación, recurrencias
// puras e idempotencia del generador, nómina (cálculo puro y corridas por HTTP con comisiones reales de ventas), banco
// (parser CSV puro, carga manual, importación con duplicados) y aislamiento: la agencia B no ve ni toca nada de la A.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index.ts';
import { adminPool, appPool, withWorkspace } from '../src/db.ts';
import { ensureBucket } from '../src/files/s3.ts';
import { occurrences, nextOccurrence, generateOccurrences, addDays, type ScheduleRule } from '../src/finance/schedule.ts';
import { computeLine, effectiveAt, nextPeriod, periodContaining, type CalcInput } from '../src/finance/payroll-calc.ts';
import {
  parseCsv, detectDelimiter, parseCsvDate, parseCsvAmount, interpretRow, dedupeKey, suggestCarrier,
} from '../src/finance/csv.ts';

let server: Server;
let base = '';
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slugA = `fin-a-${run}`, slugB = `fin-b-${run}`;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });   // "hoy" del servidor (Nueva York)

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown, raw?: { data: string; type: string }) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method, headers: { cookie, 'content-type': raw?.type ?? 'application/json' },
      body: raw ? raw.data : body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}
type Client = ReturnType<typeof client>;

// owner = Owner de A · conta = Contable de A · ana = Miembro (agente de ventas) · guest = Invitado · outsider = Owner de B
const owner = client(), conta = client(), ana = client(), guest = client(), outsider = client();
let ownerId = '', contaId = '', anaId = '', wsA = '', wsB = '';
let rentA = '', otherA = '', catB = '';
const A = (p: string) => `/w/${slugA}/finance${p}`;
const B = (p: string) => `/w/${slugB}/finance${p}`;

/** Sube un archivo con el flujo normal (alta → PUT del contenido → complete) y devuelve su id */
async function upload(c: Client, slug: string, name: string, mime: string, data: string, context: string) {
  const up = await c('POST', `/w/${slug}/files`, { name, mime, size: Buffer.byteLength(data), context });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await c('PUT', up.body.uploadUrl.replace('/api/v1', ''), undefined, { data, type: mime })).status, 204);
  const ref = await c('POST', `/w/${slug}/files/${up.body.fileId}/complete`);
  assert.equal(ref.status, 200);
  return ref.body.id as string;
}

before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await ensureBucket();

  const reg = (c: Client, email: string, slug: string, template: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template } });
  ownerId = (await reg(owner, `owner-${run}@test.local`, slugA, 'insurance_agency')).body.user.id;
  await reg(outsider, `intruso-${run}@test.local`, slugB, 'blank');
  const join = async (c: Client, name: string, role: string) => {
    const inv = await owner('POST', `/w/${slugA}/invitations`, { email: null, role });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const acc = await c('POST', '/invitations/accept', {
      token: inv.body.url.split('/invite/')[1], newAccount: { name, password, locale: 'es', email: `${name.toLowerCase()}-${run}@test.local` } });
    return acc.body.user.id as string;
  };
  contaId = await join(conta, 'Contable', 'accountant');
  anaId = await join(ana, 'Ana', 'member');
  await join(guest, 'Invitado', 'guest');
  const ws = (await adminPool.query('select id, slug from workspaces where slug = any($1)', [[slugA, slugB]])).rows;
  wsA = ws.find((w) => w.slug === slugA).id;
  wsB = ws.find((w) => w.slug === slugB).id;
});

after(async () => {
  server.close();
  const ws = [wsA, wsB].filter(Boolean);
  await adminPool.query('update carriers set default_product_id = null where workspace_id = any($1)', [ws]);
  // Todas las tablas con workspace_id; varias pasadas para respetar el orden de las FK sin listarlas a mano
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
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from ws_tickets where user_id = any($1)', [users]).catch(() => {});
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

// ═══════════════════════════ 1. Permisos ═══════════════════════════

const FINANCE_GETS = ['/expenses', '/expense-categories', '/expense-schedules', '/vendors', '/expenses.csv', '/payroll/calendars',
  '/payroll/people', '/payroll/runs', '/bank/accounts', '/bank/transactions', '/bank/statements'];

test('permisos: Miembro e Invitado reciben 404 en todo /finance; el Contable entra', async () => {
  for (const c of [ana, guest]) {
    for (const p of FINANCE_GETS) {
      const r = await c('GET', A(p));
      assert.equal(r.status, 404, `${p} → ${r.status}`);
      assert.equal(r.body.code, 'not_found');
    }
    assert.equal((await c('POST', A('/expenses'), {})).status, 404);
    assert.equal((await c('POST', A('/bank/accounts'), { name: 'X' })).status, 404);
  }
  for (const c of [conta, owner]) {
    for (const p of FINANCE_GETS) assert.equal((await c('GET', A(p))).status, 200, p);
  }
  assert.equal((await conta('GET', `/w/${slugA}`)).body.me.role, 'accountant');
});

test('módulo apagado → 404 module_disabled; activarlo por PATCH crea las 7 categorías sin duplicar', async () => {
  // Plantilla de seguros: activo y con 7 categorías
  assert.equal((await owner('GET', `/w/${slugA}`)).body.settings.financeModule, true);
  const catsA = (await owner('GET', A('/expense-categories'))).body;
  assert.equal(catsA.length, 7);
  rentA = catsA.find((c: any) => c.name === 'Renta').id;
  otherA = catsA.find((c: any) => c.name === 'Software').id;
  // Agencia en blanco: apagado
  const off = await outsider('GET', B('/expenses'));
  assert.equal(off.status, 404);
  assert.equal(off.body.code, 'module_disabled');
  // Activar crea las categorías; apagar y volver a encender no las duplica
  assert.equal((await outsider('PATCH', `/w/${slugB}`, { settings: { financeModule: true, salesModule: true } })).status, 200);
  const count = async () => (await adminPool.query('select count(*)::int as n from expense_categories where workspace_id = $1', [wsB])).rows[0].n;
  assert.equal(await count(), 7);
  await outsider('PATCH', `/w/${slugB}`, { settings: { financeModule: false } });
  assert.equal((await outsider('GET', B('/expenses'))).body.code, 'module_disabled');
  await outsider('PATCH', `/w/${slugB}`, { settings: { financeModule: true } });
  await outsider('PATCH', `/w/${slugB}`, { settings: { financeModule: true } });
  assert.equal(await count(), 7);
  catB = (await outsider('GET', B('/expense-categories'))).body[0].id;
  // Apagado en A: ni el Owner entra
  await owner('PATCH', `/w/${slugA}`, { settings: { financeModule: false } });
  assert.equal((await owner('GET', A('/expenses'))).body.code, 'module_disabled');
  assert.equal((await conta('GET', A('/expenses'))).status, 404);
  await owner('PATCH', `/w/${slugA}`, { settings: { financeModule: true } });
  assert.equal((await owner('GET', A('/expense-categories'))).body.length, 7);
});

test('el Contable fuera de finanzas es Miembro: no invita, no administra ventas ni ajustes', async () => {
  assert.equal((await conta('POST', `/w/${slugA}/invitations`, { email: null, role: 'member' })).status, 403);
  assert.equal((await conta('POST', `/w/${slugA}/carriers`, { name: 'X' })).status, 403);
  assert.equal((await conta('GET', `/w/${slugA}/sales-inbox`)).status, 403);
  assert.equal((await conta('PATCH', `/w/${slugA}`, { settings: { financeModule: false } })).status, 403);
  assert.equal((await conta('GET', `/w/${slugA}/channels`)).status, 200);   // lo de cualquier miembro sí
});

// ═══════════════════════════ 2. Gastos ═══════════════════════════

const expense = (extra: object = {}) => ({ categoryId: rentA, vendor: 'Brickell Offices', dueDate: '2026-11-01', amount: 2500, payMethod: 'ach', ...extra });

test('aprobación: Owner crea aprobado, Contable crea por aprobar y no puede aprobar ni pagar lo pendiente', async () => {
  const o = await owner('POST', A('/expenses'), expense());
  assert.equal(o.status, 201);
  assert.deepEqual([o.body.approvalStatus, o.body.approvedBy, o.body.status, o.body.createdBy], ['approved', ownerId, 'pending', ownerId]);

  const c = await conta('POST', A('/expenses'), expense({ vendor: 'Zoom', amount: 15.99 }));
  assert.equal(c.status, 201);
  assert.deepEqual([c.body.approvalStatus, c.body.approvedBy, c.body.createdBy], ['pending', null, contaId]);
  assert.equal((await conta('POST', A(`/expenses/${c.body.id}/approve`))).status, 403);
  assert.equal((await conta('POST', A(`/expenses/${c.body.id}/reject`))).status, 403);
  const pay = await owner('POST', A(`/expenses/${c.body.id}/pay`), { paidAt: '2026-10-10' });
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'not_approved');
  // El Contable tampoco lo carga ya pagado
  assert.equal((await conta('POST', A('/expenses'), expense({ paid: { paidAt: '2026-10-01' } }))).body.code, 'not_approved');

  const ap = await owner('POST', A(`/expenses/${c.body.id}/approve`));
  assert.deepEqual([ap.body.approvalStatus, ap.body.approvedBy], ['approved', ownerId]);
  // El Contable cambia el monto de uno aprobado → vuelve a por aprobar; cambiar solo notas no
  const n = await conta('PATCH', A(`/expenses/${c.body.id}`), { notes: 'plan anual' });
  assert.equal(n.body.approvalStatus, 'approved');
  const m = await conta('PATCH', A(`/expenses/${c.body.id}`), { amount: 19.99 });
  assert.deepEqual([m.body.amount, m.body.approvalStatus, m.body.approvedBy], [19.99, 'pending', null]);
  // El Owner cambia el monto y sigue aprobado
  const om = await owner('PATCH', A(`/expenses/${o.body.id}`), { amount: 2600 });
  assert.deepEqual([om.body.amount, om.body.approvalStatus], [2600, 'approved']);
});

test('pagar, saltar, reabrir y borrar', async () => {
  const e = (await owner('POST', A('/expenses'), expense({ vendor: 'FPL', amount: 180 }))).body;
  // El Contable paga uno aprobado con monto real distinto
  const p = await conta('POST', A(`/expenses/${e.id}/pay`), { paidAt: '2026-10-05', paidAmount: 176.4, reference: 'CONF-1' });
  assert.equal(p.status, 200);
  assert.deepEqual([p.body.status, p.body.paidAmount, p.body.paidAt, p.body.reference], ['paid', 176.4, '2026-10-05', 'CONF-1']);
  assert.equal((await owner('POST', A(`/expenses/${e.id}/pay`), { paidAt: '2026-10-05' })).body.code, 'expense_not_pending');
  assert.equal((await owner('POST', A(`/expenses/${e.id}/skip`))).status, 409);
  assert.equal((await owner('PATCH', A(`/expenses/${e.id}`), { amount: 1 })).body.code, 'expense_paid');
  assert.equal((await owner('DELETE', A(`/expenses/${e.id}`))).body.code, 'expense_paid');
  const r = await owner('POST', A(`/expenses/${e.id}/reopen`));
  assert.deepEqual([r.body.status, r.body.paidAmount, r.body.paidAt], ['pending', null, null]);
  assert.equal((await owner('POST', A(`/expenses/${e.id}/reopen`))).body.code, 'expense_pending');
  assert.equal((await owner('POST', A(`/expenses/${e.id}/skip`))).body.status, 'skipped');
  assert.equal((await owner('POST', A(`/expenses/${e.id}/reopen`))).body.status, 'pending');
  assert.equal((await conta('DELETE', A(`/expenses/${e.id}`))).status, 204);
  assert.equal((await owner('POST', A(`/expenses/${e.id}/skip`))).status, 404);
  // Cargado ya pagado (Owner): sin paidAmount toma el monto
  const pd = await owner('POST', A('/expenses'), expense({ vendor: 'Staples', amount: 42.5, paid: { paidAt: '2026-10-02' } }));
  assert.deepEqual([pd.body.status, pd.body.paidAmount], ['paid', 42.5]);
  // Proveedores ya usados para autocompletar
  assert.ok((await conta('GET', A('/vendors?q=stap'))).body.includes('Staples'));
});

test('vencidos y totales: saltados y rechazados no suman', async () => {
  const mk = async (c: Client, extra: object) => (await c('POST', A('/expenses'), expense({ vendor: `Totales ${run}`, ...extra }))).body;
  const late = await mk(owner, { amount: 100, dueDate: '2020-01-01' });
  const paid = await mk(owner, { amount: 200, dueDate: '2099-01-01' });
  await owner('POST', A(`/expenses/${paid.id}/pay`), { paidAt: '2026-10-01', paidAmount: 190 });
  const skipped = await mk(owner, { amount: 50 });
  await owner('POST', A(`/expenses/${skipped.id}/skip`));
  const rejected = await mk(conta, { amount: 75, dueDate: '2020-01-01' });
  assert.equal((await owner('POST', A(`/expenses/${rejected.id}/reject`))).body.approvalStatus, 'rejected');
  assert.equal((await owner('POST', A(`/expenses/${rejected.id}/pay`), { paidAt: '2026-10-01' })).status, 409);
  const pendingApproval = await mk(conta, { amount: 10, dueDate: '2020-01-01', categoryId: otherA });

  const l = (await owner('GET', A(`/expenses?vendor=${encodeURIComponent(`Totales ${run}`)}`))).body;
  assert.equal(l.items.length, 5);
  assert.equal(l.items.find((e: any) => e.id === late.id).overdue, true);
  assert.equal(l.items.find((e: any) => e.id === pendingApproval.id).overdue, false);   // sin aprobar no está "vencido"
  assert.deepEqual(l.totals, { count: 3, amount: 310, paid: 190, pending: 110, overdue: 100, overdueCount: 1 });
  assert.deepEqual(l.byCategory, [{ categoryId: rentA, amount: 300, paid: 190 }, { categoryId: otherA, amount: 10, paid: 0 }]);
  const od = (await owner('GET', A(`/expenses?overdue=true&vendor=${encodeURIComponent(`Totales ${run}`)}`))).body;
  assert.deepEqual(od.items.map((e: any) => e.id), [late.id]);
  const ap = (await owner('GET', A(`/expenses?approvalStatus=pending&vendor=${encodeURIComponent(`Totales ${run}`)}`))).body;
  assert.deepEqual(ap.items.map((e: any) => e.id), [pendingApproval.id]);
});

test('CSV de gastos: los textos que empiezan con = o - llevan apóstrofo', async () => {
  await owner('POST', A('/expenses'), expense({ vendor: '=HYPERLINK("http://x")', concept: '-descuento', amount: 230 }));
  const r = await owner('GET', A('/expenses.csv'));
  assert.match(r.headers.get('content-type')!, /text\/csv/);
  assert.match(r.body, /"Vence","Categoría","Proveedor"/);
  assert.ok(r.body.includes(`"'=HYPERLINK(""http://x"")"`), 'el = no se neutralizó');
  assert.ok(r.body.includes(`"'-descuento"`), 'el - de texto no se neutralizó');
  assert.ok(r.body.includes('"230.00"'));
});

test('comprobante: archivo de gastos válido; id inexistente, de otro contexto o de otra agencia → 400', async () => {
  const fileId = await upload(conta, slugA, 'factura.pdf', 'application/pdf', '%PDF-1.4 factura', 'expense');
  const e = await conta('POST', A('/expenses'), expense({ vendor: 'Con comprobante', fileId }));
  assert.equal(e.status, 201);
  assert.equal(e.body.file.id, fileId);
  assert.equal(e.body.file.url, `/api/v1/w/${slugA}/files/${fileId}`);
  const chatFile = await upload(owner, slugA, 'nota.txt', 'text/plain', 'hola', 'message');
  const foreign = await upload(outsider, slugB, 'b.pdf', 'application/pdf', '%PDF b', 'expense');
  for (const bad of [randomUUID(), chatFile, foreign]) {
    const r = await owner('POST', A('/expenses'), expense({ fileId: bad }));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_file');
    assert.equal((await owner('PATCH', A(`/expenses/${e.body.id}`), { fileId: bad })).body.code, 'invalid_file');
  }
  const ok = (await owner('POST', A('/expenses'), expense({ vendor: 'Sin comprobante' }))).body;
  assert.equal((await owner('POST', A(`/expenses/${ok.id}/pay`), { paidAt: '2026-10-01', fileId: randomUUID() })).body.code, 'invalid_file');
  const paid = await owner('POST', A(`/expenses/${ok.id}/pay`), { paidAt: '2026-10-01', fileId });
  assert.equal(paid.body.file.id, fileId);
});

// ═══════════════════════════ 3. Recurrencias ═══════════════════════════

const rule = (r: Partial<ScheduleRule>): ScheduleRule => ({
  frequency: 'monthly', interval: 1, weekdays: null, monthDay: null, businessDaysOnly: false, startsOn: '2026-01-01', endsOn: null, ...r });

test('mensual día 31: cae en el último día de febrero (bisiesto y no) y de los meses de 30', () => {
  assert.deepEqual(occurrences(rule({ monthDay: 31, startsOn: '2024-01-31' }), '2024-01-01', '2024-04-30'),
    ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
  assert.deepEqual(occurrences(rule({ monthDay: 31, startsOn: '2025-01-31' }), '2025-01-01', '2025-04-30'),
    ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30']);
  assert.deepEqual(occurrences(rule({ monthDay: 30, startsOn: '2026-01-01' }), '2026-02-01', '2026-03-31'), ['2026-02-28', '2026-03-30']);
});

test('mensual "último día" y cada 2 meses (también con ventana a mitad de la serie)', () => {
  assert.deepEqual(occurrences(rule({ monthDay: 'last', startsOn: '2026-01-15' }), '2026-01-01', '2026-03-31'),
    ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(occurrences(rule({ monthDay: null, startsOn: '2028-02-01' }), '2028-02-01', '2028-02-29'), ['2028-02-29']);
  const every2 = rule({ monthDay: 15, interval: 2, startsOn: '2026-01-15' });
  assert.deepEqual(occurrences(every2, '2026-01-01', '2026-06-30'), ['2026-01-15', '2026-03-15', '2026-05-15']);
  assert.deepEqual(occurrences(every2, '2026-04-01', '2026-08-31'), ['2026-05-15', '2026-07-15']);
  // Día anterior al inicio en el primer mes: no cuenta
  assert.deepEqual(occurrences(rule({ monthDay: 10, startsOn: '2026-01-20' }), '2026-01-01', '2026-02-28'), ['2026-02-10']);
});

test('semanal cada 2 semanas con varios días', () => {
  // 2026-10-05 es lunes: lunes y jueves, semanas alternas
  const r = rule({ frequency: 'weekly', interval: 2, weekdays: [1, 4], startsOn: '2026-10-05' });
  assert.deepEqual(occurrences(r, '2026-10-01', '2026-11-08'), ['2026-10-05', '2026-10-08', '2026-10-19', '2026-10-22', '2026-11-02', '2026-11-05']);
  // Empezando un miércoles: el lunes de esa semana ya pasó, el jueves sí
  const mid = rule({ frequency: 'weekly', interval: 2, weekdays: [1, 4], startsOn: '2026-10-07' });
  assert.deepEqual(occurrences(mid, '2026-10-01', '2026-10-25'), ['2026-10-08', '2026-10-19', '2026-10-22']);
  assert.equal(nextOccurrence(r, '2026-10-09'), '2026-10-19');
});

test('diario solo hábiles: el fin de semana se mueve al lunes sin duplicarlo', () => {
  // 2026-10-09 es viernes
  const daily = rule({ frequency: 'daily', businessDaysOnly: true, startsOn: '2026-10-09' });
  assert.deepEqual(occurrences(daily, '2026-10-09', '2026-10-14'), ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14']);
  // Cada 2 días: 9 (vie), 11 (dom → lun 12), 13, 15, 17 (sáb → lun 19), 19 (lun) = una sola vez
  const every2 = rule({ frequency: 'daily', interval: 2, businessDaysOnly: true, startsOn: '2026-10-09' });
  assert.deepEqual(occurrences(every2, '2026-10-09', '2026-10-20'), ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-15', '2026-10-19']);
  // Ventana que empieza el lunes: recoge el sábado y domingo anteriores movidos
  assert.deepEqual(occurrences(daily, '2026-10-12', '2026-10-12'), ['2026-10-12']);
  // Sin hábiles: todos los días
  assert.equal(occurrences(rule({ frequency: 'daily', startsOn: '2026-10-09' }), '2026-10-09', '2026-10-15').length, 7);
});

test('endsOn corta la serie (en hábiles, el lunes al que se mueve puede caer después)', () => {
  assert.deepEqual(occurrences(rule({ frequency: 'daily', startsOn: '2026-10-01', endsOn: '2026-10-05' }), '2026-09-01', '2026-10-31'),
    ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(occurrences(rule({ monthDay: 15, startsOn: '2026-01-15', endsOn: '2026-03-20' }), '2026-01-01', '2026-12-31'),
    ['2026-01-15', '2026-02-15', '2026-03-15']);
  assert.deepEqual(occurrences(rule({ frequency: 'weekly', weekdays: [1], startsOn: '2026-10-05', endsOn: '2026-10-19' }), '2026-10-01', '2026-12-31'),
    ['2026-10-05', '2026-10-12', '2026-10-19']);
  assert.deepEqual(occurrences(rule({ frequency: 'daily', businessDaysOnly: true, startsOn: '2026-10-09', endsOn: '2026-10-10' }), '2026-10-01', '2026-10-31'),
    ['2026-10-09', '2026-10-12']);
  assert.equal(nextOccurrence(rule({ monthDay: 15, startsOn: '2026-01-15', endsOn: '2026-03-20' }), '2026-03-16'), null);
  assert.equal(nextOccurrence(rule({ monthDay: 'last', startsOn: '2026-01-01' }), '2026-02-10'), '2026-02-28');
});

let scheduleId = '';
test('plantilla del Contable: no genera hasta aprobarse; aprobar genera y repetir no duplica', async () => {
  const body = { categoryId: rentA, vendor: `Renta oficina ${run}`, amount: 2500, payMethod: 'ach', frequency: 'monthly',
    monthDay: 'last', startsOn: today };
  const s = await conta('POST', A('/expense-schedules'), body);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual([s.body.approvalStatus, s.body.monthDay, s.body.status], ['pending', 'last', 'active']);
  scheduleId = s.body.id;
  const list = async () => (await owner('GET', A(`/expenses?scheduleId=${scheduleId}`))).body.items as any[];
  assert.equal((await list()).length, 0);
  assert.equal((await conta('POST', A(`/expense-schedules/${scheduleId}/approve`))).status, 403);

  const ap = await owner('POST', A(`/expense-schedules/${scheduleId}/approve`));
  assert.equal(ap.body.approvalStatus, 'approved');
  const expected = occurrences(rule({ monthDay: 'last', startsOn: today }), today, addDays(today, 35));
  const items = await list();
  assert.deepEqual(items.map((e) => e.dueDate).sort(), expected);
  assert.ok(items.every((e) => e.approvalStatus === 'approved' && e.createdBy === null && e.approvedBy === null && e.amount === 2500));
  assert.equal(ap.body.nextDueDate, expected[0]);

  // Idempotencia: aprobar otra vez y correr el generador del job
  await owner('POST', A(`/expense-schedules/${scheduleId}/approve`));
  assert.equal(await withWorkspace({ workspaceId: wsA, userId: null }, (db) => generateOccurrences(db)), 0);
  await adminPool.query('update expense_schedules set generated_until = null where id = $1', [scheduleId]);   // forzar regeneración completa
  assert.equal(await withWorkspace({ workspaceId: wsA, userId: null }, (db) => generateOccurrences(db, scheduleId)), 0);
  assert.equal((await list()).length, expected.length);

  // Una ocurrencia no se borra: se salta
  assert.equal((await owner('DELETE', A(`/expenses/${items[0].id}`))).body.code, 'expense_recurring');
  // El Contable cambia el monto → por aprobar; al aprobar llega a las próximas pendientes
  const m = await conta('PATCH', A(`/expense-schedules/${scheduleId}`), { amount: 2700 });
  assert.equal(m.body.approvalStatus, 'pending');
  await owner('POST', A(`/expense-schedules/${scheduleId}/approve`));
  assert.ok((await list()).every((e) => e.amount === 2700));
});

test('plantilla del Owner nace aprobada y genera; diaria hábil sin fines de semana; rechazada no genera', async () => {
  const d = await owner('POST', A('/expense-schedules'), { categoryId: otherA, vendor: `Leads ${run}`, amount: 30, payMethod: 'card',
    frequency: 'daily', businessDaysOnly: true, startsOn: today });
  assert.equal(d.body.approvalStatus, 'approved');
  const items = (await owner('GET', A(`/expenses?scheduleId=${d.body.id}`))).body.items as any[];
  const expected = occurrences(rule({ frequency: 'daily', businessDaysOnly: true, startsOn: today }), today, addDays(today, 35));
  assert.deepEqual(items.map((e) => e.dueDate).sort(), expected);
  assert.ok(items.every((e) => ![0, 6].includes(new Date(`${e.dueDate}T00:00:00Z`).getUTCDay())));
  // Incoherencias de la regla → 400
  assert.equal((await owner('POST', A('/expense-schedules'), { categoryId: otherA, vendor: 'X', amount: 1, payMethod: 'card',
    frequency: 'weekly', startsOn: today })).status, 400);
  const r = await conta('POST', A('/expense-schedules'), { categoryId: otherA, vendor: `Rechazada ${run}`, amount: 5, payMethod: 'card',
    frequency: 'weekly', weekdays: [1, 3], startsOn: today });
  assert.equal((await owner('POST', A(`/expense-schedules/${r.body.id}/reject`))).body.approvalStatus, 'rejected');
  assert.equal(await withWorkspace({ workspaceId: wsA, userId: null }, (db) => generateOccurrences(db, r.body.id)), 0);
  assert.equal((await owner('GET', A(`/expenses?scheduleId=${r.body.id}`))).body.items.length, 0);
});

// ═══════════════════════════ 4. Nómina ═══════════════════════════

const calc = (over: Partial<CalcInput>): CalcInput => ({
  periodEnd: '2026-09-30', components: [], hours: null, hasUser: false,
  commissions: { cents: 0, count: 0 }, issuedSales: { cents: 0, count: 0 }, adjustments: [], ...over });
const comp = (kind: any, extra: object = {}) => ({ id: `${kind}-${Math.random()}`, kind, label: '', amount: null, rate: null,
  effectiveFrom: '2026-01-01', effectiveTo: null, ...extra });

test('computeLine: sueldo, horas, bono, deducción fija y %, ajustes', () => {
  const r = computeLine(calc({
    hours: 40,
    components: [comp('salary', { amount: 1000 }), comp('hourly', { amount: 15 }), comp('bonus', { amount: 100, label: 'Bono puntualidad' }),
      comp('deduction_fixed', { amount: 50, label: 'Seguro' }), comp('deduction_percent', { rate: 10 })],
    adjustments: [{ id: 'a1', kind: 'bonus', label: 'Extra', amount: 25 }, { id: 'a2', kind: 'deduction', label: 'Adelanto', amount: 5 }],
  }));
  assert.equal(r.grossCents, 172_500);                 // 1000 + 40 × 15 + 100 + 25
  assert.equal(r.deductionsCents, 22_750);             // 50 + 10 % de 1725 + 5
  assert.equal(r.netCents, 149_750);
  assert.equal(r.hasHourly, true);
  assert.deepEqual(r.breakdown.map((i) => [i.kind, i.label, i.amount]), [
    ['salary', 'Sueldo', 1000], ['hourly', 'Horas', 600], ['bonus', 'Bono puntualidad', 100], ['adjustment_bonus', 'Extra', 25],
    ['deduction_fixed', 'Seguro', 50], ['deduction_percent', 'Deducción %', 172.5], ['adjustment_deduction', 'Adelanto', 5],
  ]);
  assert.equal(r.breakdown[1]!.detail, '40 h × $15.00');
  // Sin horas cargadas: 0 y aviso
  const nh = computeLine(calc({ components: [comp('hourly', { amount: 15 })] }));
  assert.deepEqual([nh.grossCents, nh.breakdown[0]!.detail], [0, 'Sin horas cargadas']);
  // Redondeo a centavos: 7.5 h × 15.33 = 114.975 → 114.98
  assert.equal(computeLine(calc({ hours: 7.5, components: [comp('hourly', { amount: 15.33 })] })).grossCents, 11_498);
});

test('computeLine: comisión de ventas, % de ventas, chargeback como deducción y neto negativo', () => {
  const s = computeLine(calc({
    hasUser: true, commissions: { cents: 58_500, count: 1 }, issuedSales: { cents: 120_000, count: 1 },
    components: [comp('sales_commission'), comp('sales_commission'), comp('sales_percent', { rate: 5 })],
  }));
  assert.equal(s.grossCents, 64_500);                  // 585 una sola vez (dos componentes no cobran doble) + 5 % de 1200
  assert.deepEqual(s.breakdown.map((i) => [i.kind, i.amount, i.detail]), [
    ['sales_commission', 585, '1 cuota pagada'], ['sales_percent', 60, '5 % de $1,200.00 (1 ventas)']]);
  // Sin usuario enlazado: no cobra y lo avisa
  const nu = computeLine(calc({ components: [comp('sales_commission'), comp('sales_percent', { rate: 5 })] }));
  assert.equal(nu.grossCents, 0);
  assert.ok(nu.breakdown.every((i) => i.detail === 'Sin usuario de Kora enlazado'));
  // Chargebacks netos negativos: no restan del bruto, entran como deducción positiva
  const cb = computeLine(calc({ hasUser: true, commissions: { cents: -29_250, count: 2 }, components: [comp('sales_commission'), comp('salary', { amount: 100 })] }));
  assert.deepEqual([cb.grossCents, cb.deductionsCents, cb.netCents], [10_000, 29_250, -19_250]);
  const ded = cb.breakdown.find((i) => i.label === 'Chargebacks de comisión')!;
  assert.deepEqual([ded.kind, ded.amount, ded.detail], ['deduction_fixed', 292.5, '2 cuotas pagadas']);
  assert.ok(cb.breakdown.every((i) => i.amount >= 0));
  const last = cb.breakdown.at(-1)!;
  assert.deepEqual([last.label, last.amount], ['Neto negativo', 0]);
  assert.match(last.detail!, /\$192\.50/);
  // Solo deducción fija: neto −230
  assert.equal(computeLine(calc({ components: [comp('deduction_fixed', { amount: 230 })] })).netCents, -23_000);
});

test('vigencia: cuentan los componentes vigentes a la fecha de fin del periodo', () => {
  assert.equal(effectiveAt({ effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' }, '2026-09-30'), true);
  assert.equal(effectiveAt({ effectiveFrom: '2026-10-01', effectiveTo: null }, '2026-09-30'), false);
  assert.equal(effectiveAt({ effectiveFrom: '2026-01-01', effectiveTo: '2026-09-29' }, '2026-09-30'), false);
  const r = computeLine(calc({ components: [
    comp('salary', { amount: 1000, effectiveTo: '2026-09-15' }),        // terminó a mitad del periodo
    comp('salary', { amount: 1200, effectiveFrom: '2026-09-16' }),      // aumento: aplica completo
    comp('bonus', { amount: 50, effectiveFrom: '2026-10-01' }),         // futuro
  ] }));
  assert.equal(r.grossCents, 120_000);
});

test('nextPeriod y periodContaining de los 4 calendarios', () => {
  const weekly = { frequency: 'weekly' as const, anchorDate: '2026-10-09', payDay: null };
  assert.deepEqual(nextPeriod(weekly, '2026-10-11', []), { periodStart: '2026-10-09', periodEnd: '2026-10-15', payDate: '2026-10-16' });
  assert.deepEqual(nextPeriod(weekly, '2026-10-11', [{ periodStart: '2026-10-09', periodEnd: '2026-10-15' }]),
    { periodStart: '2026-10-16', periodEnd: '2026-10-22', payDate: '2026-10-23' });
  assert.deepEqual(periodContaining(weekly, '2026-09-20'), { periodStart: '2026-09-18', periodEnd: '2026-09-24', payDate: '2026-09-25' });

  const biweekly = { frequency: 'biweekly' as const, anchorDate: '2026-10-09', payDay: null };
  assert.deepEqual(nextPeriod(biweekly, '2026-10-11', []), { periodStart: '2026-10-09', periodEnd: '2026-10-22', payDate: '2026-10-23' });
  assert.deepEqual(nextPeriod(biweekly, '2026-10-11', [{ periodStart: '2026-10-09', periodEnd: '2026-10-22' }]),
    { periodStart: '2026-10-23', periodEnd: '2026-11-05', payDate: '2026-11-06' });

  const semi = { frequency: 'semimonthly' as const, anchorDate: null, payDay: null };
  assert.deepEqual(nextPeriod(semi, '2026-10-11', []), { periodStart: '2026-10-01', periodEnd: '2026-10-15', payDate: '2026-10-15' });
  assert.deepEqual(nextPeriod(semi, '2026-10-11', [{ periodStart: '2026-10-01', periodEnd: '2026-10-15' }]),
    { periodStart: '2026-10-16', periodEnd: '2026-10-31', payDate: '2026-10-31' });
  assert.deepEqual(periodContaining(semi, '2028-02-20'), { periodStart: '2028-02-16', periodEnd: '2028-02-29', payDate: '2028-02-29' });

  const monthly5 = { frequency: 'monthly' as const, anchorDate: null, payDay: 5 };
  assert.deepEqual(nextPeriod(monthly5, '2026-10-11', []), { periodStart: '2026-10-01', periodEnd: '2026-10-31', payDate: '2026-11-05' });
  assert.deepEqual(nextPeriod(monthly5, '2026-12-11', [{ periodStart: '2026-12-01', periodEnd: '2026-12-31' }]),
    { periodStart: '2027-01-01', periodEnd: '2027-01-31', payDate: '2027-02-05' });
  const monthlyLast = { frequency: 'monthly' as const, anchorDate: null, payDay: 'last' as const };
  assert.deepEqual(nextPeriod(monthlyLast, '2026-02-10', []), { periodStart: '2026-02-01', periodEnd: '2026-02-28', payDate: '2026-02-28' });
  assert.deepEqual(periodContaining({ ...monthlyLast, payDay: 31 }, '2026-02-10').payDate, '2026-02-28');
});

let calId = '', luisId = '', anaPersonId = '', salaryId = '', runId = '', luisLine = '', anaLine = '';
let negCalId = '', carrierA = '';
test('nómina: comisiones reales de ventas pagadas en el periodo (venta ISSUED + cuotas pagadas)', async () => {
  // Ana vende en septiembre; la compañía le paga el adelanto el 10/09
  const c = await owner('POST', `/w/${slugA}/carriers`, { name: 'Americo', aliases: ['americo fin'] });
  carrierA = c.body.id;
  const pid = (await owner('POST', `/w/${slugA}/carriers/${carrierA}/products`, { name: 'IUL' })).body.products[0].id;
  await owner('PUT', `/w/${slugA}/products/${pid}/grid`, { effectiveFrom: '2024-08-19', rows: [{ level: 80, rate: 65 }, { level: 100, rate: 85 }] });
  await owner('POST', `/w/${slugA}/agents/${anaId}/levels`, { carrierIds: [carrierA], level: 80, effectiveFrom: '2026-01-01' });
  const s = await owner('POST', `/w/${slugA}/sales`, { agentUserId: anaId, productId: pid, amount: 1200, clientName: 'Cliente Uno', expectedIssueDate: '2026-09-05' });
  assert.equal((await owner('POST', `/w/${slugA}/sales/${s.body.id}/issue`, { issuedAt: '2026-09-05' })).body.status, 'issued');
  const adv = (await owner('GET', `/w/${slugA}/commissions`)).body.items.find((i: any) => i.saleId === s.body.id && i.part === 'advance');
  assert.equal(adv.amount, 585);
  assert.equal((await owner('POST', `/w/${slugA}/commissions/pay`, { ids: [adv.id], paidAt: '2026-09-10' })).status, 204);

  const cal = await conta('POST', A('/payroll/calendars'), { name: 'Mensual', frequency: 'monthly', payDay: 'last' });
  assert.equal(cal.status, 201, JSON.stringify(cal.body));
  calId = cal.body.id;
  assert.equal((await conta('POST', A('/payroll/calendars'), { name: 'Mensual', frequency: 'monthly' })).body.code, 'calendar_name_taken');
  // Persona sin usuario de Kora
  const luis = await conta('POST', A('/payroll/people'), { name: 'Luis Pérez', calendarId: calId, payMethod: 'zelle' });
  luisId = luis.body.id;
  for (const body of [{ kind: 'salary', amount: 2000, effectiveFrom: '2026-01-01' }, { kind: 'hourly', amount: 20, effectiveFrom: '2026-01-01' },
    { kind: 'deduction_percent', rate: 10, effectiveFrom: '2026-01-01' }, { kind: 'deduction_fixed', amount: 50, label: 'Seguro', effectiveFrom: '2026-01-01' }]) {
    assert.equal((await conta('POST', A(`/payroll/people/${luisId}/components`), body)).status, 201);
  }
  salaryId = (await conta('GET', A('/payroll/people'))).body.find((p: any) => p.id === luisId).components.find((x: any) => x.kind === 'salary').id;
  // Ana enlazada a su usuario: comisión + 5 % de lo vendido
  const ap = await conta('POST', A('/payroll/people'), { name: 'Ana', userId: anaId, calendarId: calId, payMethod: 'ach' });
  anaPersonId = ap.body.id;
  await conta('POST', A(`/payroll/people/${anaPersonId}/components`), { kind: 'sales_commission', effectiveFrom: '2026-01-01' });
  await conta('POST', A(`/payroll/people/${anaPersonId}/components`), { kind: 'sales_percent', rate: 5, effectiveFrom: '2026-01-01' });
  assert.equal((await conta('POST', A('/payroll/people'), { name: 'Ana bis', userId: anaId, calendarId: calId, payMethod: 'ach' })).body.code, 'user_already_in_payroll');
  // Componente incoherente
  assert.equal((await conta('POST', A(`/payroll/people/${luisId}/components`), { kind: 'salary', rate: 5, effectiveFrom: '2026-01-01' })).status, 400);

  const r = await conta('POST', A('/payroll/runs'), { calendarId: calId, periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-30' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  runId = r.body.id;
  assert.equal(r.body.status, 'draft');
  const line = (name: string, run: any) => run.lines.find((l: any) => l.personName === name);
  luisLine = line('Luis Pérez', r.body).id;
  anaLine = line('Ana', r.body).id;
  assert.deepEqual([line('Luis Pérez', r.body).gross, line('Luis Pérez', r.body).deductions, line('Luis Pérez', r.body).net], [2000, 250, 1750]);
  const a = line('Ana', r.body);
  assert.deepEqual([a.gross, a.deductions, a.net], [645, 0, 645]);
  assert.deepEqual(a.breakdown.map((i: any) => [i.kind, i.amount]), [['sales_commission', 585], ['sales_percent', 60]]);
  assert.equal((await conta('POST', A('/payroll/runs'), { calendarId: calId, periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-30' })).body.code, 'run_exists');
});

test('corrida: horas y ajustes se conservan al recalcular; solo Owner/Admin aprueba; aprobada queda congelada', async () => {
  const L = (run: any) => run.lines.find((l: any) => l.id === luisLine);
  let r = await conta('PATCH', A(`/payroll/runs/${runId}/lines/${luisLine}`), { hours: 10 });
  assert.deepEqual([L(r.body).hours, L(r.body).gross, L(r.body).deductions, L(r.body).net], [10, 2200, 270, 1930]);
  r = await conta('POST', A(`/payroll/runs/${runId}/adjustments`), { personId: luisId, kind: 'bonus', label: 'Bono puntual', amount: 100 });
  assert.equal(r.status, 201);
  r = await conta('POST', A(`/payroll/runs/${runId}/adjustments`), { personId: luisId, kind: 'deduction', label: 'Adelanto', amount: 30 });
  assert.deepEqual([L(r.body).gross, L(r.body).deductions, L(r.body).net], [2300, 310, 1990]);
  const adj = L(r.body).adjustments.find((x: any) => x.kind === 'deduction').id;
  r = await conta('DELETE', A(`/payroll/runs/${runId}/adjustments/${adj}`));
  assert.deepEqual([L(r.body).gross, L(r.body).deductions, L(r.body).net], [2300, 280, 2020]);
  r = await conta('POST', A(`/payroll/runs/${runId}/recalculate`));
  assert.deepEqual([L(r.body).hours, L(r.body).gross, L(r.body).net, L(r.body).adjustments.length], [10, 2300, 2020, 1]);
  assert.equal((await conta('POST', A(`/payroll/runs/${runId}/adjustments`), { personId: randomUUID(), kind: 'bonus', label: 'X', amount: 1 })).body.code, 'person_not_in_run');

  const no = await conta('POST', A(`/payroll/runs/${runId}/approve`));
  assert.equal(no.status, 403);
  const ok = await owner('POST', A(`/payroll/runs/${runId}/approve`));
  assert.deepEqual([ok.body.status, ok.body.approvedBy], ['approved', ownerId]);
  assert.deepEqual(ok.body.totals, { people: 2, gross: 2945, deductions: 280, net: 2665, paid: 0 });
  // Congelada: subir el sueldo o borrar componentes no la toca; tampoco se editan horas ni ajustes
  await owner('PATCH', A(`/payroll/components/${salaryId}`), { amount: 3000 });
  const fixedId = (await owner('GET', A('/payroll/people'))).body.find((p: any) => p.id === luisId).components.find((x: any) => x.kind === 'deduction_fixed').id;
  await owner('DELETE', A(`/payroll/components/${fixedId}`));
  const g = await owner('GET', A(`/payroll/runs/${runId}`));
  assert.deepEqual([L(g.body).gross, L(g.body).deductions, L(g.body).breakdown.find((i: any) => i.kind === 'salary').amount], [2300, 280, 2000]);
  assert.equal((await conta('PATCH', A(`/payroll/runs/${runId}/lines/${luisLine}`), { hours: 1 })).body.code, 'run_not_draft');
  assert.equal((await conta('POST', A(`/payroll/runs/${runId}/recalculate`))).body.code, 'run_not_draft');
  assert.equal((await owner('DELETE', A(`/payroll/runs/${runId}`))).body.code, 'run_not_draft');
});

test('corrida: pagar parcial y total, deshacer, reabrir con pagos → 409', async () => {
  // El Contable sí marca pagada una aprobada
  let r = await conta('POST', A(`/payroll/runs/${runId}/pay`), { lineIds: [luisLine], paidAt: '2026-09-30', reference: 'ZELLE-1' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.status, r.body.totals.paid], ['approved', 2020]);
  assert.equal(r.body.lines.find((l: any) => l.id === luisLine).reference, 'ZELLE-1');
  assert.equal((await conta('POST', A(`/payroll/runs/${runId}/pay`), { lineIds: [randomUUID()], paidAt: '2026-09-30' })).body.code, 'invalid_lines');
  const re = await owner('POST', A(`/payroll/runs/${runId}/reopen`));
  assert.equal(re.status, 409);
  assert.equal(re.body.code, 'run_has_payments');
  r = await conta('POST', A(`/payroll/runs/${runId}/pay`), { paidAt: '2026-10-01' });
  assert.deepEqual([r.body.status, r.body.paidAt, r.body.totals.paid], ['paid', '2026-10-01', 2665]);
  assert.equal(r.body.lines.find((l: any) => l.id === luisLine).paidAt, '2026-09-30');   // la ya pagada conserva su fecha
  // CSV de la corrida
  const csv = await owner('GET', A(`/payroll/runs/${runId}/export.csv`));
  assert.match(csv.body, /"Luis Pérez","Zelle","10","2300.00","280.00","2020.00","2026-09-30","ZELLE-1"/);
  // Deshacer todos los pagos → vuelve a aprobada; ya se puede reabrir (solo Owner/Admin) y recalcula con el sueldo nuevo
  r = await conta('POST', A(`/payroll/runs/${runId}/pay`), { paidAt: null });
  assert.deepEqual([r.body.status, r.body.paidAt, r.body.totals.paid], ['approved', null, 0]);
  assert.ok(r.body.lines.every((l: any) => l.paidAt === null && l.reference === ''));
  assert.equal((await conta('POST', A(`/payroll/runs/${runId}/reopen`))).status, 403);
  r = await owner('POST', A(`/payroll/runs/${runId}/reopen`));
  assert.equal(r.body.status, 'draft');
  const L = r.body.lines.find((l: any) => l.id === luisLine);
  assert.deepEqual([L.gross, L.deductions, L.net], [3300, 330, 2970]);   // 3000 + 10 h × 20 + 100; 10 %; sin la deducción fija borrada
  // Pagar un borrador no se puede
  assert.equal((await conta('POST', A(`/payroll/runs/${runId}/pay`), { paidAt: '2026-10-01' })).body.code, 'run_not_approved');
});

test('nómina: chargeback pagado en el periodo entra como deducción y deja neto negativo; CSV sin apóstrofo en -230.00', async () => {
  const sale = (await owner('GET', `/w/${slugA}/sales`)).body.items.find((s: any) => s.agentUserId === anaId);
  assert.equal((await owner('POST', `/w/${slugA}/sales/${sale.id}/cancel`, { chargebackPercent: 100 })).body.status, 'cancelled');
  const cb = (await owner('GET', `/w/${slugA}/commissions`)).body.items.find((i: any) => i.part === 'chargeback' && i.beneficiaryUserId === anaId);
  assert.equal(cb.amount, -585);
  await owner('POST', `/w/${slugA}/commissions/pay`, { ids: [cb.id], paidAt: '2026-10-05' });
  const oct = await conta('POST', A('/payroll/runs'), { calendarId: calId, periodStart: '2026-10-01', periodEnd: '2026-10-31', payDate: '2026-10-31' });
  const a = oct.body.lines.find((l: any) => l.personId === anaPersonId);
  assert.deepEqual([a.gross, a.deductions, a.net], [0, 585, -585]);
  assert.ok(a.breakdown.some((i: any) => i.label === 'Chargebacks de comisión' && i.amount === 585));
  assert.equal(a.breakdown.at(-1).label, 'Neto negativo');
  // El calendario sugiere el primer periodo sin corrida
  const cal = (await conta('GET', A('/payroll/calendars'))).body.find((c: any) => c.id === calId);
  assert.deepEqual(cal.nextPeriod, { periodStart: '2026-11-01', periodEnd: '2026-11-30', payDate: '2026-11-30' });
  assert.equal(cal.people, 2);

  // Neto −230 en el CSV: un número negativo NO lleva apóstrofo
  negCalId = (await conta('POST', A('/payroll/calendars'), { name: 'Quincenal', frequency: 'semimonthly' })).body.id;
  const neg = (await conta('POST', A('/payroll/people'), { name: '-Persona Neg', calendarId: negCalId, payMethod: 'cash' })).body;
  await conta('POST', A(`/payroll/people/${neg.id}/components`), { kind: 'deduction_fixed', amount: 230, effectiveFrom: '2026-01-01' });
  const nr = await conta('POST', A('/payroll/runs'), { calendarId: negCalId, periodStart: '2026-09-01', periodEnd: '2026-09-15', payDate: '2026-09-15' });
  assert.equal(nr.body.lines[0].net, -230);
  const csv = (await conta('GET', A(`/payroll/runs/${nr.body.id}/export.csv`))).body as string;
  assert.ok(csv.includes('"-230.00"'), csv);
  assert.ok(!csv.includes("'-230.00"), 'el número negativo lleva apóstrofo');
  assert.ok(csv.includes(`"'-Persona Neg"`), 'el texto que empieza con - no se neutralizó');
});

// ═══════════════════════════ 5. Banco ═══════════════════════════

test('parseCsv: BOM, comillas escapadas, CRLF, salto dentro de comillas, líneas en blanco y separador ;', () => {
  const recs = parseCsv('﻿Fecha,Detalle,Monto\r\n10/01/2026,"ACME, Inc. ""LLC""",10.00\r\n"10/02/2026","línea uno\nlínea dos",5\r\n\r\n10/03/2026,x,1', ',');
  assert.deepEqual(recs, [
    { line: 1, cells: ['Fecha', 'Detalle', 'Monto'] },
    { line: 2, cells: ['10/01/2026', 'ACME, Inc. "LLC"', '10.00'] },
    { line: 3, cells: ['10/02/2026', 'línea uno\nlínea dos', '5'] },
    { line: 6, cells: ['10/03/2026', 'x', '1'] },
  ]);
  assert.deepEqual(parseCsv('a;b;"c;d"\n1;2;3', ';').map((r) => r.cells), [['a', 'b', 'c;d'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('a,b\rc,d', ',').map((r) => r.cells), [['a', 'b'], ['c', 'd']]);   // CR solo (Mac viejo)
  assert.equal(detectDelimiter('﻿Fecha;Concepto;Importe\n'), ';');
  assert.equal(detectDelimiter('"a,b,c";x;y\n'), ';');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.equal(detectDelimiter('a,b|c,d'), ',');
});

test('fechas y montos del CSV', () => {
  assert.equal(parseCsvDate('10/05/2026', 'MM/DD/YYYY'), '2026-10-05');
  assert.equal(parseCsvDate('10/05/2026', 'DD/MM/YYYY'), '2026-05-10');
  assert.equal(parseCsvDate('2026-1-5', 'YYYY-MM-DD'), '2026-01-05');
  assert.equal(parseCsvDate('1/5/26', 'MM/DD/YY'), '2026-01-05');
  assert.equal(parseCsvDate('10/05/2026 08:30:00', 'MM/DD/YYYY'), '2026-10-05');
  assert.equal(parseCsvDate('10-05-2026', 'MM-DD-YYYY'), '2026-10-05');
  assert.equal(parseCsvDate('02/30/2026', 'MM/DD/YYYY'), null);
  assert.equal(parseCsvDate('10/05/2026', 'MM/DD/YY'), null);
  assert.equal(parseCsvDate('10/05/26', 'MM/DD/YYYY'), null);
  assert.equal(parseCsvDate('ayer', 'MM/DD/YYYY'), null);

  assert.equal(parseCsvAmount('(1,234.56)'), -1234.56);
  assert.equal(parseCsvAmount('($50.00)'), -50);
  assert.equal(parseCsvAmount('$1,234.56'), 1234.56);
  assert.equal(parseCsvAmount('-$50.00'), -50);
  assert.equal(parseCsvAmount('50.00-'), -50);
  assert.equal(parseCsvAmount('+12'), 12);
  assert.equal(parseCsvAmount('1.234,56'), 1234.56);
  assert.equal(parseCsvAmount('12,5'), 12.5);
  assert.equal(parseCsvAmount('1,234'), 1234);
  assert.equal(parseCsvAmount(' USD 10 '), 10);
  assert.equal(parseCsvAmount(''), null);
  assert.equal(parseCsvAmount('abc'), null);
  assert.equal(parseCsvAmount('$'), null);

  const base = { delimiter: ',', hasHeader: false, skipRows: 0, dateColumn: 0, dateFormat: 'MM/DD/YYYY', descriptionColumn: 1, referenceColumn: 2 } as const;
  const split = { ...base, amount: { mode: 'split', debitColumn: 3, creditColumn: 4 } } as const;
  const row = (cells: string[]) => ({ line: 7, cells });
  assert.equal(interpretRow(row(['10/01/2026', 'Renta', 'R1', '100.00', '']), split).amount, -100);
  assert.equal(interpretRow(row(['10/01/2026', 'Depósito', '', '', '250']), split).amount, 250);
  assert.equal(interpretRow(row(['10/01/2026', 'x', '', '', '']), split).error, 'Monto ilegible');
  const inv = { ...base, amount: { mode: 'single', column: 3, invert: true } } as const;
  assert.equal(interpretRow(row(['10/01/2026', 'Salida', '', '45.10']), inv).amount, -45.1);
  const r = interpretRow(row(['10/01/2026', '  ACH   DEP  ', ' REF9 ', '0.00']), inv);
  assert.deepEqual([r.line, r.description, r.reference, r.error], [7, 'ACH DEP', 'REF9', 'Monto en cero']);
  assert.equal(interpretRow(row(['13/45/2026', 'x', '', '1']), inv).error, 'Fecha ilegible');

  assert.equal(dedupeKey('2026-10-01', 10, '', '  ACH   Deposit '), '2026-10-01|10.00|ach deposit');
  assert.equal(dedupeKey('2026-10-01', -10.5, 'R-1', 'lo que sea'), '2026-10-01|-10.50|R-1');
});

test('suggestCarrier: nombre o alias como palabra completa, la coincidencia más larga y solo entradas', () => {
  const carriers = [
    { id: 'americo', name: 'Americo', aliases: ['americo'] },
    { id: 'americo-fin', name: 'Americo Financial', aliases: ['americo fin'] },
    { id: 'moo', name: 'Mutual of Omaha', aliases: ['moo'] },
  ];
  assert.equal(suggestCarrier('AMERICO FIN LIFE ACH 123', 100, carriers), 'americo-fin');
  assert.equal(suggestCarrier('DEP AMÉRICO', 100, carriers), 'americo');
  assert.equal(suggestCarrier('MOO COMMISSIONS 10/2026', 100, carriers), 'moo');
  assert.equal(suggestCarrier('MUTUAL OF OMAHA INS', 100, carriers), 'moo');
  assert.equal(suggestCarrier('SMOOTHIE KING', 100, carriers), null);   // "moo" dentro de otra palabra no cuenta
  assert.equal(suggestCarrier('AMERICOX', 100, carriers), null);
  assert.equal(suggestCarrier('MOO CHARGEBACK', -100, carriers), null);
  assert.equal(suggestCarrier('MOO', null, carriers), null);
});

let accountA = '', manualTx = '', statementA = '', csvFile = '';
const CSV = [
  'Chase export generado 10/11/2026',
  'Date,Description,Amount,Ref',
  '10/01/2026,AMERICO FIN LIFE ACH,"1,500.00",R1',
  '10/02/2026,Office rent,(2000.00),R2',
  '10/02/2026,Office rent,(2000.00),R2',
  '10/03/2026,Fila mala,abc,R3',
  '10/04/2026,MOO COMMISSION,250.00,',
].join('\r\n');
const MAPPING = { delimiter: ',', hasHeader: true, skipRows: 1, dateColumn: 0, dateFormat: 'MM/DD/YYYY', descriptionColumn: 1,
  referenceColumn: 3, amount: { mode: 'single', column: 2, invert: false } };

test('banco: carga manual avisa possibleDuplicate sin bloquear', async () => {
  const a = await conta('POST', A('/bank/accounts'), { name: 'Chase operativa', bankName: 'Chase', last4: '1234' });
  assert.equal(a.status, 201);
  assert.deepEqual([a.body.hasMapping, a.body.lastStatementTo, a.body.isActive], [false, null, true]);
  accountA = a.body.id;
  const t1 = await conta('POST', A('/bank/transactions'), { accountId: accountA, postedOn: '2026-10-01', description: 'Depósito Americo', amount: 1500, reference: 'R1' });
  assert.equal(t1.status, 201);
  assert.deepEqual([t1.body.possibleDuplicate, t1.body.source, t1.body.matchStatus], [false, 'manual', 'unmatched']);
  manualTx = t1.body.id;
  const t2 = await conta('POST', A('/bank/transactions'), { accountId: accountA, postedOn: '2026-10-01', description: 'otra', amount: 1500, reference: 'R1' });
  assert.equal(t2.body.possibleDuplicate, true);
  // Sin referencia: la descripción normalizada decide
  const t3 = await conta('POST', A('/bank/transactions'), { accountId: accountA, postedOn: '2026-10-07', description: 'Pago  Luz', amount: -80 });
  const t4 = await conta('POST', A('/bank/transactions'), { accountId: accountA, postedOn: '2026-10-07', description: 'pago luz', amount: -80 });
  assert.deepEqual([t3.body.possibleDuplicate, t4.body.possibleDuplicate], [false, true]);
  assert.equal((await conta('POST', A('/bank/transactions'), { accountId: accountA, postedOn: '2026-10-07', amount: 0 })).status, 400);
  // Los manuales se editan y se borran
  const e = await conta('PATCH', A(`/bank/transactions/${t2.body.id}`), { amount: 1499.99, carrierId: carrierA });
  assert.deepEqual([e.body.amount, e.body.carrierId], [1499.99, carrierA]);
  assert.equal((await conta('DELETE', A(`/bank/transactions/${t2.body.id}`))).status, 204);
  assert.equal((await conta('DELETE', A(`/bank/transactions/${t4.body.id}`))).status, 204);
  const l = (await conta('GET', A(`/bank/transactions?accountId=${accountA}`))).body;
  assert.deepEqual(l.totals, { count: 2, inflow: 1500, outflow: 80, net: 1420 });
  assert.deepEqual((await conta('GET', A(`/bank/transactions?accountId=${accountA}&direction=out`))).body.items.map((t: any) => t.id), [t3.body.id]);
});

test('banco: importación CSV con vista previa, duplicados omitidos, compañía sugerida y mapeo guardado', async () => {
  await owner('POST', `/w/${slugA}/carriers`, { name: 'Mutual of Omaha', aliases: ['MOO'] });
  const moo = (await owner('GET', `/w/${slugA}/carriers`)).body.find((c: any) => c.name === 'Mutual of Omaha').id;
  csvFile = await upload(conta, slugA, 'chase.csv', 'text/csv', CSV, 'bank_statement');
  // Sin mapeo guardado ni enviado: solo lo crudo
  const raw = await conta('POST', A('/bank/import/preview'), { accountId: accountA, fileId: csvFile });
  assert.equal(raw.status, 200, JSON.stringify(raw.body));
  assert.deepEqual([raw.body.mapping, raw.body.rows], [null, []]);
  assert.ok(raw.body.sample.length > 0);

  const p = await conta('POST', A('/bank/import/preview'), { accountId: accountA, fileId: csvFile, mapping: MAPPING });
  assert.deepEqual(p.body.headers, ['Date', 'Description', 'Amount', 'Ref']);
  assert.deepEqual(p.body.totals, { rows: 5, valid: 3, duplicates: 1, invalid: 1 });
  assert.deepEqual(p.body.period, { from: '2026-10-01', to: '2026-10-04' });
  assert.deepEqual(p.body.rows.map((r: any) => [r.line, r.amount, r.duplicate, r.error, r.carrierId]), [
    [3, 1500, true, null, carrierA],           // ya cargado a mano (fecha|monto|referencia)
    [4, -2000, false, null, null],
    [5, -2000, false, null, null],             // repetida dentro del mismo archivo: se conserva
    [6, null, false, 'Monto ilegible', null],
    [7, 250, false, null, moo],
  ]);

  // Commit: corrige la compañía de la línea 7 a ninguna
  const c = await conta('POST', A('/bank/import/commit'), { accountId: accountA, fileId: csvFile, mapping: MAPPING, carriers: [{ line: 7, carrierId: null }] });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([c.body.rowsImported, c.body.rowsSkipped, c.body.periodFrom, c.body.periodTo, c.body.importedBy], [3, 1, '2026-10-01', '2026-10-04', contaId]);
  assert.equal(c.body.file.id, csvFile);
  statementA = c.body.id;
  const imported = (await conta('GET', A(`/bank/transactions?statementId=${statementA}`))).body.items;
  assert.equal(imported.length, 3);
  assert.ok(imported.every((t: any) => t.source === 'csv' && t.carrierId === null));
  // Mapeo guardado por cuenta: la vista previa lo usa sin enviarlo
  assert.deepEqual((await conta('GET', A(`/bank/accounts/${accountA}/csv-mapping`))).body, MAPPING);
  const acc = (await conta('GET', A('/bank/accounts'))).body.find((a: any) => a.id === accountA);
  assert.deepEqual([acc.hasMapping, acc.lastStatementTo], [true, '2026-10-04']);
  const again = await conta('POST', A('/bank/import/preview'), { accountId: accountA, fileId: csvFile });
  assert.deepEqual([again.body.mapping, again.body.totals.duplicates], [MAPPING, 4]);
  // Segundo commit del mismo archivo: nada nuevo
  const dup = await conta('POST', A('/bank/import/commit'), { accountId: accountA, fileId: csvFile, mapping: MAPPING });
  assert.equal(dup.status, 400);
  assert.equal(dup.body.code, 'nothing_to_import');
});

test('banco: movimientos importados solo editan compañía, notas y cruce; deshacer el estado de cuenta los borra', async () => {
  const t = (await conta('GET', A(`/bank/transactions?statementId=${statementA}`))).body.items[0];
  for (const body of [{ amount: 1 }, { postedOn: '2026-01-01' }, { description: 'x' }, { reference: 'x' }]) {
    const r = await conta('PATCH', A(`/bank/transactions/${t.id}`), body);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'imported_transaction');
  }
  const ok = await conta('PATCH', A(`/bank/transactions/${t.id}`), { notes: 'revisado', matchStatus: 'ignored', carrierId: carrierA });
  assert.deepEqual([ok.body.notes, ok.body.matchStatus, ok.body.carrierId, ok.body.amount], ['revisado', 'ignored', carrierA, t.amount]);
  assert.equal((await conta('DELETE', A(`/bank/transactions/${t.id}`))).body.code, 'imported_transaction');
  // CSV de movimientos: entradas y salidas en positivo
  const csv = (await conta('GET', A('/bank/transactions.csv'))).body as string;
  assert.match(csv, /"2026-10-02","Chase operativa","Office rent","","2000.00","R2"/);

  assert.equal((await conta('DELETE', A(`/bank/statements/${statementA}`))).status, 204);
  assert.equal((await conta('GET', A(`/bank/transactions?statementId=${statementA}`))).body.items.length, 0);
  assert.equal((await conta('GET', A(`/bank/transactions?accountId=${accountA}`))).body.items.some((x: any) => x.id === manualTx), true);
  assert.equal((await conta('DELETE', A(`/bank/statements/${statementA}`))).status, 404);
  // Tras deshacer se puede volver a importar
  const re = await conta('POST', A('/bank/import/commit'), { accountId: accountA, fileId: csvFile, mapping: MAPPING, saveMapping: false });
  assert.equal(re.body.rowsImported, 3);
  statementA = re.body.id;
});

// ═══════════════════════════ 6. Aislamiento entre agencias ═══════════════════════════

test('aislamiento: la agencia B no ve ni toca nada de la A con IDs de la A', async () => {
  // Datos propios de B para comprobar que los listados no se mezclan
  const expB = (await outsider('POST', B('/expenses'), { categoryId: catB, vendor: 'B vendor', dueDate: '2026-11-01', amount: 10, payMethod: 'card' })).body;
  const accB = (await outsider('POST', B('/bank/accounts'), { name: 'Cuenta B' })).body;
  const calB = (await outsider('POST', B('/payroll/calendars'), { name: 'Mensual B', frequency: 'monthly' })).body;
  assert.ok(expB.id && accB.id && calB.id);

  const exA = (await owner('GET', A('/expenses'))).body.items[0].id;
  const schA = scheduleId;
  const people = (await owner('GET', A('/payroll/people'))).body;
  const compA = people.find((p: any) => p.id === luisId).components[0].id;
  const txA = (await owner('GET', A(`/bank/transactions?accountId=${accountA}`))).body.items[0].id;
  const adjA = (await owner('GET', A(`/payroll/runs/${runId}`))).body.lines.find((l: any) => l.id === luisLine).adjustments[0].id;
  const calls: [string, string, unknown?][] = [
    ['PATCH', `/expense-categories/${rentA}`, { name: 'Robada' }],
    ['PATCH', `/expenses/${exA}`, { notes: 'x' }], ['DELETE', `/expenses/${exA}`],
    ['POST', `/expenses/${exA}/approve`], ['POST', `/expenses/${exA}/reject`], ['POST', `/expenses/${exA}/pay`, { paidAt: '2026-10-01' }],
    ['POST', `/expenses/${exA}/skip`], ['POST', `/expenses/${exA}/reopen`],
    ['PATCH', `/expense-schedules/${schA}`, { vendor: 'x' }], ['POST', `/expense-schedules/${schA}/approve`], ['POST', `/expense-schedules/${schA}/reject`],
    ['PATCH', `/payroll/calendars/${calId}`, { name: 'x' }],
    ['PATCH', `/payroll/people/${luisId}`, { name: 'x' }], ['POST', `/payroll/people/${luisId}/components`, { kind: 'bonus', amount: 1, effectiveFrom: '2026-01-01' }],
    ['PATCH', `/payroll/components/${compA}`, { label: 'x' }], ['DELETE', `/payroll/components/${compA}`],
    ['GET', `/payroll/runs/${runId}`], ['PATCH', `/payroll/runs/${runId}`, { notes: 'x' }], ['DELETE', `/payroll/runs/${runId}`],
    ['POST', `/payroll/runs/${runId}/recalculate`], ['PATCH', `/payroll/runs/${runId}/lines/${luisLine}`, { hours: 1 }],
    ['POST', `/payroll/runs/${runId}/adjustments`, { personId: luisId, kind: 'bonus', label: 'x', amount: 1 }],
    ['DELETE', `/payroll/runs/${runId}/adjustments/${adjA}`],
    ['POST', `/payroll/runs/${runId}/approve`], ['POST', `/payroll/runs/${runId}/reopen`], ['POST', `/payroll/runs/${runId}/pay`, { paidAt: null }],
    ['GET', `/payroll/runs/${runId}/export.csv`],
    ['PATCH', `/bank/accounts/${accountA}`, { name: 'x' }], ['GET', `/bank/accounts/${accountA}/csv-mapping`], ['PUT', `/bank/accounts/${accountA}/csv-mapping`, MAPPING],
    ['PATCH', `/bank/transactions/${txA}`, { notes: 'x' }], ['DELETE', `/bank/transactions/${txA}`],
    ['DELETE', `/bank/statements/${statementA}`],
    ['POST', '/bank/transactions', { accountId: accountA, postedOn: '2026-10-01', amount: 5 }],
    ['POST', '/bank/import/preview', { accountId: accountA, fileId: csvFile, mapping: MAPPING }],
    ['POST', '/bank/import/preview', { accountId: accB.id, fileId: csvFile, mapping: MAPPING }],   // archivo de la A con cuenta propia
    ['POST', '/bank/import/commit', { accountId: accB.id, fileId: csvFile, mapping: MAPPING }],
    ['POST', '/expenses', { categoryId: rentA, vendor: 'x', dueDate: '2026-11-01', amount: 1, payMethod: 'card' }],
    ['POST', '/expense-schedules', { categoryId: rentA, vendor: 'x', amount: 1, payMethod: 'card', frequency: 'daily', startsOn: today }],
    ['PATCH', `/expenses/${expB.id}`, { categoryId: rentA }],
  ];
  for (const [method, path, body] of calls) {
    const r = await outsider(method, B(path), body);
    assert.equal(r.status, 404, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  // Referencias de la A en el cuerpo → 400
  for (const body of [{ name: 'x', calendarId: calId, payMethod: 'ach' }, { name: 'x', calendarId: calB.id, payMethod: 'ach', userId: anaId }]) {
    const r = await outsider('POST', B('/payroll/people'), body);
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.equal((await outsider('POST', B('/payroll/runs'), { calendarId: calId, periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-30' })).status, 404);
  assert.equal((await outsider('POST', B('/expenses'), { categoryId: catB, vendor: 'x', dueDate: '2026-11-01', amount: 1, payMethod: 'card', fileId: csvFile })).body.code, 'invalid_file');

  // Listados de B sin nada de A (y al revés)
  const idsOf = async (c: Client, path: string, pick: (b: any) => any[]) => pick((await c('GET', path)).body).map((x: any) => x.id);
  const checks: [string, (b: any) => any[]][] = [
    ['/expenses', (b) => b.items], ['/expense-schedules', (b) => b], ['/expense-categories', (b) => b], ['/payroll/calendars', (b) => b],
    ['/payroll/people', (b) => b], ['/payroll/runs', (b) => b], ['/bank/accounts', (b) => b], ['/bank/transactions', (b) => b.items],
    ['/bank/statements', (b) => b],
  ];
  for (const [p, pick] of checks) {
    const a = new Set(await idsOf(owner, A(p), pick));
    const b = await idsOf(outsider, B(p), pick);
    assert.ok(b.every((id) => !a.has(id)), `fuga en ${p}`);
  }
  assert.deepEqual((await outsider('GET', B('/expenses'))).body.items.map((e: any) => e.id), [expB.id]);
  assert.deepEqual((await outsider('GET', B('/vendors'))).body, ['B vendor']);
  assert.equal((await outsider('GET', B('/expenses.csv'))).body.includes('Brickell'), false);
  // Un no miembro tampoco entra por el slug de A
  assert.equal((await outsider('GET', A('/expenses'))).status, 404);
  // Lo de A sigue intacto
  assert.equal((await owner('GET', A('/expense-categories'))).body.find((c: any) => c.id === rentA).name, 'Renta');
  assert.equal((await owner('GET', A(`/payroll/runs/${runId}`))).status, 200);
});

test('aislamiento: carrierId de otra agencia en un movimiento se rechaza', async () => {
  const carrierB = (await outsider('POST', `/w/${slugB}/carriers`, { name: 'Compañía B' })).body.id;
  assert.ok(carrierB);
  const c = await conta('POST', A('/bank/transactions'), { accountId: accountA, postedOn: '2026-10-09', description: 'x', amount: 9, carrierId: carrierB });
  assert.equal(c.status, 400, JSON.stringify(c.body));
  const t = (await conta('GET', A(`/bank/transactions?accountId=${accountA}`))).body.items[0];
  assert.equal((await conta('PATCH', A(`/bank/transactions/${t.id}`), { carrierId: carrierB })).status, 400);
  const f = await upload(conta, slugA, 'otro.csv', 'text/csv', 'Date,Description,Amount\n10/20/2026,AMERICO,10.00', 'bank_statement');
  const commit = await conta('POST', A('/bank/import/commit'), { accountId: accountA, fileId: f,
    mapping: { ...MAPPING, skipRows: 0, referenceColumn: null }, carriers: [{ line: 2, carrierId: carrierB }] });
  assert.equal(commit.status, 400, JSON.stringify(commit.body));
  assert.equal((await conta('GET', A('/bank/transactions?from=2026-10-20&to=2026-10-20'))).body.items.length, 0);
});
