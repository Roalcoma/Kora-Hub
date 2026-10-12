# ADR 0008 · El resto de cada comisión se paga en cuotas mensuales

**Estado:** aceptada · 2026-10-12 (migración `0012_monthly_remainder.sql`)

## Contexto
Hasta ahora cada comisión (directa u override) se pagaba en dos cuotas: el adelanto (`advance_months` de 12 de la
compañía, p. ej. 9/12 = 75 %) en la fecha de ISSUE y el resto completo a los 12 meses. Rodrigo pidió (2026-10-12) que
el resto se pague mes a mes, como lo paga la compañía.

## Decisión
- Regla: el adelanto no cambia. El resto se divide en `n = 12 − advance_months` cuotas de `round(total / 12)` centavos,
  con vencimiento el mismo día del ISSUE de los meses `advance_months + 1 … 12`. La última absorbe el redondeo para que
  la suma sea exactamente el total. Con `advance_months = 12` no hay resto. Con montos de pocos centavos la cuota se acota
  para que la última no quede negativa, y las cuotas en 0 se omiten.
- `commission_installments.seq smallint`: `0` = adelanto, `1..n` = cuotas del resto (consecutivas), `null` = chargeback
  (check en la BD). `part` se mantiene (`advance` / `remainder` / `chargeback`) para no tocar los consumidores
  (nómina y resumen de Finanzas suman por estado y fecha, sin mirar la parte).
- Migración de datos: cada resto **pendiente** se reemplaza por sus `n` cuotas (mismo beneficiario, tipo, nivel y %,
  fechas desde el ISSUE de la venta, `advance_months` actual de la compañía; el total de la comisión es la suma de sus
  cuotas no anuladas). Los restos pagados o anulados quedan como estaban, con `seq = 1` (legado).
- Contrato: `Installment` pierde `sibling` y gana `seq`, `month` (meses tras el ISSUE), `of` (cuántas cuotas tiene la
  comisión) y `group` (todas las cuotas de la misma venta + beneficiario + tipo, sin chargebacks, ordenadas por `seq`,
  **incluida la propia**, para que la UI dibuje la fila completa con la actual marcada). `total` sigue siendo la suma.

## Consecuencias
- Una venta genera 4 filas por beneficiario (con 9 meses adelantados) en lugar de 2: el listado de Comisiones y el CSV
  crecen; la paginación y los filtros por fecha ya lo cubren.
- El chargeback no cambia: se anulan todas las cuotas pendientes y se descuenta el % de lo pagado (adelanto + las
  cuotas mensuales ya pagadas).
- Si una compañía cambió `advance_months` después del ISSUE, la migración usa el valor actual; la suma se conserva igual
  porque la última cuota absorbe la diferencia.
