<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { MessagesSquare, Settings, UserPlus } from 'lucide-vue-next';
import { useSession } from '@/stores/session.ts';
import EmptyState from '@/design/EmptyState.vue';
import Button from '@/design/Button.vue';
import Badge from '@/design/Badge.vue';

const { t, d } = useI18n();
const router = useRouter();
const s = useSession();
const base = `/w/${s.workspace!.slug}`;
</script>

<template>
  <div class="home">
    <header class="top">
      <h1>{{ t('home.welcome', { name: s.user!.name.split(' ')[0] }) }}</h1>
      <Badge v-if="s.workspace!.status === 'trialing'" tone="primary">{{ t('home.trial', { date: d(s.workspace!.trialEndsAt) }) }}</Badge>
    </header>
    <EmptyState :icon="MessagesSquare" :title="t('home.soonTitle')" :text="t('home.soonText')">
      <template v-if="s.isAdmin">
        <Button variant="primary" @click="router.push(`${base}/onboarding`)"><Settings :size="16" />{{ t('home.setup') }}</Button>
        <Button @click="router.push(`${base}/settings/invitations`)"><UserPlus :size="16" />{{ t('home.invite') }}</Button>
      </template>
    </EmptyState>
  </div>
</template>

<style scoped>
.home { display: grid; align-content: start; }
.top { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; min-height: 56px; padding: 0 20px; background: var(--color-surface); border-bottom: 1px solid var(--color-line); }
h1 { margin: 0; font-size: 19px; }
</style>
