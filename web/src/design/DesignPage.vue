<script setup lang="ts">
// Página interna /_design: todos los componentes del design system para revisarlos (§13.3 A2).
import { ref } from 'vue';
import { Hash, Pencil, Trash2, Pin, Inbox } from 'lucide-vue-next';
import Button from './Button.vue';
import Input from './Input.vue';
import Textarea from './Textarea.vue';
import Dropdown from './Dropdown.vue';
import Modal from './Modal.vue';
import SlideOver from './SlideOver.vue';
import Tabs from './Tabs.vue';
import Avatar from './Avatar.vue';
import Badge from './Badge.vue';
import Tooltip from './Tooltip.vue';
import EmptyState from './EmptyState.vue';
import Skeleton from './Skeleton.vue';
import ContextMenu from './ContextMenu.vue';
import Kbd from './Kbd.vue';
import { toast } from './toast.ts';
import { CATEGORY_TONES, toneColor, type CategoryTone } from './types.ts';

const text = ref('');
const err = ref('Cliente nuevo');
const color = ref<CategoryTone>('teal');
const toneName: Record<CategoryTone, string> = { green: 'Verde', blue: 'Azul', purple: 'Morado', orange: 'Naranja', red: 'Rojo', teal: 'Turquesa', pink: 'Rosa', gray: 'Gris' };
const colorOptions = CATEGORY_TONES.map((c) => ({ value: c, label: toneName[c], swatch: toneColor(c) }));
const tab = ref<'a' | 'b' | 'c'>('a');
const modal = ref(false);
const slide = ref(false);
const menu = ref(false);
const pos = ref({ x: 0, y: 0 });
const openMenu = (e: MouseEvent) => { pos.value = { x: e.clientX, y: e.clientY }; menu.value = true; };
const colors = ['primary', 'primary-dark', 'primary-light', 'ink', 'ink-soft', 'leaf', 'cta', 'canvas', 'line', 'muted', 'danger', 'warning', 'success', 'presence'];
</script>

<template>
  <div class="page">
    <header><h1>Design system</h1><p>Componentes base de Kora. Esquinas rectas, tokens del CRM, Roboto + Plus Jakarta Sans.</p></header>

    <section><h2>Colores</h2>
      <div class="swatches"><div v-for="c in colors" :key="c" class="sw"><span :style="{ background: `var(--color-${c})` }" /><code>--color-{{ c }}</code></div></div>
    </section>

    <section><h2>Paleta de categorías</h2>
      <p class="note">Ocho colores fijos (<code>CATEGORY_COLORS</code>) para las categorías de cada agencia. Texto sobre el fondo suave en AA; el tono brillante es para los puntos sobre el sidebar marino.</p>
      <div class="cats">
        <div v-for="c in CATEGORY_TONES" :key="c" class="cat">
          <span class="chip" :style="{ background: toneColor(c) }" />
          <div class="cat-txt"><b>{{ toneName[c] }}</b><code>--color-cat-{{ c }}</code></div>
          <Badge :tone="c">{{ toneName[c] }}</Badge>
          <span class="on-dark"><i :style="{ background: toneColor(c, true) }" />{{ toneName[c] }}</span>
        </div>
      </div>
    </section>

    <section><h2>Button</h2>
      <div class="row">
        <Button variant="primary">Publicar anuncio</Button><Button>Cancelar</Button><Button variant="ghost">Lo haré después</Button>
        <Button variant="danger"><Trash2 :size="16" />Eliminar</Button><Button variant="primary" loading>Guardando</Button><Button disabled>Deshabilitado</Button>
        <Button size="sm">Pequeño</Button><Button size="lg" variant="primary">Grande (44 px)</Button>
      </div>
    </section>

    <section><h2>Input · Textarea · Dropdown</h2>
      <div class="cols">
        <Input v-model="text" label="Nombre del proyecto" hint="Como lo conoce el cliente" placeholder="Campaña de otoño" />
        <Input v-model="err" label="Con error" error="Ese nombre ya existe" />
        <Input label="Dirección" prefix="app.agencia-hub.com/w/" model-value="agencia-piloto" />
        <Dropdown v-model="color" label="Color de la categoría" :options="colorOptions" />
        <Textarea label="Notas del reporte" placeholder="Qué salió bien esta semana…" />
      </div>
    </section>

    <section><h2>Tabs</h2>
      <Tabs v-model="tab" :tabs="[{ value: 'a', label: 'Pendientes', count: 6 }, { value: 'b', label: 'Confirmaron', count: 12 }, { value: 'c', label: 'Todos' }]" />
    </section>

    <section><h2>Avatar · Badge · Kbd · Tooltip</h2>
      <div class="row">
        <Avatar name="María López" presence="active" /><Avatar name="Carlos Rivera" presence="away" /><Avatar name="Ana Torres" :size="28" /><Avatar name="José Martínez" :size="48" />
        <Badge tone="primary">3</Badge><Badge>Neutral</Badge><Badge tone="success">110 %</Badge><Badge tone="warning">73 %</Badge><Badge tone="danger">Vencida</Badge>
        <Badge tone="green">Norte</Badge><Badge tone="blue">Sur</Badge><Badge tone="purple">Centro</Badge>
        <span>Buscar <Kbd>Ctrl K</Kbd></span>
        <Tooltip text="Fijar en el canal"><Button size="sm" variant="ghost" aria-label="Fijar"><Pin :size="16" /></Button></Tooltip>
      </div>
    </section>

    <section><h2>Modal · SlideOver · ContextMenu · Toast</h2>
      <div class="row">
        <Button @click="modal = true">Abrir modal</Button><Button @click="slide = true">Abrir panel lateral</Button>
        <Button @contextmenu.prevent="openMenu" @click="openMenu">Menú contextual (clic)</Button>
        <Button @click="toast('Cambios guardados', 'success')">Toast éxito</Button><Button @click="toast('No se pudo enviar el mensaje. Revisa tu conexión.', 'error')">Toast error</Button>
      </div>
      <Modal v-model="modal" title="Crear canal">
        <Input label="Nombre" prefix="#" model-value="ventas-norte" />
        <template #footer><Button @click="modal = false">Cancelar</Button><Button variant="primary" @click="modal = false">Crear</Button></template>
      </Modal>
      <SlideOver v-model="slide" title="Hilo" subtitle="# ventas-norte"><p>Contenido del panel derecho: hilos, perfiles y detalle de tareas.</p></SlideOver>
      <ContextMenu v-model="menu" :x="pos.x" :y="pos.y" :items="[{ label: 'Editar mensaje', icon: Pencil, action: () => toast('Editar') }, { label: 'Fijar', icon: Pin, action: () => toast('Fijado') }, { label: 'Eliminar', icon: Trash2, danger: true, action: () => toast('Eliminado') }]" />
    </section>

    <section><h2>EmptyState · Skeleton</h2>
      <div class="cols">
        <div class="frame"><EmptyState :icon="Inbox" title="Sin tareas pendientes" text="Cuando alguien te asigne una tarea aparecerá aquí."><Button variant="primary"><Hash :size="16" />Ir a un canal</Button></EmptyState></div>
        <div class="frame grid gap-3 p-4"><Skeleton width="40%" /><Skeleton /><Skeleton width="80%" /><Skeleton height="80px" /></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page { max-width: 1100px; margin: 0 auto; padding: 32px 16px 64px; display: grid; gap: 32px; }
header h1 { margin: 0; font-size: 30px; }
header p { margin: 6px 0 0; color: var(--color-muted); }
section { display: grid; gap: 14px; }
h2 { margin: 0; font-size: 18px; padding-bottom: 6px; border-bottom: 1px solid var(--color-line); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; align-items: start; }
.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.sw { display: grid; gap: 6px; font-size: 12px; }
.sw span { height: 44px; border: 1px solid var(--color-line); }
.frame { background: var(--color-surface); border: 1px solid var(--color-line); }
.note { margin: 0; color: var(--color-muted); font-size: 14px; }
.cats { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); grid-auto-rows: 1fr; gap: 10px; }
.cat { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px 12px; padding: 12px 14px; background: var(--color-surface); box-shadow: var(--shadow-sm); }
.chip { width: 34px; height: 34px; grid-row: span 2; box-shadow: var(--shadow-sm); }
.cat-txt { display: grid; min-width: 0; font-size: 13px; }
.cat-txt code { font-size: 11px; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.on-dark { grid-column: 2 / 4; display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 12px; color: var(--color-sidebar-text); background: var(--color-ink); }
.on-dark i { width: 6px; height: 6px; }
</style>
