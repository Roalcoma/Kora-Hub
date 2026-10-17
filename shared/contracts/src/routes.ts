// Mapa de rutas REST bajo /api/v1. Fuente de verdad para backend y frontend.
// Rutas con `/w/:slug` operan sobre ese workspace: el backend valida la membresía y fija el contexto RLS.
// `body`/`query` apuntan al esquema zod; `res` es la respuesta (204 = sin cuerpo).
import type { z } from 'zod';
import type * as P from './platform.ts';
import type * as C from './chat.ts';
import type * as F from './files.ts';
import type * as M from './modules.ts';
import type * as S from './sales.ts';
import type * as Fi from './finance.ts';
import type { Page, Id } from './common.ts';
import type { WsTicketResponse } from './realtime.ts';

type R<Body, Res, Query = never> = { body: Body; res: Res; query: Query };
type In<S extends z.ZodType> = z.input<S>;
type NoContent = 204;

export type Routes = {
  // ── Configuración pública (sin sesión) ──
  'GET /config': R<never, P.PublicConfig>;

  // ── Autenticación (sin workspace) ──
  'POST /auth/register': R<In<typeof P.RegisterBody>, P.Session & { workspaceSlug: string }>;
  'POST /auth/login': R<In<typeof P.LoginBody>, P.Session | { totpRequired: true }>;
  'POST /auth/logout': R<never, NoContent>;
  'POST /auth/logout-all': R<never, NoContent>;                 // sube token_version
  'POST /auth/forgot-password': R<In<typeof P.ForgotPasswordBody>, NoContent>;
  'POST /auth/reset-password': R<In<typeof P.ResetPasswordBody>, NoContent>;
  'GET /me': R<never, P.Session>;
  'PATCH /me': R<In<typeof P.UpdateProfileBody>, P.User>;
  'POST /me/totp/setup': R<never, { otpauthUrl: string; secret: string }>;
  'POST /me/totp/confirm': R<In<typeof P.TotpConfirmBody>, NoContent>;
  'DELETE /me/totp': R<In<typeof P.TotpConfirmBody>, NoContent>;
  'POST /me/push-subscriptions': R<{ endpoint: string; keys: { p256dh: string; auth: string } }, NoContent>;
  'DELETE /me/push-subscriptions': R<{ endpoint: string }, NoContent>;
  'POST /me/push-test': R<never, NoContent>;
  'GET /invitations/:token': R<never, { workspaceName: string; role: string; email: string | null; hasAccount: boolean }>;
  'POST /invitations/accept': R<In<typeof P.AcceptInvitationBody>, P.Session & { workspaceSlug: string }>;
  'GET /push/vapid-key': R<never, { publicKey: string }>;

  // ── Workspace ──
  'GET /w/:slug': R<never, P.Workspace & { me: P.Member; departments: P.Department[]; lines: P.BusinessLine[] }>;
  'PATCH /w/:slug': R<In<typeof P.UpdateWorkspaceBody>, P.Workspace>;                       // admin
  'PATCH /w/:slug/me': R<In<typeof P.UpdateMyMembershipBody>, P.Member>;
  'POST /w/:slug/ws-ticket': R<never, WsTicketResponse>;
  'GET /w/:slug/members': R<never, P.Member[]>;
  'PATCH /w/:slug/members/:userId': R<In<typeof P.UpdateMemberBody>, P.Member>;              // admin
  'POST /w/:slug/members': R<In<typeof P.CreateMemberBody>, P.Member & { existingAccount: boolean }>;   // admin
  'PUT /w/:slug/members/:userId/password': R<In<typeof P.SetMemberPasswordBody>, NoContent>;    // admin
  'POST /w/:slug/members/:userId/recovery-link': R<never, { url: string; expiresAt: string }>;  // admin: enlace para que elija su clave
  'POST /w/:slug/members/:userId/logout-all': R<never, NoContent>;                             // admin: cierra sus sesiones
  'GET /w/:slug/invitations': R<never, P.Invitation[]>;                                      // admin
  'POST /w/:slug/invitations': R<In<typeof P.CreateInvitationBody>, P.Invitation & { url: string }>;
  'DELETE /w/:slug/invitations/:id': R<never, NoContent>;
  'POST /w/:slug/departments': R<In<typeof P.DepartmentBody>, P.Department>;                // admin
  'PATCH /w/:slug/departments/:id': R<Partial<In<typeof P.DepartmentBody>> & { archived?: boolean }, P.Department>;
  'POST /w/:slug/lines': R<In<typeof P.BusinessLineBody>, P.BusinessLine>;                  // admin
  'PATCH /w/:slug/lines/:id': R<Partial<In<typeof P.BusinessLineBody>> & { archived?: boolean }, P.BusinessLine>;
  'POST /w/:slug/billing/checkout': R<In<typeof P.CheckoutBody>, { url: string }>;          // owner
  'POST /w/:slug/billing/portal': R<never, { url: string }>;                                // owner
  'GET /w/:slug/billing': R<never, P.BillingInfo>;                                          // admin
  'POST /w/:slug/billing/simulate': R<In<typeof P.SimulateBillingBody>, P.BillingInfo>;    // owner, solo modo simulado
  'POST /w/:slug/export': R<never, { jobId: string }>;                                      // owner, avisa por email
  'GET /w/:slug/search-all': R<never, { people: P.Member[]; channels: C.Channel[]; messages: C.SearchResult[]; documents: M.DocumentNode[]; tasks: M.Task[] }, { q: string }>;

  // ── Chat ──
  'GET /w/:slug/channels': R<never, C.Channel[]>;                                            // los míos + públicos
  'POST /w/:slug/channels': R<In<typeof C.CreateChannelBody>, C.Channel>;
  'PATCH /w/:slug/channels/:id': R<In<typeof C.UpdateChannelBody>, C.Channel>;
  'POST /w/:slug/channels/:id/join': R<never, C.Channel>;
  'POST /w/:slug/channels/:id/leave': R<never, NoContent>;
  'GET /w/:slug/channels/:id/members': R<never, Id[]>;
  'POST /w/:slug/channels/:id/members': R<In<typeof C.ChannelMembersBody>, NoContent>;
  'DELETE /w/:slug/channels/:id/members/:userId': R<never, NoContent>;
  'PATCH /w/:slug/channels/:id/me': R<In<typeof C.MyChannelPrefsBody>, C.Channel>;
  'POST /w/:slug/channels/:id/read': R<In<typeof C.MarkReadBody>, NoContent>;
  'POST /w/:slug/dms': R<In<typeof C.OpenDmBody>, C.Channel>;
  'GET /w/:slug/channels/:id/messages': R<never, Page<C.Message>, In<typeof C.ListMessagesQuery>>;
  'GET /w/:slug/channels/:id/pins': R<never, C.Message[]>;
  'POST /w/:slug/channels/:id/messages': R<In<typeof C.PostMessageBody>, C.Message>;
  'GET /w/:slug/messages/:id/replies': R<never, Page<C.Message>, In<typeof C.ListMessagesQuery>>;
  'PATCH /w/:slug/messages/:id': R<In<typeof C.EditMessageBody>, C.Message>;                 // autor
  'DELETE /w/:slug/messages/:id': R<never, NoContent>;                                       // autor o admin
  'POST /w/:slug/messages/:id/reactions': R<In<typeof C.ReactionBody>, C.Reaction[]>;       // alterna
  'POST /w/:slug/messages/:id/pin': R<In<typeof C.PinBody>, NoContent>;
  'DELETE /w/:slug/messages/:id/pin': R<never, NoContent>;
  'POST /w/:slug/messages/:id/ack': R<never, NoContent>;                                     // "Entendido"
  'GET /w/:slug/messages/:id/acks': R<never, C.AckStatus>;                                   // autor, lead, admin
  'GET /w/:slug/mentions': R<never, Page<C.Message>, { before?: string }>;                   // pestaña Menciones (móvil)
  'GET /w/:slug/search': R<never, C.SearchResult[], In<typeof C.SearchQuery>>;

  // ── Archivos ──
  'POST /w/:slug/files': R<In<typeof F.CreateUploadBody>, F.CreateUploadResponse>;
  'POST /w/:slug/files/:id/complete': R<never, F.FileRef>;
  'GET /w/:slug/files/:id': R<never, never>;                                                  // 302 a URL prefirmada
  'GET /w/:slug/files/:id/office': R<never, F.OfficeView>;

  // ── Manuales ──
  'GET /w/:slug/documents': R<never, M.DocumentNode[], In<typeof M.ListDocumentsQuery>>;
  'POST /w/:slug/documents': R<In<typeof M.CreateDocumentBody>, M.Document>;                // lead del depto, admin
  'GET /w/:slug/documents/:id': R<never, M.Document>;
  'PATCH /w/:slug/documents/:id': R<In<typeof M.UpdateDocumentBody>, M.Document>;
  'GET /w/:slug/documents/:id/versions': R<never, M.DocumentVersion[]>;
  'GET /w/:slug/documents/:id/versions/:versionId': R<never, M.DocumentVersionDetail>;
  'POST /w/:slug/documents/:id/versions/:versionId/restore': R<never, M.Document>;

  // ── Tareas ──
  'GET /w/:slug/tasks': R<never, M.Task[], In<typeof M.ListTasksQuery>>;
  'POST /w/:slug/tasks': R<In<typeof M.CreateTaskBody>, M.Task>;
  'GET /w/:slug/tasks/:id': R<never, M.Task & { comments: M.TaskComment[] }>;
  'PATCH /w/:slug/tasks/:id': R<In<typeof M.UpdateTaskBody>, M.Task>;
  'DELETE /w/:slug/tasks/:id': R<never, NoContent>;
  'POST /w/:slug/tasks/:id/comments': R<In<typeof M.TaskCommentBody>, M.TaskComment>;
  'POST /w/:slug/tasks/:id/checklist': R<In<typeof M.ChecklistItemBody>, M.ChecklistItem>;
  'PATCH /w/:slug/tasks/:id/checklist/:itemId': R<In<typeof M.UpdateChecklistItemBody>, M.ChecklistItem>;
  'DELETE /w/:slug/tasks/:id/checklist/:itemId': R<never, NoContent>;

  // ── Metas ──
  'GET /w/:slug/goals': R<never, M.Goal[], In<typeof M.GoalsQuery>>;
  'POST /w/:slug/goals': R<In<typeof M.GoalBody>, M.Goal>;                                   // admin
  'PATCH /w/:slug/goals/:id': R<In<typeof M.UpdateGoalBody>, M.Goal>;                        // admin
  'GET /w/:slug/reports': R<never, M.WeeklyReport[], In<typeof M.ReportsQuery>>;
  'PUT /w/:slug/reports': R<In<typeof M.SubmitReportBody>, M.WeeklyReport>;                  // lead del depto; admin edita histórico
  'GET /w/:slug/goals/dashboard': R<never, M.GoalsDashboard, In<typeof M.DashboardQuery>>;
  'GET /w/:slug/goals/dashboard.csv': R<never, string, In<typeof M.DashboardQuery>>;

  // ── Ventas y comisiones (solo con settings.salesModule) ──
  'GET /w/:slug/carriers': R<never, S.Carrier[]>;
  'POST /w/:slug/carriers': R<In<typeof S.CarrierBody>, S.Carrier>;                          // admin
  'PATCH /w/:slug/carriers/:id': R<In<typeof S.UpdateCarrierBody>, S.Carrier>;               // admin
  'POST /w/:slug/carriers/:id/products': R<In<typeof S.ProductBody>, S.Carrier>;             // admin
  'PATCH /w/:slug/products/:id': R<In<typeof S.UpdateProductBody>, S.Carrier>;               // admin
  'PUT /w/:slug/products/:id/grid': R<In<typeof S.GridBody>, S.Carrier>;                     // admin
  'GET /w/:slug/agents': R<never, S.Agent[]>;                                                // admin: todos; resto: el suyo y su equipo
  'POST /w/:slug/agents': R<In<typeof S.AgentBody>, S.Agent>;                                 // admin
  'PATCH /w/:slug/agents/:id': R<In<typeof S.UpdateAgentBody>, S.Agent>;                      // admin
  'POST /w/:slug/agents/:id/levels': R<In<typeof S.LevelBody>, S.Agent>;                      // admin
  'GET /w/:slug/sales': R<never, S.SalesList, In<typeof S.SalesQuery>>;                      // admin: todas; dueño: suyas y de sus agentes; resto: suyas
  'GET /w/:slug/sales.csv': R<never, string, In<typeof S.SalesQuery>>;
  'POST /w/:slug/sales': R<In<typeof S.SaleBody>, S.Sale>;                                   // admin
  'PATCH /w/:slug/sales/:id': R<In<typeof S.UpdateSaleBody>, S.Sale>;                        // admin, solo pendientes
  'POST /w/:slug/sales/:id/issue': R<In<typeof S.IssueSaleBody>, S.Sale>;                    // admin; genera las cuotas
  'POST /w/:slug/sales/:id/decline': R<never, S.Sale>;                                       // admin, solo pendientes
  'POST /w/:slug/sales/:id/cancel': R<In<typeof S.CancelSaleBody>, S.Sale>;                  // admin, ISSUED → chargeback
  'GET /w/:slug/commissions': R<never, S.CommissionsList, In<typeof S.CommissionsQuery>>;    // mismas reglas de visibilidad
  'GET /w/:slug/commissions.csv': R<never, string, In<typeof S.CommissionsQuery>>;
  'POST /w/:slug/commissions/pay': R<In<typeof S.PayInstallmentsBody>, NoContent>;           // admin
  'GET /w/:slug/sales-inbox': R<never, S.InboxItem[]>;                                       // admin
  'POST /w/:slug/sales-inbox/:id/dismiss': R<never, NoContent>;                              // admin
  'POST /w/:slug/sales-inbox/:id/link': R<In<typeof S.LinkInboxAuthorBody>, { created: number }>;  // admin: enlaza al autor y reintenta sus mensajes
  'POST /w/:slug/sales-inbox/retry': R<never, { created: number }>;                           // admin: tras agregar alias o productos
  'GET /w/:slug/discord-feed': R<never, S.DiscordFeed>;                                       // admin
  'PUT /w/:slug/discord-feed': R<In<typeof S.DiscordFeedBody>, S.DiscordFeed>;               // admin
  'DELETE /w/:slug/discord-feed': R<never, NoContent>;                                        // admin

  // ── Finanzas (solo con settings.financeModule; Owner, Admin y Contable — el resto 403) ──
  // "admin" = solo Owner/Admin (aprobar o rechazar lo cargado por un Contable).
  'GET /w/:slug/finance/vendors': R<never, string[], { q?: string }>;                         // autocompletado de proveedores
  'GET /w/:slug/finance/expense-categories': R<never, Fi.ExpenseCategory[]>;
  'POST /w/:slug/finance/expense-categories': R<In<typeof Fi.ExpenseCategoryBody>, Fi.ExpenseCategory>;
  'PATCH /w/:slug/finance/expense-categories/:id': R<In<typeof Fi.UpdateExpenseCategoryBody>, Fi.ExpenseCategory>;
  'GET /w/:slug/finance/expense-schedules': R<never, Fi.ExpenseSchedule[]>;
  'POST /w/:slug/finance/expense-schedules': R<In<typeof Fi.ExpenseScheduleBody>, Fi.ExpenseSchedule>;          // Contable → por aprobar
  'PATCH /w/:slug/finance/expense-schedules/:id': R<In<typeof Fi.UpdateExpenseScheduleBody>, Fi.ExpenseSchedule>;  // Contable cambia monto → por aprobar
  'POST /w/:slug/finance/expense-schedules/:id/approve': R<never, Fi.ExpenseSchedule>;        // admin; genera ocurrencias
  'POST /w/:slug/finance/expense-schedules/:id/reject': R<never, Fi.ExpenseSchedule>;         // admin
  'GET /w/:slug/finance/expenses': R<never, Fi.ExpensesList, In<typeof Fi.ExpensesQuery>>;
  'GET /w/:slug/finance/expenses.csv': R<never, string, In<typeof Fi.ExpensesQuery>>;
  'POST /w/:slug/finance/expenses': R<In<typeof Fi.ExpenseBody>, Fi.Expense>;                // Contable → por aprobar
  'PATCH /w/:slug/finance/expenses/:id': R<In<typeof Fi.UpdateExpenseBody>, Fi.Expense>;     // Contable cambia monto de uno aprobado → por aprobar
  'DELETE /w/:slug/finance/expenses/:id': R<never, NoContent>;                               // solo únicos no pagados; las ocurrencias se saltan
  'POST /w/:slug/finance/expenses/:id/approve': R<never, Fi.Expense>;                        // admin
  'POST /w/:slug/finance/expenses/:id/reject': R<never, Fi.Expense>;                         // admin
  'POST /w/:slug/finance/expenses/:id/pay': R<In<typeof Fi.PayExpenseBody>, Fi.Expense>;    // solo aprobados
  'POST /w/:slug/finance/expenses/:id/skip': R<never, Fi.Expense>;
  'POST /w/:slug/finance/expenses/:id/reopen': R<never, Fi.Expense>;                         // pagado o saltado → pendiente

  'GET /w/:slug/finance/payroll/calendars': R<never, Fi.PayrollCalendar[]>;
  'POST /w/:slug/finance/payroll/calendars': R<In<typeof Fi.PayrollCalendarBody>, Fi.PayrollCalendar>;
  'PATCH /w/:slug/finance/payroll/calendars/:id': R<In<typeof Fi.UpdatePayrollCalendarBody>, Fi.PayrollCalendar>;
  'GET /w/:slug/finance/payroll/people': R<never, Fi.PayrollPerson[]>;
  'POST /w/:slug/finance/payroll/people': R<In<typeof Fi.PayrollPersonBody>, Fi.PayrollPerson>;
  'PATCH /w/:slug/finance/payroll/people/:id': R<In<typeof Fi.UpdatePayrollPersonBody>, Fi.PayrollPerson>;
  'POST /w/:slug/finance/payroll/people/:id/components': R<In<typeof Fi.PayrollComponentBody>, Fi.PayrollPerson>;
  'PATCH /w/:slug/finance/payroll/components/:id': R<In<typeof Fi.UpdatePayrollComponentBody>, Fi.PayrollPerson>;
  'DELETE /w/:slug/finance/payroll/components/:id': R<never, Fi.PayrollPerson>;              // las corridas aprobadas no cambian
  'GET /w/:slug/finance/payroll/runs': R<never, Fi.PayrollRun[], In<typeof Fi.PayrollRunsQuery>>;
  'POST /w/:slug/finance/payroll/runs': R<In<typeof Fi.PayrollRunBody>, Fi.PayrollRunDetail>;       // borrador calculado
  'GET /w/:slug/finance/payroll/runs/:id': R<never, Fi.PayrollRunDetail>;
  'PATCH /w/:slug/finance/payroll/runs/:id': R<In<typeof Fi.UpdatePayrollRunBody>, Fi.PayrollRunDetail>;   // borrador
  'DELETE /w/:slug/finance/payroll/runs/:id': R<never, NoContent>;                                      // borrador
  'POST /w/:slug/finance/payroll/runs/:id/recalculate': R<never, Fi.PayrollRunDetail>;                  // borrador: relee componentes, comisiones y personas
  'PATCH /w/:slug/finance/payroll/runs/:id/lines/:lineId': R<In<typeof Fi.UpdatePayrollLineBody>, Fi.PayrollRunDetail>;   // horas, borrador
  'POST /w/:slug/finance/payroll/runs/:id/adjustments': R<In<typeof Fi.PayrollAdjustmentBody>, Fi.PayrollRunDetail>;      // borrador
  'DELETE /w/:slug/finance/payroll/runs/:id/adjustments/:adjustmentId': R<never, Fi.PayrollRunDetail>;                    // borrador
  'POST /w/:slug/finance/payroll/runs/:id/approve': R<In<typeof Fi.ApprovePayrollRunBody>, Fi.PayrollRunDetail>;   // congela líneas y desglose; 409 run_changed
  'POST /w/:slug/finance/payroll/runs/:id/reopen': R<never, Fi.PayrollRunDetail>;                       // aprobada sin pagos → borrador
  'POST /w/:slug/finance/payroll/runs/:id/pay': R<In<typeof Fi.PayPayrollBody>, Fi.PayrollRunDetail>;   // por línea o toda
  'GET /w/:slug/finance/payroll/runs/:id/export.csv': R<never, string>;

  'GET /w/:slug/finance/bank/accounts': R<never, Fi.BankAccount[]>;
  'POST /w/:slug/finance/bank/accounts': R<In<typeof Fi.BankAccountBody>, Fi.BankAccount>;
  'PATCH /w/:slug/finance/bank/accounts/:id': R<In<typeof Fi.UpdateBankAccountBody>, Fi.BankAccount>;
  'GET /w/:slug/finance/bank/accounts/:id/csv-mapping': R<never, Fi.CsvMapping | null>;
  'PUT /w/:slug/finance/bank/accounts/:id/csv-mapping': R<In<typeof Fi.CsvMapping>, Fi.CsvMapping>;
  'GET /w/:slug/finance/bank/transactions': R<never, Fi.BankTransactionsList, In<typeof Fi.BankTransactionsQuery>>;
  'GET /w/:slug/finance/bank/transactions.csv': R<never, string, In<typeof Fi.BankTransactionsQuery>>;
  'POST /w/:slug/finance/bank/transactions': R<In<typeof Fi.BankTransactionBody>, Fi.BankTransaction & { possibleDuplicate: boolean }>;
  'PATCH /w/:slug/finance/bank/transactions/:id': R<In<typeof Fi.UpdateBankTransactionBody>, Fi.BankTransaction>;
  'DELETE /w/:slug/finance/bank/transactions/:id': R<never, NoContent>;                      // solo manuales; los de CSV se van deshaciendo el estado
  'POST /w/:slug/finance/bank/import/preview': R<In<typeof Fi.ImportPreviewBody>, Fi.ImportPreview>;
  'POST /w/:slug/finance/bank/import/commit': R<In<typeof Fi.ImportCommitBody>, Fi.BankStatement>;
  'GET /w/:slug/finance/bank/statements': R<never, Fi.BankStatement[], In<typeof Fi.BankStatementsQuery>>;
  'DELETE /w/:slug/finance/bank/statements/:id': R<never, NoContent>;                        // deshace la importación completa
  'GET /w/:slug/finance/summary': R<never, Fi.FinanceSummary, In<typeof Fi.FinanceSummaryQuery>>;     // flujo de caja del periodo + próximos pagos

  // ── Webhooks y superadmin (fuera de workspace) ──
  'POST /webhooks/stripe': R<unknown, NoContent>;                                             // firma verificada
  'GET /admin/workspaces': R<never, P.AdminWorkspace[], { q?: string; status?: P.WorkspaceStatus }>;
  'POST /admin/workspaces/:id/status': R<In<typeof P.AdminStatusBody>, NoContent>;
  'PATCH /admin/workspaces/:id': R<In<typeof P.AdminWorkspaceBody>, NoContent>;               // crmLink; audit_log
  'POST /admin/workspaces/:id/impersonate': R<In<typeof P.ImpersonateBody>, P.Session & { workspaceSlug: string }>;  // como el Owner; 30 min; audit_log
  'POST /admin/impersonation/end': R<never, P.Session>;                                       // vuelve a la sesión del superadmin
  'GET /admin/metrics': R<never, P.AdminMetrics>;

  // ── Operación ──
  'GET /health': R<never, { ok: true; db: boolean }>;
};

export type RouteKey = keyof Routes;
