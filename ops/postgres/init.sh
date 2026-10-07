#!/bin/sh
# Crea el rol con el que corre la app. No es superusuario ni dueño de las tablas,
# así que las políticas RLS sí se le aplican (ver docs/decisiones/0001).
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE agencia_app LOGIN PASSWORD '$APP_DB_PASSWORD' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE $POSTGRES_DB TO agencia_app;
SQL
