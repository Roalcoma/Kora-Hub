<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { SmilePlus, MessageSquareText, SquareCheck, Pin, PinOff, EllipsisVertical, Pencil, Trash2, Link2, Copy, FileText, Download, Check, CheckCheck, RotateCw, X } from 'lucide-vue-next';
import type { Channel } from '@agencia-hub/contracts';
import { useSession } from '@/stores/session.ts';
import Avatar from '@/design/Avatar.vue';
import Popover from '@/design/Popover.vue';
import ContextMenu from '@/design/ContextMenu.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { useChat, type UiMessage } from './store.ts';
import { renderBody, plainBody } from './format.ts';
import { useTasks } from '@/tasks/store.ts';
import DocCard from '@/docs/DocCard.vue';
import EmojiPicker from './EmojiPicker.vue';

const props = defineProps<{ m: UiMessage; compact?: boolean; inThread?: boolean; channel: Channel; canWrite: boolean }>();
const emit = defineEmits<{ thread: [id: string]; acks: [id: string]; image: [url: string, name: string] }>();
const { t, locale } = useI18n();
const s = useSession();
const chat = useChat();

const me = computed(() => s.user!.id);
const mine = computed(() => props.m.userId === me.value);
const author = computed(() => chat.memberById.get(props.m.userId ?? ''));
const isAdmin = computed(() => ['owner', 'admin'].includes(s.workspace!.me.role));
const live = computed(() => !props.m.status && !props.m.deletedAt);
const mentionsMe = computed(() => props.m.mentions.some((x) => (x.kind === 'user' && x.userId === me.value) || x.kind !== 'user') && !mine.value);
const html = computed(() => renderBody(props.m.body, (id) => chat.memberById.get(id)?.name, me.value));
const time = (iso: string) => new Intl.DateTimeFormat(locale.value, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const fullDate = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(props.m.createdAt)));
const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const totalMembers = computed(() => chat.channels.length && props.channel.kind === 'announcement' ? chat.members.filter((x) => x.isActive).length - 1 : 0);

// ─── Acciones ───
const emojiOpen = ref(false);
const menu = ref(false);
const menuPos = ref({ x: 0, y: 0 });
const editing = ref(false);
const draft = ref('');
const editor = ref<HTMLTextAreaElement>();
const confirmDelete = ref(false);

const run = (p: Promise<unknown>) => p.catch((e) => toast(e.message ?? t('common.error'), 'error'));
const react = (e: string) => { emojiOpen.value = false; run(chat.react(props.m.id, e)); };

function openMenu(x: number, y: number) {
  menuPos.value = { x, y };
  menu.value = true;
}
// Enlaces a manuales de este workspace se muestran como tarjeta
const docIds = computed(() => [...new Set([...props.m.body.matchAll(new RegExp(`/w/${s.workspace!.slug}/manuals/([0-9a-f-]{36})`, 'g'))].map((x) => x[1]!))].slice(0, 3));

// "Crear tarea": el texto del mensaje propone el título y queda enlazado al mensaje
const tasks = useTasks();
const canTask = computed(() => s.workspace!.me.role !== 'guest');
function createTask() {
  const text = plainBody(props.m.body, (id) => chat.memberById.get(id)?.name);
  // Título: primera línea sin enlaces (la descripción conserva el texto completo)
  const title = text.split('\n')[0]!.replace(/https?:\/\/\S+/g, '').replace(/[\s:]+$/, '').trim();
  tasks.compose({ title: (title || text).slice(0, 200), description: text, sourceMessageId: props.m.id, sourcePreview: `${chat.nameOf(props.m.userId)}: ${text}` });
}

const menuItems = computed(() => [
  ...(!props.inThread && !props.m.parentId ? [{ label: t('chat.replyInThread'), icon: MessageSquareText, action: () => emit('thread', props.m.id) }] : []),
  ...(canTask.value ? [{ label: t('chat.createTask'), icon: SquareCheck, action: createTask }] : []),
  ...(mine.value ? [{ label: t('chat.edit'), icon: Pencil, action: startEdit }] : []),
  ...(props.canWrite ? [{ label: props.m.pinned ? t('chat.unpin') : t('chat.pin'), icon: props.m.pinned ? PinOff : Pin, action: () => run(chat.pin(props.m.id, !props.m.pinned)) }] : []),
  { label: t('chat.copyText'), icon: Copy, action: () => copy(props.m.body.replace(/<@([0-9a-f-]{36})>/g, (_, id) => `@${chat.nameOf(id)}`)) },
  { label: t('chat.copyLink'), icon: Link2, action: () => copy(`${location.origin}/w/${s.workspace!.slug}/c/${props.m.channelId}?m=${props.m.id}`, t('chat.linkCopied')) },
  ...(mine.value || isAdmin.value ? [{ label: t('chat.delete'), icon: Trash2, danger: true, action: () => { confirmDelete.value = true; } }] : []),
]);
async function copy(text: string, ok = t('common.copied')) {
  try { await navigator.clipboard.writeText(text); toast(ok, 'success'); } catch { /* sin portapapeles */ }
}

async function startEdit() {
  // En el editor las menciones se muestran como @Nombre y se convierten de vuelta al guardar
  draft.value = props.m.body.replace(/<@([0-9a-f-]{36})>/g, (_, id) => `@${chat.nameOf(id)}`).replace(/<!channel>/g, '@canal').replace(/<!here>/g, '@aquí');
  editing.value = true;
  await nextTick();
  editor.value?.focus();
}
async function saveEdit() {
  let body = draft.value.trim();
  if (!body) return;
  for (const id of props.m.mentions.flatMap((x) => (x.kind === 'user' ? [x.userId] : []))) body = body.split(`@${chat.nameOf(id)}`).join(`<@${id}>`);
  body = body.replace(/@canal\b/g, '<!channel>').replace(/@aquí/g, '<!here>');
  await run(chat.edit(props.m.id, body));
  editing.value = false;
}

// Mantener presionado en el iPhone abre el menú (Safari no dispara contextmenu)
let press: ReturnType<typeof setTimeout> | undefined;
function onPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'touch' || !live.value) return;
  press = setTimeout(() => openMenu(e.clientX, e.clientY), 450);
}
const cancelPress = () => clearTimeout(press);
</script>

<template>
  <div class="msg" :class="{ compact, mention: mentionsMe, pending: m.status === 'sending', failed: m.status === 'failed', editing }"
    :data-id="m.id" @contextmenu.prevent="live && openMenu($event.clientX, $event.clientY)"
    @pointerdown="onPointerDown" @pointerup="cancelPress" @pointermove="cancelPress" @pointercancel="cancelPress">
    <div class="gutter">
      <Avatar v-if="!compact" :name="author?.name ?? '?'" :size="38" />
      <time v-else class="hover-time" :datetime="m.createdAt" :title="fullDate">{{ time(m.createdAt) }}</time>
    </div>
    <div class="content">
      <div v-if="!compact" class="head">
        <b>{{ author?.name ?? t('common.error') }}</b>
        <span v-if="author?.title" class="role">{{ author.title }}</span>
        <time :datetime="m.createdAt" :title="fullDate">{{ time(m.createdAt) }}</time>
        <span v-if="m.pinned" class="pin-tag"><Pin :size="12" />{{ t('chat.pinned') }}</span>
      </div>

      <p v-if="m.deletedAt" class="deleted">{{ t('chat.deletedMessage') }}</p>
      <div v-else-if="editing" class="edit">
        <textarea ref="editor" v-model="draft" rows="3" @keydown.enter.exact.prevent="saveEdit" @keydown.esc="editing = false" />
        <div class="edit-actions"><Button size="sm" @click="editing = false">{{ t('chat.cancel') }}</Button><Button size="sm" variant="primary" @click="saveEdit">{{ t('chat.save') }}</Button></div>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- renderBody escapa todo antes de agregar etiquetas conocidas -->
      <div v-else-if="m.body" class="body" v-html="html" />
      <DocCard v-for="id in docIds" :key="id" :id="id" />
      <span v-if="m.editedAt && !m.deletedAt && !editing" class="edited">{{ t('chat.edited') }}</span>

      <div v-if="m.files.length" class="files">
        <template v-for="f in m.files" :key="f.id">
          <button v-if="f.mime.startsWith('image/') && f.mime !== 'image/heic'" type="button" class="img"
            :style="{ aspectRatio: f.width && f.height ? `${f.width} / ${f.height}` : '4 / 3' }" @click="emit('image', f.url, f.name)">
            <img :src="f.url" :alt="f.name" loading="lazy">
          </button>
          <a v-else class="file" :href="`${f.url}?download`" :download="f.name">
            <span class="ico" :class="{ pdf: f.mime === 'application/pdf' }"><FileText :size="18" /></span>
            <span class="meta"><b>{{ f.name }}</b><small>{{ size(f.size) }}</small></span>
            <Download :size="16" class="dl" />
          </a>
        </template>
      </div>

      <div v-if="m.reactions.length" class="reactions">
        <button v-for="r in m.reactions" :key="r.emoji" type="button" class="react" :class="{ mine: r.userIds.includes(me) }"
          :title="r.userIds.map(chat.nameOf).join(', ')" @click="react(r.emoji)">{{ r.emoji }} <span>{{ r.count }}</span></button>
        <Popover v-model="emojiOpen" placement="top-start">
          <template #trigger><button type="button" class="react add" :aria-label="t('chat.react')" @click="emojiOpen = !emojiOpen"><SmilePlus :size="15" /></button></template>
          <EmojiPicker @pick="react" />
        </Popover>
      </div>

      <button v-if="m.replyCount && !inThread" type="button" class="replies" @click="emit('thread', m.id)">
        <span class="stack"><Avatar v-for="u in m.replyUserIds" :key="u" :name="chat.nameOf(u)" :size="22" /></span>
        <b>{{ t('chat.replies', { n: m.replyCount }, m.replyCount) }}</b>
        <small v-if="m.lastReplyAt">{{ t('chat.lastReply', { time: time(m.lastReplyAt) }) }}</small>
      </button>

      <div v-if="m.ackRequired && !m.deletedAt" class="ack">
        <Button v-if="!mine && !m.ackedByMe" variant="primary" size="sm" @click="run(chat.ack(m.id))"><Check :size="15" />{{ t('chat.understood') }}</Button>
        <span v-else-if="m.ackedByMe" class="acked"><CheckCheck :size="15" />{{ t('chat.youConfirmed') }}</span>
        <span v-if="m.ackCount !== undefined" class="ack-count">
          <span class="bar"><i :style="{ width: `${totalMembers ? Math.min(100, (m.ackCount / totalMembers) * 100) : 0}%` }" /></span>
          {{ t('chat.confirmed', { n: m.ackCount, total: totalMembers }) }}
        </span>
        <Button v-if="mine || ['owner', 'admin', 'lead'].includes(s.workspace!.me.role)" size="sm" variant="ghost" @click="emit('acks', m.id)">{{ t('chat.seeWho') }}</Button>
      </div>

      <p v-if="m.status === 'sending'" class="status">{{ t('chat.sending') }}</p>
      <p v-else-if="m.status === 'failed'" class="status err">
        {{ t('chat.failed') }}
        <button type="button" @click="chat.deliver(m)"><RotateCw :size="13" />{{ t('chat.retry') }}</button>
        <button type="button" @click="chat.discard(m)"><X :size="13" />{{ t('chat.discard') }}</button>
      </p>
    </div>

    <div v-if="live && !editing" class="toolbar" :class="{ open: emojiOpen && !m.reactions.length }">
      <Popover v-if="!m.reactions.length" v-model="emojiOpen" placement="bottom-end">
        <template #trigger><button type="button" :aria-label="t('chat.react')" :title="t('chat.react')" @click="emojiOpen = !emojiOpen"><SmilePlus :size="17" /></button></template>
        <EmojiPicker @pick="react" />
      </Popover>
      <button v-else type="button" :aria-label="t('chat.react')" :title="t('chat.react')" @click="react('👍')">👍</button>
      <button v-if="!inThread && !m.parentId" type="button" :aria-label="t('chat.replyInThread')" :title="t('chat.replyInThread')" @click="emit('thread', m.id)"><MessageSquareText :size="17" /></button>
      <button v-if="canTask" type="button" :aria-label="t('chat.createTask')" :title="t('chat.createTask')" @click="createTask"><SquareCheck :size="17" /></button>
      <button v-if="canWrite" type="button" :aria-label="m.pinned ? t('chat.unpin') : t('chat.pin')" :title="m.pinned ? t('chat.unpin') : t('chat.pin')" @click="run(chat.pin(m.id, !m.pinned))">
        <PinOff v-if="m.pinned" :size="17" /><Pin v-else :size="17" />
      </button>
      <button type="button" :aria-label="t('chat.more')" :title="t('chat.more')" @click="openMenu($event.clientX, $event.clientY)"><EllipsisVertical :size="17" /></button>
    </div>

    <ContextMenu v-model="menu" :items="menuItems" :x="menuPos.x" :y="menuPos.y" />
    <div v-if="confirmDelete" class="confirm" role="alertdialog">
      <span>{{ t('chat.deleteConfirm') }}</span>
      <Button size="sm" @click="confirmDelete = false">{{ t('chat.cancel') }}</Button>
      <Button size="sm" variant="danger" @click="run(chat.remove(m.id)); confirmDelete = false">{{ t('chat.delete') }}</Button>
    </div>
  </div>
</template>

<style scoped>
.msg { position: relative; display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 0 10px; padding: 7px 24px 7px 18px; transition: background var(--duration), box-shadow var(--duration); }
/* El mensaje activo se pone por encima de sus vecinos para que su barra y sus menús no queden tapados */
.msg:hover, .msg:focus-within { z-index: 3; }
.msg.compact { padding-top: 2px; padding-bottom: 2px; }
/* Profundidad: el mensaje bajo el cursor se separa del lienzo */
.msg:hover { background: var(--color-surface); box-shadow: var(--shadow-sm), inset 3px 0 0 var(--color-line-strong); }
.msg.mention { background: var(--color-primary-light); box-shadow: inset 3px 0 0 var(--color-primary); }
.msg.mention:hover { box-shadow: var(--shadow-sm), inset 3px 0 0 var(--color-primary); }
.msg.pending { opacity: .62; }
.msg.failed { background: var(--color-danger-light); box-shadow: inset 3px 0 0 var(--color-danger); }
.gutter { display: flex; justify-content: flex-end; padding-top: 2px; }
.hover-time { visibility: hidden; font-size: 11px; color: var(--color-muted); padding-top: 3px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.msg:hover .hover-time { visibility: visible; }
.head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
.head b { font-weight: 700; }
.role { font-size: 11px; padding: 0 6px; color: var(--color-muted); background: var(--color-canvas); border: 1px solid var(--color-line); }
.head time { font-size: 12px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
.pin-tag { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; font-weight: 700; color: #8A4B00; }
.body { line-height: 1.5; overflow-wrap: anywhere; }
.body :deep(code) { font: 13px ui-monospace, 'Cascadia Mono', Consolas, monospace; padding: 1px 4px; background: var(--color-canvas-deep); color: #8A2A1B; }
.body :deep(pre) { margin: 6px 0; padding: 10px 12px; background: var(--color-ink); color: #E8EEF6; overflow-x: auto; box-shadow: var(--shadow-sm); }
.body :deep(pre code) { background: none; color: inherit; padding: 0; }
.body :deep(ul) { margin: 4px 0; padding-left: 22px; }
.body :deep(a) { color: var(--color-leaf); text-underline-offset: 2px; }
.body :deep(.mention) { padding: 0 3px; font-weight: 500; color: #8A4B00; background: var(--color-primary-light); }
.body :deep(.mention.me), .body :deep(.mention.all) { background: var(--color-primary); color: var(--color-ink); }
.body :deep(mark) { background: var(--color-primary-light); color: inherit; box-shadow: inset 0 -2px 0 var(--color-primary); }
.edited { font-size: 12px; color: var(--color-muted); }
.deleted { margin: 0; font-style: italic; color: var(--color-muted); }

.files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.img { display: block; width: min(340px, 100%); max-height: 260px; padding: 0; border: 1px solid var(--color-line); background: var(--color-canvas); cursor: zoom-in; overflow: hidden; box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration); }
.img:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.file { display: flex; align-items: center; gap: 10px; min-width: 240px; max-width: 360px; padding: 8px 12px 8px 8px; color: inherit; text-decoration: none; background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); transition: box-shadow var(--duration), transform var(--duration); }
.file:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
.file .ico { width: 36px; height: 42px; display: grid; place-items: center; background: var(--color-leaf); color: #fff; flex: none; }
.file .ico.pdf { background: var(--color-danger); }
.file .meta { display: grid; min-width: 0; }
.file b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file small { color: var(--color-muted); font-size: 12px; }
.file .dl { margin-left: auto; color: var(--color-muted); }

.reactions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.react { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 8px; font: inherit; font-size: 13px; background: var(--color-surface); border: 1px solid var(--color-line); cursor: pointer; box-shadow: var(--shadow-sm); transition: border-color var(--duration), transform var(--duration); }
.react:hover { border-color: var(--color-ink); transform: translateY(-1px); }
.react span { font-size: 12px; font-variant-numeric: tabular-nums; }
.react.mine { border-color: var(--color-leaf); background: #EAF1F8; color: var(--color-leaf); font-weight: 700; }
.react.add { color: var(--color-muted); }

.replies { display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; padding: 3px 10px 3px 3px; font: inherit; font-size: 13px; color: inherit; background: none; border: 1px solid transparent; cursor: pointer; transition: background var(--duration), border-color var(--duration), box-shadow var(--duration); }
.replies:hover { background: var(--color-surface); border-color: var(--color-line); box-shadow: var(--shadow-sm); }
.replies b { color: var(--color-leaf); }
.replies small { color: var(--color-muted); }
.stack { display: flex; }
.stack > * + * { margin-left: -5px; box-shadow: 0 0 0 2px var(--color-canvas); }

.ack { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 10px; padding: 10px 12px; background: var(--color-canvas); border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.acked { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--color-success-light); color: var(--color-success); font-weight: 700; font-size: 13px; }
.ack-count { display: grid; gap: 4px; min-width: 140px; font-size: 12px; color: var(--color-muted); }
.bar { height: 5px; background: var(--color-line); }
.bar i { display: block; height: 100%; background: var(--color-ink); }

.status { margin: 4px 0 0; font-size: 12px; color: var(--color-muted); display: flex; gap: 10px; align-items: center; }
.status.err { color: var(--color-danger); font-weight: 500; }
.status button { display: inline-flex; align-items: center; gap: 4px; font: inherit; color: var(--color-leaf); background: none; border: 0; cursor: pointer; text-decoration: underline; }

.edit { display: grid; gap: 6px; margin-top: 4px; }
.edit textarea { font: inherit; padding: 8px 10px; border: 1px solid var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .25), var(--shadow-md); resize: vertical; outline: none; }
.edit-actions { display: flex; gap: 6px; justify-content: flex-end; }

/* Barra de acciones: flota sobre el mensaje con su propia sombra */
.toolbar { position: absolute; z-index: 4; top: -18px; right: 24px; display: none; background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-md); }
.msg:hover .toolbar, .toolbar:focus-within, .toolbar.open { display: flex; }
.toolbar button { width: 34px; height: 32px; display: grid; place-items: center; font-size: 16px; color: var(--color-ink); background: none; border: 0; cursor: pointer; }
.toolbar button:hover { background: var(--color-canvas); }
.confirm { grid-column: 2; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; padding: 10px 12px; background: var(--color-danger-light); box-shadow: var(--shadow-md); font-size: 14px; }
.confirm span { flex: 1; min-width: 180px; }

@media (hover: none) { .toolbar { display: none !important; } .msg:hover { background: transparent; box-shadow: none; } }
@media (max-width: 767px) { .msg { grid-template-columns: 38px minmax(0, 1fr); padding: 6px 14px 6px 10px; } .role { display: none; } }
</style>
