# Revisión de seguridad · Olas 0 a 4 (antes de exponer `kora.arbolaureo.org`)

**Fecha:** 2026-10-07 · **Agente:** seguridad (solo lectura) · **Alcance:** `server/`, `server/migrations/`,
`shared/contracts/`, `web/src/`, `Dockerfile`, `ops/`, `docs/despliegue.md`, ADR 0001–0005, `docs/plan-ola-4.md`.

**Método:** lectura completa del backend (todas las rutas, middleware, hub WebSocket, jobs, migraciones y políticas RLS),
de los puntos sensibles del frontend (`v-html`, enlaces, push, login) y del despliegue. Los dos hallazgos del WebSocket se
**reprodujeron** contra una API local propia (puerto 4399, aparte de la que ya corría en 4300): ambos tumban el proceso.
Para la prueba se registraron dos agencias desechables `sec-<timestamp>` (emails `sec-…@example.test`) en la BD de
desarrollo; no se borró nada.

## Resumen

| # | Severidad | Hallazgo | ¿Bloquea? |
|---|---|---|---|
| A1 | **Alto** | Cualquier usuario tumba el servidor por el WebSocket (`null` o un mensaje > 16 KB) | **Sí** |
| A2 | **Alto** | `trust proxy` no confía en `cloudflared`: todos los rate-limits pasan a ser globales | **Sí** |
| A3 | **Alto** | `/goals/dashboard.csv` sin `Cache-Control`: Cloudflare lo cachea y lo sirve sin sesión | **Sí** |
| M1 | Medio | Los WebSocket abiertos no se revocan (desactivar miembro, cerrar sesiones, fin de impersonación) | No (recomendado antes) |
| M2 | Medio | Los invitados (`guest`) ven y se unen a todos los canales públicos, buscan en ellos y ven emails de todos | No |
| M3 | Medio | Simulador de facturación activo en producción (sin `STRIPE_SECRET_KEY`): cualquier Owner se da plan Pro gratis | No |
| M4 | Medio | Superadmin (acceso a todas las agencias) sin 2FA obligatorio | No (recomendado antes) |
| M5 | Medio | Registro abierto sin verificación + 10 GB por prueba: llenar el disco del servidor | No |
| M6 | Medio | Las suscripciones push sobreviven a logout, "cerrar todas las sesiones" y reset de contraseña | No |
| B1–B12 | Bajo | Ver sección Bajo | No |
| I1–I9 | Informativo | Ver sección Informativo | No |

**Lo que está bien** (revisado y sin hallazgos): RLS `tenant` en las 25 tablas de negocio + `workspace_members`,
`workspaces`, `users` y `push_subscriptions`, con el rol `agencia_app` `NOSUPERUSER NOBYPASSRLS` y grants por columna
(no puede tocar facturación ni `storage_bytes`); FK compuestas `(workspace_id, id)` en todas las referencias cruzadas;
`workspace_id` siempre desde sesión + slug (nunca body/query); todas las rutas de negocio usan `tx()`; `adminPool` solo en
login/registro/invitaciones/webhook/jobs/superadmin; eventos WebSocket filtrados por workspace y por miembros del canal;
descargas con control por canal y CSP `sandbox`; MIME en lista blanca y `nosniff`; SQL 100 % parametrizado (lo
interpolado son constantes); `renderBody` escapa antes de agregar etiquetas (sin XSS encontrado en los 4 `v-html`);
`sanitizeDoc` filtra imágenes externas y `javascript:`; CSV con prefijo anti-fórmulas; firma del webhook de Stripe sobre
el cuerpo crudo con tolerancia de 5 min e idempotencia por `stripe_events`; tokens de invitación y reset de 192 bits
guardados como SHA-256, de un solo uso/expiración/revocación con `for update`; 2FA sin vías de bypass (registro,
invitación y reset no saltan el TOTP); impersonación limitada a 30 min, a un workspace, sin `/admin`, contraseña, 2FA,
`logout-all` ni facturación de escritura, con motivo y `audit_log`; excepciones de `read_only` (`/billing*`,
`/ws-ticket`, `/channels/:id/read`) seguras (solo tocan datos propios o la salida de pago, y el chequeo de ruta es
sensible a mayúsculas, así que una variante en mayúsculas queda **bloqueada**, no exenta); contenedor con usuario `node`,
`NODE_ENV=production`, sin puertos publicados; backups cifrados; `.env` fuera de git y de la imagen.

---

## Alto

### A1 · Cualquier usuario autenticado tumba el proceso por el WebSocket — **BLOQUEA**

**Dónde:** `server/src/realtime/hub.ts:84-91` (manejador `message`) y `hub.ts:49,77-96` (sin `ws.on('error')`).

Dos caminos, ambos **reproducidos** (el proceso sale con `TypeError`/`RangeError` no capturado y `/health` queda en
`ECONNREFUSED`):

1. `JSON.parse('null')` devuelve `null` y la línea 88 hace `msg.type` → `TypeError` síncrono dentro del listener de
   un `EventEmitter` → excepción no capturada → Node termina.
2. Un mensaje de más de `maxPayload` (16 KB) hace que `ws` emita `'error'` (`RangeError: Max payload size exceeded`) en
   el socket; sin listener de `'error'` el `EventEmitter` lo lanza → Node termina. Lo mismo con cualquier frame inválido
   (UTF-8 malo, opcode reservado).

**Explotación:** registrarse (abierto, gratis, sin verificar email) → `POST /api/v1/w/<slug>/ws-ticket` → abrir
`wss://kora.arbolaureo.org/ws?ticket=…` → enviar `null`. Cae la app de **todas** las agencias. `restart: unless-stopped`
la levanta (migraciones + arranque, varios segundos), y un bucle de 3 líneas la mantiene caída indefinidamente. Además,
`server.on('upgrade', async …)` (línea 51) no captura un fallo de `adminPool.query`: una caída momentánea de Postgres
durante un upgrade también es una promesa rechazada sin manejar (mismo final).

**Impacto:** denegación de servicio total por cualquier persona de internet.

**Corrección:**
```ts
ws.on('error', () => ws.terminate());
ws.on('message', (raw) => {
  let msg: unknown;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  // …o validar con un esquema zod de ClientEvent
});
```
y envolver el cuerpo del handler de `upgrade` en `try/catch` (responder 500 y `socket.destroy()`). Como red de
seguridad, registrar `process.on('uncaughtException')` solo para loguear/alertar no basta: la corrección es en el hub.
Agregar prueba: enviar `null`, `123`, `"x"` y 20 KB y comprobar que `/health` sigue respondiendo.

### A2 · `trust proxy: 'loopback'` detrás de `cloudflared`: todos los rate-limits son globales — **BLOQUEA**

**Dónde:** `server/src/index.ts:20`; usos de `req.ip` en `server/src/platform/auth-routes.ts:22,46,76,168,179` y en
cada `audit(...)`.

En producción `cloudflared` es **otro contenedor** (red `n8n_default`, `ops/compose.prod.yml:63-66`) que conecta a
`kora-app:4300` desde una IP de Docker (`172.x`), no desde loopback. Express no confía en esa IP, ignora
`X-Forwarded-For`/`CF-Connecting-IP` y `req.ip` es **la IP de `cloudflared` para todas las peticiones**.

**Explotación (sin cuenta):**
- `POST /auth/register` ×10 por hora → nadie más en el mundo puede registrarse esa hora (`register:<ip>` es global).
- `POST /auth/forgot-password` ×5 por hora → nadie puede recuperar su contraseña.
- `GET /invitations/x` ×30 cada 15 min → nadie puede abrir ni aceptar invitaciones.
- `POST /auth/login` con `email=victima@agencia.com` y contraseña falsa ×10 cada 15 min → la víctima recibe 429
  aunque escriba bien su contraseña (bloqueo dirigido de cuentas, p. ej. del Owner o del superadmin).
- Además el `audit_log.ip` (bitácora que pide §11/HIPAA) registra siempre la misma IP: inútil para investigar.

**Impacto:** denegación de alta, recuperación, invitaciones y login, trivial y sin autenticación; bitácora sin valor.

**Corrección:** confiar en la red de Docker y tomar la IP real que pone Cloudflare:
```ts
app.set('trust proxy', ['loopback', 'uniquelocal']);   // 172.16/12, 10/8, 192.168/16 (cloudflared)
// y, para no depender del orden de XFF, un helper:
const clientIp = (req) => (req.get('cf-connecting-ip') ?? req.ip);
```
(`CF-Connecting-IP` solo es confiable porque la app no publica puertos; los demás contenedores de `n8n_default`
podrían falsearlo, ver I8). Además, cambiar la clave del login a `login:<email>` con un límite más alto **y**
`login:<ip>` aparte, para que un atacante no pueda bloquear a una víctima concreta desde muchas IPs. Verificar tras
desplegar con un `audit_log` real.

### A3 · El CSV de metas se cachea en Cloudflare y se sirve a cualquiera sin sesión — **BLOQUEA**

**Dónde:** `server/src/goals/routes.ts:156-175` (y en general: ninguna respuesta de `/api` lleva `Cache-Control`).

Cloudflare, con su configuración por defecto, cachea por **extensión** y `.csv` está en la lista de extensiones
cacheadas. La respuesta de `/api/v1/w/<slug>/goals/dashboard.csv?weeks=…` no trae `Cache-Control` ni `Set-Cookie`, así
que el borde la guarda con el TTL por defecto, y la clave de caché **no incluye la cookie**.

**Explotación:** el Admin de "agencia-x" descarga el CSV (la URL la arma `web/src/goals/GoalsPage.vue:84` con
parámetros predecibles). Durante el TTL, cualquiera sin cuenta pide
`https://kora.arbolaureo.org/api/v1/w/agencia-x/goals/dashboard.csv?weeks=8` y recibe el CSV desde el borde
(`cf-cache-status: HIT`). El slug es casi siempre el nombre de la agencia.

**Impacto:** fuga entre agencias / a anónimos de metas y resultados semanales por departamento. Mismo riesgo para
cualquier ruta futura de la API que termine en una extensión cacheable.

**Corrección:** en `index.ts`, antes de montar `api`:
```ts
app.use('/api', (_req, res, next) => { res.set('cache-control', 'no-store'); next(); });
```
(las descargas de archivos ya ponen `private`; dejarlas así o pasarlas también a `private, no-store`). En Cloudflare,
agregar una Cache Rule "Bypass cache" para `/api/*` y `/ws`. Verificar después del despliegue que
`curl -sI …/dashboard.csv` devuelve `cf-cache-status: BYPASS` o `DYNAMIC`.

---

## Medio

### M1 · Los WebSocket abiertos no se revocan

**Dónde:** `server/src/realtime/hub.ts:19-35,77-96`; `server/src/platform/workspace-routes.ts:73-123` (desactivar);
`server/src/platform/auth-routes.ts:67-72,88-101` (`logout-all`, reset); `server/src/admin/routes.ts:113-116`.

El socket se autoriza una sola vez (ticket de 30 s) y luego vive mientras haya ping/pong (el navegador lo hace solo).
Nada lo cierra cuando: se desactiva al miembro (`is_active=false`; sigue en `channel_members`, así que
`publishToChannel` le sigue enviando), se hace "cerrar sesión en todos" o reset de contraseña (sube `token_version`), el
workspace pasa a `suspended`, o vence la impersonación de 30 min.

**Explotación:** un agente despedido deja la pestaña abierta: el Admin lo desactiva, pero sigue recibiendo en tiempo
real cada mensaje, edición, archivo (nombre + URL; la descarga sí falla) y tarea de sus canales, durante días. Igual
para un teléfono robado tras "cerrar sesión en todos", o para el superadmin más allá de los 30 min de impersonación.

**Impacto:** la revocación de acceso no es efectiva para lo nuevo que se escriba.

**Corrección:** exportar `disconnect(filter)` en el hub y llamarlo al desactivar miembro (`workspaceId+userId`), en
`logout-all`/reset (`userId`), al suspender (`workspaceId`) y guardar `exp` en `Conn` para cerrar al vencer la
impersonación (el ticket puede guardar el `imp.exp`). Opcional: revalidar membresía cada N minutos en el latido.

### M2 · Los invitados (`guest`) acceden a más de lo que define §4

**Dónde:** `server/src/chat/model.ts:35-40` (`listChannels`), `chat/model.ts:52-60` (`readableChannel` sin chequeo de
rol), `server/src/chat/routes.ts:88-96` (`join`), `chat/routes.ts:404` (búsqueda), `server/src/files/routes.ts:80-85`,
`server/src/platform/workspace-routes.ts:69-71` (`GET /members`).

§4 dice que el invitado ve "solo los canales a los que se le invita". El código permite a un `guest`: listar todos los
canales públicos, leer su historial, **unirse** a cualquiera (`POST /channels/:id/join`), buscar en todos ellos, leer
`#anuncios`, descargar sus adjuntos, y obtener nombre + **email** de todos los miembros. Además, los archivos de manuales
y tareas (`context <> 'message'`) los descarga cualquier miembro, guest incluido, si conoce el UUID.

**Explotación:** un Admin invita como `guest` a un agente externo o proveedor (el API lo permite hoy:
`CreateInvitationBody.role` solo excluye `owner`). Ese invitado lee `#general`, se une a `#ventas-medicare`, busca
"póliza" en todo el workspace y descarga la lista de emails del personal.

**Corrección:** en `readableChannel`/`listChannels`/búsqueda/descarga, para `role = 'guest'` exigir membresía del canal
(tratar `public` y `announcement` como privados); prohibir `join` a guests; en `GET /members` devolver a guests solo los
miembros con los que comparte canal y sin email; en descarga, `context <> 'message'` solo para `ROLE_RANK >= member`.
Si los invitados son "fase posterior", alternativa mínima: rechazar `role: 'guest'` en `POST /invitations` y en
`PATCH /members` hasta implementarlo.

### M3 · Simulador de facturación activo en producción

**Dónde:** `server/src/billing/stripe.ts:6`, `server/src/billing/routes.ts:65-79`; `docs/despliegue.md:48`
("Las variables de Stripe pueden quedar vacías").

Sin `STRIPE_SECRET_KEY`, `POST /w/:slug/billing/simulate {"event":"paid","plan":"pro"}` deja al workspace `active` en
plan `pro` (50 GB) con una suscripción `sim_…`; el job de ciclo de vida nunca lo vuelve a mover (no hay
`current_period_end` real que venza). Es el diseño del ADR 0005 para probar, pero en un despliegue público con registro
abierto equivale a "cualquiera se activa Pro gratis para siempre", y combinado con M5 multiplica por 5 la cuota de
disco de cada cuenta falsa.

**Corrección:** exigir una bandera explícita (`BILLING_SIMULATOR=1`) además de no tener llave, y no ponerla en
`.env.prod.example`; o limitar `/billing/simulate` a `platform_admins`. Al abrir la cuenta de Stripe el endpoint se
apaga solo (devuelve 404), lo cual está bien.

### M4 · El superadmin no está obligado a usar 2FA

**Dónde:** `server/src/admin/routes.ts:14-22,97-117`; `ops/make-admin.ts`.

El backoffice da lectura de todas las agencias e impersonación de cualquier Owner (incluye sus DMs). Solo se exige 2FA
al superadmin si la agencia tiene `require_2fa` (que además nadie puede activar desde la UI, ver B10). Con A2 sin
corregir, el login del superadmin tampoco tiene un rate-limit útil.

**Explotación:** contraseña del superadmin filtrada o reutilizada → acceso a los datos de todos los clientes.

**Corrección:** en el middleware de `/admin`, rechazar si el usuario no tiene `totp_enabled` (`403 admin_2fa_required`);
`make-admin.ts` puede avisar si la cuenta aún no tiene 2FA.

### M5 · Registro abierto sin verificación + cuota de 10 GB por prueba: llenado del disco del servidor

**Dónde:** `server/src/platform/auth-routes.ts:20-42`, `server/src/files/routes.ts:12,19-39`.

Registrar no exige verificar el email, cada registro crea un workspace con 10 GB de cuota, y el único freno es
`register:<ip>` (10/h, y global por A2). El MinIO del piloto vive en el disco del servidor casero, compartido con
AppFlowy, Odoo, n8n, Vaultwarden, Nextcloud.

**Explotación:** script que registra cuentas desde varias IPs y sube 10 GB de basura en cada una (o 50 GB con M3).
Llenar el disco tumba Postgres y el resto de servicios del servidor.

**Corrección:** cuota de prueba baja (p. ej. 1 GB) hasta el pago; verificación de email antes de subir archivos;
límite global de almacenamiento de la plataforma (rechazar subidas si el bucket supera X) y alerta de disco por Telegram;
volumen de MinIO con tamaño acotado.

### M6 · Las suscripciones push sobreviven al cierre de sesión

**Dónde:** `server/src/platform/auth-routes.ts:62-72,88-101`; `server/src/notifications/routes.ts:21-38`;
`web/src/stores/session.ts:70`.

Ni `logout`, ni `logout-all`, ni el reset de contraseña borran `push_subscriptions`. Las notificaciones incluyen los
primeros 140 caracteres del mensaje (`notifications/push.ts:67`).

**Explotación:** teléfono robado o compartido: el usuario hace "cerrar sesión en todos" y cambia la contraseña, pero el
dispositivo sigue mostrando en la pantalla bloqueada el texto de los DMs y menciones que le lleguen. Variante: durante
una impersonación el superadmin puede activar push "como el Owner" en su navegador (la ruta no llama a
`forbidImpersonation`) y seguir recibiendo las notificaciones del Owner, de **todas** sus agencias, después de los 30 min.

**Corrección:** `logout` del cliente llama antes a `DELETE /me/push-subscriptions` con el endpoint del dispositivo;
`logout-all` y reset borran todas las del usuario; `POST /me/push-subscriptions` llama a `forbidImpersonation`.

---

## Bajo

**B1 · CSRF desde subdominios hermanos y cookie sin prefijo `__Host-`.** `server/src/platform/auth.ts:63-71`.
`SameSite=lax` trata como "mismo sitio" a todo `*.arbolaureo.org` (Rocco CRM, Vitrina, n8n si se publican ahí). Un XSS
en cualquiera de ellos puede hacer `POST` con cookies a rutas sin cuerpo JSON (`/auth/logout-all`,
`/w/:slug/channels/:id/join|leave`, `/me/push-test`, `/admin/impersonation/end`) y fijar una cookie `ah_session` para
`.arbolaureo.org` (login CSRF). Las rutas con JSON quedan protegidas por el preflight. **Corrección:** renombrar la
cookie a `__Host-ah_session` (en producción) y rechazar peticiones no-GET cuyo `Origin` no sea `APP_URL`.

**B2 · Terminar la impersonación emite una sesión de superadmin de 30 días sin reautenticar.**
`server/src/admin/routes.ts:119-127`. Usa el `token_version` **actual** del superadmin, así que un token de
impersonación robado (30 min, alcance de un Owner) se convierte en sesión plena de superadmin, incluso si el superadmin
hizo "cerrar sesión en todos" después. **Corrección:** guardar el `tv` del superadmin en el claim `imp` y comprobarlo en
`/impersonation/end`, o simplemente cerrar sesión y pedir login.

**B3 · Firma de Stripe con bytes multibyte provoca 500.** `server/src/billing/stripe.ts:63`. Si `v1` tiene 64
caracteres pero no ASCII, `timingSafeEqual` recibe buffers de distinto largo y lanza `RangeError` → 500 + alerta.
**Corrección:** comparar `Buffer.from(v, 'utf8').length === expected.length` antes, o hacer `try/catch` → `null`.

**B4 · Agotar el presupuesto de alertas.** `server/src/ops/alert.ts:19-31`, `billing/routes.ts:87`. Cualquiera puede
mandar basura al webhook: cada IP/texto distinto consume una de las 10 alertas por 5 min, y una 500 real o un job
agotado quedan silenciados. Con A2 el texto es siempre igual, lo que lo mitiga parcialmente. **Corrección:** no alertar
por firma inválida (solo contar y alertar si supera un umbral), o presupuesto separado por tipo.

**B5 · Errores de stream pueden tumbar el proceso.** `server/src/files/routes.ts:101`. `Readable.fromWeb(...).pipe(res)`
no maneja `'error'` del origen: un corte de MinIO a mitad de una descarga es una excepción no capturada. No es
provocable por el cliente de forma directa. **Corrección:** `await pipeline(Readable.fromWeb(s3.body), res)` de
`node:stream/promises`.

**B6 · SSRF ciego por el endpoint de push.** `server/src/notifications/routes.ts:12,21-38`. Cualquier usuario puede
registrar `https://<host-interno>/…` como endpoint; el servidor le hace `POST` (con `/me/push-test`, 5/min). El
servidor comparte LAN con AppFlowy, Odoo, n8n, Vaultwarden, Nextcloud. Ciego y solo `POST` HTTPS con cuerpo cifrado:
impacto bajo. **Corrección:** lista blanca de hosts de push (`fcm.googleapis.com`, `*.push.apple.com`,
`updates.push.services.mozilla.com`, `*.notify.windows.com`).

**B7 · TOTP reutilizable dentro de su ventana.** `server/src/platform/auth.ts:128-132`. Un código capturado (phishing en
tiempo real) sirve ~90 s más. **Corrección:** guardar el último `step` usado por usuario y rechazar `step <=` ese.

**B8 · Tokens de reset anteriores siguen vivos tras un reset.** `server/src/platform/auth-routes.ts:88-101`. Si se
pidieron varios enlaces, usar uno no invalida los demás (1 h). **Corrección:** `update password_resets set used_at = now()
where user_id = $1 and used_at is null` dentro de la misma transacción. Relacionado: los enlaces de reset e invitación
quedan en claro en `jobs.payload` (`auth-routes.ts:83`, `workspace-routes.ts:281`) para siempre; borrar el payload
(o los jobs `email.send`) al completarse.

**B9 · Sin cabeceras CSP / Permissions-Policy / HSTS en la SPA.** `server/src/index.ts:22-25`. Hay `nosniff`,
`X-Frame-Options` y `Referrer-Policy`, pero no CSP para la SPA, que tiene 4 `v-html`. Hoy `renderBody` es seguro; una CSP
`default-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss:; object-src 'none'; base-uri 'none';
frame-ancestors 'none'` es la segunda barrera. HSTS se puede activar en Cloudflare.

**B10 · `require_2fa` del workspace no se aplica.** `server/src/platform/workspace-routes.ts:38`, solo se lee en
`admin/routes.ts:110`. El API lo acepta y lo guarda, pero ningún login ni `workspaceContext` lo exige (y la UI no lo
muestra). §11 lo promete. **Corrección:** en `workspaceContext`, si `settings.require_2fa` y el usuario no tiene
`totp_enabled`, responder `403 totp_required` (permitiendo las rutas de configurar 2FA), o quitar el campo del contrato
hasta implementarlo.

**B11 · Se acepta el `JWT_SECRET` de ejemplo.** `.env.example:23` tiene un valor de 42 caracteres que pasa el chequeo
de `auth.ts:33-37`. Si alguien copia la plantilla de desarrollo a producción, cualquiera puede firmar sesiones (incluida
la del superadmin). La plantilla de producción lo deja vacío (bien). **Corrección:** rechazar al arrancar ese valor
conocido y exigir `JWT_SECRET` en `main.ts` (hoy falla petición a petición).

**B12 · Crecimiento de memoria sin límite en el rate-limit.** `server/src/platform/auth.ts:136-143` y
`ops/alert.ts:22`. Las claves (incluyen email) nunca se borran del `Map`; con millones de emails distintos se puede
acercar al `mem_limit: 768m`. **Corrección:** purgar claves vacías en cada llamada o con un `setInterval`.

---

## Informativo

- **I1 · Sin verificación de email ni anti-enumeración en registro.** `register` responde `email_taken` y
  `GET /invitations/:token` devuelve `hasAccount`. Aceptable para el piloto; la verificación resuelve también parte de M5.
- **I2 · `logout` no invalida el JWT** (sesión sin estado de 30 días, sin expiración por inactividad). Para HIPAA
  conviene una vida más corta o expiración por inactividad.
- **I3 · RLS no protege los roles.** `agencia_app` puede `update` cualquier columna de `workspace_members` del tenant
  (incluido `role`); la barrera es solo la app (`PATCH /me` solo toca título/estado). Defensa en profundidad posible:
  `grant update (title, status_text, status_until, notif_prefs, …)` y mover cambios de rol a una función.
- **I4 · `adminPool` usa el superusuario de Postgres** (`agencia`, `compose.prod.yml:16`) y la app usa las credenciales
  **root** de MinIO. No se encontró inyección SQL, pero un fallo futuro daría `COPY … TO PROGRAM` (RCE en el contenedor
  de Postgres). Recomendable un rol dueño del esquema no superusuario y un usuario de MinIO limitado al bucket.
- **I5 · HIPAA / PHI:** el superadmin que impersona lee los DMs del Owner (está en el ADR y queda auditado, pero debe
  figurar en Términos/BAA); las alertas de Telegram incluyen `err.message` y la ruta (pueden contener slugs o fragmentos
  de datos); las notificaciones push muestran 140 caracteres en la pantalla bloqueada. Mantener la regla "no PHI" del
  piloto.
- **I6 · Backups:** cifrados (bien) pero con AES-256-CBC sin autenticación (no detecta manipulación) y en el mismo
  servidor. Recomendado copia fuera del servidor y `age`/`gpg` o un MAC. `backup.sh:70` pasa las llaves de MinIO por
  `-e` (visibles en `docker inspect` mientras corre el contenedor efímero).
- **I7 · Imágenes sin fijar:** `minio/minio:latest` (`compose.prod.yml:45`). Fijar versión.
- **I8 · Red compartida:** `kora-app` está en `n8n_default`, así que n8n y cualquier contenedor de esa red alcanzan
  `kora-app:4300` sin pasar por Cloudflare (y podrían falsear `CF-Connecting-IP`, ver A2). Aceptable si esa red es de
  confianza; ideal una red dedicada solo con `cloudflared`.
- **I9 · Metadatos de archivos ajenos:** `PATCH /documents/:id` (`docs/routes.ts:135-141`) acepta cualquier `fileId`
  del workspace (también adjuntos de DMs); el nombre y el tamaño aparecen en el manual, aunque la descarga sigue
  protegida. Requiere conocer el UUID. Recomendable exigir `context = 'document'` y `uploader_id = app_user()`.

---

## Qué bloquea y qué no

**Bloquean la exposición a internet** (las tres son correcciones de pocas líneas):
1. **A1** — manejar `'error'` y validar el JSON en el WebSocket (hoy cualquiera que se registre tumba la app).
2. **A2** — `trust proxy` para la red de Docker / `CF-Connecting-IP` (hoy los rate-limits son globales y dejan a todos
   sin registro, recuperación, invitaciones o login).
3. **A3** — `Cache-Control: no-store` en `/api` + regla de Cloudflare de no cachear `/api/*` (hoy el CSV de metas
   queda público en el borde).

**Recomendado antes de abrir, sin bloquear:** M1 (cerrar sockets al revocar), M4 (2FA obligatorio para el superadmin)
y M3 (apagar el simulador con una bandera), por ser baratos y de alto valor.

**No bloquean, pero sí antes de vender a agencias de salud o activar invitados:** M2, M5, M6 y los Bajo, en especial B1
(cookie `__Host-` + chequeo de `Origin`), B9 (CSP) y B10 (`require_2fa`).

No se encontró ningún cruce de datos entre agencias por la base de datos, por las rutas ni por el WebSocket: la doble
barrera app + RLS + FK compuestas está bien aplicada en todo el código revisado. La única fuga entre tenants (A3) viene
de la caché de Cloudflare, no del aislamiento.
