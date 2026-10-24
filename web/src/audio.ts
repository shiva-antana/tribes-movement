import * as THREE from 'three';

/** Fully synthesized audio — wind, jets, skis, weapons. No sample assets. */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private wind!: { gain: GainNode; filter: BiquadFilterNode };
  private jet!: { gain: GainNode; filter: BiquadFilterNode };
  private ski!: { gain: GainNode; filter: BiquadFilterNode };
  listener = new THREE.Vector3();

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    // Brown-ish noise: more body for wind.
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.04 * w) / 1.04; d[i] = last * 3.5 + w * 0.15; }
    this.wind = this.loop('bandpass', 400, 0.6);
    this.jet = this.loop('lowpass', 900, 1);
    this.ski = this.loop('highpass', 2500, 1);
  }

  private loop(type: BiquadFilterType, freq: number, q: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    return { gain, filter };
  }

  /** Continuous sounds driven by the local player each frame. */
  setAmbient(windSpeed: number, jetting: boolean, skiSpeed: number, underwater: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const w = Math.min(1, windSpeed / 40);
    this.wind.gain.gain.setTargetAtTime(underwater ? 0.02 : 0.05 + w * 0.35, t, 0.3);
    this.wind.filter.frequency.setTargetAtTime(underwater ? 200 : 250 + w * 700, t, 0.5);
    this.jet.gain.gain.setTargetAtTime(jetting ? 0.35 : 0, t, 0.05);
    this.ski.gain.gain.setTargetAtTime(Math.min(0.18, skiSpeed / 300), t, 0.1);
  }

  private atten(at?: THREE.Vector3) {
    if (!at) return 1;
    const d = at.distanceTo(this.listener);
    return Math.max(0, 1 / (1 + d * 0.015) - 0.02);
  }
  /** Sound travels at ~343 m/s: distant shots and blasts arrive late (you see the flash first). */
  private when(at?: THREE.Vector3) {
    return this.ctx!.currentTime + (at ? at.distanceTo(this.listener) / 343 : 0);
  }

  private burst(dur: number, freq: number, type: BiquadFilterType, vol: number, at?: THREE.Vector3, sweep = 1) {
    if (!this.ctx) return;
    const a = this.atten(at) * vol;
    if (a < 0.01) return;
    const ctx = this.ctx, t = this.when(at);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  private tone(dur: number, f0: number, f1: number, type: OscillatorType, vol: number, at?: THREE.Vector3) {
    if (!this.ctx) return;
    const a = this.atten(at) * vol;
    if (a < 0.01) return;
    const ctx = this.ctx, t = this.when(at);
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }

  shot(at: THREE.Vector3, kind: string, local = false) {
    const v = local ? 1 : 0.8;
    switch (kind) {
      case 'spinfusor': this.tone(0.35, 900, 180, 'sawtooth', 0.12 * v, at); this.burst(0.2, 1800, 'bandpass', 0.25 * v, at, 0.3); break;
      case 'grenade': this.tone(0.12, 220, 90, 'square', 0.15 * v, at); this.burst(0.1, 600, 'lowpass', 0.3 * v, at); break;
      case 'chaingun': this.burst(0.05, 3000, 'bandpass', 0.18 * v, at, 0.5); break;
      case 'mortar': this.tone(0.5, 160, 40, 'sawtooth', 0.25 * v, at); this.burst(0.3, 400, 'lowpass', 0.4 * v, at); break;
      case 'blaster': this.tone(0.15, 1400, 300, 'square', 0.08 * v, at); break;
      case 'turret': this.tone(0.25, 700, 200, 'triangle', 0.2, at); break;
      case 'flak': this.burst(0.15, 1200, 'bandpass', 0.3, at, 0.4); break;
    }
  }
  explosion(at: THREE.Vector3, size = 1) { this.burst(0.9 * size, 900, 'lowpass', 0.9 * Math.min(1.5, size), at, 0.08); this.tone(0.6, 90, 30, 'sine', 0.5 * size, at); }
  bounce(at: THREE.Vector3) { this.tone(0.05, 500, 300, 'square', 0.06, at); }
  hit() { this.tone(0.06, 1800, 1500, 'sine', 0.12); }
  /** Bright metallic ding for head hits. */
  headshot() { this.tone(0.12, 3200, 2600, 'triangle', 0.16); this.tone(0.2, 4800, 4400, 'sine', 0.06); }
  /** Kill confirm: a two-note chime that climbs with the multi-kill count. */
  kill(multi = 1) {
    const base = 880 * Math.pow(1.122, Math.min(4, multi) - 1);
    this.tone(0.09, base, base, 'triangle', 0.18);
    setTimeout(() => this.tone(0.16, base * 1.5, base * 1.5, 'triangle', 0.16), 70);
  }
  incoming(at: THREE.Vector3) { this.tone(2.2, 2400, 200, 'sine', 0.15, at); }
  beam() { this.tone(0.8, 200, 2400, 'sine', 0.2); }
  click() { this.tone(0.05, 900, 900, 'square', 0.05); }
  error() { this.tone(0.15, 200, 150, 'square', 0.08); }
  overheat() { this.burst(0.6, 5000, 'highpass', 0.3, undefined, 0.5); this.tone(0.4, 400, 200, 'square', 0.08); }
  alert(good: boolean, big = false) {
    const base = good ? 660 : 330;
    this.tone(0.25, base, base, 'triangle', 0.18);
    setTimeout(() => this.tone(0.3, base * (good ? 1.5 : 0.75), base * (good ? 1.5 : 0.75), 'triangle', 0.18), 180);
    if (big) setTimeout(() => this.tone(0.6, base * 2, base * 2, 'triangle', 0.2), 400);
  }
}
