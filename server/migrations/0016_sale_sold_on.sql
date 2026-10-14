-- 0016 · Fecha de la venta (el día en que el agente la reportó), aparte de la fecha esperada de ISSUE.
-- Las de Discord la sacan del id del mensaje (snowflake: ms desde 2015 en los bits altos); las manuales, del día en que se registraron.
-- Todo en el día de Nueva York, como el resto del módulo de ventas.
alter table sales add column sold_on date;
update sales set sold_on = (case
  when discord_message_id ~ '^[0-9]+$'
    then to_timestamp((div(discord_message_id::numeric, 4194304) + 1420070400000) / 1000.0)
  else created_at end at time zone 'America/New_York')::date;
alter table sales alter column sold_on set default (now() at time zone 'America/New_York')::date, alter column sold_on set not null;
create index on sales (workspace_id, sold_on desc);
