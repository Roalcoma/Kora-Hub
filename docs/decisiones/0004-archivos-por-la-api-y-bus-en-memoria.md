# ADR 0004 · Archivos a través de la API y bus de tiempo real en memoria

**Estado:** aceptada · 2026-10-07

## 1. Subida y descarga de archivos pasan por la API
El plan (§8) proponía subida directa del navegador a MinIO con URL prefirmada. Eso obliga a que MinIO sea
alcanzable desde el iPhone (Wi-Fi), desde el túnel de Cloudflare y con CORS configurado, y a que una URL
prefirmada filtrada sirva a cualquiera mientras viva.

**Decisión:** el navegador sube con `PUT /w/:slug/files/:id/content` y descarga con `GET /w/:slug/files/:id`.
La API valida tamaño, cuota y permisos (archivos de mensajes solo si puedes leer ese canal) y hace stream
desde/hacia MinIO con URLs SigV4 de 60–300 s firmadas con `node:crypto` (sin SDK de AWS).
El contrato no cambió de forma: `uploadUrl` y `FileRef.url` apuntan a la API.

**Consecuencias:** los bytes atraviesan Node (aceptable con el límite de 25 MB del piloto); los enlaces nunca
caducan en la UI y nunca son públicos. Sin miniaturas en el servidor (sin `sharp`): el visor escala la imagen.
Si el tráfico crece, se vuelve a URLs prefirmadas directas detrás de un dominio propio para S3.

## 2. Tiempo real con bus en memoria
**Decisión:** el piloto corre en **una instancia**; `realtime/hub.ts` entrega eventos a los sockets locales.
`publish()` es el único punto de salida, así que pasar a varias instancias es cambiar su implementación por
`NOTIFY` con ids (el payload de NOTIFY tiene límite de 8 KB) y que cada instancia recargue el evento.
La presencia y la visibilidad (que deciden si se manda push) también viven en memoria por la misma razón.

## 3. Precisión de milisegundos en `messages.created_at`
JavaScript no representa microsegundos; "leído hasta createdAt" quedaba antes del propio mensaje.
Los mensajes se guardan truncados a milisegundos con `clock_timestamp()` (migración 0004).
