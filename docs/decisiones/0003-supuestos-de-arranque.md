# ADR 0003 · Supuestos para arrancar mientras siguen abiertas las decisiones de §17

**Estado:** provisional · 2026-10-07 — se reemplaza cuando Rodrigo decida cada punto.

| # | Decisión pendiente | Supuesto con el que se trabaja | Impacto si cambia |
|---|---|---|---|
| 1 | Nombre y dominio | "Kora", `app.agencia-hub.local` en desarrollo | Textos de i18n, manifest, landing |
| 2 | Departamentos y metas del piloto | Plantilla: Ventas, Servicio al cliente, Renovaciones, Administración; líneas Salud/Vida/Medicare | Solo la plantilla y la demo |
| 3 | Precios | Los de §3.5 ($6 / $9) | Configuración de Stripe |
| 4 | Proveedor con BAA | Se decide antes de vender a clientes de Salud/Medicare | Ola 4 / despliegue |
| 5 | Entidad de Stripe | Pendiente; Stripe solo en modo test hasta decidir | Ola 4 |
| 6 | Invitados externos | El rol `guest` existe en el esquema; la UI llega después del piloto | Ninguno ahora |

Otros cambios menores al plan:
- **Mailpit** en vez de MailHog (MailHog está abandonado; misma función).
- El agente `diseñador-ui` se llama `disenador-ui` (los nombres de agentes no admiten `ñ`).
