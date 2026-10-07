# Estado del proyecto

_Lo mantiene el orquestador. Última actualización: 2026-10-07 (Ola 4)._

**Regla de diseño vigente:** profundidad con sombras y composición asimétrica en toda pantalla (CLAUDE.md, regla 6).

## Ola 0 · Cimientos — cerrada
Esquema + RLS, contrato v1, entorno local, CI, tokens y mockups (https://claude.ai/artifact/AizW92hqjj4rwfJgVkSZvX).
Rodrigo dio luz verde para arrancar ("Empieza"); se trabaja con los supuestos de ADR 0003.

## Ola 1 · Plataforma — cerrada (2026-10-07)
Registro, login con 2FA, invitaciones, roles, departamentos/líneas, design system, shell y onboarding.

## Ola 2 · Chat completo — en compuerta (falta prueba en iPhone real)

| Entregable | Agente | Estado |
|---|---|---|
| Canales públicos/privados, DMs 1:1 y grupales (hasta 8), explorar/unirse/salir | backend-chat | Hecho |
| Mensajes con formato, hilos ("enviar también al canal"), menciones @persona/@canal/@aquí | backend-chat | Hecho |
| Edición/borrado (admin borra cualquiera, con auditoría), reacciones, fijados, destacados, silenciar | backend-chat | Hecho |
| No leídos y menciones por canal, línea "Nuevos mensajes", sincronización entre dispositivos | backend-chat | Hecho |
| Anuncios: solo Owner/Admin/Líder, "Entendido" con panel de confirmaciones, fijados con fecha | backend-chat | Hecho |
| Búsqueda sin acentos con filtros (canal, persona, fechas, con archivos) y resaltado | backend-chat | Hecho |
| WebSocket con ticket de un solo uso, presencia, "escribiendo…", reconexión y reenvío | backend-chat · frontend-chat | Hecho |
| Archivos: subida/descarga por la API (SigV4 propio), cuota por trigger, imágenes y documentos | backend-notificaciones | Hecho |
| Motor de reglas de push §6 (visible, silencio, no molestar, hilos, @aquí) + VAPID + limpieza 404/410 | backend-notificaciones | Hecho, probado con unit tests |
| Cola de trabajos (SKIP LOCKED, reintentos), emails por SMTP, limpieza horaria de tokens | backend-notificaciones | Hecho |
| UI tipo Slack: sidebar, canal, hilo, compositor, panel de fijados/miembros/confirmaciones, Ctrl+K, búsqueda, Mensajes y Menciones (móvil) | frontend-chat | Hecho |
| PWA: manifest, íconos, service worker (push, insignia, caché del shell), flujo de activación de notificaciones | frontend-chat | Hecho, **sin probar en iPhone** |
| Pruebas: 39 en verde (chat por HTTP+WS con aislamiento, reglas de push, plataforma, RLS) + check del formato | qa | Hecho |
| Prueba manual en navegador: mención, hilo, reacción, DM, imagen pegada, anuncio con "Entendido" en tiempo real; vista iPhone 390 px | orquestador | Hecho |

### Compuerta de la Ola 2 — falta
- [ ] **Push en iPhone real** con la PWA instalada. Requiere HTTPS: publicar el piloto con Cloudflare Tunnel (o `cloudflared tunnel --url http://localhost:5180` temporal).
  El navegador integrado de la app de Claude no registra service workers; en Chrome de escritorio sí.
- [ ] Rodrigo revisa el chat en escritorio y en su teléfono.
- [ ] Revisión del agente `seguridad` (Olas 0–2).

## Ola 3 · Módulos — en compuerta (falta revisión de Rodrigo)

| Entregable | Agente | Estado |
|---|---|---|
| Manuales: árbol por departamento, editor Tiptap (títulos, listas, tablas, imágenes, enlaces), adjuntos PDF/Office | backend-modulos · frontend-modulos | Hecho |
| Manuales: versiones (se juntan ediciones de 10 min de la misma persona), vista previa y restaurar; archivar con subpáginas | backend-modulos · frontend-modulos | Hecho |
| Manuales: búsqueda sin acentos con fragmento marcado; contenido limpiado en el servidor (sin imágenes externas ni `javascript:`) | backend-modulos | Hecho |
| Manuales: enlace copiado y pegado en el chat se ve como tarjeta | frontend-modulos | Hecho |
| Tareas: kanban (arrastrar entre columnas), lista, Mis tareas, filtros por depto/línea/texto, detalle en panel | frontend-modulos | Hecho |
| Tareas: responsables, prioridad, fecha límite (vencidas en rojo), checklist, comentarios, tiempo real por WebSocket | backend-modulos · frontend-modulos | Hecho |
| Tareas: "Crear tarea" desde el menú de un mensaje (queda enlazada al mensaje) | frontend-chat · frontend-modulos | Hecho |
| Avisos: tarea asignada, comentario y 24 h antes del vencimiento (push + aviso en la app) | backend-notificaciones | Hecho |
| Metas: definición (Admin), reporte semanal (Líder; semana actual y anterior), objetivo copiado al reporte | backend-modulos · frontend-modulos | Hecho |
| Metas: semanas cerradas solo Admin con auditoría; recordatorio push los viernes 15:00 (NY) a quien no reportó | backend-modulos · backend-notificaciones | Hecho |
| Tablero: semáforo con ícono y texto, tendencia por semana con tooltip, vista tabla, CSV (a prueba de fórmulas) y PDF por impresión | frontend-modulos | Hecho |
| Pruebas: 11 nuevas (permisos Admin/Líder/Miembro, histórico, CSV, aislamiento entre agencias); total 50 en verde | qa | Hecho |
| Prueba manual en navegador: escritorio y teléfono (390 px) de los tres módulos | orquestador | Hecho |

Nueva dependencia aprobada por el plan: Tiptap (`@tiptap/vue-3`, `starter-kit`, `extension-image`, `extension-table`, `pm`).

### Compuerta de la Ola 3 — falta
- [ ] Rodrigo revisa manuales, tareas y metas.
- [ ] Revisión del agente `seguridad` (Olas 0–3).

## Pendientes registrados
- **Avatar y logo:** el módulo de archivos ya existe; falta conectar `avatarFileId`/`logoFileId` en perfil y agencia.
- **Onboarding:** el paso del iPhone muestra la URL; sin QR (evita una dependencia).
- **Sin miniaturas en el servidor** (sin `sharp`): las imágenes se sirven completas y el navegador las escala (ADR 0004).
- **Vistas previas de enlaces** (`meta.linkPreviews`) no implementadas: requieren que el servidor visite URLs externas (riesgo SSRF); evaluar en Ola 5.
- **Resumen del lunes en #anuncios** (`settings.weeklySummary`) no implementado; el recordatorio del viernes sí.
- **Ctrl+K** todavía no busca manuales ni tareas (`GET /search-all` sin implementar); cada módulo tiene su buscador.
- **Semana de metas y recordatorio en horario de Nueva York** para todas las agencias; zona por workspace si llegan clientes de otra costa.
- **Tareas cerradas**: se cargan las de los últimos 30 días (sin paginación); el kanban no se arrastra en pantallas táctiles (el estado se cambia en el detalle).
- **Archivos de manuales** (`context = document`) los puede descargar cualquier miembro, incluidos invitados si conocen el id; cerrar al implementar invitados.
- Texto del recordatorio de reportes solo en español.
- Prueba intermitente vista una vez (1 de 6 corridas) con el servidor de desarrollo encendido: su worker consume la misma cola de jobs que las pruebas. Correr las pruebas con la API de desarrollo apagada o con una BD aparte.
- **Recordar a los pendientes** de un anuncio: no implementado (el panel muestra quién falta).
- **Tiempo real en una sola instancia** (bus en memoria, ADR 0004); NOTIFY al escalar.
- **Scroll virtual:** se usa `content-visibility: auto` + paginación de 50; medir con 5 000 mensajes en un iPhone de gama media antes del piloto.
- **Riel:** sin botón "+" para crear otro workspace con la misma cuenta (no hay endpoint todavía; Ola 4 con facturación).
- **Rate-limit en memoria** por instancia; pasar a Postgres cuando haya más de una instancia.
- Las migraciones son solo hacia adelante; purga de `ws_tickets` y `password_resets` vencidos → job en Ola 2.
- Revisión formal de Seguridad (agente `seguridad`) de las Olas 0–1 antes de integrar la Ola 2.

## Ola 4 · SaaS y despliegue — en curso (plan: [plan-ola-4.md](plan-ola-4.md))

Decisiones del 2026-10-07: generalizar a cualquier rubro; Stripe **simulado** (sin cuenta); piloto en el servidor
192.168.0.123 con Cloudflare Tunnel en **`kora.arbolaureo.org`**; **sin landing** (cuando la haya será la de Árbol Áureo
con sus tres productos).

| Entregable | Agente | Estado |
|---|---|---|
| Contrato v2, migración 0006 y ADR 0005 | arquitecto | Hecho |
| Plantillas por rubro (Seguros, Marketing, Inmobiliaria, Viajes, En blanco), categoría con nombre libre, paleta fija de colores | backend-plataforma · frontend | Hecho |
| Facturación: estado, checkout/portal (Stripe por REST sin SDK), simulador, webhook firmado e idempotente, ciclo prueba → gracia → solo lectura → suspendida, avisos por email, puestos | backend-plataforma | Hecho (Stripe real sin probar: no hay cuenta) |
| Ajustes → Facturación, banda de estado del plan, avisos amables de solo lectura, pantalla de suspendida | frontend | Hecho |
| Backoffice `/admin`: métricas, agencias, suspender/reactivar, impersonar con motivo (30 min, auditado) y banda roja | backend-plataforma · frontend | Hecho |
| `/health`, servido de la SPA en producción, alertas a Telegram | backend-plataforma | Hecho |
| Dockerfile (imagen *healthy*), `ops/compose.prod.yml`, backups cifrados con prueba de restauración, `docs/despliegue.md`, CI construye la imagen | devops | Hecho |
| Pruebas: 76 en verde (facturación, superadmin, impersonación, plantillas, aislamiento) | qa | Hecho |
| Revisión de seguridad Olas 0–4 (`docs/seguridad/`) | seguridad | En curso |
| Despliegue en el servidor y push en iPhone real | devops + Rodrigo | Pendiente (faltan SMTP, Telegram y precios) |

### Pendientes de la Ola 4
- **MinIO** ya no publica imágenes en Docker Hub: fijar una imagen disponible o cambiar a otro S3 (p. ej. Garage) antes de desplegar.
- Stripe real: probar checkout, portal y `sync_seats` en modo test cuando exista la cuenta.
- Los planes todavía no limitan funciones (Pro = Estándar salvo el texto); la tarjeta de Pro promete "retención de datos configurable", que no existe.
- Al expirar una impersonación el superadmin queda sin sesión (su cookie se reemplazó) y debe volver a entrar.
- La banda de pago fallido no muestra la fecha de fin de la gracia (`GET /w/:slug` no trae `graceEndsAt`).
- `/admin` filtra en el cliente; usar `?q=&status=` cuando haya muchas agencias.
- Las pruebas comparten la BD de desarrollo: una corrida fallida deja agencias `fact-*`/`test-*` sueltas. Conviene una BD de pruebas aparte.
- Fuera de la ola: exportación de datos y baja con borrado (Ola 5), segunda agencia desde el riel, landing.
