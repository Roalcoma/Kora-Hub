// Gastos recurrentes: cálculo puro de fechas de una plantilla, generación idempotente de ocurrencias y job periódico.
// Días hábiles (diario con businessDaysOnly): una fecha que cae en sábado o domingo se MUEVE AL LUNES SIGUIENTE
// (los cobros que vencen en fin de semana se pagan el hábil siguiente); si el lunes ya era ocurrencia, cuenta una vez.
import type pg from 'pg';
import { adminPool, withWorkspace } from '../db.ts';

export type ScheduleRule = {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;                       // cada N días / semanas / meses
  weekdays: number[] | null;              // semanal: 0 = domingo … 6 = sábado
  monthDay: number | 'last' | null;       // mensual: null o 'last' = último día; 29–31 caen en el último de meses cortos
  businessDaysOnly: boolean;              // diario
  startsOn: string; endsOn: string | null;   // YYYY-MM-DD; la serie se ancla en startsOn
};

/** Ventana de generación: hoy + 35 días */
export const HORIZON_DAYS = 35;
/**
 * Revisión de seguridad F5: una plantilla no empieza más de un año atrás (lo valida la API), y cada pasada genera como
 * máximo MAX_OCCURRENCES_PER_PASS ocurrencias por plantilla; si quedan más, `generated_until` se queda en la última
 * creada y la siguiente pasada (job horario o próxima edición) sigue desde ahí.
 */
export const MAX_PAST_DAYS = 366;
export const MAX_OCCURRENCES_PER_PASS = 400;

const MS = 86_400_000;
/** Días desde 1970-01-01 (UTC, sin husos horarios) */
const toNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / MS;
const toDay = (n: number) => new Date(n * MS).toISOString().slice(0, 10);
const weekday = (n: number) => (n + 4) % 7;   // 1970-01-01 fue jueves
export const addDays = (d: string, days: number) => toDay(toNum(d) + days);

/**
 * Fechas de vencimiento de la regla dentro de [from, to] (ambos inclusive), en orden y sin repetir.
 * La serie empieza en startsOn y no pasa de endsOn (la fecha original; en hábiles, el lunes al que se mueve puede caer
 * justo después de endsOn).
 */
export function occurrences(rule: ScheduleRule, from: string, to: string): string[] {
  const start = toNum(rule.startsOn);
  const end = rule.endsOn ? toNum(rule.endsOn) : Infinity;
  const lo = toNum(from);
  const hi = toNum(to);
  const n = Math.max(1, rule.interval);
  const out = new Set<number>();
  if (hi < lo || hi < start) return [];

  if (rule.frequency === 'daily') {
    // Un fin de semana se mueve hasta 2 días: se miran originales desde 2 días antes de la ventana
    const first = Math.max(start, lo - 2);
    for (let d = start + Math.ceil((first - start) / n) * n; d <= Math.min(hi, end); d += n) {
      const w = weekday(d);
      const due = !rule.businessDaysOnly ? d : w === 6 ? d + 2 : w === 0 ? d + 1 : d;
      if (due >= lo && due <= hi) out.add(due);
    }
  } else if (rule.frequency === 'weekly') {
    const days = new Set(rule.weekdays ?? []);
    const week0 = start - weekday(start);   // domingo de la semana de inicio
    for (let d = Math.max(start, lo); d <= Math.min(hi, end); d++) {
      if (days.has(weekday(d)) && Math.floor((d - week0) / 7) % n === 0) out.add(d);
    }
  } else {
    const s = new Date(start * MS);
    const y0 = s.getUTCFullYear();
    const m0 = s.getUTCMonth();
    const loDate = new Date(lo * MS);
    // Primer mes de la serie que puede caer en la ventana
    const skip = Math.max(0, (loDate.getUTCFullYear() - y0) * 12 + loDate.getUTCMonth() - m0);
    for (let k = Math.ceil(skip / n) * n; ; k += n) {
      const y = y0 + Math.floor((m0 + k) / 12);
      const m = (m0 + k) % 12;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const dom = rule.monthDay == null || rule.monthDay === 'last' ? last : Math.min(rule.monthDay, last);
      const d = Date.UTC(y, m, dom) / MS;
      if (d > hi || d > end) break;
      if (d >= lo && d >= start) out.add(d);
    }
  }
  return [...out].sort((a, b) => a - b).map(toDay);
}

/** Próxima fecha de la regla desde `from` (inclusive); null si la plantilla ya terminó */
export function nextOccurrence(rule: ScheduleRule, from: string): string | null {
  const n = Math.max(1, rule.interval);
  const span = rule.frequency === 'daily' ? n + 3 : rule.frequency === 'weekly' ? 7 * n + 7 : 31 * n + 31;
  const begin = rule.startsOn > from ? rule.startsOn : from;
  return occurrences(rule, begin, addDays(begin, span))[0] ?? null;
}

/** Fila de expense_schedules → regla */
export const ruleOf = (r: any): ScheduleRule => ({
  frequency: r.frequency, interval: r.interval_n, weekdays: r.weekdays, monthDay: r.month_day ?? 'last',
  businessDaysOnly: r.business_days_only, startsOn: r.starts, endsOn: r.ends,
});

export const todayNy = async (db: pg.PoolClient) =>
  (await db.query(`select to_char((now() at time zone 'America/New_York')::date, 'YYYY-MM-DD') as d`)).rows[0].d as string;

/**
 * Genera las ocurrencias pendientes de las plantillas activas y aprobadas del workspace de la transacción (RLS), desde
 * `generated_until` + 1 (o el inicio) hasta hoy + 35. Idempotente: `unique (schedule_id, due_date)` + `generated_until`.
 * Las ocurrencias nacen aprobadas (approved_by y created_by null = job). Devuelve cuántas creó.
 */
export async function generateOccurrences(db: pg.PoolClient, scheduleId: string | null = null): Promise<number> {
  const today = await todayNy(db);
  const horizon = addDays(today, HORIZON_DAYS);
  const { rows } = await db.query(
    `select *, to_char(starts_on, 'YYYY-MM-DD') as starts, to_char(ends_on, 'YYYY-MM-DD') as ends,
       to_char(generated_until, 'YYYY-MM-DD') as gen
     from expense_schedules
     where status = 'active' and approval_status = 'approved' and ($1::uuid is null or id = $1)
       and (generated_until is null or generated_until < $2::date) for update`, [scheduleId, horizon]);
  let created = 0;
  for (const s of rows) {
    const from = s.gen ? addDays(s.gen, 1) : s.starts;
    const all = occurrences(ruleOf(s), from, horizon);
    const dates = all.slice(0, MAX_OCCURRENCES_PER_PASS);
    const until = all.length > dates.length ? dates[dates.length - 1]! : horizon;
    if (dates.length) {
      created += (await db.query(
        `insert into expenses (workspace_id, schedule_id, category_id, vendor, concept, due_date, amount, pay_method,
           approval_status, approved_at)
         select app_ws(), $1, $2, $3, $4, d, $5, $6, 'approved', now() from unnest($7::date[]) as d
         on conflict (schedule_id, due_date) do nothing`,
        [s.id, s.category_id, s.vendor, s.concept, s.amount, s.pay_method, dates])).rowCount ?? 0;
    }
    await db.query('update expense_schedules set generated_until = $2 where id = $1', [s.id, until]);
  }
  return created;
}

/** Recorre las agencias con el módulo activo y plantillas por generar. Un candado de Postgres evita dos pasadas a la vez. */
export async function runExpenseSchedules(): Promise<number> {
  const lock = await adminPool.connect();
  let total = 0;
  try {
    if (!(await lock.query('select pg_try_advisory_lock(4344) as ok')).rows[0].ok) return 0;
    try {
      const { rows } = await lock.query(
        `select distinct s.workspace_id from expense_schedules s join workspaces w on w.id = s.workspace_id
         where w.settings->>'finance_module' = 'true' and s.status = 'active' and s.approval_status = 'approved'
           and (s.generated_until is null
             or s.generated_until < (now() at time zone 'America/New_York')::date + ${HORIZON_DAYS})`);
      for (const { workspace_id } of rows) {
        try {
          total += await withWorkspace({ workspaceId: workspace_id, userId: null }, (db) => generateOccurrences(db));
        } catch (err: any) {
          console.error(JSON.stringify({ level: 'error', msg: 'gastos recurrentes', workspaceId: workspace_id, error: err?.message }));
        }
      }
    } finally {
      await lock.query('select pg_advisory_unlock(4344)');
    }
  } finally {
    lock.release();
  }
  return total;
}

/**
 * Job "diario": corre al arrancar y luego cada hora. Fuera del cambio de día no hace nada (generated_until ya llega a
 * hoy + 35), así que mirar cada hora solo asegura que el día nuevo de Nueva York se cubra pronto.
 */
export function startExpenseScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runExpenseSchedules(); } catch (err: any) { console.error(JSON.stringify({ level: 'error', msg: 'gastos recurrentes', error: err?.message })); }
    running = false;
  };
  void tick();
  setInterval(tick, Number(process.env.EXPENSE_SCHEDULER_MS ?? 3_600_000));
}
