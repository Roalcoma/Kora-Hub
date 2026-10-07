# Kora — resumen para quien continúa el proyecto

Documento de traspaso, escrito el 2026-10-07 por la sesión de Claude que construyó las Olas 0 a 3.
Léelo junto con [CLAUDE.md](CLAUDE.md) (reglas obligatorias), [PLAN.md](PLAN.md) (plan maestro original)
y [docs/estado.md](docs/estado.md) (avance detallado y pendientes).

---

## 1. Qué es

**Kora** (antes "Agencia Hub") es un SaaS multi-tenant tipo Slack para agencias de seguros (Salud, Vida, Medicare):
chat en tiempo real, anuncios con confirmación, manuales, tareas y metas semanales.

- Bilingüe español / inglés. Toda la UI y los textos de referencia están en español.
- Pensado sobre todo para iPhone, como PWA instalable con notificaciones push.
- Dueño del producto: **Rodrigo** (rodrigoalfonzo97@gmail.com).
- Repositorio: https://github.com/Roalcoma/Kora-Hub, rama `main`.

El nombre interno sigue siendo `agencia-hub`: carpeta, paquetes npm (`@agencia-hub/*`), base de datos `agencia_hub`
y bucket. Solo cambió lo que ve el usuario.

---

## 2. Cómo levantarlo

Requisitos: Node ≥ 22.18 y Docker. El proyecto se desarrolló en Windows 11.

```bash
npm install
cp .env.example .env          # rellenar VAPID con: npx web-push generate-vapid-keys
npm run db:up                 # Postgres 16, MinIO y Mailpit (ops/docker-compose.yml)
npm run migrate
npm run dev:api               # API en http://localhost:4300
npm run dev:web               # Web en http://localhost:5180 (proxy /api → 4300)
npm test                      # pruebas del backend (requiere la BD arriba)
npm run typecheck
npm run build
```

| Servicio | Puerto |
|---|---|
| API | 4300 |
| Web (Vite) | 5180 |
| Postgres | 55432 |
| MinIO API / consola | 59000 / 59001 |
| Mailpit SMTP / web | 51025 / 58025 |

`/_design` muestra el design system.

**Cuentas de demo**: solo existen en la BD local de Rodrigo. Se crean registrándose en la app.

| Cuenta | Email | Contraseña | Rol |
|---|---|---|---|
| Owner | `demo@agencia-hub.test` | `demo-local-12345` | Owner de `agencia-piloto-seguros` |
| Invitada | `ana@agencia-hub.test` | `demo-local-12345` | Líder |

---

## 3. Stack y decisiones técnicas

- **Backend**:
  - Node 22 ejecuta TypeScript directo (*type stripping*, sin build). Solo sintaxis borrable: nada de `enum`,
    `namespace` ni parameter properties. Los imports llevan extensión `.ts`.
  - Express 5, zod 4 y `pg` con SQL plano, sin ORM.
- **Base de datos**: PostgreSQL 16 con **RLS** ([ADR 0001](docs/decisiones/0001-aislamiento-multi-tenant.md)).
  - Dos roles. `agencia_app` (appPool) tiene RLS activa y se usa en todo lo de negocio. `agencia` (adminPool) es el
    dueño del esquema, no tiene RLS y se usa solo para login/registro, invitaciones por token, jobs, webhooks y
    superadmin.
  - `withWorkspace(ctx, fn)` en `server/src/db.ts` fija `app.workspace_id` / `app.user_id` con `set_config`. Las
    políticas usan `app_ws()` y `app_user()`.
  - Las referencias entre tablas usan FK compuestas `(workspace_id, id)`, así la BD rechaza mezclar agencias.
  - El `workspace_id` sale siempre de la sesión y del slug de la ruta, nunca del body.
- **Contrato**: `shared/contracts/` es la fuente de verdad, con esquemas zod, tipos, el mapa `Routes` y los eventos
  WebSocket. El front tiene un cliente tipado (`web/src/api.ts`): `api('PATCH /w/:slug/tasks/:id', { params, body })`.
- **Tiempo real**: WebSocket `/ws` con ticket de un solo uso (`POST /w/:slug/ws-ticket`). El bus vive en memoria, para
  una sola instancia ([ADR 0004](docs/decisiones/0004-archivos-por-la-api-y-bus-en-memoria.md)); con varias
  instancias habrá que pasar a `LISTEN/NOTIFY`.
- **Archivos**: van a MinIO pasando por la API, que firma con SigV4 propio usando `node:crypto`; nunca hay URL
  pública. La cuota de almacenamiento la mantiene un trigger (migración 0005). No hay miniaturas en el servidor.
- **Push y email**: `web-push` con VAPID y nodemailer hacia Mailpit. Hay una cola de jobs en Postgres con
  `SKIP LOCKED` (`server/src/jobs/`). El worker arranca dentro de `main.ts`.
- **Frontend**:
  - Vue 3, Vite 8, TypeScript **~5.9** (TS 7 rompe vue-tsc), Tailwind v4 con tokens en `@theme`, Pinia, vue-router 5,
    vue-i18n 11, lucide-vue-next.
  - Tiptap 3 para el editor de manuales.
  - Sin librerías de gráficas: las de Metas son SVG propio.
- **PWA**: `web/public/sw.js` (push, insignia, caché del shell), `manifest.webmanifest` e íconos que genera
  `ops/make-icons.ps1`.

---

## 4. Mapa del código

```
server/
  migrations/0001..0005.sql     esquema completo + RLS (0001 ya trae las tablas de las Olas 3 y 4)
  src/db.ts, migrate.ts, index.ts (monta routers), main.ts (http + ws + worker)
  src/platform/                 auth, sesiones, 2FA, workspaces, miembros, invitaciones, permisos
                                workspace.ts: tx(), requireRole(), isAdmin(), canManageDept(), membersOnly
  src/chat/                     canales, DMs, mensajes, hilos, reacciones, fijados, anuncios, búsqueda
  src/realtime/hub.ts           WebSocket, presencia, publish()
  src/files/                    subida/descarga (s3.ts firma SigV4)
  src/notifications/            reglas de push (rules.ts), envío (push.ts), email
  src/jobs/                     cola + worker (notify.message, notify.task, reports.remind, email.send, cleanup)
  src/docs/  tasks/  goals/     módulos de la Ola 3
  test/                         rls, platform, chat, rules, modules (node:test, 50 pruebas)
shared/contracts/src/           common, platform, chat, files, modules, realtime, routes
web/src/
  api.ts, router.ts, stores/session.ts, i18n/{es,en,index}.ts
  design/                       Button, Input, Textarea, Dropdown (con `searchable`), Modal, SlideOver, Tabs, Avatar,
                                Badge, Tooltip, Toast, EmptyState, Skeleton, ContextMenu, Popover, Kbd, tokens.css
  layouts/AppShell.vue          riel + sidebar contraíble + tarjeta de usuario + barra inferior móvil
  platform/                     login, registro, invitaciones, onboarding, Ajustes (2 columnas), timezones.ts
  chat/                         store (WebSocket compartido, `listen()` para otros módulos), mensajes, compositor, etc.
  docs/                         Manuales: DocsPage, DocsHome (portada), DocTree, DocView, DocEditor (Tiptap), DocCard
  tasks/                        Tareas: store, TasksPage (kanban/lista/mías), TaskCard, TaskPanel, TaskCompose
  goals/                        Metas: GoalsPage, GoalChart, ReportForm, GoalModal
.claude/agents/                 11 agentes con zonas de escritura (ver CLAUDE.md)
docs/decisiones/                ADR 0001-0004
docs/diseño/mockups.html        mockups aprobados (https://claude.ai/artifact/AizW92hqjj4rwfJgVkSZvX)
ops/                            docker-compose, init de Postgres, íconos, README con cuentas demo
```

---

## 5. Lo que está hecho, por ola

### Ola 0 · Cimientos (cerrada)
Esquema y RLS, contrato v1, entorno Docker, CI, tokens de diseño y mockups.

### Ola 1 · Plataforma (cerrada)
- Registro con plantilla ("Agencia de seguros" o "En blanco"), login con 2FA TOTP, recuperar contraseña.
- Invitaciones por email o por enlace, roles Owner/Admin/Líder/Miembro/Invitado, departamentos y líneas de negocio.
- Design system, shell de la app y onboarding de 5 pasos (incluye la activación de notificaciones).

### Ola 2 · Chat completo (falta probar en un iPhone real)
- Canales públicos y privados, DMs 1:1 y grupales, hilos, menciones @persona/@canal/@aquí, edición y borrado,
  reacciones, fijados, destacados, silenciar.
- No leídos sincronizados, búsqueda sin acentos, "escribiendo…", presencia, reconexión.
- Anuncios con "Entendido" y panel de confirmaciones.
- Archivos (pegar o arrastrar), push con las reglas §6 del plan, Ctrl+K, vista iPhone.

### Ola 3 · Módulos (hecha, falta la revisión de Rodrigo)
- **Manuales**:
  - Árbol por departamento y editor Tiptap con títulos, listas, tablas, imágenes y enlaces.
  - Guarda solo. Las ediciones de la misma persona dentro de 10 minutos se juntan en una versión.
  - Historial con vista previa y "Restaurar". Adjuntos PDF/Office.
  - Búsqueda sin acentos con fragmento marcado.
  - El servidor limpia el JSON (`server/src/docs/content.ts`): quita imágenes externas y enlaces `javascript:`.
  - Un enlace a un manual pegado en el chat se ve como tarjeta. Portada de biblioteca con conteo por departamento y
    los manuales recientes.
  - Permisos: todos leen; editan el Admin y el Líder (`is_lead`) del departamento.
- **Tareas**:
  - Kanban (arrastrar entre columnas, posición fraccional), lista y "Mis tareas", que es la vista por defecto en el
    teléfono.
  - Detalle en panel lateral con responsables, prioridad, fecha límite (vencidas en rojo), checklist y comentarios.
  - "Crear tarea" desde el menú de un mensaje; la tarea queda enlazada al mensaje.
  - Eventos `task.*` por WebSocket, que no llegan a invitados.
  - Avisos (job `notify.task`): al asignar, al comentar y 24 h antes del vencimiento.
  - Permisos: crean los miembros del departamento; gestionan el Admin, el Líder del departamento y el creador; los
    responsables cambian estado, orden y checklist.
- **Metas**:
  - El Admin define indicadores semanales por departamento y, opcionalmente, por línea.
  - El Líder reporta la semana actual o la anterior. El objetivo se **copia** al reporte, así el histórico no cambia.
    Las semanas viejas solo las corrige un Admin y queda en `audit_log`.
  - Tablero con semáforo (ícono y texto), tendencia SVG con tooltip, vista tabla, CSV a prueba de fórmulas y PDF por
    impresión.
  - Recordatorio push los viernes desde las 15:00 hora de Nueva York (job `reports.remind`).
- **Ajustes visuales pedidos por Rodrigo** (ver §6): tarjeta de usuario al pie del sidebar, tipografía Plus Jakarta
  Sans, estados vacíos asimétricos, Ajustes a dos columnas, zona horaria con selector buscable y encabezado del
  sidebar con estado del plan y filtro de línea como barra segmentada.

Pruebas: 50 en verde. Cubren el aislamiento entre agencias en cada módulo, los permisos por rol, el chat por
HTTP + WebSocket y las reglas de push.

---

## 6. Preferencias de Rodrigo (obligatorias)

Están en CLAUDE.md, regla 6. Las repito porque él las revisa en cada entrega:

- **Profundidad**: sombras en tres niveles, hovers que elevan, paneles que proyectan sombra. Nada plano.
- **Asimetría en la composición**: columna principal más contexto, acentos laterales, estados vacíos alineados a la
  izquierda. Nunca un ícono centrado solo en la pantalla.
- **Pero simetría entre tarjetas hermanas**: si dos tarjetas del mismo tipo van lado a lado, llevan el mismo ancho, el
  mismo alto y las acciones alineadas (`.split.even`). Le molestó verlas desparejas.
- **Sin grandes huecos**: revisar cada pantalla a 1600 px de ancho; el contenido debe ocupar el ancho.
- Fondo gris casi blanco (`#F7F8FA`), nunca beige.
- Modales **siempre centrados** (`Modal.vue`); nunca `<select>` nativo (`Dropdown.vue`). Las listas conocidas, como
  zona horaria o idioma, van con `Dropdown searchable`, nunca como texto libre.
- Sidebar **contraíble** (Ctrl+Shift+D). Lo considera muy importante.
- Siempre visible quién está logueado y un acceso claro al perfil.
- Tipografía: Roboto para el texto y Plus Jakarta Sans para los títulos. **No usar Bricolage Grotesque**: le pareció
  "chata y fea".
- Esquinas rectas (`border-radius: 0`), sin emojis en la UI, y texto sobre naranja `#F69008` siempre en `--color-ink`.
- Habla en español y trabaja por **olas con compuerta**: presentar lo hecho y esperar su visto bueno antes de la
  siguiente ola.

---

## 7. Pendiente y próximos pasos

**Decisión abierta (preguntar a Rodrigo antes de avanzar):** él quiere que la app sirva a *cualquier tipo de agencia*,
no solo de seguros. Se le propuso esto y todavía no respondió:
1. Convertir la "línea de negocio" en una categoría que cada agencia nombra a su gusto ("Producto", "Sede", "Cliente"…)
   y que sea opcional; el selector ya se oculta si no hay líneas.
2. Plantillas al registrarse: Seguros, Marketing, Inmobiliaria, Viajes y En blanco
   (`server/src/platform/template.ts`).
3. Textos neutros, sin "pólizas" ni Medicare fijos, con colores de categoría elegibles. Los avisos de PHI/HIPAA solo en
   la plantilla de seguros.

**Compuertas sin cerrar**
- Ola 2: probar push en un iPhone real. Requiere HTTPS, por ejemplo con
  `cloudflared tunnel --url http://localhost:5180`. El navegador integrado de la app de Claude no registra service
  workers; Chrome de escritorio sí.
- Ola 3: revisión de Rodrigo.
- Revisión del agente `seguridad` sobre las Olas 0 a 3. Se ofreció y no se ha hecho.

**Ola 4 (siguiente, según PLAN.md §14)**: Stripe (checkout, portal, webhooks), backoffice de superadmin, pantalla de
facturación, landing con precios y despliegue del piloto con Cloudflare Tunnel, backups y alertas a Telegram. El
esquema ya tiene las columnas de Stripe y la tabla `stripe_events`.

**Deuda registrada** (detalle en docs/estado.md):
- Ctrl+K todavía no busca manuales ni tareas: `GET /search-all` está en el contrato pero no implementado.
- Falta el resumen del lunes en #anuncios.
- Las semanas de metas y el recordatorio usan la hora de Nueva York para todos; falta una zona por agencia.
- Falta conectar avatar y logo (`avatarUrl` y `logoUrl` siempre son null) y las vistas previas de enlaces (riesgo de
  SSRF).
- Recordatorio a quien no confirmó un anuncio.
- Archivos de manuales: cualquier miembro, incluidos invitados que conozcan el id, puede descargarlos.
- El kanban no se arrastra en pantallas táctiles.
- Rate-limit y bus de tiempo real en memoria: solo sirven para una instancia.
- Hay una prueba intermitente cuando el servidor de desarrollo está encendido, porque su worker consume la misma cola
  de jobs. Correr `npm test` con la API de desarrollo apagada.

---

## 8. Cosas que conviene saber (tropiezos ya resueltos)

- **Windows**: los heredocs de bash fallan con comillas raras. Para ediciones grandes es más seguro escribir un
  script en un archivo.
- **vue-i18n**: los plurales se llaman como `t(key, { n }, count)`, la `@` se escapa como `{'@'}` y los formatos de
  fecha son `short`, `long` y `day` (en `i18n/index.ts`).
- **pg** convierte las columnas `date` a medianoche local y eso puede correr el día. En metas se formatea con `to_char`
  en SQL.
- **Store de tareas**: ignora versiones más viejas que la que ya tiene (`updatedAt`), porque respuestas y eventos
  llegan desordenados.
- **Tailwind preflight** quita los marcadores de las listas y el margen automático de los `<dialog>`. Por eso
  `Modal.vue` fija `margin: auto` y el editor de manuales repone `list-style`.
- **Las zonas de hover de los SVG** van encima de las marcas (GoalChart).
- **AppShell** mantiene montadas las pantallas usando `route.meta.view`: no se recargan al cambiar de manual ni al
  abrir una tarea con `?t=`.
- **CI de GitHub**: es solo manual (`workflow_dispatch`) porque Rodrigo pidió que no corra solo.
- **Commits** en español y pequeños por feature. Hacer push solo cuando Rodrigo lo pida.
- `.env` está en `.gitignore` y nunca se subió.
