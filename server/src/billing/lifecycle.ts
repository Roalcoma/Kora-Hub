// Ciclo de vida del plan (ADR 0005 §2–§3): un único manejador de eventos (webhook de Stripe y simulador),
// el job `billing.lifecycle` (vencimientos y avisos) y el job `billing.sync_seats`. Todo por adminPool:
// los campos de facturación no los puede escribir agencia_app. Nunca se borran datos.
import type pg from 'pg';
import type { BillingInfo } from '@agencia-hub/contracts';
import { adminPool, withAdmin } from '../db.ts';
import { enqueue } from '../jobs/queue.ts';
import { audit } from '../platform/model.ts';
import { simulated, pricesCents, stripe, planFromPrice } from './stripe.ts';

export type BillingEvent =
  | { type: 'paid'; plan?: 'standard' | 'pro' | null; customerId?: string | null; subscriptionId?: string | null; periodEnd?: Date | null }
  | { type: 'payment_failed' }
  | { type: 'canceled' };
/** Cómo encontrar el workspace: metadata propia o ids de Stripe */
export type BillingRef = { workspaceId?: string | null; customerId?: string | null; subscriptionId?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRACE_DAYS = 7;
const appUrl = () => process.env.APP_URL ?? 'http://localhost:5180';

/** Aplica un evento de facturación dentro de la transacción `db` (adminPool). Devuelve el workspace o null. */
export async function applyBillingEvent(
  db: pg.PoolClient, ref: BillingRef, ev: BillingEvent, meta: { source: string; actor?: string | null },
): Promise<string | null> {
  const wsId = ref.workspaceId && UUID.test(ref.workspaceId) ? ref.workspaceId : null;
  const { rows } = await db.query(
    `select id, status from workspaces
     where id = $1 or stripe_customer_id = $2 or stripe_subscription_id = $3
     order by (id = $1) desc nulls last limit 1 for update`,
    [wsId, ref.customerId ?? null, ref.subscriptionId ?? null]);
  const w = rows[0];
  if (!w) return null;

  let next = w.status as string;
  if (ev.type === 'paid') {
    next = 'active';
    await db.query(
      `update workspaces set status = 'active', grace_ends_at = null, read_only_since = null,
         plan = coalesce($2, case when plan = 'trial' then 'standard' else plan end),
         stripe_customer_id = coalesce($3, stripe_customer_id), stripe_subscription_id = coalesce($4, stripe_subscription_id),
         current_period_end = coalesce($5, current_period_end)
       where id = $1`,
      [w.id, ev.plan ?? null, ev.customerId ?? null, ev.subscriptionId ?? null, ev.periodEnd ?? null]);
  } else if (ev.type === 'payment_failed') {
    if (w.status === 'active') {
      next = 'past_due';
      await db.query(
        `update workspaces set status = 'past_due', grace_ends_at = now() + make_interval(days => $2) where id = $1`, [w.id, GRACE_DAYS]);
    }
  } else {
    // Baja: queda en solo lectura (si ya estaba bloqueada, no se mueve) y sin suscripción
    if (!['read_only', 'suspended'].includes(w.status)) next = 'read_only';
    await db.query(
      `update workspaces set stripe_subscription_id = null, grace_ends_at = null,
         status = $2, read_only_since = case when $2 = 'read_only' and status <> 'read_only' then now() else read_only_since end
       where id = $1`, [w.id, next]);
  }
  if (next !== w.status) {
    await audit(db, { workspaceId: w.id, actor: meta.actor ?? null, action: 'billing.status_changed',
      meta: { from: w.status, to: next, event: ev.type, source: meta.source } });
  }
  return w.id;
}

/** Traduce un evento de Stripe al manejador interno; los que no nos interesan se ignoran. */
export function fromStripeEvent(event: any): { ref: BillingRef; ev: BillingEvent } | null {
  const o = event?.data?.object ?? {};
  const periodEnd = (s?: number) => (s ? new Date(s * 1000) : null);
  switch (event?.type) {
    case 'checkout.session.completed':
      return {
        ref: { workspaceId: o.client_reference_id ?? o.metadata?.workspace_id, customerId: o.customer },
        ev: { type: 'paid', plan: o.metadata?.plan === 'pro' ? 'pro' : o.metadata?.plan === 'standard' ? 'standard' : null,
          customerId: o.customer, subscriptionId: o.subscription },
      };
    case 'customer.subscription.updated': {
      const ref = { workspaceId: o.metadata?.workspace_id, customerId: o.customer, subscriptionId: o.id };
      const item = o.items?.data?.[0];
      if (['active', 'trialing'].includes(o.status)) {
        return { ref, ev: { type: 'paid', plan: planFromPrice(item?.price?.id), subscriptionId: o.id, customerId: o.customer,
          periodEnd: periodEnd(o.current_period_end ?? item?.current_period_end) } };
      }
      if (['past_due', 'unpaid'].includes(o.status)) return { ref, ev: { type: 'payment_failed' } };
      if (['canceled', 'incomplete_expired'].includes(o.status)) return { ref, ev: { type: 'canceled' } };
      return null;
    }
    case 'customer.subscription.deleted':
      return { ref: { workspaceId: o.metadata?.workspace_id, customerId: o.customer, subscriptionId: o.id }, ev: { type: 'canceled' } };
    case 'invoice.paid':
      return { ref: { customerId: o.customer, subscriptionId: o.subscription },
        ev: { type: 'paid', periodEnd: periodEnd(o.lines?.data?.[0]?.period?.end) } };
    case 'invoice.payment_failed':
      return { ref: { customerId: o.customer, subscriptionId: o.subscription }, ev: { type: 'payment_failed' } };
    default:
      return null;
  }
}

/** Webhook ya verificado: idempotente con stripe_events. Devuelve false si el evento ya se había procesado. */
export async function handleStripeEvent(event: any): Promise<boolean> {
  return withAdmin(async (db) => {
    const ins = await db.query('insert into stripe_events (id, type) values ($1, $2) on conflict do nothing', [event.id, event.type]);
    if (!ins.rowCount) return false;
    const mapped = fromStripeEvent(event);
    const wsId = mapped ? await applyBillingEvent(db, mapped.ref, mapped.ev, { source: 'stripe' }) : null;
    if (wsId && mapped?.ev.type === 'paid') await enqueueSeatSync(wsId, db);   // la cantidad del checkout pudo quedar vieja
    return true;
  });
}

// ─── Puestos ───

/** Puesto = miembro activo que no es invitado */
export async function countSeats(db: pg.PoolClient | pg.Pool, workspaceId: string): Promise<number> {
  const { rows } = await db.query(
    "select count(*)::int as n from workspace_members where workspace_id = $1 and is_active and role <> 'guest'", [workspaceId]);
  return rows[0].n;
}

/** Encola la sincronización de puestos: una pendiente por workspace; si la anterior ya terminó, se reactiva. */
export async function enqueueSeatSync(workspaceId: string, db: pg.PoolClient | pg.Pool = adminPool) {
  await db.query(
    `insert into jobs (workspace_id, kind, payload, dedupe_key) values ($1, 'billing.sync_seats', $2, $3)
     on conflict (dedupe_key) do update set done_at = null, run_at = now(), attempts = 0, last_error = null, locked_at = null
       where jobs.done_at is not null or jobs.attempts >= jobs.max_attempts`,
    [workspaceId, { workspaceId }, `billing-seats:${workspaceId}`]);
}

/** Job `billing.sync_seats`: ajusta la cantidad de la suscripción (con prorrateo) si cambió. */
export async function syncSeats(workspaceId: string) {
  const seats = await countSeats(adminPool, workspaceId);
  const w = (await adminPool.query('select billing_seats, stripe_subscription_id from workspaces where id = $1', [workspaceId])).rows[0];
  if (!w || w.billing_seats === seats) return;
  const sub = w.stripe_subscription_id as string | null;
  if (!simulated() && sub && !sub.startsWith('sim_')) {
    const s = await stripe('GET', `/subscriptions/${sub}`);
    const item = s.items?.data?.[0];
    if (item && item.quantity !== seats) {
      await stripe('POST', `/subscription_items/${item.id}`, { quantity: seats, proration_behavior: 'create_prorations' });
    }
  }
  await adminPool.query('update workspaces set billing_seats = $2 where id = $1', [workspaceId, seats]);
}

// ─── Estado para la UI ───

export async function billingInfo(db: pg.PoolClient | pg.Pool, workspaceId: string): Promise<BillingInfo> {
  const [w, seats] = await Promise.all([
    db.query(
      `select plan, status, trial_ends_at, grace_ends_at, current_period_end, stripe_subscription_id
       from workspaces where id = $1`, [workspaceId]),
    countSeats(db, workspaceId),
  ]);
  const r = w.rows[0];
  const prices = pricesCents();
  return {
    plan: r.plan, status: r.status,
    trialEndsAt: r.trial_ends_at.toISOString(), graceEndsAt: r.grace_ends_at?.toISOString() ?? null,
    currentPeriodEnd: r.current_period_end?.toISOString() ?? null,
    seats, pricesCents: prices,
    estimatedMonthlyCents: seats * (r.plan === 'pro' ? prices.pro : prices.standard),
    hasSubscription: !!r.stripe_subscription_id,
    simulated: simulated(),
  };
}

// ─── Job `billing.lifecycle` (cada hora) ───

/** Vencimientos de prueba y gracia, suspensión a los 30 días y avisos 3 y 1 día antes. `only` acota (pruebas). */
export async function runLifecycle(only: string[] | null = null) {
  const scope = 'and ($1::uuid[] is null or id = any($1))';
  await withAdmin(async (db) => {
    const moves = [
      ['trialing', 'read_only', `status = 'trialing' and trial_ends_at <= now() and stripe_subscription_id is null`],
      ['past_due', 'read_only', `status = 'past_due' and grace_ends_at <= now()`],
      ['read_only', 'suspended', `status = 'read_only' and read_only_since <= now() - interval '30 days'`],
    ] as const;
    for (const [from, to, where] of moves) {
      const { rows } = await db.query(
        `update workspaces set status = '${to}', read_only_since = case when '${to}' = 'read_only' then now() else read_only_since end
         where ${where} ${scope} returning id`, [only]);
      for (const r of rows) {
        await audit(db, { workspaceId: r.id, actor: null, action: 'billing.status_changed', meta: { from, to, source: 'lifecycle' } });
      }
    }
  });

  // Avisos: la clave incluye la fecha de vencimiento, así una segunda gracia vuelve a avisar
  const { rows } = await adminPool.query(
    `select id, slug, name, case when status = 'trialing' then 'trial' else 'grace' end as kind,
       case when status = 'trialing' then trial_ends_at else grace_ends_at end as ends_at
     from workspaces
     where ((status = 'trialing' and stripe_subscription_id is null and trial_ends_at > now() and trial_ends_at <= now() + interval '3 days')
        or (status = 'past_due' and grace_ends_at > now() and grace_ends_at <= now() + interval '3 days')) ${scope}`, [only]);
  for (const w of rows) {
    const days = (w.ends_at.getTime() - Date.now()) / 86400_000 <= 1 ? 1 : 3;
    const key = `${w.kind}-${days}d:${w.ends_at.toISOString().slice(0, 10)}`;
    await withAdmin(async (db) => {
      const marked = await db.query(
        `update workspaces set billing_notices = billing_notices || jsonb_build_object($2::text, now())
         where id = $1 and not billing_notices ? $2`, [w.id, key]);
      if (!marked.rowCount) return;   // ya avisado
      const owners = await db.query(
        `select u.email, u.locale from workspace_members m join users u on u.id = m.user_id
         where m.workspace_id = $1 and m.role = 'owner' and m.is_active`, [w.id]);
      for (const o of owners.rows) {
        await enqueue('email.send', {
          to: o.email, locale: o.locale, template: w.kind === 'trial' ? 'trial_ending' : 'grace_ending',
          url: `${appUrl()}/w/${w.slug}/settings/billing`, days, workspaceName: w.name,
        }, { workspaceId: w.id, db });
      }
    });
  }
}
