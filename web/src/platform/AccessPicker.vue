<script setup lang="ts">
// Departamentos (— / Miembro / Líder) y líneas de una persona. Lo usan «Crear usuario» y la ficha de cada miembro.
// Sin líneas marcadas ve todas las de sus departamentos; el Líder ve todas las del suyo (deptLineRule en el servidor).
import { useI18n } from 'vue-i18n';
import { useSession } from '@/stores/session.ts';
import { toneColor } from '@/design/types.ts';

const depts = defineModel<Record<string, 'none' | 'member' | 'lead'>>('depts', { required: true });
const lines = defineModel<string[]>('lines', { required: true });
const { t } = useI18n();
const s = useSession();
const toggleLine = (id: string) => { lines.value = lines.value.includes(id) ? lines.value.filter((x) => x !== id) : [...lines.value, id]; };
</script>

<template>
  <div class="grid gap-2">
    <div v-for="dpt in s.workspace!.departments.filter((x) => !x.archivedAt)" :key="dpt.id" class="dept">
      <span class="flex-1">{{ dpt.name }}</span>
      <div class="seg" role="radiogroup" :aria-label="dpt.name">
        <button v-for="v in (['none', 'member', 'lead'] as const)" :key="v" type="button" role="radio" :aria-checked="(depts[dpt.id] ?? 'none') === v"
          @click="depts = { ...depts, [dpt.id]: v }">{{ v === 'none' ? '—' : v === 'lead' ? t('settings.lead') : t('roles.member') }}</button>
      </div>
    </div>
    <template v-if="s.activeLines.length">
      <h3 class="lines-h">{{ s.cat.categories }}</h3>
      <p class="hint">{{ t('settings.memberLinesHint', s.cat) }}</p>
      <div class="line-picks">
        <button v-for="l in s.activeLines" :key="l.id" type="button" role="checkbox" :aria-checked="lines.includes(l.id)" @click="toggleLine(l.id)">
          <span class="dot" :style="{ background: toneColor(s.lineTone(l.id), true) }" />{{ l.name }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dept { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--color-line); }
.seg { display: flex; border: 1px solid var(--color-line-strong); }
.seg button { min-height: 36px; padding: 0 10px; font: inherit; font-size: 13px; color: var(--color-ink); background: var(--color-surface); border: 0; cursor: pointer; }
.seg button[aria-checked="true"] { background: var(--color-ink); color: #fff; }
.lines-h { margin: 18px 0 0; font-size: 14px; }
.hint { margin: 0; font-size: 13px; color: var(--color-muted); }
.line-picks { display: flex; flex-wrap: wrap; gap: 8px; }
.line-picks button { display: inline-flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 14px; font: inherit; font-size: 14px; color: var(--color-ink); background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-sm); cursor: pointer; }
.line-picks button[aria-checked="true"] { background: var(--color-ink); color: #fff; border-color: var(--color-ink); }
.line-picks .dot { width: 8px; height: 8px; }
</style>
