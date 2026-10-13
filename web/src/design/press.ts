// Respuesta al toque en pantallas táctiles (como una app nativa): una onda sale del punto tocado en botones, enlaces,
// opciones y filas. Un solo listener para toda la app; con mouse no se usa (en la PC basta el hover).
const SEL = 'button, a[href], summary, label, [role="button"], [role="option"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"]';

export function installPress() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.button !== 0) return;
    const el = (e.target as Element).closest<HTMLElement>(SEL);
    if (!el || el.matches(':disabled, [aria-disabled="true"]') || el.closest('[data-no-press]')) return;
    if (el.tagName === 'LABEL' && !el.querySelector('input')) return;
    const r = el.getBoundingClientRect();
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const box = document.createElement('span');
    box.className = 'press-box';
    const wave = document.createElement('span');
    wave.className = 'press-wave';
    const size = Math.hypot(r.width, r.height) * 2;
    wave.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    box.appendChild(wave);
    el.appendChild(box);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      box.classList.add('out');
      setTimeout(() => box.remove(), 350);
    };
    // Al soltar o al convertirse en scroll (pointercancel); si nada llega, se apaga solo
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) el.addEventListener(ev, end, { once: true });
    setTimeout(end, 900);
  }, { passive: true });
}
