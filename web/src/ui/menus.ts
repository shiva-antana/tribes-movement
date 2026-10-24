import { ARMORS, ArmorId, PACKS, PackId, VEHICLES, VehicleKind, WEAPONS, WeaponId } from '../config';
import { BIOMES, BiomeId } from '../world/biomes';
import type { Loadout } from '../game/player';

import type { LevelDef } from '../content/level';

export interface MatchSetup { biome: BiomeId; seed: number; teamSize: number; level?: LevelDef; }

function overlay(cls: string) {
  const d = document.createElement('div');
  d.className = 'overlay ' + cls;
  document.body.appendChild(d);
  return d;
}

export function showMainMenu(onStart: (s: MatchSetup) => void, levels: LevelDef[] = []) {
  const o = overlay('main');
  // Selection is either a level id or "random:<biome>".
  let sel = levels[0] ? levels[0].id : 'random:tundra';
  const render = () => {
    o.innerHTML = `
      <div class="menu">
        <h1>VASTLANDS</h1>
        <div class="sub">jetpacks · skiing · spinfusors · capture the flag · call-downs · terraforming</div>
        <div class="section">LEVELS</div>
        <div class="biomes">${levels.map(l => `
          <div class="biome-card ${sel === l.id ? 'sel' : ''}" data-s="${l.id}">
            <div class="bn">${l.name}</div>
            <div class="bd">${l.description}</div>
            <div class="dim">${BIOMES[l.biome].name} · by ${l.author}${l.tags?.length ? ' · ' + l.tags.join(', ') : ''}</div>
          </div>`).join('')}
        </div>
        <div class="section">RANDOM WORLD</div>
        <div class="biomes">${(Object.keys(BIOMES) as BiomeId[]).map(id => `
          <div class="biome-card ${sel === 'random:' + id ? 'sel' : ''}" data-s="random:${id}">
            <div class="bn">${BIOMES[id].name}</div>
            <div class="bd">${BIOMES[id].blurb}</div>
          </div>`).join('')}
        </div>
        <div class="row">
          <label>Seed (random worlds) <input id="seed" type="number" value="${Math.floor(Math.random() * 99999)}"></label>
          <label>Tribe size <select id="ts"><option>4</option><option selected>6</option><option>8</option></select></label>
        </div>
        <button id="go">DEPLOY</button>
        <div class="help">
          <b>WASD</b> move · <b>Space</b> jump, <b>hold</b> to ski · <b>RMB / Shift</b> jetpack · <b>LMB</b> fire · <b>1-5 / Q</b> weapons<br>
          <b>E</b> use station / vehicle · <b>B</b> build (wheel rotate, R tilt, snaps & merges) · <b>F</b> repair & rebuild (Repair pack) · <b>I</b> loadout at base<br>
          <b>V</b> third person · <b>Tab</b> scores · <b>C</b> descend (APC) · <b>G</b> deploy APC station · <b>Esc</b> release mouse<br>
          Nothing heals on its own: blown-out walls stay open until someone rebuilds them, and craters and roads are permanent.
        </div>
      </div>`;
    o.querySelectorAll<HTMLElement>('.biome-card').forEach(c => c.onclick = () => { sel = c.dataset.s!; render(); });
    (o.querySelector('#go') as HTMLButtonElement).onclick = () => {
      const seed = parseInt((o.querySelector('#seed') as HTMLInputElement).value) || 1;
      const ts = parseInt((o.querySelector('#ts') as HTMLSelectElement).value) || 6;
      o.remove();
      const level = levels.find(l => l.id === sel);
      if (level) onStart({ biome: level.biome, seed: level.seed, teamSize: level.teamSize ?? ts, level });
      else onStart({ biome: sel.replace('random:', '') as BiomeId, seed, teamSize: ts });
    };
  };
  render();
}

export function showLoadoutMenu(current: Loadout, onApply: (l: Loadout) => void, onClose: () => void) {
  const o = overlay('loadout');
  const l: Loadout = { armor: current.armor, weapons: [...current.weapons], pack: current.pack };
  const render = () => {
    const a = ARMORS[l.armor];
    l.weapons = l.weapons.filter(w => a.allowed.includes(w)).slice(0, a.weaponSlots);
    o.innerHTML = `
      <div class="menu small">
        <h2>INVENTORY STATION</h2>
        <div class="section">ARMOR</div>
        <div class="opts">${(Object.keys(ARMORS) as ArmorId[]).map(id => {
          const d = ARMORS[id];
          return `<div class="opt ${id === l.armor ? 'sel' : ''}" data-a="${id}"><b>${d.name}</b><span>${d.health} hp · ${d.weaponSlots} weapons · run ${d.runSpeed} m/s · jet ${d.jetAccel}</span></div>`;
        }).join('')}</div>
        <div class="section">WEAPONS (${l.weapons.length}/${a.weaponSlots})</div>
        <div class="opts">${(Object.keys(WEAPONS) as WeaponId[]).map(id => {
          const ok = a.allowed.includes(id);
          return `<div class="opt ${l.weapons.includes(id) ? 'sel' : ''} ${ok ? '' : 'na'}" data-w="${id}"><b>${WEAPONS[id].name}</b><span>${ok ? `${WEAPONS[id].damage} dmg${WEAPONS[id].radius ? ` · ${WEAPONS[id].radius}m splash` : ''}` : 'heavy armor only'}</span></div>`;
        }).join('')}</div>
        <div class="section">PACK</div>
        <div class="opts">${(Object.keys(PACKS) as PackId[]).map(id => `<div class="opt ${id === l.pack ? 'sel' : ''}" data-p="${id}"><b>${PACKS[id].name}</b><span>${PACKS[id].desc}</span></div>`).join('')}</div>
        <div class="row"><button id="apply">EQUIP</button><button id="close" class="ghost">CANCEL</button></div>
      </div>`;
    o.querySelectorAll<HTMLElement>('[data-a]').forEach(e => e.onclick = () => { l.armor = e.dataset.a as ArmorId; render(); });
    o.querySelectorAll<HTMLElement>('[data-w]').forEach(e => e.onclick = () => {
      const w = e.dataset.w as WeaponId;
      if (!ARMORS[l.armor].allowed.includes(w)) return;
      if (l.weapons.includes(w)) l.weapons = l.weapons.filter(x => x !== w);
      else if (l.weapons.length < ARMORS[l.armor].weaponSlots) l.weapons.push(w);
      render();
    });
    o.querySelectorAll<HTMLElement>('[data-p]').forEach(e => e.onclick = () => { l.pack = e.dataset.p as PackId; render(); });
    (o.querySelector('#apply') as HTMLButtonElement).onclick = () => { o.remove(); onApply(l); };
    (o.querySelector('#close') as HTMLButtonElement).onclick = () => { o.remove(); onClose(); };
  };
  render();
  return () => o.remove();
}

export function showVehicleMenu(materiel: number, onBuy: (k: VehicleKind) => void, onClose: () => void) {
  const o = overlay('loadout');
  o.innerHTML = `
    <div class="menu small">
      <h2>VEHICLE STATION</h2>
      <div class="dim">Team materiel: ${Math.floor(materiel)}</div>
      <div class="opts">${(Object.keys(VEHICLES) as VehicleKind[]).map(k => {
        const v = VEHICLES[k];
        return `<div class="opt ${materiel < v.cost ? 'na' : ''}" data-v="${k}"><b>${v.name} — ${v.cost}</b><span>${v.desc}</span></div>`;
      }).join('')}</div>
      <div class="row"><button id="close" class="ghost">CLOSE</button></div>
    </div>`;
  o.querySelectorAll<HTMLElement>('[data-v]').forEach(e => e.onclick = () => {
    const k = e.dataset.v as VehicleKind;
    if (materiel < VEHICLES[k].cost) return;
    o.remove(); onBuy(k);
  });
  (o.querySelector('#close') as HTMLButtonElement).onclick = () => { o.remove(); onClose(); };
}

export function showEndScreen(won: boolean, onAgain: () => void) {
  const o = overlay('main');
  o.innerHTML = `<div class="menu small"><h1>${won ? 'VICTORY' : 'DEFEAT'}</h1><div class="sub">${won ? 'Your tribe holds the Vastlands.' : 'The enemy tribe prevails.'}</div><button id="again">NEW WORLD</button></div>`;
  (o.querySelector('#again') as HTMLButtonElement).onclick = () => { o.remove(); onAgain(); };
}
