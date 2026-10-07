<script setup lang="ts">
// Rama del árbol de manuales (se llama a sí mismo para las subpáginas).
import { ref } from 'vue';
import { ChevronRight, FileText } from 'lucide-vue-next';
import type { DocumentNode } from '@agencia-hub/contracts';
import { useSession } from '@/stores/session.ts';

const props = defineProps<{ items: DocumentNode[]; children: Map<string, DocumentNode[]>; activeId?: string; openIds: Set<string>; depth?: number }>();
const s = useSession();
const toggled = ref(new Set<string>());
// Abierta si el usuario la abrió o si contiene la página activa
const isOpen = (id: string) => toggled.value.has(id) !== props.openIds.has(id);
function toggle(id: string) {
  const next = new Set(toggled.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  toggled.value = next;
}
</script>

<template>
  <ul class="tree" :style="{ '--depth': depth ?? 0 }">
    <li v-for="n in items" :key="n.id">
      <div class="row" :class="{ active: n.id === activeId }">
        <button v-if="children.get(n.id)?.length" type="button" class="tw" :class="{ open: isOpen(n.id) }" :aria-expanded="isOpen(n.id)" :aria-label="n.title" @click="toggle(n.id)"><ChevronRight :size="15" /></button>
        <FileText v-else :size="14" class="ic" />
        <RouterLink :to="`/w/${s.workspace!.slug}/manuals/${n.id}`" class="lnk">{{ n.title }}</RouterLink>
        <span v-if="n.lineId" class="line" :class="s.lineTone(n.lineId)" :title="s.lineOf(n.lineId)?.name" />
      </div>
      <DocTree v-if="children.get(n.id)?.length && isOpen(n.id)" :items="children.get(n.id)!" :children="children" :active-id="activeId" :open-ids="openIds" :depth="(depth ?? 0) + 1" />
    </li>
  </ul>
</template>

<style scoped>
.tree { list-style: none; margin: 0; padding: 0; }
.row { position: relative; display: flex; align-items: center; gap: 4px; min-height: 34px; padding: 0 10px 0 calc(10px + var(--depth) * 16px); transition: background var(--duration); }
.row:hover { background: var(--color-canvas); }
.row.active { background: var(--color-surface); box-shadow: var(--shadow-md); z-index: 1; }
.row.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--color-primary); }
.row.active .lnk { font-weight: 600; color: var(--color-ink); }
.tw { width: 22px; height: 22px; display: grid; place-items: center; flex: none; color: var(--color-muted); background: none; border: 0; cursor: pointer; transition: transform var(--duration); }
.tw.open { transform: rotate(90deg); }
.ic { width: 22px; color: var(--color-line-strong); }
.lnk { flex: 1; min-width: 0; padding: 6px 0; font-size: 14px; color: var(--color-ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line { width: 6px; height: 6px; flex: none; background: var(--color-line-strong); }
.line.salud { background: var(--color-success); }
.line.vida { background: var(--color-leaf); }
.line.medicare { background: #5B4B8A; }
@media (max-width: 767px) { .row { min-height: var(--tap); } .lnk { font-size: 16px; } }
</style>
