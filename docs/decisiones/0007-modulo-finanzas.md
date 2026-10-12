# ADR 0007 · Módulo de finanzas: rol Contable, aprobación de gastos, nómina congelada y dedupe bancario

**Estado:** aceptada · 2026-10-11 (migración `0010_finance.sql`, contrato `shared/contracts/src/finance.ts`,
plan `docs/plan-finanzas.md`)

## Contexto
VFS pidió llevar gastos, nómina y estados de cuenta del banco dentro de Kora. Como todo módulo, se activa por agencia
(`settings.finance_module`, encendido por defecto en las de seguros, igual que ventas) y nada de VFS queda fijo.

## Decisiones

**Rol Contable (`accountant`).**
- Nuevo valor en `workspace_members.role`, `invitations.role` y en `Role` del contrato.
- Fuera de finanzas tiene el **rango de Miembro**: en `ROLE_RANK` vale lo mismo que `member`, así que `requireRole`
  y `isAdmin` lo tratan como Miembro sin tocar los demás módulos.
- Dentro de finanzas tiene el **poder de Admin**: el guardián único de `/w/:slug/finance/*` deja pasar a Owner,
  Admin y Contable (el resto recibe 404, como si el módulo no existiera, y no ve el menú). La única excepción es la regla de aprobación.
- Las corridas de nómina las **prepara** el Contable pero solo las **aprueba** Owner/Admin (nadie aprueba su propia
  nómina; decisión del orquestador del 2026-10-11, misma lógica que los gastos). Una corrida aprobada sí la puede
  marcar pagada el Contable. Un Owner/Admin **sí** puede aprobar una corrida que incluye su propia línea (Rodrigo,
  2026-10-12: en agencias chicas hay una sola persona que aprueba); hallazgo F7 de la revisión de seguridad aceptado.

**Regla de aprobación de gastos.**
- Gasto o plantilla recurrente creado por Owner/Admin → `approval_status = 'approved'` (aprobado por su autor).
- Creado por un Contable, o un Contable cambia el monto de uno aprobado → `'pending'` hasta que Owner/Admin lo
  apruebe o rechace (`approved_by/approved_at` guardan quién decidió, en ambos casos).
- Las ocurrencias de una plantilla aprobada nacen aprobadas (`created_by` y `approved_by` null = job). Una plantilla
  pendiente o rechazada no genera ocurrencias.
- Solo se pagan gastos aprobados; los rechazados y los saltados no suman en totales ni reportes.

**Gastos recurrentes.** El job diario genera ocurrencias hasta 35 días adelante; `unique (schedule_id, due_date)` lo
hace idempotente y `generated_until` le dice desde dónde seguir. Mensual con `month_day` null = último día; un 31 cae
en el último día de los meses cortos. Una ocurrencia no se borra (el job la recrearía): se salta.

**Nómina congelada al aprobar.** En borrador, `payroll_lines` se recalcula desde componentes vigentes, horas, ajustes
puntuales y cuotas de comisión **pagadas** en el periodo (para personas enlazadas a un usuario). Al aprobar, la línea y
su `breakdown` (jsonb) quedan fijos: cambiar componentes, vigencias o comisiones después no toca la corrida. Solo se
reabre una aprobada sin pagos. Los pagos de nómina **no se copian a `expenses`**: los reportes los suman desde
`payroll_lines.paid_at` bajo una categoría virtual "Nómina" (evita doble registro y desincronización).

**Sin impuestos de nómina.** Kora no calcula retenciones federales, FICA ni estatales ni emite W-2/1099. Si la agencia
retiene algo, se carga como componente `deduction_fixed` o `deduction_percent`.

**Dedupe de movimientos del banco.** El servidor calcula `dedupe_key` = fecha | monto | referencia (o la descripción
normalizada en minúsculas y sin espacios repetidos si no hay referencia). La clave **no es única** en la BD: un mismo
CSV puede listar dos movimientos idénticos legítimos. Al importar se omite una fila si su clave ya existe en la cuenta
desde **otro** estado de cuenta o carga manual; las repetidas dentro del mismo archivo se conservan. La carga manual
no se bloquea: la respuesta avisa `possibleDuplicate`. Deshacer un estado de cuenta borra sus movimientos en cascada.

**Otros.** Dinero en `numeric(12,2)` como ventas (dólares con centavos en el JSON). El mapeo CSV va por índice de
columna (los bancos repiten encabezados) y se guarda por cuenta. Comprobantes y CSV originales usan el flujo normal de
archivos con los contextos nuevos `expense` y `bank_statement`.

## Consecuencias
- `ROLE_RANK` (server) y las etiquetas de rol (web, i18n) deben conocer `accountant`.
- El Contable puede ver sueldos de todos, incluido el suyo; es inherente al rol pedido.
- La conciliación banco ↔ comisiones (fase posterior) partirá de `carrier_id`, `reference` y `match_status`.
