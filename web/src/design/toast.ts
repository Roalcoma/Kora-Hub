import { reactive } from 'vue';

export type Toast = { id: number; text: string; tone: 'info' | 'success' | 'error' };
export const toasts = reactive<Toast[]>([]);
let seq = 0;

/** Muestra un aviso breve; los errores duran más para que se alcancen a leer. */
export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = ++seq;
  toasts.push({ id, text, tone });
  setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 3500);
}
export function dismiss(id: number) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}
