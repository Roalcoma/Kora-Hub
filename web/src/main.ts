import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.ts';
import { i18n } from './i18n/index.ts';
import { registerSW, clearBadge } from './chat/push.ts';
import { pollConfig } from './platform/config.ts';
import { watchForUpdates } from './platform/update.ts';
import './main.css';

// iOS con la app instalada y la barra de estado translúcida calcula el 100 % sin la barra de estado y deja una franja
// vacía abajo; la altura real de la ventana sí es correcta
const setAppHeight = () => document.documentElement.style.setProperty('--app-h', `${window.innerHeight}px`);
setAppHeight();
window.addEventListener('resize', setAppHeight);

createApp(App).use(createPinia()).use(router).use(i18n).mount('#app');
registerSW();
pollConfig();   // configuración pública: registro abierto y aviso del respaldo (cada 5 min)
clearBadge();
watchForUpdates();   // versión nueva publicada: recarga al volver a la app o franja para actualizar
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') clearBadge(); });
