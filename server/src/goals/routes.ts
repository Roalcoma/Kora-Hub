// /w/:slug/goals y /reports — metas semanales, reportes de los Líderes y tablero de cumplimiento (§5.5).
// El reporte copia el objetivo vigente al entregarse: si la meta cambia después, el histórico no se mueve.
// Líder: su departamento, semana actual y la anterior (se reporta el lunes). Más atrás solo Admin, con auditoría.
import { Router, type Request } from 'express';
import type pg from 'pg';
import {
  Id, GoalBody, UpdateGoalBody, GoalsQuery, ReportsQuery, SubmitReportBody, DashboardQuery,
  type Goal, type WeeklyReport, type GoalsDashboard,
} from '@agencia-hub/contracts';
import { HttpError, parse } from '../platform/http.ts';
import { tx, canManageDept, isAdmin, requireRole, membersOnly } from '../platform/workspace.ts';
import { audit } from '../platform/model.ts';

export const goalsRouter = Router({ mergeParams: true });
goalsRouter.use(['/goals', '/reports'], membersOnly);

// ponytail: semana en horario de Nueva York para todas las agencias; zona por workspace si llegan clientes de otra costa
export const CURRENT_WEEK = `date_trunc('week', now() at time zone 'America/New_York')::date`;

const toGoal = (r: any): Goal => ({
  id: r.id, departmentId: r.department_id, lineId: r.line_id, name: r.name, unit: r.unit,
  weeklyTarget: Number(r.weekly_target), position: r.position, archivedAt: r.archived_at?.toISOString() ?? null,
});

async function listReports(db: pg.PoolClient, where: string, vals: unknown[]): Promise<WeeklyReport[]> {
  const { rows } = await db.query(
    `select r.*, to_char(r.week_start, 'YYYY-MM-DD') as wk, coalesce(json_agg(json_build_object('goalId', i.goal_id, 'target', i.target, 'actual', i.actual, 'note', i.note))
       filter (where i.goal_id is not null), '[]') as items
     from weekly_reports r left join weekly_report_items i on i.report_id = r.id
     where ${where} group by r.id order by r.week_start desc, r.department_id`, vals);
  return rows.map((r) => ({
    id: r.id, departmentId: r.department_id, weekStart: r.wk, notes: r.notes, submittedBy: r.submitted_by,
    submittedAt: r.submitted_at.toISOString(),
    items: r.items.map((i: any) => ({ ...i, target: Number(i.target), actual: Number(i.actual) })),
  }));
}

// ─── Metas (Admin) ───

goalsRouter.get('/goals', async (req, res) => {
  const q = parse(GoalsQuery, req.query);
  res.json(await tx(req, async (db) => (await db.query(
    `select * from goals where ($1::uuid is null or department_id = $1) and ($2 or archived_at is null) order by position, name`,
    [q.departmentId ?? null, q.includeArchived ?? false])).rows.map(toGoal)));
});

goalsRouter.post('/goals', async (req, res) => {
  requireRole(req, 'admin');
  const body = parse(GoalBody, req.body);
  res.status(201).json(await tx(req, async (db) => toGoal((await db.query(
    `insert into goals (workspace_id, department_id, line_id, name, unit, weekly_target, position)
     values (app_ws(), $1, $2, $3, $4, $5, coalesce($6, (select coalesce(max(position) + 1, 0) from goals where department_id = $1)))
     returning *`,
    [body.departmentId, body.lineId, body.name, body.unit, body.weeklyTarget, body.position ?? null])).rows[0])));
});

goalsRouter.patch('/goals/:id', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const body = parse(UpdateGoalBody, req.body);
  res.json(await tx(req, async (db) => {
    const { rows } = await db.query(
      `update goals set department_id = coalesce($2, department_id), line_id = case when $3 then $4 else line_id end,
         name = coalesce($5, name), unit = coalesce($6, unit), weekly_target = coalesce($7, weekly_target),
         position = coalesce($8, position),
         archived_at = case when $9::boolean is null then archived_at when $9 then coalesce(archived_at, now()) else null end
       where id = $1 returning *`,
      [id, body.departmentId ?? null, body.lineId !== undefined, body.lineId ?? null, body.name ?? null, body.unit ?? null,
        body.weeklyTarget ?? null, body.position ?? null, body.archived ?? null]);
    if (!rows[0]) throw new HttpError(404, 'goal_not_found', 'Meta no encontrada');
    return toGoal(rows[0]);
  }));
});

// ─── Reportes semanales ───

goalsRouter.get('/reports', async (req, res) => {
  const q = parse(ReportsQuery, req.query);
  res.json(await tx(req, (db) => listReports(db,
    '($1::uuid is null or r.department_id = $1) and ($2::date is null or r.week_start = $2)',
    [q.departmentId ?? null, q.weekStart ?? null])));
});

goalsRouter.put('/reports', async (req, res) => {
  const body = parse(SubmitReportBody, req.body);
  res.json(await tx(req, async (db) => {
    if (!(await canManageDept(db, req, body.departmentId))) throw new HttpError(403, 'forbidden', 'Solo el Líder del departamento o un Admin reporta');
    // Fechas como texto: pg convierte `date` a medianoche local y puede correr el día
    const { cur } = (await db.query(`select to_char(${CURRENT_WEEK}, 'YYYY-MM-DD') as cur`)).rows[0];
    const weeksBack = Math.round((Date.parse(cur) - Date.parse(body.weekStart)) / (7 * 86400_000));
    if (weeksBack < 0) throw new HttpError(400, 'future_week', 'No se puede reportar una semana que no empezó');
    if (weeksBack > 1 && !isAdmin(req)) throw new HttpError(403, 'report_locked', 'Esta semana ya cerró: solo un Admin puede corregirla');

    const prev = (await db.query(
      'select id from weekly_reports where department_id = $1 and week_start = $2 for update', [body.departmentId, body.weekStart])).rows[0];
    const { rows } = await db.query(
      `insert into weekly_reports (workspace_id, department_id, week_start, notes, submitted_by)
       values (app_ws(), $1, $2, $3, app_user())
       on conflict (workspace_id, department_id, week_start)
       do update set notes = excluded.notes, submitted_by = excluded.submitted_by, updated_at = now()
       returning id`, [body.departmentId, body.weekStart, body.notes]);
    const reportId = rows[0].id;

    for (const item of body.items) {
      // La meta debe ser del departamento. El objetivo se copia solo la primera vez (histórico fijo).
      const { rowCount } = await db.query(
        `insert into weekly_report_items (workspace_id, report_id, goal_id, target, actual, note)
         select app_ws(), $1, g.id, g.weekly_target, $3, $4 from goals g where g.id = $2 and g.department_id = $5
         on conflict (report_id, goal_id) do update set actual = excluded.actual, note = excluded.note`,
        [reportId, item.goalId, item.actual, item.note, body.departmentId]);
      if (!rowCount) throw new HttpError(400, 'invalid_goal', 'Una de las metas no es de este departamento');
    }
    if (prev && weeksBack > 1) {
      await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'report.edited', targetType: 'weekly_report', targetId: reportId,
        meta: { weekStart: body.weekStart, items: body.items }, ip: req.ip });
    }
    return (await listReports(db, 'r.id = $1', [reportId]))[0]!;
  }));
});

// ─── Tablero ───

async function dashboard(req: Request, q: ReturnType<typeof DashboardQuery.parse>): Promise<GoalsDashboard> {
  return tx(req, async (db) => {
    const weeks: string[] = (await db.query(
      `select to_char(w, 'YYYY-MM-DD') as w from generate_series(${CURRENT_WEEK} - ($1 - 1) * 7, ${CURRENT_WEEK}, interval '7 days') w`,
      [q.weeks])).rows.map((r) => r.w);
    const goals = (await db.query(
      `select * from goals g
       where ($1::uuid is null or g.department_id = $1) and ($2::uuid is null or g.line_id = $2)
         and (g.archived_at is null or exists (
           select 1 from weekly_report_items i join weekly_reports r on r.id = i.report_id
           where i.goal_id = g.id and r.week_start >= $3::date))
       order by g.department_id, g.position, g.name`,
      [q.departmentId ?? null, q.lineId ?? null, weeks[0]])).rows;
    const reports = await listReports(db, 'r.week_start >= $1::date and ($2::uuid is null or r.department_id = $2)', [weeks[0], q.departmentId ?? null]);
    const byKey = new Map(reports.map((r) => [`${r.departmentId}|${r.weekStart}`, r]));

    const rows = goals.map((g) => ({
      departmentId: g.department_id, lineId: g.line_id, goalId: g.id, name: g.name, unit: g.unit,
      series: weeks.map((w) => {
        const item = byKey.get(`${g.department_id}|${w}`)?.items.find((i) => i.goalId === g.id);
        return { weekStart: w, target: item?.target ?? Number(g.weekly_target), actual: item?.actual ?? null };
      }),
    }));
    const activeDepts = [...new Set(goals.filter((g) => !g.archived_at).map((g) => g.department_id as string))];
    const missingReports = activeDepts.flatMap((d) => weeks.filter((w) => !byKey.has(`${d}|${w}`)).map((w) => ({ departmentId: d, weekStart: w })));
    return { weeks, rows, missingReports };
  });
}

goalsRouter.get('/goals/dashboard', async (req, res) => {
  res.json(await dashboard(req, parse(DashboardQuery, req.query)));
});

goalsRouter.get('/goals/dashboard.csv', async (req, res) => {
  const d = await dashboard(req, parse(DashboardQuery, req.query));
  const names = await tx(req, async (db) => new Map([
    ...(await db.query('select id, name from departments')).rows,
    ...(await db.query('select id, name from business_lines')).rows,
  ].map((r) => [r.id, r.name])));
  // Comillas siempre; los textos que empiezan con = + - @ se prefijan con ' para que Excel no los ejecute
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const lines = [['Departamento', 'Línea', 'Meta', 'Unidad', 'Semana', 'Objetivo', 'Logrado', 'Cumplimiento %']];
  for (const r of d.rows) {
    for (const s of r.series) {
      lines.push([names.get(r.departmentId) ?? '', r.lineId ? names.get(r.lineId) ?? '' : '', r.name, r.unit, s.weekStart,
        String(s.target), s.actual == null ? '' : String(s.actual), s.actual == null ? '' : String(Math.round((s.actual / s.target) * 100))]);
    }
  }
  res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="metas.csv"' });
  res.send('﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n'));
});
