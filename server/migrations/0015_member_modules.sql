-- 0015 · Permiso por módulo de cada persona: {"manuals": "view", "finance": "edit", …}. Lo que no está sale del rol
-- (MODULE_DEFAULTS en shared/contracts/src/common.ts). Owner y Admin tienen todo, sin importar lo que diga aquí.
alter table workspace_members add column module_access jsonb not null default '{}';
alter table workspace_members add constraint workspace_members_module_access_check check (jsonb_typeof(module_access) = 'object');
