// Facturación (ADR 0005): estado, permisos (solo Owner paga), modo simulado, webhook firmado e idempotente,
// cada transición del ciclo (el tiempo se simula moviendo columnas con adminPool), avisos y aislamiento.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/index.ts';
import { adminPool, appPool } from '../src/db.ts';
import { signHeader } from '../src/billing/stripe.ts';
import { runLifecycle, syncSeats } from '../src/billing/lifecycle.ts';

let server: Server;
let base: string;
const run = randomUUID().slice(0, 8);
const password = 'clave-segura-123';
const slugA = `fact-a-${run}`, slugB = `fact-b-${run}`;
const SECRET = 'whsec_prueba_kora';
let wsA = '', wsB = '';

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}
type Client = ReturnType<typeof client>;
const owner = client(), admin = client(), guest = client(), ownerB = client();

/** Envía un evento al webhook como lo haría Stripe (firma opcionalmente rota o vieja) */
async function webhook(event: object, opts: { secret?: string; t?: number } = {}) {
  const payload = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/webhooks/stripe`, {
    method: 'POST', body: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': signHeader(payload, opts.secret ?? SECRET, opts.t) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const ws = async (id: string) => (await adminPool.query('select * from workspaces where id = $1', [id])).rows[0];
const setWs = (id: string, sql: string) => adminPool.query(`update workspaces set ${sql} where id = $1`, [id]);

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  const reg = (c: Client, email: string, slug: string) => c('POST', '/auth/register', {
    name: 'Dueña', email, password, locale: 'es', workspace: { name: slug, slug, template: 'blank' } });
  wsA = (await reg(owner, `owner-${run}@test.local`, slugA)).body.workspaces[0].id;
  wsB = (await reg(ownerB, `owner-b-${run}@test.local`, slugB)).body.workspaces[0].id;
  for (const [c, role, name] of [[admin, 'admin', 'adm'], [guest, 'guest', 'inv']] as const) {
    const inv = await owner('POST', `/w/${slugA}/invitations`, { email: null, role });
    await c('POST', '/invitations/accept', {
      token: inv.body.url.split('/invite/')[1], newAccount: { name, password, locale: 'es', email: `${name}-${run}@test.local` } });
  }
});

after(async () => {
  server.close();
  const ids = [wsA, wsB];
  for (const t of ['audit_log', 'channel_members', 'channels', 'member_departments', 'member_lines', 'invitations',
    'departments', 'business_lines', 'workspace_members', 'jobs']) {
    await adminPool.query(`delete from ${t} where workspace_id = any($1)`, [ids]);
  }
  await adminPool.query('delete from workspaces where id = any($1)', [ids]);
  await adminPool.query('delete from stripe_events where id like $1', [`%${run}%`]);
  const users = (await adminPool.query('select id from users where email like $1', [`%-${run}@test.local`])).rows.map((r) => r.id);
  await adminPool.query('delete from audit_log where actor_user_id = any($1)', [users]);
  await adminPool.query('delete from users where id = any($1)', [users]);
  await adminPool.end();
  await appPool.end();
});

test('estado de facturación: prueba, puestos sin invitados, precios y modo simulado', async () => {
  const r = await owner('GET', `/w/${slugA}/billing`);
  assert.equal(r.status, 200);
  assert.equal(r.body.plan, 'trial');
  assert.equal(r.body.status, 'trialing');
  assert.equal(r.body.seats, 2);   // owner + admin; el invitado no cuenta
  assert.deepEqual(r.body.pricesCents, { standard: 600, pro: 900 });
  assert.equal(r.body.estimatedMonthlyCents, 1200);
  assert.equal(r.body.hasSubscription, false);
  assert.equal(r.body.simulated, true);
  assert.equal((await admin('GET', `/w/${slugA}/billing`)).status, 200);
  assert.equal((await guest('GET', `/w/${slugA}/billing`)).status, 403);
});

test('solo el Owner abre checkout, portal y simulador; el Admin recibe 403', async () => {
  for (const [path, body] of [['/billing/checkout', { plan: 'pro' }], ['/billing/portal', undefined], ['/billing/simulate', { event: 'paid' }]] as const) {
    const r = await admin('POST', `/w/${slugA}${path}`, body);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.code, 'forbidden');
  }
  const co = await owner('POST', `/w/${slugA}/billing/checkout`, { plan: 'pro' });
  assert.equal(co.status, 200);
  assert.match(co.body.url, new RegExp(`/w/${slugA}/settings/billing\\?simulated=pro$`));
  const portal = await owner('POST', `/w/${slugA}/billing/portal`);
  assert.match(portal.body.url, new RegExp(`/w/${slugA}/settings/billing$`));
  assert.equal((await owner('POST', `/w/${slugA}/billing/checkout`, { plan: 'gratis' })).status, 400);
});

test('simulado: pagar activa el plan y encola la sincronización de puestos', async () => {
  const r = await owner('POST', `/w/${slugA}/billing/simulate`, { event: 'paid', plan: 'pro' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'active');
  assert.equal(r.body.plan, 'pro');
  assert.equal(r.body.hasSubscription, true);
  assert.equal(r.body.estimatedMonthlyCents, 1800);
  const job = await adminPool.query("select * from jobs where dedupe_key = $1", [`billing-seats:${wsA}`]);
  assert.equal(job.rows[0].kind, 'billing.sync_seats');
  await syncSeats(wsA);
  assert.equal((await ws(wsA)).billing_seats, 2);
  const log = await adminPool.query("select meta from audit_log where workspace_id = $1 and action = 'billing.status_changed'", [wsA]);
  assert.deepEqual(log.rows.at(-1).meta, { from: 'trialing', to: 'active', event: 'paid', source: 'simulated' });
});

test('desactivar un miembro reactiva la sincronización de puestos', async () => {
  await adminPool.query('update jobs set done_at = now() where dedupe_key = $1', [`billing-seats:${wsA}`]);
  const adminId = (await admin('GET', '/me')).body.user.id;
  assert.equal((await owner('PATCH', `/w/${slugA}/members/${adminId}`, { isActive: false })).status, 200);
  const job = (await adminPool.query('select done_at from jobs where dedupe_key = $1', [`billing-seats:${wsA}`])).rows[0];
  assert.equal(job.done_at, null);
  await syncSeats(wsA);
  assert.equal((await ws(wsA)).billing_seats, 1);
  await owner('PATCH', `/w/${slugA}/members/${adminId}`, { isActive: true });
});

test('ciclo: cobro fallido → gracia de 7 días → solo lectura', async () => {
  const r = await owner('POST', `/w/${slugA}/billing/simulate`, { event: 'payment_failed' });
  assert.equal(r.body.status, 'past_due');
  const days = (new Date(r.body.graceEndsAt).getTime() - Date.now()) / 86400_000;
  assert.ok(days > 6.9 && days <= 7, `gracia de ${days} días`);
  await runLifecycle([wsA]);
  assert.equal((await ws(wsA)).status, 'past_due');   // la gracia no ha vencido
  await setWs(wsA, "grace_ends_at = now() - interval '1 minute'");
  await runLifecycle([wsA]);
  const w = await ws(wsA);
  assert.equal(w.status, 'read_only');
  assert.ok(w.read_only_since);
});

test('solo lectura bloquea escribir pero deja ver y pagar', async () => {
  const patch = await owner('PATCH', `/w/${slugA}`, { name: 'Otro nombre' });
  assert.equal(patch.status, 403);
  assert.equal(patch.body.code, 'workspace_read_only');
  assert.equal((await owner('GET', `/w/${slugA}/members`)).status, 200);
  assert.equal((await owner('GET', `/w/${slugA}/billing`)).status, 200);
  assert.equal((await owner('POST', `/w/${slugA}/billing/checkout`, { plan: 'standard' })).status, 200);
  assert.equal((await owner('POST', `/w/${slugA}/billing/portal`)).status, 200);
  const paid = await owner('POST', `/w/${slugA}/billing/simulate`, { event: 'paid' });
  assert.equal(paid.body.status, 'active');
  assert.equal(paid.body.plan, 'pro');   // pagar sin cambiar de plan conserva el que tenía
  assert.equal((await ws(wsA)).read_only_since, null);
});

test('ciclo: baja → solo lectura; 30 días después → suspendida; pagar la reactiva', async () => {
  const c = await owner('POST', `/w/${slugA}/billing/simulate`, { event: 'canceled' });
  assert.equal(c.body.status, 'read_only');
  assert.equal(c.body.hasSubscription, false);
  await runLifecycle([wsA]);
  assert.equal((await ws(wsA)).status, 'read_only');
  await setWs(wsA, "read_only_since = now() - interval '31 days'");
  await runLifecycle([wsA]);
  assert.equal((await ws(wsA)).status, 'suspended');

  const blocked = await owner('GET', `/w/${slugA}/members`);
  assert.equal(blocked.body.code, 'workspace_suspended');
  assert.equal((await owner('GET', `/w/${slugA}/billing`)).status, 200);
  const paid = await owner('POST', `/w/${slugA}/billing/simulate`, { event: 'paid', plan: 'standard' });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.status, 'active');
  assert.equal((await owner('GET', `/w/${slugA}/members`)).status, 200);
});

test('ciclo: la prueba vence sin pagar → solo lectura', async () => {
  await setWs(wsB, "trial_ends_at = now() - interval '1 minute'");
  await runLifecycle([wsB]);
  assert.equal((await ws(wsB)).status, 'read_only');
  assert.equal((await ownerB('POST', `/w/${slugB}/channels`, { kind: 'public', name: 'x', memberIds: [] })).body.code, 'workspace_read_only');
});

test('avisos al Owner 3 días y 1 día antes, sin repetir', async () => {
  await setWs(wsB, "status = 'trialing', read_only_since = null, trial_ends_at = now() + interval '2 days 12 hours'");
  await runLifecycle([wsB]);
  await runLifecycle([wsB]);
  const emails = async () => (await adminPool.query(
    "select payload from jobs where workspace_id = $1 and kind = 'email.send' order by id", [wsB])).rows.map((r) => r.payload);
  let sent = await emails();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template, 'trial_ending');
  assert.equal(sent[0].days, 3);
  assert.equal(sent[0].to, `owner-b-${run}@test.local`);
  assert.match(sent[0].url, new RegExp(`/w/${slugB}/settings/billing$`));

  await setWs(wsB, "trial_ends_at = now() + interval '12 hours'");
  await runLifecycle([wsB]);
  await runLifecycle([wsB]);
  sent = await emails();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].days, 1);
  const notices = Object.keys((await ws(wsB)).billing_notices);
  assert.deepEqual(notices.map((k) => k.split(':')[0]).sort(), ['trial-1d', 'trial-3d']);
});

test('webhook: firma inválida o caducada → 400; válida → aplica el evento', async () => {
  const ev = {
    id: `evt_checkout_${run}`, type: 'checkout.session.completed',
    data: { object: { client_reference_id: wsB, customer: `cus_${run}`, subscription: `sub_${run}`, metadata: { plan: 'standard' } } },
  };
  const bad = await webhook(ev, { secret: 'otra-clave' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_signature');
  assert.equal((await webhook(ev, { t: Math.floor(Date.now() / 1000) - 600 })).status, 400);
  const raw = await fetch(`${base}/api/v1/webhooks/stripe`, { method: 'POST', body: JSON.stringify(ev) });
  assert.equal(raw.status, 400);
  assert.equal((await ws(wsB)).status, 'trialing');

  assert.equal((await webhook(ev)).status, 204);
  const w = await ws(wsB);
  assert.equal(w.status, 'active');
  assert.equal(w.plan, 'standard');
  assert.equal(w.stripe_customer_id, `cus_${run}`);
  assert.equal(w.stripe_subscription_id, `sub_${run}`);
});

test('webhook idempotente: el mismo evento dos veces se aplica una sola vez', async () => {
  const ev = { id: `evt_fail_${run}`, type: 'invoice.payment_failed', data: { object: { customer: `cus_${run}`, subscription: `sub_${run}` } } };
  assert.equal((await webhook(ev)).status, 204);
  assert.equal((await ws(wsB)).status, 'past_due');
  await setWs(wsB, "status = 'active', grace_ends_at = null");
  assert.equal((await webhook(ev)).status, 204);
  assert.equal((await ws(wsB)).status, 'active');   // no se reprocesó
  const n = await adminPool.query('select count(*)::int as n from stripe_events where id = $1', [ev.id]);
  assert.equal(n.rows[0].n, 1);
});

test('webhook: baja de la suscripción y pago posterior por customer', async () => {
  const del = { id: `evt_del_${run}`, type: 'customer.subscription.deleted', data: { object: { id: `sub_${run}`, customer: `cus_${run}`, metadata: {} } } };
  assert.equal((await webhook(del)).status, 204);
  let w = await ws(wsB);
  assert.equal(w.status, 'read_only');
  assert.equal(w.stripe_subscription_id, null);
  const paid = { id: `evt_paid_${run}`, type: 'invoice.paid',
    data: { object: { customer: `cus_${run}`, subscription: null, lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 30 * 86400 } }] } } } };
  assert.equal((await webhook(paid)).status, 204);
  w = await ws(wsB);
  assert.equal(w.status, 'active');
  assert.ok(w.current_period_end > new Date());
  // Evento de otro tipo: se registra y se ignora
  assert.equal((await webhook({ id: `evt_otro_${run}`, type: 'customer.created', data: { object: {} } })).status, 204);
});

test('con llaves de Stripe el simulador no existe (404)', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_falsa';
  try {
    const r = await owner('POST', `/w/${slugA}/billing/simulate`, { event: 'paid' });
    assert.equal(r.status, 404);
    assert.equal((await owner('GET', `/w/${slugA}/billing`)).body.simulated, false);
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('aislamiento: otra agencia no ve ni toca la facturación de A', async () => {
  assert.equal((await ownerB('GET', `/w/${slugA}/billing`)).status, 404);
  assert.equal((await ownerB('POST', `/w/${slugA}/billing/simulate`, { event: 'canceled' })).status, 404);
  assert.equal((await ownerB('POST', `/w/${slugA}/billing/checkout`, { plan: 'pro' })).status, 404);
  assert.equal((await ws(wsA)).status, 'active');
  // El simulador de B solo mueve a B
  await ownerB('POST', `/w/${slugB}/billing/simulate`, { event: 'canceled' });
  assert.equal((await ws(wsA)).status, 'active');
  assert.equal((await ws(wsB)).status, 'read_only');
});
