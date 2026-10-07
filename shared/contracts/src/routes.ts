// Mapa de rutas REST bajo /api/v1. Fuente de verdad para backend y frontend.
// Rutas con `/w/:slug` operan sobre ese workspace: el backend valida la membresía y fija el contexto RLS.
// `body`/`query` apuntan al esquema zod; `res` es la respuesta (204 = sin cuerpo).
import type { z } from 'zod';
import type * as P from './platform.ts';
import type * as C from './chat.ts';
import type * as F from './files.ts';
import type * as M from './modules.ts';
import type { Page, Id } from './common.ts';
import type { WsTicketResponse } from './realtime.ts';

type R<Body, Res, Query = never> = { body: Body; res: Res; query: Query };
type In<S extends z.ZodType> = z.input<S>;
type NoContent = 204;

export type Routes = {
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
  'GET /w/:slug/invitations': R<never, P.Invitation[]>;                                      // admin
  'POST /w/:slug/invitations': R<In<typeof P.CreateInvitationBody>, P.Invitation & { url: string }>;
  'DELETE /w/:slug/invitations/:id': R<never, NoContent>;
  'POST /w/:slug/departments': R<In<typeof P.DepartmentBody>, P.Department>;                // admin
  'PATCH /w/:slug/departments/:id': R<Partial<In<typeof P.DepartmentBody>> & { archived?: boolean }, P.Department>;
  'POST /w/:slug/lines': R<In<typeof P.BusinessLineBody>, P.BusinessLine>;                  // admin
  'PATCH /w/:slug/lines/:id': R<Partial<In<typeof P.BusinessLineBody>> & { archived?: boolean }, P.BusinessLine>;
  'POST /w/:slug/billing/checkout': R<In<typeof P.CheckoutBody>, { url: string }>;          // owner
  'POST /w/:slug/billing/portal': R<never, { url: string }>;                                // owner
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

  // ── Webhooks y superadmin (fuera de workspace) ──
  'POST /webhooks/stripe': R<unknown, NoContent>;                                             // firma verificada
  'GET /admin/workspaces': R<never, (P.Workspace & { members: number; storageBytes: number; mrrCents: number })[]>;
  'POST /admin/workspaces/:id/status': R<{ status: 'active' | 'suspended' }, NoContent>;
  'POST /admin/workspaces/:id/impersonate': R<{ reason: string }, P.Session>;                 // queda en audit_log
  'GET /admin/metrics': R<never, { mrrCents: number; activeWorkspaces: number; trials: number; churn30d: number }>;
};

export type RouteKey = keyof Routes;
