// Middleware `/w/:slug`: valida membresía activa y deja el contexto de tenant en la petición.
// El workspace_id sale SIEMPRE de aquí (sesión + slug), nunca del body ni del query.
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import { effectiveModules, ACCESS_RANK, type Role, type Module, type AccessLevel } from '@agencia-hub/contracts';
import { withWorkspace } from '../db.ts';
import { HttpError } from './http.ts';
import { ROLE_RANK } from './model.ts';

type WsCtx = { id: string; slug: string; role: Role; status: string; modules: Record<Module, AccessLevel> };
declare module 'express-serve-static-core' {
  interface Request { ws?: WsCtx }
}

export async function workspaceContext(req: Request, _res: Response, next: NextFunction) {
  const { rows } = await withWorkspace({ workspaceId: null, userId: req.userId! }, (db) =>
    db.query(
      `select w.id, w.slug, w.status, m.role, m.module_access from workspaces w
       join workspace_members m on m.workspace_id = w.id and m.user_id = app_user() and m.is_active
       where w.slug = $1`,
      [req.params.slug],
    ));
  // Mismo 404 si no existe o si no soy miembro: no revela qué agencias existen
  // La impersonación solo abre el workspace impersonado
  if (!rows[0] || (req.imp && rows[0].id !== req.imp.ws)) throw new HttpError(404, 'workspace_not_found', 'Espacio de trabajo no encontrado');
  const { module_access, ...rest } = rows[0];
  const ws: WsCtx = { ...rest, modules: effectiveModules(rest.role, module_access) };
  // Facturación siempre abierta: es la única salida del bloqueo (pagar)
  const billing = req.path === '/billing' || req.path.startsWith('/billing/');
  if (ws.status === 'suspended' && !billing && !(req.method === 'GET' && req.path === '/')) {
    throw new HttpError(403, 'workspace_suspended', 'Este espacio de trabajo está suspendido');
  }
  // En solo lectura se sigue leyendo en tiempo real: ticket del WebSocket y marcar como leído no son escrituras de negocio
  const readingAid = req.path === '/ws-ticket' || /^\/channels\/[^/]+\/read$/.test(req.path);
  if (ws.status === 'read_only' && !billing && !readingAid && req.method !== 'GET') {
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

/**
 * Condición SQL «esta persona ve lo de este departamento y línea» (tareas, metas, canales privados de departamento):
 * es del departamento y, o lo lidera, o lo visto no tiene línea, o ella no tiene líneas asignadas, o tiene esa línea.
 * Owners y Admins ven todo: eso lo decide quien la usa. Sirve también fuera de RLS (adminPool): todo cuelga del departamento.
 */
export const deptLineRule = (user: string, dept: string, line: string) => `exists (
  select 1 from member_departments md where md.user_id = ${user} and md.department_id = ${dept} and (md.is_lead
    or ${line} is null
    or not exists (select 1 from member_lines ml where ml.workspace_id = md.workspace_id and ml.user_id = md.user_id)
    or exists (select 1 from member_lines ml where ml.workspace_id = md.workspace_id and ml.user_id = md.user_id and ml.line_id = ${line})))`;

/** Lo que ve quien hace la petición: Admin todo; el resto según departamento y línea */
export const seesDeptLine = (req: Request, dept: string, line: string) => isAdmin(req) ? 'true' : deptLineRule('app_user()', dept, line);

/** Middleware: los módulos (manuales, tareas, metas) no son para invitados. */
export function membersOnly(req: Request, _res: Response, next: NextFunction) {
  requireRole(req, 'member');
  next();
}

// ─── Permiso por módulo (Ajustes → Miembros → Módulos) ───

/** ¿Tiene al menos ese nivel en el módulo? Owner/Admin siempre «manage» */
export const hasModule = (req: Request, m: Module, min: AccessLevel) => ACCESS_RANK[req.ws!.modules[m]] >= ACCESS_RANK[min];

/** Sin acceso al módulo: 404, como si no existiera. Con acceso pero sin el nivel pedido: 403. */
export function requireModule(req: Request, m: Module, min: AccessLevel) {
  if (!hasModule(req, m, 'view')) throw new HttpError(404, 'module_not_found', 'No tienes acceso a este módulo');
  if (!hasModule(req, m, min)) throw new HttpError(403, 'forbidden', 'No tienes permiso para esta acción');
}
export const moduleGate = (m: Module) => (req: Request, _res: Response, next: NextFunction) => { requireModule(req, m, 'view'); next(); };

/** ¿Es del departamento? (con «edit» crea y trabaja en los suyos; con «manage» además gestiona lo de sus departamentos) */
export async function inDept(db: pg.PoolClient, departmentId: string): Promise<boolean> {
  return !!(await db.query('select 1 from member_departments where user_id = app_user() and department_id = $1', [departmentId])).rowCount;
}
