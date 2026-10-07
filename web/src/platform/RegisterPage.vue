<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { RegisterBody } from '@agencia-hub/contracts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import AuthLayout from './AuthLayout.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import { errorText } from './errors.ts';

const { t, locale } = useI18n();
const router = useRouter();
const session = useSession();

const f = reactive({ name: '', email: '', password: '', agency: '', slug: '', template: 'insurance_agency' as 'insurance_agency' | 'blank' });
const slugTouched = ref(false);
const errors = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const busy = ref(false);

// La dirección se sugiere a partir del nombre de la agencia hasta que la persona la edite
const toSlug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
watch(() => f.agency, (v) => { if (!slugTouched.value) f.slug = toSlug(v); });
const slug = computed({ get: () => f.slug, set: (v) => { slugTouched.value = true; f.slug = v; } });

const body = () => ({
  name: f.name, email: f.email, password: f.password, locale: locale.value as 'es' | 'en',
  workspace: { name: f.agency, slug: f.slug, template: f.template },
});

async function submit() {
  error.value = null;
  const parsed = RegisterBody.safeParse(body());
  errors.value = {};
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.value[i.path.join('.')] ??= i.message;
    return;
  }
  busy.value = true;
  try {
    const res = await api('POST /auth/register', { body: parsed.data });
    session.set(res);
    router.replace(`/w/${res.workspaceSlug}/onboarding`);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthLayout :title="t('auth.registerTitle')" :subtitle="t('auth.registerSubtitle')">
    <form class="grid gap-4" novalidate @submit.prevent="submit">
      <Input v-model="f.name" :label="t('auth.yourName')" autocomplete="name" :error="errors.name" />
      <Input v-model="f.email" :label="t('common.email')" type="email" autocomplete="email" :error="errors.email" />
      <Input v-model="f.password" :label="t('common.password')" type="password" autocomplete="new-password" :hint="t('auth.passwordHint')" :error="errors.password" />
      <Input v-model="f.agency" :label="t('auth.agencyName')" autocomplete="organization" :error="errors['workspace.name']" />
      <Input v-model="slug" :label="t('auth.address')" prefix="app.agencia-hub.com/w/" :hint="t('auth.addressHint')" :error="errors['workspace.slug']" />
      <fieldset class="tpl">
        <legend>{{ t('auth.template') }}</legend>
        <label v-for="o in (['insurance_agency', 'blank'] as const)" :key="o" :class="{ on: f.template === o }">
          <input v-model="f.template" type="radio" name="tpl" :value="o" class="sr-only">
          <b>{{ o === 'insurance_agency' ? t('auth.templateInsurance') : t('auth.templateBlank') }}</b>
          <small>{{ o === 'insurance_agency' ? t('auth.templateInsuranceHint') : t('auth.templateBlankHint') }}</small>
        </label>
      </fieldset>
      <p class="text-xs text-muted">{{ t('auth.terms') }}</p>
      <p v-if="error" class="text-sm font-medium text-danger" role="alert">{{ error }}</p>
      <Button type="submit" variant="primary" size="lg" block :loading="busy">{{ t('auth.register') }}</Button>
    </form>
    <template #footer>{{ t('auth.haveAccount') }} <RouterLink to="/login">{{ t('auth.login') }}</RouterLink></template>
  </AuthLayout>
</template>

<style scoped>
.tpl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0; padding: 0; border: 0; }
legend { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
.tpl label { display: grid; gap: 2px; padding: 10px 12px; border: 1px solid var(--color-line-strong); cursor: pointer; transition: border-color var(--duration), background var(--duration); }
.tpl label:focus-within { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.tpl label.on { border-color: var(--color-ink); background: var(--color-primary-light); box-shadow: inset 3px 0 0 var(--color-primary); }
.tpl small { font-size: 12px; color: var(--color-muted); line-height: 1.35; }
@media (max-width: 420px) { .tpl { grid-template-columns: 1fr; } }
</style>
