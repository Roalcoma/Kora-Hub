<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '@/api.ts';
import AuthLayout from './AuthLayout.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { errorText } from './errors.ts';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const password = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    await api('POST /auth/reset-password', { body: { token: route.params.token as string, password: password.value } });
    toast(t('auth.resetDone'), 'success');
    router.replace('/login');
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthLayout :title="t('auth.resetTitle')">
    <form class="grid gap-4" novalidate @submit.prevent="submit">
      <Input v-model="password" :label="t('common.password')" type="password" autocomplete="new-password" :hint="t('auth.passwordHint')" />
      <p v-if="error" class="text-sm font-medium text-danger" role="alert">{{ error }}</p>
      <Button type="submit" variant="primary" size="lg" block :loading="busy">{{ t('auth.setPassword') }}</Button>
    </form>
  </AuthLayout>
</template>
