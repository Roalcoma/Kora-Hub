// Ventas y comisiones por HTTP: % por nivel FFL × tabla del producto, 75/25 con override de un nivel, % congelado al ISSUE, chargebacks,
// visibilidad (agente / dueño de agencia / admin) y aislamiento: la agencia B no ve ni toca nada de la A.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';
import { commissionShares, installments } from '../src/sales/commissions.ts';

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
  anaId = await join(ana, 'Ana');
  carlosId = await join(carlos, 'Carlos');
  omarId = await join(omar, 'Omar');
});

after(async () => {
  server.close();
  const ws = (await adminPool.query('select id from workspaces where slug = any($1)', [[slugA, slugB]])).rows.map((r) => r.id);
  for (const t of ['sale_inbox', 'commission_installments', 'sales', 'agent_levels', 'comp_grid', 'agent_profiles', 'carrier_products', 'carriers',
    'discord_feeds', 'messages', 'channel_members', 'channels', 'audit_log', 'member_departments', 'member_lines', 'invitations',
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

// ═══ Cálculo puro ═══

test('comisión directa y override: 75 % al ISSUE y 25 % a los 12 meses', () => {
  const rows = installments(120_000, 9, commissionShares({ userId: 'ana', rate: 70 }, { userId: 'carlos', rate: 90 }));
  assert.deepEqual(rows.map((r) => [r.beneficiaryUserId, r.kind, r.part, r.amountCents, r.monthsAfterIssue]), [
    ['ana', 'direct', 'advance', 63_000, 0], ['ana', 'direct', 'remainder', 21_000, 12],
    ['carlos', 'override', 'advance', 18_000, 0], ['carlos', 'override', 'remainder', 6_000, 12],
  ]);
});

test('override en 0 si el dueño no supera al agente; los centavos siempre cuadran', () => {
  assert.deepEqual(commissionShares({ userId: 'a', rate: 90 }, { userId: 'b', rate: 80 }).map((s) => s.kind), ['direct']);
  const rows = installments(119_988, 9, commissionShares({ userId: 'a', rate: 72.5 }, null));
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
});

test('perfil de agente: dueño de agencia, Discord y nivel de contrato con vigencia', async () => {
  assert.equal((await ana('PATCH', A(`/agents/${anaId}`), { uplineUserId: anaId })).status, 403);
  assert.equal((await owner('PATCH', A(`/agents/${anaId}`), { uplineUserId: anaId })).status, 400);
  const p = await owner('PATCH', A(`/agents/${anaId}`), { uplineUserId: carlosId, discordUserId: '123456789012' });
  assert.equal(p.body.uplineUserId, carlosId);
  await owner('POST', A(`/agents/${anaId}/levels`), { level: 80, effectiveFrom: '2026-01-01' });
  await owner('POST', A(`/agents/${anaId}/levels`), { level: 85, effectiveFrom: '2027-01-01' });   // ascenso futuro
  const r = await owner('POST', A(`/agents/${carlosId}/levels`), { level: 105, effectiveFrom: '2026-01-01' });
  assert.deepEqual(r.body.levels, [{ level: 105, effectiveFrom: '2026-01-01' }]);
  // Cada uno ve solo su perfil; el Admin ve a todos
  assert.deepEqual((await ana('GET', A('/agents'))).body.map((a: any) => a.userId), [anaId]);
  assert.ok((await owner('GET', A('/agents'))).body.length >= 4);
});

// ═══ Ventas y comisiones ═══

test('solo Admin registra ventas; quedan pendientes de ISSUE', async () => {
  const body = { agentUserId: anaId, productId: iulId, amount: 1200, clientName: 'Danielle Cardenas', clientState: 'NY', expectedIssueDate: '2026-10-08' };
  assert.equal((await ana('POST', A('/sales'), body)).status, 403);
  const s = await owner('POST', A('/sales'), body);
  assert.equal(s.status, 201);
  assert.equal(s.body.status, 'pending');
  assert.equal(s.body.uplineUserId, carlosId);
  assert.equal(s.body.carrierId, carrierId);
  saleId = s.body.id;
});

test('sin nivel del agente no se puede marcar ISSUED', async () => {
  const s = await owner('POST', A('/sales'), { agentUserId: omarId, productId: iulId, amount: 500, clientName: 'Vilma', expectedIssueDate: '2026-10-09' });
  const r = await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-15' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'missing_level');
  assert.match(r.body.error, /Omar/);
  // Nivel que la tabla no tiene
  await owner('POST', A(`/agents/${omarId}/levels`), { level: 90, effectiveFrom: '2026-01-01' });
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
  assert.deepEqual(c.items.map((i: any) => [i.beneficiaryUserId, i.kind, i.part, i.level, i.rate, i.amount, i.dueDate]).sort(), [
    [anaId, 'direct', 'advance', 80, 65, 585, '2026-10-15'], [anaId, 'direct', 'remainder', 80, 65, 195, '2027-10-15'],
    [carlosId, 'override', 'advance', 105, 25, 225, '2026-10-15'], [carlosId, 'override', 'remainder', 105, 25, 75, '2027-10-15'],
  ].sort());
  assert.equal(c.totals.pending, 1080);
  // Ya no se edita ni se vuelve a hacer ISSUE
  assert.equal((await owner('PATCH', A(`/sales/${saleId}`), { amount: 1 })).status, 409);
  assert.equal((await owner('POST', A(`/sales/${saleId}/issue`), { issuedAt: '2026-10-16' })).status, 409);
});

test('visibilidad: agente lo suyo, dueño también lo de sus agentes, otro agente nada', async () => {
  const mine = (await ana('GET', A('/commissions'))).body.items;
  assert.deepEqual([...new Set(mine.map((i: any) => i.beneficiaryUserId))], [anaId]);   // no ve el override de Carlos
  assert.equal((await carlos('GET', A('/commissions'))).body.items.length, 4);
  assert.equal((await carlos('GET', A('/sales'))).body.items.some((s: any) => s.id === saleId), true);
  assert.equal((await omar('GET', A('/commissions'))).body.items.length, 0);
  assert.equal((await omar('GET', A('/sales'))).body.items.some((s: any) => s.id === saleId), false);
  assert.equal((await ana('POST', A('/commissions/pay'), { ids: [randomUUID()], paidAt: '2026-10-20' })).status, 403);
});

test('cancelar con chargeback: anula lo no pagado y descuenta % de lo pagado', async () => {
  const advances = (await owner('GET', A('/commissions'))).body.items.filter((i: any) => i.part === 'advance').map((i: any) => i.id);
  assert.equal((await owner('POST', A('/commissions/pay'), { ids: advances, paidAt: '2026-10-20' })).status, 204);
  assert.equal((await owner('POST', A(`/sales/${saleId}/decline`))).status, 409);
  const r = await owner('POST', A(`/sales/${saleId}/cancel`), { chargebackPercent: 50 });
  assert.equal(r.body.status, 'cancelled');
  const items = (await owner('GET', A('/commissions'))).body.items;
  assert.deepEqual(items.filter((i: any) => i.part === 'remainder').map((i: any) => i.status), ['void', 'void']);
  assert.deepEqual(items.filter((i: any) => i.part === 'chargeback').map((i: any) => [i.beneficiaryUserId, i.amount]).sort(),
    [[anaId, -292.5], [carlosId, -112.5]].sort());
});

test('ventas reales del Discord de VFS (8-9 oct 2026) con la guía FFL', async () => {
  // Cesar (80) y Nanishka (85) bajo Lendry (105): aquí Ana, Omar y Carlos hacen esos papeles
  const nlg = (await owner('POST', A('/carriers'), { name: 'National Life Group', aliases: ['NLG'] })).body;
  const flex = (await owner('POST', A(`/carriers/${nlg.id}/products`), { name: 'Flex Life IUL', aliases: ['IUL'] })).body.products[0].id;
  await owner('PUT', A(`/products/${flex}/grid`), { effectiveFrom: '2024-08-19', rows: FLEX_LIFE });
  const moo = (await owner('POST', A('/carriers'), { name: 'Mutual of Omaha', aliases: ['MOO'] })).body;
  const iule = (await owner('POST', A(`/carriers/${moo.id}/products`), { name: 'IULE', aliases: ['IUL'] })).body.products[0].id;
  await owner('PUT', A(`/products/${iule}/grid`), { effectiveFrom: '2024-08-19', rows: IULE });
  await owner('PATCH', A(`/agents/${omarId}`), { uplineUserId: carlosId });
  await owner('POST', A(`/agents/${omarId}/levels`), { level: 85, effectiveFrom: '2026-01-01' });

  const sell = async (agentUserId: string, productId: string, amount: number, clientName: string) => {
    const s = await owner('POST', A('/sales'), { agentUserId, productId, amount, clientName, expectedIssueDate: '2026-10-08' });
    await owner('POST', A(`/sales/${s.body.id}/issue`), { issuedAt: '2026-10-08' });
    const items = (await owner('GET', A('/commissions'))).body.items.filter((i: any) => i.saleId === s.body.id);
    return items.map((i: any) => [i.kind, i.part, i.amount]).sort();
  };
  assert.deepEqual(await sell(anaId, flex, 1200, 'Danielle Cardenas'), [
    ['direct', 'advance', 450], ['direct', 'remainder', 150], ['override', 'advance', 225], ['override', 'remainder', 75]].sort());
  assert.deepEqual(await sell(omarId, iulId, 1199.88, 'Jose Gonzalez Valdez'), [
    ['direct', 'advance', 629.94], ['direct', 'remainder', 209.98], ['override', 'advance', 179.99], ['override', 'remainder', 59.99]].sort());
  assert.deepEqual(await sell(omarId, iule, 960, 'Vilma'), [
    ['direct', 'advance', 540], ['direct', 'remainder', 180], ['override', 'advance', 144], ['override', 'remainder', 48]].sort());
});

test('CSV de ventas con nombres legibles', async () => {
  const r = await owner('GET', A('/sales.csv'));
  assert.match(r.headers.get('content-type')!, /text\/csv/);
  assert.match(r.body, /"Ana","Carlos","Americo","IUL","1200.00","Danielle Cardenas","NY"/);
});

test('aislamiento: la agencia B no ve ni toca las ventas de la A', async () => {
  await outsider('PATCH', `/w/${slugB}`, { settings: { salesModule: true } });
  const B = (p: string) => `/w/${slugB}${p}`;
  assert.equal((await outsider('GET', B('/sales'))).body.items.length, 0);
  assert.equal((await outsider('GET', B('/commissions'))).body.items.length, 0);
  assert.equal((await outsider('POST', B(`/sales/${saleId}/issue`), { issuedAt: '2026-10-15' })).status, 404);
  assert.equal((await outsider('PATCH', B(`/products/${iulId}`), { name: 'x' })).status, 404);
  // Una venta en B con el producto de A: la FK compuesta lo rechaza
  const me = (await outsider('GET', B(''))).body.me.userId;
  assert.equal((await outsider('POST', B('/sales'), { agentUserId: me, productId: iulId, amount: 1, clientName: 'x', expectedIssueDate: '2026-10-01' })).status, 400);
  assert.equal((await outsider('GET', A('/sales'))).status, 404);
});
