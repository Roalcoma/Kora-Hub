# ADR 0005 · Facturación con Stripe sin SDK, ciclo de vida del plan, superadmin y agencias de cualquier rubro

**Estado:** aceptada · 2026-10-07 (Ola 4, ver [docs/plan-ola-4.md](../plan-ola-4.md))

## 1. Stripe por REST y en modo simulado
No hay cuenta de Stripe todavía. Se programa contra el API real con `fetch` (form-urlencoded) y la firma del
webhook (`Stripe-Signature`, HMAC-SHA256 de `t.payload`, tolerancia de 5 min) se verifica con `node:crypto`.
**No se agrega el SDK** (misma razón que SigV4 en ADR 0004: tres llamadas no justifican una dependencia).

- Con `STRIPE_SECRET_KEY` vacío la facturación queda **simulada**: `POST /billing/checkout` devuelve una URL de la
  propia app (`/w/:slug/settings/billing?simulated=<plan>`), y `POST /billing/simulate` (solo el Owner, solo en
  este modo) aplica el mismo manejador interno que usarían los eventos reales. Así se prueba todo el ciclo sin Stripe.
- Webhook: `POST /api/v1/webhooks/stripe` recibe el cuerpo **crudo** (antes de `express.json`), usa `adminPool`
  y es idempotente con `stripe_events`. Eventos: `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
- Variables nuevas: `STRIPE_PRICE_STANDARD`, `STRIPE_PRICE_PRO` (ids de precio) y `PRICE_STANDARD_CENTS`,
  `PRICE_PRO_CENTS` (lo que muestra la UI; por defecto 600 y 900).

## 2. Puestos
Puesto = miembro activo que no es `guest`. El job `billing.sync_seats` (encolado al cambiar miembros, con
`dedupe_key` por workspace) actualiza la cantidad de la suscripción si difiere de `billing_seats`.

## 3. Ciclo de vida (lo aplica el job diario `billing.lifecycle` + los eventos)
| De | A | Cuándo |
|---|---|---|
| trialing | active | pago confirmado |
| trialing | read_only | vence `trial_ends_at` sin suscripción |
| active | past_due | `invoice.payment_failed` → `grace_ends_at = now() + 7 días` |
| past_due | read_only | vence `grace_ends_at` |
| read_only | suspended | 30 días en solo lectura (`read_only_since`) |
| cualquiera | active | `invoice.paid` / suscripción activa |
| active | read_only | `customer.subscription.deleted` (baja) |

Nunca se borran datos. Avisos al Owner (email + aviso en la app) 3 días y 1 día antes de vencer la prueba o la
gracia, registrados en `billing_notices` para no repetirlos. `closing` queda para la baja con borrado (Ola 5).
El superadmin puede forzar `active` o `suspended` (queda en `audit_log`).

## 4. Superadmin e impersonación
Acceso por `platform_admins` (se otorga con `node ops/make-admin.ts <email>`, nunca desde la app).
Impersonar entra **como el Owner** del workspace durante 30 minutos: JWT con claim `imp: { by, ws, exp }`,
motivo obligatorio, `audit_log` con acción `admin.impersonate` y fin con `admin.impersonate_end`.
La sesión impersonada no puede abrir `/admin`, cambiar contraseña, 2FA, ni facturación (403). La UI muestra una
banda roja fija con "Salir". Si el superadmin no tiene 2FA y el workspace exige 2FA, se rechaza.

## 5. Rubros y categorías
`workspaces.settings` gana `industry` y `category_label` (`{singular, plural}` o `null` = texto por defecto).
La "línea de negocio" sigue llamándose `business_lines` / `lineId` en el código; en la UI se llama como la agencia
decida. Los colores pasan a una paleta fija (`CATEGORY_COLORS`, constraint en BD). Los avisos de PHI/HIPAA solo se
muestran cuando `industry = 'insurance'`.
