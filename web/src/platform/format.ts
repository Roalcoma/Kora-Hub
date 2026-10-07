// Formatos compartidos por Facturación y el backoffice.
import type { WorkspaceStatus } from '@agencia-hub/contracts';

/** Centavos de USD → "$6" / "$6.50" (es-US para que el español no muestre "6 US$") */
export const money = (cents: number, locale: string) =>
  new Intl.NumberFormat(locale === 'es' ? 'es-US' : 'en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

/** Bytes → "1.2 GB" */
export function bytes(n: number, locale: string) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i ? 1 : 0 }).format(n)} ${units[i]}`;
}

/** Tono del Badge para el estado del plan */
export const statusTone = (st: WorkspaceStatus) =>
  ({ trialing: 'primary', active: 'success', past_due: 'warning', read_only: 'warning', suspended: 'danger', closing: 'danger' } as const)[st];

/** Días que faltan hasta una fecha (0 si ya pasó) */
export const daysUntil = (iso: string | null) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000)) : 0);
