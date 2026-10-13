// /w/:slug/finance/payroll — calendarios, personas con sus componentes y corridas (docs/plan-finanzas.md §3, ADR 0007).
// El guardián de routes.ts ya filtra módulo activo y rol (Owner, Admin, Contable). Aprobar y reabrir: solo Owner/Admin
// (el Contable prepara y paga, no aprueba). En borrador las líneas se recalculan; al aprobar quedan congeladas con su
// desglose, así que editar o borrar componentes después no toca las corridas aprobadas. El cálculo está en payroll-calc.ts.
import { createHash } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import {
  Id, PayrollCalendarBody, UpdatePayrollCalendarBody, PayrollPersonBody, UpdatePayrollPersonBody, PayrollComponentBody,
  UpdatePayrollComponentBody, PayrollRunBody, UpdatePayrollRunBody, UpdatePayrollLineBody, PayrollAdjustmentBody,
  PayPayrollBody, PayrollRunsQuery, ApprovePayrollRunBody,
  type PayrollCalendar, type PayrollPerson, type PayrollComponent, type PayrollRun, type PayrollRunDetail, type PayrollLine,
  type PayrollItem,
} from '@agencia-hub/contracts';
import { HttpError, parse, sendCsv } from '../platform/http.ts';
import { tx } from '../platform/workspace.ts';
import { audit } from '../platform/model.ts';
import { requireApprover } from './access.ts';
import { computeLine, nextPeriod, toCents, type CalcComponent } from './payroll-calc.ts';

export const payrollRouter = Router({ mergeParams: true });

// ponytail: "hoy" en Nueva York para todas las agencias, igual que ventas y metas
const TODAY = `(now() at time zone 'America/New_York')::date`;
const day = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;   // como texto: pg pasa `date` a medianoche local y corre el día
const num = (v: string | number | null) => (v == null ? null : Number(v));
const dollars = (cents: number) => cents / 100;
/** Máximo de numeric(12,2) en centavos: un bruto, deducción o neto mayor se rechaza con 400 en vez de un 500 (F6) */
const MAX_CENTS = 999_999_999_999;
/** Traduce violaciones de FK/unique a errores legibles */
const pgError = (e: any, messages: { unique?: [string, string]; fk?: [string, string] }) => {
  if (e?.code === '23505' && messages.unique) return new HttpError(409, ...messages.unique);
  if (e?.code === '23503' && messages.fk) return new HttpError(400, ...messages.fk);
  return e;
};

// ─── Calendarios ───

async function listCalendars(db: pg.PoolClient, id?: string): Promise<PayrollCalendar[]> {
  const { rows } = await db.query(
    `select c.*, ${day('c.anchor_date')} as anchor, ${day(TODAY)} as today,
       (select count(*)::int from payroll_people p where p.calendar_id = c.id and p.is_active) as people,
       coalesce((select json_agg(json_build_object('periodStart', ${day('r.period_start')}, 'periodEnd', ${day('r.period_end')}))
                 from payroll_runs r where r.calendar_id = c.id), '[]') as runs
     from payroll_calendars c where $1::uuid is null or c.id = $1 order by c.archived_at nulls first, c.name`, [id ?? null]);
  return rows.map((r) => {
    // monthly con pay_day null = último día del mes
    const payDay = r.frequency === 'monthly' ? (r.pay_day ?? 'last') : null;
    const rule = { frequency: r.frequency, anchorDate: r.anchor, payDay };
    return {
      id: r.id, name: r.name, frequency: r.frequency, anchorDate: r.anchor, payDay, archivedAt: r.archived_at?.toISOString() ?? null,
      people: r.people, nextPeriod: r.archived_at ? null : nextPeriod(rule, r.today, r.runs),
    };
  });
}
const oneCalendar = async (db: pg.PoolClient, id: string) => {
  const c = (await listCalendars(db, id))[0];
  if (!c) throw new HttpError(404, 'calendar_not_found', 'Calendario no encontrado');
  return c;
};
const payDayDb = (v: number | 'last' | null | undefined) => (v === 'last' ? null : v ?? null);
const calendarConflict: [string, string] = ['calendar_name_taken', 'Ya existe un calendario con ese nombre'];

payrollRouter.get('/payroll/calendars', async (req, res) => {
  res.json(await tx(req, (db) => listCalendars(db)));
});

payrollRouter.post('/payroll/calendars', async (req, res) => {
  const body = parse(PayrollCalendarBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    const { rows } = await db.query(
      'insert into payroll_calendars (workspace_id, name, frequency, anchor_date, pay_day) values (app_ws(), $1, $2, $3, $4) returning id',
      [body.name, body.frequency, body.anchorDate, payDayDb(body.payDay)]).catch((e) => { throw pgError(e, { unique: calendarConflict }); });
    return oneCalendar(db, rows[0].id);
  }));
});

payrollRouter.patch('/payroll/calendars/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(UpdatePayrollCalendarBody, req.body);
  res.json(await tx(req, async (db) => {
    const cur = await oneCalendar(db, id);
    const weekly = cur.frequency === 'weekly' || cur.frequency === 'biweekly';
    if (body.anchorDate !== undefined && weekly !== (body.anchorDate != null)) {
      throw new HttpError(400, 'invalid_anchor', 'La fecha ancla es solo, y obligatoria, en semanal y quincenal');
    }
    if (body.payDay != null && cur.frequency !== 'monthly') throw new HttpError(400, 'invalid_pay_day', 'El día de pago es solo para mensual');
    await db.query(
      `update payroll_calendars set name = coalesce($2, name),
         anchor_date = case when $3 then $4::date else anchor_date end, pay_day = case when $5 then $6::smallint else pay_day end,
         archived_at = case when $7::boolean is null then archived_at when $7 then coalesce(archived_at, now()) else null end
       where id = $1`,
      [id, body.name ?? null, body.anchorDate !== undefined, body.anchorDate ?? null, body.payDay !== undefined, payDayDb(body.payDay),
        body.archived ?? null]).catch((e) => { throw pgError(e, { unique: calendarConflict }); });
    return oneCalendar(db, id);
  }));
});

// ─── Personas y componentes ───

async function listPeople(db: pg.PoolClient, id?: string): Promise<PayrollPerson[]> {
  const { rows } = await db.query(
    `select p.*, ${day('p.hired_on')} as hired, ${day('p.terminated_on')} as terminated,
       coalesce((select json_agg(json_build_object('id', c.id, 'personId', c.person_id, 'kind', c.kind, 'label', c.label,
                   'amount', c.amount::float, 'rate', c.rate::float, 'effectiveFrom', ${day('c.effective_from')},
                   'effectiveTo', ${day('c.effective_to')}) order by c.effective_from desc, c.created_at desc)
                 from payroll_components c where c.person_id = p.id), '[]') as components
     from payroll_people p where $1::uuid is null or p.id = $1 order by p.is_active desc, p.name`, [id ?? null]);
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone, jobTitle: r.job_title, userId: r.user_id, calendarId: r.calendar_id,
    payMethod: r.pay_method, accountLast4: r.account_last4, hiredOn: r.hired, terminatedOn: r.terminated, isActive: r.is_active,
    components: r.components,
  }));
}
const onePerson = async (db: pg.PoolClient, id: string) => {
  const p = (await listPeople(db, id))[0];
  if (!p) throw new HttpError(404, 'person_not_found', 'Persona no encontrada');
  return p;
};
const personErrors = {
  unique: ['user_already_in_payroll', 'Ese usuario ya está enlazado a otra persona en nómina'] as [string, string],
  fk: ['invalid_reference', 'El usuario debe ser miembro de la agencia y el calendario debe existir'] as [string, string],
};
async function checkPersonRefs(db: pg.PoolClient, b: { userId?: string | null; calendarId?: string }) {
  if (b.userId && !(await db.query('select 1 from workspace_members where user_id = $1', [b.userId])).rowCount) {
    throw new HttpError(400, 'invalid_user', 'El usuario debe ser miembro de la agencia');
  }
  if (b.calendarId && !(await db.query('select 1 from payroll_calendars where id = $1', [b.calendarId])).rowCount) {
    throw new HttpError(400, 'invalid_calendar', 'Calendario no encontrado');
  }
}

payrollRouter.get('/payroll/people', async (req, res) => {
  res.json(await tx(req, (db) => listPeople(db)));
});

payrollRouter.post('/payroll/people', async (req, res) => {
  const b = parse(PayrollPersonBody, req.body);
  if (b.hiredOn && b.terminatedOn && b.terminatedOn < b.hiredOn) throw new HttpError(400, 'invalid_dates', 'La baja es anterior al alta');
  res.status(201).json(await tx(req, async (db) => {
    await checkPersonRefs(db, b);
    const { rows } = await db.query(
      `insert into payroll_people (workspace_id, name, email, phone, job_title, user_id, calendar_id, pay_method, account_last4,
         hired_on, terminated_on, is_active)
       values (app_ws(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [b.name, b.email, b.phone, b.jobTitle, b.userId, b.calendarId, b.payMethod, b.accountLast4, b.hiredOn, b.terminatedOn, b.isActive],
    ).catch((e) => { throw pgError(e, personErrors); });
    return onePerson(db, rows[0].id);
  }));
});

payrollRouter.patch('/payroll/people/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const b = parse(UpdatePayrollPersonBody, req.body);
  res.json(await tx(req, async (db) => {
    await onePerson(db, id);
    await checkPersonRefs(db, b);
    // Solo los campos que vinieron (null borra el dato)
    const cols: Record<string, unknown> = {
      name: b.name, email: b.email, phone: b.phone, job_title: b.jobTitle, user_id: b.userId, calendar_id: b.calendarId,
      pay_method: b.payMethod, account_last4: b.accountLast4, hired_on: b.hiredOn, terminated_on: b.terminatedOn, is_active: b.isActive,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    await db.query(
      `update payroll_people set ${set.map(([c], i) => `${c} = $${i + 2}`).concat('updated_at = now()').join(', ')} where id = $1`,
      [id, ...set.map(([, v]) => v)],
    ).catch((e) => {
      if (e?.code === '23514') throw new HttpError(400, 'invalid_dates', 'La baja es anterior al alta');
      throw pgError(e, personErrors);
    });
    return onePerson(db, id);
  }));
});

payrollRouter.post('/payroll/people/:id/components', async (req, res) => {
  const id = Id.parse(req.params.id);
  const b = parse(PayrollComponentBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    await onePerson(db, id);
    const { rows } = await db.query(
      `insert into payroll_components (workspace_id, person_id, kind, label, amount, rate, effective_from, effective_to)
       values (app_ws(), $1, $2, $3, $4, $5, $6, $7) returning id`,
      [id, b.kind, b.label, b.amount, b.rate, b.effectiveFrom, b.effectiveTo]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'payroll.component_created', targetType: 'payroll_component', targetId: rows[0].id, meta: { personId: id, ...b } });
    return onePerson(db, id);
  }));
});

payrollRouter.patch('/payroll/components/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const b = parse(UpdatePayrollComponentBody, req.body);
  res.json(await tx(req, async (db) => {
    const cur = (await db.query(`select *, ${day('effective_from')} as ef, ${day('effective_to')} as et from payroll_components where id = $1`, [id])).rows[0];
    if (!cur) throw new HttpError(404, 'component_not_found', 'Componente no encontrado');
    const next = {
      label: b.label ?? cur.label,
      amount: b.amount !== undefined ? b.amount : num(cur.amount),
      rate: b.rate !== undefined ? b.rate : num(cur.rate),
      effectiveFrom: b.effectiveFrom ?? cur.ef,
      effectiveTo: b.effectiveTo !== undefined ? b.effectiveTo : cur.et,
    };
    // Mismas reglas que al crear (el tipo no cambia)
    const amountKind = ['salary', 'hourly', 'bonus', 'deduction_fixed'].includes(cur.kind);
    if (amountKind !== (next.amount != null)) throw new HttpError(400, 'invalid_amount', 'Monto obligatorio solo en sueldo, por hora, bono y deducción fija');
    if (['sales_percent', 'deduction_percent'].includes(cur.kind) !== (next.rate != null)) throw new HttpError(400, 'invalid_rate', 'Porcentaje obligatorio solo en % de ventas y deducción %');
    if (next.effectiveTo && next.effectiveTo < next.effectiveFrom) throw new HttpError(400, 'invalid_dates', 'Termina antes de empezar');
    await db.query('update payroll_components set label = $2, amount = $3, rate = $4, effective_from = $5, effective_to = $6 where id = $1',
      [id, next.label, next.amount, next.rate, next.effectiveFrom, next.effectiveTo]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'payroll.component_updated', targetType: 'payroll_component', targetId: id, meta: b });
    return onePerson(db, cur.person_id);
  }));
});

payrollRouter.delete('/payroll/components/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    const { rows } = await db.query('delete from payroll_components where id = $1 returning person_id, kind, amount, rate', [id]);
    if (!rows[0]) throw new HttpError(404, 'component_not_found', 'Componente no encontrado');
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'payroll.component_deleted', targetType: 'payroll_component', targetId: id, meta: rows[0] });
    return onePerson(db, rows[0].person_id);
  }));
});

// ─── Corridas ───

const RUN_COLS = `r.*, ${day('r.period_start')} as ps, ${day('r.period_end')} as pe, ${day('r.pay_date')} as pd, ${day('r.paid_at')} as paid,
  (select json_build_object('people', count(*)::int, 'gross', coalesce(sum(l.gross), 0)::float, 'deductions', coalesce(sum(l.deductions), 0)::float,
     'net', coalesce(sum(l.net), 0)::float, 'paid', coalesce(sum(l.net) filter (where l.paid_at is not null), 0)::float)
   from payroll_lines l where l.run_id = r.id) as totals`;
const toRun = (r: any): PayrollRun => ({
  id: r.id, calendarId: r.calendar_id, periodStart: r.ps, periodEnd: r.pe, payDate: r.pd, status: r.status, notes: r.notes,
  approvedBy: r.approved_by, approvedAt: r.approved_at?.toISOString() ?? null, paidAt: r.paid, createdAt: r.created_at.toISOString(),
  totals: r.totals,
});

async function getRun(db: pg.PoolClient, id: string): Promise<PayrollRunDetail> {
  const run = (await db.query(`select ${RUN_COLS} from payroll_runs r where r.id = $1`, [id])).rows[0];
  if (!run) throw new HttpError(404, 'run_not_found', 'Corrida no encontrada');
  const { rows } = await db.query(
    `select l.*, p.name as person_name, ${day('l.paid_at')} as paid,
       coalesce((select json_agg(json_build_object('id', a.id, 'personId', a.person_id, 'kind', a.kind, 'label', a.label,
                   'amount', a.amount::float, 'createdAt', to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by a.created_at)
                 from payroll_adjustments a where a.run_id = l.run_id and a.person_id = l.person_id), '[]') as adjustments
     from payroll_lines l join payroll_people p on p.id = l.person_id where l.run_id = $1 order by p.name`, [id]);
  const lines = rows.map((l): PayrollLine => ({
    id: l.id, personId: l.person_id, personName: l.person_name, hours: num(l.hours),
    hasHourly: (l.breakdown as PayrollItem[]).some((i) => i.kind === 'hourly'),
    gross: Number(l.gross), deductions: Number(l.deductions), net: Number(l.net), breakdown: l.breakdown,
    payMethod: l.pay_method, paidAt: l.paid, reference: l.reference, adjustments: l.adjustments,
  }));
  // Huella de lo que se ve (F4): si cambia algo de una línea, cambia la versión
  const version = createHash('sha256')
    .update(JSON.stringify(lines.map((l) => [l.personId, l.hours, l.gross, l.deductions, l.net, l.payMethod, l.breakdown])))
    .digest('hex').slice(0, 32);
  return { ...toRun(run), lines, version };
}

/** Corrida bloqueada para escritura; exige el estado indicado */
async function lockRun(db: pg.PoolClient, id: string, status: PayrollRun['status'] | 'approved_or_paid') {
  const r = (await db.query(`select id, status, calendar_id, ${day('period_start')} as ps, ${day('period_end')} as pe from payroll_runs where id = $1 for update`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'run_not_found', 'Corrida no encontrada');
  const ok = status === 'approved_or_paid' ? r.status !== 'draft' : r.status === status;
  if (!ok) {
    throw status === 'draft'
      ? new HttpError(409, 'run_not_draft', 'La corrida ya está aprobada: reábrela para cambiarla')
      : new HttpError(409, 'run_not_approved', 'La corrida debe estar aprobada');
  }
  return r as { id: string; status: string; calendar_id: string; ps: string; pe: string };
}

/**
 * Recalcula un borrador: líneas para las personas activas del calendario en el periodo (alta ≤ fin y sin baja antes
 * del inicio), quita las que ya no aplican (con sus ajustes) y relee componentes, comisiones y ventas. Conserva horas
 * y ajustes de las que siguen.
 */
async function recalcRun(db: pg.PoolClient, runId: string) {
  const run = await lockRun(db, runId, 'draft');
  const people = (await db.query(
    `select id, user_id, pay_method from payroll_people
     where calendar_id = $1 and is_active and (hired_on is null or hired_on <= $3) and (terminated_on is null or terminated_on >= $2)`,
    [run.calendar_id, run.ps, run.pe])).rows;
  const ids = people.map((p) => p.id);
  await db.query('delete from payroll_adjustments where run_id = $1 and not (person_id = any($2))', [runId, ids]);
  await db.query('delete from payroll_lines where run_id = $1 and not (person_id = any($2))', [runId, ids]);
  await db.query(
    `insert into payroll_lines (workspace_id, run_id, person_id, pay_method)
     select app_ws(), $1, x.id, x.pay_method from json_to_recordset($2) as x(id uuid, pay_method text)
     on conflict (run_id, person_id) do nothing`, [runId, JSON.stringify(people)]);
  if (!people.length) return;

  const users = people.map((p) => p.user_id).filter(Boolean);
  const comps = await db.query(
    `select id, person_id, kind, label, amount::float, rate::float, ${day('effective_from')} as ef, ${day('effective_to')} as et
     from payroll_components where person_id = any($1)`, [ids]);
  // Cuotas pagadas en el periodo (los chargebacks pagados vienen negativos). Las ventas son del agente enlazado al usuario.
  const commissions = await db.query(
    `select a.user_id as uid, sum(i.amount) as total, count(*)::int as n from commission_installments i join agents a on a.id = i.beneficiary_agent_id
     where a.user_id = any($1) and i.status = 'paid' and i.paid_at between $2 and $3 group by 1`, [users, run.ps, run.pe]);
  const sales = await db.query(
    `select a.user_id as uid, sum(s.amount) as total, count(*)::int as n from sales s join agents a on a.id = s.agent_id
     where a.user_id = any($1) and s.status = 'issued' and s.issued_at between $2 and $3 group by 1`, [users, run.ps, run.pe]);
  const adjustments = await db.query('select id, person_id, kind, label, amount::float from payroll_adjustments where run_id = $1', [runId]);
  const lines = await db.query('select id, person_id, hours::float from payroll_lines where run_id = $1', [runId]);
  const byUser = (rows: any[]) => new Map(rows.map((r) => [r.uid, { cents: toCents(r.total), count: r.n }]));
  const comm = byUser(commissions.rows), sold = byUser(sales.rows);
  const zero = { cents: 0, count: 0 };
  for (const p of people) {
    const line = lines.rows.find((l) => l.person_id === p.id)!;
    const r = computeLine({
      periodEnd: run.pe,
      components: comps.rows.filter((c) => c.person_id === p.id).map((c): CalcComponent => ({
        id: c.id, kind: c.kind, label: c.label, amount: c.amount, rate: c.rate, effectiveFrom: c.ef, effectiveTo: c.et })),
      hours: line.hours,
      hasUser: !!p.user_id,
      commissions: (p.user_id && comm.get(p.user_id)) || zero,
      issuedSales: (p.user_id && sold.get(p.user_id)) || zero,
      adjustments: adjustments.rows.filter((a) => a.person_id === p.id),
    });
    if ([r.grossCents, r.deductionsCents, r.netCents].some((c) => Math.abs(c) > MAX_CENTS)) {
      throw new HttpError(400, 'amount_out_of_range', 'El bruto, las deducciones o el neto de una línea superan el máximo permitido');
    }
    await db.query('update payroll_lines set gross = $2, deductions = $3, net = $4, breakdown = $5, pay_method = $6 where id = $1',
      [line.id, dollars(r.grossCents), dollars(r.deductionsCents), dollars(r.netCents), JSON.stringify(r.breakdown), p.pay_method]);
  }
}

const runConflict: [string, string] = ['run_exists', 'Ya hay una corrida de ese calendario con ese inicio de periodo'];

payrollRouter.get('/payroll/runs', async (req, res) => {
  const q = parse(PayrollRunsQuery, req.query);
  res.json(await tx(req, async (db) => (await db.query(
    `select ${RUN_COLS} from payroll_runs r
     where ($1::date is null or r.pay_date >= $1) and ($2::date is null or r.pay_date <= $2)
       and ($3::uuid is null or r.calendar_id = $3) and ($4::text is null or r.status = $4)
     order by r.pay_date desc, r.created_at desc limit 500`,
    [q.from ?? null, q.to ?? null, q.calendarId ?? null, q.status ?? null])).rows.map(toRun)));
});

payrollRouter.post('/payroll/runs', async (req, res) => {
  const b = parse(PayrollRunBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    const cal = await oneCalendar(db, b.calendarId);
    if (cal.archivedAt) throw new HttpError(400, 'calendar_archived', 'El calendario está archivado');
    const { rows } = await db.query(
      `insert into payroll_runs (workspace_id, calendar_id, period_start, period_end, pay_date, notes, created_by)
       values (app_ws(), $1, $2, $3, $4, $5, app_user()) returning id`,
      [b.calendarId, b.periodStart, b.periodEnd, b.payDate, b.notes]).catch((e) => { throw pgError(e, { unique: runConflict }); });
    await recalcRun(db, rows[0].id);
    return getRun(db, rows[0].id);
  }));
});

payrollRouter.get('/payroll/runs/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, (db) => getRun(db, id)));
});

payrollRouter.patch('/payroll/runs/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const b = parse(UpdatePayrollRunBody, req.body);
  res.json(await tx(req, async (db) => {
    const run = await lockRun(db, id, 'draft');
    if ((b.periodEnd ?? run.pe) < (b.periodStart ?? run.ps)) throw new HttpError(400, 'invalid_period', 'El periodo termina antes de empezar');
    await db.query(
      `update payroll_runs set period_start = coalesce($2, period_start), period_end = coalesce($3, period_end),
         pay_date = coalesce($4, pay_date), notes = coalesce($5, notes) where id = $1`,
      [id, b.periodStart ?? null, b.periodEnd ?? null, b.payDate ?? null, b.notes ?? null]).catch((e) => { throw pgError(e, { unique: runConflict }); });
    if (b.periodStart || b.periodEnd) await recalcRun(db, id);
    return getRun(db, id);
  }));
});

payrollRouter.delete('/payroll/runs/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const run = await lockRun(db, id, 'draft');
    await db.query('delete from payroll_runs where id = $1', [id]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'payroll.run_deleted', targetType: 'payroll_run', targetId: id, meta: { periodStart: run.ps, periodEnd: run.pe } });
  });
  res.status(204).end();
});

payrollRouter.post('/payroll/runs/:id/recalculate', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => { await recalcRun(db, id); return getRun(db, id); }));
});

payrollRouter.patch('/payroll/runs/:id/lines/:lineId', async (req, res) => {
  const id = Id.parse(req.params.id);
  const lineId = Id.parse(req.params.lineId);
  const b = parse(UpdatePayrollLineBody, req.body);
  res.json(await tx(req, async (db) => {
    await lockRun(db, id, 'draft');
    const { rowCount } = await db.query('update payroll_lines set hours = $3 where id = $2 and run_id = $1', [id, lineId, b.hours]);
    if (!rowCount) throw new HttpError(404, 'line_not_found', 'Línea no encontrada');
    await recalcRun(db, id);   // ponytail: recalcula toda la corrida; con decenas de personas es instantáneo
    return getRun(db, id);
  }));
});

payrollRouter.post('/payroll/runs/:id/adjustments', async (req, res) => {
  const id = Id.parse(req.params.id);
  const b = parse(PayrollAdjustmentBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    await lockRun(db, id, 'draft');
    if (!(await db.query('select 1 from payroll_lines where run_id = $1 and person_id = $2', [id, b.personId])).rowCount) {
      throw new HttpError(400, 'person_not_in_run', 'Esa persona no está en la corrida');
    }
    await db.query(
      'insert into payroll_adjustments (workspace_id, run_id, person_id, kind, label, amount, created_by) values (app_ws(), $1, $2, $3, $4, $5, app_user())',
      [id, b.personId, b.kind, b.label, b.amount]);
    await recalcRun(db, id);
    return getRun(db, id);
  }));
});

payrollRouter.delete('/payroll/runs/:id/adjustments/:adjustmentId', async (req, res) => {
  const id = Id.parse(req.params.id);
  const adjustmentId = Id.parse(req.params.adjustmentId);
  res.json(await tx(req, async (db) => {
    await lockRun(db, id, 'draft');
    const { rowCount } = await db.query('delete from payroll_adjustments where id = $2 and run_id = $1', [id, adjustmentId]);
    if (!rowCount) throw new HttpError(404, 'adjustment_not_found', 'Ajuste no encontrado');
    await recalcRun(db, id);
    return getRun(db, id);
  }));
});

/**
 * Aprobar: recalcula una última vez y fija líneas y desglose. Solo Owner/Admin. El cliente manda la `version` de la
 * corrida que revisó; si tras recalcular no coincide (alguien añadió un ajuste, cambió horas o componentes, o
 * entraron comisiones), responde 409 `run_changed` y no aprueba (F4).
 */
payrollRouter.post('/payroll/runs/:id/approve', async (req, res) => {
  requireApprover(req);
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    await recalcRun(db, id);   // primero: corrida ajena o no borrador → 404/409 antes de mirar el body
    const b = parse(ApprovePayrollRunBody, req.body ?? {});
    if ((await getRun(db, id)).version !== b.version) {
      throw new HttpError(409, 'run_changed', 'La corrida cambió mientras la revisabas; revísala de nuevo');
    }
    await db.query("update payroll_runs set status = 'approved', approved_by = app_user(), approved_at = now() where id = $1", [id]);
    const run = await getRun(db, id);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'payroll.run_approved', targetType: 'payroll_run', targetId: id, meta: run.totals });
    return run;
  }));
});

/** Reabrir: solo una aprobada sin ningún pago, y solo Owner/Admin */
payrollRouter.post('/payroll/runs/:id/reopen', async (req, res) => {
  requireApprover(req);
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    await lockRun(db, id, 'approved');
    if ((await db.query('select 1 from payroll_lines where run_id = $1 and paid_at is not null', [id])).rowCount) {
      throw new HttpError(409, 'run_has_payments', 'La corrida tiene pagos: deshazlos antes de reabrirla');
    }
    await db.query("update payroll_runs set status = 'draft', approved_by = null, approved_at = null where id = $1", [id]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'payroll.run_reopened', targetType: 'payroll_run', targetId: id });
    await recalcRun(db, id);
    return getRun(db, id);
  }));
});

/** Pagar (o deshacer con paidAt null) líneas de una aprobada; sin lineIds, todas. Con todas pagadas la corrida queda `paid`. */
payrollRouter.post('/payroll/runs/:id/pay', async (req, res) => {
  const id = Id.parse(req.params.id);
  const b = parse(PayPayrollBody, req.body);
  res.json(await tx(req, async (db) => {
    await lockRun(db, id, 'approved_or_paid');
    if (b.lineIds) {
      const { rowCount } = await db.query('select 1 from payroll_lines where run_id = $1 and id = any($2)', [id, b.lineIds]);
      if (rowCount !== new Set(b.lineIds).size) throw new HttpError(400, 'invalid_lines', 'Alguna línea no es de esta corrida');
    }
    const { rowCount } = await db.query(
      `update payroll_lines set paid_at = $3, reference = case when $3::date is null then '' else coalesce($4, reference) end
       where run_id = $1 and ($2::uuid[] is null or id = any($2)) and (paid_at is null) = ($3::date is not null)`,
      [id, b.lineIds ?? null, b.paidAt, b.reference ?? null]);
    await db.query(
      `update payroll_runs r set status = case when s.unpaid = 0 and s.n > 0 then 'paid' else 'approved' end,
         paid_at = case when s.unpaid = 0 and s.n > 0 then s.last else null end
       from (select count(*) as n, count(*) filter (where paid_at is null) as unpaid, max(paid_at) as last
             from payroll_lines where run_id = $1) s
       where r.id = $1`, [id]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: b.paidAt ? 'payroll.run_paid' : 'payroll.run_unpaid', targetType: 'payroll_run', targetId: id, meta: { ...b, updated: rowCount } });
    return getRun(db, id);
  }));
});

payrollRouter.get('/payroll/runs/:id/export.csv', async (req, res) => {
  const id = Id.parse(req.params.id);
  const run = await tx(req, (db) => getRun(db, id));
  const METHOD = { ach: 'ACH', zelle: 'Zelle', check: 'Cheque', cash: 'Efectivo' };
  const STATUS = { draft: 'Borrador', approved: 'Aprobada', paid: 'Pagada' };
  const items = (l: PayrollLine) => l.breakdown.filter((i) => i.amount !== 0 || i.kind === 'hourly')
    .map((i) => `${i.label}: ${i.amount.toFixed(2)}${i.detail ? ` (${i.detail})` : ''}`).join('; ');
  sendCsv(res, `nomina-${run.periodStart}-${run.periodEnd}.csv`, [
    ['Persona', 'Método de pago', 'Horas', 'Bruto', 'Deducciones', 'Neto', 'Pagada el', 'Referencia', 'Desglose', 'Periodo', 'Fecha de pago', 'Estado'],
    ...run.lines.map((l) => [l.personName, METHOD[l.payMethod], l.hours ?? '', l.gross.toFixed(2), l.deductions.toFixed(2), l.net.toFixed(2),
      l.paidAt ?? '', l.reference, items(l), `${run.periodStart} a ${run.periodEnd}`, run.payDate, STATUS[run.status]]),
  ]);
});
