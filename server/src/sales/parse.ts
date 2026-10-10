// Lector de mensajes de venta del canal de Discord (docs/plan-comisiones.md §1). Formato real de VFS:
//   "$1199.88 Americo IUL 10/23 OK (Jose Gonzalez Valdez)"   "$1800 FEX AMÉRICO UPPON ISSUE(Norma Salgado)"
// Monto, compañía y producto (en cualquier orden, por alias), "upon issue" o fecha MM/DD, estado y cliente entre paréntesis.
import { US_STATES } from '@agencia-hub/contracts';

export type CatalogCarrier = { id: string; name: string; aliases: string[]; products: { id: string; name: string; aliases: string[] }[] };
/** Qué le faltó al mensaje; la UI lo traduce */
export type Problem = 'amount' | 'carrier' | 'product' | 'date' | 'client' | 'agent';
export type ParsedSale = {
  amount?: number; carrierId?: string; productId?: string; clientName?: string; clientState?: string; expectedIssueDate?: string;
  problems: Problem[];
};

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** ¿El alias aparece como palabra(s) completa(s) en el texto ya normalizado? */
const has = (text: string, alias: string) =>
  alias.length > 0 && new RegExp(`(^|[^a-z0-9])${fold(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text);
const STATES = new Set<string>(US_STATES);

/** Un mensaje con monto en dólares parece una venta; el resto es conversación y se ignora */
export const looksLikeSale = (content: string) => /\$\s*\d/.test(content);

/** `postedOn`: día del mensaje en Nueva York (YYYY-MM-DD), para "upon issue" y para deducir el año de "10/23" */
export function parseSale(content: string, postedOn: string, catalog: CatalogCarrier[]): ParsedSale {
  const out: ParsedSale = { problems: [] };

  // Cliente: lo último entre paréntesis, tal como lo escribieron
  const client = /\(([^()]+)\)[^()]*$/.exec(content);
  if (client?.[1]?.trim()) out.clientName = client[1].trim().replace(/\s+/g, ' ');
  else out.problems.push('client');
  const rest = client ? content.slice(0, client.index) + content.slice(client.index + client[0].length) : content;
  const text = fold(rest);

  const amount = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/.exec(rest);
  if (amount) out.amount = Number(amount[1]!.replace(/,/g, ''));
  if (!out.amount) out.problems.push('amount');

  // Fecha: "upon issue" (también "uppon", "upon-issue") = el día del mensaje; si no, MM/DD o MM/DD/AA
  if (/\bupp?on[\s-]*issue\b/.test(text)) out.expectedIssueDate = postedOn;
  else {
    const d = /(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?=\s|$)/.exec(text);
    const [m, day] = d ? [Number(d[1]), Number(d[2])] : [0, 0];
    if (d && m >= 1 && m <= 12 && day >= 1 && day <= 31) {
      let year = d[3] ? Number(d[3].length === 2 ? `20${d[3]}` : d[3]) : Number(postedOn.slice(0, 4));
      const iso = (y: number) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      // Sin año: es la próxima vez que llega esa fecha (un "1/05" escrito en diciembre es de enero siguiente)
      if (!d[3] && Date.parse(iso(year)) < Date.parse(postedOn) - 60 * 86400_000) year++;
      out.expectedIssueDate = iso(year);
    } else out.problems.push('date');
  }

  // Compañía por nombre o alias (gana el alias más largo); producto por alias dentro de esa compañía
  const hits = catalog.flatMap((c) => [c.name, ...c.aliases].filter((a) => has(text, a)).map((a) => ({ c, len: a.length })))
    .sort((a, b) => b.len - a.len);
  const carrier = hits[0]?.c;
  if (!carrier || hits.some((h) => h.c.id !== carrier.id && h.len === hits[0]!.len)) out.problems.push('carrier');
  else {
    out.carrierId = carrier.id;
    const products = carrier.products.filter((p) => [p.name, ...p.aliases].some((a) => has(text, a)));
    if (products.length === 1) out.productId = products[0]!.id;
    else out.problems.push('product');
  }

  // Estado: dos letras en mayúscula que sean un estado de EE. UU. y no parte de un alias (p. ej. "OK", "NY", "CA")
  const used = new Set(catalog.flatMap((c) => [c.name, ...c.aliases, ...c.products.flatMap((p) => [p.name, ...p.aliases])]).map(fold));
  const state = rest.match(/(?<![\p{L}\d])[A-Z]{2}(?![\p{L}\d])/gu)?.find((x) => STATES.has(x) && !used.has(fold(x)));
  if (state) out.clientState = state;
  return out;
}
