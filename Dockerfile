# Imagen de producción de Kora: la web se compila en la etapa "build"; el servidor corre TypeScript directo
# (type stripping de Node 22), así que la imagen final solo lleva dependencias de producción.

# ---- Etapa 1: compilar la web ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/contracts/package.json shared/contracts/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY web web
RUN npm run build

# ---- Etapa 2: dependencias de producción (solo server + contratos) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/contracts/package.json shared/contracts/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server -w shared/contracts

# ---- Etapa 3: landing estática (opcional) ----
# El comodín "landing*" no falla si la carpeta aún no existe; package.json asegura que haya al menos una coincidencia.
FROM node:22-alpine AS landing
COPY package.json landing* /stage/
RUN rm -f /stage/package.json

# ---- Etapa 4: imagen final ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=4300 \
    WEB_DIST=/app/web/dist \
    LANDING_DIR=/app/landing
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY shared shared
COPY server server
COPY ops ops
COPY --from=build /app/web/dist web/dist
COPY --from=landing /stage landing
COPY ops/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R node:node /app
USER node
WORKDIR /app/server
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/main.ts"]
