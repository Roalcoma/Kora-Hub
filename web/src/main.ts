import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.ts';
import { i18n } from './i18n/index.ts';
import { registerSW, clearBadge } from './chat/push.ts';
import './main.css';

createApp(App).use(createPinia()).use(router).use(i18n).mount('#app');
registerSW();
clearBadge();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') clearBadge(); });
