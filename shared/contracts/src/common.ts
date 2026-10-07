import { z } from 'zod';

export const Id = z.uuid();
export type Id = string;
/** Fecha ISO 8601 tal como viaja en JSON */
export type IsoDate = string;

export const ROLES = ['owner', 'admin', 'lead', 'member', 'guest'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

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
