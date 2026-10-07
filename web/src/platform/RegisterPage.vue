<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { RegisterBody, TEMPLATES } from '@agencia-hub/contracts';
import { ShieldCheck, Megaphone, Building2, Plane, LayoutTemplate } from 'lucide-vue-next';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import AuthLayout from './AuthLayout.vue';
import Input from '@/design/Input.vue';
import Button from '@/design/Button.vue';
import { errorText } from './errors.ts';

const { t, locale } = useI18n();
const router = useRouter();
const session = useSession();

const f = reactive({ name: '', email: '', password: '', agency: '', slug: '', template: 'insurance_agency' as typeof TEMPLATES[number] });
// Ícono de cada rubro en las tarjetas del selector
const tplIcon = { insurance_agency: ShieldCheck, marketing_agency: Megaphone, real_estate_agency: Building2, travel_agency: Plane, blank: LayoutTemplate };
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
      <!-- Rubro: tarjetas hermanas del mismo tamaño, una por plantilla -->
      <fieldset class="tpl">
        <legend>{{ t('auth.template') }}<small>{{ t('auth.templateHint') }}</small></legend>
        <label v-for="o in TEMPLATES" :key="o" :class="{ on: f.template === o }">
          <input v-model="f.template" type="radio" name="tpl" :value="o" class="sr-only">
          <span class="ico"><component :is="tplIcon[o]" :size="18" /></span>
          <span class="txt"><b>{{ t(`auth.templates.${o}.name`) }}</b><small>{{ t(`auth.templates.${o}.hint`) }}</small></span>
        </label>
      </fieldset>
      <!-- El aviso de PHI solo aplica a las agencias de seguros -->
      <p v-if="f.template === 'insurance_agency'" class="text-xs text-muted">{{ t('auth.phiNotice') }}</p>
      <p v-if="error" class="text-sm font-medium text-danger" role="alert">{{ error }}</p>
      <Button type="submit" variant="primary" size="lg" block :loading="busy">{{ t('auth.register') }}</Button>
    </form>
    <template #footer>{{ t('auth.haveAccount') }} <RouterLink to="/login">{{ t('auth.login') }}</RouterLink></template>
  </AuthLayout>
</template>

<style scoped>
.tpl { display: grid; grid-auto-rows: 1fr; gap: 8px; margin: 0; padding: 0; border: 0; }
legend { display: grid; gap: 2px; font-size: 13px; font-weight: 500; margin-bottom: 8px; }
legend small { font-weight: 400; color: var(--color-muted); }
/* Mismo alto para todas (grid-auto-rows: 1fr); la elegida se eleva y lleva el acento naranja */
.tpl label { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); cursor: pointer; transition: border-color var(--duration), background var(--duration), box-shadow var(--duration), transform var(--duration); }
.tpl label:hover:not(.on) { border-color: var(--color-ink); box-shadow: var(--shadow-md); transform: translateY(-1px); }
.tpl label:focus-within { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.tpl label.on { border-color: var(--color-ink); background: var(--color-primary-light); box-shadow: inset 4px 0 0 var(--color-primary), var(--shadow-md); }
.ico { width: 34px; height: 34px; display: grid; place-items: center; flex: none; color: var(--color-ink); background: var(--color-canvas); box-shadow: var(--shadow-sm); }
.on .ico { background: var(--color-primary); }
.txt { display: grid; gap: 2px; min-width: 0; }
.tpl small { font-size: 12px; color: var(--color-muted); line-height: 1.35; }
</style>
