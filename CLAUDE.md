# Kora — reglas para todos los agentes

SaaS multi-tenant tipo Slack para agencias de seguros (Salud, Vida, Medicare). El plan completo está en
[PLAN.md](PLAN.md); el avance en [docs/estado.md](docs/estado.md); las decisiones en [docs/decisiones/](docs/decisiones/).

**Si llegas nuevo al proyecto, lee primero [resumen.md](resumen.md):** traspaso de todo lo construido (Olas 0–3),
preferencias de Rodrigo, decisiones abiertas y tropiezos ya resueltos.

## Comandos

```bash
npm install                      # instala todos los workspaces (shared/contracts, server)
npm run db:up                    # levanta Postgres, MinIO y Mailpit (ops/docker-compose.yml)
npm run migrate                  # aplica server/migrations/*.sql pendientes
npm test                         # pruebas del backend (node:test, requiere la BD arriba)
npm run typecheck                # tsc / vue-tsc en todos los workspaces
npm run dev:api                  # API en :4300
npm run dev:web                  # Vite en :5180 (proxy /api → :4300); /_design muestra el design system
```

Puertos locales (elegidos para no chocar con otros proyectos de la laptop):
API `4300` · Web `5180` · Postgres `55432` · MinIO API `59000` / consola `59001` · Mailpit SMTP `51025` / web `58025`.

## Reglas comunes (§13.2 del plan)

1. **Idioma:** comentarios, commits, textos de UI de referencia y reportes en **español**; la UI además en
   inglés vía i18n. Nombres de código (variables, tablas, rutas) en **inglés**.
2. **Stack fijo** (§8): Vue 3 + Vite + TS + Tailwind v4 + Pinia · Node 22+ con TS nativo (type stripping, sin build)
   + Express 5 + zod · PostgreSQL 16 sin ORM (SQL plano con `pg`). **Prohibido añadir dependencias** sin
   aprobación del orquestador; justificarlo en el reporte.
3. **Multi-tenant obligatorio** (ver [ADR 0001](docs/decisiones/0001-aislamiento-multi-tenant.md)):
   - Toda tabla de negocio nueva lleva `workspace_id` + política RLS `tenant` + `grant` al rol `agencia_app`.
   - Toda consulta de negocio corre dentro de `withWorkspace(ctx, fn)` (`server/src/db.ts`), que hace
     `set_config('app.workspace_id', …, true)`. El `workspace_id` sale **siempre** de la sesión + ruta validada,
     nunca del body/query.
   - Las referencias cruzadas usan FK compuestas `(workspace_id, id)`: la BD rechaza mezclar workspaces.
   - `adminPool` (sin RLS) solo para: login/registro, aceptar invitación, webhooks de Stripe, jobs, superadmin.
4. Validar toda entrada con **zod** en el borde de la API (esquemas en `shared/contracts`).
5. El contrato de `shared/contracts/` es la **fuente de verdad**. Solo el `arquitecto` lo cambia.
6. **Diseño:** solo tokens y componentes de `web/src/design/`; `border-radius: 0` en todo (excepto el punto de
   presencia); sin `<select>` nativo; sin emojis en la UI; texto sobre `#F69008` en `--color-ink`.
   **Profundidad y asimetría (pedido de Rodrigo, punto importante):** nada plano ni simétrico. Tres niveles de
   elevación con sombras (`--shadow-sm` superficie, `--shadow-md` tarjetas/compositor, `--shadow-lg` flotantes y
   paneles), hovers que elevan, paneles que proyectan sombra sobre el contenido. Composición asimétrica: columnas de
   distinto peso, encabezados y estados vacíos alineados a un lado, acentos laterales; evitar todo centrado en espejo.
   Fondo general gris casi blanco (`--color-canvas`). **Modales siempre centrados** (`Modal.vue`) y desplegables con
   `Dropdown.vue`; nunca controles con aspecto nativo. El sidebar es contraíble (Ctrl+Shift+D) y debe seguir siéndolo.
   **Sin huecos:** a 1600 px el contenido llena el ancho (dos columnas de distinto peso, tarjetas); los estados vacíos van
   alineados a la izquierda (`EmptyState`), nunca un ícono centrado solo. Siempre visible quién está logueado (tarjeta al pie
   del sidebar). Títulos en Plus Jakarta Sans (Bricolage se descartó).
   Tarjetas hermanas lado a lado (mismo tipo de contenido): mismo ancho y alto, acciones alineadas (`.split.even`).
   Valores de una lista conocida (zona horaria, idioma…): `Dropdown` con `searchable`, nunca un input de texto.
7. Toda feature incluye pruebas: caso feliz, permiso denegado y **aislamiento entre workspaces**.
8. Commits pequeños por feature, en español, con el coautor que indique el sistema. **No hacer push a `main`.**
9. Leer el código existente antes de escribir; imitar su estilo y densidad de comentarios.
10. No dejar `TODO` sin registrar: lo pospuesto va en el reporte y en `docs/estado.md`.
11. **Reporte final de cada entrega:** qué se hizo · archivos tocados · cómo probarlo · pruebas y resultado ·
    pendientes/riesgos · cambios de contrato solicitados.

## Zonas por agente

Cada agente (`.claude/agents/`) escribe **solo** en su zona. Para tocar otra zona, lo pide al orquestador.

| Agente | Zona |
|---|---|
| arquitecto | `server/migrations/`, `shared/contracts/`, `docs/decisiones/`, `server/src/db.ts` |
| disenador-ui | `web/src/design/`, `web/src/App.vue`, layouts, `docs/diseño/` |
| backend-plataforma | `server/src/platform/`, `server/src/index.ts` |
| backend-chat | `server/src/chat/`, `server/src/realtime/` |
| backend-notificaciones | `server/src/notifications/`, `server/src/files/`, `server/src/jobs/` |
| backend-modulos | `server/src/docs/`, `server/src/tasks/`, `server/src/goals/` |
| frontend-chat | `web/src/chat/`, `web/public/` |
| frontend-modulos | `web/src/platform/`, `web/src/docs/`, `web/src/tasks/`, `web/src/goals/`, `landing/` |
| qa | `server/test/`, `web/e2e/`, `docs/qa/` |
| seguridad | solo lectura; reportes en `docs/seguridad/` |
| devops | `ops/`, `Dockerfile`, `.github/workflows/`, `.env.example`, `package.json` raíz |

## Convenciones técnicas

- Imports de TS con extensión `.ts` (Node ejecuta TypeScript directo; solo sintaxis "borrable": nada de `enum`,
  `namespace` ni parameter properties).
- IDs `uuid` (`gen_random_uuid()`); fechas `timestamptz`; paginación por cursor `(created_at, id)`.
- Errores de la API: `{ error: string, code: string }`.
- Búsqueda: columnas `tsvector` generadas con `immutable_unaccent()` + índices trigram.
