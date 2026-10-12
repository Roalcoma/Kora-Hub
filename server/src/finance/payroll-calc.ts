// Cálculo puro de nómina (docs/plan-finanzas.md §3, ADR 0007): sin BD, para probarlo aislado.
// Todo en centavos enteros; el desglose sale en dólares (como el resto del contrato).
//
// Decisiones:
// - Vigencia: en una corrida se usan los componentes vigentes a la FECHA DE FIN del periodo (sin prorrateo).
//   Un aumento a mitad de periodo aplica completo en ese periodo; un componente que terminó antes del fin no aplica.
// - Neto negativo: se permite (deducciones > bruto) y se marca con un renglón informativo de monto 0 al final.
// - Comisiones con chargebacks: si la suma de cuotas pagadas del periodo es negativa, no resta del bruto sino que
//   entra como deducción ("deduction_fixed") por su valor absoluto; así ningún renglón lleva monto negativo.
import type { ComponentKind, PayrollFrequency, PayrollItem } from '@agencia-hub/contracts';

// ─── Fechas (YYYY-MM-DD, aritmética en UTC para no correr el día) ───

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => { const x = toDate(d); x.setUTCDate(x.getUTCDate() + n); return fmt(x); };
const diffDays = (a: string, b: string) => Math.round((toDate(a).getTime() - toDate(b).getTime()) / 86_400_000);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();   // m en base 0
const ymd = (y: number, m: number, d: number) => fmt(new Date(Date.UTC(y, m, d)));

export type Period = { periodStart: string; periodEnd: string; payDate: string };
export type CalendarRule = { frequency: PayrollFrequency; anchorDate: string | null; payDay: number | 'last' | null };

/**
 * Periodo que contiene `day` según la frecuencia:
 * - weekly / biweekly: `anchorDate` es una fecha de pago del ciclo; cada pago cubre los 7 (o 14) días anteriores
 *   (periodo = [pago − n, pago − 1]).
 * - semimonthly: 1–15 (paga el 15) y 16–último (paga el último).
 * - monthly: mes calendario; paga el `payDay` del mes siguiente, o el último día del mismo mes si es 'last'/31
 *   (un día mayor al último del mes cae en el último).
 */
export function periodContaining(cal: CalendarRule, day: string): Period {
  if (cal.frequency === 'weekly' || cal.frequency === 'biweekly') {
    const n = cal.frequency === 'weekly' ? 7 : 14;
    const anchorStart = addDays(cal.anchorDate!, -n);
    const k = Math.floor(diffDays(day, anchorStart) / n);
    const periodStart = addDays(anchorStart, k * n);
    return { periodStart, periodEnd: addDays(periodStart, n - 1), payDate: addDays(periodStart, n) };
  }
  const d = toDate(day);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (cal.frequency === 'semimonthly') {
    return d.getUTCDate() <= 15
      ? { periodStart: ymd(y, m, 1), periodEnd: ymd(y, m, 15), payDate: ymd(y, m, 15) }
      : { periodStart: ymd(y, m, 16), periodEnd: ymd(y, m, lastDay(y, m)), payDate: ymd(y, m, lastDay(y, m)) };
  }
  const end = ymd(y, m, lastDay(y, m));
  const pd = cal.payDay ?? 'last';
  const payDate = pd === 'last' || pd >= lastDay(y, m) ? end : ymd(y, m + 1, Math.min(pd, lastDay(y, m + 1)));
  return { periodStart: ymd(y, m, 1), periodEnd: end, payDate };
}

/**
 * Siguiente periodo sugerido: el primero sin corrida a partir del día siguiente a la última corrida
 * (o del periodo de `today` si el calendario no tiene corridas).
 */
export function nextPeriod(cal: CalendarRule, today: string, runs: { periodStart: string; periodEnd: string }[]): Period {
  const taken = new Set(runs.map((r) => r.periodStart));
  const lastEnd = runs.reduce<string | null>((max, r) => (max == null || r.periodEnd > max ? r.periodEnd : max), null);
  let p = periodContaining(cal, lastEnd ? addDays(lastEnd, 1) : today);
  for (let i = 0; i < 120 && taken.has(p.periodStart); i++) p = periodContaining(cal, addDays(p.periodEnd, 1));
  return p;
}

// ─── Línea de nómina ───

export type CalcComponent = {
  id: string; kind: ComponentKind; label: string; amount: number | null; rate: number | null;
  effectiveFrom: string; effectiveTo: string | null;
};
export type CalcAdjustment = { id: string; kind: 'bonus' | 'deduction'; label: string; amount: number };
export type CalcInput = {
  periodEnd: string;
  components: CalcComponent[];            // todos los de la persona: aquí se filtran por vigencia
  hours: number | null;
  hasUser: boolean;                       // enlazada a un usuario de Kora (comisiones y % de ventas)
  commissions: { cents: number; count: number };   // cuotas pagadas en el periodo (chargebacks incluidos)
  issuedSales: { cents: number; count: number };   // ventas ISSUED del periodo
  adjustments: CalcAdjustment[];
};
export type CalcResult = { grossCents: number; deductionsCents: number; netCents: number; breakdown: PayrollItem[]; hasHourly: boolean };

export const toCents = (amount: number | string) => Math.round(Number(amount) * 100);
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (rate: number) => `${Number(rate.toFixed(3))} %`;

const DEFAULT_LABEL: Record<ComponentKind, string> = {
  salary: 'Sueldo', hourly: 'Horas', sales_commission: 'Comisiones de ventas', sales_percent: '% de ventas',
  bonus: 'Bono', deduction_fixed: 'Deducción', deduction_percent: 'Deducción %',
};

/** Vigente a la fecha `day` (desde ≤ día ≤ hasta) */
export const effectiveAt = (c: { effectiveFrom: string; effectiveTo: string | null }, day: string) =>
  c.effectiveFrom <= day && (c.effectiveTo == null || c.effectiveTo >= day);

/**
 * Bruto = sueldo + horas + comisiones + % de ventas + bonos + ajustes de bono.
 * Deducciones = fijas + % del bruto + ajustes de deducción (+ chargebacks netos). Neto = bruto − deducciones.
 */
export function computeLine(input: CalcInput): CalcResult {
  const comps = input.components.filter((c) => effectiveAt(c, input.periodEnd));
  const earnings: PayrollItem[] = [];
  const deductions: PayrollItem[] = [];
  const item = (c: CalcComponent, cents: number, detail: string | null): PayrollItem =>
    ({ kind: c.kind, label: c.label || DEFAULT_LABEL[c.kind], amount: cents / 100, detail, sourceId: c.id });
  let commissionDone = false;

  for (const c of comps) {
    switch (c.kind) {
      case 'salary': case 'bonus':
        earnings.push(item(c, toCents(c.amount!), null));
        break;
      case 'hourly': {
        const hours = input.hours ?? 0;
        earnings.push(item(c, Math.round(hours * toCents(c.amount!)), input.hours == null ? 'Sin horas cargadas' : `${hours} h × ${usd(toCents(c.amount!))}`));
        break;
      }
      case 'sales_commission': {
        if (commissionDone) break;            // dos componentes de comisión vigentes no cobran doble
        commissionDone = true;
        const { cents, count } = input.commissions;
        const detail = input.hasUser ? `${count} ${count === 1 ? 'cuota pagada' : 'cuotas pagadas'}` : 'Sin usuario de Kora enlazado';
        if (cents >= 0) earnings.push(item(c, cents, detail));
        else deductions.push({ kind: 'deduction_fixed', label: 'Chargebacks de comisión', amount: -cents / 100, detail, sourceId: c.id });
        break;
      }
      case 'sales_percent': {
        const cents = Math.round((input.issuedSales.cents * c.rate!) / 100);
        earnings.push(item(c, cents, input.hasUser ? `${pct(c.rate!)} de ${usd(input.issuedSales.cents)} (${input.issuedSales.count} ventas)` : 'Sin usuario de Kora enlazado'));
        break;
      }
    }
  }
  for (const a of input.adjustments.filter((a) => a.kind === 'bonus')) {
    earnings.push({ kind: 'adjustment_bonus', label: a.label, amount: toCents(a.amount) / 100, detail: null, sourceId: a.id });
  }
  const grossCents = earnings.reduce((t, i) => t + toCents(i.amount), 0);

  for (const c of comps) {
    if (c.kind === 'deduction_fixed') deductions.push(item(c, toCents(c.amount!), null));
    if (c.kind === 'deduction_percent') deductions.push(item(c, Math.round((grossCents * c.rate!) / 100), `${pct(c.rate!)} de ${usd(grossCents)}`));
  }
  for (const a of input.adjustments.filter((a) => a.kind === 'deduction')) {
    deductions.push({ kind: 'adjustment_deduction', label: a.label, amount: toCents(a.amount) / 100, detail: null, sourceId: a.id });
  }
  const deductionsCents = deductions.reduce((t, i) => t + toCents(i.amount), 0);
  const netCents = grossCents - deductionsCents;
  const breakdown = [...earnings, ...deductions];
  if (netCents < 0) {
    breakdown.push({ kind: 'adjustment_deduction', label: 'Neto negativo', amount: 0, detail: `Las deducciones superan el bruto por ${usd(-netCents)}`, sourceId: null });
  }
  return { grossCents, deductionsCents, netCents, breakdown, hasHourly: comps.some((c) => c.kind === 'hourly') };
}
