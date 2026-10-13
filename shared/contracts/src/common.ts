import { z } from 'zod';

export const Id = z.uuid();
export type Id = string;
/** Fecha ISO 8601 tal como viaja en JSON */
export type IsoDate = string;

// accountant (Contable): Miembro fuera de finanzas, Admin dentro (ADR 0007)
export const ROLES = ['owner', 'admin', 'lead', 'member', 'guest', 'accountant'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/**
 * Módulos con permiso por persona y su nivel. Owner y Admin tienen todo en «manage»; el resto parte de los valores por
 * defecto de su rol (MODULE_DEFAULTS) y el Admin los ajusta persona por persona. Qué ve dentro de cada módulo lo siguen
 * decidiendo sus departamentos y líneas.
 */
export const MODULES = ['manuals', 'tasks', 'goals', 'sales', 'finance'] as const;
export type Module = (typeof MODULES)[number];
export const ACCESS_LEVELS = ['none', 'view', 'edit', 'manage'] as const;
export const AccessLevel = z.enum(ACCESS_LEVELS);
export type AccessLevel = z.infer<typeof AccessLevel>;
export const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2, manage: 3 };
/** Lo que cada rol puede hoy (antes de esta pantalla): así nadie gana ni pierde acceso hasta que el Admin lo cambie */
export const MODULE_DEFAULTS: Record<Role, Record<Module, AccessLevel>> = {
  owner: { manuals: 'manage', tasks: 'manage', goals: 'manage', sales: 'manage', finance: 'manage' },
  admin: { manuals: 'manage', tasks: 'manage', goals: 'manage', sales: 'manage', finance: 'manage' },
  lead: { manuals: 'view', tasks: 'edit', goals: 'view', sales: 'view', finance: 'none' },
  member: { manuals: 'view', tasks: 'edit', goals: 'view', sales: 'view', finance: 'none' },
  accountant: { manuals: 'view', tasks: 'edit', goals: 'view', sales: 'view', finance: 'edit' },
  guest: { manuals: 'none', tasks: 'none', goals: 'none', sales: 'none', finance: 'none' },
};
/** Nivel efectivo: Owner/Admin todo; el resto, el ajuste de la persona o el del rol */
export function effectiveModules(role: Role, overrides: Partial<Record<Module, AccessLevel>> = {}): Record<Module, AccessLevel> {
  if (role === 'owner' || role === 'admin') return { ...MODULE_DEFAULTS.owner };
  return Object.fromEntries(MODULES.map((m) => [m, overrides[m] ?? MODULE_DEFAULTS[role][m]])) as Record<Module, AccessLevel>;
}

export const Locale = z.enum(['es', 'en']);
export type Locale = z.infer<typeof Locale>;

/** Error estándar de la API */
export type ApiError = { error: string; code: string };

/** Cursor opaco `(created_at, id)` codificado en base64url */
export const CursorQuery = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type Page<T> = { items: T[]; nextCursor: string | null; prevCursor: string | null };

export const Name = z.string().trim().min(1).max(80);
