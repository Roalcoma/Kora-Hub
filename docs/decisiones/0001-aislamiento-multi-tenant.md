# ADR 0001 · Aislamiento multi-tenant: RLS + FK compuestas + dos pools

**Estado:** aceptada · 2026-10-07

## Contexto
Una fuga de datos entre agencias es el riesgo crítico del producto (§16). El plan pide doble barrera: filtro en la app
y Row-Level Security en Postgres.

## Decisión
Tres barreras en la base de datos, además del filtro de la app:

1. **RLS.** Toda tabla de negocio tiene la política `tenant`: `workspace_id = app_ws()`, donde `app_ws()` lee
   `current_setting('app.workspace_id')`. `withWorkspace()` lo fija con `set_config(..., true)` (equivale a
   `SET LOCAL`, se borra al cerrar la transacción, seguro con pool). Sin contexto, `app_ws()` es `null` → cero filas.
2. **FK compuestas `(workspace_id, id)`.** Cada tabla padre tiene `unique (workspace_id, id)` y los hijos la
   referencian con su propio `workspace_id`. La BD rechaza un mensaje en un canal de otro workspace o un
   responsable que no es miembro, aunque la app no lo valide.
3. **Dos roles.**
   - `agencia_app` (`appPool`): no es dueño ni superusuario, RLS aplica. Grants por columna: no puede leer
     `password_hash`/`totp_secret` ni tocar plan/Stripe; no ve `jobs`, `password_resets`, `ws_tickets`.
   - `agencia` (`adminPool`): dueño del esquema, RLS no aplica. Solo para operaciones que por naturaleza cruzan
     tenants: login/registro, aceptar invitación por token, webhooks de Stripe, cola de jobs, superadmin, migraciones.

Tablas globales con políticas propias: `users` (me veo a mí y a los miembros del workspace activo),
`workspaces` (los míos), `workspace_members` (el activo + mis membresías), `push_subscriptions` (las mías).

## Consecuencias
- Un olvido de `where workspace_id = ...` en la app devuelve vacío en vez de datos ajenos.
- Código que use `adminPool` es de alto riesgo: Seguridad lo revisa línea por línea.
- Toda tabla nueva debe repetir el patrón (lo exige `CLAUDE.md`). La prueba `server/test/rls.test.ts` es la base
  de la suite de aislamiento de QA.
