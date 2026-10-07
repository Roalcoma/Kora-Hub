// Alertas de operación a Telegram (5xx, jobs agotados, webhooks rechazados). Sin TELEGRAM_* no hace nada.
// ponytail: rate-limit en memoria por instancia; basta para el piloto con una sola.

const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 10;
let sent: number[] = [];
const lastByText = new Map<string, number>();

/** Envía `text` sin bloquear ni lanzar: máx. 10 alertas cada 5 min y el mismo texto una vez por ventana. */
export function alert(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const now = Date.now();
  sent = sent.filter((t) => now - t < WINDOW_MS);
  const key = text.slice(0, 200);
  if (sent.length >= MAX_PER_WINDOW || now - (lastByText.get(key) ?? 0) < WINDOW_MS) return;
  sent.push(now);
  lastByText.set(key, now);
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `[Kora] ${text}`.slice(0, 4000), disable_web_page_preview: true }),
  }).catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'alerta Telegram fallida', error: err?.message })));
}
