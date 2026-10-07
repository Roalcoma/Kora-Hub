# ADR 0002 · TypeScript nativo en Node y contrato con zod compartido

**Estado:** aceptada · 2026-10-07

## Decisión
- El backend corre `.ts` directamente con Node ≥ 22.18 (type stripping), sin paso de build ni `tsx`.
  Solo sintaxis borrable (`erasableSyntaxOnly`): nada de `enum`, `namespace` ni parameter properties. Imports con `.ts`.
- `shared/contracts` es un workspace npm (`@agencia-hub/contracts`) que exporta **esquemas zod** para toda entrada
  y **tipos** para las respuestas, más el mapa `Routes` (`'MÉTODO /ruta': { body, query, res }`) y los eventos WS.
  El backend valida con los mismos esquemas que el frontend usa en sus formularios.
- zod 4 (`z.email()`, `z.uuid()`, `z.iso.datetime()`).

## Consecuencias
- Un cambio de contrato rompe el `typecheck` de ambos lados: así se detecta antes de integrar.
- Solo el arquitecto edita `shared/contracts`.
