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

export type Product = { id: Id; carrierId: Id; name: string; aliases: string[]; archivedAt: IsoDate | null };
export type Carrier = { id: Id; name: string; aliases: string[]; advanceMonths: number; archivedAt: IsoDate | null; products: Product[] };

export type CommissionRate = { productId: Id; rate: number; effectiveFrom: Day };
/** Admin ve todos los miembros; el resto, solo su propio perfil */
export type AgentProfile = {
  userId: Id; uplineUserId: Id | null; discordUserId: string | null;
  rates: CommissionRate[];        // historial completo, del más reciente al más antiguo por producto
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
  rate: number; amount: number; dueDate: Day; status: InstallmentStatus; paidAt: Day | null;
  sale: Pick<Sale, 'agentUserId' | 'carrierId' | 'productId' | 'clientName' | 'amount' | 'issuedAt' | 'status'>;
};
export type CommissionsList = {
  items: Installment[];
  totals: { pending: number; paid: number };   // anuladas no suman
};

/** Mensaje de Discord que el lector no pudo completar */
export type InboxItem = {
  id: Id; discordUserId: string; authorName: string; content: string; postedAt: IsoDate;
  parsed: Partial<Pick<Sale, 'agentUserId' | 'carrierId' | 'productId' | 'amount' | 'clientName' | 'clientState' | 'expectedIssueDate'>>;
  problems: string[];
};

// ─── Entradas ───

const Aliases = z.array(z.string().trim().min(1).max(40)).max(20).default([]);

export const CarrierBody = z.object({
  name: z.string().trim().min(1).max(80), aliases: Aliases, advanceMonths: z.number().int().min(0).max(12).default(9),
});
export const UpdateCarrierBody = z.object({
  name: z.string().trim().min(1).max(80), aliases: Aliases, advanceMonths: z.number().int().min(0).max(12), archived: z.boolean(),
}).partial();
export const ProductBody = z.object({ name: z.string().trim().min(1).max(80), aliases: Aliases });
export const UpdateProductBody = z.object({ name: z.string().trim().min(1).max(80), aliases: Aliases, archived: z.boolean() }).partial();

export const UpdateAgentProfileBody = z.object({
  uplineUserId: Id.nullable(), discordUserId: z.string().regex(/^\d{5,25}$/).nullable(),
}).partial();
export const RateBody = z.object({ productId: Id, rate: z.number().min(0).max(300), effectiveFrom: Day });

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
export const PayInstallmentsBody = z.object({ ids: z.array(Id).min(1).max(500), paidAt: Day.nullable() });   // null = deshacer
