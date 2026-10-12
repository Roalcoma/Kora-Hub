// Configuración pública (GET /config, sin sesión): registro abierto o cerrado y ventana diaria del respaldo.
import type { PublicConfig, MaintenanceWindow } from '@agencia-hub/contracts';

/** Registro público de agencias. Abierto por defecto (dev, pruebas, demo); en producción se cierra con `false`. */
export const registrationOpen = () => process.env.REGISTRATION_OPEN?.trim().toLowerCase() !== 'false';

const DAY = 86400_000;

/**
 * Ventana del respaldo diario que empieza a `dailyUtc` ("HH:MM", hora UTC) y dura `minutes`: la que está en curso
 * o, si no hay, la próxima. Mira también la de ayer por si la ventana cruza la medianoche UTC.
 * `dailyUtc` vacío o mal formado, o `minutes` <= 0 → null (sin aviso).
 */
export function maintenanceWindow(now: Date, dailyUtc: string | undefined, minutes: number): { startsAt: Date; endsAt: Date } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(dailyUtc?.trim() ?? '');
  if (!m || !(minutes > 0)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[1]), Number(m[2]));
  for (const start of [today - DAY, today, today + DAY]) {
    const end = start + minutes * 60_000;
    if (end > now.getTime()) return { startsAt: new Date(start), endsAt: new Date(end) };
  }
  return null; // inalcanzable: la de mañana siempre termina después de ahora
}

const num = (v: string | undefined, fallback: number) => (v?.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback);

export function publicConfig(now = new Date()): PublicConfig {
  const w = maintenanceWindow(now, process.env.MAINTENANCE_DAILY_UTC, num(process.env.MAINTENANCE_MINUTES, 15));
  const maintenance: MaintenanceWindow | null = w && {
    startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString(),
    noticeMinutes: Math.max(0, num(process.env.MAINTENANCE_NOTICE_MINUTES, 30)),
  };
  return { registrationOpen: registrationOpen(), maintenance };
}
