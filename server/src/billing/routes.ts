// Facturación (ADR 0005 §1): estado, checkout y portal de Stripe, simulador y webhook.
// workspaceContext deja pasar /billing aunque el workspace esté en solo lectura o suspendido: es la salida (pagar).
import { Router, type Request, type Response } from 'express';
import { CheckoutBody, SimulateBillingBody } from '@agencia-hub/contracts';
import { adminPool, withAdmin } from '../db.ts';
import { HttpError, parse } from '../platform/http.ts';
import { forbidImpersonation } from '../platform/auth.ts';
import { tx, requireRole } from '../platform/workspace.ts';
import { alert } from '../ops/alert.ts';
import { simulated, stripe, priceId, verifyWebhook } from './stripe.ts';
import { applyBillingEvent, billingInfo, countSeats, handleStripeEvent, enqueueSeatSync } from './lifecycle.ts';

// Montado en index.ts dentro de /w/:slug (requireAuth + workspaceContext)
export const billingRouter = Router({ mergeParams: true });

const appUrl = () => process.env.APP_URL ?? 'http://localhost:5180';
const billingPage = (req: Request) => `${appUrl()}/w/${req.ws!.slug}/settings/billing`;

/** Escritura de facturación: solo el Owner y nunca en una sesión impersonada */
function ownerOnly(req: Request) {
  forbidImpersonation(req);
  requireRole(req, 'owner');
}

billingRouter.get('/billing', async (req, res) => {
  requireRole(req, 'admin');
  res.json(await tx(req, (db) => billingInfo(db, req.ws!.id)));
});

billingRouter.post('/billing/checkout', async (req, res) => {
  ownerOnly(req);
  const { plan } = parse(CheckoutBody, req.body);
  if (simulated()) return res.json({ url: `${billingPage(req)}?simulated=${plan}` });

  const w = (await adminPool.query(
    'select id, stripe_customer_id, stripe_subscription_id, status from workspaces where id = $1', [req.ws!.id])).rows[0];
  // Con suscripción viva el cambio de plan o de tarjeta va por el portal
  if (w.stripe_subscription_id && !['read_only', 'suspended'].includes(w.status)) {
    throw new HttpError(409, 'already_subscribed', 'Ya hay una suscripción; adminístrala desde el portal de pago');
  }
  const email = (await adminPool.query('select email from users where id = $1', [req.userId])).rows[0].email;
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: priceId(plan), quantity: Math.max(1, await countSeats(adminPool, w.id)) }],
    client_reference_id: w.id,
    ...(w.stripe_customer_id ? { customer: w.stripe_customer_id } : { customer_email: email }),
    metadata: { workspace_id: w.id, plan },
    subscription_data: { metadata: { workspace_id: w.id, plan } },
    success_url: `${billingPage(req)}?checkout=success`,
    cancel_url: `${billingPage(req)}?checkout=cancel`,
  });
  res.json({ url: session.url });
});

billingRouter.post('/billing/portal', async (req, res) => {
  ownerOnly(req);
  if (simulated()) return res.json({ url: billingPage(req) });
  const customer = (await adminPool.query('select stripe_customer_id from workspaces where id = $1', [req.ws!.id])).rows[0].stripe_customer_id;
  if (!customer) throw new HttpError(409, 'no_customer', 'Todavía no hay un método de pago; elige un plan primero');
  const portal = await stripe('POST', '/billing_portal/sessions', { customer, return_url: billingPage(req) });
  res.json({ url: portal.url });
});

/** Solo sin llaves de Stripe: el Owner provoca el evento que mandaría Stripe y pasa por el mismo manejador. */
billingRouter.post('/billing/simulate', async (req, res) => {
  if (!simulated()) throw new HttpError(404, 'not_found', 'Ruta no encontrada');
  ownerOnly(req);
  const body = parse(SimulateBillingBody, req.body);
  const wsId = req.ws!.id;
  await withAdmin(async (db) => {
    const ev = body.event === 'paid'
      ? { type: 'paid' as const, plan: body.plan ?? null, customerId: `sim_cus_${wsId}`, subscriptionId: `sim_sub_${wsId}`,
          periodEnd: new Date(Date.now() + 30 * 86400_000) }
      : { type: body.event };
    await applyBillingEvent(db, { workspaceId: wsId }, ev, { source: 'simulated', actor: req.userId });
    if (body.event === 'paid') await enqueueSeatSync(wsId, db);
  });
  res.json(await billingInfo(adminPool, wsId));
});

// ─── Webhook (fuera de /w y antes de express.json: la firma se calcula sobre el cuerpo crudo) ───

export async function stripeWebhook(req: Request, res: Response) {
  const event = verifyWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET ?? '');
  if (!event?.id) {
    alert(`Webhook de Stripe rechazado (firma inválida o caducada) desde ${req.ip}`);
    throw new HttpError(400, 'invalid_signature', 'Firma inválida');
  }
  await handleStripeEvent(event);   // repetido → no hace nada; igual 204 para que Stripe no reintente
  res.status(204).end();
}
