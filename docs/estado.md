# Estado del proyecto

_Lo mantiene el orquestador. Última actualización: 2026-10-07._

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

## Pendientes registrados
- **Avatar y logo:** el módulo de archivos ya existe; falta conectar `avatarFileId`/`logoFileId` en perfil y agencia.
- **Onboarding:** el paso del iPhone muestra la URL; sin QR (evita una dependencia).
- **Sin miniaturas en el servidor** (sin `sharp`): las imágenes se sirven completas y el navegador las escala (ADR 0004).
- **Vistas previas de enlaces** (`meta.linkPreviews`) no implementadas: requieren que el servidor visite URLs externas (riesgo SSRF); evaluar en Ola 5.
- **"Crear tarea" desde un mensaje** muestra aviso; se conecta en la Ola 3 con el módulo de Tareas.
- **Recordar a los pendientes** de un anuncio: no implementado (el panel muestra quién falta).
- **Tiempo real en una sola instancia** (bus en memoria, ADR 0004); NOTIFY al escalar.
- **Scroll virtual:** se usa `content-visibility: auto` + paginación de 50; medir con 5 000 mensajes en un iPhone de gama media antes del piloto.
- **Riel:** sin botón "+" para crear otro workspace con la misma cuenta (no hay endpoint todavía; Ola 4 con facturación).
- **Rate-limit en memoria** por instancia; pasar a Postgres cuando haya más de una instancia.
- Las migraciones son solo hacia adelante; purga de `ws_tickets` y `password_resets` vencidos → job en Ola 2.
- Revisión formal de Seguridad (agente `seguridad`) de las Olas 0–1 antes de integrar la Ola 2.

## Siguiente: Ola 3 · Módulos
backend-modulos + frontend-modulos: manuales (Tiptap, árbol, versiones), tareas (kanban, "crear desde mensaje"), metas y reportes semanales.
