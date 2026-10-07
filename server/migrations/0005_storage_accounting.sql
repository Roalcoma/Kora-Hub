-- 0005 · Uso de almacenamiento por workspace, mantenido por la BD.
-- El rol de la app no puede escribir workspaces.storage_bytes (lo usa la cuota y la facturación),
-- así que un trigger SECURITY DEFINER lo actualiza cuando un archivo pasa a 'ready' o se borra.
create function files_storage_accounting() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status = 'ready' and old.status <> 'ready' then
    update workspaces set storage_bytes = storage_bytes + new.size where id = new.workspace_id;
  elsif tg_op = 'DELETE' and old.status = 'ready' then
    update workspaces set storage_bytes = greatest(storage_bytes - old.size, 0) where id = old.workspace_id;
  end if;
  return null;
end $$;

create trigger files_storage_accounting after update of status or delete on files
  for each row execute function files_storage_accounting();
