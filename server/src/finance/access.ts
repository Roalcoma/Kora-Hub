// Permisos dentro de finanzas, según el nivel de la persona en el módulo: «Ver» solo lee; «Editar» (lo del Contable por
// defecto) registra todo salvo aprobar; «Gestionar» (Owner, Admin o a quien se le dé) además aprueba gastos, plantillas y
// corridas de nómina.
import type { Request } from 'express';
import { HttpError } from '../platform/http.ts';
import { hasModule } from '../platform/workspace.ts';

export const isApprover = (req: Request) => hasModule(req, 'finance', 'manage');
export function requireApprover(req: Request) {
  if (!isApprover(req)) throw new HttpError(403, 'forbidden', 'Solo un Owner o Admin puede aprobar');
}
