// Cliente Stripe mínimo: REST con fetch (form-urlencoded) y firma de webhooks con node:crypto, sin SDK (ADR 0005 §1).
// Sin STRIPE_SECRET_KEY la facturación queda simulada: nadie llama a Stripe y los eventos los provoca el Owner.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Plan } from '@agencia-hub/contracts';

export const simulated = () => !process.env.STRIPE_SECRET_KEY;

/** Lo que muestra la UI, por usuario al mes (supuesto de precios del ADR 0003) */
export const pricesCents = () => ({
  standard: Number(process.env.PRICE_STANDARD_CENTS || 600),
  pro: Number(process.env.PRICE_PRO_CENTS || 900),
});

export const priceId = (plan: 'standard' | 'pro') =>
  (plan === 'pro' ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_STANDARD) ?? '';

/** Plan a partir del id de precio de Stripe (null si no es uno de los nuestros) */
export function planFromPrice(id: string | undefined): Exclude<Plan, 'trial'> | null {
  if (id && id === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (id && id === process.env.STRIPE_PRICE_STANDARD) return 'standard';
  return null;
}

/** `{ a: { b: [1] } }` → `a[b][0]=1`, el formato que espera el API de Stripe */
function form(params: object, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe<T = any>(method: 'GET' | 'POST', path: string, params: object = {}): Promise<T> {
  const body = form(params);
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && [...body].length ? `?${body}` : ''}`, {
    method,
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? body : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message ?? 'error'}`);
  return json;
}

// ─── Firma del webhook: `Stripe-Signature: t=<seg>,v1=<hex>[,v1=…]` = HMAC-SHA256(secret, `${t}.${payload}`) ───

const TOLERANCE_SEC = 5 * 60;
const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

/** Cabecera firmada (la usan las pruebas para fabricar eventos como los de Stripe) */
export const signHeader = (payload: string, secret: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${hmacHex(secret, `${t}.${payload}`)}`;

/** Verifica la firma y devuelve el evento; null si la firma no cuadra o es de hace más de 5 min. */
export function verifyWebhook(raw: Buffer, header: string | undefined, secret: string, now = Date.now()): any | null {
  if (!header || !secret) return null;
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > TOLERANCE_SEC) return null;
  const expected = Buffer.from(hmacHex(secret, `${t}.${raw.toString('utf8')}`));
  const ok = parts.some(([k, v]) => k === 'v1' && v?.length === expected.length && timingSafeEqual(Buffer.from(v), expected));
  if (!ok) return null;
  try { return JSON.parse(raw.toString('utf8')); } catch { return null; }
}
