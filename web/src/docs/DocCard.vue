<script setup lang="ts">
// Tarjeta de un manual compartido en el chat (§5.3): título, departamento y línea; abre la página.
// Si el manual no existe o no es visible para mí, no se muestra nada (queda el enlace del mensaje).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { BookOpen, ArrowUpRight } from 'lucide-vue-next';
import Badge from '@/design/Badge.vue';
import { useSession } from '@/stores/session.ts';
import { useDocs } from './store.ts';

const props = defineProps<{ id: string }>();
const { t } = useI18n();
const s = useSession();
const docs = useDocs();
if (s.workspace!.me.role !== 'guest') docs.init();
const node = computed(() => docs.byId(props.id));
const parent = computed(() => docs.trail(props.id).slice(-2, -1)[0]);
</script>

<template>
  <RouterLink v-if="node" :to="`/w/${s.workspace!.slug}/manuals/${node.id}`" class="card">
    <span class="ic"><BookOpen :size="20" /></span>
    <span class="txt">
      <small>{{ t('docs.manual') }} · {{ s.deptName(node.departmentId) }}<template v-if="parent"> › {{ parent.title }}</template></small>
      <b>{{ node.title }}</b>
    </span>
    <Badge v-if="node.lineId" :tone="s.lineTone(node.lineId)">{{ s.lineOf(node.lineId)?.name }}</Badge>
    <ArrowUpRight :size="18" class="go" :aria-label="t('docs.open')" />
  </RouterLink>
</template>

<style scoped>
.card { display: flex; align-items: center; gap: 12px; max-width: 460px; margin-top: 6px; padding: 10px 12px 10px 10px; color: inherit; text-decoration: none; background: var(--color-surface); border-left: 4px solid var(--color-primary); box-shadow: var(--shadow-md); transition: box-shadow var(--duration), transform var(--duration); }
.card:hover { box-shadow: var(--shadow-lg); transform: translateY(-1px); }
.ic { width: 38px; height: 38px; display: grid; place-items: center; flex: none; color: var(--color-ink); background: var(--color-primary-light); }
.txt { flex: 1; min-width: 0; display: grid; }
.txt small { font-size: 12px; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.txt b { font-weight: 600; overflow-wrap: anywhere; }
.go { color: var(--color-muted); }
</style>
