# Infraestructura

## Local

```bash
cp .env.example .env
npm install
npm run db:up      # Postgres 16, MinIO, Mailpit
npm run migrate
npm test
```

| Servicio | URL | Credenciales (solo dev) |
|---|---|---|
| Postgres | `localhost:55432` / db `agencia_hub` | dueño `agencia` / `agencia_dev` · app `agencia_app` / `agencia_app_dev` |
| MinIO consola | http://localhost:59001 | `agencia` / `agencia_dev_secret` |
| Mailpit | http://localhost:58025 | — |

`ops/postgres/init.sh` crea el rol `agencia_app` solo la **primera** vez que se inicializa el volumen.
Para empezar de cero: `docker compose -f ops/docker-compose.yml down -v` (borra los datos locales).

## CI
`.github/workflows/ci.yml`: typecheck → migraciones sobre Postgres limpio → pruebas.

## Pendiente (Ola 4)
Imagen de producción, despliegue del piloto con Cloudflare Tunnel, backups cifrados con prueba de restauración,
alertas a Telegram, guía de VPS con BAA.
