<script setup lang="ts">
// Estados de cuenta importados: cuenta, periodo, filas, quién y cuándo, archivo original. "Ver movimientos" filtra la
// lista por ese estado; "Deshacer importación" borra sus movimientos en cascada (el archivo original se conserva).
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { FileSpreadsheet, Download, Undo2, ListFilter, Upload } from 'lucide-vue-next';
import type { BankStatement } from '@agencia-hub/contracts';
import Button from '@/design/Button.vue';
import Modal from '@/design/Modal.vue';
import EmptyState from '@/design/EmptyState.vue';
import Skeleton from '@/design/Skeleton.vue';
import { toast } from '@/design/toast.ts';
import { api } from '@/api.ts';
import { useSession } from '@/stores/session.ts';
import { errorText } from '@/platform/errors.ts';
import { useFinance } from './store.ts';
import { fmtDay } from './format.ts';

const props = defineProps<{ statements: BankStatement[] | null }>();
const emit = defineEmits<{ view: [statementId: string]; undone: []; import: [] }>();
const { t, locale } = useI18n();
const s = useSession();
const fin = useFinance();
const day = (x: string) => fmtDay(x, locale.value);
const when = (iso: string) => new Date(iso).toLocaleString(locale.value, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Agrupadas por cuenta en el orden del servidor (más recientes primero) */
const list = computed(() => props.statements ?? []);

const undoing = ref<BankStatement | null>(null);
const undoOpen = computed({ get: () => !!undoing.value, set: (v) => { if (!v) undoing.value = null; } });
const busy = ref(false);
async function undo() {
  const st = undoing.value!;
  busy.value = true;
  try {
    await api('DELETE /w/:slug/finance/bank/statements/:id', { params: { slug: s.workspace!.slug, id: st.id } });
    toast(t('finance.bank.statements.undoneOk', { n: st.rowsImported }, st.rowsImported), 'success');
    undoing.value = null;
    emit('undone');
  } catch (e) { toast(errorText(e), 'error'); } finally { busy.value = false; }
}
</script>

<template>
  <div class="wrap">
    <div v-if="!statements" class="grid gap-3"><Skeleton v-for="n in 3" :key="n" height="64px" /></div>
    <EmptyState v-else-if="!list.length" :icon="FileSpreadsheet" :title="t('finance.bank.statements.empty')" :text="t('finance.bank.statements.emptyText')">
      <Button variant="primary" @click="emit('import')"><Upload :size="16" />{{ t('finance.bank.import.title') }}</Button>
    </EmptyState>
    <ul v-else class="sts">
      <li v-for="st in list" :key="st.id">
        <span class="ico"><FileSpreadsheet :size="20" /></span>
        <div class="main">
          <b>{{ fin.account(st.accountId)?.name ?? '—' }}</b>
          <span class="per">{{ day(st.periodFrom) }} → {{ day(st.periodTo) }}</span>
          <small>{{ t('finance.bank.statements.by', { name: fin.memberName(st.importedBy), when: when(st.importedAt) }) }}</small>
        </div>
        <div class="nums">
          <span><b>{{ st.rowsImported }}</b>{{ t('finance.bank.statements.imported', st.rowsImported) }}</span>
          <span v-if="st.rowsSkipped" class="sk"><b>{{ st.rowsSkipped }}</b>{{ t('finance.bank.statements.skipped', st.rowsSkipped) }}</span>
        </div>
        <div class="acts">
          <a v-if="st.file" :href="st.file.url" target="_blank" rel="noopener" class="act" :title="st.file.name"><Download :size="15" />{{ t('finance.bank.statements.original') }}</a>
          <button type="button" class="act" @click="emit('view', st.id)"><ListFilter :size="15" />{{ t('finance.bank.statements.view') }}</button>
          <button type="button" class="act danger" @click="undoing = st"><Undo2 :size="15" />{{ t('finance.bank.statements.undo') }}</button>
        </div>
      </li>
    </ul>

    <Modal v-model="undoOpen" :title="t('finance.bank.statements.undoTitle')"
      :subtitle="undoing ? `${fin.account(undoing.accountId)?.name ?? ''} · ${day(undoing.periodFrom)} → ${day(undoing.periodTo)}` : ''">
      <p class="note">{{ t('finance.bank.statements.undoNote', { n: undoing?.rowsImported ?? 0 }, undoing?.rowsImported ?? 0) }}</p>
      <template #footer>
        <Button variant="ghost" @click="undoing = null">{{ t('common.cancel') }}</Button>
        <Button variant="danger" :loading="busy" @click="undo">{{ t('finance.bank.statements.undo') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.wrap { display: grid; gap: 14px; }
.wrap :deep(.empty) { max-width: none; }
.sts { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.sts li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 8px 18px; padding: 14px 16px 14px 14px;
  background: var(--color-surface); border-left: 4px solid var(--color-leaf); box-shadow: var(--shadow-md); transition: box-shadow var(--duration), transform var(--duration); }
.sts li:hover { box-shadow: var(--shadow-lg); transform: translateY(-1px); }
.ico { display: grid; place-items: center; width: 42px; height: 42px; color: var(--color-leaf); background: var(--color-cat-blue-light); }
.main { display: grid; gap: 2px; min-width: 0; }
.main b { font-size: 15px; }
.per { font-weight: 600; font-variant-numeric: tabular-nums; }
.main small { font-size: 12px; color: var(--color-muted); }
.nums { display: flex; gap: 14px; font-size: 13px; color: var(--color-muted); }
.nums b { margin-right: 4px; font-family: var(--font-display); font-size: 20px; color: var(--color-ink); font-variant-numeric: tabular-nums; }
.nums .sk b { color: var(--color-warning); }
.acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
.act { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px; font: inherit; font-size: 13px; font-weight: 600; color: var(--color-leaf); text-decoration: none;
  background: none; border: 0; cursor: pointer; transition: background var(--duration); }
.act:hover { background: var(--color-canvas); }
.act.danger { color: var(--color-danger); }
.note { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; color: var(--color-ink); background: var(--color-danger-light); border-left: 3px solid var(--color-danger); }
@media (max-width: 900px) {
  .sts li { grid-template-columns: auto minmax(0, 1fr); }
  .nums, .acts { grid-column: 1 / -1; }
  .acts { justify-content: flex-start; }
  .act:first-child { padding-left: 0; }
}
</style>
