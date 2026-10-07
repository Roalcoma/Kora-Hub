-- 0001 · Esquema inicial de Agencia Hub (§9 del plan).
-- Aislamiento: toda tabla de negocio lleva workspace_id, FK compuestas (workspace_id, id) para que la BD
-- rechace referencias entre workspaces, y política RLS "tenant". Ver docs/decisiones/0001.

create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists citext;

-- El rol de la app lo crea ops/postgres/init.sh con contraseña; aquí solo garantizamos que exista.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'agencia_app') then
    create role agencia_app nologin;
  end if;
end $$;
grant usage on schema public to agencia_app;

-- Contexto de la transacción (lo fija withWorkspace con set_config(..., true)).
create function app_ws() returns uuid language sql stable as
  $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;
create function app_user() returns uuid language sql stable as
  $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- unaccent no es immutable; este envoltorio permite usarlo en columnas generadas e índices.
create function immutable_unaccent(text) returns text language sql immutable parallel safe strict as
  $$ select public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ═══════════════════════════ Plataforma ═══════════════════════════

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         citext not null unique,
  password_hash text,
  name          text not null,
  avatar_key    text,
  locale        text not null default 'es' check (locale in ('es', 'en')),
  timezone      text not null default 'America/New_York',
  totp_secret   text,
  totp_enabled  boolean not null default false,
  token_version integer not null default 0,
  created_at    timestamptz not null default now()
);

create table workspaces (
  id                     uuid primary key default gen_random_uuid(),
  slug                   citext not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                   text not null,
  logo_key               text,
  plan                   text not null default 'trial' check (plan in ('trial', 'standard', 'pro')),
  status                 text not null default 'trialing'
                           check (status in ('trialing', 'active', 'past_due', 'read_only', 'suspended', 'closing')),
  trial_ends_at          timestamptz not null default now() + interval '14 days',
  grace_ends_at          timestamptz,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  settings               jsonb not null default '{"max_file_mb": 25, "require_2fa": false, "weekly_summary": false}',
  storage_bytes          bigint not null default 0,
  deletion_scheduled_at  timestamptz,
  created_at             timestamptz not null default now()
);

create table workspace_members (
  workspace_id    uuid not null references workspaces(id),
  user_id         uuid not null references users(id),
  role            text not null check (role in ('owner', 'admin', 'lead', 'member', 'guest')),
  title           text,
  status_text     text,
  status_until    timestamptz,
  is_active       boolean not null default true,
  -- channel_default: nivel de push para canales sin preferencia propia; dnd: horario "no molestar"
  notif_prefs     jsonb not null default '{"channel_default": "mentions", "dnd": null}',
  joined_at       timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on workspace_members (user_id);

create table invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  token_hash   text not null unique,           -- sha256 del token; el token en claro solo viaja en el enlace
  email        citext,                         -- null = enlace de invitación reutilizable
  role         text not null check (role in ('admin', 'lead', 'member', 'guest')),
  invited_by   uuid not null,
  max_uses     integer not null default 1,
  uses         integer not null default 0,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, invited_by) references workspace_members(workspace_id, user_id)
);

create table password_resets (
  token_hash text primary key,
  user_id    uuid not null references users(id),
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- Ticket de un solo uso para abrir el WebSocket (§10). En tabla para que sirva entre instancias.
create table ws_tickets (
  token_hash   text primary key,
  user_id      uuid not null references users(id),
  workspace_id uuid not null references workspaces(id),
  expires_at   timestamptz not null
);

create table platform_admins (
  user_id    uuid primary key references users(id),
  created_at timestamptz not null default now()
);

create table audit_log (
  id            bigint generated always as identity primary key,
  workspace_id  uuid references workspaces(id),  -- null = evento de plataforma
  actor_user_id uuid references users(id),
  action        text not null,                   -- p. ej. 'member.role_changed', 'auth.login', 'admin.impersonate'
  target_type   text,
  target_id     text,
  meta          jsonb not null default '{}',
  ip            inet,
  created_at    timestamptz not null default now()
);
create index on audit_log (workspace_id, created_at desc);

-- Idempotencia de webhooks de Stripe
create table stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

-- ═══════════════════════════ Estructura de la agencia ═══════════════════════════

create table departments (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  name         text not null,
  position     integer not null default 0,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

create table business_lines (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  name         text not null,
  color        text,                      -- nombre de token del design system, no hex libre
  position     integer not null default 0,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

create table member_departments (
  workspace_id  uuid not null,
  user_id       uuid not null,
  department_id uuid not null,
  is_lead       boolean not null default false,
  primary key (workspace_id, user_id, department_id),
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, department_id) references departments(workspace_id, id)
);
create index on member_departments (workspace_id, department_id);

create table member_lines (
  workspace_id uuid not null,
  user_id      uuid not null,
  line_id      uuid not null,
  primary key (workspace_id, user_id, line_id),
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, line_id) references business_lines(workspace_id, id)
);

-- ═══════════════════════════ Archivos ═══════════════════════════

create table files (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  uploader_id  uuid not null,
  storage_key  text not null unique check (storage_key like workspace_id::text || '/%'),
  name         text not null,
  mime         text not null,
  size         bigint not null check (size > 0),
  width        integer,
  height       integer,
  thumb_key    text,
  status       text not null default 'pending' check (status in ('pending', 'ready')),
  context      text not null check (context in ('message', 'document', 'avatar', 'logo', 'task')),
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, uploader_id) references workspace_members(workspace_id, user_id)
);
create index files_name_trgm on files using gin (immutable_unaccent(name) gin_trgm_ops);

-- ═══════════════════════════ Chat ═══════════════════════════

create table channels (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id),
  kind          text not null check (kind in ('public', 'private', 'dm', 'group_dm', 'announcement')),
  name          text,
  topic         text,
  description   text,
  department_id uuid,
  line_id       uuid,
  dm_key        text,   -- ids de los participantes ordenados y unidos por ':' (evita DMs duplicados)
  created_by    uuid,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, department_id) references departments(workspace_id, id),
  foreign key (workspace_id, line_id) references business_lines(workspace_id, id),
  check ((kind in ('dm', 'group_dm')) = (dm_key is not null)),
  check ((kind in ('dm', 'group_dm')) or name is not null)
);
create unique index channels_name_uq on channels (workspace_id, lower(name)) where name is not null;
create unique index channels_dm_uq on channels (workspace_id, dm_key) where dm_key is not null;
create unique index channels_announcement_uq on channels (workspace_id) where kind = 'announcement';

create table channel_members (
  workspace_id uuid not null,
  channel_id   uuid not null,
  user_id      uuid not null,
  last_read_at timestamptz not null default now(),
  notif_level  text check (notif_level in ('all', 'mentions', 'none')),  -- null = preferencia del miembro
  muted        boolean not null default false,
  starred      boolean not null default false,
  joined_at    timestamptz not null default now(),
  primary key (channel_id, user_id),
  foreign key (workspace_id, channel_id) references channels(workspace_id, id),
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id)
);
create index on channel_members (workspace_id, user_id);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  channel_id      uuid not null,
  user_id         uuid,                                   -- null = mensaje de sistema
  parent_id       uuid,                                   -- hilo
  body            text not null default '',
  body_tsv        tsvector generated always as (to_tsvector('simple', immutable_unaccent(body))) stored,
  also_in_channel boolean not null default false,
  reply_count     integer not null default 0,
  last_reply_at   timestamptz,
  ack_required    boolean not null default false,          -- anuncios con "Entendido"
  meta            jsonb not null default '{}',             -- vistas previas de enlaces, tarjetas de manual
  edited_at       timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, channel_id) references channels(workspace_id, id),
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, parent_id) references messages(workspace_id, id)
);
-- Historial del canal (raíz + respuestas enviadas también al canal), paginado por (created_at, id)
create index messages_channel_idx on messages (channel_id, created_at desc, id desc)
  where parent_id is null or also_in_channel;
create index messages_thread_idx on messages (parent_id, created_at, id) where parent_id is not null;
create index messages_tsv_idx on messages using gin (body_tsv);
create index messages_trgm_idx on messages using gin (immutable_unaccent(body) gin_trgm_ops);

create table message_mentions (
  workspace_id uuid not null,
  message_id   uuid not null,
  kind         text not null check (kind in ('user', 'channel', 'here')),
  user_id      uuid,
  foreign key (workspace_id, message_id) references messages(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id),
  check ((kind = 'user') = (user_id is not null))
);
create index on message_mentions (message_id);
create index on message_mentions (workspace_id, user_id);

create table message_reactions (
  workspace_id uuid not null,
  message_id   uuid not null,
  user_id      uuid not null,
  emoji        text not null check (length(emoji) between 1 and 64),
  created_at   timestamptz not null default now(),
  primary key (message_id, user_id, emoji),
  foreign key (workspace_id, message_id) references messages(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id)
);

create table message_pins (
  workspace_id uuid not null,
  channel_id   uuid not null,
  message_id   uuid primary key,
  pinned_by    uuid not null,
  expires_at   timestamptz,                -- anuncios fijados hasta una fecha
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, channel_id) references channels(workspace_id, id),
  foreign key (workspace_id, message_id) references messages(workspace_id, id) on delete cascade,
  foreign key (workspace_id, pinned_by) references workspace_members(workspace_id, user_id)
);
create index on message_pins (channel_id);

create table announcement_acks (
  workspace_id uuid not null,
  message_id   uuid not null,
  user_id      uuid not null,
  acked_at     timestamptz not null default now(),
  primary key (message_id, user_id),
  foreign key (workspace_id, message_id) references messages(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id)
);

create table message_files (
  workspace_id uuid not null,
  message_id   uuid not null,
  file_id      uuid not null,
  position     integer not null default 0,
  primary key (message_id, file_id),
  foreign key (workspace_id, message_id) references messages(workspace_id, id) on delete cascade,
  foreign key (workspace_id, file_id) references files(workspace_id, id)
);

-- Una suscripción por dispositivo; sirve para todos los workspaces del usuario (push es por origen).
create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id),
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index on push_subscriptions (user_id);

-- ═══════════════════════════ Manuales ═══════════════════════════

create table documents (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  department_id uuid not null,
  line_id       uuid,
  parent_id     uuid,
  title         text not null,
  content       jsonb not null default '{"type": "doc", "content": []}',  -- JSON de Tiptap
  content_text  text not null default '',
  tsv           tsvector generated always as (
                  setweight(to_tsvector('simple', immutable_unaccent(title)), 'A') ||
                  setweight(to_tsvector('simple', immutable_unaccent(content_text)), 'B')) stored,
  position      integer not null default 0,
  created_by    uuid not null,
  updated_by    uuid not null,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, department_id) references departments(workspace_id, id),
  foreign key (workspace_id, line_id) references business_lines(workspace_id, id),
  foreign key (workspace_id, parent_id) references documents(workspace_id, id),
  foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, updated_by) references workspace_members(workspace_id, user_id)
);
create index on documents (workspace_id, department_id, parent_id, position);
create index documents_tsv_idx on documents using gin (tsv);

create table document_versions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id  uuid not null,
  title        text not null,
  content      jsonb not null,
  edited_by    uuid not null,
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, document_id) references documents(workspace_id, id),
  foreign key (workspace_id, edited_by) references workspace_members(workspace_id, user_id)
);
create index on document_versions (document_id, created_at desc);

create table document_files (
  workspace_id uuid not null,
  document_id  uuid not null,
  file_id      uuid not null,
  primary key (document_id, file_id),
  foreign key (workspace_id, document_id) references documents(workspace_id, id),
  foreign key (workspace_id, file_id) references files(workspace_id, id)
);

-- ═══════════════════════════ Tareas ═══════════════════════════

create table tasks (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  department_id     uuid not null,
  line_id           uuid,
  title             text not null,
  description       text not null default '',
  status            text not null default 'todo' check (status in ('todo', 'doing', 'done', 'cancelled')),
  priority          text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  due_at            timestamptz,
  position          double precision not null default 0,   -- orden dentro de la columna del kanban
  source_message_id uuid,
  created_by        uuid not null,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, department_id) references departments(workspace_id, id),
  foreign key (workspace_id, line_id) references business_lines(workspace_id, id),
  foreign key (workspace_id, source_message_id) references messages(workspace_id, id),
  foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id)
);
create index on tasks (workspace_id, department_id, status, position);
create index on tasks (due_at) where status in ('todo', 'doing');

create table task_assignees (
  workspace_id uuid not null,
  task_id      uuid not null,
  user_id      uuid not null,
  primary key (task_id, user_id),
  foreign key (workspace_id, task_id) references tasks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id)
);
create index on task_assignees (workspace_id, user_id);

create table task_comments (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id      uuid not null,
  user_id      uuid not null,
  body         text not null,
  edited_at    timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, task_id) references tasks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id)
);
create index on task_comments (task_id, created_at);

create table task_checklist_items (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id      uuid not null,
  text         text not null,
  done         boolean not null default false,
  position     integer not null default 0,
  foreign key (workspace_id, task_id) references tasks(workspace_id, id) on delete cascade
);
create index on task_checklist_items (task_id, position);

-- ═══════════════════════════ Metas ═══════════════════════════

create table goals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  department_id uuid not null,
  line_id       uuid,
  name          text not null,
  unit          text not null,
  weekly_target numeric not null check (weekly_target > 0),
  position      integer not null default 0,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, department_id) references departments(workspace_id, id),
  foreign key (workspace_id, line_id) references business_lines(workspace_id, id)
);

create table weekly_reports (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  department_id uuid not null,
  week_start    date not null check (extract(isodow from week_start) = 1),  -- siempre lunes
  notes         text not null default '',
  submitted_by  uuid not null,
  submitted_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, department_id, week_start),
  foreign key (workspace_id, department_id) references departments(workspace_id, id),
  foreign key (workspace_id, submitted_by) references workspace_members(workspace_id, user_id)
);

create table weekly_report_items (
  workspace_id uuid not null,
  report_id    uuid not null,
  goal_id      uuid not null,
  target       numeric not null,   -- copia del objetivo vigente al entregar: el histórico no cambia
  actual       numeric not null check (actual >= 0),
  note         text,
  primary key (report_id, goal_id),
  foreign key (workspace_id, report_id) references weekly_reports(workspace_id, id) on delete cascade,
  foreign key (workspace_id, goal_id) references goals(workspace_id, id)
);

-- ═══════════════════════════ Infra ═══════════════════════════

-- Cola de trabajos (SKIP LOCKED). Solo la usa adminPool: los jobs cruzan workspaces.
create table jobs (
  id           bigint generated always as identity primary key,
  workspace_id uuid references workspaces(id),
  kind         text not null,
  payload      jsonb not null default '{}',
  dedupe_key   text unique,          -- idempotencia: el mismo trabajo no se encola dos veces
  run_at       timestamptz not null default now(),
  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  done_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index jobs_ready_idx on jobs (run_at) where done_at is null;

-- ═══════════════════════════ RLS y permisos del rol de la app ═══════════════════════════

-- Tablas de negocio: política única por workspace del contexto.
do $$
declare t text;
begin
  foreach t in array array[
    'invitations', 'audit_log', 'departments', 'business_lines', 'member_departments', 'member_lines',
    'files', 'channels', 'channel_members', 'messages', 'message_mentions', 'message_reactions',
    'message_pins', 'announcement_acks', 'message_files', 'documents', 'document_versions',
    'document_files', 'tasks', 'task_assignees', 'task_comments', 'task_checklist_items',
    'goals', 'weekly_reports', 'weekly_report_items'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
    execute format('grant select, insert, update, delete on %I to agencia_app', t);
  end loop;
end $$;
revoke update, delete on audit_log from agencia_app;   -- la bitácora solo crece

-- Miembros: el workspace activo completo + mis propias membresías (para el riel de workspaces).
alter table workspace_members enable row level security;
create policy tenant on workspace_members using (workspace_id = app_ws()) with check (workspace_id = app_ws());
create policy self_read on workspace_members for select using (user_id = app_user());
grant select, insert, update, delete on workspace_members to agencia_app;

-- Workspaces: leo el activo y aquellos de los que soy miembro; solo edito el activo (y no campos de facturación).
alter table workspaces enable row level security;
create policy member_read on workspaces for select using (
  id = app_ws() or exists (select 1 from workspace_members m where m.workspace_id = workspaces.id and m.user_id = app_user()));
create policy tenant_update on workspaces for update using (id = app_ws()) with check (id = app_ws());
grant select on workspaces to agencia_app;
grant update (name, logo_key, settings) on workspaces to agencia_app;

-- Usuarios (globales): me veo a mí y a los miembros del workspace activo. Nunca hash ni secreto TOTP.
alter table users enable row level security;
create policy visible on users for select using (
  id = app_user() or exists (select 1 from workspace_members m where m.user_id = users.id and m.workspace_id = app_ws()));
create policy self_update on users for update using (id = app_user()) with check (id = app_user());
grant select (id, email, name, avatar_key, locale, timezone, totp_enabled, created_at) on users to agencia_app;
grant update (name, avatar_key, locale, timezone) on users to agencia_app;

-- Suscripciones push: solo las mías.
alter table push_subscriptions enable row level security;
create policy own on push_subscriptions using (user_id = app_user()) with check (user_id = app_user());
grant select, insert, update, delete on push_subscriptions to agencia_app;

-- password_resets, ws_tickets, platform_admins, stripe_events y jobs: sin grant → solo adminPool.
