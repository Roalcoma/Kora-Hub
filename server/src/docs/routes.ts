// /w/:slug/documents — manuales en árbol por departamento, con versiones y búsqueda (§5.3).
// Lectura: todo el workspace (menos invitados). Edición: Admin o Líder del departamento.
import { Router, type Request } from 'express';
import type pg from 'pg';
import { Id, ListDocumentsQuery, CreateDocumentBody, UpdateDocumentBody, type Document, type DocumentNode } from '@agencia-hub/contracts';
import { HttpError, parse } from '../platform/http.ts';
import { tx, canManageDept, membersOnly } from '../platform/workspace.ts';
import { toFileRef } from '../files/routes.ts';
import { highlight } from '../chat/highlight.ts';
import { sanitizeDoc } from './content.ts';

export const docsRouter = Router({ mergeParams: true });
docsRouter.use('/documents', membersOnly);

// Ediciones seguidas de la misma persona se juntan en una versión (el editor guarda a menudo)
const VERSION_WINDOW_MIN = 10;

const toNode = (r: any): DocumentNode => ({
  id: r.id, parentId: r.parent_id, title: r.title, position: r.position, lineId: r.line_id,
  departmentId: r.department_id, updatedAt: r.updated_at.toISOString(),
});

const filePrefix = (req: Request) => `/api/v1/w/${req.ws!.slug}/files/`;

async function getDoc(db: pg.PoolClient, req: Request, id: string): Promise<Document> {
  const r = (await db.query('select * from documents where id = $1 and archived_at is null', [id])).rows[0];
  if (!r) throw new HttpError(404, 'document_not_found', 'Manual no encontrado');
  const files = (await db.query(
    'select f.* from document_files df join files f on f.id = df.file_id where df.document_id = $1 order by f.created_at', [id])).rows;
  return {
    ...toNode(r), content: r.content, files: files.map((f) => toFileRef(req.ws!.slug, f)),
    updatedBy: r.updated_by, canEdit: await canManageDept(db, req, r.department_id),
  };
}

async function editableDoc(db: pg.PoolClient, req: Request, id: string) {
  const r = (await db.query('select * from documents where id = $1 and archived_at is null for update', [id])).rows[0];
  if (!r) throw new HttpError(404, 'document_not_found', 'Manual no encontrado');
  if (!(await canManageDept(db, req, r.department_id))) throw new HttpError(403, 'forbidden', 'Solo Admin o Líder del departamento edita este manual');
  return r;
}

/** El padre debe existir, ser del mismo departamento y no ser el propio documento ni un descendiente suyo. */
async function checkParent(db: pg.PoolClient, parentId: string | null, departmentId: string, selfId?: string) {
  if (!parentId) return;
  const p = (await db.query('select department_id from documents where id = $1 and archived_at is null', [parentId])).rows[0];
  if (!p || p.department_id !== departmentId) throw new HttpError(400, 'invalid_parent', 'La página superior no es válida');
  if (!selfId) return;
  const { rowCount } = await db.query(
    `with recursive up as (select id, parent_id from documents where id = $1
       union all select d.id, d.parent_id from documents d join up on d.id = up.parent_id)
     select 1 from up where id = $2`, [parentId, selfId]);
  if (rowCount) throw new HttpError(400, 'invalid_parent', 'Una página no puede quedar dentro de sí misma');
}

async function saveVersion(db: pg.PoolClient, id: string) {
  const { rowCount } = await db.query(
    `update document_versions v set title = d.title, content = d.content, created_at = now()
     from documents d
     where d.id = $1 and v.id = (select id from document_versions where document_id = $1 order by created_at desc limit 1)
       and v.edited_by = app_user() and v.created_at > now() - make_interval(mins => $2)`, [id, VERSION_WINDOW_MIN]);
  if (!rowCount) {
    await db.query(
      `insert into document_versions (workspace_id, document_id, title, content, edited_by)
       select app_ws(), id, title, content, app_user() from documents where id = $1`, [id]);
  }
}

docsRouter.get('/documents', async (req, res) => {
  const q = parse(ListDocumentsQuery, req.query);
  res.json(await tx(req, async (db) => {
    const term = q.q?.trim();
    const { rows } = await db.query(
      `select * from documents
       where archived_at is null and ($1::uuid is null or department_id = $1) and ($2::uuid is null or line_id = $2)
         and ($3::text is null or tsv @@ plainto_tsquery('simple', immutable_unaccent($3))
              or immutable_unaccent(title) ilike '%' || immutable_unaccent($3) || '%')
       order by ${term ? "ts_rank(tsv, plainto_tsquery('simple', immutable_unaccent($3))) desc, updated_at desc limit 50" : 'position, title'}`,
      [q.departmentId ?? null, q.lineId ?? null, term || null]);
    return rows.map((r) => (term ? { ...toNode(r), snippet: highlight(r.content_text || r.title, term) } : toNode(r)));
  }));
});

docsRouter.post('/documents', async (req, res) => {
  const body = parse(CreateDocumentBody, req.body);
  const doc = await tx(req, async (db) => {
    if (!(await canManageDept(db, req, body.departmentId))) throw new HttpError(403, 'forbidden', 'Solo Admin o Líder del departamento crea manuales');
    await checkParent(db, body.parentId, body.departmentId);
    const { content, text } = sanitizeDoc(body.content ?? { type: 'doc', content: [] }, filePrefix(req));
    const { rows } = await db.query(
      `insert into documents (workspace_id, department_id, line_id, parent_id, title, content, content_text, position, created_by, updated_by)
       values (app_ws(), $1, $2, $3, $4, $5, $6,
         (select coalesce(max(position) + 1, 0) from documents where department_id = $1 and parent_id is not distinct from $3),
         app_user(), app_user())
       returning id`,
      [body.departmentId, body.lineId, body.parentId, body.title, content, text]);
    await saveVersion(db, rows[0].id);
    return getDoc(db, req, rows[0].id);
  });
  res.status(201).json(doc);
});

docsRouter.get('/documents/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, (db) => getDoc(db, req, id)));
});

docsRouter.patch('/documents/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(UpdateDocumentBody, req.body);
  res.json(await tx(req, async (db) => {
    const cur = await editableDoc(db, req, id);
    if (body.archived) {
      // Archivar una página archiva también sus subpáginas
      await db.query(
        `with recursive sub as (select id from documents where id = $1
           union all select d.id from documents d join sub on d.parent_id = sub.id)
         update documents set archived_at = now(), updated_by = app_user() where id in (select id from sub)`, [id]);
      return { ...toNode(cur), content: cur.content, files: [], updatedBy: req.userId!, canEdit: true };
    }
    if (body.parentId !== undefined) await checkParent(db, body.parentId, cur.department_id, id);
    const set: string[] = ['updated_by = app_user()', 'updated_at = now()'];
    const vals: unknown[] = [id];
    const add = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
    if (body.title !== undefined) add('title', body.title);
    if (body.content !== undefined) {
      const { content, text } = sanitizeDoc(body.content, filePrefix(req));
      add('content', content);
      add('content_text', text);
    }
    if (body.parentId !== undefined) add('parent_id', body.parentId);
    if (body.position !== undefined) add('position', body.position);
    if (body.lineId !== undefined) add('line_id', body.lineId);
    await db.query(`update documents set ${set.join(', ')} where id = $1`, vals);
    if (body.fileIds) {
      await db.query('delete from document_files where document_id = $1', [id]);
      // FK compuesta: solo entran archivos de este workspace
      await db.query(
        `insert into document_files (workspace_id, document_id, file_id)
         select app_ws(), $1, id from files where id = any($2) and status = 'ready'`, [id, body.fileIds]);
    }
    if (body.title !== undefined || body.content !== undefined) await saveVersion(db, id);
    return getDoc(db, req, id);
  }));
});

docsRouter.get('/documents/:id/versions', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    await getDoc(db, req, id);
    const { rows } = await db.query(
      'select id, title, edited_by, created_at from document_versions where document_id = $1 order by created_at desc limit 100', [id]);
    return rows.map((r) => ({ id: r.id, title: r.title, editedBy: r.edited_by, createdAt: r.created_at.toISOString() }));
  }));
});

docsRouter.get('/documents/:id/versions/:versionId', async (req, res) => {
  const id = Id.parse(req.params.id);
  const versionId = Id.parse(req.params.versionId);
  res.json(await tx(req, async (db) => {
    await getDoc(db, req, id);
    const r = (await db.query('select * from document_versions where id = $1 and document_id = $2', [versionId, id])).rows[0];
    if (!r) throw new HttpError(404, 'version_not_found', 'Versión no encontrada');
    return { id: r.id, title: r.title, editedBy: r.edited_by, createdAt: r.created_at.toISOString(), content: r.content };
  }));
});

docsRouter.post('/documents/:id/versions/:versionId/restore', async (req, res) => {
  const id = Id.parse(req.params.id);
  const versionId = Id.parse(req.params.versionId);
  res.json(await tx(req, async (db) => {
    await editableDoc(db, req, id);
    const v = (await db.query('select title, content from document_versions where id = $1 and document_id = $2', [versionId, id])).rows[0];
    if (!v) throw new HttpError(404, 'version_not_found', 'Versión no encontrada');
    const { content, text } = sanitizeDoc(v.content, filePrefix(req));
    await db.query(
      'update documents set title = $2, content = $3, content_text = $4, updated_by = app_user(), updated_at = now() where id = $1',
      [id, v.title, content, text]);
    // Restaurar es un cambio más: queda como versión nueva (no se junta con la anterior)
    await db.query(
      `insert into document_versions (workspace_id, document_id, title, content, edited_by)
       values (app_ws(), $1, $2, $3, app_user())`, [id, v.title, content]);
    return getDoc(db, req, id);
  }));
});
