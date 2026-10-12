-- 0011 · Botón de Rocco CRM: el superadmin decide desde el backoffice qué agencias lo ven en la barra lateral.
-- Columna propia y no dentro de `settings`, porque el Admin de la agencia edita `settings` por PATCH /w/:slug.
-- La URL del CRM es global (variable de entorno CRM_URL), no por agencia.
alter table workspaces add column crm_link boolean not null default false;
