import { i18n } from '@/i18n/index.ts';
import { RequestError } from '@/api.ts';

/** Mensaje para el usuario: traducción del código si existe, si no el texto del servidor. */
export function errorText(e: unknown): string {
  const t = i18n.global.t;
  if (e instanceof RequestError) {
    const key = `auth.errors.${e.code}`;
    return i18n.global.te(key) ? t(key) : e.message;
  }
  return t('common.error');
}
