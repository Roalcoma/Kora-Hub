// Lectura de estados de cuenta en CSV (docs/plan-finanzas.md §4, ADR 0007). Funciones puras, sin dependencias:
// parser CSV, fechas y montos según el mapeo de la cuenta, clave de duplicado y sugerencia de compañía.
import type { CsvMapping, ImportRow } from '@agencia-hub/contracts';
import { normalize } from '../sales/routes.ts';

export type CsvRecord = { line: number; cells: string[] };   // line = línea del archivo donde empieza el registro (1 = primera)
type DateFormat = CsvMapping['dateFormat'];

/** Topes del parser (revisión de seguridad F1): lo que exceda se descarta en silencio */
export const MAX_CSV_CELL_CHARS = 1_000;
export const MAX_CSV_CELLS = 200;
/** Ningún monto ni fecha legítimo pasa de esto; se corta antes de aplicar regex (F1) */
const MAX_VALUE_CHARS = 32;

/**
 * Parser CSV (RFC 4180 tolerante): BOM, comillas dobles con "" escapadas, saltos CRLF/LF/CR y saltos de línea dentro
 * de campos entre comillas. Omite las líneas en blanco. Cada celda se corta a MAX_CSV_CELL_CHARS y cada registro a
 * MAX_CSV_CELLS celdas, para que un archivo hostil no produzca encabezados o celdas gigantes.
 */
export function parseCsv(text: string, delimiter: string): CsvRecord[] {
  const out: CsvRecord[] = [];
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let cells: string[] = [];
  let cell = '';
  let quoted = false;     // dentro de un campo entre comillas
  let line = 1;           // línea física actual
  let start = 1;          // línea donde empezó el registro en curso
  const add = (c: string) => { if (cell.length < MAX_CSV_CELL_CHARS) cell += c; };
  const push = () => { if (cells.length < MAX_CSV_CELLS) cells.push(cell); cell = ''; };
  const endRecord = () => {
    push();
    if (cells.length > 1 || cells[0]!.trim() !== '') out.push({ line: start, cells });
    cells = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { add('"'); i++; } else quoted = false;
      } else {
        if (c === '\n' || (c === '\r' && s[i + 1] !== '\n')) line++;
        add(c);
      }
    } else if (c === '"' && cell.trim() === '') {
      quoted = true; cell = '';
    } else if (c === delimiter) {
      push();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRecord();
      line++; start = line;
    } else {
      add(c);
    }
  }
  if (cell !== '' || cells.length) endRecord();
  return out;
}

/** Separador más probable según la primera línea con contenido (sin contar lo que va entre comillas) */
export function detectDelimiter(text: string): CsvMapping['delimiter'] {
  const first = (text.replace(/^﻿/, '').split(/\r?\n|\r/).find((l) => l.trim()) ?? '').replace(/"[^"]*"/g, '');
  const counts = ([',', ';', '\t', '|'] as const).map((d) => [d, first.split(d).length - 1] as const);
  return counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/** Fecha del CSV según el formato del mapeo → YYYY-MM-DD, o null si es ilegible. Acepta días/meses de 1 dígito y hora al final. */
export function parseCsvDate(raw: string, format: DateFormat): string | null {
  if (raw.length > MAX_VALUE_CHARS) return null;
  const m = raw.trim().split(/[\sT]/)[0]!.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/);
  if (!m) return null;
  const [a, b, c] = [m[1]!, m[2]!, m[3]!];
  const order = format.startsWith('YYYY') ? [a, b, c] : format.startsWith('MM') ? [c, a, b] : [c, b, a];   // [año, mes, día]
  let [y, mo, d] = order.map(Number) as [number, number, number];
  const yLen = order[0]!.length;
  if (format.endsWith('YY') && !format.endsWith('YYYY') ? yLen !== 2 : yLen !== 4) return null;
  if (yLen === 2) y += 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1990 || y > 2100) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Monto del CSV → número con 2 decimales, o null si es ilegible o viene vacío. Acepta $, espacios, separador de miles,
 * signo delante o detrás, paréntesis como negativo y coma decimal ("1.234,56"; "12,5"; pero "1,234" es mil).
 */
export function parseCsvAmount(raw: string): number | null {
  if (raw.length > MAX_VALUE_CHARS) return null;   // F1: nada de regex sobre celdas largas
  let s = raw.trim().replace(/[$\s ]|USD/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[-+]/.test(s)) { neg = neg !== (s[0] === '-'); s = s.slice(1); }
  else if (/[-+]$/.test(s)) { neg = neg !== s.endsWith('-'); s = s.slice(0, -1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // El separador que va último es el decimal y debe aparecer una sola vez; si no, el monto es ambiguo
    if (lastComma > lastDot ? s.indexOf(',') !== lastComma : s.indexOf('.') !== lastDot) return null;
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Solo comas: si hay una sola y no va seguida de exactamente 3 dígitos, es decimal
    s = (s.split(',').length === 2 && !/,\d{3}$/.test(s)) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (s.split('.').length > 2) {
    s = s.replace(/\./g, '');   // "1.234.567" = miles con punto
  }
  if (!/^\d*(\.\d*)?$/.test(s)) return null;   // sin ambigüedad: lineal (F1)
  const n = Math.round(Number(s) * 100) / 100;
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Fila interpretada con el mapeo, sin compañía ni duplicado (eso depende de la BD) */
export type ParsedRow = Omit<ImportRow, 'carrierId' | 'duplicate'>;

/** Separa encabezado y filas de datos según skipRows/hasHeader */
export function splitRecords(records: CsvRecord[], mapping: Pick<CsvMapping, 'skipRows' | 'hasHeader'>) {
  const rest = records.slice(mapping.skipRows);
  return { header: mapping.hasHeader ? rest[0] ?? null : null, data: mapping.hasHeader ? rest.slice(1) : rest };
}

export function interpretRow(r: CsvRecord, mapping: CsvMapping): ParsedRow {
  const cell = (i: number | null) => (i == null ? '' : (r.cells[i] ?? '').trim());
  const postedOn = parseCsvDate(cell(mapping.dateColumn), mapping.dateFormat);
  let amount: number | null;
  if (mapping.amount.mode === 'single') {
    amount = parseCsvAmount(cell(mapping.amount.column));
    if (amount !== null && mapping.amount.invert) amount = -amount;
  } else {
    const debit = parseCsvAmount(cell(mapping.amount.debitColumn));
    const credit = parseCsvAmount(cell(mapping.amount.creditColumn));
    amount = debit === null && credit === null ? null : Math.round((Math.abs(credit ?? 0) - Math.abs(debit ?? 0)) * 100) / 100;
  }
  const error = !postedOn ? 'Fecha ilegible'
    : amount === null ? 'Monto ilegible'
    : amount === 0 ? 'Monto en cero'
    : Math.abs(amount) > 10_000_000 ? 'Monto fuera de rango'
    : null;
  return {
    line: r.line, postedOn, amount: amount === null || Number.isNaN(amount) ? null : amount,
    description: cell(mapping.descriptionColumn).replace(/\s+/g, ' ').slice(0, 300),
    reference: cell(mapping.referenceColumn).slice(0, 120),
    error,
  };
}

/** Clave de duplicado (ADR 0007): fecha|monto|referencia, o la descripción en minúsculas sin espacios repetidos si no hay referencia */
export const dedupeKey = (postedOn: string, amount: number, reference: string, description: string) =>
  `${postedOn}|${amount.toFixed(2)}|${reference.trim() || description.toLowerCase().replace(/\s+/g, ' ').trim()}`;

export type CarrierTerms = { id: string; name: string; aliases: string[] };
const words = (s: string) => ` ${normalize(s).replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * Compañía sugerida por la descripción: nombre o alias que aparezca como palabras completas (sin acentos, minúsculas);
 * gana la coincidencia más larga ("americo fin" le gana a "americo"). Solo para entradas (monto > 0).
 */
export function suggestCarrier(description: string, amount: number | null, carriers: CarrierTerms[]): string | null {
  if (amount === null || amount <= 0) return null;
  const text = words(description);
  let best: { id: string; len: number } | null = null;
  for (const c of carriers) {
    for (const term of [c.name, ...c.aliases]) {
      const t = words(term);
      if (t.trim() && text.includes(t) && (!best || t.length > best.len)) best = { id: c.id, len: t.length };
    }
  }
  return best?.id ?? null;
}
