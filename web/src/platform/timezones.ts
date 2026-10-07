// Zonas horarias para el selector del perfil: todas las IANA que conoce el navegador, ordenadas por desfase UTC.
// Etiqueta legible ("America / New York") y pista con el desfase y la hora actual allí.

const offsetMinutes = (tz: string, at: Date) => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
    .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
};
const fmtOffset = (min: number) => `UTC${min < 0 ? '−' : '+'}${String(Math.floor(Math.abs(min) / 60)).padStart(2, '0')}:${String(Math.abs(min) % 60).padStart(2, '0')}`;

export function timezoneOptions(locale: string, current?: string) {
  const now = new Date();
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  // La zona guardada siempre aparece, aunque el navegador no la liste (p. ej. "UTC")
  if (current && !zones.includes(current)) zones.push(current);
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  return zones
    .map((tz) => {
      let off = 0;
      let hour = '';
      try { off = offsetMinutes(tz, now); hour = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(now); } catch { hour = time.format(now); }
      return { value: tz, label: tz.replace(/_/g, ' ').replace(/\//g, ' / '), hint: `${fmtOffset(off)} · ${hour}`, off };
    })
    .sort((a, b) => a.off - b.off || a.label.localeCompare(b.label))
    .map(({ off: _off, ...o }) => o);
}
