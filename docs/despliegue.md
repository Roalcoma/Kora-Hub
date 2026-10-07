# Guía de despliegue

Piloto en el servidor de Rodrigo (`192.168.0.123`, Docker) detrás de un Cloudflare Tunnel remoto ya existente.
Nada de esto se ejecuta solo: cada paso lo confirma Rodrigo. No se toca ningún contenedor que ya corra.

Piezas del repo: [`Dockerfile`](../Dockerfile) · [`ops/compose.prod.yml`](../ops/compose.prod.yml) ·
[`ops/.env.prod.example`](../ops/.env.prod.example) · [`ops/backup.sh`](../ops/backup.sh) ·
[`ops/restore-test.sh`](../ops/restore-test.sh).

## Arquitectura

```
Internet → Cloudflare → túnel (contenedor cloudflared, red del túnel)
                           └─ http://kora-app:4300 ─► kora-app ─► kora-postgres
                                                             └──► kora-minio   (red interna "kora_internal")
```

- Ningún contenedor publica puertos al host. `kora-app` está en dos redes: `kora_internal` (BD y MinIO) y la **red del
  túnel**, para que `cloudflared` lo alcance por nombre.
- `kora-app` sirve la API (`/api/v1`), el WebSocket (`/ws`), la SPA (`app.<dominio>`) y la landing estática
  (`<dominio>`, distinguida por `LANDING_HOST`). Un solo puerto interno: `4300`.
- Al arrancar, el contenedor corre `node src/migrate.ts` y después el servidor. Healthcheck: `/api/v1/health`.

## 1. Carpeta y secretos

En el servidor:

```bash
mkdir -p ~/infra/kora/postgres ~/infra/kora/backups
cd ~/infra/kora
# Desde la laptop, con el repo clonado (o con git clone en el servidor):
#   scp ops/compose.prod.yml ops/.env.prod.example ops/backup.sh ops/restore-test.sh  usuario@192.168.0.123:infra/kora/
#   scp ops/postgres/init.sh usuario@192.168.0.123:infra/kora/postgres/
cp .env.prod.example .env && chmod 600 .env
```

Genera cada secreto y pégalo en `.env` (y guárdalos en Vaultwarden):

```bash
openssl rand -hex 32                              # JWT_SECRET
openssl rand -hex 32                              # BACKUP_PASSPHRASE (¡guárdala aparte: sin ella los backups no se abren!)
openssl rand -base64 24 | tr -d '/+='             # PG_PASSWORD, APP_DB_PASSWORD, S3_SECRET_KEY (una distinta cada una)
npx web-push generate-vapid-keys                  # VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Rellena también `APP_URL=https://app.<dominio>`, `LANDING_HOST=<dominio>`, `MAIL_FROM`, `BACKUP_DIR` (ruta absoluta) y,
si ya los tienes, `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (el bot de las alertas de Rocco sirve; chat aparte si prefieres).
Las variables de Stripe pueden quedar vacías: la facturación queda **simulada** (ADR 0005).

> Las contraseñas de Postgres solo se aplican al **crear** el volumen. Si las cambias después hay que cambiarlas
> también con `ALTER ROLE` dentro de la base.

## 2. Construir y levantar

La imagen se construye en el propio servidor (no se publica en ningún registro):

```bash
cd ~/infra/kora
git clone <repo> src   # o `git -C src pull` en actualizaciones
docker build -t kora:$(git -C src rev-parse --short HEAD) -t kora:local src
docker compose -f compose.prod.yml --env-file .env up -d
docker compose -f compose.prod.yml ps          # app queda "healthy" tras ~40 s
docker logs kora-app | tail
```

> **Aviso sobre MinIO:** MinIO dejó de publicar imágenes en Docker Hub (la última conocida es
> `RELEASE.2025-09-07T16-13-09Z`) y `minio/mc` tampoco se descarga. Si `docker compose up` no puede bajar la imagen, usa
> `MINIO_IMAGE=` con una ya presente o un espejo, o valora cambiar de almacenamiento S3 (p. ej. Garage). `backup.sh`
> usa `mc` y, si no está disponible, copia el volumen `kora_minio` con tar (probado).

## 3. Conectar a la red del túnel

`compose.prod.yml` une `kora-app` a una red **externa** cuyo nombre sale de `TUNNEL_NETWORK` (por defecto `n8n_default`,
la red donde ya vive el `cloudflared` del servidor, igual que n8n). Comprueba el nombre real:

```bash
docker inspect <contenedor-cloudflared> --format '{{json .NetworkSettings.Networks}}' | head -c 300
```

Si es otro, pon `TUNNEL_NETWORK=<nombre>` en `.env` y repite `up -d`. Verifica desde el túnel:

```bash
docker exec <contenedor-cloudflared> wget -qO- http://kora-app:4300/api/v1/health
```

## 4. Hostnames en Cloudflare

El túnel se configura de forma remota, en el panel (Zero Trust → Networks → Tunnels → tu túnel → Public hostname):

| Hostname | Servicio |
|---|---|
| `app.<dominio>` | `http://kora-app:4300` |
| `<dominio>` | `http://kora-app:4300` (la landing; la API la distingue por `LANDING_HOST`) |

El DNS lo crea el panel solo (CNAME al túnel). `NODE_ENV=production` activa las cookies `secure`; solo funciona
detrás de HTTPS (Cloudflare lo da).

## 5. SMTP de producción (invitaciones y recuperación de contraseña)

Opción por defecto: **Brevo** (plan gratuito, 300 correos/día).

1. Crear cuenta, verificar el dominio (registros SPF y DKIM en Cloudflare DNS) y generar una clave SMTP.
2. En `.env`: `SMTP_URL=smtp://LOGIN:CLAVE@smtp-relay.brevo.com:587` (codifica en URL los caracteres especiales de la clave)
   y `MAIL_FROM="Kora <no-reply@<dominio>>"` con un remitente verificado.
3. `docker compose -f compose.prod.yml --env-file .env up -d` para recrear la app y probar con "Olvidé mi contraseña".

## 6. Crear el superadmin

Primero registra tu usuario normalmente desde `https://app.<dominio>`; luego:

```bash
docker exec kora-app node /app/ops/make-admin.ts tu@email.com
```

(El contenedor ya trae las variables de entorno, así que no hace falta `--env-file`; en local es
`node --env-file=.env ops/make-admin.ts email`.) Entra en `/admin`.

## 7. Backups con cron

`backup.sh` hace `pg_dump` comprimido y copia el bucket de MinIO con un contenedor efímero `minio/mc`, ambos cifrados con
`openssl enc -aes-256-cbc -pbkdf2` (clave `BACKUP_PASSPHRASE`), conserva 14 días y avisa a Telegram. Lee `.env` que esté
junto al script.

```bash
cd ~/infra/kora && ./backup.sh && ls -lh backups/        # prueba manual
./restore-test.sh                                         # restaura en un Postgres efímero y cuenta filas
crontab -e
```

```cron
# Kora: backup diario a las 03:15 y prueba de restauración el día 1 de cada mes a las 04:00
15 3 * * *  cd $HOME/infra/kora && ./backup.sh >> backups/backup.log 2>&1
0 4 1 * *   cd $HOME/infra/kora && ./restore-test.sh >> backups/backup.log 2>&1
```

Para abrir un backup a mano:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in backups/db-AAAAMMDD-HHMMSS.sql.gz.enc | gunzip | less
```

Los backups viven en el mismo disco del servidor: copia `backups/` a otro sitio (Nextcloud, disco externo) para que
sean un respaldo real. La passphrase debe estar en Vaultwarden.

## 8. Actualizar

```bash
cd ~/infra/kora && ./backup.sh                # siempre antes de actualizar
git -C src pull
docker build -t kora:$(git -C src rev-parse --short HEAD) -t kora:local src
docker compose -f compose.prod.yml --env-file .env up -d     # recrea app; migra al arrancar
docker compose -f compose.prod.yml ps && docker logs --tail 30 kora-app
```

## 9. Revertir

Las migraciones son solo hacia adelante. Si una versión falla:

1. **Solo código (la migración no rompió nada):** `KORA_IMAGE=kora:<hash-anterior>` en `.env` y `up -d`.
   El esquema nuevo suele ser compatible hacia atrás (migraciones aditivas).
2. **Migración defectuosa:** parar la app, restaurar el backup previo (`kora-postgres` con el volcado descifrado, ver
   abajo) y volver a la imagen anterior. Se pierde lo escrito desde el backup.

```bash
docker compose -f compose.prod.yml stop app
docker exec kora-postgres psql -U agencia -d postgres -c "DROP DATABASE agencia_hub" -c "CREATE DATABASE agencia_hub OWNER agencia"
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in backups/db-XXXX.sql.gz.enc | gunzip \
  | docker exec -i kora-postgres psql -U agencia -d agencia_hub
# GRANTs: el volcado los incluye; si faltan, reinicia la app (las migraciones son idempotentes por schema_migrations).
```

## 10. Migración futura a un VPS con BAA (PLAN §11)

El piloto vive en un servidor propio con la regla "no PHI" en los Términos. Antes de aceptar agencias de Salud o
Medicare que compartan datos de pacientes (PHI), hay que mudar a infraestructura con **BAA** firmado:

- **Proveedor** que firme BAA (AWS, DigitalOcean con BAA, etc.) y BAA propio de Kora con cada cliente.
- **Cifrado en reposo**: discos/volúmenes cifrados (LUKS o volúmenes cifrados del proveedor) para Postgres, MinIO y los
  backups; cifrado en tránsito con TLS (el túnel o un proxy con certificado).
- **Bitácora de accesos**: `audit_log` ya cubre logins, roles, borrados, exportaciones e impersonación; añadir logs de
  acceso del servidor y conservarlos según la política.
- **Retención configurable** por cliente y borrado verificable al dar de baja.
- **Backups** cifrados con copia fuera del servidor, prueba de restauración mensual (ya existe) y la passphrase en un
  gestor de secretos.
- **Acceso mínimo**: SSH solo con llave, sin puertos publicados salvo el proxy, actualizaciones de seguridad y
  alertas (Telegram) activas.
- **Migración**: la imagen y `compose.prod.yml` son portables. Pasos: levantar el VPS, restaurar el último backup
  (sección 9), cambiar DNS/túnel, verificar, y apagar el piloto solo con confirmación de Rodrigo.
- Revisión de `seguridad` y asesoría legal (BAA, Términos y Política de privacidad) antes de abrir a rubro salud.
