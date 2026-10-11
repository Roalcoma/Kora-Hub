-- 0009 · El nivel de contrato del agente va por compañía (ADR 0006): un agente puede ser 80 en Americo y 90 en NLG.
-- Backfill: cada nivel existente se copia a todas las compañías de su workspace (incluidas las archivadas) y se
-- borra la fila original sin compañía. Un workspace sin compañías pierde su historial de niveles: sin compañía no
-- hay producto ni tabla de comisiones donde aplicarlo.

alter table agent_levels add column carrier_id uuid;
-- La PK vieja (sin compañía) impediría las copias: se quita antes del backfill
alter table agent_levels drop constraint agent_levels_pkey;

insert into agent_levels (workspace_id, user_id, carrier_id, effective_from, level, set_by, set_at)
select l.workspace_id, l.user_id, c.id, l.effective_from, l.level, l.set_by, l.set_at
from agent_levels l
join carriers c on c.workspace_id = l.workspace_id
where l.carrier_id is null;

-- Corre como dueño de la tabla: el revoke de delete aplica solo a agencia_app
delete from agent_levels where carrier_id is null;

alter table agent_levels alter column carrier_id set not null;
alter table agent_levels add primary key (workspace_id, user_id, carrier_id, effective_from);
alter table agent_levels add constraint agent_levels_carrier_fk
  foreign key (workspace_id, carrier_id) references carriers(workspace_id, id);

-- RLS (política tenant) y grants (select/insert/update a agencia_app, sin delete) siguen como en 0007:
-- alter table no los toca.
