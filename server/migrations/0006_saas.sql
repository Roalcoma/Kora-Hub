-- 0006 · Ola 4: facturación, ciclo de vida del plan y agencias de cualquier rubro (ADR 0005).

-- ─── Facturación ───
-- grace_ends_at ya existe (0001): fin de la gracia tras un cobro fallido.
alter table workspaces
  add column current_period_end timestamptz,               -- fin del periodo pagado (lo informa Stripe)
  add column billing_seats      integer,                   -- última cantidad enviada a Stripe
  add column read_only_since    timestamptz,               -- desde cuándo está en solo lectura (suspende a los 30 días)
  add column billing_notices    jsonb not null default '{}';  -- avisos ya enviados: { "trial-3d": "2026-…", … }

-- Los campos de facturación solo los escribe el adminPool (webhooks, jobs, superadmin): el grant de
-- update de agencia_app sigue limitado a (name, logo_key, settings) desde 0001.

-- ─── Rubro y categorías ───
-- Agencias existentes: si tienen líneas son de seguros (única plantilla con líneas hasta ahora).
update workspaces w set settings = w.settings || jsonb_build_object(
  'industry', case when exists (select 1 from business_lines b where b.workspace_id = w.id) then 'insurance' else 'other' end,
  'category_label', case when exists (select 1 from business_lines b where b.workspace_id = w.id)
                      then '{"singular": "Línea", "plural": "Líneas"}'::jsonb else 'null'::jsonb end);
alter table workspaces alter column settings set default
  '{"max_file_mb": 25, "require_2fa": false, "weekly_summary": false, "industry": "other", "category_label": null}';

-- Colores de categoría: de los tonos de seguros a la paleta fija del contrato (CATEGORY_COLORS).
update business_lines set color = case color
  when 'salud' then 'green' when 'vida' then 'blue' when 'medicare' then 'purple' else color end;
update business_lines set color = null
  where color is not null and color not in ('green', 'blue', 'purple', 'orange', 'red', 'teal', 'pink', 'gray');
alter table business_lines add constraint business_lines_color_check
  check (color in ('green', 'blue', 'purple', 'orange', 'red', 'teal', 'pink', 'gray'));
