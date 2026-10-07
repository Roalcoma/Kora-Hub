-- 0004 · created_at de mensajes con precisión de milisegundos.
-- JavaScript solo maneja milisegundos: si guardamos microsegundos, "leído hasta <createdAt del mensaje>"
-- queda un instante antes del propio mensaje y lo sigue contando como no leído.
-- clock_timestamp() (no now()) para que varios mensajes de una misma transacción conserven su orden.
alter table messages alter column created_at set default date_trunc('milliseconds', clock_timestamp());
update messages set created_at = date_trunc('milliseconds', created_at);
