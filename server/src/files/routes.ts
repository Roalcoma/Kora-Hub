// /w/:slug/files — alta, subida (stream a S3), confirmación y descarga. Nunca hay URL pública.
import { Router } from 'express';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Id, CreateUploadBody, type FileRef } from '@agencia-hub/contracts';
import { HttpError, parse } from '../platform/http.ts';
import { tx } from '../platform/workspace.ts';
import { presign } from './s3.ts';

export const filesRouter = Router({ mergeParams: true });

const QUOTA_GB: Record<string, number> = { trial: 10, standard: 10, pro: 50 };

export const toFileRef = (slug: string, r: any): FileRef => ({
  id: r.id, name: r.name, mime: r.mime, size: Number(r.size), width: r.width, height: r.height,
  url: `/api/v1/w/${slug}/files/${r.id}`, thumbUrl: null, // ponytail: sin miniaturas en servidor; el visor escala la imagen
});

filesRouter.post('/', async (req, res) => {
  const body = parse(CreateUploadBody, req.body);
  const file = await tx(req, async (db) => {
    const ws = (await db.query('select plan, settings, storage_bytes from workspaces where id = app_ws()')).rows[0];
    if (body.size > ws.settings.max_file_mb * 1024 * 1024) {
      throw new HttpError(413, 'file_too_large', `El archivo supera el límite de ${ws.settings.max_file_mb} MB`);
    }
    if (Number(ws.storage_bytes) + body.size > QUOTA_GB[ws.plan]! * 1024 ** 3) {
      throw new HttpError(413, 'quota_exceeded', 'Se alcanzó el espacio de almacenamiento del plan');
    }
    const id = randomUUID();
    // La clave lleva el workspace como prefijo (también lo exige un check en la BD)
    const ext = body.name.includes('.') ? body.name.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : 'bin';
    const { rows } = await db.query(
      `insert into files (id, workspace_id, uploader_id, storage_key, name, mime, size, width, height, context)
       values ($1, app_ws(), app_user(), $2, $3, $4, $5, $6, $7, $8) returning *`,
      [id, `${req.ws!.id}/${id}.${ext}`, body.name, body.mime, body.size, body.width ?? null, body.height ?? null, body.context]);
    return rows[0];
  });
  res.status(201).json({ fileId: file.id, uploadUrl: `/api/v1/w/${req.ws!.slug}/files/${file.id}/content`, headers: { 'content-type': file.mime } });
});

// Subida: el cuerpo crudo pasa en stream de la petición a S3, con el tamaño declarado al crear.
filesRouter.put('/:id/content', async (req, res) => {
  const id = Id.parse(req.params.id);
  const file = await tx(req, async (db) => (await db.query(
    "select * from files where workspace_id = app_ws() and id = $1 and uploader_id = app_user() and status = 'pending'", [id])).rows[0]);
  if (!file) throw new HttpError(404, 'file_not_found', 'Archivo no encontrado');
  if (Number(req.headers['content-length']) !== Number(file.size)) {
    throw new HttpError(400, 'size_mismatch', 'El tamaño enviado no coincide con el declarado');
  }
  const put = await fetch(presign('PUT', file.storage_key), {
    method: 'PUT', body: Readable.toWeb(req) as ReadableStream, duplex: 'half',
    headers: { 'content-type': file.mime, 'content-length': String(file.size) },
  } as RequestInit);
  if (!put.ok) throw new HttpError(502, 'storage_error', 'No se pudo guardar el archivo');
  res.status(204).end();
});

filesRouter.post('/:id/complete', async (req, res) => {
  const id = Id.parse(req.params.id);
  const file = await tx(req, async (db) => {
    const f = (await db.query(
      "select * from files where workspace_id = app_ws() and id = $1 and uploader_id = app_user() and status = 'pending' for update", [id])).rows[0];
    if (!f) throw new HttpError(404, 'file_not_found', 'Archivo no encontrado');
    const head = await fetch(presign('HEAD', f.storage_key), { method: 'HEAD' });
    if (!head.ok || Number(head.headers.get('content-length')) !== Number(f.size)) {
      throw new HttpError(400, 'upload_incomplete', 'El archivo no terminó de subirse');
    }
    // storage_bytes lo suma un trigger de la BD (migración 0005)
    return (await db.query("update files set status = 'ready' where id = $1 returning *", [id])).rows[0];
  });
  res.json(toFileRef(req.ws!.slug, file));
});

// Descarga: valida acceso y hace stream desde S3. Archivos de mensajes solo si puedo leer ese canal.
filesRouter.get('/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const file = await tx(req, async (db) => (await db.query(
    `select f.* from files f
     where f.workspace_id = app_ws() and f.id = $1 and f.status = 'ready'
       and (f.uploader_id = app_user()
         or f.context <> 'message'
         or exists (select 1 from message_files mf join messages m on m.id = mf.message_id join channels c on c.id = m.channel_id
                    where mf.file_id = f.id and m.deleted_at is null
                      and (c.kind in ('public', 'announcement')
                        or exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = app_user()))))`,
    [id])).rows[0]);
  if (!file) throw new HttpError(404, 'file_not_found', 'Archivo no encontrado');
  const range = req.headers.range;
  const s3 = await fetch(presign('GET', file.storage_key, 60), { headers: range ? { range } : {} });
  if (!s3.ok || !s3.body) throw new HttpError(502, 'storage_error', 'No se pudo leer el archivo');
  const inline = /^(image\/|application\/pdf$)/.test(file.mime) && req.query.download === undefined;
  res.status(s3.status).set({
    'content-type': file.mime,
    'content-length': s3.headers.get('content-length') ?? undefined,
    'content-range': s3.headers.get('content-range') ?? undefined,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=86400',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  Readable.fromWeb(s3.body as never).pipe(res);
});
