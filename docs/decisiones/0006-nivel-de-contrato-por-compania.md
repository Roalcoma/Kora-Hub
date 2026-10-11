# ADR 0006 · El nivel de contrato del agente va por compañía

**Estado:** aceptada · 2026-10-11 (migración `0009_levels_by_carrier.sql`)

## Contexto
`agent_levels` (0007) guardaba un solo nivel FFL por agente, con historial por `effective_from`, y el % salía de
`comp_grid` del producto. El cliente (VFS) aclaró que el nivel se contrata **con cada compañía**: un agente puede ser
80 en Americo y 90 en NLG.

## Decisión
- `agent_levels` gana `carrier_id` (not null). PK `(workspace_id, user_id, carrier_id, effective_from)` y FK compuesta
  `(workspace_id, carrier_id) → carriers(workspace_id, id)`. El nivel vigente para una venta es el más reciente
  `<= ISSUE` **de la compañía del producto vendido**.
- Backfill: cada fila existente se copia a todas las compañías del workspace (archivadas incluidas, por si hay ventas
  antiguas de ellas) y se borra la original. Así el cálculo de comisiones da exactamente lo mismo que antes.
- Se mantienen RLS `tenant` y el `revoke delete` a `agencia_app`: el historial sigue sin borrarse.
- Contrato: `AgentProfile.levels[]` lleva `carrierId`; `LevelBody` recibe `carrierIds[]` (1–50) para aplicar el mismo
  nivel a varias compañías de una vez (un ascenso general sigue siendo una sola acción en la UI).

## Consecuencias
- Un workspace sin compañías al migrar pierde su historial de niveles (no tenía dónde aplicarlo). En VFS no ocurre.
- Una compañía creada después no hereda niveles: el admin debe asignarlos; sin nivel no hay % (igual que antes con un
  agente sin nivel).
