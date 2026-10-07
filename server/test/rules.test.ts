// Reglas de push de §6 (función pura).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushReason, inDnd, plainText, type Recipient, type MessageFacts } from '../src/notifications/rules.ts';

const r = (o: Partial<Recipient> = {}): Recipient => ({
  userId: 'u', visible: false, online: false, muted: false, level: 'mentions', inDnd: false, mentioned: false, threadParticipant: false, ...o,
});
const m = (o: Partial<MessageFacts> = {}): MessageFacts => ({
  kind: 'public', isReply: false, alsoInChannel: false, channelMention: false, hereMention: false, ...o,
});

test('tabla de §6', () => {
  assert.equal(pushReason(m({ kind: 'dm' }), r()), 'dm');
  assert.equal(pushReason(m(), r({ mentioned: true, muted: true })), 'mention');
  assert.equal(pushReason(m({ kind: 'announcement' }), r({ muted: true, inDnd: true })), 'announcement');
  assert.equal(pushReason(m({ channelMention: true }), r()), 'channel_mention');
  assert.equal(pushReason(m({ channelMention: true }), r({ muted: true })), null);
  assert.equal(pushReason(m({ hereMention: true }), r({ online: false })), null);
  assert.equal(pushReason(m({ hereMention: true }), r({ online: true })), 'channel_mention');
  assert.equal(pushReason(m(), r()), null);                         // por defecto: solo menciones
  assert.equal(pushReason(m(), r({ level: 'all' })), 'channel');
  assert.equal(pushReason(m({ isReply: true }), r({ threadParticipant: true, muted: true })), 'thread');
  assert.equal(pushReason(m({ isReply: true }), r({ level: 'all' })), null);
});

test('nunca push si la app está visible; "no molestar" frena todo menos anuncios', () => {
  assert.equal(pushReason(m({ kind: 'dm' }), r({ visible: true })), null);
  assert.equal(pushReason(m({ kind: 'announcement' }), r({ visible: true })), null);
  assert.equal(pushReason(m({ kind: 'dm' }), r({ inDnd: true })), null);
});

test('horario no molestar con cruce de medianoche y zona horaria', () => {
  const dnd = { from: '22:00', to: '07:00', days: [] };
  // 2026-10-07 03:30 UTC = 23:30 del día 6 en Nueva York (UTC-4)
  assert.equal(inDnd(dnd, 'America/New_York', new Date('2026-10-07T03:30:00Z')), true);
  assert.equal(inDnd(dnd, 'America/New_York', new Date('2026-10-07T16:00:00Z')), false);
  assert.equal(inDnd(null, 'America/New_York'), false);
});

test('texto de la notificación', () => {
  const names = new Map([['11111111-1111-1111-1111-111111111111', 'Ana']]);
  assert.equal(plainText('Hola <@11111111-1111-1111-1111-111111111111> **urgente** <!here>', names), 'Hola @Ana urgente @aquí');
  assert.equal(plainText('x'.repeat(200), names, 10), `${'x'.repeat(9)}…`);
});
