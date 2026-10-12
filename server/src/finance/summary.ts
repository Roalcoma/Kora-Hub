// /w/:slug/finance/summary — flujo de caja del periodo según lo cargado (docs/plan-finanzas.md §5, ADR 0007).
// Resultado = entradas del banco − gastos pagados (por paid_at, monto pagado) − nómina pagada (payroll_lines.paid_at,
// neto, categoría virtual "Nómina": no se copia a expenses). Próximos pagos, vencidos, por aprobar y la serie mensual
// se miden desde "hoy" en Nueva York y no dependen del periodo. El guardián de routes.ts ya filtró módulo y rol.
import { Router } from 'express';
import { FinanceSummaryQuery, type FinanceSummary, type UpcomingPayment } from '@agencia-hub/contracts';
import { parse } from '../platform/http.ts';
import { tx } from '../platform/workspace.ts';

export const summaryRouter = Router({ mergeParams: true });

const TODAY = `(now() at time zone 'America/New_York')::date`;
const day = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;   // como texto: pg pasa `date` a medianoche local y corre el día
const UPCOMING_DAYS = 15;
const MONTHS = 6;
const money = (v: unknown) => Number(v ?? 0);
const round = (n: number) => Math.round(n * 100) / 100;
/** Rango opcional por los dos lados: null = sin límite */
const inRange = (col: string) => `($1::date is null or ${col} >= $1) and ($2::date is null or ${col} <= $2)`;

summaryRouter.get('/summary', async (req, res) => {
  const q = parse(FinanceSummaryQuery, req.query);
  const range = [q.from ?? null, q.to ?? null];
  res.json(await tx(req, async (db) => {
    const today = (await db.query(`select ${day(TODAY)} as d`)).rows[0].d as string;

    // ─── Banco: entradas por compañía y salidas ───
    const bank = (await db.query(
      `select carrier_id, sum(amount) filter (where amount > 0) as inflow, count(*) filter (where amount > 0) as n,
              -sum(amount) filter (where amount < 0) as outflow
       from bank_transactions where ${inRange('posted_on')} group by carrier_id`, range)).rows;
    const inflow = round(bank.reduce((t, r) => t + money(r.inflow), 0));
    const outflow = round(bank.reduce((t, r) => t + money(r.outflow), 0));
    const inflowByCarrier = bank.filter((r) => Number(r.n) > 0)
      .map((r) => ({ carrierId: r.carrier_id, amount: money(r.inflow), count: Number(r.n) }))
      .sort((a, b) => b.amount - a.amount);

    // ─── Gastos pagados en el periodo (por fecha de pago) ───
    const cats = (await db.query(
      `select category_id, sum(paid_amount) as amount, count(*) as n from expenses
       where status = 'paid' and approval_status <> 'rejected' and ${inRange('paid_at')} group by category_id order by 2 desc`, range)).rows;
    const byCategory = cats.map((r) => ({ categoryId: r.category_id, amount: money(r.amount), count: Number(r.n) }));
    const expensesPaid = round(byCategory.reduce((t, c) => t + c.amount, 0));

    // ─── Nómina pagada (neto de las líneas pagadas en el periodo) ───
    const pr = (await db.query(
      `select coalesce(sum(net), 0) as paid, count(*) as n from payroll_lines where paid_at is not null and ${inRange('paid_at')}`, range)).rows[0];

    // ─── Comisiones de ventas esperadas vs. marcadas pagadas (para la conciliación futura) ───
    const salesOn = (await db.query("select settings->>'sales_module' = 'true' as on from workspaces where id = app_ws()")).rows[0]?.on;
    let commissions: FinanceSummary['commissions'] = null;
    if (salesOn) {
      const c = (await db.query(
        `select coalesce(sum(amount), 0) as expected, coalesce(sum(amount) filter (where status = 'paid'), 0) as paid,
                count(*) as n, count(*) filter (where status = 'paid') as paid_n
         from commission_installments where status <> 'void' and ${inRange('due_date')}`, range)).rows[0];
      commissions = { expected: money(c.expected), paid: money(c.paid), count: Number(c.n), paidCount: Number(c.paid_n) };
    }

    // ─── Próximos pagos: gastos aprobados pendientes de hoy a +15 días y corridas aprobadas sin pagar ───
    const exp = (await db.query(
      `select id, ${day('due_date')} as d, vendor, concept, amount, category_id from expenses
       where status = 'pending' and approval_status = 'approved' and due_date between ${TODAY} and ${TODAY} + ${UPCOMING_DAYS}
       order by due_date, vendor limit 50`)).rows;
    // Las corridas aprobadas atrasadas también salen (marcadas): nadie más las recuerda
    const runs = (await db.query(
      `select r.id, ${day('r.pay_date')} as d, ${day('r.period_start')} as ps, ${day('r.period_end')} as pe, c.name,
              (r.pay_date < ${TODAY}) as late, coalesce(sum(l.net) filter (where l.paid_at is null), 0) as amount
       from payroll_runs r join payroll_calendars c on c.id = r.calendar_id left join payroll_lines l on l.run_id = r.id
       where r.status = 'approved' and r.pay_date <= ${TODAY} + ${UPCOMING_DAYS}
       group by r.id, c.name order by r.pay_date limit 20`)).rows;
    const upcoming: UpcomingPayment[] = [
      ...exp.map((r): UpcomingPayment => ({ kind: 'expense', id: r.id, date: r.d, label: r.vendor, detail: r.concept,
        amount: money(r.amount), categoryId: r.category_id, overdue: false })),
      ...runs.map((r): UpcomingPayment => ({ kind: 'payroll', id: r.id, date: r.d, label: r.name, detail: `${r.ps}|${r.pe}`,
        amount: money(r.amount), categoryId: null, overdue: r.late })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));

    const late = (await db.query(
      `select count(*) as n, coalesce(sum(amount), 0) as amount from expenses
       where status = 'pending' and approval_status = 'approved' and due_date < ${TODAY}`)).rows[0];
    const approvals = (await db.query("select count(*) as n from expenses where approval_status = 'pending'")).rows[0];

    // ─── Serie mensual: últimos 6 meses (incluido el actual) ───
    const monthly = (await db.query(
      `with m as (select to_char(g, 'YYYY-MM') as month from generate_series(
         date_trunc('month', ${TODAY}) - interval '${MONTHS - 1} months', date_trunc('month', ${TODAY}), interval '1 month') g),
       start as (select (date_trunc('month', ${TODAY}) - interval '${MONTHS - 1} months')::date as d)
       select m.month,
         coalesce((select sum(amount) from bank_transactions where amount > 0 and posted_on >= (select d from start)
           and to_char(posted_on, 'YYYY-MM') = m.month), 0) as inflow,
         coalesce((select sum(paid_amount) from expenses where status = 'paid' and approval_status <> 'rejected'
           and paid_at >= (select d from start) and to_char(paid_at, 'YYYY-MM') = m.month), 0)
         + coalesce((select sum(net) from payroll_lines where paid_at >= (select d from start)
           and to_char(paid_at, 'YYYY-MM') = m.month), 0) as spent
       from m order by m.month`)).rows.map((r) => ({ month: r.month, inflow: money(r.inflow), spent: money(r.spent) }));

    const payrollPaid = money(pr.paid);
    const out: FinanceSummary = {
      period: { from: q.from ?? null, to: q.to ?? null }, today,
      bank: { inflow, outflow, inflowByCarrier },
      expenses: { paid: expensesPaid, count: byCategory.reduce((t, c) => t + c.count, 0), byCategory },
      payroll: { paid: payrollPaid, lines: Number(pr.n) },
      result: round(inflow - expensesPaid - payrollPaid),
      commissions, upcoming,
      overdue: { count: Number(late.n), amount: money(late.amount) },
      pendingApprovals: Number(approvals.n),
      monthly,
    };
    return out;
  }));
});
