// Reglas de §6: ¿a quién le llega push por un mensaje? Función pura para poder probarla sin red.

export type Recipient = {
  userId: string;
  visible: boolean;           // tiene la app abierta y visible en algún dispositivo
  online: boolean;            // tiene la app conectada (aunque no visible)
  muted: boolean;
  level: 'all' | 'mentions' | 'none';   // nivel efectivo del canal (propio o el predeterminado del miembro)
  inDnd: boolean;             // dentro de su horario "no molestar"
  mentioned: boolean;         // @persona
  threadParticipant: boolean; // escribió en el hilo o es autor del mensaje raíz
};

export type MessageFacts = {
  kind: 'public' | 'private' | 'dm' | 'group_dm' | 'announcement';
  isReply: boolean;
  alsoInChannel: boolean;
  channelMention: boolean;    // @canal
  hereMention: boolean;       // @aquí
};

export type Reason = 'dm' | 'mention' | 'announcement' | 'thread' | 'channel_mention' | 'channel';

/** Devuelve el motivo del push, o null si no corresponde. */
export function pushReason(m: MessageFacts, r: Recipient): Reason | null {
  if (r.visible) return null;                                       // ya lo está viendo
  if (m.kind === 'announcement') return 'announcement';             // siempre, ni "no molestar" lo frena
  if (r.inDnd) return null;
  if (m.kind === 'dm' || m.kind === 'group_dm') return 'dm';
  if (r.mentioned) return 'mention';                                // aunque el canal esté silenciado
  if (m.isReply && r.threadParticipant) return 'thread';
  if (m.isReply && !m.alsoInChannel) return null;                   // respuesta de un hilo ajeno
  if (r.muted) return null;
  if (m.channelMention || (m.hereMention && r.online)) return 'channel_mention';
  if (r.level === 'all') return 'channel';
  return null;
}

/** ¿`now` cae dentro de la ventana "no molestar" (horas locales del usuario, puede cruzar medianoche)? */
export function inDnd(dnd: { from: string; to: string; days: number[] } | null, timezone: string, now = new Date()): boolean {
  if (!dnd) return false;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const [from, to] = [toMin(dnd.from), toMin(dnd.to)];
  if (dnd.days.length && !dnd.days.includes(day)) return false;
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** Texto plano para la notificación: menciones con nombre, sin markdown, recortado. */
export function plainText(body: string, names: Map<string, string>, max = 140): string {
  const text = body
    .replace(/<@([0-9a-f-]{36})>/g, (_, id) => `@${names.get(id) ?? 'alguien'}`)
    .replace(/<!channel>/g, '@canal').replace(/<!here>/g, '@aquí')
    .replace(/```[\s\S]*?```/g, '[código]')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
