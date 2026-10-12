// Cálculo de comisiones (docs/plan-comisiones.md §2). Todo en centavos enteros: nada de flotantes con dinero.

export type Share = { beneficiaryUserId: string; kind: 'direct' | 'override'; rate: number };
/** `seq`: 0 = adelanto, 1..n = cuotas mensuales del resto (ADR 0008) */
export type NewInstallment = Share & { part: 'advance' | 'remainder'; seq: number; amountCents: number; monthsAfterIssue: number };

/**
 * Directa: % del agente sobre el monto. Override (un nivel): el dueño cobra su % menos el del agente, nunca negativo.
 * Cada parte se divide en adelanto (`advanceMonths` de 12, al ISSUE) y resto en cuotas mensuales.
 */
export function commissionShares(
  agent: { userId: string; rate: number },
  upline: { userId: string; rate: number } | null,
): Share[] {
  const shares: Share[] = [{ beneficiaryUserId: agent.userId, kind: 'direct', rate: agent.rate }];
  if (upline) shares.push({ beneficiaryUserId: upline.userId, kind: 'override', rate: Math.max(0, round3(upline.rate - agent.rate)) });
  return shares.filter((s) => s.rate > 0);
}

/**
 * Adelanto al ISSUE y el resto en cuotas de 1/12 del total en los meses advanceMonths+1 … 12. La última cuota absorbe el
 * redondeo para que la suma sea exactamente el total. Las cuotas en 0 se omiten y `seq` queda consecutivo.
 */
export function installments(amountCents: number, advanceMonths: number, shares: Share[]): NewInstallment[] {
  return shares.flatMap((s) => {
    const total = Math.round((amountCents * s.rate) / 100);
    const advance = Math.round((total * advanceMonths) / 12);
    const rest = remainderCents(total, total - advance, 12 - advanceMonths)
      .map((amountCents, k) => ({ amountCents, monthsAfterIssue: advanceMonths + 1 + k }))
      .filter((r) => r.amountCents > 0)
      .map((r, k) => ({ ...s, part: 'remainder' as const, seq: k + 1, ...r }));
    return [...(advance > 0 ? [{ ...s, part: 'advance' as const, seq: 0, amountCents: advance, monthsAfterIssue: 0 }] : []), ...rest];
  });
}

/** Reparte `remainder` en `n` cuotas de round(total/12); la última absorbe la diferencia */
export function remainderCents(total: number, remainder: number, n: number): number[] {
  if (n <= 0 || remainder <= 0) return [];
  // En montos de pocos centavos round(total/12) podría dejar la última en negativo: se acota
  const each = n > 1 ? Math.min(Math.round(total / 12), Math.floor(remainder / (n - 1))) : 0;
  return [...Array(n - 1).fill(each), remainder - each * (n - 1)];
}

/** Chargeback: `percent` de lo que ya se le pagó a cada beneficiario, como monto negativo */
export function chargebackCents(paidCents: number, percent: number): number {
  return -Math.round((paidCents * percent) / 100);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const toCents = (amount: number | string) => Math.round(Number(amount) * 100);
