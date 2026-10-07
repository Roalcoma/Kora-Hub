import pg from 'pg';

// Rol agencia_app: las políticas RLS aplican. Todo acceso de negocio pasa por aquí.
export const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP });

// Dueño del esquema: sin RLS. Solo login/registro, invitaciones por token, webhooks, jobs y superadmin.
export const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export type TenantContext = { workspaceId: string | null; userId: string | null };

/**
 * Ejecuta `fn` en una transacción con el contexto de tenant fijado (equivale a SET LOCAL).
 * Si la app olvida un filtro por workspace, RLS impide ver o escribir datos de otro.
 */
export async function withWorkspace<T>(ctx: TenantContext, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await appPool.connect();
  try {
    await db.query('begin');
    await db.query(
      "select set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)",
      [ctx.workspaceId ?? '', ctx.userId ?? ''],
    );
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback');
    throw err;
  } finally {
    db.release();
  }
}

/** Transacción sobre adminPool (sin RLS). Usar solo en los casos listados arriba. */
export async function withAdmin<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await adminPool.connect();
  try {
    await db.query('begin');
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback');
    throw err;
  } finally {
    db.release();
  }
}
