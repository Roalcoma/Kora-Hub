// Canales, mensajes, hilos, menciones, reacciones, fijados, anuncios y búsqueda (§5.1, §5.2).
import { z } from 'zod';
import { Id, Name, CursorQuery, type IsoDate } from './common.ts';
import type { FileRef } from './files.ts';

// ─── Entidades ───

export type ChannelKind = 'public' | 'private' | 'dm' | 'group_dm' | 'announcement';

export type Channel = {
  id: Id; kind: ChannelKind; name: string | null; topic: string | null; description: string | null;
  departmentId: Id | null; lineId: Id | null; archivedAt: IsoDate | null;
  memberIds?: Id[];               // solo en dm / group_dm
  // Estado del usuario actual
  isMember: boolean; muted: boolean; starred: boolean; notifLevel: 'all' | 'mentions' | 'none' | null;
  unreadCount: number; mentionCount: number; lastReadAt: IsoDate | null; lastMessageAt: IsoDate | null;
};

export type Reaction = { emoji: string; count: number; userIds: Id[] };

export type Mention = { kind: 'user'; userId: Id } | { kind: 'channel' } | { kind: 'here' };

export type Message = {
  id: Id; clientId: string | null; channelId: Id; userId: Id | null; parentId: Id | null;
  // Markdown restringido: **negrita** _cursiva_ ~tachado~ `código` ```bloque``` listas y enlaces.
  // Menciones en el texto: <@userId>, <!channel> (todo el canal), <!here> (conectados).
  body: string;
  mentions: Mention[]; files: FileRef[]; reactions: Reaction[];
  alsoInChannel: boolean; replyCount: number; lastReplyAt: IsoDate | null; replyUserIds: Id[];
  ackRequired: boolean; ackCount?: number; ackedByMe?: boolean;
  pinned: boolean;
  meta: {
    linkPreviews?: { url: string; title: string | null; description: string | null; imageUrl: string | null }[];
    documentCard?: { documentId: Id; title: string; excerpt: string };
  };
  editedAt: IsoDate | null; deletedAt: IsoDate | null; createdAt: IsoDate;
};

export type AckStatus = { acked: { userId: Id; ackedAt: IsoDate }[]; pending: Id[] };

export type SearchResult =
  | { type: 'message'; message: Message; channelName: string | null; highlight: string }
  | { type: 'file'; file: FileRef; messageId: Id; channelId: Id };

// ─── Entradas ───

export const CreateChannelBody = z.object({
  kind: z.enum(['public', 'private']),
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9áéíóúñü][a-z0-9áéíóúñü_-]{0,79}$/),
  topic: z.string().max(250).optional(), description: z.string().max(1000).optional(),
  departmentId: Id.optional(), lineId: Id.optional(),
  memberIds: z.array(Id).max(500).default([]),
});
export const UpdateChannelBody = z.object({
  name: Name, topic: z.string().max(250).nullable(), description: z.string().max(1000).nullable(),
  departmentId: Id.nullable(), lineId: Id.nullable(), archived: z.boolean(),
}).partial();

/** Abre (o reutiliza) un DM 1:1 o grupal; el usuario actual se incluye solo */
export const OpenDmBody = z.object({ userIds: z.array(Id).min(1).max(7) });

export const ChannelMembersBody = z.object({ userIds: z.array(Id).min(1).max(500) });
export const MyChannelPrefsBody = z.object({
  muted: z.boolean(), starred: z.boolean(), notifLevel: z.enum(['all', 'mentions', 'none']).nullable(),
}).partial();
export const MarkReadBody = z.object({ lastReadAt: z.iso.datetime() });

export const ListMessagesQuery = CursorQuery.extend({ around: Id.optional() });  // around = saltar a un mensaje

export const PostMessageBody = z.object({
  clientId: z.uuid(),                     // id generado en el cliente para UI optimista e idempotencia
  body: z.string().max(40_000),
  parentId: Id.optional(),
  alsoInChannel: z.boolean().default(false),
  fileIds: z.array(Id).max(10).default([]),
  ackRequired: z.boolean().default(false),       // solo en #anuncios
  pinUntil: z.iso.datetime().optional(),         // solo en #anuncios
}).refine((m) => m.body.trim() !== '' || m.fileIds.length > 0, { message: 'Mensaje vacío' });
export const EditMessageBody = z.object({ body: z.string().min(1).max(40_000) });
export const ReactionBody = z.object({ emoji: z.string().min(1).max(64) });
export const PinBody = z.object({ expiresAt: z.iso.datetime().nullable().default(null) });

export const SearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  channelId: Id.optional(), userId: Id.optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  hasFiles: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
