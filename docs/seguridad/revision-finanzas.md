# Revisión de seguridad · Módulo de finanzas (rama `feat/finanzas`)

_Agente: seguridad · 2026-10-12 · alcance: `git diff feat/filtros-niveles..feat/finanzas` (commits 01ad40f → 2ffd774)_

Revisé la migración `0010_finance.sql`, el contrato `shared/contracts/src/finance.ts`, `server/src/finance/*`, los cambios
de `server/src/platform/{model,workspace-routes,template,http}.ts`, `main.ts`, `files/routes.ts` (por los contextos
nuevos) y el frontend `web/src/finance/*`, `SettingsPage.vue`, `InvitePanel.vue`, `router.ts` y `AppShell.vue`.
Pruebas en vivo contra el API local (:4300, `vfs-prueba`) solo con lecturas y peticiones sin efecto; no se creó ni
modificó ningún dato.

**Ningún hallazgo crítico: no bloquea la integración**, pero los dos Altos deberían corregirse antes de producción.

| # | Severidad | Hallazgo |
|---|---|---|
| F1 | **Alto** | ReDoS en `parseCsvAmount`: un CSV de 2 MB bloquea el proceso del API ~50 min (todas las agencias) |
| F2 | **Alto** | El Contable esquiva la aprobación: regla, proveedor, método y monto pagado no vuelven a pedir aprobación |
| F3 | Medio | Comprobantes y estados de cuenta descargables por cualquier miembro o invitado que conozca el `fileId` |
| F4 | Medio | TOCTOU al aprobar una corrida: se aprueba lo que haya en ese instante, no lo que revisó el Admin |
| F5 | Bajo | `startsOn` sin límite inferior: una plantilla diaria desde 1900 genera ~46 000 gastos en una petición |
| F6 | Bajo | Desbordes de `numeric(12,2)`/`integer` → 500 y alerta, en vez de 400 |
| F7 | Bajo | Un Admin puede aprobar una corrida que incluye su propia línea de nómina |
| F8 | Info | `sendCsv`: el cambio es correcto; queda sin neutralizar un `\n` inicial (heredado, no alcanzable en finanzas) |
| F9 | Info | Datos financieros sensibles en `audit_log.meta` y en el texto de las alertas de 500 |
| F10 | Info | Detalles menores (GET con efecto, deshacer pagos del Contable) |

---

## F1 · Alto · ReDoS en la lectura de montos del CSV

**Dónde:** `server/src/finance/csv.ts:455` — `if (!/^\d*\.?\d*$/.test(s)) return null;`
Se alcanza desde `server/src/finance/bank.ts:271` (vista previa sin mapeo: `first.cells.every((c) => parseCsvAmount(c) === null)`)
y desde `bank.ts:248-249` → `csv.ts:475-479` (vista previa con mapeo y commit).

**Problema:** `\d*\.?\d*` es ambiguo sobre una cadena de dígitos; si el final no encaja, el motor de V8 prueba todos los
repartos posibles → tiempo **cuadrático**. Antes de llegar ahí la cadena pasa por las transformaciones de las líneas
446-454: con un punto antes de varias comas (`lastComma > lastDot`) se quitan los puntos y solo se cambia **la primera**
coma por punto, así que una coma sobrevive y el regex falla tras recorrer todo.

Medido con la función real copiada (Node 22): celda `"." + "1"×N + ",1,1"`

| N | tiempo |
|---|---|
| 10 000 | 77 ms |
| 40 000 | 1 231 ms |
| ~2 000 000 (límite de 2 MB) | ≈ 50 min (extrapolado, ×4 por cada ×2) |

**Escenario:** el registro es abierto y la plantilla de seguros enciende finanzas, así que cualquiera crea una agencia,
sube un CSV (contexto `bank_statement`) cuya primera línea es `".1111…(1,9 MB)…1,1,1";x` y llama a
`POST /w/:slug/finance/bank/import/preview` sin `mapping`. El hilo único de Node queda ocupado ~50 minutos: el API, el
WebSocket y los jobs se caen para **todas** las agencias. Unas pocas peticiones en paralelo lo prolongan
indefinidamente. Además la transacción mantiene abierta la conexión del pool (y en el commit, el `for update` de la cuenta).

**Corrección sugerida:**
1. Regex sin ambigüedad: `/^\d*(\.\d*)?$/` (lineal), o sin regex: `s.split('.').length <= 2 && !s.includes(',')`.
   Arreglar también la rama `lastComma > lastDot` para que, si queda más de una coma, devuelva `null`.
2. Cortar por longitud antes de interpretar: `if (raw.length > 32) return null` en `parseCsvAmount` y `parseCsvDate`.
3. En `parseCsv`, tope de longitud por celda (p. ej. 1 000 caracteres) y de celdas por registro (p. ej. 200): hoy un
   archivo de 2 MB de solo comas produce un encabezado de 2 M celdas que se devuelve entero en `headers` (~6 MB de JSON).
4. Prueba de regresión con una celda de 50 000 caracteres que debe resolverse en < 50 ms.

## F2 · Alto · El Contable esquiva la regla de aprobación

La regla (ADR 0007, plan §2) es que lo que carga o cambia un Contable queda por aprobar y que solo se pagan gastos
aprobados. En el código **solo el cambio de monto** devuelve a `pending`; todo lo demás conserva la aprobación.

**a) Plantillas recurrentes** — `server/src/finance/expenses.ts:166-170` y `192-193`
`toPending` solo mira `amountChanged`. Un Contable puede, sobre una plantilla **aprobada**:
- cambiar `frequency/interval/weekdays/monthDay/startsOn/endsOn`: mensual de $5 000 → diaria de $5 000. `ruleChanged`
  borra y regenera, `generateOccurrences` crea ~35 ocurrencias que **nacen aprobadas** (`schedule.ts:113`) y él mismo
  las puede pagar (`/expenses/:id/pay` no exige aprobador). 30× el gasto aprobado sin que nadie apruebe nada.
- cambiar `vendor` (p. ej. "Landlord LLC" → "Servicios Contables Pérez") y `payMethod`; `syncFuture` (línea 120) lo
  copia a todas las ocurrencias futuras, que siguen aprobadas.
- reanudar (`status: 'active'`) una plantilla que el Admin pausó.

**b) Gastos** — `expenses.ts:315-320`
Sobre un gasto aprobado, el Contable cambia `vendor`, `categoryId`, `dueDate`, `payMethod`, `reference` o `fileId` sin
volver a aprobación.

**c) Pago** — `expenses.ts:366-378`
`paidAmount` es libre (hasta 10 M por el contrato) y no pasa por aprobación: un gasto aprobado de $100 se marca
"pagado $9 999 999". `reopen` (líneas 395-403) + `pay` permite repetirlo. El resumen (`summary.ts:204`) suma
`paid_amount`, así que el reporte que mira el dueño queda falseado.

**Escenario completo:** Admin aprueba "Software · $49 · mensual". El Contable cambia el proveedor a una empresa propia y
la frecuencia a diaria; aparecen ~35 gastos aprobados de $49 a su proveedor; los marca pagados con montos de $4 900. Nada
llega a la bandeja de aprobación (`pendingApprovals` sigue en 0).

**Corrección sugerida:** para quien no es aprobador, pasar a `pending` cuando cambie cualquier campo material: monto,
proveedor, método de pago, categoría, regla (frecuencia, intervalo, días, inicio/fin) y la reanudación de una pausada;
en gastos, monto, proveedor, método, vencimiento. En `pay`, si quien paga no es aprobador y `paidAmount ≠ amount`
(o supera una tolerancia definida por producto), rechazar con 409 o dejar el gasto pendiente de aprobación. En `reopen`
de un gasto pagado por un Contable, dejarlo `pending` de aprobación. Añadir pruebas de "Contable cambia X → queda por
aprobar" por cada campo.

## F3 · Medio · Comprobantes y estados de cuenta visibles para cualquier miembro

**Dónde:** `server/src/files/routes.ts:80-81` — la descarga permite cualquier archivo con `f.context <> 'message'`.
La migración añadió los contextos `expense` y `bank_statement` (`0010_finance.sql:16-18`) sin restringir la descarga.

**Verificado en vivo:** con la sesión de `juan.jair@vfs.test` (rol `member`, que recibe 404 en todo `/finance`),
`GET /api/v1/w/vfs-prueba/files/<id>` devolvió **200** para dos estados de cuenta CSV (`text/csv`, 789 B) y un
comprobante (`image/png`).

**Escenario:** los ids son UUID v4 (no se adivinan), pero se filtran con facilidad: un Contable o Admin al que se le baja
el rol a Miembro conserva en su historial/red las URLs de todos los estados de cuenta y comprobantes que vio y los sigue
descargando; un enlace pegado en el chat lo abre cualquier miembro o invitado. Un estado de cuenta contiene todos los
movimientos bancarios de la agencia. Relacionado: `server/src/docs/routes.ts:140` deja adjuntar a un manual cualquier
archivo `ready` del workspace por id, incluidos estos (también requiere conocer el id).

**Corrección sugerida:** en la consulta de descarga, para `context in ('expense', 'bank_statement')` exigir rol
`owner/admin/accountant` y `finance_module` activo (además de, o en lugar de, `uploader_id = app_user()`); en
`docs/routes.ts:140` aceptar solo contextos `document`. Prueba: miembro/invitado → 404 sobre un comprobante.

## F4 · Medio · Aprobar una corrida aprueba lo que haya en ese instante

**Dónde:** `server/src/finance/payroll.ts:420-425` — `approve` llama a `recalcRun` y congela el resultado.

**Escenario:** el Admin abre la corrida, revisa netos y, mientras tanto, el Contable añade un ajuste "Bono" de $8 000 a
una persona, sube un componente de sueldo (o enlaza su propia persona a un usuario con comisiones). El Admin pulsa
"Aprobar" sobre la pantalla vieja: el servidor recalcula y congela los valores nuevos, que el Admin nunca vio. Como el
Contable puede pagar una corrida aprobada, el ciclo se cierra sin revisión real.

**Corrección sugerida:** que el cliente envíe en `approve` lo que vio (`expectedNet` y número de líneas, o una versión /
hash de las líneas) y responder 409 si no coincide tras recalcular; o no recalcular en `approve` y exigir que el borrador
no haya cambiado desde el último cálculo (columna `updated_at` en `payroll_runs` que toquen ajustes, horas y componentes).

## F5 · Bajo · Generación masiva de ocurrencias desde fechas antiguas

**Dónde:** `shared/contracts/src/finance.ts:95` (`startsOn: Day` sin mínimo) + `server/src/finance/schedule.ts:107-115`.
`z.iso.date()` acepta `1900-01-01`; la primera pasada genera desde `startsOn` hasta hoy + 35.

**Escenario:** el Owner de una agencia de prueba (registro abierto) crea plantillas diarias con `startsOn: 1900-01-01`:
~46 000 filas en `expenses` por petición, repetible → crecimiento de la BD y peticiones largas que retienen conexiones.

**Corrección sugerida:** limitar `startsOn` (p. ej. ≥ hoy − 1 año) en el contrato o en el backend, y/o generar como
máximo N ocurrencias atrasadas por plantilla.

## F6 · Bajo · Desbordes numéricos devuelven 500 (y disparan la alerta)

- `payroll.ts:312`: `hours` hasta 1 000 × tarifa `hourly` hasta 10 M = 1e10 > máximo de `numeric(12,2)`
  (9 999 999 999,99). Igual con muchos ajustes o componentes de 10 M en una línea. Error `22003` → 500 +
  `alert()` a Telegram en cada intento.
- `shared/contracts/src/finance.ts:86`: `position: z.number().int()` sin rango → `integer out of range` → 500.

**Corrección sugerida:** topes coherentes (tarifa por hora ≤ 10 000, `position` entre 0 y 10 000, número de ajustes por
persona) y traducir `22003` a 400 en `errorHandler`.

## F7 · Bajo · Un Admin aprueba su propia nómina

**Dónde:** `payroll.ts:420-425`. El ADR dice "nadie aprueba su propia nómina"; el código solo impide aprobar al Contable.
Un Admin enlazado como persona de nómina (`payroll_people.user_id`) puede añadirse un ajuste y aprobar la corrida.

**Corrección sugerida (decisión de producto):** si la corrida tiene una línea cuya persona es el aprobador, exigir que
apruebe otro Admin u Owner (con excepción explícita para el Owner único), o al menos registrarlo en la auditoría.

## F8 · Info · `sendCsv` y fórmulas

`server/src/platform/http.ts:21`: verificado en Node —
`-1+cmd|/C calc!A0` → `'-1+cmd|…` (neutralizado) · `-2.5e3` → `'-2.5e3` (neutralizado) · `-230.00` → sin prefijo ·
`-1\n=1+1` → neutralizado (en JS `$` sin bandera `m` no casa antes de `\n`). El cambio es correcto.
Pendiente heredado: una celda que empieza con `\n` (`"\n=1+1"`) no se prefija. En finanzas no es alcanzable (zod hace
`trim()` y el import colapsa espacios), pero conviene añadir `\n` a la clase `[=+\-@\t\r\n]`.

## F9 · Info · Datos sensibles en auditoría y alertas

- `expenses.ts:333` guarda el body completo (notas incluidas) en `audit_log.meta`; `payroll.ts:181` y `206` guardan
  montos de sueldo/porcentajes; `payroll.ts:427`, totales de nómina. Son datos que solo deberían ver finanzas y quedan
  visibles para el superadmin. Aceptable, pero conviene registrarlo en la política de datos o guardar solo los campos
  cambiados sin valores de sueldo.
- `http.ts` `errorHandler` envía `err.message` a Telegram; con el código actual no lleva valores de negocio (las
  violaciones de check solo nombran la restricción), pero cualquier error de pg nuevo con `invalid input … "valor"` lo haría.
- No hay `console.log` de personas, cuentas ni montos en `server/src/finance/*` (el job solo registra el mensaje de error).

## F10 · Info · Menores

- `GET /finance/expense-categories` inserta categorías si no hay ninguna (`expenses.ts:43-49`): efecto en un GET. Inocuo
  (idempotente, sin datos del usuario), pero ya existe `seedFinanceCategories` al activar el módulo.
- El Contable puede deshacer pagos de una corrida `paid` (`payroll.ts:449-471` con `paidAt: null`) y volver a pagarla
  con otra fecha/referencia. Coherente con "el Contable paga", pero no requiere aprobación; queda en auditoría.
- Los FK cruzados inválidos (`carrierId` de otra agencia en import/movimientos) los rechaza la BD con 400
  `invalid_reference` genérico (sin fuga de información).

---

## Verificado sin hallazgos

**Aislamiento multi-tenant**
- Las 13 tablas tienen RLS activa y política `tenant` (comprobado en `pg_class`/`pg_policies` de la BD local) y `grant`
  a `agencia_app`.
- FK compuestas `(workspace_id, …)` en todas las referencias: categoría, plantilla, archivo, miembros
  (`approved_by`, `created_by`, `updated_by`, `imported_by`, `user_id`), calendario, persona, corrida, cuenta, estado de
  cuenta y compañía (`carriers`). `bank_csv_mappings` usa PK `(workspace_id, account_id)`.
  `unique (schedule_id, due_date)` y `unique (run_id, person_id)` no llevan `workspace_id`, pero los ids ya son únicos
  globalmente y el padre está protegido por FK compuesta.
- Todas las consultas de `server/src/finance/*` corren por `tx(req, …)`; ningún uso de `adminPool` salvo el job.
- Job de recurrencias (`schedule.ts:123-148`): `adminPool` solo para el candado y la lista de agencias; la generación va
  por `withWorkspace({ workspaceId })` una agencia a la vez, con RLS. Candado `pg_try_advisory_lock` + bandera
  `running` + `for update` de las plantillas + `on conflict do nothing`: dos pasadas o un PATCH simultáneo no duplican.
- Ids del body validados contra el workspace: `categoryId` (`checkCategory`), `fileId` (`checkFile`/`loadCsvFile`:
  contexto correcto + `ready` + RLS), `accountId` (`oneAccount`), `calendarId` (`oneCalendar`/`checkPersonRefs`),
  `userId` (`checkPersonRefs` + FK), `personId` de ajustes (debe tener línea en la corrida), `lineIds` (conteo contra la
  corrida), `carrierId` y `statementId` (FK compuesta / filtro bajo RLS), ajuste y línea por `run_id`.

**Autorización**
- Guardián de `/finance` (`routes.ts:13-18`): verificado en vivo, un `member` recibe 404 en `/finance/expenses`,
  `/FINANCE/expenses`, `/Finance/bank/accounts`, `/finance%2Fsummary`, `/finance/expenses.csv` y
  `/files/../finance/summary`; el Owner recibe 200. Módulo apagado → 404.
- `approve`/`reject` de gastos y plantillas y `approve`/`reopen` de corridas exigen `requireApprover` (solo owner/admin).
- Un body con `approvalStatus`, `status` o `approvedBy` no tiene efecto: los esquemas zod no estrictos descartan claves
  desconocidas y ningún UPDATE usa esos campos del body (comprobado en vivo: PATCH con esos campos → solo 404 del recurso).
  El `status` del PATCH de plantillas está limitado a `active|paused`.
- Corrida aprobada o pagada: `PATCH`, horas, ajustes, recalcular y borrar exigen `lockRun(…, 'draft')` → 409.
  Aprobar dos veces → la segunda espera el candado y recibe 409.
- `ROLE_RANK.accountant = 1`: fuera de finanzas vale lo que un Miembro; no hay comparaciones `role === 'admin'` ni
  `>= lead` que lo favorezcan. Solo un Admin cambia roles o invita como Contable (`requireRole(req, 'admin')`), y solo un
  Owner toca a otro Owner. Encender/apagar el módulo exige Admin.

**Validación y montos**
- Todos los bordes con zod: `Money` positivo, ≤ 10 M y múltiplo de 0,01 (rechaza NaN, negativos e Infinity);
  `SignedMoney` distinto de 0; `Rate` ≤ 100; fechas `z.iso.date()`; textos con tope y `trim`; listas acotadas
  (`lineIds` ≤ 500, `carriers` ≤ 5 000, `weekdays` ≤ 7); `CsvMapping` con columnas ≤ 100 y `skipRows` ≤ 50.
  En la BD, checks de positivo y `net = gross - deductions`.
- CSV: 2 MB (tamaño declarado = tamaño verificado con HEAD al completar la subida), 5 000 filas, montos ≤ 10 M,
  fechas 1990–2100. `ilike` del proveedor escapa `\ % _`; la búsqueda de movimientos usa `position()`.

**Concurrencia**
- Pagar un gasto dos veces: `for update` + verificación `status = 'pending'`. Pagar líneas: `for update` de la corrida y
  condición `paid_at is null` en el UPDATE.
- Commit de importación duplicado: `for update` de la cuenta antes de leer las claves; el segundo commit del mismo
  archivo encuentra todo duplicado y responde `nothing_to_import`.

**Archivos y frontend**
- Lectura desde MinIO con URL prefirmada de 60 s generada en el servidor; nunca se expone al cliente.
  Descarga con `content-security-policy: … sandbox` (aplica a comprobantes PDF/imagen/SVG).
- Sin `v-html`, `innerHTML` ni `document.write` en `web/src/finance/*`, `SettingsPage.vue`, `InvitePanel.vue`; las
  descripciones del banco, notas y nombres se interpolan como texto. El recibo imprimible (`PayrollReceipt.vue`) usa
  `window.print()` sobre el mismo DOM, con interpolación de texto; enlaces con `rel="noopener"` y URLs del servidor.
- Finanzas no emite eventos por WebSocket ni push.

---

## Estado de las correcciones

_2026-10-12 · rama `feat/finanzas` · **commit pendiente** (cambios en el árbol de trabajo, sin commit ni push)._

| # | Estado | Qué se hizo |
|---|---|---|
| F1 | Corregido | `csv.ts`: regex del monto sin ambigüedad (`/^\d*(\.\d*)?$/`); con punto y coma mezclados, el separador decimal (el último) debe aparecer una sola vez o el monto es `null`; `parseCsvAmount` y `parseCsvDate` devuelven `null` si la celda pasa de 32 caracteres; `parseCsv` corta cada celda a 1 000 caracteres y cada registro a 200 celdas (también evita el `cell.trim()` cuadrático con muchas comillas). Revisadas el resto de regex de `csv.ts` y `bank.ts`: ancladas o acotadas, sin backtracking cuadrático. Prueba: celda de 40 000 caracteres en < 50 ms y encabezado de 2 M comas en < 1 s. |
| F2 | Corregido | `expenses.ts`: un no aprobador que cambia monto, proveedor, categoría, vencimiento, método o concepto de un gasto aprobado lo deja `pending`; en plantillas, además regla (frecuencia, intervalo, días, día del mes, solo hábiles, inicio, fin) y reanudar una pausada. Pendiente → no se propaga a las ocurrencias (`syncFuture`) ni genera nuevas hasta aprobar. `pay` de un no aprobador con `paidAmount` ≠ monto aprobado → 409 `paid_amount_differs`. Pruebas por campo. |
| F3 | Corregido | `files/routes.ts`: contextos `expense` y `bank_statement` solo para owner/admin/accountant con `finance_module` activo (sin excepción para quien lo subió). Pruebas: miembro e invitado → 404; módulo apagado → 404 también para Owner/Contable. `server/src/docs/routes.ts`: un manual ya no acepta adjuntos de contexto `expense` ni `bank_statement` (orquestador, 2026-10-12). |
| F4 | Corregido | `PayrollRunDetail.version` (huella sha256 de las líneas); `POST …/runs/:id/approve` exige `{ version }` (contrato `ApprovePayrollRunBody`) y, si tras recalcular no coincide, responde 409 `run_changed` sin aprobar. `PayrollRunView.vue` envía la versión y, ante 409, recalcula, muestra lo actual y avisa. Prueba: bono añadido entre la revisión y la aprobación → 409. |
| F5 | Corregido | `startsOn` no anterior a hoy − 366 días (400 `starts_too_early`, en alta y al cambiarlo); el generador crea como máximo 400 ocurrencias por plantilla y pasada y deja `generated_until` en la última creada (la siguiente pasada continúa). Prueba con diaria desde hoy − 366 (402 fechas: 400 + 2). |
| F6 | Corregido | `recalcRun` rechaza con 400 `amount_out_of_range` una línea cuyo bruto, deducciones o neto pasen de 9 999 999 999,99; `position` de categorías entre 0 y 10 000 en el contrato. Pruebas: 1 000 h × 10 M → 400; `position` 2³¹ → 400. |
| F7 | Aceptado por Rodrigo (2026-10-12) | Un Owner/Admin puede aprobar una corrida con su propia línea; registrado en el ADR 0007. |
| F8–F10 | Sin cambios | Fuera de alcance de esta tanda. |
