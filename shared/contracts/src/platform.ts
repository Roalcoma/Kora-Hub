// Cuentas, workspaces, miembros, invitaciones, estructura de la agencia y facturación (§3, §4).
import { z } from 'zod';
import { Id, Role, Locale, Name, type IsoDate } from './common.ts';

// ─── Entidades ───

export type User = {
  id: Id; email: string; name: string; avatarUrl: string | null;
  locale: Locale; timezone: string; totpEnabled: boolean;
};

export type WorkspaceStatus = 'trialing' | 'active' | 'past_due' | 'read_only' | 'suspended' | 'closing';
export type Plan = 'trial' | 'standard' | 'pro';

export type Workspace = {
  id: Id; slug: string; name: string; logoUrl: string | null;
  plan: Plan; status: WorkspaceStatus; trialEndsAt: IsoDate;
  settings: { maxFileMb: number; require2fa: boolean; weeklySummary: boolean };
};

export type Member = {
  userId: Id; name: string; email: string; avatarUrl: string | null;
  role: Role; title: string | null; statusText: string | null; statusUntil: IsoDate | null;
  isActive: boolean; departmentIds: Id[]; leadOfDepartmentIds: Id[]; lineIds: Id[];
  presence: 'active' | 'away';
};

export type Department = { id: Id; name: string; position: number; archivedAt: IsoDate | null };
export type BusinessLine = { id: Id; name: string; color: string | null; position: number; archivedAt: IsoDate | null };

/** Respuesta de login/registro: el JWT va en cookie httpOnly; el cuerpo trae el estado inicial */
export type Session = { user: User; workspaces: Pick<Workspace, 'id' | 'slug' | 'name' | 'logoUrl'>[] };

export type Invitation = { id: Id; email: string | null; role: Role; expiresAt: IsoDate; uses: number; maxUses: number; url?: string };

export type NotifPrefs = {
  channelDefault: 'all' | 'mentions';
  dnd: { from: string; to: string; days: number[] } | null;   // "22:00" → "07:00", 0 = domingo
};

// ─── Entradas (validar en el borde con estos esquemas) ───

const Password = z.string().min(10).max(200);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);

export const RegisterBody = z.object({
  name: Name, email: z.email(), password: Password, locale: Locale,
  workspace: z.object({ name: Name, slug: Slug, template: z.enum(['insurance_agency', 'blank']) }),
});
export const LoginBody = z.object({ email: z.email(), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() });
export const ForgotPasswordBody = z.object({ email: z.email() });
export const ResetPasswordBody = z.object({ token: z.string().min(20), password: Password });
export const TotpConfirmBody = z.object({ code: z.string().regex(/^\d{6}$/) });

export const UpdateProfileBody = z.object({
  name: Name, locale: Locale, timezone: z.string().max(64), avatarFileId: Id.nullable(),
}).partial();
export const UpdateMyMembershipBody = z.object({
  title: z.string().max(80).nullable(), statusText: z.string().max(100).nullable(), statusUntil: z.iso.datetime().nullable(),
  notifPrefs: z.object({
    channelDefault: z.enum(['all', 'mentions']),
    dnd: z.object({ from: z.string().regex(/^\d\d:\d\d$/), to: z.string().regex(/^\d\d:\d\d$/), days: z.array(z.number().int().min(0).max(6)) }).nullable(),
  }),
}).partial();

export const UpdateWorkspaceBody = z.object({
  name: Name, logoFileId: Id.nullable(),
  settings: z.object({ maxFileMb: z.number().int().min(1).max(100), require2fa: z.boolean(), weeklySummary: z.boolean() }).partial(),
}).partial();

export const CreateInvitationBody = z.object({
  email: z.email().nullable(),                         // null = enlace reutilizable
  role: Role.exclude(['owner']),
  departmentIds: z.array(Id).default([]),
  maxUses: z.number().int().min(1).max(500).default(1),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export const AcceptInvitationBody = z.object({
  token: z.string().min(20),
  // Solo si el email no tiene cuenta todavía
  newAccount: z.object({ name: Name, password: Password, locale: Locale }).optional(),
});

export const UpdateMemberBody = z.object({
  role: Role, title: z.string().max(80).nullable(), isActive: z.boolean(),
  departments: z.array(z.object({ id: Id, isLead: z.boolean() })), lineIds: z.array(Id),
}).partial();

export const DepartmentBody = z.object({ name: Name, position: z.number().int().optional() });
export const BusinessLineBody = z.object({ name: Name, color: z.string().max(32).nullable().optional(), position: z.number().int().optional() });

export const CheckoutBody = z.object({ plan: z.enum(['standard', 'pro']) });
