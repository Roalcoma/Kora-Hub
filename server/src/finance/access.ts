// Permisos dentro de finanzas: el Contable tiene poder de Admin salvo aprobar (gastos, plantillas y corridas de nómina).
import type { Request } from 'express';
import { HttpError } from '../platform/http.ts';

export const isApprover = (req: Request) => req.ws!.role === 'owner' || req.ws!.role === 'admin';
export function requireApprover(req: Request) {
  if (!isApprover(req)) throw new HttpError(403, 'forbidden', 'Solo un Owner o Admin puede aprobar');
}
