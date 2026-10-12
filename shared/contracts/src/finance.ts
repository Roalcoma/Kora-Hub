// Finanzas: gastos, nómina y estados de cuenta del banco (docs/plan-finanzas.md, ADR 0007).
// Módulo activo según settings.financeModule. Solo Owner, Admin y Contable (accountant) lo ven; todas las rutas
// viven bajo /w/:slug/finance para que el backend las proteja con un solo guardián (módulo + rol).
// Moneda única USD; montos en dólares con 2 decimales (numeric(12,2) en la BD), igual que ventas.
//
// OJO con `.default()`: los esquemas de edición (`Update…Body`) se arman con `.partial()` sobre campos SIN default;
// un default dentro de un PATCH rellenaría el campo omitido y borraría el dato guardado.
import { z } from 'zod';
import { Id, type IsoDate } from './common.ts';
import { CategoryColor } from './platform.ts';
import type { FileRef } from './files.ts';

/** Fecha sin hora (YYYY-MM-DD) */
const Day = z.iso.date();
type Day = string;
const Money = z.number().positive().max(10_000_000).multipleOf(0.01);
const Text = (max: number) => z.string().trim().max(max);
const Bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const EXPENSE_PAY_METHODS = ['card', 'ach', 'zelle', 'check', 'cash', 'other'] as const;
export type ExpensePayMethod = (typeof EXPENSE_PAY_METHODS)[number];
export const PAYROLL_PAY_METHODS = ['ach', 'zelle', 'check', 'cash'] as const;
export type PayrollPayMethod = (typeof PAYROLL_PAY_METHODS)[number];

export const EXPENSE_STATUS = ['pending', 'paid', 'skipped'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUS)[number];
/** Gasto o plantilla cargado por un Contable: queda `pending` hasta que Owner/Admin lo apruebe o rechace */
export const APPROVAL_STATUS = ['approved', 'pending', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];
export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const PAYROLL_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;
export type PayrollFrequency = (typeof PAYROLL_FREQUENCIES)[number];
export const COMPONENT_KINDS = ['salary', 'hourly', 'sales_commission', 'sales_percent', 'bonus', 'deduction_fixed', 'deduction_percent'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
/** Tipos que llevan monto (por periodo, o tarifa por hora en `hourly`) y los que llevan % */
export const AMOUNT_KINDS: readonly ComponentKind[] = ['salary', 'hourly', 'bonus', 'deduction_fixed'];
export const RATE_KINDS: readonly ComponentKind[] = ['sales_percent', 'deduction_percent'];
export const RUN_STATUS = ['draft', 'approved', 'paid'] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

export const MATCH_STATUS = ['unmatched', 'matched', 'ignored'] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];

/** Día del mes: 1–31 o el último (un 31 cae en el 30 o el 28/29 en meses más cortos) */
const MonthDay = z.union([z.number().int().min(1).max(31), z.literal('last')]);
type MonthDay = number | 'last';

type Approval = { approvalStatus: ApprovalStatus; approvedBy: Id | null; approvedAt: IsoDate | null };   // approvedBy/At = quien decidió

// ═══════════════════════════ Gastos ═══════════════════════════

export type ExpenseCategory = { id: Id; name: string; color: CategoryColor; position: number; archivedAt: IsoDate | null };

/** Plantilla de gasto recurrente; el job diario genera sus ocurrencias hasta 35 días adelante */
export type ExpenseSchedule = Approval & {
  id: Id; categoryId: Id; vendor: string; concept: string; amount: number; payMethod: ExpensePayMethod;
  frequency: ScheduleFrequency; interval: number;
  weekdays: number[] | null;              // semanal: 0 = domingo … 6 = sábado
  monthDay: MonthDay | null;              // mensual
  businessDaysOnly: boolean;              // diario
  startsOn: Day; endsOn: Day | null; status: 'active' | 'paused';
  nextDueDate: Day | null;                // próxima ocurrencia según la regla (null si terminó)
  createdBy: Id; createdAt: IsoDate;
};

export type Expense = Approval & {
  id: Id; scheduleId: Id | null; categoryId: Id; vendor: string; concept: string;
  dueDate: Day; amount: number;           // estimado (recurrente) o registrado
  paidAmount: number | null; paidAt: Day | null;   // monto real y fecha del pago
  payMethod: ExpensePayMethod; reference: string; notes: string; file: FileRef | null;   // comprobante
  status: ExpenseStatus; overdue: boolean;          // pendiente con fecha vencida
  createdBy: Id | null;                   // null = generado por el job
  createdAt: IsoDate;
};
/** Los saltados y rechazados no suman en los totales */
export type ExpensesList = {
  items: Expense[];
  totals: { count: number; amount: number; paid: number; pending: number; overdue: number; overdueCount: number };
  byCategory: { categoryId: Id; amount: number; paid: number }[];
};

export const ExpenseCategoryBody = z.object({ name: Text(60).min(1), color: CategoryColor.default('gray') });
export const UpdateExpenseCategoryBody = z.object({
  name: Text(60).min(1), color: CategoryColor, position: z.number().int(), archived: z.boolean(),
}).partial();

const ScheduleFields = z.object({
  categoryId: Id, vendor: Text(120).min(1), concept: Text(200), amount: Money,
  payMethod: z.enum(EXPENSE_PAY_METHODS), frequency: z.enum(SCHEDULE_FREQUENCIES),
  interval: z.number().int().min(1).max(365),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable(),
  monthDay: MonthDay.nullable(), businessDaysOnly: z.boolean(),
  startsOn: Day, endsOn: Day.nullable(),
});
type ScheduleShape = Partial<z.infer<typeof ScheduleFields>>;
/** Coherencia frecuencia ↔ campos; en el PATCH el backend la vuelve a validar sobre la fila combinada */
const scheduleRules = (s: ScheduleShape, ctx: z.RefinementCtx) => {
  if (s.frequency === 'weekly' && !s.weekdays?.length) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Elige al menos un día de la semana' });
  if (s.frequency && s.frequency !== 'weekly' && s.weekdays) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Solo para frecuencia semanal' });
  if (s.frequency === 'monthly' && s.monthDay == null) ctx.addIssue({ code: 'custom', path: ['monthDay'], message: 'Elige el día del mes' });
  if (s.frequency && s.frequency !== 'monthly' && s.monthDay != null) ctx.addIssue({ code: 'custom', path: ['monthDay'], message: 'Solo para frecuencia mensual' });
  if (s.frequency && s.frequency !== 'daily' && s.businessDaysOnly) ctx.addIssue({ code: 'custom', path: ['businessDaysOnly'], message: 'Solo para frecuencia diaria' });
  if (s.startsOn && s.endsOn && s.endsOn < s.startsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'Termina antes de empezar' });
};
export const ExpenseScheduleBody = ScheduleFields.extend({
  concept: Text(200).default(''), interval: z.number().int().min(1).max(365).default(1),
  weekdays: ScheduleFields.shape.weekdays.default(null), monthDay: MonthDay.nullable().default(null),
  businessDaysOnly: z.boolean().default(false), endsOn: Day.nullable().default(null),
}).superRefine(scheduleRules);
/** Cambiar el monto aplica desde la próxima ocurrencia pendiente; pausar o terminar no borra lo ya generado */
export const UpdateExpenseScheduleBody = ScheduleFields.extend({ status: z.enum(['active', 'paused']) }).partial()
  .superRefine(scheduleRules);

/** Registrar el pago: monto real (por defecto el estimado), fecha, referencia y comprobante */
export const PayExpenseBody = z.object({
  paidAt: Day, paidAmount: Money.optional(), payMethod: z.enum(EXPENSE_PAY_METHODS).optional(),
  reference: Text(120).optional(), fileId: Id.nullable().optional(),
});
const ExpenseFields = z.object({
  categoryId: Id, vendor: Text(120).min(1), concept: Text(200), dueDate: Day, amount: Money,
  payMethod: z.enum(EXPENSE_PAY_METHODS), reference: Text(120), notes: Text(2_000), fileId: Id.nullable(),
});
export const ExpenseBody = ExpenseFields.extend({
  concept: Text(200).default(''), reference: Text(120).default(''), notes: Text(2_000).default(''),
  fileId: Id.nullable().default(null),
  paid: PayExpenseBody.optional(),        // gasto que se carga ya pagado
});
/** Si un Contable cambia el monto de un gasto aprobado, vuelve a quedar por aprobar */
export const UpdateExpenseBody = ExpenseFields.partial();

export const ExpensesQuery = z.object({
  from: Day.optional(), to: Day.optional(),            // por fecha de vencimiento
  categoryId: Id.optional(), status: z.enum(EXPENSE_STATUS).optional(), approvalStatus: z.enum(APPROVAL_STATUS).optional(),
  vendor: z.string().max(120).optional(), scheduleId: Id.optional(), overdue: Bool.optional(),
});

// ═══════════════════════════ Nómina ═══════════════════════════

/**
 * Calendario de pago. semimonthly = días 15 y último (fijo); weekly/biweekly siguen el ciclo de `anchorDate`
 * (una fecha de pago cualquiera); monthly paga el `payDay`. El calendario solo sugiere el siguiente periodo:
 * cada corrida guarda sus fechas explícitas.
 */
export type PayrollCalendar = {
  id: Id; name: string; frequency: PayrollFrequency; anchorDate: Day | null; payDay: MonthDay | null;
  archivedAt: IsoDate | null; people: number;
  nextPeriod: { periodStart: Day; periodEnd: Day; payDate: Day } | null;   // primero sin corrida
};

export type PayrollComponent = {
  id: Id; personId: Id; kind: ComponentKind; label: string;
  amount: number | null;                  // por periodo; en `hourly`, tarifa por hora
  rate: number | null;                    // % en sales_percent (del ISSUE del periodo) y deduction_percent (del bruto)
  effectiveFrom: Day; effectiveTo: Day | null;
};
/** Persona en nómina: no necesita usuario de Kora (se enlaza solo si cobra comisión o % de ventas) */
export type PayrollPerson = {
  id: Id; name: string; email: string | null; phone: string | null; jobTitle: string | null;
  userId: Id | null; calendarId: Id; payMethod: PayrollPayMethod; accountLast4: string | null;
  hiredOn: Day | null; terminatedOn: Day | null; isActive: boolean;
  components: PayrollComponent[];         // vigentes y pasados, el más reciente primero
};

/** Renglón del desglose de una línea; congelado al aprobar la corrida */
export type PayrollItem = {
  kind: ComponentKind | 'adjustment_bonus' | 'adjustment_deduction';
  label: string;
  amount: number;                         // siempre positivo: las deducciones restan por su tipo
  detail: string | null;                  // "40 h × $15.00", "3 cuotas pagadas", "5 % de $12,000.00"
  sourceId: Id | null;                    // componente o ajuste de origen
};
export type PayrollAdjustment = { id: Id; personId: Id; kind: 'bonus' | 'deduction'; label: string; amount: number; createdAt: IsoDate };
export type PayrollLine = {
  id: Id; personId: Id; personName: string; hours: number | null; hasHourly: boolean;
  gross: number; deductions: number; net: number; breakdown: PayrollItem[];
  payMethod: PayrollPayMethod; paidAt: Day | null; reference: string;
  adjustments: PayrollAdjustment[];
};
export type PayrollRun = {
  id: Id; calendarId: Id; periodStart: Day; periodEnd: Day; payDate: Day; status: RunStatus; notes: string;
  approvedBy: Id | null; approvedAt: IsoDate | null; paidAt: Day | null; createdAt: IsoDate;
  totals: { people: number; gross: number; deductions: number; net: number; paid: number };
};
export type PayrollRunDetail = PayrollRun & { lines: PayrollLine[] };

export const PayrollCalendarBody = z.object({
  name: Text(60).min(1), frequency: z.enum(PAYROLL_FREQUENCIES),
  anchorDate: Day.nullable().default(null), payDay: MonthDay.nullable().default(null),
}).superRefine((c, ctx) => {
  if ((c.frequency === 'weekly' || c.frequency === 'biweekly') !== (c.anchorDate != null))
    ctx.addIssue({ code: 'custom', path: ['anchorDate'], message: 'Solo y obligatoria en semanal y quincenal' });
  if (c.frequency !== 'monthly' && c.payDay != null) ctx.addIssue({ code: 'custom', path: ['payDay'], message: 'Solo para mensual' });
});
/** La frecuencia no se cambia: se crea otro calendario */
export const UpdatePayrollCalendarBody = z.object({
  name: Text(60).min(1), anchorDate: Day.nullable(), payDay: MonthDay.nullable(), archived: z.boolean(),
}).partial();

const PersonFields = z.object({
  name: Text(120).min(1), email: z.email().nullable(), phone: Text(30).nullable(), jobTitle: Text(80).nullable(),
  userId: Id.nullable(), calendarId: Id, payMethod: z.enum(PAYROLL_PAY_METHODS),
  accountLast4: z.string().regex(/^\d{4}$/).nullable(), hiredOn: Day.nullable(), terminatedOn: Day.nullable(),
  isActive: z.boolean(),
});
export const PayrollPersonBody = PersonFields.extend({
  email: z.email().nullable().default(null), phone: Text(30).nullable().default(null),
  jobTitle: Text(80).nullable().default(null), userId: Id.nullable().default(null),
  accountLast4: z.string().regex(/^\d{4}$/).nullable().default(null),
  hiredOn: Day.nullable().default(null), terminatedOn: Day.nullable().default(null), isActive: z.boolean().default(true),
});
export const UpdatePayrollPersonBody = PersonFields.partial();

const componentRules = (c: { kind?: ComponentKind; amount?: number | null; rate?: number | null; effectiveFrom?: Day; effectiveTo?: Day | null }, ctx: z.RefinementCtx) => {
  if (c.kind && AMOUNT_KINDS.includes(c.kind) !== (c.amount != null)) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Monto obligatorio solo en sueldo, por hora, bono y deducción fija' });
  if (c.kind && RATE_KINDS.includes(c.kind) !== (c.rate != null)) ctx.addIssue({ code: 'custom', path: ['rate'], message: 'Porcentaje obligatorio solo en % de ventas y deducción %' });
  if (c.effectiveFrom && c.effectiveTo && c.effectiveTo < c.effectiveFrom) ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'Termina antes de empezar' });
};
const Rate = z.number().positive().max(100);
export const PayrollComponentBody = z.object({
  kind: z.enum(COMPONENT_KINDS), label: Text(80).default(''),
  amount: Money.nullable().default(null), rate: Rate.nullable().default(null),
  effectiveFrom: Day, effectiveTo: Day.nullable().default(null),
}).superRefine(componentRules);
/** El tipo no cambia; un aumento conviene registrarlo cerrando el vigente (effectiveTo) y creando otro */
export const UpdatePayrollComponentBody = z.object({
  label: Text(80), amount: Money.nullable(), rate: Rate.nullable(), effectiveFrom: Day, effectiveTo: Day.nullable(),
}).partial();

/** Crea la corrida en borrador y calcula una línea por persona activa del calendario */
export const PayrollRunBody = z.object({
  calendarId: Id, periodStart: Day, periodEnd: Day, payDate: Day, notes: Text(2_000).default(''),
}).refine((r) => r.periodEnd >= r.periodStart, { path: ['periodEnd'], message: 'El periodo termina antes de empezar' });
/** Solo en borrador; cambiar el periodo recalcula */
export const UpdatePayrollRunBody = z.object({ periodStart: Day, periodEnd: Day, payDate: Day, notes: Text(2_000) }).partial();
/** Horas del periodo de una línea (borrador): recalcula esa línea */
export const UpdatePayrollLineBody = z.object({ hours: z.number().min(0).max(1_000).multipleOf(0.01).nullable() });
export const PayrollAdjustmentBody = z.object({
  personId: Id, kind: z.enum(['bonus', 'deduction']), label: Text(80).min(1), amount: Money,
});
/** Pagar líneas de una corrida aprobada; sin `lineIds`, todas las no pagadas. paidAt null = deshacer el pago */
export const PayPayrollBody = z.object({
  lineIds: z.array(Id).min(1).max(500).optional(), paidAt: Day.nullable(), reference: Text(120).optional(),
});
export const PayrollRunsQuery = z.object({
  from: Day.optional(), to: Day.optional(),            // por fecha de pago
  calendarId: Id.optional(), status: z.enum(RUN_STATUS).optional(),
});

// ═══════════════════════════ Banco ═══════════════════════════

export type BankAccount = {
  id: Id; name: string; bankName: string; last4: string | null; isActive: boolean;
  hasMapping: boolean; lastStatementTo: Day | null;   // hasta dónde llega el último estado importado
};

/** Movimiento: + entrada / − salida */
export type BankTransaction = {
  id: Id; accountId: Id; statementId: Id | null; postedOn: Day; description: string; amount: number;
  reference: string; carrierId: Id | null; notes: string; source: 'manual' | 'csv'; matchStatus: MatchStatus;
  createdBy: Id; createdAt: IsoDate;
};
export type BankTransactionsList = {
  items: BankTransaction[];
  totals: { count: number; inflow: number; outflow: number; net: number };   // outflow en positivo
};

export type BankStatement = {
  id: Id; accountId: Id; periodFrom: Day; periodTo: Day; file: FileRef | null;
  rowsImported: number; rowsSkipped: number; importedBy: Id; importedAt: IsoDate;
};

export const CSV_DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MM-DD-YYYY', 'DD-MM-YYYY', 'MM/DD/YY', 'DD/MM/YY'] as const;
const Col = z.number().int().min(0).max(100);           // índice de columna (0 = primera); los encabezados pueden repetirse
/** Cómo leer el CSV de una cuenta; se guarda por cuenta (los días/meses de 1 dígito se aceptan en cualquier formato) */
export const CsvMapping = z.object({
  delimiter: z.enum([',', ';', '\t', '|']),
  hasHeader: z.boolean(),
  skipRows: z.number().int().min(0).max(50),             // líneas de cortesía del banco antes del encabezado
  dateColumn: Col, dateFormat: z.enum(CSV_DATE_FORMATS),
  descriptionColumn: Col,
  referenceColumn: Col.nullable(),
  amount: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('single'), column: Col, invert: z.boolean() }),   // invert: el banco pone las salidas en positivo
    z.object({ mode: z.literal('split'), debitColumn: Col, creditColumn: Col }), // débito = salida, crédito = entrada
  ]),
});
export type CsvMapping = z.infer<typeof CsvMapping>;

/** Fila del CSV ya interpretada con el mapeo */
export type ImportRow = {
  line: number;                           // número de línea en el archivo (1 = primera)
  postedOn: Day | null; description: string; amount: number | null; reference: string;
  carrierId: Id | null;                   // sugerida por los alias de compañías de ventas
  duplicate: boolean;                     // ya existe en la cuenta (se omitirá)
  error: string | null;                   // fecha o monto ilegibles: la fila se omite
};
export type ImportPreview = {
  headers: string[] | null; sample: string[][];        // primeras filas crudas, para elegir columnas
  mapping: CsvMapping | null;                          // el enviado o el guardado de la cuenta
  rows: ImportRow[];                                   // vacío si no hay mapeo
  totals: { rows: number; valid: number; duplicates: number; invalid: number };
  period: { from: Day; to: Day } | null;
};

export const BankAccountBody = z.object({
  name: Text(60).min(1), bankName: Text(60).default(''), last4: z.string().regex(/^\d{4}$/).nullable().default(null),
});
export const UpdateBankAccountBody = z.object({
  name: Text(60).min(1), bankName: Text(60), last4: z.string().regex(/^\d{4}$/).nullable(), isActive: z.boolean(),
}).partial();

const SignedMoney = z.number().min(-10_000_000).max(10_000_000).multipleOf(0.01).refine((n) => n !== 0, 'El monto no puede ser cero');
const TransactionFields = z.object({
  accountId: Id, postedOn: Day, description: Text(300), amount: SignedMoney, reference: Text(120),
  carrierId: Id.nullable(), notes: Text(2_000),
});
/** Carga manual; la respuesta avisa si parece duplicado (no lo bloquea) */
export const BankTransactionBody = TransactionFields.extend({
  description: Text(300).default(''), reference: Text(120).default(''), carrierId: Id.nullable().default(null),
  notes: Text(2_000).default(''),
});
/** Compañía, notas y estado de cruce en cualquiera; fecha, descripción, monto y referencia solo en los manuales */
export const UpdateBankTransactionBody = TransactionFields.omit({ accountId: true })
  .extend({ matchStatus: z.enum(MATCH_STATUS) }).partial();
export const BankTransactionsQuery = z.object({
  from: Day.optional(), to: Day.optional(),            // por fecha del movimiento
  accountId: Id.optional(), carrierId: Id.optional(), statementId: Id.optional(),
  matchStatus: z.enum(MATCH_STATUS).optional(), direction: z.enum(['in', 'out']).optional(),
  q: z.string().trim().max(100).optional(),            // descripción o referencia
});

/** Paso 1: el archivo ya subido (context 'bank_statement') + mapeo opcional (si falta, el guardado de la cuenta) */
export const ImportPreviewBody = z.object({ accountId: Id, fileId: Id, mapping: CsvMapping.optional() });
/** Paso 2: importa las filas válidas no duplicadas como un estado de cuenta */
export const ImportCommitBody = z.object({
  accountId: Id, fileId: Id, mapping: CsvMapping,
  saveMapping: z.boolean().default(true),
  periodFrom: Day.optional(), periodTo: Day.optional(),   // por defecto, la primera y última fecha del archivo
  carriers: z.array(z.object({ line: z.number().int().min(1), carrierId: Id.nullable() })).max(5_000).optional(),   // correcciones a la sugerencia
});
export const BankStatementsQuery = z.object({ accountId: Id.optional() });

// ═══════════════════════════ Resumen ═══════════════════════════

/** Periodo del resumen; sin `from`/`to` = sin límite por ese lado (atajo "Todas") */
export const FinanceSummaryQuery = z.object({ from: Day.optional(), to: Day.optional() })
  .refine((q) => !q.from || !q.to || q.to >= q.from, { path: ['to'], message: 'El periodo termina antes de empezar' });

/** Próximo pago (gasto pendiente aprobado o corrida aprobada sin pagar) */
export type UpcomingPayment = {
  kind: 'expense' | 'payroll'; id: Id; date: Day; label: string; detail: string; amount: number;
  categoryId: Id | null;                  // solo gastos
  overdue: boolean;                       // corrida aprobada cuya fecha de pago ya pasó
};

/**
 * Flujo de caja del periodo según lo cargado en Kora (no contabilidad): entradas del banco − gastos pagados (por
 * `paid_at`, monto pagado) − nómina pagada (`payroll_lines.paid_at`, neto; categoría virtual "Nómina").
 * Próximos pagos, vencidos, por aprobar y la serie mensual no dependen del periodo (se miden desde hoy en Nueva York).
 */
export type FinanceSummary = {
  period: { from: Day | null; to: Day | null };
  today: Day;
  bank: {
    inflow: number; outflow: number;                                          // outflow en positivo
    inflowByCarrier: { carrierId: Id | null; amount: number; count: number }[];   // null = sin compañía
  };
  expenses: { paid: number; count: number; byCategory: { categoryId: Id; amount: number; count: number }[] };
  payroll: { paid: number; lines: number };
  result: number;                                                             // inflow − expenses.paid − payroll.paid
  /** Cuotas de comisión (no anuladas) con vencimiento en el periodo; null si el módulo de ventas está apagado */
  commissions: { expected: number; paid: number; count: number; paidCount: number } | null;
  upcoming: UpcomingPayment[];                                                // próximos 15 días (y corridas atrasadas)
  overdue: { count: number; amount: number };                                 // gastos aprobados pendientes con vencimiento < hoy
  pendingApprovals: number;                                                   // gastos por aprobar
  monthly: { month: string; inflow: number; spent: number }[];                // YYYY-MM, últimos 6 meses; spent = gastos + nómina
};
