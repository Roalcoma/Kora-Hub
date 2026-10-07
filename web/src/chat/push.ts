// Suscripción a Web Push en este dispositivo (§6). En iPhone solo funciona con la app instalada (iOS 16.4+).
import { api } from '@/api.ts';

export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export type PushState = 'insecure' | 'unsupported' | 'install-first' | 'denied' | 'off' | 'on';

export async function registerSW() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch { /* sin SW: la app sigue funcionando */ }
  }
}

export async function pushState(): Promise<PushState> {
  if (!window.isSecureContext) return 'insecure';
  if (isIos() && !isStandalone()) return 'install-first';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

const b64ToBytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** Pide permiso (debe llamarse desde un toque del usuario) y registra la suscripción en el servidor. */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET /push/vapid-key');
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api('POST /me/push-subscriptions', { body: { endpoint: json.endpoint, keys: json.keys } });
  return 'on';
}

export const sendTestPush = () => api('POST /me/push-test');

/** Limpia el contador del ícono al abrir la app */
export const clearBadge = () => (navigator as { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {});
