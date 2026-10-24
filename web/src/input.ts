/** Keyboard + pointer-lock mouse state. */
export class Input {
  readonly keys = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  lmb = false;
  rmb = false;
  private lmbPressed = false;
  wheel = 0;
  sensitivity = 0.0022;
  locked = false;

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', e => {
      if (e.code === 'Tab') e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.lmb = this.rmb = false; });
    canvas.addEventListener('mousedown', e => {
      if (!this.locked) return;
      if (e.button === 0) { this.lmb = true; this.lmbPressed = true; }
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener('mouseup', e => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', e => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; });
  }

  lock() { this.canvas.requestPointerLock?.(); }
  unlock() { document.exitPointerLock?.(); }

  down(code: string) { return this.keys.has(code); }
  /** True once per physical key press. */
  hit(code: string) { return this.pressed.has(code); }
  clicked() { return this.lmbPressed; }

  endFrame() {
    this.pressed.clear();
    this.lmbPressed = false;
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
  }
}
