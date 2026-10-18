// Keyboard + mouse state. Keys are tracked by KeyboardEvent.code so layouts (Hebrew included)
// do not change the controls.
export function createInput(dom) {
  const down = new Set();
  const pressed = new Set();
  const state = {
    down, pressed,
    dragDX: 0, dragDY: 0, wheel: 0, dragging: false, lastDragTime: -1e9,
    isDown(...codes) { return codes.some((c) => down.has(c)); },
    wasPressed(...codes) { return codes.some((c) => pressed.has(c)); },
    axis() {
      const f = (this.isDown('KeyW', 'ArrowUp') ? 1 : 0) - (this.isDown('KeyS', 'ArrowDown') ? 1 : 0);
      const r = (this.isDown('KeyD', 'ArrowRight') ? 1 : 0) - (this.isDown('KeyA', 'ArrowLeft') ? 1 : 0);
      return { f, r };
    },
    // Called once per frame after everyone has read this frame's edges and deltas.
    endFrame() { pressed.clear(); this.dragDX = 0; this.dragDY = 0; this.wheel = 0; },
  };

  const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  window.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (!e.repeat && !down.has(e.code)) pressed.add(e.code);
    down.add(e.code);
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => down.clear());

  let lx = 0, ly = 0;
  dom.addEventListener('pointerdown', (e) => {
    state.dragging = true; lx = e.clientX; ly = e.clientY;
    try { dom.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events have no capture */ }
    dom.focus();
  });
  dom.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    state.dragDX += e.clientX - lx; state.dragDY += e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    state.lastDragTime = performance.now();
  });
  const up = () => { state.dragging = false; };
  dom.addEventListener('pointerup', up);
  dom.addEventListener('pointercancel', up);
  dom.addEventListener('wheel', (e) => { e.preventDefault(); state.wheel += e.deltaY; }, { passive: false });
  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  return state;
}
