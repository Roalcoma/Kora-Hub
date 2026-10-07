<script setup lang="ts">
// Tendencia semanal de una meta: una columna por semana (logrado) y una marca del objetivo de esa semana.
// Una sola serie: sin leyenda (el título de la tarjeta la nombra). Hover con tooltip; las semanas sin reporte
// se ven como un trazo rayado en la base. Esquinas rectas por el design system (radio 0).
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

type Point = { weekStart: string; target: number; actual: number | null };
const props = defineProps<{ series: Point[]; unit: string }>();
const { t, d } = useI18n();

const W = 300, H = 92, PAD_T = 8, PAD_B = 4;
const max = computed(() => Math.max(1, ...props.series.flatMap((p) => [p.target, p.actual ?? 0])) * 1.08);
const slot = computed(() => W / props.series.length);
const bw = computed(() => Math.min(18, slot.value - 2));      // columnas finas; el resto del espacio es aire
const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / max.value);
const x = (i: number) => i * slot.value + (slot.value - bw.value) / 2;

const hover = ref<number | null>(null);
const cur = computed(() => (hover.value === null ? null : props.series[hover.value]!));
const pct = (p: Point) => (p.actual === null ? null : Math.round((p.actual / p.target) * 100));
const week = (w: string) => d(new Date(`${w}T12:00:00`), 'day');
const fmt = (n: number) => n.toLocaleString();
</script>

<template>
  <div class="chart" @mouseleave="hover = null">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="t('goals.trendLabel', { n: series.length })">
      <line :x1="0" :x2="W" :y1="H - PAD_B" :y2="H - PAD_B" class="base" />
      <g v-for="(p, i) in series" :key="p.weekStart">
        <rect v-if="p.actual !== null" :x="x(i)" :y="y(p.actual)" :width="bw" :height="Math.max(1, H - PAD_B - y(p.actual))"
          class="bar" :class="{ last: i === series.length - 1, dim: hover !== null && hover !== i }" />
        <rect v-else :x="x(i)" :y="H - PAD_B - 6" :width="bw" height="6" class="missing" />
        <line :x1="x(i) - 2" :x2="x(i) + bw + 2" :y1="y(p.target)" :y2="y(p.target)" class="target" />
        <!-- zona de hover: toda la franja de la semana, encima de las marcas -->
        <rect :x="i * slot" y="0" :width="slot" :height="H" class="hit" @mouseenter="hover = i" />
      </g>
      <defs>
        <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" class="hatch" />
        </pattern>
      </defs>
    </svg>
    <div v-if="cur" class="tip" :style="{ left: `${Math.min(80, Math.max(20, ((hover! + 0.5) / series.length) * 100))}%` }">
      <b>{{ t('goals.weekOf', { date: week(cur.weekStart) }) }}</b>
      <span v-if="cur.actual !== null">{{ fmt(cur.actual) }} / {{ fmt(cur.target) }} {{ unit }} · {{ pct(cur) }}%</span>
      <span v-else>{{ t('goals.noReport') }} · {{ t('goals.target') }} {{ fmt(cur.target) }}</span>
    </div>
    <div class="axis"><span>{{ week(series[0]!.weekStart) }}</span><span>{{ t('goals.thisWeek') }}</span></div>
  </div>
</template>

<style scoped>
.chart { position: relative; }
svg { display: block; width: 100%; height: 92px; overflow: visible; }
.base { stroke: var(--color-line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.hit { fill: transparent; cursor: default; }
.bar { fill: var(--color-leaf); transition: opacity var(--duration); }
.bar.last { fill: var(--color-ink); }
.bar.dim { opacity: .45; }
.missing { fill: url(#hatch); }
.hatch { stroke: var(--color-line-strong); stroke-width: 2; }
.target { stroke: var(--color-muted); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.tip { position: absolute; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 5; display: grid; gap: 1px; padding: 6px 9px; font-size: 12px; white-space: nowrap; color: #fff; background: var(--color-ink); box-shadow: var(--shadow-lg); pointer-events: none; font-variant-numeric: tabular-nums; }
.axis { display: flex; justify-content: space-between; margin-top: 4px; font-size: 11px; color: var(--color-muted); }
</style>
