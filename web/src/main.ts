import * as THREE from 'three';
import { Game } from './game/game';
import { Input } from './input';
import { Audio } from './audio';
import { showMainMenu, showEndScreen, MatchSetup } from './ui/menus';
import { LEVELS } from './content/catalog';

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const input = new Input(renderer.domElement);
const audio = new Audio();
let game: Game | null = null;

const lockHint = document.createElement('div');
lockHint.className = 'lockhint hidden';
lockHint.textContent = 'Click to resume';
document.body.appendChild(lockHint);

function start(setup: MatchSetup) {
  audio.start();
  game?.dispose();
  game = new Game(setup, renderer, input, audio, won => {
    showEndScreen(won, () => { game?.dispose(); game = null; showMainMenu(start, LEVELS); });
  });
  (window as any).game = game; // handy for debugging in the console
  input.lock();
}

renderer.domElement.addEventListener('click', () => { if (game && !game.menuOpen && !game.over) input.lock(); });
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); game?.resize(innerWidth, innerHeight); });

let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (game) {
    game.frame(dt);
    renderer.render(game.scene, game.camera);
    lockHint.classList.toggle('hidden', input.locked || game.menuOpen || game.over);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

(window as any).startMatch = (s: MatchSetup) => { document.querySelectorAll(".overlay").forEach(o => o.remove()); start(s); };
showMainMenu(start, LEVELS);
