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

const text = ref('');
const err = ref('Póliza');
const line = ref<'all' | 'salud' | 'vida' | 'medicare'>('vida');
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

    <section><h2>Button</h2>
      <div class="row">
        <Button variant="primary">Publicar anuncio</Button><Button>Cancelar</Button><Button variant="ghost">Lo haré después</Button>
        <Button variant="danger"><Trash2 :size="16" />Eliminar</Button><Button variant="primary" loading>Guardando</Button><Button disabled>Deshabilitado</Button>
        <Button size="sm">Pequeño</Button><Button size="lg" variant="primary">Grande (44 px)</Button>
      </div>
    </section>

    <section><h2>Input · Textarea · Dropdown</h2>
      <div class="cols">
        <Input v-model="text" label="Nombre de la póliza" hint="Como aparece en la aseguradora" placeholder="Term Life 20" />
        <Input v-model="err" label="Con error" error="Ese nombre ya existe" />
        <Input label="Dirección" prefix="app.agencia-hub.com/w/" model-value="agencia-piloto" />
        <Dropdown v-model="line" label="Línea de negocio" :options="[{ value: 'all', label: 'Todas' }, { value: 'salud', label: 'Salud', hint: 'ACA y grupales' }, { value: 'vida', label: 'Vida' }, { value: 'medicare', label: 'Medicare', hint: 'Advantage y suplementos' }]" />
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
        <Badge tone="salud">Salud</Badge><Badge tone="vida">Vida</Badge><Badge tone="medicare">Medicare</Badge>
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
        <Input label="Nombre" prefix="#" model-value="ventas-vida" />
        <template #footer><Button @click="modal = false">Cancelar</Button><Button variant="primary" @click="modal = false">Crear</Button></template>
      </Modal>
      <SlideOver v-model="slide" title="Hilo" subtitle="# ventas-vida"><p>Contenido del panel derecho: hilos, perfiles y detalle de tareas.</p></SlideOver>
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
</style>
