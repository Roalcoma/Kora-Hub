// Enlace agente ↔ usuario: cuando alguien entra a la agencia (cuenta creada por un Admin o invitación aceptada) y hay un
// agente asociado sin usuario con su mismo email, quedan enlazados: desde entonces ve sus ventas y comisiones.
import type pg from 'pg';

export async function linkAgentByEmail(db: pg.PoolClient, workspaceId: string, userId: string) {
  await db.query(
    `update agents set user_id = $2
     where workspace_id = $1 and user_id is null and archived_at is null and email is not null
       and lower(email) = (select lower(email) from users where id = $2)
       and not exists (select 1 from agents x where x.workspace_id = $1 and x.user_id = $2)`, [workspaceId, userId]);
}
