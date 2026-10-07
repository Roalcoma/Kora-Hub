// Cuentas, workspaces, miembros, invitaciones, estructura de la agencia y facturación (§3, §4).
import { z } from 'zod';
import { Id, Role, Locale, Name, type IsoDate } from './common.ts';

// ─── Entidades ───

export type User = {
  id: Id; email: string; name: string; avatarUrl: string | null;
  locale: Locale; timezone: string; totpEnabled: boolean;
};

// Rubro de la agencia: decide la plantilla inicial y los avisos propios del sector (PHI solo en seguros).
export const INDUSTRIES = ['insurance', 'marketing', 'real_estate', 'travel', 'other'] as const;
export const Industry = z.enum(INDUSTRIES);
export type Industry = z.infer<typeof Industry>;
export const TEMPLATES = ['insurance_agency', 'marketing_agency', 'real_estate_agency', 'travel_agency', 'blank'] as const;

/** Paleta fija de las categorías (antes "líneas de negocio"): nombres de token, nunca hex libre */
export const CATEGORY_COLORS = ['green', 'blue', 'purple', 'orange', 'red', 'teal', 'pink', 'gray'] as const;
export const CategoryColor = z.enum(CATEGORY_COLORS);
export type CategoryColor = z.infer<typeof CategoryColor>;
/** Cómo llama cada agencia a sus categorías ("Línea", "Producto", "Sede"…). null = texto por defecto de la UI */
export const CategoryLabel = z.object({ singular: z.string().trim().min(1).max(30), plural: z.string().trim().min(1).max(30) });
export type CategoryLabel = z.infer<typeof CategoryLabel>;

export type WorkspaceStatus = 'trialing' | 'active' | 'past_due' | 'read_only' | 'suspended' | 'closing';
export type Plan = 'trial' | 'standard' | 'pro';

export type Workspace = {
  id: Id; slug: string; name: string; logoUrl: string | null;
  plan: Plan; status: WorkspaceStatus; trialEndsAt: IsoDate;
  settings: {
    maxFileMb: number; require2fa: boolean; weeklySummary: boolean;
    industry: Industry; categoryLabel: CategoryLabel | null;
  };
};

export type Member = {
  userId: Id; name: string; email: string; avatarUrl: string | null;
  role: Role; title: string | null; statusText: string | null; statusUntil: IsoDate | null;
  isActive: boolean; departmentIds: Id[]; leadOfDepartmentIds: Id[]; lineIds: Id[];
  presence: 'active' | 'away';
};

export type Department = { id: Id; name: string; position: number; archivedAt: IsoDate | null };
export type BusinessLine = { id: Id; name: string; color: CategoryColor | null; position: number; archivedAt: IsoDate | null };

/** Respuesta de login/registro: el JWT va en cookie httpOnly; el cuerpo trae el estado inicial */
export type Session = {
  user: User; workspaces: Pick<Workspace, 'id' | 'slug' | 'name' | 'logoUrl'>[];
  platformAdmin: boolean;                 // ve el backoffice /admin
  impersonation: Impersonation | null;    // sesión abierta por un superadmin "como" este usuario
};
export type Impersonation = { byUserId: Id; byName: string; workspaceSlug: string; expiresAt: IsoDate };

// ─── Facturación (§3.4, §3.5, ADR 0005) ───

export type BillingInfo = {
  plan: Plan; status: WorkspaceStatus;
  trialEndsAt: IsoDate; graceEndsAt: IsoDate | null; currentPeriodEnd: IsoDate | null;
  seats: number;                                       // miembros activos que no son invitados
  pricesCents: { standard: number; pro: number };      // por usuario al mes
  estimatedMonthlyCents: number;                       // seats × precio del plan (o del Estándar en prueba)
  hasSubscription: boolean;
  simulated: boolean;                                  // sin llaves de Stripe: checkout y eventos simulados
};

// ─── Backoffice de plataforma (§3.6) ───

export type AdminWorkspace = Workspace & {
  members: number; storageBytes: number; mrrCents: number; createdAt: IsoDate; ownerEmail: string | null;
};
export type AdminMetrics = { mrrCents: number; activeWorkspaces: number; trials: number; signups30d: number; churn30d: number };

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
  workspace: z.object({ name: Name, slug: Slug, template: z.enum(TEMPLATES) }),
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
  settings: z.object({
    maxFileMb: z.number().int().min(1).max(100), require2fa: z.boolean(), weeklySummary: z.boolean(),
    industry: Industry, categoryLabel: CategoryLabel.nullable(),
  }).partial(),
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
  // Solo si el email no tiene cuenta todavía. `email` es obligatorio cuando la invitación es un enlace sin email.
  newAccount: z.object({ name: Name, password: Password, locale: Locale, email: z.email().optional() }).optional(),
});

export const UpdateMemberBody = z.object({
  role: Role, title: z.string().max(80).nullable(), isActive: z.boolean(),
  departments: z.array(z.object({ id: Id, isLead: z.boolean() })), lineIds: z.array(Id),
}).partial();

export const DepartmentBody = z.object({ name: Name, position: z.number().int().optional() });
export const BusinessLineBody = z.object({ name: Name, color: CategoryColor.nullable().optional(), position: z.number().int().optional() });

export const CheckoutBody = z.object({ plan: z.enum(['standard', 'pro']) });
/** Solo en modo simulado (sin llaves de Stripe): el Owner provoca el evento que mandaría Stripe */
export const SimulateBillingBody = z.object({
  event: z.enum(['paid', 'payment_failed', 'canceled']), plan: z.enum(['standard', 'pro']).optional(),
});

export const AdminStatusBody = z.object({ status: z.enum(['active', 'suspended']) });
export const ImpersonateBody = z.object({ reason: z.string().trim().min(5).max(300) });
