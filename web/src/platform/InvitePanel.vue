<script setup lang="ts">
// Invitar por enlace o por email, y ver/revocar las invitaciones pendientes.
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Link2, Copy, Mail, X } from 'lucide-vue-next';
import type { Invitation, Role } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import Button from '@/design/Button.vue';
import Input from '@/design/Input.vue';
import Dropdown from '@/design/Dropdown.vue';
import Badge from '@/design/Badge.vue';
import { toast } from '@/design/toast.ts';
import { errorText } from './errors.ts';

const { t, d } = useI18n();
const s = useSession();
const params = computed(() => ({ slug: s.workspace!.slug }));

type InviteRole = Exclude<Role, 'owner'>;
const role = ref<InviteRole>('member');
const roleOptions = computed(() => (['member', 'lead', 'admin'] as const).map((r) => ({ value: r, label: t(`roles.${r}`) })));
const link = ref('');
const emails = ref('');
const pending = ref<Invitation[]>([]);
const busy = ref(false);

const load = async () => { pending.value = await api('GET /w/:slug/invitations', { params: params.value }); };
onMounted(load);

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('common.copied'), 'success');
  } catch { /* el input queda seleccionable */ }
}

async function createLink() {
  busy.value = true;
  try {
    const inv = await api('POST /w/:slug/invitations', { params: params.value, body: { email: null, role: role.value, maxUses: 100 } });
    link.value = inv.url;
    await copy(inv.url);
    await load();
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = false;
  }
}

async function sendEmails() {
  const list = emails.value.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
  if (!list.length) return;
  busy.value = true;
  try {
    for (const email of list) await api('POST /w/:slug/invitations', { params: params.value, body: { email, role: role.value } });
    emails.value = '';
    toast(t('settings.invitesSent'), 'success');
    await load();
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    busy.value = false;
  }
}

async function revoke(id: string) {
  await api('DELETE /w/:slug/invitations/:id', { params: { ...params.value, id } });
  toast(t('settings.revoked'));
  await load();
}
</script>

<template>
  <div class="grid gap-5">
    <Dropdown v-model="role" :options="roleOptions" :label="t('settings.role')" class="max-w-60" />
    <section class="grid gap-2">
      <h3 class="m-0 text-base">{{ t('settings.inviteLink') }}</h3>
      <p class="m-0 text-sm text-muted">{{ t('settings.inviteLinkHint') }}</p>
      <div class="flex flex-wrap gap-2">
        <input v-if="link" class="link" :value="link" readonly :aria-label="t('settings.link')" @focus="($event.target as HTMLInputElement).select()">
        <Button v-if="link" @click="copy(link)"><Copy :size="16" />{{ t('common.copy') }}</Button>
        <Button v-else variant="primary" :loading="busy" @click="createLink"><Link2 :size="16" />{{ t('settings.createLink') }}</Button>
      </div>
    </section>
    <form class="grid gap-2" @submit.prevent="sendEmails">
      <h3 class="m-0 text-base">{{ t('settings.inviteByEmail') }}</h3>
      <Input v-model="emails" :label="t('settings.emails')" :hint="t('settings.emailsHint')" placeholder="ana@agencia.com, carlos@agencia.com" />
      <div><Button type="submit" :loading="busy"><Mail :size="16" />{{ t('settings.sendInvites') }}</Button></div>
    </form>
    <section v-if="pending.length" class="grid gap-2">
      <h3 class="m-0 text-base">{{ t('settings.pending') }}</h3>
      <ul class="pend">
        <li v-for="p in pending" :key="p.id">
          <span class="flex-1 min-w-0 truncate">{{ p.email ?? t('settings.link') }}</span>
          <Badge>{{ t(`roles.${p.role}`) }}</Badge>
          <small class="text-muted">{{ p.email ? t('settings.expires', { date: d(p.expiresAt) }) : t('settings.uses', { uses: p.uses, max: p.maxUses }) }}</small>
          <button type="button" class="icon" :aria-label="t('settings.revoke')" @click="revoke(p.id)"><X :size="16" /></button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.link { flex: 1; min-width: 220px; min-height: 38px; padding: 0 10px; font: inherit; font-size: 13px; background: var(--color-canvas); border: 1px solid var(--color-line-strong); color: var(--color-ink); }
.pend { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-line); background: var(--color-surface); }
.pend li { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 6px 6px 12px; border-top: 1px solid var(--color-line); font-size: 14px; }
.pend li:first-child { border-top: 0; }
.icon { width: 36px; height: 36px; display: grid; place-items: center; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.icon:hover { color: var(--color-danger); background: var(--color-danger-light); }
</style>
