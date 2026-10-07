#!/usr/bin/env bash
# Backup diario de Kora: pg_dump + copia del bucket de MinIO, ambos cifrados con AES-256 (openssl, PBKDF2).
# Pensado para cron en el servidor. Lee ~/infra/kora/.env (o la ruta en ENV_FILE).
# Uso: ops/backup.sh            Variables opcionales: ENV_FILE, BACKUP_DIR, RETENTION_DAYS, COMPOSE_PROJECT
set -Eeuo pipefail

ENV_FILE="${ENV_FILE:-$(dirname "$(readlink -f "$0")")/.env}"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
: "${BACKUP_PASSPHRASE:?Falta BACKUP_PASSPHRASE}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/infra/kora/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_CONTAINER="${PG_CONTAINER:-kora-postgres}"
MINIO_NETWORK="${MINIO_NETWORK:-kora_internal}"
MINIO_HOST="${MINIO_HOST:-minio:9000}"
S3_BUCKET="${S3_BUCKET:-agencia-hub}"
STAMP="$(date +%Y%m%d-%H%M%S)"

notify() { # Aviso a Telegram solo si hay token (el fallo del aviso no rompe el backup)
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  curl -fsS -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" >/dev/null || true
}
WORK="$(mktemp -d)"
trap 'rc=$?; rm -rf "$WORK"; [ $rc -ne 0 ] && notify "Kora: FALLÓ el backup ($STAMP, código $rc)"; exit $rc' EXIT

umask 077
mkdir -p "$BACKUP_DIR"
encrypt() { openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE; }

# 1) Base de datos (formato plano comprimido; el dueño del esquema lo vuelca completo)
docker exec "$PG_CONTAINER" pg_dump -U agencia -d agencia_hub --no-owner | gzip -9 \
  | encrypt > "$BACKUP_DIR/db-$STAMP.sql.gz.enc"

# 2) Archivos: mc mirror desde un contenedor efímero en la red interna. Si la imagen de mc no se puede obtener
#    (MinIO retiró sus imágenes públicas de Docker Hub), se copia el volumen de datos tal cual con tar.
MC_IMAGE="${MC_IMAGE:-minio/mc}"
MINIO_VOLUME="${MINIO_VOLUME:-kora_minio}"
mkdir -p "$WORK/files"
if docker run --rm --network "$MINIO_NETWORK" -v "$WORK/files:/out" \
     -e MC_HOST_kora="http://${S3_ACCESS_KEY:?}:${S3_SECRET_KEY:?}@${MINIO_HOST}" \
     --entrypoint mc "$MC_IMAGE" mirror --quiet "kora/$S3_BUCKET" /out >/dev/null; then
  tar -C "$WORK/files" -czf - . | encrypt > "$BACKUP_DIR/files-$STAMP.tar.gz.enc"
else
  echo "aviso: no se pudo usar $MC_IMAGE; copiando el volumen $MINIO_VOLUME con tar" >&2
  docker run --rm -v "$MINIO_VOLUME:/data:ro" --entrypoint tar postgres:16-alpine -C /data -czf - . \
    | encrypt > "$BACKUP_DIR/files-$STAMP.tar.gz.enc"
fi

# 3) Retención
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.enc' -o -name 'files-*.enc' \) -mtime +"$RETENTION_DAYS" -delete

DB_SIZE=$(du -h "$BACKUP_DIR/db-$STAMP.sql.gz.enc" | cut -f1); F_SIZE=$(du -h "$BACKUP_DIR/files-$STAMP.tar.gz.enc" | cut -f1)
echo "backup $STAMP ok (db $DB_SIZE, archivos $F_SIZE)"
notify "Kora: backup OK $STAMP (db $DB_SIZE, archivos $F_SIZE)"
