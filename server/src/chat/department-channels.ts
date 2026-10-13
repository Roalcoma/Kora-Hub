// Canales de departamento: un canal privado con departamento asignado lo integran siempre las personas activas de ese
// departamento (y de su línea, si el canal tiene una) más los Owners y Admins activos.
// Se recalcula al cambiar departamentos, líneas, roles, estado, invitaciones o el canal.
import type pg from 'pg';
import { publish } from '../realtime/hub.ts';
import { HttpError } from '../platform/http.ts';
import { deptLineRule } from '../platform/workspace.ts';
import { getChannel } from './model.ts';

export const isDepartmentChannel = (c: { kind: string; departmentId?: string | null; department_id?: string | null }) =>
  c.kind === 'private' && !!(c.departmentId ?? c.department_id);

/** En un canal de departamento nadie entra ni sale a mano: lo decide el departamento */
export async function assertNotDepartmentChannel(db: pg.PoolClient, channelId: string) {
  const { rows } = await db.query('select kind, department_id from channels where id = $1 and workspace_id = app_ws()', [channelId]);
  if (rows[0] && isDepartmentChannel(rows[0])) {
    throw new HttpError(400, 'department_channel', 'Los miembros de este canal son los del departamento, los Owners y los Admins');
  }
}

/** Ajusta la membresía (opcionalmente solo de una persona o de un canal) y avisa en tiempo real a quien entra o sale */
export async function syncDepartmentChannels(db: pg.PoolClient, workspaceId: string, scope: { userId?: string; channelId?: string } = {}) {
  const params = [workspaceId, scope.userId ?? null, scope.channelId ?? null];
  const managed = `c.workspace_id = $1 and c.kind = 'private' and c.department_id is not null and c.archived_at is null
    and ($3::uuid is null or c.id = $3)`;
  const belongs = `m.is_active and (m.role in ('owner', 'admin') or ${deptLineRule('m.user_id', 'c.department_id', 'c.line_id')})`;

  const added = (await db.query(
    `insert into channel_members (workspace_id, channel_id, user_id)
     select c.workspace_id, c.id, m.user_id from channels c
     join workspace_members m on m.workspace_id = c.workspace_id and ($2::uuid is null or m.user_id = $2)
     where ${managed} and ${belongs}
     on conflict do nothing returning channel_id, user_id`, params)).rows as { channel_id: string; user_id: string }[];

  const removed = (await db.query(
    `delete from channel_members cm using channels c, workspace_members m
     where cm.channel_id = c.id and m.workspace_id = c.workspace_id and m.user_id = cm.user_id
       and ($2::uuid is null or cm.user_id = $2) and ${managed} and not (${belongs})
     returning cm.channel_id, cm.user_id`, params)).rows as { channel_id: string; user_id: string }[];

  // getChannel lee app_ws(): fijarlo también cuando se llama desde una conexión de admin (aceptar invitación)
  if (added.length) await db.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId]);
  for (const channelId of new Set(added.map((r) => r.channel_id))) {
    const channel = { ...(await getChannel(db, channelId)), isMember: true, unreadCount: 0, mentionCount: 0 };
    publish(workspaceId, added.filter((r) => r.channel_id === channelId).map((r) => r.user_id), { type: 'channel.updated', channel });
  }
  for (const r of removed) publish(workspaceId, [r.user_id], { type: 'channel.removed', channelId: r.channel_id });
  return { added: added.length, removed: removed.length };
}
