// Consultas y conversiones fila → contrato compartidas por las rutas de plataforma.
import type pg from 'pg';
import type { User, Workspace, Member, Department, BusinessLine, Session, Role } from '@agencia-hub/contracts';
import { onlineUserIds } from '../realtime/hub.ts';

export const ROLE_RANK: Record<Role, number> = { guest: 0, member: 1, lead: 2, admin: 3, owner: 4 };

export const toUser = (r: any): User => ({
  id: r.id, email: r.email, name: r.name, avatarUrl: null, // ponytail: URL prefirmada del avatar llega con files (Ola 2)
  locale: r.locale, timezone: r.timezone, totpEnabled: r.totp_enabled,
});

export const toWorkspace = (r: any): Workspace => ({
  id: r.id, slug: r.slug, name: r.name, logoUrl: null, plan: r.plan, status: r.status,
  trialEndsAt: r.trial_ends_at.toISOString(),
  settings: { maxFileMb: r.settings.max_file_mb, require2fa: r.settings.require_2fa, weeklySummary: r.settings.weekly_summary },
});

export const toDepartment = (r: any): Department => ({ id: r.id, name: r.name, position: r.position, archivedAt: r.archived_at?.toISOString() ?? null });
export const toLine = (r: any): BusinessLine => ({ id: r.id, name: r.name, color: r.color, position: r.position, archivedAt: r.archived_at?.toISOString() ?? null });

const toMember = (r: any, online: Set<string>): Member => ({
  userId: r.user_id, name: r.name, email: r.email, avatarUrl: null, role: r.role, title: r.title,
  statusText: r.status_text, statusUntil: r.status_until?.toISOString() ?? null, isActive: r.is_active,
  departmentIds: r.dept_ids, leadOfDepartmentIds: r.lead_ids, lineIds: r.line_ids,
  presence: online.has(r.user_id) ? 'active' : 'away',
});

/** Miembros del workspace activo (corre dentro de withWorkspace). */
export async function listMembers(db: pg.PoolClient, userId?: string): Promise<Member[]> {
  const { rows } = await db.query(
    `select m.workspace_id, m.user_id, u.name, u.email, m.role, m.title, m.status_text, m.status_until, m.is_active,
       coalesce(array_agg(distinct md.department_id) filter (where md.department_id is not null), '{}') as dept_ids,
       coalesce(array_agg(distinct md.department_id) filter (where md.is_lead), '{}') as lead_ids,
       coalesce(array_agg(distinct ml.line_id) filter (where ml.line_id is not null), '{}') as line_ids
     from workspace_members m
     join users u on u.id = m.user_id
     left join member_departments md on md.workspace_id = m.workspace_id and md.user_id = m.user_id
     left join member_lines ml on ml.workspace_id = m.workspace_id and ml.user_id = m.user_id
     where m.workspace_id = app_ws() and ($1::uuid is null or m.user_id = $1)
     group by m.workspace_id, m.user_id, u.id
     order by u.name`,
    [userId ?? null],
  );
  const online = onlineUserIds(rows[0]?.workspace_id ?? (await db.query('select app_ws() as id')).rows[0].id);
  return rows.map((r) => toMember(r, online));
}

/** Sesión: usuario + workspaces activos donde es miembro (adminPool o withWorkspace sin ws). */
export async function buildSession(db: pg.PoolClient | pg.Pool, userId: string): Promise<Session> {
  const [u, w] = await Promise.all([
    db.query('select id, email, name, locale, timezone, totp_enabled from users where id = $1', [userId]),
    db.query(
      `select w.id, w.slug, w.name from workspaces w
       join workspace_members m on m.workspace_id = w.id and m.user_id = $1 and m.is_active
       order by m.joined_at`, [userId]),
  ]);
  return { user: toUser(u.rows[0]), workspaces: w.rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, logoUrl: null })) };
}

export async function audit(
  db: pg.PoolClient,
  e: { workspaceId: string | null; actor: string | null; action: string; targetType?: string; targetId?: string; meta?: object; ip?: string },
) {
  await db.query(
    'insert into audit_log (workspace_id, actor_user_id, action, target_type, target_id, meta, ip) values ($1, $2, $3, $4, $5, $6, $7)',
    [e.workspaceId, e.actor, e.action, e.targetType ?? null, e.targetId ?? null, e.meta ?? {}, e.ip ?? null],
  );
}

/** Alta de un miembro en los canales que todos comparten (#general y #anuncios). */
export async function joinDefaultChannels(db: pg.PoolClient, workspaceId: string, userId: string) {
  await db.query(
    `insert into channel_members (workspace_id, channel_id, user_id)
     select $1, id, $2 from channels
     where workspace_id = $1 and (kind = 'announcement' or (kind = 'public' and lower(name) = 'general'))
     on conflict do nothing`,
    [workspaceId, userId],
  );
}
