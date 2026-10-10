# Plan · Módulo de ventas y comisiones

_Borrador para aprobación de Rodrigo · 2026-10-10. No se escribe código hasta su visto bueno. Producción espera a este módulo._

Pedido por VFS. Kora sigue siendo multi-rubro, así que el módulo se **activa por agencia** (lo trae activado la
plantilla de Seguros) y las compañías, productos y alias son configurables; nada de VFS queda fijo en el código.

Decisiones tomadas el 2026-10-10:

| Tema | Decisión |
|---|---|
| Origen de las ventas | Canal `#ventas` del Discord de VFS (lo escribe el agente) **+** modal de carga manual |
| Monto | El monto del mensaje es el **monto ISSUE**: la prima anual de la póliza. Base de toda comisión |
| Pago | **75 %** (9 meses adelantados) en la fecha de ISSUE · **25 %** restante a los **12 meses** del ISSUE |
| Override | **Un solo nivel**: el dueño de agencia cobra (su % − % del agente) × monto, con el mismo reparto 75/25 |
| Porcentajes | **Nivel de contrato FFL** del agente (80, 85, 100, 105…) × **tabla de comisiones** del producto (guía IUL de FFL); ambos con fecha de vigencia (ajuste del 2026-10-10) |
| Visibilidad | Agente: lo suyo · Dueño de agencia: lo suyo y lo de sus agentes directos · Owner/admin: todo, y son los únicos que cargan porcentajes y ventas a mano |

---

## 1. El mensaje de Discord

Formato real (canal `#ventas`, 8-9 oct 2026):

```
$1200  NLG IUL Upon issue NY (Danielle Cardenas)
$1199.88 Americo IUL 10/23 OK (Jose Gonzalez Valdez)
$1800 FEX AMÉRICO UPPON ISSUE(Norma Salgado)
$960 MOO IUL Upon Issue CA (Vilma)
```

| Pieza | Regla del lector |
|---|---|
| Monto | `$` + número; acepta comas y decimales |
| Compañía y producto | En **cualquier orden**, sin importar mayúsculas ni acentos, por **alias** configurables: `NLG` → National Life Group, `MOO` → Mutual of Omaha, `Americo`/`Américo` → Americo · `IUL`, `FEX` |
| Cuándo | `upon issue` / `uppon issue` → ISSUE inmediato al aprobarse. `MM/DD` (o `MM/DD/YY`) → fecha del primer pago; sin año se toma la próxima fecha a partir del día del mensaje |
| Estado | Código de 2 letras (`NY`, `OK`, `CA`); opcional, se valida contra los 50 estados + DC |
| Cliente | Lo que está entre paréntesis. Se guarda aparte porque se usará en otra función |
| Agente | El autor del mensaje en Discord, enlazado a su cuenta de Kora (ver §3) |

Si al lector le falta una pieza (compañía desconocida, sin monto, autor sin enlazar), la venta **no se pierde**: entra a
una **bandeja de revisión** con el mensaje original para que un admin la complete o la descarte.

**Conexión:** un bot de Discord de VFS con permiso de leer `#ventas` (y el *Message Content Intent* activado). Kora
consulta el canal **cada minuto** por el API REST de Discord con `fetch`, guardando el último mensaje leído; no hace
falta ninguna dependencia nueva. Al conectarlo se puede importar el historial desde una fecha. El token del bot va en
una variable de entorno del servidor, nunca en la BD ni en la web. Un mensaje editado o borrado en Discord después de
leído **no** cambia la venta: se corrige en Kora.

## 2. Ciclo de una venta

```
Registrada ──(admin confirma que la compañía la aprobó / el cliente pagó)──▶ ISSUED ──▶ comisiones generadas
     │                                                                     
     └──▶ Rechazada / Cancelada (sin comisión)
```

- "Upon issue" queda con fecha esperada = día del mensaje; con fecha (`10/23`) queda con esa fecha esperada.
- La venta pasa a **ISSUED** cuando un admin lo marca, con la fecha real de ISSUE (por defecto la esperada). Kora
  **no** la marca sola al llegar la fecha, porque el pago puede no ocurrir; en cambio, muestra la lista
  **"ISSUE pendiente"** con las ventas cuya fecha ya pasó.
- Al marcar ISSUED se generan las cuotas de comisión, **congelando el porcentaje vigente** ese día: cambiar un % más
  tarde no altera comisiones ya generadas.

**Ejemplo** · venta de $1,200 de Ana (70 % en NLG IUL), dueña de agencia Carlos (90 % en NLG IUL), ISSUE el 15/10/2026
(los % salen del nivel de cada uno en la tabla del producto):

| Quién | Tipo | Base | Total | 15/10/2026 (75 %) | 15/10/2027 (25 %) |
|---|---|---|---|---|---|
| Ana | Directa | 70 % × 1,200 | 840 | 630 | 210 |
| Carlos | Override | (90 − 70) % × 1,200 | 240 | 180 | 60 |

Si el % del dueño es **menor o igual** al del agente, el override es 0 y la venta se marca con un aviso. Si al agente (o al dueño)
le falta el nivel, o la tabla del producto no tiene ese nivel, la venta no pasa a ISSUED hasta cargarlo (aviso claro).

Cada cuota tiene estado **Por cobrar → Pagada** (un admin la marca, con fecha). Así VFS ve qué le deben a cada agente
este mes y el año que viene.

## 3. Datos (migración 0007)

Todas con `workspace_id`, RLS `tenant`, grant a `agencia_app` y FK compuestas, como el resto (ADR 0001).

| Tabla | Para qué |
|---|---|
| `carriers` | Compañías: nombre, alias para el lector, archivada |
| `carrier_products` | Productos de cada compañía (IUL, FEX…) con sus alias |
| `agent_profiles` | Por miembro: **dueño de agencia directo** (`upline_user_id`, un nivel), **ID de Discord** del agente |
| `agent_levels` | Nivel de contrato del agente desde una fecha (un ascenso = fila nueva) |
| `comp_grid` | Tabla de cada producto: nivel → %, por revisión (`effective_from`) |
| `sales` | Agente, compañía, producto, monto ISSUE, cliente, estado (US), fecha esperada, fecha ISSUE real, estado de la venta, origen (`discord`/`manual`), ID del mensaje de Discord (único: no se duplica) |
| `sale_inbox` | Mensajes de Discord que el lector no pudo completar, con el texto original y lo que sí entendió |
| `commission_installments` | Cuotas generadas: beneficiario, tipo (`direct`/`override`), % congelado, monto, fecha de pago, estado y fecha de pagado |

Dinero en `numeric(12,2)`, porcentajes en `numeric(6,3)` (pueden pasar de 100 %, como en IUL).

## 4. Pantallas

Nueva sección **Ventas** en el sidebar (solo si el módulo está activo):

1. **Ventas**: tabla con filtros por agente, compañía, producto, estado y rango de fechas; totales arriba (vendido, issued,
   pendiente). Botón **Registrar venta** (modal manual) para owner/admin. Acción **Marcar ISSUED** / **Cancelar**.
2. **ISSUE pendiente**: ventas con fecha esperada vencida, para que la oficina las revise.
3. **Comisiones**: por agente y por mes; separa "Por cobrar este mes", "Próximos 12 meses" y "Pagadas". El agente ve solo
   las suyas; el dueño de agencia ve además los overrides y las ventas de sus agentes.
4. **Bandeja de Discord**: mensajes sin completar, con el texto original al lado del formulario prellenado.

En **Ajustes → Comisiones** (owner/admin): compañías, productos, alias y la tabla nivel → % de cada producto · nivel de
contrato de cada agente · dueño de agencia de cada agente · enlace del usuario de Discord con cada miembro · estado de la
conexión con Discord y última lectura.

Exportación CSV de ventas y de comisiones del período, para que la oficina cuadre con las compañías.

## 5. Entregas

| Paso | Qué | Compuerta |
|---|---|---|
| A | Contrato + migración 0007 + cálculo de comisiones + API de ventas manuales y ajustes + pruebas | Reviso contigo el cálculo con ventas reales |
| B | Pantallas (Ventas, Comisiones, Ajustes) | Lo pruebas en local |
| C | Lector de Discord + bandeja de revisión, probado con los mensajes reales | Conectamos el bot al Discord de VFS |
| D | Despliegue en producción (lo que ya estaba planeado) | — |

Pruebas: el lector con los 4 mensajes reales y variantes con errores · el cálculo (directa, override, override en 0,
75/25, % congelado) · permisos (agente no ve lo de otros, dueño solo ve a sus agentes directos) · aislamiento entre
workspaces.

## 6. Chargebacks (confirmados 2026-10-10)

Sí existen. Al **cancelar** una venta ya ISSUED, el admin indica qué porcentaje de lo adelantado descontó la compañía
(por defecto 100 %; la pantalla sugiere el proporcional a los meses no ganados). Kora:
- anula las cuotas que aún no se pagaron (la del mes 12 normalmente);
- crea una cuota **negativa** de chargeback para el agente y otra para el dueño de agencia, sobre lo que ya se les
  pagó, que se descuenta en el siguiente pago (se marca pagada igual que las demás).

Cada agente que vende tendrá su cuenta en Kora (confirmado). Pendiente solo crear el bot de Discord en el paso C.

## 7. VFS (datos para la prueba y la puesta en marcha)

- Productos: **Americo Instant Decision**, **NLG Flex Life IUL** y **MOO IULE** (alias `IUL` en cada compañía); tablas
  de la guía IUL de FFL revisada el 08/19/2024.
- Dueña de agencia: **Lendry Labrador** (nivel 105); los otros 17 agentes, todos bajo ella. Niveles: 80 la mayoría,
  85 Nanishka y Yelitza, 100 Miguel Angel y Veronica.
- En Discord, "Maria V Salas" es Veronica V Salas Castillo.
- Las 3 ventas del 8-9 oct con producto válido quedaron como prueba automática (`server/test/sales.test.ts`).
