import { createI18n } from 'vue-i18n';
import es from './es.ts';
import en from './en.ts';

const saved = (() => { try { return localStorage.getItem('locale'); } catch { return null; } })();
const initial = saved ?? (navigator.language.startsWith('en') ? 'en' : 'es');

export const i18n = createI18n({ legacy: false, locale: initial, fallbackLocale: 'es', messages: { es, en } });

export function setLocale(locale: 'es' | 'en') {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  try { localStorage.setItem('locale', locale); } catch { /* modo privado */ }
}
