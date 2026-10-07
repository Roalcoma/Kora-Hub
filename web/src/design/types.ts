/** `swatch`: muestra de color a la izquierda de la opción (p. ej. un var(--color-cat-*)) */
export type Option<V extends string = string> = { value: V; label: string; hint?: string; swatch?: string };
/** Colores de categoría (espejo de CATEGORY_COLORS del contrato; el design system no depende del contrato) */
export const CATEGORY_TONES = ['green', 'blue', 'purple', 'orange', 'red', 'teal', 'pink', 'gray'] as const;
export type CategoryTone = typeof CATEGORY_TONES[number];
/** Color sólido de una categoría; `bright` para fondos oscuros (sidebar) */
export const toneColor = (tone: CategoryTone | 'neutral', bright = false) =>
  `var(--color-cat-${tone === 'neutral' ? 'gray' : tone}${bright ? '-bright' : ''})`;
export type MenuItem = { label: string; icon?: import('vue').Component; danger?: boolean; action: () => void };
