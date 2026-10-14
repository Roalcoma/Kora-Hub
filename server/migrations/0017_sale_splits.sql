-- 0017 · Ventas en split: otros agentes con su % de la venta (el agente principal se queda con el resto).
-- Al ISSUE cada agente cobra sobre su parte con su nivel, y el override de su dueño de agencia sale de esa parte.
create table sale_splits (
  workspace_id  uuid not null,
  sale_id       uuid not null,
  agent_id      uuid not null,
  percent       numeric(5,2) not null check (percent > 0 and percent < 100),
  primary key (workspace_id, sale_id, agent_id),
  foreign key (workspace_id, sale_id) references sales(workspace_id, id) on delete cascade,
  foreign key (workspace_id, agent_id) references agents(workspace_id, id)
);
create index on sale_splits (workspace_id, agent_id);

-- De qué agente de la venta sale cada cuota (su parte) y qué % de la venta es esa parte
alter table commission_installments add column via_agent_id uuid, add column share numeric(5,2) not null default 100
  check (share > 0 and share <= 100);
update commission_installments i set via_agent_id = s.agent_id from sales s where s.id = i.sale_id;
alter table commission_installments alter column via_agent_id set not null,
  add constraint commission_installments_via_fk foreign key (workspace_id, via_agent_id) references agents(workspace_id, id);

alter table sale_splits enable row level security;
create policy tenant on sale_splits using (workspace_id = app_ws()) with check (workspace_id = app_ws());
grant select, insert, delete on sale_splits to agencia_app;
