// Configuración pública del servidor (GET /config, sin sesión): registro abierto y ventana del respaldo diario.
// Se pide una vez al cargar y luego cada 5 minutos; el reloj del aviso lo lleva el cliente.
import { ref } from 'vue';
import type { PublicConfig } from '@agencia-hub/contracts';
import { api } from '@/api.ts';

export const publicConfig = ref<PublicConfig | null>(null);

let pending: Promise<PublicConfig | null> | null = null;
/** Carga (o recarga) la configuración. Si falla, se deja la anterior y el registro se asume abierto. */
export function loadConfig(): Promise<PublicConfig | null> {
  pending ??= api('GET /config')
    .then((c) => (publicConfig.value = c))
    .catch(() => publicConfig.value)
    .finally(() => { pending = null; });
  return pending;
}

let timer: ReturnType<typeof setInterval> | undefined;
/** Arranca el sondeo cada 5 minutos (idempotente). */
export function pollConfig() {
  if (timer) return;
  loadConfig();
  timer = setInterval(loadConfig, 5 * 60_000);
}
