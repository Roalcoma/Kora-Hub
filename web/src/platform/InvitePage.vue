<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { Routes } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import AuthLayout from './AuthLayout.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import Skeleton from '@/design/Skeleton.vue';
import { errorText } from './errors.ts';

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const session = useSession();
const token = route.params.token as string;

const info = ref<Routes['GET /invitations/:token']['res'] | null>(null);
const invalid = ref(false);
const f = reactive({ name: '', email: '', password: '' });
const error = ref<string | null>(null);
const busy = ref(false);

onMounted(async () => {
  try {
    info.value = await api('GET /invitations/:token', { params: { token } });
  } catch {
    invalid.value = true;
  }
});

async function accept() {
  busy.value = true;
  error.value = null;
  try {
    const res = await api('POST /invitations/accept', {
      body: session.session ? { token } : {
        token, newAccount: { name: f.name, password: f.password, locale: locale.value as 'es' | 'en', email: info.value?.email ? undefined : f.email },
      },
    });
    session.set(res);
    router.replace(`/w/${res.workspaceSlug}`);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthLayout v-if="invalid" :title="t('auth.inviteInvalid')"><RouterLink to="/login">{{ t('auth.login') }}</RouterLink></AuthLayout>
  <AuthLayout v-else-if="!info" :title="t('common.loading')"><Skeleton height="40px" /><Skeleton height="40px" /></AuthLayout>
  <AuthLayout v-else :title="t('auth.inviteTitle', { workspace: info.workspaceName })" :subtitle="t('auth.inviteRole', { role: t(`roles.${info.role}`) })">
    <form class="grid gap-4" novalidate @submit.prevent="accept">
      <template v-if="!session.session">
        <p v-if="info.hasAccount" class="text-sm">{{ t('auth.loginToAccept') }}</p>
        <template v-else>
          <p class="text-sm font-medium">{{ t('auth.createAccount') }}</p>
          <Input v-model="f.name" :label="t('auth.yourName')" autocomplete="name" />
          <Input v-if="!info.email" v-model="f.email" :label="t('common.email')" type="email" autocomplete="email" />
          <Input v-else :model-value="info.email" :label="t('common.email')" type="email" />
          <Input v-model="f.password" :label="t('common.password')" type="password" autocomplete="new-password" :hint="t('auth.passwordHint')" />
        </template>
      </template>
      <p v-if="error" class="text-sm font-medium text-danger" role="alert">{{ error }}</p>
      <Button v-if="!session.session && info.hasAccount" variant="primary" size="lg" block
        @click="router.push({ path: '/login', query: { next: route.fullPath } })">{{ t('auth.login') }}</Button>
      <Button v-else type="submit" variant="primary" size="lg" block :loading="busy">{{ t('auth.accept') }}</Button>
    </form>
  </AuthLayout>
</template>
