<script setup lang="ts">
// Tabla de comisiones de un producto (nivel de contrato → %). Guardar con otra fecha crea una revisión nueva;
// con la misma fecha corrige esa revisión. Las ventas ya ISSUED no cambian.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Plus, X } from 'lucide-vue-next';
import type { Product } from '@agencia-hub/contracts';
import Modal from '@/design/Modal.vue';
import Button from '@/design/Button.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { today, fmtDay } from './format.ts';

const open = defineModel<boolean>({ default: false });
const props = defineProps<{ product: Product | null; title: string }>();
const emit = defineEmits<{ saved: [] }>();
const { t, locale } = useI18n();
const s = useSession();

const effectiveFrom = ref('');
const rows = ref<{ level: string; rate: string }[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);
watch(open, (v) => {
  if (!v) return;
  const last = props.product?.grids[0];
  effectiveFrom.value = last?.effectiveFrom ?? today();
  rows.value = last ? last.rows.map((r) => ({ level: String(r.level), rate: String(r.rate) })) : [{ level: '', rate: '' }];
  error.value = null;
});
const clean = computed(() => rows.value.filter((r) => r.level !== '' || r.rate !== '').map((r) => ({ level: Number(r.level), rate: Number(r.rate) })));
const valid = computed(() => effectiveFrom.value && clean.value.length
  && clean.value.every((r) => Number.isInteger(r.level) && r.level >= 0 && r.rate >= 0 && r.rate <= 300)
  && new Set(clean.value.map((r) => r.level)).size === clean.value.length);

async function save() {
  busy.value = true;
  error.value = null;
  try {
    await api('PUT /w/:slug/products/:id/grid', { params: { slug: s.workspace!.slug, id: props.product!.id },
      body: { effectiveFrom: effectiveFrom.value, rows: clean.value } });
    toast(t('common.saved'), 'success');
    open.value = false;
    emit('saved');
  } catch (e) { error.value = errorText(e); } finally { busy.value = false; }
}
</script>

<template>
  <Modal v-model="open" :title="title" :subtitle="t('sales.gridHint')" width="460px">
    <label class="date">{{ t('sales.gridFrom') }}<input v-model="effectiveFrom" type="date"></label>
    <p v-if="product?.grids.length && product.grids[0]!.effectiveFrom !== effectiveFrom" class="note">
      {{ t('sales.gridNewRevision', { date: fmtDay(product.grids[0]!.effectiveFrom, locale) }) }}
    </p>
    <div class="grid-rows">
      <div class="head"><span>{{ t('sales.level') }}</span><span>%</span></div>
      <div v-for="(r, i) in rows" :key="i" class="r">
        <input v-model="r.level" type="number" inputmode="numeric" :aria-label="t('sales.level')" placeholder="80">
        <input v-model="r.rate" type="number" inputmode="decimal" aria-label="%" placeholder="65">
        <button type="button" class="x" :aria-label="t('sales.removeRow')" @click="rows.splice(i, 1)"><X :size="15" /></button>
      </div>
      <div><Button size="sm" variant="ghost" @click="rows.push({ level: '', rate: '' })"><Plus :size="15" />{{ t('sales.addLevel') }}</Button></div>
    </div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <template #footer>
      <Button variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
      <Button variant="primary" :loading="busy" :disabled="!valid" @click="save">{{ t('common.save') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.date { display: grid; gap: 6px; font-size: 13px; font-weight: 500; }
.date input { min-height: 42px; }
.note { margin: 0; padding: 8px 12px; font-size: 13px; color: var(--color-muted); background: var(--color-canvas); border-left: 3px solid var(--color-cta); }
.grid-rows { display: grid; gap: 6px; }
.head, .r { display: grid; grid-template-columns: 1fr 1fr 32px; gap: 8px; align-items: center; }
.head { font-size: 12px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; }
.r input { min-height: 36px; width: 100%; padding: 0 10px; font: inherit; font-variant-numeric: tabular-nums; color: var(--color-ink); background: var(--color-surface); border: 1px solid var(--color-line-strong); outline: none; }
.r input:focus { border-color: var(--color-ink); box-shadow: 0 0 0 3px rgb(246 144 8 / .22); }
.x { display: grid; place-items: center; width: 32px; height: 32px; color: var(--color-muted); background: none; border: 0; cursor: pointer; }
.x:hover { color: var(--color-danger); background: var(--color-danger-light); }
.err { margin: 0; padding: 8px 12px; font-size: 14px; color: var(--color-danger); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
</style>
