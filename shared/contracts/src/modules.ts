// Manuales (§5.3), tareas (§5.4) y metas (§5.5).
import { z } from 'zod';
import { Id, type IsoDate } from './common.ts';
import type { FileRef } from './files.ts';

// ═══ Manuales ═══

export type DocumentNode = { id: Id; parentId: Id | null; title: string; position: number; lineId: Id | null; departmentId: Id };
export type Document = DocumentNode & {
  content: unknown;          // JSON de Tiptap
  files: FileRef[];
  updatedBy: Id; updatedAt: IsoDate; canEdit: boolean;
};
export type DocumentVersion = { id: Id; title: string; editedBy: Id; createdAt: IsoDate };

export const ListDocumentsQuery = z.object({ departmentId: Id.optional(), lineId: Id.optional(), q: z.string().max(200).optional() });
export const CreateDocumentBody = z.object({
  departmentId: Id, parentId: Id.nullable().default(null), lineId: Id.nullable().default(null),
  title: z.string().trim().min(1).max(200), content: z.unknown().optional(),
});
export const UpdateDocumentBody = z.object({
  title: z.string().trim().min(1).max(200), content: z.unknown(),
  parentId: Id.nullable(), position: z.number().int(), lineId: Id.nullable(),
  fileIds: z.array(Id).max(50), archived: z.boolean(),
}).partial();

// ═══ Tareas ═══

export const TASK_STATUS = ['todo', 'doing', 'done', 'cancelled'] as const;
export const TASK_PRIORITY = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];
export type TaskPriority = (typeof TASK_PRIORITY)[number];

export type ChecklistItem = { id: Id; text: string; done: boolean; position: number };
export type TaskComment = { id: Id; userId: Id; body: string; createdAt: IsoDate; editedAt: IsoDate | null };
export type Task = {
  id: Id; departmentId: Id; lineId: Id | null; title: string; description: string;
  status: TaskStatus; priority: TaskPriority; dueAt: IsoDate | null; position: number;
  assigneeIds: Id[]; checklist: ChecklistItem[]; commentCount: number;
  sourceMessageId: Id | null; createdBy: Id; completedAt: IsoDate | null; createdAt: IsoDate; updatedAt: IsoDate;
};

export const ListTasksQuery = z.object({
  departmentId: Id.optional(), lineId: Id.optional(), status: z.enum(TASK_STATUS).optional(),
  mine: z.coerce.boolean().optional(),   // vista "Mis tareas"
});
export const CreateTaskBody = z.object({
  departmentId: Id, lineId: Id.nullable().default(null),
  title: z.string().trim().min(1).max(200), description: z.string().max(10_000).default(''),
  priority: z.enum(TASK_PRIORITY).default('normal'), dueAt: z.iso.datetime().nullable().default(null),
  assigneeIds: z.array(Id).max(20).default([]),
  checklist: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  sourceMessageId: Id.optional(),        // "Crear tarea" desde un mensaje
});
export const UpdateTaskBody = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(10_000),
  status: z.enum(TASK_STATUS), priority: z.enum(TASK_PRIORITY), dueAt: z.iso.datetime().nullable(),
  position: z.number(), lineId: Id.nullable(), assigneeIds: z.array(Id).max(20),
}).partial();
export const TaskCommentBody = z.object({ body: z.string().trim().min(1).max(5_000) });
export const ChecklistItemBody = z.object({ text: z.string().trim().min(1).max(300), done: z.boolean().default(false) });
export const UpdateChecklistItemBody = z.object({ text: z.string().trim().min(1).max(300), done: z.boolean(), position: z.number().int() }).partial();

// ═══ Metas y reportes semanales ═══

export type Goal = { id: Id; departmentId: Id; lineId: Id | null; name: string; unit: string; weeklyTarget: number; position: number; archivedAt: IsoDate | null };
export type WeeklyReport = {
  id: Id; departmentId: Id; weekStart: string; notes: string; submittedBy: Id; submittedAt: IsoDate;
  items: { goalId: Id; target: number; actual: number; note: string | null }[];
};
/** Agregado para el tablero: % de cumplimiento por departamento/línea y tendencia */
export type GoalsDashboard = {
  weeks: string[];                                   // últimos N lunes (YYYY-MM-DD), del más antiguo al actual
  rows: {
    departmentId: Id; lineId: Id | null; goalId: Id; name: string; unit: string;
    series: { weekStart: string; target: number; actual: number | null }[];   // null = sin reporte
  }[];
  missingReports: { departmentId: Id; weekStart: string }[];
};

const WeekStart = z.iso.date().refine((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1, 'Debe ser lunes');

export const GoalBody = z.object({
  departmentId: Id, lineId: Id.nullable().default(null),
  name: z.string().trim().min(1).max(120), unit: z.string().trim().min(1).max(40),
  weeklyTarget: z.number().positive(), position: z.number().int().optional(),
});
export const UpdateGoalBody = GoalBody.partial().extend({ archived: z.boolean().optional() });
export const SubmitReportBody = z.object({
  departmentId: Id, weekStart: WeekStart, notes: z.string().max(5_000).default(''),
  items: z.array(z.object({ goalId: Id, actual: z.number().min(0), note: z.string().max(500).nullable().default(null) })).min(1),
});
export const DashboardQuery = z.object({
  weeks: z.coerce.number().int().min(1).max(52).default(12),
  departmentId: Id.optional(), lineId: Id.optional(),
});
