// Markdown restringido → HTML seguro. Primero se escapa todo; después solo se agregan etiquetas conocidas.
// Soporta: **negrita** _cursiva_ ~tachado~ `código` ```bloque``` listas "- ", enlaces https y menciones.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type NameLookup = (userId: string) => string | undefined;

// Marcadores de uso privado de Unicode: no aparecen en texto normal
const OPEN = '';
const CLOSE = '';

function inline(s: string, name: NameLookup, me?: string): string {
  // Código, enlaces y menciones se apartan primero para que su contenido no reciba formato
  const stash: string[] = [];
  const keep = (html: string) => `${OPEN}${stash.push(html) - 1}${CLOSE}`;
  return s
    .replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`))
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,!?;:)]/g, (url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`))
    // Menciones (en el texto escapado ya son &lt;@id&gt;)
    .replace(/&lt;@([0-9a-f-]{36})&gt;/g, (_, id: string) =>
      keep(`<span class="mention${id === me ? ' me' : ''}">@${esc(name(id) ?? 'alguien')}</span>`))
    .replace(/&lt;!channel&gt;/g, () => keep('<span class="mention all">@canal</span>'))
    .replace(/&lt;!here&gt;/g, () => keep('<span class="mention all">@aquí</span>'))
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?])/g, '$1<s>$2</s>')
    // Marcas de búsqueda «…»
    .replace(/«([^»]+)»/g, '<mark>$1</mark>')
    .replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, i: string) => stash[Number(i)]!);
}

export function renderBody(body: string, name: NameLookup, me?: string): string {
  const parts = esc(body).split(/```/);
  return parts.map((part, i) => {
    if (i % 2) return `<pre><code>${part.replace(/^\n/, '')}</code></pre>`;
    // Agrupa líneas "- " consecutivas en listas
    const lines = part.split('\n');
    let html = '';
    let inList = false;
    for (const [n, line] of lines.entries()) {
      const item = /^\s*[-•]\s+(.*)$/.exec(line);
      if (item) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inline(item[1]!, name, me)}</li>`;
        continue;
      }
      if (inList) { html += '</ul>'; inList = false; }
      html += inline(line, name, me) + (n < lines.length - 1 ? '<br>' : '');
    }
    return html + (inList ? '</ul>' : '');
  }).join('');
}

/** UUID v4 también en contextos sin HTTPS (iPhone por la red local), donde crypto.randomUUID no existe. */
export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

/** Texto plano de un mensaje (título de una tarea creada desde el chat). */
export const plainBody = (body: string, name: NameLookup) => body
  .replace(/<@([0-9a-f-]{36})>/g, (_, id: string) => `@${name(id) ?? 'alguien'}`)
  .replace(/<!channel>/g, '@canal').replace(/<!here>/g, '@aquí')
  .replace(/```|\*\*|`/g, '').trim();
