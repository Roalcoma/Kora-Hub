// Formatos y rangos de Finanzas. El dinero, las fechas y el filtro de fecha se reutilizan de Ventas (no se duplican):
// importar `usd`, `fmtDay`, `today`… desde aquí o desde '@/sales/format.ts' da lo mismo.
import { addMonths, customRange, monthEnd, monthStart, today, type DateFilterValue } from '@/sales/format.ts';

export { usd, fmtDay, today, addMonths, monthStart, monthEnd, type DateFilterValue } from '@/sales/format.ts';

/** Atajos de periodo comunes a Gastos, Nómina, Banco y Resumen (las etiquetas están en finance.periods) */
export const FINANCE_PERIODS = ['month', 'lastMonth', 'next30', 'last90', 'year', 'all'] as const;
export type FinancePeriod = (typeof FINANCE_PERIODS)[number];

/** Suma días a una fecha YYYY-MM-DD */
export function addDays(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Rango { from, to } de un valor del DateFilter con los atajos de FINANCE_PERIODS (o los propios: hoy, un día, rango) */
export function financeRange(v: DateFilterValue): { from: string | undefined; to: string | undefined } {
  const custom = customRange(v);
  if (custom) return custom;
  const now = today();
  switch (v.period) {
    case 'month': return { from: monthStart(now), to: monthEnd(now) };
    case 'lastMonth': { const m = addMonths(monthStart(now), -1); return { from: m, to: monthEnd(m) }; }
    case 'next30': return { from: now, to: addDays(now, 30) };
    case 'last90': return { from: addDays(now, -90), to: now };
    case 'year': return { from: `${now.slice(0, 4)}-01-01`, to: `${now.slice(0, 4)}-12-31` };
    default: return { from: undefined, to: undefined };
  }
}

/** Querystring sin vacíos, para los enlaces de CSV */
export const qs = (q: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();

/** Nombre corto del día de la semana (0 = domingo … 6 = sábado) en el idioma de la UI */
export const weekdayName = (d: number, locale: string, width: 'short' | 'long' = 'short') =>
  new Date(Date.UTC(2026, 0, 4 + d)).toLocaleDateString(locale, { weekday: width, timeZone: 'UTC' });   // 4 ene 2026 fue domingo
/** Lunes primero, como se lee una semana de trabajo */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

type Rule = { frequency: 'daily' | 'weekly' | 'monthly'; interval: number; weekdays: number[] | null; monthDay: number | 'last' | null; businessDaysOnly: boolean };
type T = (key: string, ...args: any[]) => string;   // el `t` de vue-i18n
/** "Cada 2 semanas · lun, mié", "Cada mes · último día", "Cada día · solo hábiles" */
export function scheduleRule(r: Rule, t: T, locale: string) {
  const n = r.interval || 1;
  const parts = [t(`finance.schedules.every.${r.frequency}`, { n }, n)];
  if (r.frequency === 'weekly' && r.weekdays?.length)
    parts.push(WEEK_ORDER.filter((d) => r.weekdays!.includes(d)).map((d) => weekdayName(d, locale)).join(', '));
  if (r.frequency === 'monthly' && r.monthDay != null)
    parts.push(r.monthDay === 'last' ? t('finance.schedules.lastDay') : t('finance.schedules.onDay', { d: r.monthDay }));
  if (r.frequency === 'daily' && r.businessDaysOnly) parts.push(t('finance.schedules.businessDays'));
  return parts.join(' · ');
}

/** Texto de un input de dinero → número con 2 decimales (el contrato exige múltiplos de 0.01) */
export const cents = (v: string | number) => Math.round(Number(v) * 100) / 100;
