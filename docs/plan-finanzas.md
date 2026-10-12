# Plan · Módulo de finanzas: gastos, nómina y estados de cuenta

_Aprobado por Rodrigo el 2026-10-11._

Pedido para VFS, pero como todo en Kora se **activa por agencia** (`settings.finance_module`) y nada de VFS queda
fijo en el código. Moneda única: **USD**. Todo el dinero en centavos enteros, igual que ventas.

Decisiones tomadas el 2026-10-11:

| Tema | Decisión |
|---|---|
| Acceso | **Owner, Admin y un rol nuevo "Contable"**: ven y editan todo el módulo. Los demás no lo ven (ni el menú) |
| Gastos | Únicos o recurrentes **diarios, semanales o mensuales**. Cada ocurrencia se genera como gasto **pendiente** que se marca pagado (y se puede ajustar el monto real) |
| Nómina | 100 % configurable: sueldo fijo por periodo, por hora, bonos/deducciones y comisión de ventas. **Las personas en nómina no necesitan usuario de Kora** (se pueden enlazar a uno si lo tienen) |
| Estados de cuenta | Formato del banco aún desconocido: **carga manual con número de referencia** + **importación de CSV con mapeo de columnas** (sirve para cualquier banco). PDF/OFX se agregan cuando se conozca el formato |
| Aprobación de gastos | Si lo carga **Owner o Admin**, queda aprobado. Si lo carga un **Contable** (gasto o plantilla recurrente, o cambia el monto de uno aprobado), queda **por aprobar** hasta que un Owner/Admin lo apruebe o rechace. Las ocurrencias de una plantilla aprobada nacen aprobadas |
| Comisión en nómina | Entran las cuotas de comisión **marcadas pagadas** dentro del periodo de la corrida |
| Calendarios de nómina | VFS puede usar cualquiera (semanal, quincenal, dos veces al mes, mensual); varios a la vez |
| Cuentas bancarias | Normalmente una, pero se admiten varias |
| Cruce con comisiones | Ahora se guarda todo lo necesario (compañía que paga, referencia, monto, fecha). El **cruce automático** es una fase posterior (§6) |

---

## 1. Rol "Contable"

- Rol nuevo `accountant` en `workspace_members.role` (y en invitaciones).
- Fuera de finanzas se comporta como **Miembro** (chat, manuales, tareas, metas, sus propias ventas si vende).
- Dentro de finanzas tiene el mismo poder que Admin.
- Se asigna desde Ajustes → Miembros o al invitar. Etiqueta en la UI: "Contable" / "Accountant".
- Toca la plataforma (rangos de rol en `server/src/platform/workspace.ts`, contrato `Role`, pantallas de miembros).

## 2. Gastos

**Categorías** configurables (Renta, Software, Marketing, Leads, Servicios, Impuestos…) con color; se crean las
básicas al activar el módulo.

**Proveedor / beneficiario**: texto libre con autocompletado de los ya usados (no hace falta una tabla aparte).

**Gasto único**: fecha, categoría, proveedor, concepto, monto, método de pago (tarjeta, ACH, Zelle, cheque,
efectivo, otro), referencia, notas, **comprobante adjunto** (PDF/imagen en MinIO, como los archivos del chat),
estado pendiente/pagado.

**Gasto recurrente** (plantilla):

| Frecuencia | Configuración |
|---|---|
| Diario | cada N días; opción "solo días hábiles" |
| Semanal | cada N semanas; día(s) de la semana |
| Mensual | cada N meses; día del mes (o "último día") |

- Fecha de inicio, fecha de fin opcional, monto estimado, categoría, proveedor, método.
- Un **job diario** genera las ocurrencias hasta 35 días adelante, idempotente (`unique (schedule_id, due_date)`).
- Cada ocurrencia es un gasto normal: se marca pagado (con monto real, fecha y referencia), se salta o se edita.
- Pausar o terminar la plantilla no borra lo ya generado; cambiar el monto aplica desde la próxima ocurrencia pendiente.

**Vistas**: lista con filtros (rango de fechas como en ventas, categoría, estado, proveedor), totales por categoría,
"vencidos sin pagar", CSV.

## 3. Nómina

**Personas en nómina** (`payroll_people`), independientes de los usuarios:
nombre, correo y teléfono opcionales, cargo, método de pago (ACH, Zelle, cheque, efectivo), últimos 4 de la cuenta,
fecha de alta/baja, **usuario de Kora opcional** (necesario solo si cobra comisión de ventas), activo/inactivo.

**Componentes** de cada persona (todos opcionales y combinables):

| Tipo | Cálculo |
|---|---|
| Sueldo fijo | monto por periodo |
| Por hora | horas del periodo × tarifa (las horas se escriben al preparar la corrida) |
| Comisión de ventas | suma de sus cuotas de comisión del módulo de ventas en el periodo (ver pregunta abierta 1) |
| % de las ventas | opcional: % sobre el monto ISSUE de sus ventas del periodo (para quien no tiene nivel FFL) |
| Bono fijo recurrente | monto por periodo |
| Deducción recurrente | monto fijo o % del bruto (adelantos, préstamos, seguro…) |

Cada componente tiene vigencia (desde/hasta), así un aumento no cambia nóminas pasadas.

**Calendarios de pago** configurables: semanal, quincenal (cada 2 semanas), dos veces al mes (15 y último) y
mensual, con su día de pago. Cada persona pertenece a uno.

**Corridas de nómina** (`payroll_runs`):
1. **Borrador**: Kora calcula una línea por persona activa del calendario (bruto, deducciones, neto) con el
   desglose; se escriben horas y se agregan **bonos o deducciones puntuales** solo para esa corrida.
2. **Aprobada**: queda congelada (cambios posteriores en componentes no la tocan).
3. **Pagada**: por persona o toda la corrida, con fecha y referencia. Cada pago aparece como gasto de categoría
   "Nómina" en los reportes.

Recibo por persona (vista imprimible / PDF del navegador) y CSV de la corrida.

**Fuera de alcance:** Kora **no calcula impuestos de nómina** de EE. UU. (federal, FICA, estatal) ni emite W-2/1099;
si VFS los retiene, se cargan como deducciones configuradas. Para eso siguen sirviendo Gusto/ADP/contador.

## 4. Estados de cuenta del banco

**Cuentas bancarias** (`bank_accounts`): nombre ("Chase operativa"), banco, últimos 4, activa.

**Movimientos** (`bank_transactions`): cuenta, fecha, descripción, monto (+ entrada / − salida), **número de
referencia**, compañía que paga (opcional: Americo, NLG, MOO…), notas, origen (manual / CSV) y estado de cruce
(sin cruzar / cruzado / ignorado).

**Carga manual**: modal rápido, pensado para escribir varios seguidos.

**Importación CSV**:
1. Se sube el archivo y se elige la cuenta.
2. Kora muestra las primeras filas y se indican las columnas: fecha, descripción, monto (o débito/crédito por
   separado), referencia; formato de fecha.
3. El mapeo se **guarda por cuenta**: el mes siguiente se importa sin volver a configurar.
4. Duplicados: misma cuenta + fecha + monto + referencia (o descripción) se omiten y se reporta cuántos.
5. Se sugiere la compañía por palabras clave en la descripción usando los **alias de compañías** del módulo de
   ventas ("AMERICO FIN LIFE…" → Americo); se puede corregir.

Cada importación queda como un **estado de cuenta** (`bank_statements`: cuenta, periodo, archivo original
adjunto, quién lo subió) para poder deshacerla completa.

## 5. Pantallas

Nueva sección **Finanzas** en la barra lateral (solo Owner/Admin/Contable), con pestañas:
**Resumen** · **Gastos** · **Nómina** · **Banco** · **Configuración**.

- **Resumen**: periodo con el mismo filtro de fechas; entradas del banco, gastos pagados, nómina pagada, resultado;
  gastos por categoría; próximos pagos (gastos y nómina de los próximos 15 días); vencidos.
- **Configuración**: categorías, calendarios de pago, personas de nómina con sus componentes, cuentas bancarias y
  sus mapeos CSV.

Mismo design system que ventas: tablas paginadas, modales, filtros con Dropdown, móvil sin scroll horizontal.

## 6. Fase posterior: conciliación (no entra ahora)

- Cruce de **entradas del banco** con **cuotas de comisión** por compañía y periodo: Kora propone
  ("Americo depositó $X el 15/10; las cuotas de Americo esperadas en esa semana suman $Y"), se confirma y las cuotas
  quedan **pagadas** con la referencia del banco. Diferencias visibles (de menos, de más, sin depósito).
- Cruce de **salidas del banco** con gastos y pagos de nómina.
- Requiere ver primero estados reales de VFS para saber si las compañías depositan por póliza o en lote.

## 7. Datos y técnica

Tablas nuevas (todas con `workspace_id`, RLS `tenant`, FK compuestas):
`expense_categories`, `expense_schedules`, `expenses`, `payroll_calendars`, `payroll_people`,
`payroll_components`, `payroll_runs`, `payroll_lines`, `payroll_adjustments`, `bank_accounts`,
`bank_statements`, `bank_transactions`, `bank_csv_mappings`. Migración `0010_finance.sql` + rol `accountant`.

Código: `server/src/finance/` (backend-modulos), `web/src/finance/` (frontend-modulos), contrato
`shared/contracts/src/finance.ts` (arquitecto), pruebas `server/test/finance.test.ts` (qa); revisión de seguridad
antes de integrar por ser datos financieros (seguridad).

Pruebas: recurrencias (fin de mes, 31 → 30/28, días hábiles, idempotencia del job), cálculo de nómina por cada
componente y vigencias, corrida congelada al aprobar, importación CSV con duplicados, permisos (Miembro → 403,
Contable → OK) y aislamiento entre agencias.

## 8. Fases

| Fase | Contenido |
|---|---|
| A | Rol Contable, migración y contrato, gastos únicos y recurrentes con su job, categorías, comprobantes |
| B | Nómina: personas, componentes, calendarios, corridas, recibos |
| C | Banco: cuentas, carga manual, importación CSV con mapeo, sugerencia de compañía |
| D | Resumen y CSV; revisión de seguridad; QA en navegador |
| Luego | Conciliación (§6) cuando tengamos estados reales |

## 9. Preguntas abiertas

Resueltas el 2026-10-11 (ver tabla de decisiones).
