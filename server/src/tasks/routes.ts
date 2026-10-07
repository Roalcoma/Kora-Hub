// /w/:slug/tasks — tareas por departamento: kanban, "Mis tareas", comentarios, checklist y "crear desde mensaje" (§5.4).
// Ver: todo el workspace (menos invitados). Crear: miembros del departamento, sus Líderes y Admin.
// Gestionar (editar todo, borrar): Admin, Líder del depto o quien la creó. Responsables: estado, orden y checklist.
import { Router, type Request } from 'express';
import type pg from 'pg';
import {
  Id, ListTasksQuery, CreateTaskBody, UpdateTaskBody, TaskCommentBody, ChecklistItemBody, UpdateChecklistItemBody, type Task, type ServerEvent,
} from '@agencia-hub/contracts';
import { adminPool } from '../db.ts';
import { HttpError, parse } from '../platform/http.ts';
import { tx, canManageDept, isAdmin, membersOnly } from '../platform/workspace.ts';
import { enqueue } from '../jobs/queue.ts';
import { publish } from '../realtime/hub.ts';

export const tasksRouter = Router({ mergeParams: true });
tasksRouter.use('/tasks', membersOnly);

const toTask = (r: any): Task => ({
  id: r.id, departmentId: r.department_id, lineId: r.line_id, title: r.title, description: r.description,
  status: r.status, priority: r.priority, dueAt: r.due_at?.toISOString() ?? null, position: r.position,
  assigneeIds: r.assignee_ids, checklist: r.checklist, commentCount: r.comment_count,
  sourceMessageId: r.source_message_id, sourceChannelId: r.source_channel_id, createdBy: r.created_by,
  completedAt: r.completed_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

const SELECT = `
  select t.*, m.channel_id as source_channel_id,
    coalesce((select array_agg(a.user_id) from task_assignees a where a.task_id = t.id), '{}') as assignee_ids,
    coalesce((select json_agg(json_build_object('id', i.id, 'text', i.text, 'done', i.done, 'position', i.position)
              order by i.position, i.id) from task_checklist_items i where i.task_id = t.id), '[]') as checklist,
    (select count(*)::int from task_comments c where c.task_id = t.id) as comment_count
  from tasks t left join messages m on m.id = t.source_message_id`;

async function getTask(db: pg.PoolClient, id: string): Promise<Task> {
  const r = (await db.query(`${SELECT} where t.id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'task_not_found', 'Tarea no encontrada');
  return toTask(r);
}

/** Permisos del usuario sobre la tarea: gestionar todo o solo trabajarla (responsable). */
async function access(db: pg.PoolClient, req: Request, t: Task) {
  const manage = t.createdBy === req.userId || (await canManageDept(db, req, t.departmentId));
  return { manage, work: manage || t.assigneeIds.includes(req.userId!) };
}

const canCreateIn = async (db: pg.PoolClient, req: Request, departmentId: string) =>
  isAdmin(req) || !!(await db.query('select 1 from member_departments where user_id = app_user() and department_id = $1', [departmentId])).rowCount;

/** Deja solo miembros activos del workspace (la FK compuesta ya rechaza los de otro). */
async function activeMembers(db: pg.PoolClient, ids: string[]) {
  return (await db.query('select user_id from workspace_members where workspace_id = app_ws() and is_active and user_id = any($1)', [ids]))
    .rows.map((r) => r.user_id as string);
}

async function setAssignees(db: pg.PoolClient, taskId: string, ids: string[]) {
  const valid = await activeMembers(db, ids);
  await db.query('delete from task_assignees where task_id = $1 and not (user_id = any($2))', [taskId, valid]);
  const { rows } = await db.query(
    `insert into task_assignees (workspace_id, task_id, user_id) select app_ws(), $1, unnest($2::uuid[])
     on conflict do nothing returning user_id`, [taskId, valid]);
  return rows.map((r) => r.user_id as string);   // los nuevos: a ellos se les avisa
}

// ─── Avisos (los envía el worker después del commit) ───

const notify = (req: Request, task: Task, userIds: string[], event: 'assigned' | 'comment') => {
  const to = userIds.filter((u) => u !== req.userId);
  if (to.length) return enqueue('notify.task', { taskId: task.id, userIds: to, event, actorId: req.userId }, { workspaceId: req.ws!.id });
};

/** Aviso 24 h antes del vencimiento. Si la fecha cambia, el job viejo ve otra fecha y no hace nada. */
const scheduleDue = (req: Request, task: Task) => {
  if (!task.dueAt) return;
  const runAt = new Date(new Date(task.dueAt).getTime() - 24 * 3600_000);
  if (runAt.getTime() < Date.now()) return;
  return enqueue('notify.task', { taskId: task.id, event: 'due', dueAt: task.dueAt }, {
    workspaceId: req.ws!.id, runAt, dedupeKey: `task-due:${task.id}:${task.dueAt}` });
};

/** Eventos de tareas: a todo el workspace menos invitados (no ven los módulos). */
async function broadcast(req: Request, event: ServerEvent) {
  const { rows } = await adminPool.query(
    "select user_id from workspace_members where workspace_id = $1 and is_active and role <> 'guest'", [req.ws!.id]);
  publish(req.ws!.id, rows.map((r) => r.user_id), event);
}
const changed = (req: Request, task: Task, type: 'task.created' | 'task.updated') => broadcast(req, { type, task });

// ─── Rutas ───

tasksRouter.get('/tasks', async (req, res) => {
  const q = parse(ListTasksQuery, req.query);
  res.json(await tx(req, async (db) => {
    // ponytail: hechas/canceladas solo de los últimos 30 días; paginar si un tablero crece más
    const { rows } = await db.query(
      `${SELECT}
       where ($1::uuid is null or t.department_id = $1) and ($2::uuid is null or t.line_id = $2)
         and ($3::text is null or t.status = $3)
         and (not $4 or exists (select 1 from task_assignees a where a.task_id = t.id and a.user_id = app_user()))
         and (t.status in ('todo', 'doing') or t.updated_at > now() - interval '30 days')
       order by t.position, t.created_at desc limit 1000`,
      [q.departmentId ?? null, q.lineId ?? null, q.status ?? null, q.mine ?? false]);
    return rows.map(toTask);
  }));
});

tasksRouter.post('/tasks', async (req, res) => {
  const body = parse(CreateTaskBody, req.body);
  const { task, assigned } = await tx(req, async (db) => {
    if (!(await canCreateIn(db, req, body.departmentId))) throw new HttpError(403, 'forbidden', 'Solo puedes crear tareas en tus departamentos');
    if (body.sourceMessageId) {
      // Solo desde mensajes que puedo leer (canal público o del que soy miembro)
      const { rowCount } = await db.query(
        `select 1 from messages m join channels c on c.id = m.channel_id
         where m.id = $1 and m.deleted_at is null
           and (c.kind = 'public' or exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = app_user()))`,
        [body.sourceMessageId]);
      if (!rowCount) throw new HttpError(404, 'message_not_found', 'Mensaje no encontrado');
    }
    const { rows } = await db.query(
      `insert into tasks (workspace_id, department_id, line_id, title, description, priority, due_at, source_message_id, created_by, position)
       values (app_ws(), $1, $2, $3, $4, $5, $6, $7, app_user(),
         (select coalesce(min(position), 1) - 1 from tasks where department_id = $1 and status = 'todo'))
       returning id`,
      [body.departmentId, body.lineId, body.title, body.description, body.priority, body.dueAt, body.sourceMessageId ?? null]);
    const id = rows[0].id;
    const assigned = await setAssignees(db, id, body.assigneeIds);
    for (const [i, text] of body.checklist.entries()) {
      await db.query('insert into task_checklist_items (workspace_id, task_id, text, position) values (app_ws(), $1, $2, $3)', [id, text, i]);
    }
    return { task: await getTask(db, id), assigned };
  });
  await notify(req, task, assigned, 'assigned');
  await scheduleDue(req, task);
  await changed(req, task, 'task.created');
  res.status(201).json(task);
});

tasksRouter.get('/tasks/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    const task = await getTask(db, id);
    const { rows } = await db.query('select * from task_comments where task_id = $1 order by created_at', [id]);
    return { ...task, comments: rows.map((c) => ({ id: c.id, userId: c.user_id, body: c.body, createdAt: c.created_at.toISOString(), editedAt: c.edited_at?.toISOString() ?? null })) };
  }));
});

tasksRouter.patch('/tasks/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(UpdateTaskBody, req.body);
  const before = { dueAt: null as string | null };
  const { task, assigned } = await tx(req, async (db) => {
    const cur = await getTask(db, id);
    before.dueAt = cur.dueAt;
    const { manage, work } = await access(db, req, cur);
    const onlyWork = Object.keys(body).every((k) => k === 'status' || k === 'position');
    if (!(manage || (work && onlyWork))) throw new HttpError(403, 'forbidden', 'No puedes cambiar esta tarea');

    const set: string[] = ['updated_at = now()'];
    const vals: unknown[] = [id];
    const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
    if (body.title !== undefined) add('title', body.title);
    if (body.description !== undefined) add('description', body.description);
    if (body.priority !== undefined) add('priority', body.priority);
    if (body.dueAt !== undefined) add('due_at', body.dueAt);
    if (body.lineId !== undefined) add('line_id', body.lineId);
    if (body.status !== undefined && body.status !== cur.status) {
      add('status', body.status);
      set.push(`completed_at = ${body.status === 'done' ? 'now()' : 'null'}`);
      // Cambió de columna sin orden explícito: arriba de la columna nueva
      if (body.position === undefined) {
        vals.push(cur.departmentId, body.status);
        set.push(`position = (select coalesce(min(position), 1) - 1 from tasks where department_id = $${vals.length - 1} and status = $${vals.length})`);
      }
    }
    if (body.position !== undefined) add('position', body.position);
    await db.query(`update tasks set ${set.join(', ')} where id = $1`, vals);
    const assigned = body.assigneeIds ? await setAssignees(db, id, body.assigneeIds) : [];
    return { task: await getTask(db, id), assigned };
  });
  await notify(req, task, assigned, 'assigned');
  if (task.dueAt !== before.dueAt) await scheduleDue(req, task);
  await changed(req, task, 'task.updated');
  res.json(task);
});

tasksRouter.delete('/tasks/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    if (!(await access(db, req, await getTask(db, id))).manage) throw new HttpError(403, 'forbidden', 'No puedes borrar esta tarea');
    await db.query('delete from tasks where id = $1', [id]);
  });
  await broadcast(req, { type: 'task.deleted', taskId: id });
  res.status(204).end();
});

tasksRouter.post('/tasks/:id/comments', async (req, res) => {
  const id = Id.parse(req.params.id);
  const { body } = parse(TaskCommentBody, req.body);
  const { comment, task } = await tx(req, async (db) => {
    await getTask(db, id);
    const { rows } = await db.query(
      'insert into task_comments (workspace_id, task_id, user_id, body) values (app_ws(), $1, app_user(), $2) returning *', [id, body]);
    await db.query('update tasks set updated_at = now() where id = $1', [id]);
    const c = rows[0];
    return { comment: { id: c.id, userId: c.user_id, body: c.body, createdAt: c.created_at.toISOString(), editedAt: null }, task: await getTask(db, id) };
  });
  await notify(req, task, [...new Set([...task.assigneeIds, task.createdBy])], 'comment');
  await changed(req, task, 'task.updated');
  res.status(201).json(comment);
});

// ─── Checklist ───

async function workable(db: pg.PoolClient, req: Request, id: string) {
  const task = await getTask(db, id);
  if (!(await access(db, req, task)).work) throw new HttpError(403, 'forbidden', 'Solo responsables o quien gestiona la tarea');
}

const toItem = (r: any) => ({ id: r.id, text: r.text, done: r.done, position: r.position });

async function afterChecklist(req: Request, db: pg.PoolClient, id: string) {
  await db.query('update tasks set updated_at = now() where id = $1', [id]);
  await changed(req, await getTask(db, id), 'task.updated');
}

tasksRouter.post('/tasks/:id/checklist', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(ChecklistItemBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    await workable(db, req, id);
    const { rows } = await db.query(
      `insert into task_checklist_items (workspace_id, task_id, text, done, position)
       values (app_ws(), $1, $2, $3, (select coalesce(max(position) + 1, 0) from task_checklist_items where task_id = $1)) returning *`,
      [id, body.text, body.done]);
    await afterChecklist(req, db, id);
    return toItem(rows[0]);
  }));
});

tasksRouter.patch('/tasks/:id/checklist/:itemId', async (req, res) => {
  const id = Id.parse(req.params.id);
  const itemId = Id.parse(req.params.itemId);
  const body = parse(UpdateChecklistItemBody, req.body);
  res.json(await tx(req, async (db) => {
    await workable(db, req, id);
    const { rows } = await db.query(
      `update task_checklist_items set text = coalesce($3, text), done = coalesce($4, done), position = coalesce($5, position)
       where id = $1 and task_id = $2 returning *`, [itemId, id, body.text ?? null, body.done ?? null, body.position ?? null]);
    if (!rows[0]) throw new HttpError(404, 'item_not_found', 'Elemento no encontrado');
    await afterChecklist(req, db, id);
    return toItem(rows[0]);
  }));
});

tasksRouter.delete('/tasks/:id/checklist/:itemId', async (req, res) => {
  const id = Id.parse(req.params.id);
  const itemId = Id.parse(req.params.itemId);
  await tx(req, async (db) => {
    await workable(db, req, id);
    await db.query('delete from task_checklist_items where id = $1 and task_id = $2', [itemId, id]);
    await afterChecklist(req, db, id);
  });
  res.status(204).end();
});
