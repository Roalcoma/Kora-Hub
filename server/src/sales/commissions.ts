// Cálculo de comisiones (docs/plan-comisiones.md §2). Todo en centavos enteros: nada de flotantes con dinero.

export type Share = { beneficiaryUserId: string; kind: 'direct' | 'override'; rate: number };
export type NewInstallment = Share & { part: 'advance' | 'remainder'; amountCents: number; monthsAfterIssue: 0 | 12 };

/**
 * Directa: % del agente sobre el monto. Override (un nivel): el dueño cobra su % menos el del agente, nunca negativo.
 * Cada parte se divide en adelanto (`advanceMonths` de 12, al ISSUE) y resto (a los 12 meses).
 */
export function commissionShares(
  agent: { userId: string; rate: number },
  upline: { userId: string; rate: number } | null,
): Share[] {
  const shares: Share[] = [{ beneficiaryUserId: agent.userId, kind: 'direct', rate: agent.rate }];
  if (upline) shares.push({ beneficiaryUserId: upline.userId, kind: 'override', rate: Math.max(0, round3(upline.rate - agent.rate)) });
  return shares.filter((s) => s.rate > 0);
}

export function installments(amountCents: number, advanceMonths: number, shares: Share[]): NewInstallment[] {
  return shares.flatMap((s) => {
    const total = Math.round((amountCents * s.rate) / 100);
    const advance = Math.round((total * advanceMonths) / 12);
    return [
      { ...s, part: 'advance' as const, amountCents: advance, monthsAfterIssue: 0 as const },
      { ...s, part: 'remainder' as const, amountCents: total - advance, monthsAfterIssue: 12 as const },
    ].filter((i) => i.amountCents > 0);
  });
}

/** Chargeback: `percent` de lo que ya se le pagó a cada beneficiario, como monto negativo */
export function chargebackCents(paidCents: number, percent: number): number {
  return -Math.round((paidCents * percent) / 100);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const toCents = (amount: number | string) => Math.round(Number(amount) * 100);
