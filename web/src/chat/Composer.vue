<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bold, Italic, Strikethrough, Code, List, AtSign, Smile, Paperclip, SendHorizontal, X, FileText, Users } from 'lucide-vue-next';
import type { Channel } from '@agencia-hub/contracts';
import { useSession } from '@/stores/session.ts';
import Avatar from '@/design/Avatar.vue';
import Popover from '@/design/Popover.vue';
import { toast } from '@/design/toast.ts';
import { useChat } from './store.ts';
import { uploadFile, type Upload } from './upload.ts';
import EmojiPicker from './EmojiPicker.vue';

const props = defineProps<{ channel: Channel; parentId?: string; placeholder: string }>();
const { t } = useI18n();
const s = useSession();
const chat = useChat();

const text = ref('');
const area = ref<HTMLTextAreaElement>();
const fileInput = ref<HTMLInputElement>();
const uploads = ref<Upload[]>([]);
const alsoInChannel = ref(false);
const requireAck = ref(false);
const pinUntil = ref('');
const emojiOpen = ref(false);
const isAnnouncement = computed(() => props.channel.kind === 'announcement' && !props.parentId);
const coarse = matchMedia('(pointer: coarse)').matches;   // en el teléfono Enter = salto de línea

// ─── Borrador por conversación (comodidad local, no crítico) ───
const draftKey = computed(() => `draft:${props.channel.id}:${props.parentId ?? ''}`);
onMounted(() => { try { text.value = localStorage.getItem(draftKey.value) ?? ''; } catch { /* sin almacenamiento */ } autosize(); });
watch(text, (v) => { try { v ? localStorage.setItem(draftKey.value, v) : localStorage.removeItem(draftKey.value); } catch { /* idem */ } });

function autosize() {
  nextTick(() => {
    const el = area.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  });
}

// ─── Formato ───
function wrap(before: string, after = before) {
  const el = area.value!;
  const [a, b] = [el.selectionStart, el.selectionEnd];
  text.value = text.value.slice(0, a) + before + text.value.slice(a, b) + after + text.value.slice(b);
  nextTick(() => { el.focus(); el.setSelectionRange(a + before.length, b + before.length); });
}
function insert(str: string) {
  const el = area.value!;
  const a = el.selectionStart;
  text.value = text.value.slice(0, a) + str + text.value.slice(el.selectionEnd);
  nextTick(() => { el.focus(); el.setSelectionRange(a + str.length, a + str.length); autosize(); });
}
const asList = () => {
  const el = area.value!;
  const start = text.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
  text.value = `${text.value.slice(0, start)}- ${text.value.slice(start)}`;
  nextTick(() => el.focus());
};

// ─── @menciones: se escriben "@Nombre" y se convierten a <@id> al enviar ───
const mentionQuery = ref<string | null>(null);
const mentionIndex = ref(0);
const inserted = new Map<string, string>();   // "@Ana Torres" → id
const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const suggestions = computed(() => {
  if (mentionQuery.value === null) return [];
  const q = fold(mentionQuery.value);
  const people = chat.members.filter((m) => m.isActive && m.userId !== s.user!.id && fold(m.name).includes(q)).slice(0, 6)
    .map((m) => ({ key: m.userId, label: m.name, hint: m.title ?? '', insert: `@${m.name}`, id: m.userId, presence: m.presence }));
  const special = props.channel.kind === 'dm' ? [] : [
    { key: 'channel', label: '@canal', hint: t('chat.channelAll'), insert: '@canal', id: null, presence: null },
    { key: 'here', label: '@aquí', hint: t('chat.here'), insert: '@aquí', id: null, presence: null },
  ].filter((x) => fold(x.label).includes(q));
  return [...people, ...special];
});

function onInput() {
  autosize();
  chat.sendTyping(props.channel.id, props.parentId);
  const el = area.value!;
  const before = text.value.slice(0, el.selectionStart);
  const m = /(^|\s)@([\p{L}\p{N} ]{0,24})$/u.exec(before);
  mentionQuery.value = m && !m[2]!.includes('  ') ? m[2]! : null;
  mentionIndex.value = 0;
}
function pickMention(i: number) {
  const sug = suggestions.value[i];
  if (!sug) return;
  const el = area.value!;
  const caret = el.selectionStart;
  const start = text.value.slice(0, caret).lastIndexOf('@');
  text.value = `${text.value.slice(0, start)}${sug.insert} ${text.value.slice(caret)}`;
  if (sug.id) inserted.set(sug.insert, sug.id);
  mentionQuery.value = null;
  const pos = start + sug.insert.length + 1;
  nextTick(() => { el.focus(); el.setSelectionRange(pos, pos); });
}

function onKeydown(e: KeyboardEvent) {
  if (suggestions.value.length) {
    if (e.key === 'ArrowDown') { mentionIndex.value = (mentionIndex.value + 1) % suggestions.value.length; e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { mentionIndex.value = (mentionIndex.value - 1 + suggestions.value.length) % suggestions.value.length; e.preventDefault(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mentionIndex.value); e.preventDefault(); return; }
    if (e.key === 'Escape') { mentionQuery.value = null; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !coarse) { e.preventDefault(); submit(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); wrap('**'); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); wrap('_'); }
}

// ─── Archivos ───
function addFiles(files: Iterable<File>) {
  const maxMb = s.workspace!.settings.maxFileMb;
  for (const f of files) {
    uploads.value.push(uploadFile(s.workspace!.slug, f, maxMb, { tooBig: t('chat.tooBig', { name: f.name, mb: maxMb }), failed: t('chat.uploadFailed', { name: f.name }) }));
  }
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
}
const uploading = computed(() => uploads.value.some((u) => !u.file && !u.error));
const ready = computed(() => uploads.value.filter((u) => u.file).map((u) => u.file!));
const canSend = computed(() => !uploading.value && (text.value.trim() !== '' || ready.value.length > 0));

function submit() {
  if (!canSend.value) return;
  let body = text.value.trim();
  for (const [display, id] of inserted) body = body.split(display).join(`<@${id}>`);
  body = body.replace(/(^|\s)@canal\b/g, '$1<!channel>').replace(/(^|\s)@aquí/g, '$1<!here>');
  chat.send(props.channel.id, body, {
    parentId: props.parentId, alsoInChannel: alsoInChannel.value, files: ready.value,
    ackRequired: isAnnouncement.value && requireAck.value,
    pinUntil: isAnnouncement.value && pinUntil.value ? new Date(`${pinUntil.value}T23:59:00`).toISOString() : undefined,
  }).catch((e) => toast(e.message, 'error'));
  for (const u of uploads.value) if (u.preview) URL.revokeObjectURL(u.preview);
  text.value = '';
  uploads.value = [];
  inserted.clear();
  alsoInChannel.value = false;
  requireAck.value = false;
  pinUntil.value = '';
  autosize();
}

const removeUpload = (u: Upload) => { uploads.value = uploads.value.filter((x) => x !== u); };
defineExpose({ addFiles, focus: () => area.value?.focus() });
</script>

<template>
  <div class="composer-wrap">
    <div v-if="suggestions.length" class="suggest" role="listbox">
      <button v-for="(sug, i) in suggestions" :key="sug.key" type="button" role="option" :aria-selected="i === mentionIndex"
        :class="{ on: i === mentionIndex }" @mousedown.prevent="pickMention(i)" @mousemove="mentionIndex = i">
        <Avatar v-if="sug.id" :name="sug.label" :size="26" :presence="sug.presence" />
        <span v-else class="all"><Users :size="15" /></span>
        <b>{{ sug.label }}</b><small>{{ sug.hint }}</small>
      </button>
    </div>

    <div class="composer" :class="{ announce: isAnnouncement }">
      <div class="tools">
        <button type="button" :title="t('chat.bold')" :aria-label="t('chat.bold')" @click="wrap('**')"><Bold :size="16" /></button>
        <button type="button" :title="t('chat.italic')" :aria-label="t('chat.italic')" @click="wrap('_')"><Italic :size="16" /></button>
        <button type="button" :title="t('chat.strike')" :aria-label="t('chat.strike')" @click="wrap('~')"><Strikethrough :size="16" /></button>
        <button type="button" :title="t('chat.code')" :aria-label="t('chat.code')" @click="wrap('`')"><Code :size="16" /></button>
        <button type="button" :title="t('chat.list')" :aria-label="t('chat.list')" @click="asList"><List :size="16" /></button>
      </div>

      <div v-if="uploads.length" class="uploads">
        <div v-for="u in uploads" :key="u.key" class="up" :class="{ err: u.error }">
          <img v-if="u.preview" :src="u.preview" alt="">
          <span v-else class="up-ico"><FileText :size="18" /></span>
          <span class="up-meta"><b>{{ u.name }}</b><small v-if="u.error">{{ u.error }}</small></span>
          <span v-if="!u.file && !u.error" class="prog"><i :style="{ width: `${u.progress * 100}%` }" /></span>
          <button type="button" class="up-x" :aria-label="t('chat.discard')" @click="removeUpload(u)"><X :size="14" /></button>
        </div>
      </div>

      <textarea ref="area" v-model="text" rows="1" :placeholder="placeholder" :aria-label="placeholder"
        @input="onInput" @keydown="onKeydown" @paste="onPaste" @click="onInput" />

      <div v-if="isAnnouncement" class="announce-opts">
        <label><input v-model="requireAck" type="checkbox">{{ t('chat.requireAck') }}</label>
        <label>{{ t('chat.pinUntil') }} <input v-model="pinUntil" type="date" :min="new Date().toISOString().slice(0, 10)"></label>
      </div>

      <div class="foot">
        <button type="button" :title="t('chat.attach')" :aria-label="t('chat.attach')" @click="fileInput?.click()"><Paperclip :size="17" /></button>
        <button type="button" :title="t('chat.mention')" :aria-label="t('chat.mention')" @click="insert('@'); onInput()"><AtSign :size="17" /></button>
        <Popover v-model="emojiOpen" placement="top-start">
          <template #trigger><button type="button" :title="t('chat.emoji')" :aria-label="t('chat.emoji')" @click="emojiOpen = !emojiOpen"><Smile :size="17" /></button></template>
          <EmojiPicker @pick="(e) => { insert(e); emojiOpen = false; }" />
        </Popover>
        <label v-if="parentId" class="also"><input v-model="alsoInChannel" type="checkbox">{{ t('chat.alsoSendTo', { name: `#${channel.name ?? chat.channelTitle(channel)}` }) }}</label>
        <button type="button" class="send" :disabled="!canSend" :aria-label="t('chat.send')" @click="submit"><SendHorizontal :size="17" /><span>{{ t('chat.send') }}</span></button>
      </div>
      <input ref="fileInput" type="file" multiple hidden @change="addFiles(($event.target as HTMLInputElement).files ?? []); ($event.target as HTMLInputElement).value = ''">
    </div>
  </div>
</template>

<style scoped>
.composer-wrap { position: relative; padding: 0 20px 16px 16px; }
/* El compositor flota sobre el lienzo: sombra media + borde inferior más grueso */
.composer { background: var(--color-surface); border: 1px solid var(--color-line-strong); border-bottom-width: 2px; box-shadow: var(--shadow-md); transition: border-color var(--duration), box-shadow var(--duration); }
.composer:focus-within { border-color: var(--color-ink); box-shadow: var(--shadow-lg); }
.composer.announce { border-top: 3px solid var(--color-primary); }
.tools, .foot { display: flex; align-items: center; gap: 2px; padding: 4px 6px; }
.tools { border-bottom: 1px solid var(--color-line); }
.tools button, .foot > button, .foot :deep(.pop) > button { width: 32px; height: 32px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: color var(--duration), background var(--duration); }
.tools button:hover, .foot > button:hover, .foot :deep(.pop) > button:hover { color: var(--color-ink); background: var(--color-canvas); }
textarea { display: block; width: 100%; min-height: 44px; max-height: 220px; padding: 10px 14px; font: inherit; line-height: 1.45; color: inherit; background: transparent; border: 0; outline: none; resize: none; }
.send { margin-left: auto; width: auto !important; display: inline-flex !important; align-items: center; gap: 6px; padding: 0 14px; min-height: 34px; font: inherit; font-weight: 700; font-size: 14px; color: var(--color-ink) !important; background: var(--color-primary) !important; box-shadow: var(--shadow-sm); }
.send:hover:not(:disabled) { background: var(--color-primary-dark) !important; box-shadow: var(--shadow-md); }
.send:disabled { opacity: .45; cursor: not-allowed; }
.also { display: flex; align-items: center; gap: 6px; margin-left: 8px; font-size: 13px; color: var(--color-muted); }
.announce-opts { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 6px 14px 4px; font-size: 13px; color: var(--color-muted); border-top: 1px dashed var(--color-line); }
.announce-opts label { display: flex; align-items: center; gap: 6px; }
.announce-opts input[type="date"] { font: inherit; padding: 2px 6px; border: 1px solid var(--color-line-strong); }
input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--color-ink); }

.uploads { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px 0; }
.up { position: relative; display: flex; align-items: center; gap: 8px; width: 220px; padding: 6px 30px 6px 6px; background: var(--color-canvas); border: 1px solid var(--color-line); box-shadow: var(--shadow-sm); }
.up.err { background: var(--color-danger-light); border-color: #F3B8B2; }
.up img, .up-ico { width: 40px; height: 40px; object-fit: cover; flex: none; display: grid; place-items: center; background: var(--color-leaf); color: #fff; }
.up-meta { display: grid; min-width: 0; font-size: 13px; }
.up-meta b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.up-meta small { color: var(--color-danger); font-size: 11px; }
.prog { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--color-line); }
.prog i { display: block; height: 100%; background: var(--color-primary); transition: width 120ms; }
.up-x { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; display: grid; place-items: center; background: var(--color-surface); border: 1px solid var(--color-line); cursor: pointer; }

.suggest { position: absolute; left: 16px; right: 20px; bottom: calc(100% - 8px); z-index: 30; max-height: 280px; overflow: auto; background: var(--color-surface); border: 1px solid var(--color-line); box-shadow: var(--shadow-lg); }
.suggest button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 0 14px; font: inherit; text-align: left; color: inherit; background: none; border: 0; cursor: pointer; }
.suggest button.on { background: var(--color-ink); color: #fff; }
.suggest small { margin-left: auto; font-size: 12px; color: var(--color-muted); }
.suggest button.on small { color: var(--color-sidebar-text); }
.all { width: 26px; height: 26px; display: grid; place-items: center; background: var(--color-primary); color: var(--color-ink); }

@media (max-width: 767px) {
  .composer-wrap { padding: 0 8px calc(8px + env(safe-area-inset-bottom, 0px)); }
  .tools { display: none; }
  .send span { display: none; }
  .send { width: var(--tap) !important; padding: 0; justify-content: center; }
  .foot > button, .foot :deep(.pop) > button { width: 40px; height: 40px; }
  textarea { font-size: 16px; } /* evita el zoom automático de iOS */
  .also { font-size: 12px; }
}
</style>
