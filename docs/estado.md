# Estado del proyecto

_Lo mantiene el orquestador. Última actualización: 2026-10-07._

## Ola 0 · Cimientos — cerrada
Esquema + RLS, contrato v1, entorno local, CI, tokens y mockups (https://claude.ai/artifact/AizW92hqjj4rwfJgVkSZvX).
Rodrigo dio luz verde para arrancar ("Empieza"); se trabaja con los supuestos de ADR 0003.

## Ola 1 · Plataforma — en compuerta (esperando revisión de Rodrigo)

| Entregable | Agente | Estado |
|---|---|---|
| Registro con plantilla "Agencia de seguros" (4 departamentos, 3 líneas, #general, #anuncios) | backend-plataforma | Hecho |
| Login, logout, cerrar sesión en todos, recuperar contraseña, 2FA TOTP | backend-plataforma | Hecho |
| Middleware `/w/:slug` (membresía + RLS + solo lectura/suspendido) y roles | backend-plataforma | Hecho |
| Miembros, cambio de rol (con protección del último Owner), departamentos/líderes, líneas | backend-plataforma | Hecho |
| Invitaciones por enlace o email (token hasheado, expiración, usos, revocar) | backend-plataforma | Hecho |
| `audit_log` en login, roles, invitaciones, altas | backend-plataforma | Hecho |
| Prueba HTTP del flujo completo + permisos + aislamiento (`server/test/platform.test.ts`, 11 casos) | qa | Hecho, en verde (21/21 en total) |
| 15 componentes del design system + página `/_design` | disenador-ui | Hecho |
| Shell (riel, sidebar, contenido, barra inferior móvil, safe areas) | disenador-ui | Hecho |
| Registro, login, olvido/reset, aceptar invitación, onboarding (4 pasos), ajustes, perfil + 2FA | frontend-modulos | Hecho |
| i18n es/en | frontend-modulos | Hecho |
| Prueba manual en navegador: registro → onboarding → invitar → aceptar → login → cambio de rol | orquestador | Hecho (escritorio y 375 px) |

## Pendientes registrados
- **Emails:** se encolan en `jobs` (`email.send`) pero no se envían hasta el worker de la Ola 2. Mientras tanto, la invitación por enlace funciona y el enlace de reset se ve con `select payload from jobs`.
- **Avatar y logo:** `avatarFileId`/`logoFileId` se ignoran hasta que exista el módulo de archivos (Ola 2).
- **Presencia:** `Member.presence` siempre `away` hasta el WebSocket (Ola 2).
- **Onboarding:** falta el paso "Activar notificaciones" (Ola 2, con push). El paso del iPhone muestra la URL; sin QR (evita una dependencia).
- **Búsqueda Ctrl K y Anuncios** en el sidebar muestran "Próximamente".
- **Riel:** sin botón "+" para crear otro workspace con la misma cuenta (no hay endpoint todavía; Ola 4 con facturación).
- **Rate-limit en memoria** por instancia; pasar a Postgres cuando haya más de una instancia.
- Las migraciones son solo hacia adelante; purga de `ws_tickets` y `password_resets` vencidos → job en Ola 2.
- Revisión formal de Seguridad (agente `seguridad`) de las Olas 0–1 antes de integrar la Ola 2.

## Siguiente: Ola 2 · Chat completo
backend-chat (canales, DMs, hilos, menciones, reacciones, fijados, no leídos, anuncios, búsqueda, WebSocket)
· backend-notificaciones (push VAPID, archivos MinIO, cola de jobs, emails) · frontend-chat (UI tipo Slack + PWA).
