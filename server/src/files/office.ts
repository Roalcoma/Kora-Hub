// Visor de Office (OnlyOffice / Euro-Office) en modo lectura. Hoy usa el Euro-Office de Nextcloud AIO; migrar a uno
// propio es cambiar OFFICE_URL y OFFICE_JWT_SECRET. Sin esas variables la ruta responde 404 y la web usa su visor propio.
// El servidor de oficina no tiene sesión de Kora: descarga el archivo con un enlace firmado (HMAC) que vence en 10 min.
import { Router } from 'express';
import { Readable } from 'node:stream';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OfficeView } from '@agencia-hub/contracts';
import { adminPool } from '../db.ts';
import { HttpError } from '../platform/http.ts';
import { presign } from './s3.ts';

const officeUrl = () => (process.env.OFFICE_URL ?? '').trim().replace(/\/+$/, '');
const officeSecret = () => (process.env.OFFICE_JWT_SECRET ?? '').trim();
const appUrl = () => process.env.APP_URL ?? 'http://localhost:5180';
const LINK_SECONDS = 600;

const TYPES: Record<string, 'cell' | 'word' | 'slide'> = {
  xlsx: 'cell', xls: 'cell', csv: 'cell', docx: 'word', doc: 'word', txt: 'word', pptx: 'slide', ppt: 'slide',
};
const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');
const linkSecret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET falta o tiene menos de 32 caracteres');
  return `office-link:${s}`;   // separación de dominio: un enlace nunca sirve como sesión ni al revés
};

/** Enlace firmado para que el servidor de oficina descargue un archivo concreto de un workspace concreto */
export function signFileLink(fileId: string, workspaceId: string, now = Date.now()) {
  const body = b64({ f: fileId, w: workspaceId, exp: Math.floor(now / 1000) + LINK_SECONDS });
  return `${body}.${hmac(linkSecret(), body)}`;
}
export function verifyFileLink(token: string): { f: string; w: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(hmac(linkSecret(), body)), b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() / 1000 && typeof p.f === 'string' && typeof p.w === 'string' ? p : null;
  } catch { return null; }
}

/** Configuración del editor firmada (JWT HS256) con el secreto que comparte el servidor de oficina */
export function officeView(file: { id: string; name: string }, workspaceId: string, user: { id: string; name: string; locale: string }): OfficeView {
  const ext = extOf(file.name);
  if (!officeUrl() || officeSecret().length < 16) throw new HttpError(404, 'office_disabled', 'El visor de Office no está configurado');
  if (!TYPES[ext]) throw new HttpError(400, 'office_unsupported', 'Este tipo de archivo no se abre en el visor de Office');
  const config = {
    documentType: TYPES[ext],
    document: {
      fileType: ext, key: file.id, title: file.name,   // los archivos no cambian: el id sirve de clave de caché
      url: `${appUrl()}/api/v1/office/files/${signFileLink(file.id, workspaceId)}`,
      permissions: { edit: false, comment: false, review: false, fillForms: false, modifyFilter: false, download: true, print: true, copy: true },
    },
    editorConfig: {
      mode: 'view', lang: user.locale === 'en' ? 'en' : 'es', user: { id: user.id, name: user.name },
      // Lo mínimo para leer: tema blanco, sin logo, sin panel izquierdo/derecho ni avatares; el título y «Descargar» los pone Kora
      customization: {
        compactHeader: true, toolbarHideFileName: true, hideRightMenu: true, hideRulers: true, uiTheme: 'theme-white',
        feedback: false, help: false, chat: false, comments: false, plugins: false, logo: { visible: false },
        layout: { header: { user: false, users: false, save: false, editMode: false }, leftMenu: false, rightMenu: false },
      },
    },
  };
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(config)}`;
  return { apiUrl: `${officeUrl()}/web-apps/apps/api/documents/api.js`, config: { ...config, token: `${body}.${hmac(officeSecret(), body)}` } };
}

// Pública (sin sesión): solo la usa el servidor de oficina con el enlace firmado
export const officeRouter = Router();
officeRouter.get('/office/files/:token', async (req, res) => {
  const link = verifyFileLink(req.params.token);
  if (!link) throw new HttpError(404, 'file_not_found', 'Archivo no encontrado');
  const file = (await adminPool.query(
    "select storage_key, mime, name from files where id = $1 and workspace_id = $2 and status = 'ready'", [link.f, link.w])).rows[0];
  if (!file) throw new HttpError(404, 'file_not_found', 'Archivo no encontrado');
  const s3 = await fetch(presign('GET', file.storage_key, 60));
  if (!s3.ok || !s3.body) throw new HttpError(502, 'storage_error', 'No se pudo leer el archivo');
  res.set({
    'content-type': file.mime, 'content-length': s3.headers.get('content-length') ?? undefined,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  });
  Readable.fromWeb(s3.body as never).pipe(res);
});
