-- 0014 · Agentes asociados: el agente de ventas deja de ser un usuario de la agencia.
-- Tiene nombre, email, Discord y dueño de agencia propios; si algún día entra a Kora, se enlaza a su usuario (user_id).
-- Los agentes migrados conservan como id el id de usuario que tenían: ventas, cuotas y niveles siguen apuntando al mismo
-- valor, solo cambia la tabla a la que apuntan. agent_profiles se absorbe en agents.

create table agents (
  workspace_id    uuid not null references workspaces(id),
  id              uuid not null default gen_random_uuid(),
  name            text not null check (length(trim(name)) between 1 and 120),
  email           text,
  user_id         uuid,
  upline_agent_id uuid check (upline_agent_id <> id),
  discord_user_id text,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, user_id),                 -- un usuario, un agente
  unique (workspace_id, discord_user_id),
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, upline_agent_id) references agents(workspace_id, id)
);
create unique index agents_email_uq on agents (workspace_id, lower(email)) where email is not null;
create index on agents (workspace_id, upline_agent_id);

-- Todo usuario que aparece en ventas, cuotas, niveles o perfiles (también como dueño de agencia) pasa a ser agente
insert into agents (workspace_id, id, name, email, user_id, discord_user_id)
select x.workspace_id, x.user_id, u.name, u.email, x.user_id, p.discord_user_id
from (
  select workspace_id, user_id from agent_profiles
  union select workspace_id, upline_user_id from agent_profiles where upline_user_id is not null
  union select workspace_id, user_id from agent_levels
  union select workspace_id, agent_user_id from sales
  union select workspace_id, beneficiary_user_id from commission_installments
) x
join users u on u.id = x.user_id
left join agent_profiles p on p.workspace_id = x.workspace_id and p.user_id = x.user_id;

update agents a set upline_agent_id = p.upline_user_id
from agent_profiles p where p.workspace_id = a.workspace_id and p.user_id = a.id and p.upline_user_id is not null;

-- Las referencias pasan de workspace_members a agents (mismas columnas de valor, nombre nuevo)
do $$
declare r record;
begin
  for r in select conrelid::regclass as t, conname from pg_constraint
           where contype = 'f' and confrelid = 'workspace_members'::regclass
             and conrelid in ('sales'::regclass, 'commission_installments'::regclass, 'agent_levels'::regclass) loop
    execute format('alter table %s drop constraint %I', r.t, r.conname);
  end loop;
end $$;

alter table sales rename column agent_user_id to agent_id;
alter table sales add constraint sales_agent_fk foreign key (workspace_id, agent_id) references agents(workspace_id, id);
alter table commission_installments rename column beneficiary_user_id to beneficiary_agent_id;
alter table commission_installments add constraint commission_installments_agent_fk
  foreign key (workspace_id, beneficiary_agent_id) references agents(workspace_id, id);
alter table agent_levels rename column user_id to agent_id;
alter table agent_levels add constraint agent_levels_agent_fk foreign key (workspace_id, agent_id) references agents(workspace_id, id);

drop table agent_profiles;

-- Multi-tenant (ADR 0001). Sin delete: un agente con historial se archiva
alter table agents enable row level security;
create policy tenant on agents using (workspace_id = app_ws()) with check (workspace_id = app_ws());
grant select, insert, update on agents to agencia_app;
