// Versión nueva publicada: la app abierta (sobre todo instalada en el teléfono) sigue con el JS viejo hasta recargar.
// Se compara el script de entrada del index.html publicado con el que está corriendo: al volver a la app se recarga sola
// (los borradores del compositor están en localStorage); si se está usando, la franja UpdateBand ofrece actualizar.
import { ref } from 'vue';

export const updateReady = ref(false);
const ENTRY = /\/assets\/index-[\w-]+\.js/;
const running = () => document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src.match(ENTRY)?.[0];

async function check(): Promise<boolean> {
  const mine = running();
  if (!mine || updateReady.value) return updateReady.value;   // en desarrollo (Vite) no hay entrada con hash
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const live = html.match(ENTRY)?.[0];
    if (live && live !== mine) updateReady.value = true;
  } catch { /* sin red: se reintenta en el próximo chequeo */ }
  return updateReady.value;
}

export function watchForUpdates() {
  setInterval(check, 5 * 60_000);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && (await check())) location.reload();
  });
}
