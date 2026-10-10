// Ventas y comisiones por agente (docs/plan-comisiones.md). Módulo activo según settings.salesModule.
import { z } from 'zod';
import { Id, type IsoDate } from './common.ts';

/** Fecha sin hora (YYYY-MM-DD): ISSUE, vencimientos y vigencias */
const Day = z.iso.date();
type Day = string;

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD',
  'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export const SALE_STATUS = ['pending', 'issued', 'declined', 'cancelled'] as const;
export type SaleStatus = (typeof SALE_STATUS)[number];
export const INSTALLMENT_STATUS = ['pending', 'paid', 'void'] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUS)[number];

// ─── Entidades ───

/** Fila de la tabla de comisiones de un producto: con el nivel `level`, el agente cobra `rate` % */
export type GridRow = { level: number; rate: number };
export type Product = {
  id: Id; carrierId: Id; name: string; aliases: string[]; archivedAt: IsoDate | null;
  grids: { effectiveFrom: Day; rows: GridRow[] }[];   // revisiones de la tabla, la más reciente primero
};
export type Carrier = {
  id: Id; name: string; aliases: string[]; advanceMonths: number; archivedAt: IsoDate | null; products: Product[];
  defaultProductId: Id | null;            // el que se asume cuando el mensaje de Discord no dice el producto
};

/** Admin ve todos los miembros; el resto, solo su propio perfil */
export type AgentProfile = {
  userId: Id; uplineUserId: Id | null; discordUserId: string | null;
  levels: { level: number; effectiveFrom: Day }[];   // nivel de contrato (FFL); historial, el más reciente primero
};

export type Sale = {
  id: Id; agentUserId: Id; uplineUserId: Id | null; carrierId: Id; productId: Id;
  amount: number; clientName: string; clientState: string | null;
  expectedIssueDate: Day; issuedAt: Day | null; status: SaleStatus; overdue: boolean;   // pendiente con fecha vencida
  source: 'manual' | 'discord'; notes: string; createdAt: IsoDate;
};
export type SalesList = {
  items: Sale[];
  totals: { count: number; amount: number; issued: number; pending: number };
};

export type Installment = {
  id: Id; saleId: Id; beneficiaryUserId: Id; kind: 'direct' | 'override'; part: 'advance' | 'remainder' | 'chargeback';
  level: number | null; rate: number; amount: number; dueDate: Day; status: InstallmentStatus; paidAt: Day | null;
  total: number;                          // comisión completa: adelanto + resto (en chargeback, el mismo monto)
  /** La otra cuota de la misma comisión (adelanto ↔ resto); null en chargebacks */
  sibling: { id: Id; part: 'advance' | 'remainder'; amount: number; dueDate: Day; status: InstallmentStatus } | null;
  sale: Pick<Sale, 'agentUserId' | 'carrierId' | 'productId' | 'clientName' | 'amount' | 'issuedAt' | 'status'>;
};
export type CommissionsList = {
  items: Installment[];
  totals: { pending: number; paid: number };   // anuladas no suman
};

/** Qué le faltó a un mensaje de Discord: monto, compañía, producto, fecha, cliente o agente sin enlazar */
export const INBOX_PROBLEMS = ['amount', 'carrier', 'product', 'date', 'client', 'agent'] as const;
export type InboxProblem = (typeof INBOX_PROBLEMS)[number];
/** Mensaje de Discord que el lector no pudo completar */
export type InboxItem = {
  id: Id; discordUserId: string; authorName: string; content: string; postedAt: IsoDate;
  parsed: Partial<Pick<Sale, 'agentUserId' | 'carrierId' | 'productId' | 'amount' | 'clientName' | 'clientState' | 'expectedIssueDate'>>;
  problems: InboxProblem[];
};

/** Canal de ventas de Discord conectado a la agencia */
export type DiscordFeed = {
  botConfigured: boolean;                 // el servidor tiene DISCORD_BOT_TOKEN
  channelId: string | null; lastPolledAt: IsoDate | null; lastError: string | null; pendingInbox: number;
};

// ─── Entradas ───

const AliasList = z.array(z.string().trim().min(1).max(40)).max(20);
const Aliases = AliasList.default([]);   // solo al crear: en una edición, omitirlos no debe borrarlos

export const CarrierBody = z.object({
  name: z.string().trim().min(1).max(80), aliases: Aliases, advanceMonths: z.number().int().min(0).max(12).default(9),
});
export const UpdateCarrierBody = z.object({
  name: z.string().trim().min(1).max(80), aliases: AliasList, advanceMonths: z.number().int().min(0).max(12), archived: z.boolean(),
  defaultProductId: Id.nullable(),
}).partial();
export const ProductBody = z.object({ name: z.string().trim().min(1).max(80), aliases: Aliases });
export const UpdateProductBody = z.object({ name: z.string().trim().min(1).max(80), aliases: AliasList, archived: z.boolean() }).partial();

export const UpdateAgentProfileBody = z.object({
  uplineUserId: Id.nullable(), discordUserId: z.string().regex(/^\d{5,25}$/).nullable(),
}).partial();
const Level = z.number().int().min(0).max(300);
export const LevelBody = z.object({ level: Level, effectiveFrom: Day });
/** Revisión de la tabla de un producto: reemplaza la de esa fecha */
export const GridBody = z.object({
  effectiveFrom: Day,
  rows: z.array(z.object({ level: Level, rate: z.number().min(0).max(300) })).min(1).max(100)
    .refine((r) => new Set(r.map((x) => x.level)).size === r.length, 'Nivel repetido'),
});

export const SaleBody = z.object({
  agentUserId: Id, productId: Id, amount: z.number().positive().max(10_000_000),
  clientName: z.string().trim().min(1).max(120), clientState: z.enum(US_STATES).nullable().default(null),
  expectedIssueDate: Day, notes: z.string().max(2_000).default(''),
  inboxId: Id.optional(),          // al completar un mensaje de la bandeja de Discord
});
export const UpdateSaleBody = SaleBody.omit({ inboxId: true }).partial();
export const IssueSaleBody = z.object({ issuedAt: Day });
/** Cancelar una venta ISSUED: % de lo ya pagado que la compañía descontó (chargeback) */
export const CancelSaleBody = z.object({ chargebackPercent: z.number().min(0).max(100).default(100) });

const Bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const SalesQuery = z.object({
  from: Day.optional(), to: Day.optional(),            // por fecha esperada de ISSUE
  agentUserId: Id.optional(), carrierId: Id.optional(), productId: Id.optional(),
  status: z.enum(SALE_STATUS).optional(), overdue: Bool.optional(),
});
export const CommissionsQuery = z.object({
  from: Day.optional(), to: Day.optional(),            // por fecha de pago
  beneficiaryUserId: Id.optional(), status: z.enum(INSTALLMENT_STATUS).optional(),
});
const Snowflake = z.string().regex(/^\d{15,25}$/, 'ID de Discord inválido');
export const DiscordFeedBody = z.object({ channelId: Snowflake, importSince: Day });   // lee el canal desde ese día
export const LinkInboxAuthorBody = z.object({ userId: Id });                         // el autor de Discord es este miembro

export const PayInstallmentsBody = z.object({ ids: z.array(Id).min(1).max(500), paidAt: Day.nullable() });   // null = deshacer
