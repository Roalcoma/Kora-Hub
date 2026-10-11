// Formatos del módulo de ventas: dinero en USD y fechas sin hora (YYYY-MM-DD).

/** 1199.88 → "$1,199.88" (es-US para que el español no muestre "1.199,88 US$") */
export const usd = (n: number, locale: string) =>
  new Intl.NumberFormat(locale === 'es' ? 'es-US' : 'en-US', { style: 'currency', currency: 'USD' }).format(n);

/** "2026-10-15" → "15 oct 2026". Mediodía UTC: así ninguna zona horaria corre el día. */
export const fmtDay = (day: string, locale: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Hoy en Nueva York, igual que el servidor */
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Suma meses a una fecha YYYY-MM-DD */
export function addMonths(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
/** Último día del mes de esa fecha (día 0 del mes siguiente) */
export const monthEnd = (day: string) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).toISOString().slice(0, 10);

/** Filtro de fecha de Ventas y Comisiones: `period` es un atajo de la pestaña o uno de los propios (hoy, un día, rango) */
export type DateFilterValue = { period: string; from: string; to: string };
export const CUSTOM_PERIODS = ['today', 'day', 'range'] as const;
type Range = { from: string | undefined; to: string | undefined };
/** Rango de los periodos propios del filtro; null si es un atajo (lo resuelve cada pestaña) */
export function customRange(v: DateFilterValue): Range | null {
  if (v.period === 'today') return { from: today(), to: today() };
  if (v.period === 'day' || v.period === 'range') return { from: v.from || undefined, to: v.to || undefined };
  return null;
}
