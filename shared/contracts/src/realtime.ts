// WebSocket /ws (§10). Autenticación: POST /api/v1/w/:slug/ws-ticket → { ticket } → abrir `/ws?ticket=...`.
// El ticket es de un solo uso y vive 30 s; el JWT nunca va en la URL.
import type { Id, IsoDate } from './common.ts';
import type { Channel, Message, Reaction } from './chat.ts';
import type { Task } from './modules.ts';

/** Eventos servidor → cliente. Solo llegan los del workspace del ticket y de canales donde el usuario es miembro. */
export type ServerEvent =
  | { type: 'message.created'; message: Message; clientId?: string }
  | { type: 'message.updated'; message: Message }
  | { type: 'message.deleted'; channelId: Id; messageId: Id; parentId: Id | null }
  | { type: 'reaction.changed'; channelId: Id; messageId: Id; reactions: Reaction[] }
  | { type: 'typing'; channelId: Id; parentId: Id | null; userId: Id }
  | { type: 'presence'; userId: Id; presence: 'active' | 'away' }
  | { type: 'channel.updated'; channel: Channel }
  | { type: 'channel.removed'; channelId: Id }          // me sacaron o se archivó un privado
  | { type: 'read.updated'; channelId: Id; lastReadAt: IsoDate }   // sincroniza no leídos entre mis dispositivos
  | { type: 'pin.changed'; channelId: Id; messageId: Id; pinned: boolean }
  | { type: 'announcement.acked'; messageId: Id; userId: Id; ackCount: number }
  | { type: 'task.created' | 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: Id }
  | { type: 'notification'; title: string; body: string; url: string }
  | { type: 'pong' };

/** Mensajes cliente → servidor */
export type ClientEvent =
  | { type: 'typing'; channelId: Id; parentId?: Id }
  | { type: 'visibility'; visible: boolean }   // la app está visible en este dispositivo (decide si se envía push)
  | { type: 'ping' };

export type WsTicketResponse = { ticket: string; expiresAt: IsoDate };
