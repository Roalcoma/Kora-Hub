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

/**
 * Agente asociado: vende y cobra comisiones, pero no es usuario de la agencia. Si algún día entra a Kora, se enlaza a su
 * usuario (`userId`) y ve sus ventas y comisiones. Admin ve todos; el resto, el suyo y los de su equipo.
 */
export type Agent = {
  id: Id; name: string; email: string | null; userId: Id | null; uplineAgentId: Id | null; discordUserId: string | null;
  archivedAt: IsoDate | null;
  /** Nivel de contrato (FFL) por compañía; historial, el más reciente primero (ADR 0006) */
  levels: { carrierId: Id; level: number; effectiveFrom: Day }[];
};

export type Sale = {
  id: Id; agentId: Id; uplineAgentId: Id | null; carrierId: Id; productId: Id;
  amount: number; clientName: string; clientState: string | null;
  soldOn: Day;                                                                           // día en que se hizo la venta
  expectedIssueDate: Day; issuedAt: Day | null; status: SaleStatus; overdue: boolean;   // pendiente con fecha vencida
  source: 'manual' | 'discord'; notes: string; createdAt: IsoDate;
  /** Split: otros agentes y su % de la venta; el principal (`agentId`) se queda con el resto */
  splits: SaleSplit[];
};
export type SaleSplit = { agentId: Id; percent: number; name: string };
export type SalesList = {
  items: Sale[];
  totals: { count: number; amount: number; issued: number; pending: number };
};

/** Una cuota de la comisión vista desde otra (para saltar entre ellas) */
export type InstallmentRef = { id: Id; part: 'advance' | 'remainder'; seq: number; amount: number; dueDate: Day; status: InstallmentStatus };
export type Installment = {
  id: Id; saleId: Id; beneficiaryAgentId: Id; kind: 'direct' | 'override'; part: 'advance' | 'remainder' | 'chargeback';
  /** 0 = adelanto, 1..n = cuotas mensuales del resto (ADR 0008); null en chargebacks */
  seq: number | null;
  /** Meses después del ISSUE en que vence (0 = adelanto, 10/11/12 = resto con 9 adelantados); null en chargebacks */
  month: number | null;
  level: number | null; rate: number; amount: number; dueDate: Day; status: InstallmentStatus; paidAt: Day | null;
  total: number;                          // comisión completa: adelanto + cuotas del resto (en chargeback, el mismo monto)
  /** Cuántas cuotas tiene esta comisión (1 en chargebacks) */
  of: number;
  /** Todas las cuotas de la misma venta, beneficiario y tipo, ordenadas por `seq` (incluye esta); vacío en chargebacks */
  group: InstallmentRef[];
  /** Agente de la venta de cuya parte sale esta cuota, y qué % de la venta es esa parte (100 sin split) */
  viaAgentId: Id; share: number;
  sale: Pick<Sale, 'agentId' | 'carrierId' | 'productId' | 'clientName' | 'amount' | 'issuedAt' | 'status'>;
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
  parsed: Partial<Pick<Sale, 'agentId' | 'carrierId' | 'productId' | 'amount' | 'clientName' | 'clientState' | 'expectedIssueDate'>>;
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

const DiscordUser = z.string().regex(/^\d{5,25}$/);
export const AgentBody = z.object({
  name: z.string().trim().min(1).max(120), email: z.email().nullable().default(null),
  uplineAgentId: Id.nullable().default(null), discordUserId: DiscordUser.nullable().default(null),
  userId: Id.nullable().default(null),     // usuario de Kora enlazado (si el email coincide, se enlaza solo)
});
export const UpdateAgentBody = z.object({
  name: z.string().trim().min(1).max(120), email: z.email().nullable(), uplineAgentId: Id.nullable(),
  discordUserId: DiscordUser.nullable(), userId: Id.nullable(), archived: z.boolean(),
}).partial();
const Level = z.number().int().min(0).max(300);
/** El mismo nivel aplicado a una o varias compañías desde esa fecha (misma fecha = corrige esa fila) */
export const LevelBody = z.object({
  carrierIds: z.array(Id).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, 'Compañía repetida'),
  level: Level, effectiveFrom: Day,
});
/** Revisión de la tabla de un producto: reemplaza la de esa fecha */
export const GridBody = z.object({
  effectiveFrom: Day,
  rows: z.array(z.object({ level: Level, rate: z.number().min(0).max(300) })).min(1).max(100)
    .refine((r) => new Set(r.map((x) => x.level)).size === r.length, 'Nivel repetido'),
});

/** Split con otros agentes (sin el principal); la suma queda por debajo de 100 */
const Splits = z.array(z.object({ agentId: Id, percent: z.number().gt(0).lt(100).multipleOf(0.01) })).max(4)
  .refine((x) => new Set(x.map((s) => s.agentId)).size === x.length, 'Agente repetido en el split')
  .refine((x) => x.reduce((t, s) => t + s.percent, 0) < 100, 'El split tiene que dejarle una parte al agente principal');

export const SaleBody = z.object({
  agentId: Id, productId: Id, amount: z.number().positive().max(10_000_000),
  clientName: z.string().trim().min(1).max(120), clientState: z.enum(US_STATES).nullable().default(null),
  expectedIssueDate: Day, notes: z.string().max(2_000).default(''),
  soldOn: Day.optional(),          // sin ella: el día del mensaje de Discord, o hoy
  inboxId: Id.optional(),          // al completar un mensaje de la bandeja de Discord
  splits: Splits.default([]),
});
export const UpdateSaleBody = SaleBody.omit({ inboxId: true, splits: true }).partial().extend({ splits: Splits.optional() });
export const IssueSaleBody = z.object({ issuedAt: Day });
/** Cancelar una venta ISSUED: % de lo ya pagado que la compañía descontó (chargeback) */
export const CancelSaleBody = z.object({ chargebackPercent: z.number().min(0).max(100).default(100) });

const Bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const SalesQuery = z.object({
  from: Day.optional(), to: Day.optional(),            // por fecha esperada de ISSUE o, con dateBy=sold, por fecha de venta
  dateBy: z.enum(['issue', 'sold']).default('issue'),
  agentId: Id.optional(), carrierId: Id.optional(), productId: Id.optional(),
  status: z.enum(SALE_STATUS).optional(), overdue: Bool.optional(),
});
export const CommissionsQuery = z.object({
  from: Day.optional(), to: Day.optional(),            // por fecha de pago
  beneficiaryAgentId: Id.optional(), status: z.enum(INSTALLMENT_STATUS).optional(),
  carrierId: Id.optional(),
  agentId: Id.optional(),                               // agente que hizo la venta (distinto del beneficiario)
});
const Snowflake = z.string().regex(/^\d{15,25}$/, 'ID de Discord inválido');
export const DiscordFeedBody = z.object({ channelId: Snowflake, importSince: Day });   // lee el canal desde ese día
export const LinkInboxAuthorBody = z.object({ agentId: Id });                        // el autor de Discord es este agente

export const PayInstallmentsBody = z.object({ ids: z.array(Id).min(1).max(500), paidAt: Day.nullable() });   // null = deshacer
