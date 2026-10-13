// Resumen de Finanzas (docs/plan-finanzas.md §5): totales del periodo (banco, gastos pagados por fecha de pago, nómina
// pagada, resultado), comisiones esperadas vs. pagadas, próximos pagos, vencidos, por aprobar y serie mensual;
// Miembro → 404 y aislamiento: la agencia B no ve nada de la A.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';
import { addDays } from '../src/finance/schedule.ts';

let server: Server;
let base = '';
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slugA = `sum-a-${run}`, slugB = `sum-b-${run}`;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });   // "hoy" del servidor (Nueva York)

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
    return { status: res.status, body: json };
  };
}
type Client = ReturnType<typeof client>;

// owner = Owner de A · conta = Contable de A · ana = Miembro de A · outsider = Owner de B (seguros, también con finanzas)
const owner = client(), conta = client(), ana = client(), outsider = client();
let wsA = '', wsB = '', anaId = '';
const A = (p: string) => `/w/${slugA}/finance${p}`;
const B = (p: string) => `/w/${slugB}/finance${p}`;

before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const reg = (c: Client, email: string, slug: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template: 'insurance_agency' } });
  await reg(owner, `owner-${run}@test.local`, slugA);
  await reg(outsider, `intruso-${run}@test.local`, slugB);
  const join = async (c: Client, name: string, role: string) => {
    const inv = await owner('POST', `/w/${slugA}/invitations`, { email: null, role });
    const acc = await c('POST', '/invitations/accept', {
      token: inv.body.url.split('/invite/')[1], newAccount: { name, password, locale: 'es', email: `${name.toLowerCase()}-${run}@test.local` } });
    return acc.body.user.id as string;
  };
  await join(conta, 'Contable', 'accountant');
  anaId = await join(ana, 'Ana', 'member');
  const ws = (await adminPool.query('select id, slug from workspaces where slug = any($1)', [[slugA, slugB]])).rows;
  wsA = ws.find((w) => w.slug === slugA).id;
  wsB = ws.find((w) => w.slug === slugB).id;
});

after(async () => {
  server.close();
  const ws = [wsA, wsB].filter(Boolean);
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
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from ws_tickets where user_id = any($1)', [users]).catch(() => {});
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

let rent = '', software = '', carrier = '';

test('resumen: banco, gastos pagados, nómina, resultado, comisiones, próximos pagos, vencidos y serie', async () => {
  const cats = (await owner('GET', A('/expense-categories'))).body;
  rent = cats.find((c: any) => c.name === 'Renta').id;
  software = cats.find((c: any) => c.name === 'Software').id;

  // Ventas: una cuota de adelanto pagada (esperada en septiembre)
  carrier = (await owner('POST', `/w/${slugA}/carriers`, { name: 'Americo' })).body.id;
  const pid = (await owner('POST', `/w/${slugA}/carriers/${carrier}/products`, { name: 'IUL' })).body.products[0].id;
  await owner('PUT', `/w/${slugA}/products/${pid}/grid`, { effectiveFrom: '2024-08-19', rows: [{ level: 80, rate: 65 }] });
  const anaAgent = (await owner('POST', `/w/${slugA}/agents`, { name: 'Ana', userId: anaId })).body.id;
  await owner('POST', `/w/${slugA}/agents/${anaAgent}/levels`, { carrierIds: [carrier], level: 80, effectiveFrom: '2026-01-01' });
  const sale = await owner('POST', `/w/${slugA}/sales`, { agentId: anaAgent, productId: pid, amount: 1200, clientName: 'Cliente', expectedIssueDate: '2026-08-05' });
  await owner('POST', `/w/${slugA}/sales/${sale.body.id}/issue`, { issuedAt: '2026-08-05' });
  const inst = (await owner('GET', `/w/${slugA}/commissions`)).body.items.filter((i: any) => i.saleId === sale.body.id && i.status !== 'void');
  const adv = inst.find((i: any) => i.part === 'advance');
  assert.equal((await owner('POST', `/w/${slugA}/commissions/pay`, { ids: [adv.id], paidAt: adv.dueDate })).status, 204);

  // Banco de agosto: dos entradas (una de Americo), una salida; y una de septiembre que no entra
  const acc = (await conta('POST', A('/bank/accounts'), { name: 'Operativa' })).body.id;
  for (const [postedOn, amount, carrierId] of [['2026-08-10', 1000, carrier], ['2026-08-20', 500.5, null], ['2026-08-21', -300, null], ['2026-09-02', 999, null]] as const) {
    assert.equal((await conta('POST', A('/bank/transactions'), { accountId: acc, postedOn, amount, carrierId, description: 'mov' })).status, 201);
  }

  // Gastos: pagados en agosto (uno vencía en julio: cuenta por fecha de pago), uno pagado en septiembre (no entra)
  const exp = (body: object) => owner('POST', A('/expenses'), { payMethod: 'card', ...body });
  await exp({ categoryId: rent, vendor: 'Oficina', dueDate: '2026-07-31', amount: 900, paid: { paidAt: '2026-08-02', paidAmount: 950 } });
  await exp({ categoryId: software, vendor: 'Kora', dueDate: '2026-08-15', amount: 49.99, paid: { paidAt: '2026-08-15' } });
  await exp({ categoryId: software, vendor: 'Otro', dueDate: '2026-08-30', amount: 10, paid: { paidAt: '2026-09-01' } });
  // Próximo (en 3 días), vencido (ayer) y uno del Contable por aprobar
  const soon = (await exp({ categoryId: rent, vendor: 'Luz', dueDate: addDays(today, 3), amount: 120 })).body.id;
  await exp({ categoryId: rent, vendor: 'Agua', dueDate: addDays(today, -1), amount: 40 });
  assert.equal((await conta('POST', A('/expenses'), { categoryId: software, vendor: 'Canva', dueDate: addDays(today, 2), amount: 15, payMethod: 'card' })).body.approvalStatus, 'pending');

  // Nómina: agosto pagada (neto 1000); una corrida aprobada sin pagar con pago en 5 días
  const cal = (await conta('POST', A('/payroll/calendars'), { name: 'Mensual', frequency: 'monthly', payDay: 'last' })).body.id;
  const luis = (await conta('POST', A('/payroll/people'), { name: 'Luis', calendarId: cal, payMethod: 'zelle' })).body.id;
  await conta('POST', A(`/payroll/people/${luis}/components`), { kind: 'salary', amount: 1000, effectiveFrom: '2026-01-01' });
  const aug = (await conta('POST', A('/payroll/runs'), { calendarId: cal, periodStart: '2026-08-01', periodEnd: '2026-08-31', payDate: '2026-08-31' })).body.id;
  await owner('POST', A(`/payroll/runs/${aug}/approve`), { version: (await owner('GET', A(`/payroll/runs/${aug}`))).body.version });
  assert.equal((await conta('POST', A(`/payroll/runs/${aug}/pay`), { paidAt: '2026-08-31' })).status, 200);
  const next = (await conta('POST', A('/payroll/runs'), { calendarId: cal, periodStart: '2026-12-01', periodEnd: '2026-12-31', payDate: addDays(today, 5) })).body.id;
  await owner('POST', A(`/payroll/runs/${next}/approve`), { version: (await owner('GET', A(`/payroll/runs/${next}`))).body.version });

  const r = await conta('GET', A('/summary?from=2026-08-01&to=2026-08-31'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body;
  assert.equal(s.today, today);
  assert.deepEqual([s.bank.inflow, s.bank.outflow], [1500.5, 300]);
  assert.deepEqual(s.bank.inflowByCarrier, [{ carrierId: carrier, amount: 1000, count: 1 }, { carrierId: null, amount: 500.5, count: 1 }]);
  assert.deepEqual([s.expenses.paid, s.expenses.count], [999.99, 2]);
  assert.deepEqual(s.expenses.byCategory, [{ categoryId: rent, amount: 950, count: 1 }, { categoryId: software, amount: 49.99, count: 1 }]);
  assert.deepEqual(s.payroll, { paid: 1000, lines: 1 });
  assert.equal(s.result, -499.49);   // 1500.50 − 999.99 − 1000

  // Comisiones del periodo de su vencimiento: sin rango cuentan todas las cuotas no anuladas
  const all = (await conta('GET', A('/summary'))).body;
  const expected = Math.round(inst.reduce((t: number, i: any) => t + i.amount * 100, 0)) / 100;
  assert.deepEqual(all.commissions, { expected, paid: adv.amount, count: inst.length, paidCount: 1 });
  assert.deepEqual(all.period, { from: null, to: null });

  // Próximos pagos (no dependen del periodo): el gasto aprobado y la corrida; ni el vencido ni el por aprobar
  assert.deepEqual(s.upcoming.map((u: any) => [u.kind, u.date, u.amount]),
    [['expense', addDays(today, 3), 120], ['payroll', addDays(today, 5), 1000]]);
  assert.equal(s.upcoming[0].id, soon);
  assert.equal(s.upcoming[1].detail, '2026-12-01|2026-12-31');
  assert.deepEqual(s.overdue, { count: 1, amount: 40 });
  assert.equal(s.pendingApprovals, 1);

  // Serie: 6 meses que terminan en el actual
  assert.equal(s.monthly.length, 6);
  assert.equal(s.monthly.at(-1).month, today.slice(0, 7));
  const augM = s.monthly.find((m: any) => m.month === '2026-08');
  if (augM) assert.deepEqual(augM, { month: '2026-08', inflow: 1500.5, spent: 1999.99 });

  // Rango invertido → 400
  assert.equal((await conta('GET', A('/summary?from=2026-08-31&to=2026-08-01'))).status, 400);
});

test('resumen: Miembro y no miembros → 404', async () => {
  const r = await ana('GET', A('/summary'));
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'module_not_found');
  assert.equal((await outsider('GET', A('/summary'))).status, 404);
});

test('aislamiento: el resumen de B no ve nada de la A', async () => {
  const r = await outsider('GET', B('/summary'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body;
  assert.deepEqual([s.bank.inflow, s.bank.outflow, s.expenses.paid, s.payroll.paid, s.result], [0, 0, 0, 0, 0]);
  assert.deepEqual([s.upcoming, s.bank.inflowByCarrier, s.expenses.byCategory], [[], [], []]);
  assert.deepEqual([s.overdue, s.pendingApprovals], [{ count: 0, amount: 0 }, 0]);
  assert.deepEqual(s.commissions, { expected: 0, paid: 0, count: 0, paidCount: 0 });
  assert.ok(s.monthly.every((m: any) => m.inflow === 0 && m.spent === 0));
});
