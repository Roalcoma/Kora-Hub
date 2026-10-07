// Worker de la cola en Postgres: toma un trabajo con SKIP LOCKED, lo ejecuta y reintenta con espera exponencial.
import { hostname } from 'node:os';
import { adminPool } from '../db.ts';
import { notifyMessage, notifyTask, remindReports } from '../notifications/push.ts';
import { sendEmail } from '../notifications/email.ts';

const HANDLERS: Record<string, (payload: any) => Promise<void>> = {
  'notify.message': (p) => notifyMessage(p.messageId),
  'email.send': (p) => sendEmail(p),
  'notify.task': (p) => notifyTask(p),
  'reports.remind': () => remindReports(),
  // Limpieza de tokens vencidos (se reencola sola cada hora)
  'cleanup.tokens': async () => {
    await adminPool.query("delete from ws_tickets where expires_at < now() - interval '1 minute'");
    await adminPool.query("delete from password_resets where expires_at < now() - interval '1 day'");
  },
};

const workerId = `${hostname()}:${process.pid}`;

/** Ejecuta un trabajo listo, si hay. Devuelve true si procesó alguno. */
export async function runOnce(): Promise<boolean> {
  const { rows } = await adminPool.query(
    `update jobs set locked_at = now(), locked_by = $1, attempts = attempts + 1
     where id = (select id from jobs
                 where done_at is null and run_at <= now() and attempts < max_attempts
                   and (locked_at is null or locked_at < now() - interval '5 minutes')
                 order by run_at limit 1 for update skip locked)
     returning *`, [workerId]);
  const job = rows[0];
  if (!job) return false;
  try {
    const handler = HANDLERS[job.kind];
    if (!handler) throw new Error(`Trabajo desconocido: ${job.kind}`);
    await handler(job.payload);
    await adminPool.query('update jobs set done_at = now(), locked_at = null, last_error = null where id = $1', [job.id]);
  } catch (err: any) {
    const wait = 10 * 2 ** job.attempts;   // 20 s, 40 s, 80 s…
    await adminPool.query(
      "update jobs set locked_at = null, last_error = $2, run_at = now() + make_interval(secs => $3) where id = $1",
      [job.id, String(err?.message ?? err).slice(0, 1000), wait]);
    console.error(JSON.stringify({ level: 'error', msg: 'job fallido', kind: job.kind, id: job.id, error: err?.message }));
  }
  return true;
}

export function startWorker() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { while (await runOnce()); } catch (err: any) { console.error(JSON.stringify({ level: 'error', msg: 'worker', error: err?.message })); }
    running = false;
  }, 1000);
  // Cada hora: limpieza (una por hora) y, los viernes desde las 15:00 de Nueva York, el recordatorio de reportes (uno por semana)
  const schedule = async () => {
    await adminPool.query(
      `insert into jobs (kind, dedupe_key) values ('cleanup.tokens', 'cleanup:' || to_char(now(), 'YYYYMMDDHH24')) on conflict do nothing`);
    await adminPool.query(
      `insert into jobs (kind, dedupe_key)
       select 'reports.remind', 'reports-remind:' || to_char(now() at time zone 'America/New_York', 'IYYY-IW')
       where extract(isodow from now() at time zone 'America/New_York') = 5
         and extract(hour from now() at time zone 'America/New_York') >= 15
       on conflict do nothing`);
  };
  schedule().catch(() => {});
  setInterval(() => schedule().catch(() => {}), 3600_000);
}
