// Contenido de manuales (JSON de Tiptap): se limpia en el borde de la API y se extrae el texto para la búsqueda.
// El cliente lo pinta con el esquema de Tiptap (sin v-html); aun así aquí se quitan imágenes externas
// (rastreo, contenido no controlado) y enlaces con esquemas peligrosos (javascript:, data:).
import { HttpError } from '../platform/http.ts';

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/))/i;
const invalid = () => new HttpError(400, 'invalid_content', 'El contenido del manual no es válido');

/** Devuelve el documento limpio y su texto plano. `filePrefix`: única fuente permitida para imágenes. */
export function sanitizeDoc(content: unknown, filePrefix: string): { content: object; text: string } {
  const parts: string[] = [];
  const walk = (n: any, depth: number): object | null => {
    if (depth > 60 || !n || typeof n !== 'object' || typeof n.type !== 'string') throw invalid();
    if (n.type === 'image' && !String(n.attrs?.src ?? '').startsWith(filePrefix)) return null;
    const out = { ...n };
    if (typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.marks)) out.marks = n.marks.filter((m: any) => m?.type !== 'link' || SAFE_HREF.test(String(m.attrs?.href ?? '')));
    if (Array.isArray(n.content)) {
      out.content = n.content.map((c: unknown) => walk(c, depth + 1)).filter(Boolean);
      parts.push('\n');
    }
    return out;
  };
  if ((content as any)?.type !== 'doc') throw invalid();
  const doc = walk(content, 0)!;
  return { content: doc, text: parts.join('').replace(/\n+/g, '\n').trim().slice(0, 200_000) };
}
