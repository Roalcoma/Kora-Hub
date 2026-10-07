# Agencia Hub — Plan maestro del proyecto

> **Nombre provisional.** SaaS multi-tenant de comunicación y operación interna para agencias de seguros
> (Salud, Vida, Medicare), inspirado en Slack. Cliente piloto: la agencia que hizo la petición original.
>
> **Estado:** planificación. **No se escribe código hasta que Rodrigo apruebe este documento.**
> Última actualización: 2026-10-07.

---

## Índice

1. [Visión y modelo de negocio](#1-visión-y-modelo-de-negocio)
2. [Requerimientos del cliente piloto](#2-requerimientos-del-cliente-piloto)
3. [Modelo SaaS multi-tenant](#3-modelo-saas-multi-tenant)
4. [Roles y permisos](#4-roles-y-permisos)
5. [Módulos funcionales](#5-módulos-funcionales)
6. [Notificaciones (iPhone incluido)](#6-notificaciones-iphone-incluido)
7. [Identidad visual y UX](#7-identidad-visual-y-ux)
8. [Arquitectura técnica](#8-arquitectura-técnica)
9. [Modelo de datos](#9-modelo-de-datos)
10. [API y tiempo real](#10-api-y-tiempo-real)
11. [Seguridad y cumplimiento (HIPAA)](#11-seguridad-y-cumplimiento-hipaa)
12. [Estructura del repositorio](#12-estructura-del-repositorio)
13. [Equipo de subagentes](#13-equipo-de-subagentes)
14. [Plan de ejecución por olas](#14-plan-de-ejecución-por-olas)
15. [Definición de "hecho" y calidad](#15-definición-de-hecho-y-calidad)
16. [Riesgos](#16-riesgos)
17. [Decisiones pendientes](#17-decisiones-pendientes)

---

## 1. Visión y modelo de negocio

- **Producto:** una sola app donde una agencia de seguros chatea, publica anuncios, guarda sus manuales,
  gestiona tareas y reporta metas semanales, todo organizado por **departamento × línea de negocio**.
- **Mercado:** agencias de seguros en EE. UU. (hispanas y angloparlantes) → la app es **bilingüe (es/en)** desde el día 1.
- **Modelo:** SaaS con suscripción mensual **por usuario activo** (como Slack). Cada agencia es un *workspace* aislado.
- **Diferenciador frente a Slack:** viene preparado para agencias de seguros (líneas de negocio, manuales,
  metas semanales de ventas, anuncios con confirmación de lectura) sin configurar nada.
- **Cliente piloto:** usa la app gratis o con descuento durante el piloto a cambio de feedback.

---

## 2. Requerimientos del cliente piloto

| # | Requerimiento | Módulo |
|---|---|---|
| 1 | Comunicación interna entre departamentos | Chat (5.1) |
| 2 | Manuales y procedimientos de cada departamento | Manuales (5.3) |
| 3 | Lista de tareas y pendientes por departamento | Tareas (5.4) |
| 4 | Reportes semanales de metas y cumplimiento | Metas (5.5) |
| 5 | Sala general de comunicados y anuncios | Anuncios (5.2) |
| 6 | Funcional para 3 líneas: Salud, Vida, Medicare | Transversal (líneas de negocio) |

---

## 3. Modelo SaaS multi-tenant

### 3.1 Conceptos
- **Workspace** = una agencia (tenant). Tiene nombre, slug, logo, plan, estado de suscripción.
- **Usuario** = persona con cuenta global (un email). Puede pertenecer a **varios workspaces**
  (como Slack) con un rol distinto en cada uno.
- **Departamentos** y **líneas de negocio** son **configurables por workspace**. Al crear el workspace se
  ofrece la plantilla "Agencia de seguros" (líneas Salud / Vida / Medicare + departamentos sugeridos).

### 3.2 Aislamiento de datos (crítico)
- Toda tabla de negocio lleva `workspace_id`.
- **Doble barrera:**
  1. **Capa app:** cada consulta filtra por el `workspace_id` de la sesión (nunca del body/query del cliente).
  2. **Postgres RLS (Row-Level Security):** políticas por `workspace_id` usando
     `SET LOCAL app.workspace_id` en cada transacción. Si la app olvida un filtro, la BD no devuelve datos ajenos.
- Las referencias cruzadas se validan (un canal, tarea o usuario debe pertenecer al mismo workspace).
- Tests automáticos de aislamiento: usuario del workspace A intenta leer/escribir datos de B en **cada endpoint**.

### 3.3 Acceso y dominio
- **Un solo dominio** para la app: `app.<dominio>` con **selector de workspace** (riel izquierdo, como Slack).
  - Motivo: la PWA y las suscripciones push son por origen; con subdominios por agencia, un usuario en dos
    agencias tendría que instalar dos apps.
- Landing pública en `<dominio>` con precios y registro.

### 3.4 Ciclo de vida del cliente
1. **Registro:** crea cuenta + workspace (nombre, slug, plantilla) → prueba gratis de **14 días**.
2. **Onboarding guiado:** departamentos, líneas, invitar equipo, instalar la app en el teléfono.
3. **Invitaciones:** por email o enlace de invitación con expiración y rol predefinido.
4. **Suscripción:** Stripe Checkout + Customer Portal; cobro por usuarios activos; webhooks actualizan el estado.
5. **Impago:** aviso → periodo de gracia (7 días) → solo lectura → suspensión. **Nunca se borran datos** sin aviso.
6. **Baja:** exportación de datos (JSON/CSV + archivos) y borrado definitivo a los 30 días.

### 3.5 Planes (propuesta, a validar)
| Plan | Precio sugerido | Incluye |
|---|---|---|
| Prueba | Gratis 14 días | Todo |
| Estándar | ~$6 / usuario / mes | Todo el producto, 10 GB por workspace |
| Pro | ~$9 / usuario / mes | + confirmación de lectura de anuncios, reportes avanzados, 50 GB, retención configurable |

### 3.6 Backoffice de plataforma (superadmin)
Panel solo para Rodrigo: lista de workspaces, estado de suscripción, uso (usuarios, almacenamiento),
suspender/reactivar, impersonar con registro en auditoría, métricas de negocio (MRR, altas, bajas).

---

## 4. Roles y permisos

Roles **por workspace**:

| Rol | Puede |
|---|---|
| **Owner** | Todo + facturación + borrar workspace (uno o más por workspace) |
| **Admin** | Usuarios, departamentos, líneas, metas, canales; todo el contenido |
| **Líder** | Publica anuncios; gestiona manuales, tareas y reportes de **sus** departamentos |
| **Miembro** | Chatea, lee manuales, trabaja sus tareas, carga avances |
| **Invitado** | Solo los canales a los que se le invita (fase posterior, útil para agentes externos) |

Además: **superadmin de plataforma** (fuera de los workspaces, solo backoffice).

---

## 5. Módulos funcionales

### 5.1 Chat — completo desde la primera entrega
Todo lo siguiente entra en la **Fase 1** (nada queda para después):

- **Canales:** públicos, privados, por departamento, por línea de negocio; descripción y tema; archivar.
- **Mensajes directos** 1 a 1 y **grupales** (hasta 8 personas).
- **Hilos** de respuesta con panel lateral (como Slack), opción "enviar también al canal".
- **Menciones:** `@persona`, `@canal` (todos los del canal), `@aquí` (los conectados); autocompletado al escribir `@`.
  Las menciones resaltan el mensaje y generan notificación aunque el canal esté silenciado.
- **Adjuntos:** imágenes (con miniatura y visor), PDF, documentos de Office; arrastrar y soltar, pegar
  imagen desde el portapapeles, varios archivos por mensaje. Límite por archivo configurable (25 MB por defecto).
- **Búsqueda:** en mensajes y archivos, con filtros (canal, persona, fecha, "tiene archivos"), sin distinguir
  acentos. Resultados con salto al mensaje en contexto.
- **Edición y borrado** de mensajes propios (admins pueden borrar cualquiera); marca "(editado)".
- **Reacciones** con emoji y contador; ver quién reaccionó.
- **Formato de texto:** negrita, cursiva, tachado, código, listas, enlaces con vista previa.
- **No leídos:** contadores por canal, línea "Nuevos mensajes", "Marcar como leído".
- **Indicador "está escribiendo…"** y **presencia** (conectado / ausente).
- **Silenciar** canal, **favoritos** (sección "Destacados" en el sidebar), **mensajes fijados** por canal.

### 5.2 Anuncios
- Canal especial **#anuncios** por workspace: todos leen; solo Owner/Admin/Líder publican.
- Push **siempre** (no se puede silenciar).
- **Confirmación de lectura** opcional por anuncio: botón "Entendido" y panel de quién lo confirmó y quién no.
- Anuncios **fijados** arriba hasta que expiren.

### 5.3 Manuales y procedimientos
- Biblioteca por departamento, páginas con **subpáginas** (árbol).
- Editor enriquecido (títulos, listas, tablas, imágenes, enlaces) + **adjuntar PDF existentes**.
- Etiqueta opcional por línea de negocio; filtro y **búsqueda** de texto completo.
- **Historial de versiones** (quién cambió qué y cuándo, restaurar versión).
- Permisos: lectura para todo el workspace; edición para Líder del depto y Admin.
- Compartir un manual en el chat genera una tarjeta con vista previa.

### 5.4 Tareas y pendientes
- **Tablero kanban** por departamento (Por hacer / En curso / Hecho / Cancelada) + vista **lista**.
- Varios responsables, fecha límite, prioridad, línea de negocio, comentarios, checklist.
- Vista **"Mis tareas"** global.
- Notificación al asignar, al comentar y 24 h antes del vencimiento; vencidas en rojo.
- Crear tarea desde un mensaje del chat (menú del mensaje → "Crear tarea").

### 5.5 Metas y reportes semanales
- **Metas:** el Admin define indicadores semanales por departamento (y opcionalmente por línea):
  nombre, unidad, objetivo semanal. Ej.: "Pólizas Vida vendidas — 15/semana".
- **Reporte semanal:** cada Líder carga lo logrado vs. meta + notas; se guarda el objetivo vigente
  (el histórico no cambia si luego se modifica la meta).
- **Tablero:** % de cumplimiento por departamento y línea, semáforo, comparativa semana a semana,
  tendencia de 12 semanas, exportar a CSV/PDF.
- **Recordatorio** automático el viernes a quien no entregó; resumen el lunes en #anuncios (opcional).

### 5.6 Transversales
- **Selector de línea de negocio** global (Todas / Salud / Vida / Medicare) que filtra canales, manuales, tareas y metas.
- **Búsqueda global** (Ctrl/⌘ + K): personas, canales, mensajes, manuales, tareas.
- **Perfil:** nombre, foto, cargo, departamento, zona horaria, estado personalizado.
- **Idioma** por usuario (español / inglés).

---

## 6. Notificaciones (iPhone incluido)

- La app es una **PWA**: se instala desde Safari → Compartir → "Agregar a pantalla de inicio" (iOS 16.4+).
- **Web Push** estándar con VAPID (`web-push`): sin App Store ni cuenta de Apple Developer.
- **Flujo guiado** en el onboarding: detecta iPhone sin instalar → muestra los pasos con capturas →
  una vez instalada, botón "Activar notificaciones" → botón "Enviarme una prueba".
- **Reglas de envío** (solo si el usuario **no** tiene la app abierta y visible en ningún dispositivo):

| Evento | Push |
|---|---|
| Mensaje directo | Siempre |
| Mención `@persona` | Siempre (aunque el canal esté silenciado) |
| `@canal` / `@aquí` | Si el canal no está silenciado |
| Anuncio | Siempre |
| Mensaje en canal | Según preferencia del usuario: *todos* / *solo menciones* (por defecto: solo menciones) |
| Respuesta en un hilo donde participo | Siempre |
| Tarea asignada / por vencer | Siempre |
| Recordatorio de reporte | Siempre |

- **Agrupación** por canal (tag) para no llenar la pantalla de bloqueo; contador en el ícono de la app.
- Preferencias por usuario: horario de "no molestar", nivel por canal.
- **Plan B futuro:** envolver la PWA con Capacitor y publicar en App Store si algún cliente lo exige.

---

## 7. Identidad visual y UX

### 7.1 Reglas duras
- **Esquinas rectas:** `border-radius: 0` en **todo** (botones, inputs, tarjetas, modales, avatares, badges,
  menús). Única excepción: el punto de presencia (círculo de 8 px).
- **Colores del CRM (Rocco):**

| Token | Hex | Uso |
|---|---|---|
| `--color-primary` | `#F69008` | Acción principal, ítem activo, badges de no leídos, foco |
| `--color-primary-dark` | `#D97706` | Hover/pressed del primario |
| `--color-primary-light` | `#FEF3C7` | Fondo de mensajes con mención, resaltados |
| `--color-ink` | `#13243D` | Sidebar, texto principal, encabezados |
| `--color-ink-soft` | `#1C3150` | Hover en sidebar, riel de workspaces |
| `--color-leaf` | `#2F5D8A` | Enlaces sobre fondo claro |
| `--color-cta` | `#60D0FA` | Acento sobre fondo oscuro (enlaces en sidebar, indicadores) |
| `--color-canvas` | `#F6F4F0` | Fondo general del área de trabajo |

- **Contraste:** el blanco sobre naranja **no** pasa AA → sobre `#F69008` el texto va en `--color-ink`.
  Sobre el sidebar marino, texto blanco/gris claro. Verificar AA en todo componente.
- **Tipografía:** Roboto (texto) + Bricolage Grotesque (títulos, nombre del workspace).
- **Íconos:** Lucide. **Sin emojis en la interfaz** (los emojis solo existen como contenido: reacciones y mensajes).
- **Sin `<select>` nativos:** dropdowns propios (mismo criterio que el CRM).
- Profundidad con sombras sutiles, hovers notorios, animaciones cortas (150–200 ms) que respetan `prefers-reduced-motion`.

### 7.2 Layout (basado en Slack)
```
┌────┬──────────────────┬───────────────────────────────────┬──────────────────┐
│ R  │ SIDEBAR (ink)    │ #canal · tema · [miembros][buscar]│                  │
│ I  │ Agencia ▾        ├───────────────────────────────────┤  PANEL DERECHO   │
│ E  │ [Línea: Todas ▾] │                                   │  (hilo / perfil /│
│ L  │ Buscar  Ctrl+K   │   Mensajes (canvas)               │   detalle tarea) │
│    │ ─ Anuncios       │                                   │                  │
│ W  │ ─ Destacados     │                                   │                  │
│ S  │ ─ Canales        │                                   │                  │
│    │ ─ Mensajes dir.  ├───────────────────────────────────┤                  │
│ +  │ ─ Manuales       │ [Compositor: B I </> @ adj Enviar]│                  │
│    │ ─ Tareas / Metas │                                   │                  │
└────┴──────────────────┴───────────────────────────────────┴──────────────────┘
```
- **Riel de workspaces** (izquierda, `ink-soft`): logos cuadrados de cada agencia + "+".
- **Sidebar** (`ink` con degradado como el CRM): secciones colapsables, no leídos en negrita blanca,
  badge naranja con número, ítem activo con barra naranja a la izquierda.
- **Panel derecho** deslizable para hilos, perfiles y detalle de tarea.
- **Móvil (lo más importante, el cliente usa iPhone):** navegación tipo app de Slack —
  barra inferior (Inicio · Mensajes directos · Menciones · Tareas · Tú), pantallas apiladas, compositor
  pegado al teclado, gestos de volver, áreas táctiles ≥ 44 px, respeta *safe areas* del iPhone.

### 7.3 Proceso de diseño
Antes de programar las pantallas: mockups de las 8 pantallas clave (canal, hilo, DM, anuncios, manual,
kanban, tablero de metas, onboarding) en escritorio y móvil → aprobación de Rodrigo → componentes.

---

## 8. Arquitectura técnica

| Capa | Tecnología | Nota |
|---|---|---|
| Frontend | Vue 3 + Vite + TypeScript + Tailwind v4 + Pinia + vue-router | Mismo stack del CRM |
| i18n | vue-i18n | es / en |
| PWA | manifest + service worker propio | Push, caché del *shell*, ícono y splash |
| Editor (manuales) | Tiptap | Editor enriquecido maduro sobre ProseMirror |
| Backend | Node 22+ (TS nativo) + Express 5 + zod | Igual que el CRM, sin ORM, SQL plano |
| Tiempo real | WebSocket (`ws`) + Postgres `LISTEN/NOTIFY` | NOTIFY permite escalar a varias instancias |
| Base de datos | PostgreSQL 16+ con RLS, `pg_trgm`, `unaccent` | Búsqueda de texto completo nativa |
| Archivos | MinIO (S3) con URLs prefirmadas | Subida directa del navegador a S3 |
| Tareas programadas | Cola simple en Postgres (`SKIP LOCKED`) | Recordatorios, push diferidos, miniaturas |
| Push | `web-push` (VAPID) | |
| Email | SMTP transaccional (Brevo/Resend) | Invitaciones, recuperar contraseña |
| Pagos | Stripe (Checkout, Portal, Webhooks) | |
| Despliegue | Docker Compose; Cloudflare Tunnel en piloto | Producción en VPS (ver §11) |
| Observabilidad | Logs JSON + alertas a Telegram (como el CRM) | |

**Principios:** monolito modular (un backend con módulos bien separados), contrato de API primero
(tipos compartidos en `shared/`), nada de dependencias nuevas sin justificar, migraciones SQL versionadas.

---

## 9. Modelo de datos

Todas las tablas de negocio llevan `workspace_id` + política RLS. Resumen:

**Plataforma**
- `users` (global) · `workspaces` (slug, plan, status, trial_ends_at, stripe_customer_id, stripe_subscription_id)
- `workspace_members` (workspace_id, user_id, role, title, is_active, notif_prefs)
- `invitations` (token, email, role, expires_at) · `platform_admins` · `audit_log`

**Estructura de la agencia**
- `departments` · `business_lines` · `member_departments` (is_lead) · `member_lines`

**Chat**
- `channels` (kind: public | private | dm | group_dm | announcement; department_id, line_id, topic, archived_at)
- `channel_members` (last_read_at, notif_level, muted, starred)
- `messages` (parent_id para hilos, body, body_tsv para búsqueda, edited_at, deleted_at, also_in_channel)
- `message_mentions` (user_id o tipo canal/aquí) · `message_reactions` (emoji, user_id)
- `message_pins` · `announcement_acks` (message_id, user_id, acked_at)
- `files` (storage_key, mime, size, width/height, thumb_key, owner, context) · `message_files`
- `push_subscriptions` (por dispositivo)

**Manuales**
- `documents` (department_id, line_id, parent_id, title, content JSON de Tiptap, content_text para búsqueda)
- `document_versions`

**Tareas**
- `tasks` (department_id, line_id, status, priority, due_date) · `task_assignees` · `task_comments` · `task_checklist_items`

**Metas**
- `goals` (department_id, line_id, unit, weekly_target) · `weekly_reports` (department_id, week_start)
- `weekly_report_items` (goal_id, target copiado, actual)

**Infra**
- `jobs` (cola) · `schema_migrations`

---

## 10. API y tiempo real

- REST bajo `/api/v1`, JSON, validación con zod, errores `{ error, code }`.
- El workspace activo va en la ruta: `/api/v1/w/:workspaceSlug/...`; el backend verifica la membresía.
- Paginación por cursor en mensajes (`before` / `after` por `created_at,id`).
- **WebSocket `/ws`:** autenticación con ticket de un solo uso (no el JWT en la URL).
  Eventos: `message.created|updated|deleted`, `reaction.changed`, `typing`, `presence`, `channel.updated`,
  `read.updated`, `task.*`, `announcement.acked`, `notification`.
- Varias instancias del backend se sincronizan con `LISTEN/NOTIFY` de Postgres.
- El contrato (rutas, tipos de request/response y eventos WS) vive en `shared/contracts/` y es
  **la fuente de verdad** para backend y frontend.

---

## 11. Seguridad y cumplimiento (HIPAA)

- Contraseñas con scrypt; sesiones JWT revocables (token_version); rate-limit en login e invitaciones.
- 2FA (TOTP) opcional por usuario, obligatorio configurable por workspace (plan Pro).
- Archivos privados: URL prefirmada de vida corta; nunca públicos.
- `audit_log`: logins, cambios de rol, borrados, exportaciones, impersonación.
- Backups diarios cifrados de BD y archivos, con prueba de restauración mensual.
- **HIPAA:** al vender a agencias de Salud/Medicare, algunas compartirán datos de pacientes (PHI).
  - **Piloto:** servidor propio, regla explícita de "no PHI en la app" en los Términos.
  - **Producción:** VPS en proveedor que firme **BAA** (p. ej. AWS, DigitalOcean con BAA, etc.),
    cifrado en reposo, bitácora de accesos, retención configurable, Términos + BAA propios con cada cliente.
- Términos de servicio y Política de privacidad (es/en) antes de cobrar.

---

## 12. Estructura del repositorio

```
agencia-hub/
├── PLAN.md                  ← este documento
├── CLAUDE.md                ← reglas globales para todos los agentes (se genera desde §13.2)
├── .claude/agents/          ← definición de cada subagente (se genera desde §13.3)
├── docs/
│   ├── decisiones/          ← ADRs (una decisión de arquitectura por archivo)
│   ├── diseño/              ← mockups y design system
│   └── estado.md            ← tablero de avance que mantiene el orquestador
├── shared/contracts/        ← tipos TS de API y eventos WS (fuente de verdad)
├── server/
│   ├── migrations/
│   └── src/
│       ├── platform/        ← auth, workspaces, miembros, invitaciones, billing, superadmin
│       ├── chat/            ← canales, mensajes, hilos, menciones, reacciones, búsqueda
│       ├── realtime/        ← WebSocket, presencia, LISTEN/NOTIFY
│       ├── notifications/   ← push, reglas, email
│       ├── files/           ← S3/MinIO, miniaturas
│       ├── docs/            ← manuales
│       ├── tasks/
│       ├── goals/
│       └── jobs/            ← cola y tareas programadas
├── web/
│   ├── public/              ← manifest, sw.js, íconos
│   └── src/
│       ├── design/          ← tokens + componentes base (design system)
│       ├── platform/        ← login, registro, onboarding, ajustes, facturación, superadmin
│       ├── chat/
│       ├── docs/
│       ├── tasks/
│       ├── goals/
│       └── i18n/
├── landing/                 ← web pública con precios
└── ops/                     ← docker-compose, backups, túnel, CI
```

---

## 13. Equipo de subagentes

### 13.1 Cómo trabaja el equipo
- **Orquestador = la sesión principal de Claude Code** con Rodrigo. No delega la toma de decisiones:
  reparte trabajo, integra, resuelve conflictos y pide aprobación en cada compuerta.
- Cada subagente es **dueño exclusivo de unas carpetas**. Solo escribe ahí. Si necesita algo de otra
  área, lo pide al orquestador (nunca edita fuera de su zona).
- Los agentes que trabajan en paralelo lo hacen en **git worktrees aislados** (una rama por tarea:
  `feat/<agente>/<tarea>`); el orquestador integra a `main`.
- **Contrato primero:** nadie implementa una ruta o evento que no esté en `shared/contracts/`.
  Frontend puede avanzar en paralelo con *mocks* del contrato.
- Cada entrega termina con un **reporte** (formato en 13.2) y pasa por **QA** y **Seguridad** antes de integrarse.

### 13.2 Reglas comunes (van a `CLAUDE.md`)
1. Idioma: comentarios, mensajes de commit, textos de UI de referencia y reportes **en español**
   (la UI además en inglés vía i18n). Nombres de código en inglés.
2. Stack fijo (§8). **Prohibido añadir dependencias** sin aprobación del orquestador (justificar en el reporte).
3. **Multi-tenant obligatorio:** toda tabla nueva con `workspace_id` + política RLS; toda consulta filtrada por
   el workspace de la sesión; nunca confiar en ids del cliente sin validar que pertenecen al workspace.
4. Validar toda entrada con zod en el borde de la API.
5. Seguir el contrato de `shared/contracts/` al pie de la letra; un cambio de contrato solo lo hace el Arquitecto.
6. Diseño: solo componentes y tokens del design system; `border-radius: 0`; sin `<select>` nativo; sin emojis en UI.
7. Toda feature incluye sus pruebas (al menos: caso feliz, permiso denegado, aislamiento entre workspaces).
8. Commits pequeños por feature, en español, con el coautor que indique el sistema. No hacer push a `main`.
9. Leer el código existente antes de escribir; imitar su estilo y densidad de comentarios.
10. No dejar `TODO` sin registrar: lo que se pospone se anota en el reporte.
11. **Formato de reporte final:** qué se hizo · archivos tocados · cómo probarlo · pruebas y resultado ·
    pendientes/riesgos · cambios de contrato solicitados.

### 13.3 Agentes

> Modelo sugerido: **Opus** para arquitectura, seguridad y lógica compleja; **Sonnet** para implementación
> acotada; **Haiku** para tareas mecánicas. Herramientas por defecto: lectura/escritura en su zona + Bash.

---

#### A1 · `arquitecto` — Datos y contratos
- **Misión:** diseñar y mantener el modelo de datos, las políticas RLS y el contrato de API/WebSocket.
- **Zona:** `server/migrations/`, `shared/contracts/`, `docs/decisiones/`.
- **Entregables:** migraciones SQL con RLS; tipos TS de cada endpoint y evento; ADRs; helper de transacción
  con `SET LOCAL app.workspace_id`.
- **Reglas:**
  - Es el **único** que cambia el contrato o el esquema; los demás le piden cambios vía orquestador.
  - Cada migración es incremental, reversible en lo posible, y no rompe datos existentes.
  - Índices para toda consulta caliente (mensajes por canal, no leídos, búsqueda).
  - Documenta cada decisión no obvia en un ADR.
- **Hecho cuando:** migraciones aplican en limpio, RLS probada con dos workspaces, contrato compila.
- **Modelo:** Opus.

#### A2 · `diseñador-ui` — Design system y layout
- **Misión:** traducir §7 a tokens, componentes base y el *shell* de la app (riel, sidebar, encabezado, panel derecho, navegación móvil).
- **Zona:** `web/src/design/`, `web/src/App.vue`, layouts, `docs/diseño/`.
- **Entregables:** mockups de las 8 pantallas clave (escritorio + móvil) para aprobación; tokens CSS; componentes:
  Button, Input, Textarea, Dropdown, Modal, SlideOver, Tabs, Avatar, Badge, Tooltip, Toast, EmptyState,
  Skeleton, Menu contextual, Kbd; layout responsive.
- **Reglas:**
  - `border-radius: 0` en todo; colores solo vía tokens; contraste AA verificado.
  - Móvil primero para chat (el cliente usa iPhone); safe areas, objetivos táctiles ≥ 44 px.
  - No implementa lógica de negocio; los componentes son "tontos" y reutilizables.
  - Página `/_design` interna con todos los componentes para revisarlos.
- **Hecho cuando:** Rodrigo aprueba mockups y la página de componentes; sin violaciones de contraste.
- **Modelo:** Opus (mockups) / Sonnet (componentes).

#### A3 · `backend-plataforma` — Cuentas, workspaces y SaaS
- **Misión:** todo lo que hace que sea SaaS multi-tenant.
- **Zona:** `server/src/platform/`, `server/src/index.ts` (montaje de rutas, coordinado con el orquestador).
- **Entregables:** registro + creación de workspace con plantilla "Agencia de seguros"; login, recuperación de
  contraseña, 2FA; miembros, roles, invitaciones; departamentos y líneas; middleware de workspace y permisos;
  Stripe (checkout, portal, webhooks, estados trial/active/past_due/suspended); backoffice superadmin; audit_log.
- **Reglas:**
  - El `workspace_id` de la petición sale **siempre** de la sesión + ruta validada, nunca del body.
  - Webhooks de Stripe con verificación de firma e idempotencia.
  - Un workspace suspendido queda en solo lectura, nunca se borran datos automáticamente.
- **Hecho cuando:** flujo registro → invitar → login del invitado → cambio de rol → suscripción de prueba en Stripe test mode, todo con pruebas.
- **Modelo:** Opus.

#### A4 · `backend-chat` — Mensajería y tiempo real
- **Misión:** el corazón del producto: §5.1 y §5.2 completos.
- **Zona:** `server/src/chat/`, `server/src/realtime/`.
- **Entregables:** canales (todos los tipos), membresías, DMs y grupales, mensajes con hilos, menciones, reacciones,
  edición/borrado, fijados, favoritos, no leídos, anuncios con confirmación; búsqueda (tsvector + unaccent + trigramas);
  WebSocket con tickets, presencia, "escribiendo…", eventos; `LISTEN/NOTIFY`.
- **Reglas:**
  - Un usuario solo recibe por WS eventos de canales de los que es miembro **y** de su workspace.
  - Paginación por cursor; nunca cargar historiales completos.
  - Emite un evento interno `notify.*` para que `backend-notificaciones` decida el push (no envía push él mismo).
  - Latencia objetivo: mensaje visible en otros clientes < 300 ms en red local.
- **Hecho cuando:** dos navegadores de un mismo workspace conversan en tiempo real con todas las funciones; un tercero de otro workspace no ve nada.
- **Modelo:** Opus.

#### A5 · `backend-notificaciones` — Push, archivos y tareas programadas
- **Misión:** que todo llegue al teléfono y que los archivos funcionen.
- **Zona:** `server/src/notifications/`, `server/src/files/`, `server/src/jobs/`.
- **Entregables:** suscripciones push por dispositivo; motor de reglas §6 (presencia, silenciados, no molestar,
  agrupación); email transaccional; subida a MinIO con URL prefirmada, validación de tipo/tamaño, miniaturas,
  cuota por workspace; cola de jobs; recordatorios (tareas por vencer, reporte del viernes).
- **Reglas:**
  - Nunca enviar push "silenciosos" (iOS revoca la suscripción): toda notificación se muestra.
  - Borrar suscripciones que devuelven 404/410.
  - Archivos jamás públicos; claves de almacenamiento con prefijo `workspace_id/`.
  - Jobs idempotentes (pueden reintentarse sin duplicar).
- **Hecho cuando:** push verificado en un **iPhone real** con la PWA instalada; adjunto subido y visto desde otro usuario; cuota respetada.
- **Modelo:** Sonnet.

#### A6 · `backend-modulos` — Manuales, tareas y metas
- **Misión:** §5.3, §5.4 y §5.5 en el backend.
- **Zona:** `server/src/docs/`, `server/src/tasks/`, `server/src/goals/`.
- **Entregables:** CRUD de documentos en árbol con versiones y búsqueda; tareas con responsables, comentarios,
  checklist, "mis tareas", crear desde mensaje; metas, reportes semanales, agregados para el tablero, exportación CSV.
- **Reglas:**
  - Permisos por departamento (Líder solo en los suyos).
  - Los reportes copian el objetivo vigente; el histórico es inmutable salvo por Admin con registro en auditoría.
  - Eventos de tareas/recordatorios se delegan a `backend-notificaciones`.
- **Hecho cuando:** los tres módulos pasan sus pruebas de permisos y aislamiento.
- **Modelo:** Sonnet.

#### A7 · `frontend-chat` — Chat, anuncios y PWA
- **Misión:** la experiencia tipo Slack en escritorio y, sobre todo, en iPhone.
- **Zona:** `web/src/chat/`, `web/public/` (manifest, `sw.js`, íconos), store de tiempo real.
- **Entregables:** lista de canales, vista de canal con scroll virtual, compositor (formato, @menciones con autocompletado,
  adjuntos con arrastrar/pegar, emoji), hilos en panel derecho, reacciones, edición, búsqueda, no leídos, presencia,
  "escribiendo…", anuncios con "Entendido"; PWA instalable, flujo guiado de instalación en iOS y activación de push,
  reconexión del WebSocket y reenvío de mensajes pendientes.
- **Reglas:**
  - Solo componentes de `design/`; si falta uno, lo pide a `diseñador-ui`.
  - UI optimista (el mensaje aparece al instante y se confirma después) con estado de error y reintento.
  - Textos siempre vía i18n.
  - Rendimiento: canal con 5 000 mensajes fluido en un iPhone de gama media.
- **Hecho cuando:** QA aprueba el flujo completo en escritorio y en iPhone instalado como PWA.
- **Modelo:** Opus.

#### A8 · `frontend-modulos` — Plataforma, manuales, tareas y metas
- **Misión:** todas las pantallas que no son chat.
- **Zona:** `web/src/platform/`, `web/src/docs/`, `web/src/tasks/`, `web/src/goals/`, `landing/`.
- **Entregables:** registro, login, onboarding guiado, ajustes del workspace (miembros, departamentos, líneas, facturación),
  perfil y preferencias de notificación; manuales con Tiptap y árbol; kanban/lista de tareas; carga de reportes y tablero
  de metas con gráficas; backoffice superadmin; landing con precios.
- **Reglas:** mismas de A7; gráficas con un solo sistema visual coherente con los tokens; formularios con validación clara.
- **Hecho cuando:** QA aprueba cada módulo en escritorio y móvil.
- **Modelo:** Sonnet.

#### A9 · `qa` — Calidad y pruebas
- **Misión:** romper lo que los demás construyen antes que el cliente.
- **Zona:** `server/test/`, `web/e2e/`, `docs/qa/`. **No corrige código de otros**: reporta con pasos para reproducir.
- **Entregables:** suite de **aislamiento multi-tenant** que recorre todos los endpoints; pruebas de API; pruebas E2E de
  navegador (con build + preview, no el servidor de desarrollo); checklist manual en **iPhone real** (instalación,
  push, teclado, safe areas); pruebas de carga del WebSocket (50 conexiones simultáneas por workspace).
- **Reglas:** cada bug con severidad, pasos, resultado esperado vs. real y captura; una feature no se integra con bugs críticos abiertos.
- **Modelo:** Sonnet.

#### A10 · `seguridad` — Revisión de seguridad (solo lectura)
- **Misión:** revisar cada entrega antes de integrarse.
- **Zona:** ninguna de escritura; solo emite reportes en `docs/seguridad/`.
- **Revisa:** aislamiento entre workspaces (app + RLS), autorización por rol en cada ruta, validación de entradas, subida
  de archivos, webhooks de Stripe, WebSocket (que nadie reciba eventos ajenos), secretos fuera del repo, cabeceras HTTP, datos
  sensibles en logs, requisitos HIPAA.
- **Reglas:** cada hallazgo con severidad y escenario concreto de explotación; un hallazgo crítico bloquea la integración.
- **Modelo:** Opus.

#### A11 · `devops` — Infraestructura y entregas
- **Misión:** que todo se levante con un comando y se despliegue sin sustos.
- **Zona:** `ops/`, `Dockerfile`, `docker-compose*.yml`, `.github/workflows/`, `.env.example`.
- **Entregables:** entorno local (Postgres, MinIO, MailHog) en puertos libres de la laptop; CI (typecheck, pruebas,
  build); imagen de producción; despliegue del piloto en el servidor con Cloudflare Tunnel y HTTPS; backups cifrados
  con prueba de restauración; alertas a Telegram; guía de despliegue en VPS con BAA para producción.
- **Reglas:** ningún secreto en el repo; todo cambio de infraestructura documentado; nada se apaga ni se borra en el
  servidor sin confirmación de Rodrigo.
- **Modelo:** Sonnet.

### 13.4 Matriz de dependencias

| Agente | Depende de | Desbloquea a |
|---|---|---|
| arquitecto | — | todos los de backend y frontend |
| diseñador-ui | aprobación de mockups | frontend-chat, frontend-modulos |
| devops | — | todos (entorno local) |
| backend-plataforma | arquitecto | backend-chat, backend-modulos (middleware de workspace) |
| backend-chat | arquitecto, backend-plataforma | frontend-chat, backend-notificaciones |
| backend-notificaciones | arquitecto, devops (MinIO) | frontend-chat (push y adjuntos) |
| backend-modulos | arquitecto, backend-plataforma | frontend-modulos |
| frontend-chat | contrato + diseñador-ui (con mocks) | QA |
| frontend-modulos | contrato + diseñador-ui (con mocks) | QA |
| qa, seguridad | cada entrega | integración a `main` |

---

## 14. Plan de ejecución por olas

Cada ola termina en una **compuerta**: el orquestador presenta a Rodrigo lo hecho, QA y Seguridad dan su visto bueno,
y solo con su aprobación se pasa a la siguiente.

| Ola | Agentes en paralelo | Resultado | Duración estimada |
|---|---|---|---|
| **0 · Cimientos** | arquitecto · diseñador-ui · devops | Esquema + RLS, contrato v1, mockups aprobados, entorno local, CI | 1 semana |
| **1 · Plataforma** | backend-plataforma · diseñador-ui (componentes) · frontend-modulos (registro/login/onboarding con mocks) | Registro, workspaces, invitaciones, roles, shell de la app | 1 semana |
| **2 · Chat completo** | backend-chat · backend-notificaciones · frontend-chat | §5.1 y §5.2 completos + push en iPhone + adjuntos | 2–3 semanas |
| **3 · Módulos** | backend-modulos · frontend-modulos | Manuales, tareas, metas y reportes | 2 semanas |
| **4 · SaaS y lanzamiento** | backend-plataforma (Stripe, superadmin) · frontend-modulos (facturación, landing) · devops (despliegue) | Cobro, backoffice, piloto en línea | 1 semana |
| **5 · Piloto** | qa · seguridad · todos según bugs | 2 semanas de uso real con el cliente, ajustes | 2 semanas |

**Total estimado: 9–10 semanas** hasta tener el piloto en uso y el producto listo para vender.
QA y Seguridad corren de forma continua al cierre de cada entrega, no solo al final.

**Hito temprano:** al terminar la Ola 2 (≈ semana 5) el cliente ya puede usar el chat completo en sus iPhones.

---

## 15. Definición de "hecho" y calidad

Una tarea está terminada solo si:
- [ ] Cumple el contrato y los criterios de su agente.
- [ ] `typecheck` y pruebas en verde; incluye prueba de aislamiento entre workspaces.
- [ ] Probada en escritorio **y** en móvil (las de UI).
- [ ] Textos en i18n (es/en); sin violaciones del design system.
- [ ] Revisada por QA y Seguridad sin hallazgos críticos.
- [ ] Reporte entregado al orquestador y `docs/estado.md` actualizado.

---

## 16. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Push en iOS menos fiable que en apps nativas | Alto | Probar en iPhone real desde la Ola 2; plan B con Capacitor |
| Fuga de datos entre agencias | Crítico | RLS + filtro en app + suite de aislamiento obligatoria |
| PHI de pacientes en la app | Alto (legal) | Regla "no PHI" en piloto; VPS con BAA antes de vender a Salud/Medicare |
| Alcance del chat completo desde la Fase 1 | Medio | Agentes en paralelo con contrato primero; hito de semana 5 |
| Usuarios no instalan la PWA | Medio | Onboarding guiado con capturas; recordatorio dentro de la app |
| Conflictos entre agentes en paralelo | Medio | Zonas exclusivas + worktrees + contrato como fuente de verdad |

---

## 17. Decisiones pendientes

1. **Nombre y dominio** del producto.
2. **Departamentos reales** y **metas** del cliente piloto (para la plantilla y la demo).
3. **Precios** definitivos (propuesta en §3.5).
4. **Proveedor de producción** con BAA y momento de migrar desde el servidor propio.
5. ¿Facturar con Stripe a nombre de quién (entidad en EE. UU.)?
6. ¿Invitados externos (agentes independientes) en la primera versión o después?
7. Aprobación de este plan → el orquestador genera `CLAUDE.md` y `.claude/agents/*.md` a partir de §13 y arranca la Ola 0.
