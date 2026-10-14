// Ventas y comisiones por HTTP: % por nivel FFL × tabla del producto, adelanto + resto mensual con override de un nivel, % congelado al ISSUE, chargebacks,
// visibilidad (agente / dueño de agencia / admin) y aislamiento: la agencia B no ve ni toca nada de la A.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';
import { commissionShares, installments } from '../src/sales/commissions.ts';
import { pollDiscord } from '../src/sales/discord.ts';
import { parseSale } from '../src/sales/parse.ts';

let server: Server;
let base = '';
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slugA = `ven-a-${run}`, slugB = `ven-b-${run}`;

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

const owner = client(), ana = client(), carlos = client(), omar = client(), outsider = client();
let anaId = '', carlosId = '', omarId = '', carrierId = '', iulId = '', saleId = '';
// Columnas de la guía IUL de FFL (revisión 08/19/2024) para los niveles de VFS
const INSTANT_DECISION = [{ level: 80, rate: 65 }, { level: 85, rate: 70 }, { level: 100, rate: 85 }, { level: 105, rate: 90 }];
const FLEX_LIFE = [{ level: 80, rate: 50 }, { level: 85, rate: 55 }, { level: 100, rate: 70 }, { level: 105, rate: 75 }];
const IULE = [{ level: 80, rate: 70 }, { level: 85, rate: 75 }, { level: 100, rate: 90 }, { level: 105, rate: 95 }];
const A = (p: string) => `/w/${slugA}${p}`;

before(async () => {
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const reg = (c: Client, email: string, slug: string, template: string) => c('POST', '/auth/register', {
    name: email.split('@')[0], email, password, locale: 'es', workspace: { name: slug, slug, template } });
  await reg(owner, `owner-${run}@test.local`, slugA, 'insurance_agency');
  await reg(outsider, `intruso-${run}@test.local`, slugB, 'blank');
  const join = async (c: Client, name: string) => {
    const inv = await owner('POST', A('/invitations'), { email: null, role: 'member' });
    const acc = await c('POST', '/invitations/accept', {
      token: inv.body.url.split('/invite/')[1], newAccount: { name, password, locale: 'es', email: `${name.toLowerCase()}-${run}@test.local` } });
    return acc.body.user.id as string;
  };
  // Los agentes son asociados: aquí cada uno además tiene usuario (enlazado) para probar lo que ve cada quien
  const agent = async (name: string, userId: string) => (await owner('POST', A('/agents'), { name, userId })).body.id as string;
  anaId = await agent('Ana', await join(ana, 'Ana'));
  carlosId = await agent('Carlos', await join(carlos, 'Carlos'));
  omarId = await agent('Omar', await join(omar, 'Omar'));
});

after(async () => {
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB]])).rows.map((r) => r.id);
  await adminPool.query('update carriers set default_product_id = null where workspace_id = any($1)', [ws]);
  for (const t of ['sale_inbox', 'commission_installments', 'sales', 'agent_levels', 'comp_grid', 'agents', 'carrier_products', 'carriers',
    'discord_feeds', 'messages', 'channel_members', 'channels', 'audit_log', 'member_departments', 'member_lines', 'invitations',
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

// ═══ Cálculo puro ═══

test('comisión directa y override: 75 % al ISSUE y el resto en 3 cuotas de 1/12 (meses 10, 11 y 12)', () => {
  const rows = installments(120_000, 9, commissionShares({ agentId: 'ana', rate: 70 }, { agentId: 'carlos', rate: 90 }));
  assert.deepEqual(rows.map((r) => [r.beneficiaryAgentId, r.kind, r.part, r.seq, r.amountCents, r.monthsAfterIssue]), [
    ['ana', 'direct', 'advance', 0, 63_000, 0], ['ana', 'direct', 'remainder', 1, 7_000, 10],
    ['ana', 'direct', 'remainder', 2, 7_000, 11], ['ana', 'direct', 'remainder', 3, 7_000, 12],
    ['carlos', 'override', 'advance', 0, 18_000, 0], ['carlos', 'override', 'remainder', 1, 2_000, 10],
    ['carlos', 'override', 'remainder', 2, 2_000, 11], ['carlos', 'override', 'remainder', 3, 2_000, 12],
  ]);
});

test('redondeo: total no divisible entre 12, la última cuota absorbe la diferencia', () => {
  // 1199.88 × 72.5 % = 869.91 → adelanto 652.43; 1/12 = 72.49 → 72.49 + 72.49 + 72.50
  const rows = installments(119_988, 9, [{ beneficiaryAgentId: 'a', kind: 'direct', rate: 72.5 }]);
  assert.deepEqual(rows.map((r) => r.amountCents), [65_243, 7_249, 7_249, 7_250]);
  assert.equal(rows.reduce((t, r) => t + r.amountCents, 0), 86_991);
  // Barrido: en cualquier monto y adelanto la suma cuadra y no hay cuotas en 0 ni negativas
  for (let m = 0; m <= 12; m++) for (const c of [1, 5, 6, 7, 13, 18, 99, 1001, 100_006, 123_457]) {
    const r = installments(c * 100, m, [{ beneficiaryAgentId: 'a', kind: 'direct', rate: 1 }]);
    assert.equal(r.reduce((t, i) => t + i.amountCents, 0), c, `${c} con ${m}`);
    assert.ok(r.every((i) => i.amountCents > 0));
    assert.deepEqual(r.filter((i) => i.part === 'remainder').map((i) => i.seq), r.filter((i) => i.part === 'remainder').map((_, k) => k + 1));
  }
});

test('adelanto de 6 meses: 6 cuotas mensuales; de 12 meses: sin resto', () => {
  const six = installments(120_000, 6, [{ beneficiaryAgentId: 'a', kind: 'direct', rate: 65 }]);
  assert.deepEqual(six.map((r) => [r.part, r.seq, r.amountCents, r.monthsAfterIssue]), [
    ['advance', 0, 39_000, 0], ...[7, 8, 9, 10, 11, 12].map((m, k) => ['remainder', k + 1, 6_500, m])]);
  const twelve = installments(120_000, 12, [{ beneficiaryAgentId: 'a', kind: 'direct', rate: 65 }]);
  assert.deepEqual(twelve.map((r) => [r.part, r.seq, r.amountCents, r.monthsAfterIssue]), [['advance', 0, 78_000, 0]]);
});

test('override en 0 si el dueño no supera al agente; los centavos siempre cuadran', () => {
  assert.deepEqual(commissionShares({ agentId: 'a', rate: 90 }, { agentId: 'b', rate: 80 }).map((s) => s.kind), ['direct']);
  const rows = installments(119_988, 9, commissionShares({ agentId: 'a', rate: 72.5 }, null));
  assert.equal(rows.reduce((t, r) => t + r.amountCents, 0), Math.round(119_988 * 0.725));
});

// ═══ Configuración ═══

test('el módulo solo existe si la agencia lo tiene activo', async () => {
  assert.equal((await owner('GET', A(''))).body.settings.salesModule, true);   // plantilla de seguros
  const r = await outsider('GET', `/w/${slugB}/sales`);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'module_disabled');
});

test('compañías y productos: solo Admin los crea; los alias se guardan sin acentos', async () => {
  assert.equal((await ana('POST', A('/carriers'), { name: 'Americo' })).status, 403);
  const c = await owner('POST', A('/carriers'), { name: 'Americo', aliases: ['AMÉRICO', 'Americo'] });
  assert.equal(c.status, 201);
  assert.deepEqual(c.body.aliases, ['americo']);
  assert.equal(c.body.advanceMonths, 9);
  carrierId = c.body.id;
  const p = await owner('POST', A(`/carriers/${carrierId}/products`), { name: 'IUL', aliases: ['iul'] });
  iulId = p.body.products[0].id;
  assert.equal((await ana('PUT', A(`/products/${iulId}/grid`), { effectiveFrom: '2024-08-19', rows: INSTANT_DECISION })).status, 403);
  const g = await owner('PUT', A(`/products/${iulId}/grid`), { effectiveFrom: '2024-08-19', rows: INSTANT_DECISION });
  assert.deepEqual(g.body.products[0].grids, [{ effectiveFrom: '2024-08-19', rows: [...INSTANT_DECISION].reverse() }]);
  assert.equal((await ana('GET', A('/carriers'))).body.length, 1);   // todos los miembros los ven para filtrar
  // Producto por defecto: editar solo eso no borra los alias (pasó el 2026-10-10)
  const d = await owner('PATCH', A(`/carriers/${carrierId}`), { defaultProductId: iulId });
  assert.deepEqual([d.body.defaultProductId, d.body.aliases], [iulId, ['americo']]);
  const pr = await owner('PATCH', A(`/products/${iulId}`), { name: 'IUL' });
  assert.deepEqual(pr.body.products[0].aliases, ['iul']);
});

test('perfil de agente: dueño de agencia, Discord y nivel de contrato con vigencia', async () => {
  assert.equal((await ana('PATCH', A(`/agents/${anaId}`), { uplineAgentId: anaId })).status, 403);
  assert.equal((await owner('PATCH', A(`/agents/${anaId}`), { uplineAgentId: anaId })).status, 400);
  const p = await owner('PATCH', A(`/agents/${anaId}`), { uplineAgentId: carlosId, discordUserId: '123456789012' });
  assert.equal(p.body.uplineAgentId, carlosId);
  await owner('POST', A(`/agents/${anaId}/levels`), { carrierIds: [carrierId], level: 80, effectiveFrom: '2026-01-01' });
  await owner('POST', A(`/agents/${anaId}/levels`), { carrierIds: [carrierId], level: 85, effectiveFrom: '2027-01-01' });   // ascenso futuro
  const r = await owner('POST', A(`/agents/${carlosId}/levels`), { carrierIds: [carrierId], level: 105, effectiveFrom: '2026-01-01' });
  assert.deepEqual(r.body.levels, [{ carrierId, level: 105, effectiveFrom: '2026-01-01' }]);
  // Cada uno ve solo su perfil; el Admin ve a todos
  assert.deepEqual((await ana('GET', A('/agents'))).body.map((a: any) => a.id), [anaId]);
  assert.ok((await owner('GET', A('/agents'))).body.length >= 3);
});

test('agente asociado sin usuario: vende y cobra; al crearle usuario con su email se enlaza y ve lo suyo', async () => {
  assert.equal((await ana('POST', A('/agents'), { name: 'Intruso' })).status, 403);
  const r = await owner('POST', A('/agents'), { name: 'Lucía Díaz', email: `LUCIA-${run}@test.local` });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.userId, r.body.email], [null, `lucia-${run}@test.local`]);
  const lucia = r.body.id;
  assert.equal((await owner('POST', A('/agents'), { name: 'Otra', email: `lucia-${run}@test.local` })).body.code, 'agent_email_taken');
  // No es usuario: no aparece entre los miembros
  assert.ok(!(await owner('GET', A('/members'))).body.some((m: any) => m.name === 'Lucía Díaz'));
  const sale = await owner('POST', A('/sales'), { agentId: lucia, productId: iulId, amount: 300, clientName: 'Cliente de Lucía', expectedIssueDate: '2026-10-08' });
  assert.equal(sale.status, 201);
  // Se le crea usuario con el mismo email: queda enlazada y ve su venta (y nada de los demás)
  const u = await owner('POST', A('/members'), { name: 'Lucía Díaz', email: `lucia-${run}@test.local`, password: 'clave-lucia-123' });
  assert.equal((await owner('GET', A('/agents'))).body.find((a: any) => a.id === lucia).userId, u.body.userId);
  const lc = client();
  await lc('POST', '/auth/login', { email: `lucia-${run}@test.local`, password: 'clave-lucia-123' });
  assert.deepEqual((await lc('GET', A('/sales'))).body.items.map((s: any) => s.clientName), ['Cliente de Lucía']);
  // Archivar no borra su historial
  assert.ok((await owner('PATCH', A(`/agents/${lucia}`), { archived: true })).body.archivedAt);
  assert.equal((await owner('POST', A(`/sales/${sale.body.id}/decline`))).body.status, 'declined');
});

test('aislamiento de agentes: otra agencia no los ve, no los edita y no enlaza usuarios ajenos', async () => {
  await outsider('PATCH', `/w/${slugB}`, { settings: { salesModule: true } });
  assert.equal((await outsider('PATCH', `/w/${slugB}/agents/${anaId}`, { name: 'x' })).status, 404);
  assert.ok(!(await outsider('GET', `/w/${slugB}/agents`)).body.some((a: any) => a.id === anaId));
  const anaUser = (await owner('GET', A('/agents'))).body.find((a: any) => a.id === anaId).userId;
  assert.equal((await outsider('POST', `/w/${slugB}/agents`, { name: 'Robo', userId: anaUser })).body.code, 'invalid_user');
});

// ═══ Ventas y comisiones ═══

test('solo Admin registra ventas; quedan pendientes de ISSUE', async () => {
  const body = { agentId: anaId, productId: iulId, amount: 1200, clientName: 'Danielle Cardenas', clientState: 'NY', expectedIssueDate: '2026-10-08' };
  assert.equal((await ana('POST', A('/sales'), body)).status, 403);
  const s = await owner('POST', A('/sales'), body);
  assert.equal(s.status, 201);
  assert.equal(s.body.status, 'pending');
  assert.equal(s.body.uplineAgentId, carlosId);
  assert.equal(s.body.carrierId, carrierId);
  saleId = s.body.id;
});

test('fecha de venta: hoy si no se indica, la elegida si se indica; se corrige mientras está pendiente', async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  assert.equal((await owner('GET', A('/sales'))).body.items.find((x: any) => x.id === saleId).soldOn, today);
  const body = { agentId: anaId, productId: iulId, amount: 300, clientName: 'Fecha Vieja', expectedIssueDate: '2026-10-20', soldOn: '2026-10-02' };
  const s = await owner('POST', A('/sales'), body);
  assert.deepEqual([s.body.soldOn, s.body.expectedIssueDate], ['2026-10-02', '2026-10-20']);
  assert.equal((await owner('PATCH', A(`/sales/${s.body.id}`), { soldOn: '2026-10-03' })).body.soldOn, '2026-10-03');
  assert.equal((await ana('PATCH', A(`/sales/${s.body.id}`), { soldOn: '2026-10-04' })).status, 403);
  assert.equal((await outsider('PATCH', A(`/sales/${s.body.id}`), { soldOn: '2026-10-04' })).status, 404);
  // Filtro por fecha de venta (y por fecha de ISSUE, la de siempre)
  const ids = async (q: string) => (await owner('GET', A(`/sales?${q}`))).body.items.map((x: any) => x.id);
  assert.ok((await ids('dateBy=sold&from=2026-10-03&to=2026-10-03')).includes(s.body.id));
  assert.ok(!(await ids('dateBy=sold&from=2026-10-04&to=2026-10-31')).includes(s.body.id));
  assert.ok((await ids('from=2026-10-20&to=2026-10-20')).includes(s.body.id));
  assert.ok(!(await ids('dateBy=sold&from=2026-10-20&to=2026-10-20')).includes(s.body.id));
  assert.equal((await owner('GET', A('/sales?dateBy=otra'))).status, 400);
  assert.equal((await outsider('GET', A('/sales?dateBy=sold'))).status, 404);
  await owner('POST', A(`/sales/${s.body.id}/decline`));   // fuera del resto de las cuentas
});

test('sin nivel del agente no se puede marcar ISSUED', async () => {
  const s = await owner('POST', A('/sales'), { agentId: omarId, productId: iulId, amount: 500, clientName: 'Vilma', expectedIssueDate: '2026-10-09' });
  const r = await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-15' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'missing_level');
  assert.match(r.body.error, /Omar/);
  // Nivel que la tabla no tiene
  await owner('POST', A(`/agents/${omarId}/levels`), { carrierIds: [carrierId], level: 90, effectiveFrom: '2026-01-01' });
  const r2 = await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-15' });
  assert.equal(r2.body.code, 'missing_rate');
  assert.match(r2.body.error, /nivel 90/);
  const d = await owner('POST', A(`/sales/${s.body.id}/decline`));
  assert.equal(d.body.status, 'declined');
});

test('ISSUE genera las cuotas con el nivel y la tabla vigentes a esa fecha', async () => {
  assert.equal((await ana('POST', A(`/sales/${saleId}/issue`), { issuedAt: '2026-10-15' })).status, 403);
  const r = await owner('POST', A(`/sales/${saleId}/issue`), { issuedAt: '2026-10-15' });
  assert.equal(r.body.status, 'issued');
  assert.equal(r.body.issuedAt, '2026-10-15');
  const c = (await owner('GET', A('/commissions'))).body;
  // Ana nivel 80 → 65 %; Carlos nivel 105 → 90 %, override 25 %
  assert.deepEqual(c.items.map((i: any) => [i.beneficiaryAgentId, i.kind, i.part, i.level, i.rate, i.amount, i.dueDate]).sort(), [
    [anaId, 'direct', 'advance', 80, 65, 585, '2026-10-15'], [anaId, 'direct', 'remainder', 80, 65, 65, '2027-08-15'],
    [anaId, 'direct', 'remainder', 80, 65, 65, '2027-09-15'], [anaId, 'direct', 'remainder', 80, 65, 65, '2027-10-15'],
    [carlosId, 'override', 'advance', 105, 25, 225, '2026-10-15'], [carlosId, 'override', 'remainder', 105, 25, 25, '2027-08-15'],
    [carlosId, 'override', 'remainder', 105, 25, 25, '2027-09-15'], [carlosId, 'override', 'remainder', 105, 25, 25, '2027-10-15'],
  ].sort());
  assert.equal(c.totals.pending, 1080);
  // Cada cuota trae su número, el mes, el total de su comisión y el grupo completo de cuotas (incluida ella)
  const anas = c.items.filter((i: any) => i.beneficiaryAgentId === anaId);
  assert.deepEqual(anas.map((i: any) => [i.part, i.seq, i.month, i.of, i.total]), [
    ['advance', 0, 0, 4, 780], ['remainder', 1, 10, 4, 780], ['remainder', 2, 11, 4, 780], ['remainder', 3, 12, 4, 780]]);
  const group = anas.map((i: any) => ({ id: i.id, part: i.part, seq: i.seq, amount: i.amount, dueDate: i.dueDate, status: 'pending' }));
  assert.ok(anas.every((i: any) => JSON.stringify(i.group) === JSON.stringify(group)));
  // El CSV dice qué cuota es cada fila
  const csv = (await owner('GET', A('/commissions.csv'))).body;
  assert.match(csv, /"Adelanto al ISSUE · cuota 1 de 4"/);
  assert.match(csv, /"Resto · cuota 3 de 4 \(mes 11\)"/);
  assert.match(csv, /"Resto · cuota 4 de 4 \(mes 12\)","Ana","Danielle Cardenas"/);
  // Ya no se edita ni se vuelve a hacer ISSUE
  assert.equal((await owner('PATCH', A(`/sales/${saleId}`), { amount: 1 })).status, 409);
  assert.equal((await owner('POST', A(`/sales/${saleId}/issue`), { issuedAt: '2026-10-16' })).status, 409);
});

test('visibilidad: agente lo suyo, dueño también lo de sus agentes, otro agente nada', async () => {
  const mine = (await ana('GET', A('/commissions'))).body.items;
  assert.deepEqual([...new Set(mine.map((i: any) => i.beneficiaryAgentId))], [anaId]);   // no ve el override de Carlos
  assert.equal((await carlos('GET', A('/commissions'))).body.items.length, 8);
  assert.equal((await carlos('GET', A('/sales'))).body.items.some((s: any) => s.id === saleId), true);
  assert.equal((await omar('GET', A('/commissions'))).body.items.length, 0);
  assert.equal((await omar('GET', A('/sales'))).body.items.some((s: any) => s.id === saleId), false);
  assert.equal((await ana('POST', A('/commissions/pay'), { ids: [randomUUID()], paidAt: '2026-10-20' })).status, 403);
});

test('cancelar con chargeback: anula lo no pagado y descuenta % de lo pagado (cuotas pagadas a medias)', async () => {
  // Pagados los adelantos y la primera cuota del resto de Ana (mes 10); las otras dos quedan por cobrar
  const before = (await owner('GET', A('/commissions'))).body.items;
  const paidIds = before.filter((i: any) => i.part === 'advance' || (i.beneficiaryAgentId === anaId && i.seq === 1)).map((i: any) => i.id);
  assert.equal((await owner('POST', A('/commissions/pay'), { ids: paidIds, paidAt: '2026-10-20' })).status, 204);
  assert.equal((await owner('POST', A(`/sales/${saleId}/decline`))).status, 409);
  const r = await owner('POST', A(`/sales/${saleId}/cancel`), { chargebackPercent: 50 });
  assert.equal(r.body.status, 'cancelled');
  const items = (await owner('GET', A('/commissions'))).body.items;
  assert.deepEqual(items.filter((i: any) => i.part === 'remainder').map((i: any) => [i.beneficiaryAgentId === anaId ? 'ana' : 'carlos', i.seq, i.status]).sort(), [
    ['ana', 1, 'paid'], ['ana', 2, 'void'], ['ana', 3, 'void'], ['carlos', 1, 'void'], ['carlos', 2, 'void'], ['carlos', 3, 'void']].sort());
  // Ana: 50 % de (585 + 65); Carlos: 50 % de 225. El chargeback va solo, sin grupo
  const cb = items.filter((i: any) => i.part === 'chargeback');
  assert.deepEqual(cb.map((i: any) => [i.beneficiaryAgentId, i.amount, i.seq, i.of, i.group.length]).sort(),
    [[anaId, -325, null, 1, 0], [carlosId, -112.5, null, 1, 0]].sort());
  // El grupo de una cuota muestra el estado de cada una
  const adv = items.find((i: any) => i.beneficiaryAgentId === anaId && i.part === 'advance');
  assert.deepEqual(adv.group.map((o: any) => o.status), ['paid', 'paid', 'void', 'void']);
});

test('split: cada agente cobra sobre su parte con su nivel; el override sale de la parte de su agente', async () => {
  await owner('POST', A(`/agents/${omarId}/levels`), { carrierIds: [carrierId], level: 85, effectiveFrom: '2026-10-01' });
  const body = { agentId: anaId, productId: iulId, amount: 1200, clientName: 'Juan Split', expectedIssueDate: '2026-10-10' };
  // El principal no va en el split y la suma tiene que dejarle algo
  assert.equal((await owner('POST', A('/sales'), { ...body, splits: [{ agentId: anaId, percent: 50 }] })).body.code, 'split_main_agent');
  assert.equal((await owner('POST', A('/sales'), { ...body, splits: [{ agentId: omarId, percent: 100 }] })).status, 400);
  const s = await owner('POST', A('/sales'), { ...body, splits: [{ agentId: omarId, percent: 50 }] });
  assert.deepEqual(s.body.splits, [{ agentId: omarId, percent: 50, name: 'Omar' }]);
  // Omar ve la venta (es suya a medias) aunque el principal sea Ana
  assert.ok((await omar('GET', A('/sales'))).body.items.some((x: any) => x.id === s.body.id));
  assert.ok((await owner('GET', A(`/sales?agentId=${omarId}`))).body.items.some((x: any) => x.id === s.body.id));
  await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-15' });
  const mine = (await owner('GET', A('/commissions'))).body.items.filter((i: any) => i.sale.clientName === 'Juan Split' && i.part === 'advance');
  // Ana: 600 × 65 % = 390 → adelanto 292.50; Carlos: 600 × 25 % = 150 → 112.50; Omar (nivel 85, 70 %): 600 × 70 % = 420 → 315
  assert.deepEqual(mine.map((i: any) => [i.beneficiaryAgentId, i.kind, i.viaAgentId, i.share, i.amount]).sort(), [
    [anaId, 'direct', anaId, 50, 292.5], [carlosId, 'override', anaId, 50, 112.5], [omarId, 'direct', omarId, 50, 315]].sort());
  // Omar ve solo lo suyo; Ana no ve lo de Omar
  assert.deepEqual([...new Set((await omar('GET', A('/commissions'))).body.items.filter((i: any) => i.sale.clientName === 'Juan Split').map((i: any) => i.beneficiaryAgentId))], [omarId]);
  assert.ok(!(await ana('GET', A('/commissions'))).body.items.some((i: any) => i.beneficiaryAgentId === omarId));
  // Cancelar: el chargeback va por cada parte
  await owner('POST', A('/commissions/pay'), { ids: mine.map((i: any) => i.id), paidAt: '2026-10-20' });
  await owner('POST', A(`/sales/${s.body.id}/cancel`), { chargebackPercent: 100 });
  const cb = (await owner('GET', A('/commissions'))).body.items.filter((i: any) => i.sale.clientName === 'Juan Split' && i.part === 'chargeback');
  assert.deepEqual(cb.map((i: any) => [i.beneficiaryAgentId, i.viaAgentId, i.amount]).sort(), [
    [anaId, anaId, -292.5], [carlosId, anaId, -112.5], [omarId, omarId, -315]].sort());
  // La cuota pagada dice cuánto se le descontó y cuándo (la venta se canceló)
  const adv = (await owner('GET', A('/commissions'))).body.items.find((i: any) => i.sale.clientName === 'Juan Split' && i.part === 'advance' && i.beneficiaryAgentId === omarId);
  assert.deepEqual([adv.status, adv.sale.status, adv.chargeback.amount], ['paid', 'cancelled', -315]);
  // Permiso y aislamiento: un agente no edita el split; otra agencia no lo ve ni lo toca
  const p = await owner('POST', A('/sales'), { ...body, clientName: 'Otro Split', splits: [{ agentId: omarId, percent: 30 }] });
  assert.equal((await ana('PATCH', A(`/sales/${p.body.id}`), { splits: [] })).status, 403);
  assert.equal((await outsider('PATCH', A(`/sales/${p.body.id}`), { splits: [] })).status, 404);
  assert.deepEqual((await owner('PATCH', A(`/sales/${p.body.id}`), { splits: [] })).body.splits, []);
  await owner('POST', A(`/sales/${p.body.id}/decline`));
});

test('ventas reales del Discord de VFS (8-9 oct 2026) con la guía FFL', async () => {
  // Cesar (80) y Nanishka (85) bajo Lendry (105): aquí Ana, Omar y Carlos hacen esos papeles
  const nlg = (await owner('POST', A('/carriers'), { name: 'National Life Group', aliases: ['NLG'] })).body;
  const flex = (await owner('POST', A(`/carriers/${nlg.id}/products`), { name: 'Flex Life IUL', aliases: ['IUL'] })).body.products[0].id;
  await owner('PUT', A(`/products/${flex}/grid`), { effectiveFrom: '2024-08-19', rows: FLEX_LIFE });
  const moo = (await owner('POST', A('/carriers'), { name: 'Mutual of Omaha', aliases: ['MOO'] })).body;
  const iule = (await owner('POST', A(`/carriers/${moo.id}/products`), { name: 'IULE', aliases: ['IUL'] })).body.products[0].id;
  await owner('PUT', A(`/products/${iule}/grid`), { effectiveFrom: '2024-08-19', rows: IULE });
  await owner('PATCH', A(`/agents/${omarId}`), { uplineAgentId: carlosId });
  for (const [id, lvl] of [[anaId, 80], [omarId, 85], [carlosId, 105]] as const) {
    await owner('POST', A(`/agents/${id}/levels`), { carrierIds: [carrierId, nlg.id, moo.id], level: lvl, effectiveFrom: '2026-01-01' });
  }

  const sell = async (agentId: string, productId: string, amount: number, clientName: string) => {
    const s = await owner('POST', A('/sales'), { agentId, productId, amount, clientName, expectedIssueDate: '2026-10-08' });
    await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-08' });
    const items = (await owner('GET', A('/commissions'))).body.items.filter((i: any) => i.saleId === s.body.id);
    return items.map((i: any) => [i.kind, i.part, i.amount]).sort();
  };
  const rest = (kind: string, amount: number) => [1, 2, 3].map(() => [kind, 'remainder', amount]);
  assert.deepEqual(await sell(anaId, flex, 1200, 'Danielle Cardenas'), [
    ['direct', 'advance', 450], ...rest('direct', 50), ['override', 'advance', 225], ...rest('override', 25)].sort());
  assert.deepEqual(await sell(omarId, iulId, 1199.88, 'Jose Gonzalez Valdez'), [
    ['direct', 'advance', 629.94], ['direct', 'remainder', 69.99], ['direct', 'remainder', 69.99], ['direct', 'remainder', 70],
    ['override', 'advance', 179.99], ['override', 'remainder', 20], ['override', 'remainder', 20], ['override', 'remainder', 19.99]].sort());
  assert.deepEqual(await sell(omarId, iule, 960, 'Vilma'), [
    ['direct', 'advance', 540], ...rest('direct', 60), ['override', 'advance', 144], ...rest('override', 16)].sort());
});

test('CSV de ventas con nombres legibles', async () => {
  const r = await owner('GET', A('/sales.csv'));
  assert.match(r.headers.get('content-type')!, /text\/csv/);
  assert.match(r.body, /"Ana","Carlos","Americo","IUL","1200.00","Danielle Cardenas","NY"/);
});

// ═══ Nivel por compañía (ADR 0006) ═══

test('nivel distinto por compañía: ISSUE y override usan el nivel de cada compañía', async () => {
  const mk = async (name: string, rows: typeof INSTANT_DECISION) => {
    const c = (await owner('POST', A('/carriers'), { name })).body;
    const pid = (await owner('POST', A(`/carriers/${c.id}/products`), { name: 'Prod' })).body.products[0].id;
    await owner('PUT', A(`/products/${pid}/grid`), { effectiveFrom: '2024-08-19', rows });
    return { id: c.id as string, pid: pid as string };
  };
  const alfa = await mk('Alfa', INSTANT_DECISION), beta = await mk('Beta', FLEX_LIFE);
  const lv = (id: string, carrierIds: string[], level: number) => owner('POST', A(`/agents/${id}/levels`), { carrierIds, level, effectiveFrom: '2026-01-01' });
  await lv(anaId, [alfa.id], 80); await lv(anaId, [beta.id], 100);
  await lv(carlosId, [alfa.id], 100); await lv(carlosId, [beta.id], 105);
  // El perfil trae carrierId en cada nivel
  const prof = (await owner('GET', A('/agents'))).body.find((a: any) => a.id === anaId);
  assert.ok(prof.levels.length >= 4);
  assert.ok(prof.levels.every((l: any) => typeof l.carrierId === 'string'));
  assert.deepEqual(prof.levels.filter((l: any) => l.carrierId === alfa.id), [{ carrierId: alfa.id, level: 80, effectiveFrom: '2026-01-01' }]);
  assert.deepEqual(prof.levels.filter((l: any) => l.carrierId === beta.id), [{ carrierId: beta.id, level: 100, effectiveFrom: '2026-01-01' }]);

  const sell = async (productId: string, clientName: string) => {
    const s = await owner('POST', A('/sales'), { agentId: anaId, productId, amount: 1000, clientName, expectedIssueDate: '2026-10-08' });
    assert.equal((await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-08' })).status, 200);
    const items = (await owner('GET', A('/commissions'))).body.items.filter((i: any) => i.saleId === s.body.id);
    return { id: s.body.id as string, rows: items.map((i: any) => [i.beneficiaryAgentId, i.kind, i.part, i.level, i.rate, i.amount]).sort() };
  };
  // Alfa: Ana 80 → 65 % (650: 487.5 + 3 × 54.17 ≈ 162.5); Carlos 100 → 85 %, override 20 % (200: 150 + 16.67 + 16.67 + 16.66)
  const rem = (r: any[]) => r.filter((x) => x[2] === 'remainder');
  const sumRem = (r: any[], who: string) => Math.round(rem(r).filter((x) => x[0] === who).reduce((t, x) => t + x[5] * 100, 0)) / 100;
  const a = await sell(alfa.pid, 'Cliente Alfa');
  assert.deepEqual(a.rows.filter((x: any) => x[2] === 'advance'), [
    [anaId, 'direct', 'advance', 80, 65, 487.5], [carlosId, 'override', 'advance', 100, 20, 150]].sort());
  assert.deepEqual(rem(a.rows).map((x) => x[5]).sort(), [16.66, 16.67, 16.67, 54.16, 54.17, 54.17].sort());
  assert.deepEqual([sumRem(a.rows, anaId), sumRem(a.rows, carlosId)], [162.5, 50]);
  // Beta: Ana 100 → 70 % (700: 525 + 175); Carlos 105 → 75 %, override 5 % (50: 37.5 + 12.5)
  const b = await sell(beta.pid, 'Cliente Beta');
  assert.deepEqual(b.rows.filter((x: any) => x[2] === 'advance'), [
    [anaId, 'direct', 'advance', 100, 70, 525], [carlosId, 'override', 'advance', 105, 5, 37.5]].sort());
  assert.deepEqual([sumRem(b.rows, anaId), sumRem(b.rows, carlosId)], [175, 12.5]);

  // Filtros por compañía y por agente vendedor (listado y CSV)
  const ids = (r: any) => new Set(r.body.items.map((i: any) => i.saleId));
  const byCarrier = await owner('GET', A(`/commissions?carrierId=${alfa.id}`));
  assert.deepEqual([...ids(byCarrier)], [a.id]);
  assert.equal(byCarrier.body.items.length, 8);
  assert.ok(!ids(await owner('GET', A(`/commissions?carrierId=${beta.id}`))).has(a.id));
  const byAgent = await owner('GET', A(`/commissions?agentId=${omarId}`));
  assert.ok(byAgent.body.items.length > 0);
  assert.ok(byAgent.body.items.every((i: any) => i.viaAgentId === omarId));   // su parte, también en splits
  const both = await owner('GET', A(`/commissions?agentId=${anaId}&carrierId=${beta.id}`));
  assert.deepEqual([...ids(both)], [b.id]);
  const csv = await owner('GET', A(`/commissions.csv?carrierId=${alfa.id}`));
  assert.match(csv.body, /Cliente Alfa/);
  assert.doesNotMatch(csv.body, /Cliente Beta|Danielle|Vilma/);
  const csvAgent = await owner('GET', A(`/commissions.csv?agentId=${omarId}`));
  assert.match(csvAgent.body, /Vilma/);
  assert.doesNotMatch(csvAgent.body, /Cliente Alfa|Cliente Beta/);

  // Un agente sin permisos de admin no ve más al filtrar: su override sigue oculto y el agente ajeno da vacío
  const mine = (await ana('GET', A('/commissions'))).body.items.length;
  const anaFiltered = (await ana('GET', A(`/commissions?agentId=${anaId}`))).body.items;
  assert.equal(anaFiltered.length, mine);
  assert.ok(anaFiltered.every((i: any) => i.beneficiaryAgentId === anaId));
  assert.equal((await ana('GET', A(`/commissions?agentId=${omarId}`))).body.items.length, 0);
  assert.equal((await ana('GET', A(`/commissions?carrierId=${alfa.id}`))).body.items.every((i: any) => i.beneficiaryAgentId === anaId), true);
  assert.doesNotMatch((await ana('GET', A(`/commissions.csv?agentId=${omarId}`))).body, /Vilma/);
  assert.equal((await omar('GET', A(`/commissions?agentId=${anaId}`))).body.items.length, 0);
});

test('sin nivel en la compañía del producto: 409 missing_level con el nombre de la compañía', async () => {
  const c = (await owner('POST', A('/carriers'), { name: 'Gamma Seguros' })).body;
  const pid = (await owner('POST', A(`/carriers/${c.id}/products`), { name: 'Prod' })).body.products[0].id;
  await owner('PUT', A(`/products/${pid}/grid`), { effectiveFrom: '2024-08-19', rows: INSTANT_DECISION });
  // Ana tiene nivel en otras compañías, pero no en Gamma
  const s = await owner('POST', A('/sales'), { agentId: anaId, productId: pid, amount: 500, clientName: 'Sin Nivel', expectedIssueDate: '2026-10-09' });
  const r = await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-15' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'missing_level');
  assert.match(r.body.error, /Gamma Seguros/);
  assert.match(r.body.error, /Ana/);
  // Con nivel del agente pero sin el del upline en Gamma: el error nombra al upline y la compañía
  await owner('POST', A(`/agents/${anaId}/levels`), { carrierIds: [c.id], level: 80, effectiveFrom: '2026-01-01' });
  const r2 = await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-15' });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'missing_level');
  assert.match(r2.body.error, /Carlos.*Gamma Seguros/);
  await owner('POST', A(`/agents/${carlosId}/levels`), { carrierIds: [c.id], level: 105, effectiveFrom: '2026-01-01' });
  assert.equal((await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-15' })).status, 200);
});

test('aislamiento: niveles con una compañía de otra agencia dan 404 carrier_not_found', async () => {
  await outsider('PATCH', `/w/${slugB}`, { settings: { salesModule: true } });
  const cb = (await outsider('POST', `/w/${slugB}/carriers`, { name: 'Compañía B' })).body;
  const before = (await owner('GET', A('/agents'))).body.find((a: any) => a.id === anaId).levels.length;
  for (const carrierIds of [[cb.id], [carrierId, cb.id]]) {
    const r = await owner('POST', A(`/agents/${anaId}/levels`), { carrierIds, level: 80, effectiveFrom: '2026-02-01' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'carrier_not_found');
  }
  // No se insertó nada (ni siquiera la compañía válida de la mezcla)
  assert.equal((await owner('GET', A('/agents'))).body.find((a: any) => a.id === anaId).levels.length, before);
  assert.equal((await owner('POST', A(`/agents/${anaId}/levels`), { carrierIds: [], level: 80, effectiveFrom: '2026-02-01' })).status, 400);
  assert.equal((await owner('POST', A(`/agents/${anaId}/levels`), { level: 80, effectiveFrom: '2026-02-01' })).status, 400);
});

test('aislamiento: la agencia B no ve ni toca las ventas de la A', async () => {
  await outsider('PATCH', `/w/${slugB}`, { settings: { salesModule: true } });
  const B = (p: string) => `/w/${slugB}${p}`;
  assert.equal((await outsider('GET', B('/sales'))).body.items.length, 0);
  assert.equal((await outsider('GET', B('/commissions'))).body.items.length, 0);
  assert.equal((await outsider('POST', B(`/sales/${saleId}/issue`), { issuedAt: '2026-10-15' })).status, 404);
  assert.equal((await outsider('PATCH', B(`/products/${iulId}`), { name: 'x' })).status, 404);
  // Una venta en B con el producto de A: la FK compuesta lo rechaza
  const me = (await outsider('POST', B('/agents'), { name: 'Agente B' })).body.id;
  assert.equal((await outsider('POST', B('/sales'), { agentId: me, productId: iulId, amount: 1, clientName: 'x', expectedIssueDate: '2026-10-01' })).status, 400);
  assert.equal((await outsider('GET', A('/sales'))).status, 404);
});

// ═══ Discord ═══

// Catálogo de VFS: sin producto = el IUL de cada compañía; FEX se acepta (comisión por definir)
const CATALOG = [
  { id: 'AM', name: 'Americo', aliases: ['americo'], defaultProductId: 'ID',
    products: [{ id: 'ID', name: 'Instant Decision', aliases: ['iul'] }, { id: 'AFEX', name: 'FEX', aliases: [] }] },
  { id: 'NLG', name: 'National Life Group', aliases: ['nlg', 'national'], defaultProductId: 'FLEX',
    products: [{ id: 'FLEX', name: 'Flex Life IUL', aliases: ['iul', 'flex'] }] },
  { id: 'MOO', name: 'Mutual of Omaha', aliases: ['moo', 'mutual of omaha'], defaultProductId: 'IULE',
    products: [{ id: 'IULE', name: 'IULE', aliases: ['iul'] }, { id: 'MFEX', name: 'FEX', aliases: [] }] },
];
const read = (content: string, postedOn = '2026-10-09') => parseSale(content, postedOn, CATALOG);

test('lector: los mensajes reales del #ventas de VFS', () => {
  assert.deepEqual(read('$1200  NLG IUL Upon issue NY (Danielle Cardenas)', '2026-10-08'), {
    problems: [], clientName: 'Danielle Cardenas', amount: 1200, expectedIssueDate: '2026-10-08', clientState: 'NY', carrierId: 'NLG', productId: 'FLEX' });
  assert.deepEqual(read('$1199.88 Americo IUL 10/23 OK (Jose Gonzalez Valdez)', '2026-10-08'), {
    problems: [], clientName: 'Jose Gonzalez Valdez', amount: 1199.88, expectedIssueDate: '2026-10-23', clientState: 'OK', carrierId: 'AM', productId: 'ID' });
  assert.equal(read('$1800 FEX AMÉRICO UPPON ISSUE(Norma Salgado)').productId, 'AFEX');
  assert.equal(read('$960 MOO IUL Upon Issue CA (Vilma)').productId, 'IULE');
  assert.equal(read('$2101.56 MOO FEX Upon Issue FL (Pedro Aviles)').productId, 'MFEX');
});

test('lector: sin producto es el IUL; NLG FLEX y "National Flex Life" también', () => {
  assert.equal(read('$3600 NLG UPPON ISSUE OH (Marisela Martinez)').productId, 'FLEX');
  assert.equal(read('$1800 AMERICO UPPON ISSUE TX(Jesse Acosta)').productId, 'ID');
  assert.equal(read('$2400 NLG FLEX 09/18 PA (Guillermo Gonzalez)', '2026-09-10').expectedIssueDate, '2026-09-18');
  const nf = read('$1800  National Flex Life NC (Álvaro)');
  assert.deepEqual([nf.productId, nf.clientState, nf.expectedIssueDate, nf.clientName], ['FLEX', 'NC', '2026-10-09', 'Álvaro']);
  const nyc = read('$2400  NLG UPPON ISSUE 🗽NY(Raul Ventura)');
  assert.deepEqual([nyc.productId, nyc.clientState], ['FLEX', 'NY']);
});

test('lector: compañías y productos que la agencia no maneja se ignoran', () => {
  assert.equal(read('$2400 AMAM IUL Upon Issue TX (Margarita Barrientos Prado)').ignore, 'carrier');
  assert.equal(read('$1200 F&G IUL JUVENILE UPPON ISSUE MD(Joel David Coronado)').ignore, 'carrier');
  assert.equal(read('$3000 NLG RAPID UPPON ISSUE CA(Lester Vallejos)').ignore, 'product');
  assert.equal(read('$3000 NLG Rapid Upon Issue Issue NJ (Carlos Sillagana)').ignore, 'product');
  assert.equal(read('$1200 NLG JUVENILE DE(Randy Rojas)').ignore, 'product');
});

test('lector: fechas con guion, "ISUUE", sin fecha y fechas del año siguiente', () => {
  assert.equal(read('$1200 AMERICO IUL 09-01 FL (Francys Cruz)', '2026-08-25').expectedIssueDate, '2026-09-01');
  assert.deepEqual(read('$1800 AMERICO IUL UPON ISUUE NJ (MARIA PINO)'), {
    problems: [], clientName: 'MARIA PINO', amount: 1800, expectedIssueDate: '2026-10-09', clientState: 'NJ', carrierId: 'AM', productId: 'ID' });
  const fex = read('$1200 AMERICO FEX DE(Humberto Rojas)');
  assert.deepEqual([fex.productId, fex.clientState, fex.expectedIssueDate, fex.problems], ['AFEX', 'DE', '2026-10-09', []]);
  assert.equal(read('$2,400 NLG 1/05 (Ana)', '2026-12-20').expectedIssueDate, '2027-01-05');
  assert.deepEqual(read('$2,400 NLG upon issue').problems, ['client']);
});

test('canal de Discord: ventas completas, bandeja, enlazar autor y sin duplicados', async () => {
  const flake = (iso: string, n: number) => (((BigInt(Date.parse(iso)) - 1420070400000n) << 22n) + BigInt(n)).toString();
  const msg = (n: number, iso: string, author: [string, string], content: string, bot = false) =>
    ({ id: flake(iso, n), type: 0, content, timestamp: iso, author: { id: author[0], username: author[1], global_name: author[1], bot } });
  const cesar = ['123456789012', 'Cesar'] as [string, string], nani = ['222222222222222222', 'Nanishka M Reyes Padua'] as [string, string];
  const vero = ['333333333333333333', 'Maria V Salas'] as [string, string];
  const messages = [
    msg(1, '2026-10-09T00:22:00Z', cesar, '$1200  NLG IUL Upon issue NY (Danielle Cardenas)'),
    msg(2, '2026-10-09T00:34:00Z', nani, '$1199.88 Americo IUL 10/23 OK (Jose Gonzalez Valdez)'),
    msg(3, '2026-10-09T15:26:00Z', vero, '$1800 FEX AMÉRICO UPPON ISSUE(Norma Salgado)'),
    msg(4, '2026-10-09T18:00:00Z', vero, '¡Felicidades equipo!'),
    msg(5, '2026-10-10T01:44:00Z', nani, '$960 MOO IUL Upon Issue CA (Vilma)'),
    msg(6, '2026-10-10T02:00:00Z', ['444444444444444444', 'Bot'], '$5 prueba', true),
    msg(7, '2026-10-10T03:00:00Z', vero, '$2400 AMAM IUL Upon Issue TX (Flor Secundino)'),
    msg(8, '2026-10-10T04:00:00Z', vero, '$500 NLG IUL Upon issue'),
  ];
  let auth = '';
  const fake = createServer((req, res) => {
    auth = req.headers.authorization ?? '';
    const after = BigInt(new URL(req.url!, 'http://x').searchParams.get('after')!);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(messages.filter((m) => BigInt(m.id) > after).reverse()));   // Discord: del más nuevo al más viejo
  });
  await new Promise<void>((r) => fake.listen(0, r));
  process.env.DISCORD_API_URL = `http://localhost:${(fake.address() as AddressInfo).port}`;
  process.env.DISCORD_BOT_TOKEN = 'token-de-prueba';
  try {
    assert.equal((await ana('GET', A('/discord-feed'))).status, 403);
    const f = await owner('PUT', A('/discord-feed'), { channelId: '999999999999999999', importSince: '2026-10-08' });
    assert.equal(f.body.botConfigured, true);
    await pollDiscord();
    assert.equal(auth, 'Bot token-de-prueba');

    const fromDiscord = async () => (await owner('GET', A('/sales'))).body.items.filter((s: any) => s.source === 'discord');
    const first = await fromDiscord();
    assert.deepEqual(first.map((s: any) => [s.agentId, s.clientName, s.amount, s.expectedIssueDate, s.clientState, s.status, s.soldOn]),
      [[anaId, 'Danielle Cardenas', 1200, '2026-10-08', 'NY', 'pending', '2026-10-08']]);   // 8:22 pm del 8 en Nueva York
    const inbox = (await owner('GET', A('/sales-inbox'))).body;
    // FEX (sin producto FEX en esta agencia) y AMAM se ignoran; el mensaje sin cliente espera en la bandeja
    assert.deepEqual(inbox.map((i: any) => [i.authorName, i.problems]).sort(), [
      ['Maria V Salas', ['client', 'agent']], ['Nanishka M Reyes Padua', ['agent']], ['Nanishka M Reyes Padua', ['agent']]].sort());

    // Enlazar a Nanishka (aquí Omar) convierte sus dos mensajes en ventas
    const link = await owner('POST', A(`/sales-inbox/${inbox.find((i: any) => i.discordUserId === nani[0]).id}/link`), { agentId: omarId });
    assert.deepEqual(link.body, { created: 2 });
    assert.equal((await owner('GET', A('/agents'))).body.find((a: any) => a.id === omarId).discordUserId, nani[0]);
    const vero1 = (await owner('GET', A('/sales-inbox'))).body;
    assert.equal(vero1.length, 1);
    assert.equal(vero1[0].parsed.amount, 500);

    // Releer el canal desde el mismo día no duplica nada
    await owner('PUT', A('/discord-feed'), { channelId: '999999999999999999', importSince: '2026-10-08' });
    await pollDiscord();
    assert.equal((await fromDiscord()).length, 3);
    const state = (await owner('GET', A('/discord-feed'))).body;
    assert.equal(state.lastError, null);
    assert.equal(state.pendingInbox, 1);

    // Descartar; la agencia B no toca la bandeja de la A
    assert.equal((await outsider('POST', `/w/${slugB}/sales-inbox/${vero1[0].id}/link`, { agentId: omarId })).status, 404);
    assert.equal((await owner('POST', A(`/sales-inbox/${vero1[0].id}/dismiss`))).status, 204);
    assert.equal((await owner('GET', A('/sales-inbox'))).body.length, 0);
  } finally {
    delete process.env.DISCORD_BOT_TOKEN;
    fake.close();
  }
});
