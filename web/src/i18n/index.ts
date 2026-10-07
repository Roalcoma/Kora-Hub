import { createI18n } from 'vue-i18n';
import es from './es.ts';
import en from './en.ts';

const saved = (() => { try { return localStorage.getItem('locale'); } catch { return null; } })();
const initial = saved ?? (navigator.language.startsWith('en') ? 'en' : 'es');

const datetime = {
  short: { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
  long: { dateStyle: 'full', timeStyle: 'short' },
} as const;

export const i18n = createI18n({
  legacy: false, locale: initial, fallbackLocale: 'es', messages: { es, en },
  datetimeFormats: { es: datetime, en: datetime },
});

export function setLocale(locale: 'es' | 'en') {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  try { localStorage.setItem('locale', locale); } catch { /* modo privado */ }
}
