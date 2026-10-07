// Cola de trabajos en Postgres. El worker (SKIP LOCKED) llega en la Ola 2 con backend-notificaciones;
// mientras tanto los trabajos quedan encolados (p. ej. emails visibles con `select * from jobs`).
import type pg from 'pg';
import { adminPool } from '../db.ts';

export async function enqueue(
  kind: string, payload: object,
  opts: { workspaceId?: string | null; dedupeKey?: string; runAt?: Date; db?: pg.PoolClient } = {},
) {
  await (opts.db ?? adminPool).query(
    `insert into jobs (workspace_id, kind, payload, dedupe_key, run_at) values ($1, $2, $3, $4, coalesce($5, now()))
     on conflict (dedupe_key) do nothing`,
    [opts.workspaceId ?? null, kind, payload, opts.dedupeKey ?? null, opts.runAt ?? null],
  );
}
