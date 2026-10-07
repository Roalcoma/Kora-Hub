<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import AuthLayout from './AuthLayout.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import { errorText } from './errors.ts';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const session = useSession();

const email = ref('');
const password = ref('');
const totp = ref('');
const needTotp = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    const res = await api('POST /auth/login', { body: { email: email.value, password: password.value, totp: needTotp.value ? totp.value : undefined } });
    if ('totpRequired' in res) {
      needTotp.value = true;
      return;
    }
    session.set(res);
    const next = route.query.next as string | undefined;
    router.replace(next?.startsWith('/') ? next : '/');
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthLayout :title="needTotp ? t('auth.totpTitle') : t('auth.loginTitle')" :subtitle="needTotp ? t('auth.totpHint') : t('auth.loginSubtitle')">
    <form class="grid gap-4" novalidate @submit.prevent="submit">
      <template v-if="!needTotp">
        <Input v-model="email" :label="t('common.email')" type="email" autocomplete="email" required />
        <Input v-model="password" :label="t('common.password')" type="password" autocomplete="current-password" required />
      </template>
      <Input v-else v-model="totp" :label="t('auth.totpCode')" autocomplete="one-time-code" placeholder="123456" />
      <p v-if="error" class="text-sm font-medium text-danger" role="alert">{{ error }}</p>
      <Button type="submit" variant="primary" size="lg" block :loading="busy">{{ t('auth.login') }}</Button>
      <RouterLink v-if="!needTotp" to="/forgot" class="text-sm">{{ t('auth.forgot') }}</RouterLink>
    </form>
    <template #footer>{{ t('auth.noAccount') }} <RouterLink to="/register">{{ t('auth.createOne') }}</RouterLink></template>
  </AuthLayout>
</template>
