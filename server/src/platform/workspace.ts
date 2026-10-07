// Middleware `/w/:slug`: valida membresía activa y deja el contexto de tenant en la petición.
// El workspace_id sale SIEMPRE de aquí (sesión + slug), nunca del body ni del query.
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import type { Role } from '@agencia-hub/contracts';
import { withWorkspace } from '../db.ts';
import { HttpError } from './http.ts';
import { ROLE_RANK } from './model.ts';

type WsCtx = { id: string; slug: string; role: Role; status: string };
declare module 'express-serve-static-core' {
  interface Request { ws?: WsCtx }
}

export async function workspaceContext(req: Request, _res: Response, next: NextFunction) {
  const { rows } = await withWorkspace({ workspaceId: null, userId: req.userId! }, (db) =>
    db.query(
      `select w.id, w.slug, w.status, m.role from workspaces w
       join workspace_members m on m.workspace_id = w.id and m.user_id = app_user() and m.is_active
       where w.slug = $1`,
      [req.params.slug],
    ));
  // Mismo 404 si no existe o si no soy miembro: no revela qué agencias existen
  // La impersonación solo abre el workspace impersonado
  if (!rows[0] || (req.imp && rows[0].id !== req.imp.ws)) throw new HttpError(404, 'workspace_not_found', 'Espacio de trabajo no encontrado');
  const ws: WsCtx = rows[0];
  // Facturación siempre abierta: es la única salida del bloqueo (pagar)
  const billing = req.path === '/billing' || req.path.startsWith('/billing/');
  if (ws.status === 'suspended' && !billing && !(req.method === 'GET' && req.path === '/')) {
    throw new HttpError(403, 'workspace_suspended', 'Este espacio de trabajo está suspendido');
  }
  if (ws.status === 'read_only' && !billing && req.method !== 'GET') {
    throw new HttpError(403, 'workspace_read_only', 'Este espacio de trabajo está en solo lectura');
  }
  req.ws = ws;
  next();
}

/** Transacción con RLS fijada al workspace y usuario de la petición. */
export const tx = <T>(req: Request, fn: (db: pg.PoolClient) => Promise<T>) =>
  withWorkspace({ workspaceId: req.ws!.id, userId: req.userId! }, fn);

export function requireRole(req: Request, min: Role) {
  if (ROLE_RANK[req.ws!.role] < ROLE_RANK[min]) throw new HttpError(403, 'forbidden', 'No tienes permiso para esta acción');
}

export const isAdmin = (req: Request) => ROLE_RANK[req.ws!.role] >= ROLE_RANK.admin;

/** Admin del workspace o líder (`is_lead`) de ese departamento (§4): gestiona manuales, tareas y reportes. */
export async function canManageDept(db: pg.PoolClient, req: Request, departmentId: string): Promise<boolean> {
  if (isAdmin(req)) return true;
  const { rowCount } = await db.query(
    'select 1 from member_departments where user_id = app_user() and department_id = $1 and is_lead', [departmentId]);
  return !!rowCount;
}

/** Middleware: los módulos (manuales, tareas, metas) no son para invitados. */
export function membersOnly(req: Request, _res: Response, next: NextFunction) {
  requireRole(req, 'member');
  next();
}
