#!/usr/bin/env bash
# Prueba de restauración: descifra el último backup de BD, lo restaura en un Postgres efímero, cuenta filas de
# tablas clave y destruye todo. Avisa a Telegram del resultado. No toca la base de producción.
# Uso: ops/restore-test.sh      Variables opcionales: ENV_FILE, BACKUP_DIR, BACKUP_FILE
set -Eeuo pipefail

ENV_FILE="${ENV_FILE:-$(dirname "$(readlink -f "$0")")/.env}"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
: "${BACKUP_PASSPHRASE:?Falta BACKUP_PASSPHRASE}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/infra/kora/backups}"
BACKUP_FILE="${BACKUP_FILE:-$(ls -1t "$BACKUP_DIR"/db-*.sql.gz.enc 2>/dev/null | head -1)}"
[ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ] || { echo "No hay backups en $BACKUP_DIR" >&2; exit 1; }
CT="kora-restore-test-$$"
TABLES="${TABLES:-users workspaces workspace_members messages}"

notify() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  curl -fsS -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" >/dev/null || true
}
trap 'rc=$?; docker rm -f "$CT" >/dev/null 2>&1 || true; [ $rc -ne 0 ] && notify "Kora: FALLÓ la prueba de restauración de $(basename "$BACKUP_FILE")"; exit $rc' EXIT

docker run -d --name "$CT" -e POSTGRES_PASSWORD=restore -e POSTGRES_DB=restore postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$CT" pg_isready -U postgres -d restore >/dev/null 2>&1 && break; sleep 1; done
sleep 2  # el entrypoint reinicia Postgres tras el init; esperar a que quede estable
for _ in $(seq 1 30); do docker exec "$CT" pg_isready -U postgres -d restore >/dev/null 2>&1 && break; sleep 1; done

# El volcado usa --no-owner pero las políticas/grants nombran a agencia_app: crearlo vacío
docker exec "$CT" psql -qU postgres -d restore -c "CREATE ROLE agencia_app NOLOGIN; CREATE ROLE agencia;" >/dev/null
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$BACKUP_FILE" | gunzip \
  | docker exec -i "$CT" psql -q -v ON_ERROR_STOP=1 -U postgres -d restore >/dev/null

REPORT=""
for t in $TABLES; do
  n=$(docker exec "$CT" psql -tAU postgres -d restore -c "select count(*) from public.$t")
  REPORT="$REPORT $t=$n"
done
MIG=$(docker exec "$CT" psql -tAU postgres -d restore -c "select count(*) from schema_migrations")
[ "$MIG" -gt 0 ] || { echo "schema_migrations vacía" >&2; exit 1; }
echo "restauración OK ($(basename "$BACKUP_FILE")):$REPORT migraciones=$MIG"
notify "Kora: prueba de restauración OK ($(basename "$BACKUP_FILE")):$REPORT migraciones=$MIG"
