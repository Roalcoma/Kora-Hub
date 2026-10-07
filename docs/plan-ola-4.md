# Plan de la Ola 4 · SaaS y lanzamiento

_Borrador para aprobación de Rodrigo · 2026-10-07. No se escribe código hasta su visto bueno._

Decisiones tomadas el 2026-10-07:

| Tema | Decisión |
|---|---|
| Alcance | Kora sirve a **cualquier tipo de agencia** y se generaliza dentro de esta ola, antes de la landing |
| Stripe | **Simulado**: no hay cuenta todavía. Se programa contra el API real de Stripe y se prueba con webhooks firmados en las pruebas y un checkout falso en local |
| Despliegue | Piloto en el **servidor 192.168.0.123** con Docker Compose y el Cloudflare Tunnel que ya existe |
| Dominio | **`kora.arbolaureo.org`** (confirmado 2026-10-07), igual que `rocco.arbolaureo.org` |

Objetivo de la ola: **Kora queda en línea con HTTPS en el servidor**. Una agencia de cualquier rubro se registra desde la
landing, prueba 14 días, ve su facturación y sus avisos de plan, y Rodrigo la administra desde un backoffice. Con HTTPS
ya se puede cerrar la compuerta pendiente de la Ola 2, que es probar push en el iPhone real.

---

## 1. Generalizar a cualquier agencia

**Qué cambia para el usuario**
- Al registrarse elige el rubro: **Seguros**, **Marketing**, **Inmobiliaria**, **Viajes** o **En blanco**. Cada plantilla
  trae departamentos, categorías y colores sugeridos que la agencia puede cambiar después.
- La "línea de negocio" pasa a ser una **categoría** opcional, y cada agencia decide cómo llamarla: "Línea", "Producto",
  "Sede", "Cliente"… El nombre aparece en el sidebar, los filtros y los formularios. Si la agencia no tiene categorías, el
  selector se oculta, como ya ocurre hoy.
- El color de cada categoría se elige de una **paleta fija** de 8 colores con buen contraste, usando `Dropdown`.
- Los textos quedan **neutros**: los ejemplos con "pólizas" y "Medicare" se reemplazan por ejemplos genéricos. Los avisos
  de PHI/HIPAA solo aparecen en las agencias de seguros.

**Plantillas** (`server/src/platform/template.ts`)

| Rubro | Departamentos | Categoría · valores |
|---|---|---|
| Seguros | Ventas, Servicio al cliente, Renovaciones, Administración | Línea · Salud, Vida, Medicare |
| Marketing | Cuentas, Creatividad, Medios, Administración | Cliente · (vacío, la agencia los agrega) |
| Inmobiliaria | Ventas, Alquileres, Administración | Sede · Principal |
| Viajes | Ventas, Operaciones, Atención al viajero, Administración | Producto · Vuelos, Paquetes, Cruceros |
| En blanco | — | Categoría · — |

**Técnica**
- No cambia el esquema. `workspaces.settings` (jsonb) gana `industry` y `categoryLabel: { singular, plural }`, y
  `RegisterBody.workspace.template` amplía su enum. Este cambio de contrato lo hace el `arquitecto`.
- En i18n, los textos usan `{category}` interpolado en vez de "Línea" fijo.
- Los nombres internos siguen igual (`business_lines`, `lineId`): solo cambia lo que se ve.

## 2. Facturación (Stripe simulado)

**Reglas de negocio** (PLAN §3.4 y §3.5)
- Prueba gratis de 14 días con todo incluido. Planes **Estándar a $6** y **Pro a $9** por usuario activo al mes. Los
  precios siguen siendo supuesto del ADR 0003.
- Cuenta como **usuario activo** todo miembro activo que no sea invitado. Cuando cambia el número de miembros, se
  actualiza la cantidad en la suscripción (job `billing.sync_seats`, con prorrateo de Stripe).
- Ciclo de estados que se aplica en el servidor:

```
trialing ──(paga)──────────────────────────────▶ active
trialing ──(vence la prueba sin pagar)─────────▶ read_only
active ──(falla un cobro)──▶ past_due ──(7 días)──▶ read_only ──(30 días)──▶ suspended
past_due / read_only / suspended ──(paga)──────▶ active
```

  En **solo lectura** se puede entrar y exportar, pero no escribir. Ese bloqueo ya existe en `workspace.ts`.
  **Nunca se borran datos.**

**Backend** (`backend-plataforma`)
- Stripe se llama con `fetch` al API REST y la firma del webhook se verifica con HMAC de `node:crypto`. **No se agrega el
  SDK de Stripe**, igual que se hizo con S3/SigV4.
- `POST /w/:slug/billing/checkout` y `POST /w/:slug/billing/portal` quedan solo para el Owner. Se agrega
  `GET /w/:slug/billing` con plan, estado, días de prueba, puestos y costo estimado.
- `POST /webhooks/stripe` corre por el `adminPool`, verifica la firma, es idempotente con `stripe_events` y maneja
  `checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.paid` e `invoice.payment_failed`.
- Job diario `billing.lifecycle`: vencimiento de la prueba, fin de la gracia y suspensión. Avisa al Owner por email y en
  la app 3 días y 1 día antes.
- **Modo simulado**: si `STRIPE_SECRET_KEY` está vacío, el checkout redirige a una página local que dice "Pago simulado"
  y, al confirmar, dispara el mismo manejador interno de eventos. Cuando abras la cuenta de Stripe solo se llenan las
  llaves y los `price_id`; el código no cambia.

**Frontend** (`frontend-modulos`)
- Nueva pestaña **Ajustes → Facturación**: tarjeta del plan actual con estado y días restantes, comparativa Estándar/Pro
  con tarjetas hermanas simétricas, puestos y costo estimado, y botones "Elegir plan" y "Administrar pago".
- **Banda de aviso** en el shell según el estado: prueba por vencer, pago fallido, solo lectura o suspendida. Lleva texto
  sobre naranja en `--color-ink` y el Owner ve el botón para pagar.

## 3. Backoffice de superadmin

- El acceso lo da la tabla `platform_admins`, que ya existe. Se agrega `ops/make-admin.ts <email>` para darte acceso.
- Rutas `/admin/*` (ya están en el contrato), todas con `adminPool` y validadas contra `platform_admins`:
  - Lista de agencias con rubro, plan, estado, miembros, almacenamiento, MRR y fecha de alta. Se puede buscar y filtrar
    por estado.
  - Suspender o reactivar.
  - **Impersonar** con un motivo obligatorio. Abre una sesión de 30 minutos marcada como impersonación (claim `imp` en el
    JWT), muestra una banda roja "Estás viendo como X" con botón para salir y queda en `audit_log`. Un usuario con 2FA
    obligatorio no se puede impersonar sin que tú tengas 2FA activado.
  - Métricas: MRR, agencias activas, en prueba, altas y bajas de 30 días.
- Pantalla `/admin` fuera del shell de agencia, con el mismo design system.

## 4. Landing y textos legales

- Carpeta `landing/` con HTML y CSS estáticos que usan los tokens del design system. Sin framework, para que cargue
  rápido y sea fácil de editar.
- Secciones: héroe con captura real de la app, módulos, "para cualquier agencia" con los rubros, precios con tarjetas
  simétricas, instalación en el iPhone, preguntas frecuentes y botón "Prueba 14 días".
- Bilingüe es/en con un selector de idioma.
- **Términos de servicio** y **Política de privacidad** en borrador, es/en. Incluyen la regla "no PHI durante el piloto"
  para el rubro seguros. Son borradores para que los revise un abogado antes de cobrar.
- Se respetan tus reglas de diseño: profundidad, asimetría, sin huecos a 1600 px, esquinas rectas y Plus Jakarta Sans.
  Primero hago un **mockup para que lo apruebes** y después lo construyo.

## 5. Despliegue del piloto (`devops`)

**En el repo**
- `Dockerfile` multi-etapa: compila la web y la imagen final corre Node 22 con el servidor, que sirve `web/dist` con
  fallback de SPA y la landing.
- `ops/compose.prod.yml` con app, Postgres 16 y MinIO. Los puertos **no** se publican al host: el túnel entra por la red
  de Docker.
- Las migraciones corren al arrancar y el contenedor tiene healthcheck.
- **Backups**: `pg_dump` diario más copia de MinIO, cifrados con `openssl` y una clave que guardas en Vaultwarden,
  retención de 14 días y un script de **prueba de restauración**.
- **Alertas a Telegram**: errores 5xx, jobs fallidos, webhooks rechazados, resultado del backup y caída del healthcheck.
  Se reutiliza el bot que ya envía las alertas de Rocco, en un chat aparte si prefieres.
- `docs/despliegue.md` con la guía para el servidor y para el VPS futuro con BAA.

**En el servidor** (cada paso con tu confirmación; no se toca nada de lo que ya corre)
1. Crear `~/infra/kora/` con `.env` en permisos 600 y secretos nuevos.
2. `docker compose up` y conectar el contenedor de la app a la red del túnel, como se hizo con n8n.
3. Agregar los hostnames `app.<dominio>` y `<dominio>` (o `kora.<dominio>`) en el túnel de Cloudflare. Ese túnel se
   configura de forma remota: lo haces tú en el panel o me das un token con permiso limitado.
4. SMTP de producción para invitaciones y recuperación de contraseña (ver §8).
5. Probar push en tu iPhone con la PWA instalada, lo que **cierra la compuerta de la Ola 2**.

## 6. Calidad y seguridad

- **Antes de abrir al público**, el agente `seguridad` revisa las Olas 0 a 4. Es la revisión que quedó pendiente y
  bloquea el despliegue. Los hallazgos críticos se corrigen antes de exponer la app.
- Pruebas nuevas (`qa`):
  - Firma de webhook válida e inválida, idempotencia y cada transición del ciclo de estados.
  - Solo lectura bloquea la escritura.
  - Solo el Owner abre el checkout; un usuario que no es superadmin recibe 403 en `/admin`.
  - La impersonación queda auditada y expira.
  - Plantillas y nombre de la categoría.
  - Aislamiento entre agencias en facturación.
- Prueba manual en escritorio a 1600 px y en teléfono a 390 px de las pantallas nuevas y la landing.
- `ops/seed-demo.ts` se actualiza para sembrar también una agencia de otro rubro.

## 7. Orden de trabajo

| Paso | Agentes | Entrega |
|---|---|---|
| 1 | arquitecto | Contrato v2 (plantillas, `industry`, `categoryLabel`, `GET /billing`, claim de impersonación) y ADR 0005 de facturación |
| 2 | backend-plataforma · frontend-modulos · devops (en paralelo) | Generalización + facturación + superadmin · pantallas + mockup de landing · Dockerfile, compose de producción, backups y alertas |
| 3 | frontend-modulos | Landing y textos legales, después de que apruebes el mockup |
| 4 | qa · seguridad | Pruebas y revisión de las Olas 0 a 4 |
| 5 | devops + Rodrigo | Despliegue en el servidor, paso a paso con confirmación, y prueba en iPhone |

Commits pequeños en español y **sin push** hasta que lo pidas.

## 8. Lo que necesito de ti

1. ~~Dominio~~: resuelto, `kora.arbolaureo.org`.
2. **SMTP de producción**: propongo **Brevo gratis** (300 correos al día, sobra para el piloto). Otra opción es Gmail con
   contraseña de aplicación.
3. **Telegram**: ¿reutilizo el bot de Rocco y su chat, o prefieres un chat aparte?
4. **Precios**: ¿confirmas $6 y $9 por usuario, o los ajustas ahora que el producto ya no es solo para seguros?

## Fuera de esta ola (va a la Ola 5 o a deuda)

- **Landing (§4): pospuesta por decisión de Rodrigo (2026-10-07).** La marca paraguas es Árbol Áureo y, cuando se haga, será una
  landing de Árbol Áureo con sus tres productos (Rocco CRM, Vitrina APP y Kora Hub), no una landing propia de Kora.
  Queda de referencia el mockup `docs/diseño/landing-mockup.html` y la landing existente en `~/crm/landing`.

- Exportación completa de datos al darse de baja (`POST /export`) y borrado a los 30 días.
- Crear una segunda agencia desde el riel con la misma cuenta.
- Bus de tiempo real y rate-limit con Postgres para varias instancias. El piloto usa una sola.
- Migrar a un VPS con BAA antes de vender a agencias de salud.
