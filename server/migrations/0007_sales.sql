-- 0007 · Ventas y comisiones por agente (docs/plan-comisiones.md).
-- Compañías y productos configurables. El % sale del nivel de contrato del agente (FFL) cruzado con la tabla de
-- comisiones de cada producto, ambos con vigencia. Override de un nivel (dueño de agencia)
-- y cuotas: adelanto al ISSUE y resto a los 12 meses. Los chargebacks son cuotas negativas.

-- Módulo activo por agencia: las de seguros lo traen encendido
update workspaces set settings = settings || jsonb_build_object('sales_module', settings->>'industry' = 'insurance');
alter table workspaces alter column settings set default
  '{"max_file_mb": 25, "require_2fa": false, "weekly_summary": false, "industry": "other", "category_label": null, "sales_module": false}';

create table carriers (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id),
  name           text not null,
  aliases        text[] not null default '{}',   -- en minúsculas y sin acentos: así los busca el lector de Discord
  advance_months integer not null default 9 check (advance_months between 0 and 12),  -- meses que adelanta al ISSUE
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

create table carrier_products (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  carrier_id   uuid not null,
  name         text not null,
  aliases      text[] not null default '{}',
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  unique (carrier_id, name),
  foreign key (workspace_id, carrier_id) references carriers(workspace_id, id)
);

-- Datos de venta de cada miembro: su dueño de agencia directo (un nivel) y su usuario de Discord
create table agent_profiles (
  workspace_id    uuid not null,
  user_id         uuid not null,
  upline_user_id  uuid check (upline_user_id <> user_id),
  discord_user_id text,
  primary key (workspace_id, user_id),
  unique (workspace_id, discord_user_id),
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, upline_user_id) references workspace_members(workspace_id, user_id)
);
create index on agent_profiles (workspace_id, upline_user_id);

-- Nivel de contrato del agente desde una fecha (un ascenso = fila nueva). El vigente al ISSUE es el más reciente <= ISSUE.
create table agent_levels (
  workspace_id   uuid not null,
  user_id        uuid not null,
  effective_from date not null,
  level          integer not null check (level between 0 and 300),
  set_by         uuid not null,
  set_at         timestamptz not null default now(),
  primary key (workspace_id, user_id, effective_from),
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id)
);

-- Tabla de comisiones de cada producto: nivel → %. Una revisión de la tabla es un juego nuevo con otra fecha.
create table comp_grid (
  workspace_id   uuid not null,
  product_id     uuid not null,
  effective_from date not null,
  level          integer not null check (level between 0 and 300),
  rate           numeric(6,3) not null check (rate >= 0 and rate <= 300),
  primary key (workspace_id, product_id, effective_from, level),
  foreign key (workspace_id, product_id) references carrier_products(workspace_id, id)
);

create table sales (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  agent_user_id       uuid not null,
  product_id          uuid not null,
  amount              numeric(12,2) not null check (amount > 0),   -- monto ISSUE: prima anual
  client_name         text not null,
  client_state        char(2),
  expected_issue_date date not null,                               -- "upon issue" = día de la venta
  issued_at           date,
  status              text not null default 'pending' check (status in ('pending', 'issued', 'declined', 'cancelled')),
  source              text not null default 'manual' check (source in ('manual', 'discord')),
  discord_message_id  text,
  notes               text not null default '',
  created_by          uuid,                                        -- null = lector de Discord
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status in ('issued', 'cancelled')) = (issued_at is not null)),
  unique (workspace_id, id),
  unique (workspace_id, discord_message_id),
  foreign key (workspace_id, agent_user_id) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, product_id) references carrier_products(workspace_id, id)
);
create index on sales (workspace_id, expected_issue_date desc);
create index on sales (workspace_id, agent_user_id);

-- Cuotas de comisión. % y montos congelados al ISSUE: cambiar un % después no las mueve.
create table commission_installments (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  sale_id             uuid not null,
  beneficiary_user_id uuid not null,
  kind                text not null check (kind in ('direct', 'override')),
  part                text not null check (part in ('advance', 'remainder', 'chargeback')),
  level               integer,                     -- nivel del beneficiario al ISSUE
  rate                numeric(6,3) not null,       -- directa: % del agente; override: diferencia con el agente
  amount              numeric(12,2) not null,      -- negativo en chargeback
  due_date            date not null,
  status              text not null default 'pending' check (status in ('pending', 'paid', 'void')),
  paid_at             date,
  created_at          timestamptz not null default now(),
  check ((status = 'paid') = (paid_at is not null)),
  check ((part = 'chargeback') = (amount < 0)),
  unique (workspace_id, id),
  foreign key (workspace_id, sale_id) references sales(workspace_id, id) on delete cascade,
  foreign key (workspace_id, beneficiary_user_id) references workspace_members(workspace_id, user_id)
);
create index on commission_installments (workspace_id, due_date);
create index on commission_installments (sale_id);

-- Lectura del canal de ventas de Discord: un canal por agencia y el último mensaje leído
create table discord_feeds (
  workspace_id    uuid primary key references workspaces(id),
  channel_id      text not null,
  last_message_id text,
  last_polled_at  timestamptz,
  last_error      text
);

-- Mensajes que el lector no pudo completar: esperan que un admin los convierta en venta o los descarte
create table sale_inbox (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id),
  discord_message_id text not null,
  discord_user_id    text not null,
  author_name        text not null,
  content            text not null,
  posted_at          timestamptz not null,
  parsed             jsonb not null default '{}',   -- lo que sí se entendió, para prellenar el formulario
  problems           text[] not null default '{}',
  resolved_at        timestamptz,
  resolved_by        uuid,
  sale_id            uuid,
  unique (workspace_id, id),
  unique (workspace_id, discord_message_id),
  foreign key (workspace_id, sale_id) references sales(workspace_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['carriers', 'carrier_products', 'agent_profiles', 'agent_levels', 'comp_grid', 'sales',
                           'commission_installments', 'discord_feeds', 'sale_inbox'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
    execute format('grant select, insert, update, delete on %I to agencia_app', t);
  end loop;
end $$;
-- El historial de niveles no se borra: un ascenso es una fila nueva (misma fecha = corrección de esa fila)
revoke delete on agent_levels from agencia_app;
