-- 0002 · Departamentos que se asignan automáticamente al aceptar una invitación.
-- ponytail: arreglo de uuid sin FK; al aceptar se insertan solo los que existen en el workspace.
alter table invitations add column department_ids uuid[] not null default '{}';
