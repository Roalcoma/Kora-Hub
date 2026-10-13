import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.ts';
import { i18n } from './i18n/index.ts';
import { registerSW, clearBadge } from './chat/push.ts';
import { pollConfig } from './platform/config.ts';
import { watchForUpdates } from './platform/update.ts';
import { setNavigating } from './design/progress.ts';
import { installPress } from './design/press.ts';
import './main.css';

// iOS con la app instalada y la barra de estado translúcida a veces informa un alto menor que la pantalla (al abrir, al
// volver de segundo plano, con una llamada en curso) y deja una franja abajo. Instalada en iPhone la app ocupa toda la
// pantalla: se usa el mayor entre el alto de la ventana y el de la pantalla, y se vuelve a medir en cada cambio.
// Lo que igual quede debajo tiene el color de la barra inferior (main.css), nunca blanco.
// iPhone/iPad: además del tamaño de letra (main.css), maximum-scale=1 evita que Safari acerque la pantalla al enfocar un
// campo. En iOS pellizcar para acercar sigue funcionando (Safari ignora el límite para el gesto del usuario).
if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
}
const iosApp = /iPhone|iPod/.test(navigator.userAgent) && (navigator as { standalone?: boolean }).standalone === true;
const setAppHeight = () => {
  const portrait = window.innerHeight >= window.innerWidth;
  // Con el teclado abierto (un campo con foco) manda el alto de la ventana: si no, el compositor quedaría bajo el teclado
  const typing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
  const full = iosApp && !typing ? (portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width)) : 0;
  document.documentElement.style.setProperty('--app-h', `${Math.max(window.innerHeight, full)}px`);
};
setAppHeight();
document.addEventListener('focusout', () => setTimeout(setAppHeight, 300));
for (const ev of ['resize', 'orientationchange', 'pageshow', 'focus']) window.addEventListener(ev, () => { setAppHeight(); setTimeout(setAppHeight, 300); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(setAppHeight, 100); });

// Barra de progreso mientras se resuelve una pantalla (guardas + carga del código de la ruta)
router.beforeEach(() => { setNavigating(true); });
router.afterEach(() => setNavigating(false));
router.onError(() => setNavigating(false));

// El splash de index.html queda hasta que la primera pantalla está lista (sesión cargada y ruta resuelta)
const app = createApp(App).use(createPinia()).use(router).use(i18n);
router.isReady().catch(() => {}).finally(() => app.mount('#app'));
installPress();
registerSW();
pollConfig();   // configuración pública: registro abierto y aviso del respaldo (cada 5 min)
clearBadge();
watchForUpdates();   // versión nueva publicada: recarga al volver a la app o franja para actualizar
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') clearBadge(); });
