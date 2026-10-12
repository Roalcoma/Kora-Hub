// /w/:slug/finance — gastos: categorías, proveedores, plantillas recurrentes y gastos (docs/plan-finanzas.md §2, ADR 0007).
// El guardián de routes.ts ya filtró módulo y rol (Owner, Admin o Contable). Aprobación: lo que crea Owner/Admin nace
// aprobado; lo que crea un Contable (o el monto que cambia de uno aprobado) queda por aprobar. Solo se pagan aprobados.
import { Router, type Request } from 'express';
import type pg from 'pg';
import {
  Id, ExpenseCategoryBody, UpdateExpenseCategoryBody, ExpenseScheduleBody, UpdateExpenseScheduleBody,
  ExpenseBody, UpdateExpenseBody, PayExpenseBody, ExpensesQuery,
  type ExpenseCategory, type ExpenseSchedule, type Expense, type ExpensesList,
} from '@agencia-hub/contracts';
import { HttpError, parse, sendCsv } from '../platform/http.ts';
import { tx } from '../platform/workspace.ts';
import { audit } from '../platform/model.ts';
import { toFileRef } from '../files/routes.ts';
import { isApprover, requireApprover } from './access.ts';
import { generateOccurrences, nextOccurrence, ruleOf, todayNy } from './schedule.ts';

export const expensesRouter = Router({ mergeParams: true });

const TODAY = `(now() at time zone 'America/New_York')::date`;
const day = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;   // como texto: pg pasa `date` a medianoche local y corre el día
const cents = (n: number) => Math.round(n * 100);
const log = (db: pg.PoolClient, req: Request, action: string, targetType: string, targetId: string, meta: object = {}) =>
  audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action, targetType, targetId, meta });
/** Columnas de aprobación según quién crea: Owner/Admin aprueba con su firma; el Contable deja pendiente */
const approvalOf = (req: Request) => isApprover(req)
  ? { status: 'approved', by: req.userId!, at: 'now()' }
  : { status: 'pending', by: null, at: 'null' };

// ─── Categorías ───

const DEFAULT_CATEGORIES: [string, string][] = [
  ['Renta', 'blue'], ['Software', 'purple'], ['Marketing', 'orange'], ['Leads', 'green'],
  ['Servicios', 'teal'], ['Impuestos', 'red'], ['Otros', 'gray'],
];
const toCategory = (r: any): ExpenseCategory => ({
  id: r.id, name: r.name, color: r.color, position: r.position, archivedAt: r.archived_at?.toISOString() ?? null,
});

expensesRouter.get('/expense-categories', async (req, res) => {
  res.json(await tx(req, async (db) => {
    // Agencia que activó el módulo después de la migración: se le crean las básicas la primera vez
    if (!(await db.query('select 1 from expense_categories limit 1')).rowCount) {
      await db.query(
        `insert into expense_categories (workspace_id, name, color, position)
         select app_ws(), c.name, c.color, c.position - 1 from unnest($1::text[], $2::text[]) with ordinality as c(name, color, position)
         on conflict do nothing`,
        [DEFAULT_CATEGORIES.map((c) => c[0]), DEFAULT_CATEGORIES.map((c) => c[1])]);
    }
    return (await db.query('select * from expense_categories order by position, name')).rows.map(toCategory);
  }));
});

expensesRouter.post('/expense-categories', async (req, res) => {
  const body = parse(ExpenseCategoryBody, req.body);
  res.status(201).json(await tx(req, async (db) => toCategory((await db.query(
    `insert into expense_categories (workspace_id, name, color, position)
     values (app_ws(), $1, $2, (select coalesce(max(position) + 1, 0) from expense_categories)) returning *`,
    [body.name, body.color])).rows[0])));
});

expensesRouter.patch('/expense-categories/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(UpdateExpenseCategoryBody, req.body);
  res.json(await tx(req, async (db) => {
    const { rows } = await db.query(
      `update expense_categories set name = coalesce($2, name), color = coalesce($3, color), position = coalesce($4, position),
         archived_at = case when $5::boolean is null then archived_at when $5 then coalesce(archived_at, now()) else null end
       where id = $1 returning *`,
      [id, body.name ?? null, body.color ?? null, body.position ?? null, body.archived ?? null]);
    if (!rows[0]) throw new HttpError(404, 'category_not_found', 'Categoría no encontrada');
    return toCategory(rows[0]);
  }));
});

async function checkCategory(db: pg.PoolClient, id: string) {
  const c = (await db.query('select archived_at from expense_categories where id = $1', [id])).rows[0];
  if (!c) throw new HttpError(404, 'category_not_found', 'Categoría no encontrada');
  if (c.archived_at) throw new HttpError(400, 'category_archived', 'La categoría está archivada');
}

/** Comprobante: archivo listo del workspace subido con contexto `expense` */
async function checkFile(db: pg.PoolClient, id: string | null | undefined) {
  if (!id) return;
  const ok = (await db.query("select 1 from files where id = $1 and context = 'expense' and status = 'ready'", [id])).rowCount;
  if (!ok) throw new HttpError(400, 'invalid_file', 'El comprobante no es un archivo válido de gastos');
}

// ─── Proveedores (autocompletado de los ya usados) ───

expensesRouter.get('/vendors', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  res.json(await tx(req, async (db) => (await db.query(
    `select vendor from (select vendor from expenses union all select vendor from expense_schedules) v
     where vendor ilike $1 group by vendor order by count(*) desc, vendor limit 20`, [like])).rows.map((r) => r.vendor)));
});

// ─── Plantillas recurrentes ───

const SCHEDULE_COLS = `*, ${day('starts_on')} as starts, ${day('ends_on')} as ends`;

const toSchedule = (r: any, today: string): ExpenseSchedule => ({
  id: r.id, categoryId: r.category_id, vendor: r.vendor, concept: r.concept, amount: Number(r.amount), payMethod: r.pay_method,
  frequency: r.frequency, interval: r.interval_n, weekdays: r.weekdays,
  monthDay: r.frequency === 'monthly' ? (r.month_day ?? 'last') : null, businessDaysOnly: r.business_days_only,
  startsOn: r.starts, endsOn: r.ends, status: r.status, nextDueDate: nextOccurrence(ruleOf(r), today),
  approvalStatus: r.approval_status, approvedBy: r.approved_by, approvedAt: r.approved_at?.toISOString() ?? null,
  createdBy: r.created_by, createdAt: r.created_at.toISOString(),
});

async function oneSchedule(db: pg.PoolClient, id: string, lock = false): Promise<any> {
  const r = (await db.query(`select ${SCHEDULE_COLS} from expense_schedules where id = $1 ${lock ? 'for update' : ''}`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'schedule_not_found', 'Gasto recurrente no encontrado');
  return r;
}
const scheduleOut = async (db: pg.PoolClient, id: string) => toSchedule(await oneSchedule(db, id), await todayNy(db));

/** Copia la plantilla a sus ocurrencias futuras pendientes sin pagar (monto, categoría, proveedor, concepto, método) */
const syncFuture = (db: pg.PoolClient, id: string) => db.query(
  `update expenses e set amount = s.amount, category_id = s.category_id, vendor = s.vendor, concept = s.concept,
     pay_method = s.pay_method, updated_at = now()
   from expense_schedules s where s.id = $1 and e.schedule_id = s.id and e.status = 'pending' and e.due_date >= ${TODAY}`, [id]);

expensesRouter.get('/expense-schedules', async (req, res) => {
  res.json(await tx(req, async (db) => {
    const today = await todayNy(db);
    return (await db.query(`select ${SCHEDULE_COLS} from expense_schedules order by status, vendor, created_at`)).rows
      .map((r) => toSchedule(r, today));
  }));
});

expensesRouter.post('/expense-schedules', async (req, res) => {
  const b = parse(ExpenseScheduleBody, req.body);
  const ap = approvalOf(req);
  res.status(201).json(await tx(req, async (db) => {
    await checkCategory(db, b.categoryId);
    const { rows } = await db.query(
      `insert into expense_schedules (workspace_id, category_id, vendor, concept, amount, pay_method, frequency, interval_n,
         weekdays, month_day, business_days_only, starts_on, ends_on, approval_status, approved_by, approved_at, created_by)
       values (app_ws(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${ap.at}, app_user()) returning id`,
      [b.categoryId, b.vendor, b.concept, b.amount, b.payMethod, b.frequency, b.interval, b.weekdays,
        b.monthDay === 'last' ? null : b.monthDay, b.businessDaysOnly, b.startsOn, b.endsOn, ap.status, ap.by]);
    const id = rows[0].id;
    if (ap.status === 'approved') await generateOccurrences(db, id);
    await log(db, req, 'expense_schedule.created', 'expense_schedule', id, { approvalStatus: ap.status });
    return scheduleOut(db, id);
  }));
});

expensesRouter.patch('/expense-schedules/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(UpdateExpenseScheduleBody, req.body);
  res.json(await tx(req, async (db) => {
    const cur = await oneSchedule(db, id, true);
    const before = toSchedule(cur, await todayNy(db));
    // Coherencia frecuencia ↔ campos sobre la fila combinada (el PATCH solo trae lo que cambia)
    const { status, ...fields } = body;
    const next = parse(ExpenseScheduleBody, {
      categoryId: before.categoryId, vendor: before.vendor, concept: before.concept, amount: before.amount,
      payMethod: before.payMethod, frequency: before.frequency, interval: before.interval, weekdays: before.weekdays,
      monthDay: before.monthDay, businessDaysOnly: before.businessDaysOnly, startsOn: before.startsOn, endsOn: before.endsOn,
      ...fields,
    });
    if (body.categoryId) await checkCategory(db, body.categoryId);
    const amountChanged = cents(next.amount) !== cents(before.amount);
    const ruleChanged = (['frequency', 'interval', 'monthDay', 'businessDaysOnly', 'startsOn', 'endsOn'] as const)
      .some((k) => next[k] !== before[k]) || JSON.stringify(next.weekdays) !== JSON.stringify(before.weekdays);
    // Un Contable que cambia el monto de una aprobada (o toca una rechazada) la deja otra vez por aprobar
    const toPending = !isApprover(req) && (cur.approval_status === 'rejected' || (amountChanged && cur.approval_status === 'approved'));
    await db.query(
      `update expense_schedules set category_id = $2, vendor = $3, concept = $4, amount = $5, pay_method = $6, frequency = $7,
         interval_n = $8, weekdays = $9, month_day = $10, business_days_only = $11, starts_on = $12, ends_on = $13,
         status = coalesce($14, status),
         -- reanudar no rellena lo que no se generó mientras estuvo en pausa
         generated_until = case when $14 = 'active' and status = 'paused' then greatest(generated_until, ${TODAY} - 1) else generated_until end,
         approval_status = case when $15 then 'pending' else approval_status end,
         approved_by = case when $15 then null else approved_by end,
         approved_at = case when $15 then null else approved_at end,
         updated_at = now()
       where id = $1`,
      [id, next.categoryId, next.vendor, next.concept, next.amount, next.payMethod, next.frequency, next.interval, next.weekdays,
        next.monthDay === 'last' ? null : next.monthDay, next.businessDaysOnly, next.startsOn, next.endsOn, status ?? null, toPending]);
    if (ruleChanged) {
      // Regla nueva: se quitan las ocurrencias futuras que nadie tocó (pendientes, sin comprobante ni referencia) y se
      // vuelve a generar desde hoy con la regla nueva. Las pasadas, pagadas o saltadas no se tocan.
      await db.query(
        `delete from expenses where schedule_id = $1 and status = 'pending' and due_date >= ${TODAY}
           and file_id is null and reference = '' and notes = ''`, [id]);
      await db.query(`update expense_schedules set generated_until = least(generated_until, ${TODAY} - 1) where id = $1`, [id]);
    }
    if (!toPending && cur.approval_status === 'approved') await syncFuture(db, id);
    await generateOccurrences(db, id);
    await log(db, req, 'expense_schedule.updated', 'expense_schedule', id, { ...body, ...(toPending ? { approvalStatus: 'pending' } : {}) });
    return scheduleOut(db, id);
  }));
});

for (const action of ['approve', 'reject'] as const) {
  expensesRouter.post(`/expense-schedules/:id/${action}`, async (req, res) => {
    requireApprover(req);
    const id = Id.parse(req.params.id);
    res.json(await tx(req, async (db) => {
      await oneSchedule(db, id, true);
      await db.query(
        "update expense_schedules set approval_status = $2, approved_by = app_user(), approved_at = now(), updated_at = now() where id = $1",
        [id, action === 'approve' ? 'approved' : 'rejected']);
      if (action === 'approve') {
        await syncFuture(db, id);              // el monto que cambió el Contable llega a las próximas pendientes
        await generateOccurrences(db, id);     // y se generan de inmediato
      }
      await log(db, req, `expense_schedule.${action === 'approve' ? 'approved' : 'rejected'}`, 'expense_schedule', id);
      return scheduleOut(db, id);
    }));
  });
}

// ─── Gastos ───

const EXPENSE_COLS = `e.*, ${day('e.due_date')} as due, ${day('e.paid_at')} as paid_on, to_jsonb(f) as file,
  (e.status = 'pending' and e.approval_status = 'approved' and e.due_date < ${TODAY}) as overdue`;
const EXPENSE_FROM = `expenses e left join files f on f.id = e.file_id`;

const toExpense = (slug: string, r: any): Expense => ({
  id: r.id, scheduleId: r.schedule_id, categoryId: r.category_id, vendor: r.vendor, concept: r.concept,
  dueDate: r.due, amount: Number(r.amount), paidAmount: r.paid_amount == null ? null : Number(r.paid_amount), paidAt: r.paid_on,
  payMethod: r.pay_method, reference: r.reference, notes: r.notes, file: r.file ? toFileRef(slug, r.file) : null,
  status: r.status, overdue: r.overdue,
  approvalStatus: r.approval_status, approvedBy: r.approved_by, approvedAt: r.approved_at?.toISOString() ?? null,
  createdBy: r.created_by, createdAt: r.created_at.toISOString(),
});

async function queryExpenses(req: Request, q: ReturnType<typeof ExpensesQuery.parse>): Promise<Expense[]> {
  return tx(req, async (db) => (await db.query(
    `select ${EXPENSE_COLS} from ${EXPENSE_FROM}
     where ($1::date is null or e.due_date >= $1) and ($2::date is null or e.due_date <= $2)
       and ($3::uuid is null or e.category_id = $3) and ($4::text is null or e.status = $4)
       and ($5::text is null or e.approval_status = $5) and ($6::text is null or e.vendor ilike $6)
       and ($7::uuid is null or e.schedule_id = $7)
       and ($8::boolean is null or (e.status = 'pending' and e.approval_status = 'approved' and e.due_date < ${TODAY}) = $8)
     order by e.due_date desc, e.created_at desc limit 2000`,
    [q.from ?? null, q.to ?? null, q.categoryId ?? null, q.status ?? null, q.approvalStatus ?? null,
      q.vendor ? `%${q.vendor.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, q.scheduleId ?? null, q.overdue ?? null],
  )).rows.map((r) => toExpense(req.ws!.slug, r)));
}

async function oneExpense(db: pg.PoolClient, req: Request, id: string, lock = false): Promise<Expense> {
  const { rows } = await db.query(`select ${EXPENSE_COLS} from ${EXPENSE_FROM} where e.id = $1 ${lock ? 'for update of e' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, 'expense_not_found', 'Gasto no encontrado');
  return toExpense(req.ws!.slug, rows[0]);
}

expensesRouter.get('/expenses', async (req, res) => {
  const items = await queryExpenses(req, parse(ExpensesQuery, req.query));
  // Saltados y rechazados no suman
  const live = items.filter((e) => e.status !== 'skipped' && e.approvalStatus !== 'rejected');
  const sum = (list: Expense[], f: (e: Expense) => number) => list.reduce((t, e) => t + cents(f(e)), 0) / 100;
  const paid = (e: Expense) => (e.status === 'paid' ? e.paidAmount ?? 0 : 0);
  const cats = new Map<string, Expense[]>();
  for (const e of live) cats.set(e.categoryId, [...(cats.get(e.categoryId) ?? []), e]);
  const overdue = live.filter((e) => e.overdue);
  const out: ExpensesList = {
    items,
    totals: {
      count: live.length, amount: sum(live, (e) => e.amount), paid: sum(live, paid),
      pending: sum(live.filter((e) => e.status === 'pending'), (e) => e.amount),
      overdue: sum(overdue, (e) => e.amount), overdueCount: overdue.length,
    },
    byCategory: [...cats].map(([categoryId, list]) => ({ categoryId, amount: sum(list, (e) => e.amount), paid: sum(list, paid) }))
      .sort((a, b) => b.amount - a.amount),
  };
  res.json(out);
});

expensesRouter.get('/expenses.csv', async (req, res) => {
  const items = await queryExpenses(req, parse(ExpensesQuery, req.query));
  const cats = new Map<string, string>(await tx(req, async (db) =>
    (await db.query('select id, name from expense_categories')).rows.map((r) => [r.id, r.name] as [string, string])));
  const STATUS = { pending: 'Pendiente', paid: 'Pagado', skipped: 'Saltado' };
  const APPROVAL = { approved: 'Aprobado', pending: 'Por aprobar', rejected: 'Rechazado' };
  sendCsv(res, 'gastos.csv', [
    ['Vence', 'Categoría', 'Proveedor', 'Concepto', 'Monto', 'Pagado', 'Fecha de pago', 'Método', 'Referencia', 'Estado', 'Aprobación', 'Recurrente', 'Notas'],
    ...items.map((e) => [e.dueDate, cats.get(e.categoryId), e.vendor, e.concept, e.amount.toFixed(2), e.paidAmount?.toFixed(2) ?? '',
      e.paidAt ?? '', e.payMethod, e.reference, STATUS[e.status], APPROVAL[e.approvalStatus], e.scheduleId ? 'Sí' : 'No', e.notes]),
  ]);
});

expensesRouter.post('/expenses', async (req, res) => {
  const b = parse(ExpenseBody, req.body);
  const ap = approvalOf(req);
  if (b.paid && ap.status !== 'approved') throw new HttpError(409, 'not_approved', 'Solo se pagan gastos aprobados: un Owner o Admin debe aprobarlo primero');
  res.status(201).json(await tx(req, async (db) => {
    await checkCategory(db, b.categoryId);
    await checkFile(db, b.fileId);
    await checkFile(db, b.paid?.fileId);
    const p = b.paid;
    const { rows } = await db.query(
      `insert into expenses (workspace_id, category_id, vendor, concept, due_date, amount, pay_method, reference, notes, file_id,
         status, paid_at, paid_amount, approval_status, approved_by, approved_at, created_by)
       values (app_ws(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${ap.at}, app_user()) returning id`,
      [b.categoryId, b.vendor, b.concept, b.dueDate, b.amount, p?.payMethod ?? b.payMethod, p?.reference ?? b.reference, b.notes,
        p?.fileId ?? b.fileId, p ? 'paid' : 'pending', p?.paidAt ?? null, p ? p.paidAmount ?? b.amount : null, ap.status, ap.by]);
    await log(db, req, 'expense.created', 'expense', rows[0].id, { amount: b.amount, approvalStatus: ap.status, paid: !!p });
    return oneExpense(db, req, rows[0].id);
  }));
});

expensesRouter.patch('/expenses/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const b = parse(UpdateExpenseBody, req.body);
  res.json(await tx(req, async (db) => {
    const cur = await oneExpense(db, req, id, true);
    const amountChanged = b.amount !== undefined && cents(b.amount) !== cents(cur.amount);
    if (amountChanged && cur.status === 'paid') throw new HttpError(409, 'expense_paid', 'Reabre el gasto pagado para cambiar el monto');
    if (b.categoryId && b.categoryId !== cur.categoryId) await checkCategory(db, b.categoryId);
    await checkFile(db, b.fileId);
    // Un Contable que cambia el monto de uno aprobado (o corrige uno rechazado) lo deja otra vez por aprobar
    const toPending = !isApprover(req) && ((amountChanged && cur.approvalStatus === 'approved') || cur.approvalStatus === 'rejected');
    await db.query(
      `update expenses set category_id = coalesce($2, category_id), vendor = coalesce($3, vendor), concept = coalesce($4, concept),
         due_date = coalesce($5, due_date), amount = coalesce($6, amount), pay_method = coalesce($7, pay_method),
         reference = coalesce($8, reference), notes = coalesce($9, notes),
         file_id = case when $10 then $11::uuid else file_id end,
         approval_status = case when $12 then 'pending' else approval_status end,
         approved_by = case when $12 then null else approved_by end,
         approved_at = case when $12 then null else approved_at end,
         updated_at = now()
       where id = $1`,
      [id, b.categoryId ?? null, b.vendor ?? null, b.concept ?? null, b.dueDate ?? null, b.amount ?? null, b.payMethod ?? null,
        b.reference ?? null, b.notes ?? null, b.fileId !== undefined, b.fileId ?? null, toPending]);
    await log(db, req, 'expense.updated', 'expense', id, { ...b, ...(toPending ? { approvalStatus: 'pending' } : {}) });
    return oneExpense(db, req, id);
  }));
});

expensesRouter.delete('/expenses/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const cur = await oneExpense(db, req, id, true);
    // Una ocurrencia borrada la recrearía el job: se salta
    if (cur.scheduleId) throw new HttpError(409, 'expense_recurring', 'Las ocurrencias de un gasto recurrente se saltan, no se borran');
    if (cur.status === 'paid') throw new HttpError(409, 'expense_paid', 'Un gasto pagado no se borra; reábrelo primero');
    await db.query('delete from expenses where id = $1', [id]);
    await log(db, req, 'expense.deleted', 'expense', id, { amount: cur.amount, vendor: cur.vendor, dueDate: cur.dueDate });
  });
  res.status(204).end();
});

for (const action of ['approve', 'reject'] as const) {
  expensesRouter.post(`/expenses/:id/${action}`, async (req, res) => {
    requireApprover(req);
    const id = Id.parse(req.params.id);
    res.json(await tx(req, async (db) => {
      const cur = await oneExpense(db, req, id, true);
      if (action === 'reject' && cur.status === 'paid') throw new HttpError(409, 'expense_paid', 'Un gasto pagado no se rechaza; reábrelo primero');
      await db.query("update expenses set approval_status = $2, approved_by = app_user(), approved_at = now(), updated_at = now() where id = $1",
        [id, action === 'approve' ? 'approved' : 'rejected']);
      await log(db, req, `expense.${action === 'approve' ? 'approved' : 'rejected'}`, 'expense', id);
      return oneExpense(db, req, id);
    }));
  });
}

expensesRouter.post('/expenses/:id/pay', async (req, res) => {
  const id = Id.parse(req.params.id);
  const b = parse(PayExpenseBody, req.body);
  res.json(await tx(req, async (db) => {
    const cur = await oneExpense(db, req, id, true);
    if (cur.approvalStatus !== 'approved') throw new HttpError(409, 'not_approved', 'Solo se pagan gastos aprobados');
    if (cur.status !== 'pending') throw new HttpError(409, 'expense_not_pending', 'El gasto no está pendiente');
    await checkFile(db, b.fileId);
    await db.query(
      `update expenses set status = 'paid', paid_at = $2, paid_amount = $3, pay_method = coalesce($4, pay_method),
         reference = coalesce($5, reference), file_id = case when $6 then $7::uuid else file_id end, updated_at = now()
       where id = $1`,
      [id, b.paidAt, b.paidAmount ?? cur.amount, b.payMethod ?? null, b.reference ?? null, b.fileId !== undefined, b.fileId ?? null]);
    await log(db, req, 'expense.paid', 'expense', id, { paidAt: b.paidAt, paidAmount: b.paidAmount ?? cur.amount });
    return oneExpense(db, req, id);
  }));
});

expensesRouter.post('/expenses/:id/skip', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    const cur = await oneExpense(db, req, id, true);
    if (cur.status !== 'pending') throw new HttpError(409, 'expense_not_pending', 'El gasto no está pendiente');
    await db.query("update expenses set status = 'skipped', updated_at = now() where id = $1", [id]);
    await log(db, req, 'expense.skipped', 'expense', id);
    return oneExpense(db, req, id);
  }));
});

expensesRouter.post('/expenses/:id/reopen', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    const cur = await oneExpense(db, req, id, true);
    if (cur.status === 'pending') throw new HttpError(409, 'expense_pending', 'El gasto ya está pendiente');
    await db.query("update expenses set status = 'pending', paid_at = null, paid_amount = null, updated_at = now() where id = $1", [id]);
    await log(db, req, 'expense.reopened', 'expense', id, { from: cur.status, paidAmount: cur.paidAmount, paidAt: cur.paidAt });
    return oneExpense(db, req, id);
  }));
});
