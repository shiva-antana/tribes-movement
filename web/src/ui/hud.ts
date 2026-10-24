import * as THREE from 'three';
import { CALLDOWNS, CalldownDef, PACKS, TEAM_COLORS, WEAPONS } from '../config';
import { SIZE } from '../world/terrain';
import type { Game } from '../game/game';
import type { PlacementCheck } from '../game/build';

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html = '') {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

export class Hud {
  readonly root: HTMLElement;
  private bars: Record<string, HTMLElement> = {};
  private speed: HTMLElement;
  private weapons: HTMLElement;
  private score: HTMLElement;
  private info: HTMLElement;
  private prompt: HTMLElement;
  private warn: HTMLElement;
  private feed: HTMLElement;
  private build: HTMLElement;
  private board: HTMLElement;
  private respawn: HTMLElement;
  private vignette: HTMLElement;
  private mini: HTMLCanvasElement;
  private miniBg: HTMLCanvasElement;
  private windArrow: HTMLElement;
  private hitmark: HTMLElement;
  private timer = 0;
  private terrainVersion = 0;
  private lastBgDraw = -10;
  private buildStatus: { def: CalldownDef; c: PlacementCheck } | null = null;

  constructor(private game: Game) {
    this.root = el('div', 'hud', document.body);
    el('div', 'crosshair', this.root);
    this.hitmark = el('div', 'hitmark', this.root);
    this.vignette = el('div', 'vignette', this.root);

    const status = el('div', 'panel status', this.root);
    for (const [k, label] of [['hp', 'ARMOR'], ['en', 'ENERGY'], ['heat', 'JET HEAT']]) {
      const row = el('div', 'bar-row', status);
      el('span', 'bar-label', row, label);
      const bar = el('div', 'bar ' + k, row);
      this.bars[k] = el('div', 'fill', bar);
      this.bars[k + 'txt'] = el('span', 'bar-val', row);
    }
    this.speed = el('div', 'speed', status);

    this.weapons = el('div', 'panel weapons', this.root);
    this.score = el('div', 'panel score', this.root);
    this.info = el('div', 'panel info', this.root);
    const windBox = el('div', 'wind', this.info);
    this.windArrow = el('div', 'wind-arrow', windBox, '➤');
    this.prompt = el('div', 'prompt', this.root);
    this.warn = el('div', 'warn', this.root);
    this.feed = el('div', 'feed', this.root);
    this.build = el('div', 'panel build hidden', this.root);
    this.board = el('div', 'panel board hidden', this.root);
    this.respawn = el('div', 'respawn hidden', this.root);

    const mapWrap = el('div', 'panel minimap', this.root);
    this.miniBg = document.createElement('canvas');
    this.miniBg.width = this.miniBg.height = 200;
    this.mini = document.createElement('canvas');
    this.mini.width = this.mini.height = 200;
    mapWrap.appendChild(this.mini);
    this.drawMiniBg();
  }

  private drawMiniBg() {
    const g = this.game, ctx = this.miniBg.getContext('2d')!;
    const img = ctx.createImageData(200, 200);
    const sea = g.biome.seaLevel;
    for (let j = 0; j < 200; j++) for (let i = 0; i < 200; i++) {
      const x = (i / 200 - 0.5) * SIZE, z = (j / 200 - 0.5) * SIZE;
      const h = g.terrain.heightAt(x, z);
      const n = g.terrain.normalAt(x, z);
      const shade = 0.55 + 0.45 * (n.x * -0.5 + n.y * 0.6 + n.z * -0.4);
      let r: number, gg: number, b: number;
      if (h < sea) { const d = Math.min(1, (sea - h) / 40); if (g.biome.frozen) { r = 200; gg = 220; b = 235; } else { r = 20; gg = 70 - d * 30; b = 110 - d * 40; } }
      else { const t = Math.min(1, (h - sea) / 250); r = 90 + t * 120; gg = 95 + t * 110; b = 85 + t * 110; }
      const k = (j * 200 + i) * 4;
      img.data[k] = r * shade; img.data[k + 1] = gg * shade; img.data[k + 2] = b * shade; img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  flashDamage(amount: number) {
    this.vignette.style.opacity = String(Math.min(0.8, amount / 40));
    setTimeout(() => (this.vignette.style.opacity = '0'), 120);
  }
  flashHit() {
    this.hitmark.style.opacity = '1';
    setTimeout(() => (this.hitmark.style.opacity = '0'), 100);
  }

  message(text: string, color = '#e0e6ec') {
    const m = el('div', 'msg', this.feed, '');
    m.textContent = text;
    m.style.color = color;
    setTimeout(() => m.classList.add('fade'), 6000);
    setTimeout(() => m.remove(), 7000);
    while (this.feed.children.length > 7) this.feed.firstChild?.remove();
  }

  setBuildStatus(def: CalldownDef, c: PlacementCheck) { this.buildStatus = { def, c }; }
  dispose() { this.root.remove(); }

  update(dt: number) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / 15;
    const g = this.game, p = g.human;
    const a = p.armor;
    const set = (k: string, v: number, max: number, txt?: string) => {
      this.bars[k].style.width = `${Math.max(0, Math.min(1, v / max)) * 100}%`;
      this.bars[k + 'txt'].textContent = txt ?? String(Math.round(v));
    };
    const veh = p.vehicle;
    if (veh) {
      set('hp', veh.hp, veh.def.health);
      set('en', veh.energy, 100);
    } else {
      set('hp', p.health, a.health);
      set('en', p.energy, a.energy);
    }
    set('heat', p.heat, 100, p.overheated ? 'OVERHEAT' : `${Math.round(p.heat)}%`);
    this.bars.heat.parentElement!.classList.toggle('over', p.overheated);
    const cool = p.coolingMult;
    const kmh = Math.round(p.vel.length() * 3.6);
    this.speed.innerHTML = `<b>${kmh}</b> km/h ${p.skiing ? '<span class="tag ski">SKI</span>' : ''}${p.jetting ? '<span class="tag jet">JET</span>' : ''}<span class="tag cool" title="jet cooling">❄ ×${cool.toFixed(1)}</span>`;

    if (veh) {
      this.weapons.innerHTML = `<div class="veh">${veh.def.name}</div><div class="dim">${veh.kind === 'tank' ? 'LMB cannon · A/D steer hull' : veh.kind === 'shrike' ? 'LMB blasters · W throttle · Space boost' : veh.kind === 'transport' ? 'Space up · C down · G deploy station' : 'Space hop · RMB boost'}</div><div class="dim">E to exit</div>`;
    } else {
      this.weapons.innerHTML = p.loadout.weapons.map((w, i) => {
        const d = WEAPONS[w];
        const ammo = d.ammo === Infinity ? '∞' : d.magazine ? `${p.mag[w] ?? 0} / ${p.ammo[w] ?? 0}${i === p.slot && p.reloading > 0 ? ' ⟳' : ''}` : p.mag[w];
        return `<div class="wpn ${i === p.slot ? 'sel' : ''}"><span class="k">${i + 1}</span>${d.name}<span class="ammo">${ammo}</span></div>`;
      }).join('') + `<div class="pack">${PACKS[p.loadout.pack].name}${p.loadout.pack === 'constructor' ? ' — <b>B</b> to build' : p.loadout.pack === 'repair' ? ' — hold <b>F</b>' : ''}</div><div class="dim">${a.name} armor</div>`;
    }

    // Score & flags
    const fs = (t: number) => {
      const f = g.flags[t];
      return f.state === 'home' ? 'home' : f.state === 'carried' ? `taken by ${f.carrier?.name}` : `dropped (${Math.ceil(f.dropTimer)}s)`;
    };
    this.score.innerHTML = [0, 1].map(t => `<div class="team" style="color:${hex(TEAM_COLORS[t])}"><b>${g.teams[t].score}</b> / ${g.captureLimit} ${g.teamName(t)} <span class="dim">flag ${fs(t)}</span></div>`).join('');

    const w = g.env.windAt(p.pos.x, p.pos.y, p.pos.z, new THREE.Vector3());
    const wsp = Math.hypot(w.x, w.z);
    // Arrow is relative to view: screen-up = where you're looking.
    const sy = Math.sin(p.controls.yaw), cy = Math.cos(p.controls.yaw);
    const wr = w.x * cy - w.z * sy, wf = -w.x * sy - w.z * cy;
    const windAng = Math.atan2(-wf, wr);
    this.windArrow.style.transform = `rotate(${windAng}rad)`;
    const wInfo = this.info.querySelector('.txt') ?? el('div', 'txt', this.info);
    wInfo.innerHTML = `<div class="biome">${g.setup.level?.name ?? g.biome.name}</div><div>Materiel <b class="mat">${Math.floor(g.teams[p.team].materiel)}</b> <span class="dim">(+extractors: ${g.structures.filter(s => s.kind === 'extractor' && s.team === p.team && s.alive).length})</span></div><div>Wind <b>${Math.round(wsp)}</b> m/s ${wsp > 25 ? '<span class="tag jet">GALE</span>' : ''}</div>`;

    // Prompts
    this.prompt.textContent = g.contextPrompt();
    this.warn.textContent = g.warning();

    // Build menu
    this.build.classList.toggle('hidden', !g.build.active);
    if (g.build.active) {
      const bs = this.buildStatus;
      this.build.innerHTML = `<div class="title">CALL-DOWN · materiel ${Math.floor(g.teams[p.team].materiel)}</div>` + CALLDOWNS.map((d, i) =>
        `<div class="cd ${i === g.build.selected ? 'sel' : ''} ${g.teams[p.team].materiel < d.cost ? 'poor' : ''}"><span class="k">${d.key}</span>${d.name}<span class="cost">${d.kind === 'road' ? 'by m³' : d.cost}</span></div>`).join('') +
        `<div class="desc">${CALLDOWNS[g.build.selected].desc}</div>` +
        (bs ? `<div class="${bs.c.ok ? 'ok' : 'bad'}">${bs.c.ok ? (bs.c.reason || 'LMB to call down') : bs.c.reason}</div>` : '') +
        `<div class="dim">rotation ${Math.round((g.build.rotation * 180 / Math.PI) % 360)}° · tilt ${['wall', 'ramp', 'floor'][g.build.tiltIndex]}${g.build.freePlace ? ' · FREE' : ''}</div><div class="dim">1-0 / [ ] select · wheel rotate · R tilt · Alt free-place · B close</div>`;
    }

    // Scoreboard
    const showBoard = g.input.down('Tab');
    this.board.classList.toggle('hidden', !showBoard);
    if (showBoard) {
      this.board.innerHTML = [0, 1].map(t => `<div class="col"><div class="title" style="color:${hex(TEAM_COLORS[t])}">${g.teamName(t)} — ${g.teams[t].score}</div>` +
        g.players.filter(q => q.team === t).sort((x, y) => y.kills - x.kills).map(q => `<div class="row ${q === p ? 'me' : ''}"><span>${q.name}</span><span>${q.armor.name}</span><span>${q.kills}/${q.deaths}</span><span>${q.caps}⚑</span></div>`).join('') + '</div>').join('');
    }

    // Respawn
    this.respawn.classList.toggle('hidden', p.alive);
    if (!p.alive) this.respawn.innerHTML = `<div>DESTROYED</div><div class="dim">Redeploying in ${Math.ceil(p.respawnTimer)}… · <b>I</b> to change loadout</div>`;

    this.drawMinimap();
    // Dynamic crosshair: grows with the real spread cone.
    const spreadPx = Math.max(9, Math.tan(p.currentSpread()) / Math.tan((g.camera.fov * Math.PI / 180) / 2) * (innerHeight / 2));
    const ch = this.root.querySelector('.crosshair') as HTMLElement;
    ch.style.width = ch.style.height = `${spreadPx * 2}px`;
    ch.style.margin = `${-spreadPx}px`;
    ch.style.opacity = p.reloading > 0 ? '0.35' : '1';
  }

  private drawMinimap() {
    const g = this.game, ctx = this.mini.getContext('2d')!;
    ctx.drawImage(this.miniBg, 0, 0);
    const toMap = (x: number, z: number) => [(x / SIZE + 0.5) * 200, (z / SIZE + 0.5) * 200];
    if (g.terrain.version !== this.terrainVersion && g.time - this.lastBgDraw > 3) { this.drawMiniBg(); this.terrainVersion = g.terrain.version; this.lastBgDraw = g.time; }
    for (const v of g.terrain.deposits) {
      const [x, y] = toMap(v.x, v.z);
      const r = v.richness > 1 ? 5 : 3;
      ctx.strokeStyle = v.amount > 0 ? '#ffc860' : '#6b6050'; ctx.lineWidth = v.richness > 1 ? 2 : 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      if (v.amount > 0) { ctx.fillStyle = 'rgba(255,200,96,0.7)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r - 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * v.amount / v.max); ctx.fill(); }
    }
    for (const s of g.structures) {
      if (!s.alive || s.kind === 'bunker' || s.kind === 'flagStand') continue;
      const [x, y] = toMap(s.pos.x, s.pos.z);
      ctx.fillStyle = s.disabled ? '#555' : hex(TEAM_COLORS[s.team]);
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    for (const t of [0, 1]) {
      const b = g.terrain.bases[t];
      const [x, y] = toMap(b.x, b.z);
      ctx.strokeStyle = hex(TEAM_COLORS[t]); ctx.lineWidth = 2; ctx.strokeRect(x - 5, y - 5, 10, 10);
    }
    for (const q of g.players) {
      if (!q.alive) continue;
      if (q.team !== g.human.team && !q.flag && q.pos.distanceTo(g.human.pos) > 250) continue; // sensor range
      const [x, y] = toMap(q.pos.x, q.pos.z);
      ctx.fillStyle = q === g.human ? '#fff' : hex(TEAM_COLORS[q.team]);
      ctx.beginPath(); ctx.arc(x, y, q === g.human ? 3 : 2, 0, Math.PI * 2); ctx.fill();
    }
    for (const v of g.vehicles) {
      if (!v.alive) continue;
      const [x, y] = toMap(v.pos.x, v.pos.z);
      ctx.strokeStyle = hex(TEAM_COLORS[v.team]); ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
    }
    for (const f of g.flags) {
      const [x, y] = toMap(f.pos.x, f.pos.z);
      ctx.fillStyle = hex(TEAM_COLORS[f.team]);
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('⚑', x - 4, y + 4);
    }
    // View cone
    const p = g.human;
    const [px, py] = toMap(p.pos.x, p.pos.z);
    const yaw = p.controls.yaw;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - Math.sin(yaw) * 12, py - Math.cos(yaw) * 12); ctx.stroke();
  }
}
