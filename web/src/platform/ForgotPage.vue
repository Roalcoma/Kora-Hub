<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api.ts';
import AuthLayout from './AuthLayout.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import { errorText } from './errors.ts';

const { t } = useI18n();
const email = ref('');
const sent = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    await api('POST /auth/forgot-password', { body: { email: email.value } });
    sent.value = true;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthLayout :title="t('auth.forgotTitle')" :subtitle="sent ? undefined : t('auth.forgotHint')">
    <p v-if="sent" role="status">{{ t('auth.forgotSent') }}</p>
    <form v-else class="grid gap-4" novalidate @submit.prevent="submit">
      <Input v-model="email" :label="t('common.email')" type="email" autocomplete="email" />
      <p v-if="error" class="text-sm font-medium text-danger" role="alert">{{ error }}</p>
      <Button type="submit" variant="primary" size="lg" block :loading="busy">{{ t('auth.sendLink') }}</Button>
    </form>
    <template #footer><RouterLink to="/login">{{ t('common.back') }}</RouterLink></template>
  </AuthLayout>
</template>
