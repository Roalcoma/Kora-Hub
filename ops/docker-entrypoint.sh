#!/bin/sh
# Aplica las migraciones pendientes y luego arranca el proceso indicado (por defecto, el servidor).
set -e
node src/migrate.ts
exec "$@"
