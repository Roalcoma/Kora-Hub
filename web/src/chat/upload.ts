// Subida de un archivo: pedir alta → PUT del contenido (con progreso) → confirmar.
import { reactive } from 'vue';
import type { FileRef } from '@agencia-hub/contracts';
import { ALLOWED_MIME } from '@agencia-hub/contracts';
import { api } from '@/api.ts';

export type Upload = { key: string; name: string; progress: number; file?: FileRef; error?: string; preview?: string };

const allowed = new Set<string>(ALLOWED_MIME);

async function imageSize(f: File): Promise<{ width?: number; height?: number }> {
  if (!f.type.startsWith('image/') || f.type === 'image/heic') return {};
  try {
    const bmp = await createImageBitmap(f);
    return { width: bmp.width, height: bmp.height };
  } catch {
    return {};
  }
}

function put(url: string, f: File, onProgress: (p: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', f.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.statusText)));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(f);
  });
}

/** Sube `f` y va actualizando el objeto reactivo devuelto (progreso, error o FileRef final). */
export function uploadFile(slug: string, f: File, maxMb: number, texts: { tooBig: string; failed: string }): Upload {
  const u = reactive<Upload>({ key: `${f.name}-${f.size}-${Math.random()}`, name: f.name, progress: 0 });
  if (f.type.startsWith('image/')) u.preview = URL.createObjectURL(f);
  if (!allowed.has(f.type)) { u.error = texts.failed; return u; }
  if (f.size > maxMb * 1024 * 1024) { u.error = texts.tooBig; return u; }
  (async () => {
    try {
      const dims = await imageSize(f);
      const { fileId, uploadUrl } = await api('POST /w/:slug/files', {
        params: { slug }, body: { name: f.name, mime: f.type as (typeof ALLOWED_MIME)[number], size: f.size, context: 'message', ...dims },
      });
      await put(uploadUrl, f, (p) => { u.progress = p; });
      u.file = await api('POST /w/:slug/files/:id/complete', { params: { slug, id: fileId } });
      u.progress = 1;
    } catch (e: any) {
      u.error = e?.message && e.message !== 'network' ? e.message : texts.failed;
    }
  })();
  return u;
}
