# Estado del proyecto

_Lo mantiene el orquestador. Última actualización: 2026-10-07._

## Ola actual: 0 · Cimientos — en compuerta (esperando aprobación de mockups)

| Entregable | Agente | Estado |
|---|---|---|
| `CLAUDE.md` y `.claude/agents/*.md` (11 agentes) | orquestador | Hecho |
| Esquema completo §9 + RLS + FK compuestas (`server/migrations/0001_init.sql`) | arquitecto | Hecho |
| Helper `withWorkspace` / `withAdmin` + runner de migraciones | arquitecto | Hecho |
| Prueba de aislamiento con dos workspaces (`server/test/rls.test.ts`, 10 casos) | arquitecto | Hecho, en verde |
| Contrato v1 (`shared/contracts`: zod + tipos + `Routes` + eventos WS) | arquitecto | Hecho, compila |
| ADR 0001 (aislamiento), 0002 (TS nativo + zod), 0003 (supuestos de §17) | arquitecto | Hecho |
| Entorno local Docker (Postgres 55432, MinIO 59000/59001, Mailpit 51025/58025) | devops | Hecho |
| CI (typecheck + migraciones + pruebas) | devops | Hecho (sin probar en GitHub: no hay remoto) |
| Tokens CSS (`web/src/design/tokens.css`) | disenador-ui | Hecho |
| Mockups de las 8 pantallas, escritorio + móvil (`docs/diseño/mockups.html`, publicado en https://claude.ai/artifact/AizW92hqjj4rwfJgVkSZvX) | disenador-ui | **Esperando aprobación de Rodrigo** |

## Compuerta de la Ola 0 — falta
- [ ] Rodrigo aprueba los mockups (o pide cambios).
- [ ] Rodrigo confirma o corrige los supuestos de ADR 0003 (sobre todo departamentos reales del piloto).
- [ ] Repositorio remoto en GitHub para que corra la CI.

## Siguiente: Ola 1 · Plataforma
backend-plataforma (registro, login, workspaces, invitaciones, roles, middleware) · disenador-ui (componentes + shell)
· frontend-modulos (registro/login/onboarding con mocks del contrato).

## Pendientes registrados
- Las migraciones son solo hacia adelante (sin "down"); una corrección es una migración nueva.
- `audit_log`: el rol de la app solo inserta; confirmar en Ola 1 con la primera escritura real.
- Purga periódica de `ws_tickets` y `password_resets` vencidos → job en Ola 2.
