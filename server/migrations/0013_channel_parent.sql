-- 0013 · Subcanales: un canal puede colgar de otro (un solo nivel; lo valida la API).
-- FK compuesta: el canal superior es siempre de la misma agencia.
alter table channels add column parent_id uuid;
alter table channels add constraint channels_parent_fk foreign key (workspace_id, parent_id) references channels (workspace_id, id);
alter table channels add constraint channels_parent_not_self check (parent_id is distinct from id);
create index channels_parent_idx on channels (parent_id) where parent_id is not null;
