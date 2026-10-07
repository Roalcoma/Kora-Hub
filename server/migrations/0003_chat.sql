-- 0003 · Ajustes para el chat (Ola 2).

-- Idempotencia del envío: el cliente genera clientId; reintentar no duplica el mensaje.
alter table messages add column client_id uuid;
create unique index messages_client_uq on messages (workspace_id, client_id) where client_id is not null;

-- Último mensaje por canal: ordena DMs y calcula no leídos sin recorrer todo el historial.
alter table channels add column last_message_at timestamptz;

-- Menciones no leídas por usuario (pestaña Menciones y contador rojo)
create index message_mentions_user_idx on message_mentions (user_id, message_id) where user_id is not null;

-- Archivos: buscar por mensaje y por dueño
create index on message_files (file_id);
