// Paginación en el cliente para listas ya cargadas: devuelve la página visible y vuelve a la primera cuando la
// lista cambia de tamaño (otro filtro); si solo se recarga (mismo tamaño), se queda en la página donde estaba.
import { computed, ref, watch, type Ref } from 'vue';

export function usePaged<T>(list: Ref<T[]>, initialSize = 25) {
  const page = ref(1);
  const size = ref(initialSize);
  watch(() => list.value.length, (n, old) => {
    if (n !== old) page.value = 1;
  });
  const rows = computed(() => list.value.slice((page.value - 1) * size.value, page.value * size.value));
  return { page, size, rows, total: computed(() => list.value.length) };
}
