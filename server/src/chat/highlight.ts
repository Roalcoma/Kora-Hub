// Fragmento de resultado de búsqueda con «coincidencias» marcadas, ignorando acentos y mayúsculas
// pero conservando el texto original (ts_headline no marca "póliza" al buscar "poliza").

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function highlight(text: string, query: string, window = 140): string {
  // Texto plegado + mapa de cada carácter plegado a su posición en el original
  let folded = '';
  const map: number[] = [];
  [...text].reduce((pos, ch) => {
    for (const f of fold(ch)) { folded += f; map.push(pos); }
    return pos + ch.length;
  }, 0);
  const terms = fold(query).split(/\s+/).filter((t) => t.length >= 2);
  const ranges: [number, number][] = [];
  for (const t of terms) {
    for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) {
      ranges.push([map[i]!, (map[i + t.length - 1] ?? text.length - 1) + 1]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, first - Math.floor(window / 3));
  const end = Math.min(text.length, start + window);
  let out = '';
  let cur = start;
  for (const [a, b] of ranges) {
    if (a < cur || b > end) continue;
    out += text.slice(cur, a) + '«' + text.slice(a, b) + '»';
    cur = b;
  }
  out += text.slice(cur, end);
  return (start > 0 ? '…' : '') + out + (end < text.length ? '…' : '');
}
