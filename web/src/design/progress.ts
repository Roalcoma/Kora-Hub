// Barra de progreso superior (TopProgress): se enciende si una pantalla o una petición tarda más de 150 ms, para no
// parpadear en lo instantáneo. Dos fuentes: la navegación del router y las peticiones a la API en curso.
import { computed, ref } from 'vue';

const navigating = ref(false);
const requests = ref(0);
const shown = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
const pending = computed(() => navigating.value || requests.value > 0);

function update() {
  if (pending.value && !timer && !shown.value) timer = setTimeout(() => { timer = undefined; shown.value = pending.value; }, 150);
  if (!pending.value) { clearTimeout(timer); timer = undefined; shown.value = false; }
}
export const progressVisible = computed(() => shown.value);
export const setNavigating = (v: boolean) => { navigating.value = v; update(); };
export function trackRequest<T>(p: Promise<T>): Promise<T> {
  requests.value++;
  update();
  return p.finally(() => { requests.value--; update(); });
}
