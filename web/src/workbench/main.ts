// Asset workbench: inspect skeletons and motions, build characters, paint materials, export GLB.
// Everything here is also scriptable through window.workbench (for agents driving a browser).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { SKELETONS, MOTIONS, CHARACTERS, MATERIALS } from '../content/assets';
import { buildCharacter, atlasRegions, BuildResult, CharacterDef } from '../character/builder';
import { fitHead, buildHeadPreview, applyKnobs, maskToDataURL, FitProgress, HEAD_KNOBS } from './headfit';
import { resampleMask } from './reference';
import { bakeMaterial, MaterialDef, Baked, Layer } from '../paint/painter';
import { characterMaterials, addOutline, updatePbr } from '../character/runtime';
import { toClip } from '../anim/motion';
import { buildSkeleton } from '../anim/skeleton';
import { analyzeMotion } from '../anim/analyze';
import { SpringRig } from '../character/springs';
import { extractFace, FaceRig, applyFace, EXPRESSION_NAMES } from '../character/face';
import { ReferenceView, RefMode, RefFit, RefView } from './reference';

// ---------------------------------------------------------------- scene
const view = document.getElementById('view')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a222b);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
camera.position.set(2.4, 1.6, -3.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
sun.position.set(3, 6, -2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 3, bottom: -1 });
scene.add(sun, new THREE.HemisphereLight(0xbcd4ff, 0x30281e, 0.5));
const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.MeshStandardMaterial({ color: 0x2a323c, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
// Reference models / images (drop files on the view, or use the panel / window.workbench.loadReference).
const refView = new ReferenceView(scene, renderer, () => built?.mesh ?? null);
// Original Tribes shapes exported locally by `npm run tribes -- meshes` (dev server only; absent elsewhere).
let tribesShapes: { id: string; tris: number; height: number }[] = [];
fetch('/local-reference/meshes/index.json').then(r => r.ok ? r.json() : []).then(j => { tribesShapes = j; renderPanel(); }).catch(() => {});
// Treadmill grid: scrolls at the motion's authored speed so planted feet visibly stay planted.
const grid = new THREE.GridHelper(8, 32, 0x4b5a6a, 0x34404c);
grid.position.y = 0.002;
scene.add(grid);

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- state
/** The character being edited: a fitted/edited copy if one exists, else the content definition. */
const charDef = (): CharacterDef => S.charEdits[S.character] ?? CHARACTERS[S.character];
const S = {
  charEdits: {} as Record<string, CharacterDef>,
  character: Object.keys(CHARACTERS).includes('scout') ? 'scout' : Object.keys(CHARACTERS)[0],
  motion: Object.keys(MOTIONS).includes('run') ? 'run' : Object.keys(MOTIONS)[0],
  team: 0x4aa3ff,
  playing: true,
  speed: 1,
  skeleton: false,
  wire: false,
  hq: false,
  springs: true,
  autoBlink: true,
  expressions: {} as Record<string, number>,
  paint: { on: false, color: '#c83a2a', radius: 0.008, height: 0.06, emissive: false },
  edits: {} as Record<string, MaterialDef>, // edited copies of materials (strokes appended)
};
const mat = (id: string) => (S.edits[id] ??= JSON.parse(JSON.stringify(MATERIALS[id])) as MaterialDef);

let built: BuildResult | null = null;
let bakedBody: Baked | null = null, bakedArmor: Baked | null = null, bakedHair: Baked | null = null;
let mixer: THREE.AnimationMixer | null = null;
let clips: THREE.AnimationClip[] = [];
let helper: THREE.SkeletonHelper | null = null;
let springs: SpringRig | null = null;
let face: FaceRig | null = null;
const footMarkers = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0x7dffb2 })); scene.add(m); return m; });

function bake(id: string, target: 'body' | 'armor') {
  const def = mat(id);
  const sk = SKELETONS[charDef().skeleton];
  const size = target === 'body' ? (S.hq ? 1024 : 512) : 512;
  const regions = target === 'body' ? atlasRegions(sk) : undefined;
  // Toon heroes draw their face decals in the shader (expressions), so they're left out of the bake.
  return bakeMaterial(faceSplit(def, regions).base, { size, teamColor: S.team, regions });
}
function faceSplit(def: MaterialDef, regions?: ReturnType<typeof atlasRegions>) {
  return charDef().style === 'toon' ? extractFace(def, regions) : { base: def, face: null };
}

function rebuild() {
  const def = charDef();
  const sk = SKELETONS[def.skeleton];
  if (built) { scene.remove(built.mesh); built.mesh.geometry.dispose(); }
  if (helper) { scene.remove(helper); helper = null; }
  bakedBody = bake(def.materials.body, 'body');
  bakedArmor = bake(def.materials.armor, 'armor');
  bakedHair = def.materials.hair ? bakeMaterial(mat(def.materials.hair), { size: 256, teamColor: S.team }) : null;
  const mats = characterMaterials(def.style, { body: bakedBody, armor: bakedArmor, hair: bakedHair }, S.team);
  const fd = faceSplit(mat(def.materials.body), atlasRegions(sk)).face;
  face = fd ? new FaceRig() : null;
  if (face && fd) {
    applyFace(mats[0], fd, face.params);
    face.autoBlink = S.autoBlink;
    for (const [n, w] of Object.entries(S.expressions)) face.set(n, w);
  }
  built = buildCharacter(def, sk, { bodyHeight: bakedBody, materials: mats });
  if (def.style === 'toon') addOutline(built.mesh, def.outline ?? 0.006);
  built.mesh.castShadow = true;
  scene.add(built.mesh);
  springs = new SpringRig(built.mesh, built.springs);
  springs.enabled = S.springs;
  for (const m of built.mesh.material as THREE.MeshStandardMaterial[]) m.wireframe = S.wire;
  helper = new THREE.SkeletonHelper(built.mesh);
  helper.visible = S.skeleton;
  scene.add(helper);
  mixer = new THREE.AnimationMixer(built.mesh);
  clips = Object.values(MOTIONS).filter(m => m.skeleton === def.skeleton).map(m => toClip(m, built!.skeleton));
  playMotion();
  renderPanel();
  drawMaps();
}

function playMotion() {
  if (!mixer || !built) return;
  mixer.stopAllAction();
  springs?.reset();
  const clip = clips.find(c => c.name === S.motion);
  if (clip) mixer.clipAction(clip).play();
}

function rebakeAndApply(target: 'body' | 'armor') {
  if (!built) return;
  const def = charDef();
  const mats = built.mesh.material as THREE.MeshStandardMaterial[];
  if (target === 'body') { bakedBody = bake(def.materials.body, 'body'); updatePbr(mats[0], bakedBody, false); }
  else { bakedArmor = bake(def.materials.armor, 'armor'); updatePbr(mats[1], bakedArmor, true); }
  drawMaps();
  const ta = document.getElementById('json') as HTMLTextAreaElement | null;
  if (ta) ta.value = JSON.stringify(mat(target === 'body' ? def.materials.body : def.materials.armor), null, 1);
}

// ---------------------------------------------------------------- painting
const ray = new THREE.Raycaster();
let stroke: { target: 'body' | 'armor'; layer: Extract<Layer, { type: 'stroke' }> } | null = null;
let lastBake = 0;
function pick(ev: PointerEvent) {
  if (!built) return null;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObject(built.mesh)[0];
  if (!hit?.uv || !hit.face) return null;
  const target: 'body' | 'armor' | null = hit.face.materialIndex === 0 ? 'body' : hit.face.materialIndex === 1 ? 'armor' : null;
  if (!target) return null;
  let u = hit.uv.x, v = hit.uv.y;
  if (target === 'armor') { u -= Math.floor(u); v -= Math.floor(v); }
  // DataTextures aren't flipped: texture row 0 is v = 0, matching the painter's layout.
  return { target, uv: [+u.toFixed(4), +v.toFixed(4)] as [number, number] };
}
renderer.domElement.addEventListener('pointerdown', ev => {
  if (!S.paint.on || ev.button !== 0) return;
  const p = pick(ev);
  if (!p) return;
  controls.enabled = false;
  const def = charDef();
  const layer: Extract<Layer, { type: 'stroke' }> = { type: 'stroke', points: [p.uv], radius: S.paint.radius * (p.target === 'armor' ? 3 : 1), color: S.paint.color, height: S.paint.height, hardness: 0.5 };
  if (S.paint.emissive) layer.emissive = S.paint.color;
  mat(p.target === 'body' ? def.materials.body : def.materials.armor).layers.push(layer);
  stroke = { target: p.target, layer };
  rebakeAndApply(p.target);
});
renderer.domElement.addEventListener('pointermove', ev => {
  if (!stroke) return;
  const p = pick(ev);
  if (!p || p.target !== stroke.target) return;
  const last = stroke.layer.points[stroke.layer.points.length - 1];
  if (Math.hypot(p.uv[0] - last[0], p.uv[1] - last[1]) > 0.15) return; // jumped across an atlas seam
  stroke.layer.points.push(p.uv);
  if (performance.now() - lastBake > 120) { lastBake = performance.now(); rebakeAndApply(stroke.target); }
});
addEventListener('pointerup', () => { if (stroke) { rebakeAndApply(stroke.target); stroke = null; } controls.enabled = true; });

// ---------------------------------------------------------------- export
async function exportGLB(download = true): Promise<ArrayBuffer | null> {
  if (!built) return null;
  const glb = await new GLTFExporter().parseAsync(built.mesh, { binary: true, animations: clips }) as ArrayBuffer;
  if (download) dl(new Blob([glb], { type: 'model/gltf-binary' }), `${S.character}.glb`);
  return glb;
}
function dl(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- panel
const side = document.getElementById('side')!;
const opt = (ids: string[], sel: string) => ids.map(i => `<option ${i === sel ? 'selected' : ''}>${i}</option>`).join('');
function renderPanel() {
  const def = charDef();
  const m = MOTIONS[S.motion];
  const report = m ? analyzeMotion(buildSkeleton(SKELETONS[m.skeleton]), m) : null;
  const st = built?.stats;
  side.innerHTML = `
    <h1>VASTLANDS WORKBENCH</h1>
    <div class="dim">Skeleton → motion → character → paint → GLB. Content lives in <code>web/content/</code>.</div>
    <div class="sec">CHARACTER</div>
    <label><select id="ch">${opt(Object.keys(CHARACTERS), S.character)}</select><input id="team" type="color" value="#${S.team.toString(16).padStart(6, '0')}"></label>
    <div class="dim">${def.description ?? ''}</div>
    ${st ? `<pre>${st.triangles.toLocaleString()} tris (body ${st.bodyTriangles.toLocaleString()} · armor ${st.armorTriangles.toLocaleString()})
${st.vertices.toLocaleString()} verts · ${st.bones} bones · ≤${st.maxInfluences} influences
weight error ${st.weightError} · built in ${st.ms} ms
textures: body ${bakedBody?.size}² (${bakedBody?.ms} ms) · armor ${bakedArmor?.size}² (${bakedArmor?.ms} ms)</pre>` : ''}
    <label><input type="checkbox" id="hq" ${S.hq ? 'checked' : ''}> 1024² body texture</label>
    <div class="sec">MOTION</div>
    <label><select id="mo">${opt(Object.keys(MOTIONS), S.motion)}</select></label>
    <label>speed <input id="spd" type="range" min="0" max="2" step="0.05" value="${S.speed}"></label>
    <label>scrub <input id="scrub" type="range" min="0" max="1" step="0.001" value="0"></label>
    <div>
      <button id="play" class="${S.playing ? 'on' : 'ghost'}">${S.playing ? 'Pause' : 'Play'}</button>
      <button id="skel" class="${S.skeleton ? 'on' : 'ghost'}">Skeleton</button>
      <button id="wire" class="${S.wire ? 'on' : 'ghost'}">Wireframe</button>
    </div>
    ${report ? `<pre class="${report.ok ? 'ok' : 'bad'}">${report.ok ? '✓ clean' : '✗ ' + report.issues.join('\n✗ ')}
stride ${report.strideLength} m · cadence ${report.cadence}/min · symmetry ${report.symmetry}
foot slide ${Object.values(report.footSlide).map(s => s.mean).join(' / ')} m/s · loop seam ${report.loopSeam}°</pre>` : ''}
    ${built?.springs.chains.length ? `<div><button id="spr" class="${S.springs ? 'on' : 'ghost'}">Spring bones (${built.springs.chains.length})</button></div>` : ''}
    ${face ? `<div class="sec">FACE (VRM expressions)</div>
    <div><button id="blink" class="${S.autoBlink ? 'on' : 'ghost'}">Auto-blink</button><button id="fcam" class="ghost">Face cam</button><button id="fclr" class="ghost">Neutral</button></div>
    ${EXPRESSION_NAMES.map(n => `<label>${n} <input class="expr" data-n="${n}" type="range" min="0" max="1" step="0.05" value="${S.expressions[n] ?? 0}"></label>`).join('')}` : ''}
    <div class="sec">PAINT (click-drag on the model)</div>
    <div><button id="pnt" class="${S.paint.on ? 'on' : 'ghost'}">${S.paint.on ? 'Painting…' : 'Paint mode'}</button>
      <input id="pcol" type="color" value="${S.paint.color}"> <label style="display:inline-flex"><input id="pem" type="checkbox" ${S.paint.emissive ? 'checked' : ''}> glow</label></div>
    <label>radius <input id="prad" type="range" min="0.002" max="0.03" step="0.001" value="${S.paint.radius}"></label>
    <label>height <input id="phei" type="range" min="-0.3" max="0.3" step="0.01" value="${S.paint.height}"></label>
    <div class="maps" id="maps"></div>
    <div class="sec">MATERIAL JSON (body: ${def.materials.body}) — edit and apply</div>
    <textarea id="json">${JSON.stringify(mat(def.materials.body), null, 1)}</textarea>
    <div><button id="apply">Apply</button><button id="undo" class="ghost">Undo stroke</button><button id="savej" class="ghost">Download JSON</button></div>
    <div class="sec">REFERENCE (drop a model or image on the view)</div>
    <div><input id="rfile" type="file" accept=".glb,.gltf,.vrm,.obj,.fbx,.png,.jpg,.jpeg,.webp" style="width:100%">
      <label>image shows <select id="rview"><option value="front">front</option><option value="side">side</option></select>
      fit <select id="rfit"><option value="body" ${refView.fit === 'body' ? 'selected' : ''}>body</option><option value="head" ${refView.fit === 'head' ? 'selected' : ''}>head</option></select></label></div>
    ${tribesShapes.length ? `<label>Tribes shape (local) <select id="rtribes"><option value="">—</option>${tribesShapes.map(t => `<option value="${t.id}">${t.id} · ${t.tris} tris · ${t.height} m</option>`).join('')}</select></label>` : ''}
    <div><button id="rside" class="${refView.mode === 'side' ? 'on' : 'ghost'}">Side by side</button><button id="rover" class="${refView.mode === 'overlay' ? 'on' : 'ghost'}">Overlay</button><button id="rhide" class="${refView.mode === 'hidden' ? 'on' : 'ghost'}">Hide</button><button id="rturn" class="ghost">Turn 180°</button></div>
    <label>opacity <input id="ropa" type="range" min="0.1" max="1" step="0.05" value="${refView.opacity}"></label>
    <div><button id="rscore" class="ghost">Silhouette score</button><button id="rclear" class="ghost">Clear</button></div>
    <pre id="rinfo">${[refView.model ? `model: ${refView.model.name}` : '', ...refView.images.map(i => `${i.view} image: ${i.name}`)].filter(Boolean).join('\n') || 'no reference loaded'}</pre>
    <div class="sec">AUTO-FIT HEAD TO REFERENCE</div>
    <div class="dim">Load front and/or side head images (fit: head), then fit. The skull, jaw, chin, cheeks, nose, neck and hair change until the silhouettes match.</div>
    <div><button id="hfit" class="${fitRunning ? 'on' : ''}">${fitRunning ? 'Stop fit' : 'Auto-fit head'}</button><button id="hsyn" class="ghost">Synthetic test reference</button></div>
    <pre id="hlog">${fitLog || 'idle'}</pre>
    <div><button id="happly" class="ghost" ${fitResult ? '' : 'disabled'}>Apply fitted head</button><button id="hjson" class="ghost" ${S.charEdits[S.character] ? '' : 'disabled'}>Download character JSON</button></div>
    <div class="sec">EXPORT</div>
    <div><button id="glb">Download GLB</button><button id="shot" class="ghost">Screenshot</button></div>
    <div class="dim">CLI: <code>npm run assets -- help</code></div>`;
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
  $('ch').onchange = () => { S.character = $('ch').value; rebuild(); };
  $('team').onchange = () => { S.team = parseInt($('team').value.slice(1), 16); rebuild(); };
  $('hq').onchange = () => { S.hq = $('hq').checked; rebuild(); };
  $('mo').onchange = () => { S.motion = $('mo').value; playMotion(); renderPanel(); };
  $('spd').oninput = () => { S.speed = +$('spd').value; };
  $('scrub').oninput = () => { S.playing = false; setTime(+$('scrub').value * (MOTIONS[S.motion]?.duration ?? 1)); };
  $('play').onclick = () => { S.playing = !S.playing; renderPanel(); };
  $('skel').onclick = () => { S.skeleton = !S.skeleton; if (helper) helper.visible = S.skeleton; renderPanel(); };
  $('wire').onclick = () => { S.wire = !S.wire; for (const m of (built?.mesh.material ?? []) as THREE.MeshStandardMaterial[]) m.wireframe = S.wire; renderPanel(); };
  if ($('spr')) $('spr').onclick = () => setSprings(!S.springs);
  if ($('blink')) $('blink').onclick = () => { S.autoBlink = !S.autoBlink; if (face) face.autoBlink = S.autoBlink; renderPanel(); };
  if ($('fcam')) $('fcam').onclick = () => faceCam();
  if ($('fclr')) $('fclr').onclick = () => { S.expressions = {}; face?.clear(); renderPanel(); };
  side.querySelectorAll<HTMLInputElement>('.expr').forEach(el => { el.oninput = () => setExpression(el.dataset.n!, +el.value); });
  $('pnt').onclick = () => { S.paint.on = !S.paint.on; if (S.paint.on) S.playing = false; renderPanel(); };
  $('pcol').oninput = () => { S.paint.color = $('pcol').value; };
  $('pem').onchange = () => { S.paint.emissive = $('pem').checked; };
  $('prad').oninput = () => { S.paint.radius = +$('prad').value; };
  $('phei').oninput = () => { S.paint.height = +$('phei').value; };
  $('apply').onclick = () => { try { S.edits[def.materials.body] = JSON.parse(($('json') as unknown as HTMLTextAreaElement).value); rebuild(); } catch (e) { alert(String(e)); } };
  $('undo').onclick = () => { for (const id of [def.materials.body, def.materials.armor]) { const L = mat(id).layers; if (L[L.length - 1]?.type === 'stroke') { L.pop(); rebakeAndApply(id === def.materials.body ? 'body' : 'armor'); break; } } };
  $('savej').onclick = () => dl(new Blob([JSON.stringify(mat(def.materials.body), null, 2)], { type: 'application/json' }), `${def.materials.body}.json`);
  $('glb').onclick = () => exportGLB();
  $('shot').onclick = () => renderer.domElement.toBlob(b => b && dl(b, `${S.character}-${S.motion}.png`));
  $('rfile').onchange = async () => { const f = ($('rfile') as HTMLInputElement).files?.[0]; if (f) { await refView.load(f, $('rview').value as RefView); renderPanel(); } };
  $('rfit').onchange = () => { refView.fit = $('rfit').value as RefFit; refView.layout(); };
  $('rside').onclick = () => { refView.mode = 'side'; refView.layout(); renderPanel(); };
  $('rover').onclick = () => { refView.mode = 'overlay'; refView.layout(); renderPanel(); };
  $('rhide').onclick = () => { refView.mode = 'hidden'; refView.layout(); renderPanel(); };
  $('rturn').onclick = () => refView.rotateModel(180);
  if ($('rtribes')) $('rtribes').onchange = async () => { const id = $('rtribes').value; if (id) { await refView.load(`/local-reference/meshes/${id}.glb`); renderPanel(); } };
  $('ropa').oninput = () => { refView.opacity = +$('ropa').value; refView.layout(); };
  $('rclear').onclick = () => { refView.clear(); renderPanel(); };
  $('hfit').onclick = () => { if (fitRunning) fitStop = true; else void runHeadFit(); };
  $('hsyn').onclick = () => void syntheticReference();
  $('happly').onclick = () => applyFit();
  $('hjson').onclick = () => dl(new Blob([JSON.stringify(charDef(), null, 2)], { type: 'application/json' }), `${S.character}.json`);
  $('rscore').onclick = () => {
    const f = refView.silhouetteScore('front'), sd = refView.silhouetteScore('side');
    document.getElementById('rinfo')!.textContent = `silhouette IoU (${refView.fit}): front ${f?.iou ?? 'n/a'} · side ${sd?.iou ?? 'n/a'}`;
  };
  drawMaps();
}

function drawMaps() {
  const el = document.getElementById('maps');
  if (!el) return;
  el.innerHTML = '';
  for (const [b, name] of [[bakedBody, 'body'], [bakedArmor, 'armor']] as const) {
    if (!b) continue;
    for (const k of ['albedo', 'normal', 'orm'] as const) {
      const c = document.createElement('canvas');
      c.width = c.height = b.size;
      c.title = `${name} ${k}`;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(b[k]), b.size, b.size), 0, 0);
      el.appendChild(c);
    }
  }
}

// ---------------------------------------------------------------- head auto-fit
let fitRunning = false, fitStop = false, fitLog = '', fitResult: FitProgress | null = null;
let fitPreview: THREE.Object3D | null = null;
const FIT_N = 160;

function referenceMasks() {
  const refs: Partial<Record<'front' | 'side', Uint8Array>> = {};
  for (const v of ['front', 'side'] as const) {
    if (refView.model) refs[v] = refView.renderMask(refView.model.root, v, 'head', FIT_N, true);
    else { const img = refView.images.find(i => i.view === v); if (img?.mask) refs[v] = resampleMask(img.mask, FIT_N, img.aspect, 0); }
  }
  return refs;
}

function showPreview(obj: THREE.Object3D | null) {
  if (fitPreview) scene.remove(fitPreview);
  fitPreview = obj;
  if (obj && built) { (obj as THREE.Mesh).material = built.mesh.material; scene.add(obj); }
  if (built) built.mesh.visible = !obj;
}

async function runHeadFit(opts: { rounds?: number } = {}) {
  const refs = referenceMasks();
  if (!refs.front && !refs.side) { fitLog = 'Load a front and/or side reference image (or model) first.'; renderPanel(); return null; }
  fitRunning = true; fitStop = false; fitResult = null;
  refView.fit = 'head'; refView.mode = 'overlay'; refView.opacity = 0.35; refView.layout();
  S.playing = false; mixer?.setTime(0); faceCam(0.75);
  const def = CHARACTERS[S.character]; // always fit from the content definition
  const sk = SKELETONS[def.skeleton];
  renderPanel();
  const res = await fitHead({
    base: def, sk, refs, N: FIT_N, rounds: opts.rounds ?? 6,
    render: (obj, v) => refView.renderMask(obj, v, 'head', FIT_N),
    shouldStop: () => fitStop,
    onProgress: async (p, mesh) => {
      showPreview(mesh);
      const changed = Object.entries(p.values).filter(([, v]) => v).map(([k, v]) => `${HEAD_KNOBS.find(x => x.name === k)?.label}: ${v > 0 ? '+' : ''}${v}`);
      fitLog = `${p.done ? 'done' : 'fitting…'}  silhouette match ${(p.start * 100).toFixed(1)}% → ${(p.score * 100).toFixed(1)}%\n` +
        `front ${p.perView.front !== undefined ? (p.perView.front * 100).toFixed(1) + '%' : '–'} · side ${p.perView.side !== undefined ? (p.perView.side * 100).toFixed(1) + '%' : '–'} · ${p.evals} builds\nlast: ${p.last}\n${changed.join('\n')}`;
      const el = document.getElementById('hlog'); if (el) el.textContent = fitLog;
      renderer.render(scene, camera);
      // Yield to the page (rAF when visible; a timer so hidden/background tabs don't stall).
      await new Promise(r => { requestAnimationFrame(() => r(null)); setTimeout(() => r(null), 30); });
    },
  });
  fitRunning = false;
  fitResult = res;
  renderPanel();
  return res;
}

/** Bake the fitted knob values into an edited character definition and rebuild at full quality. */
function applyFit() {
  if (!fitResult) return;
  showPreview(null);
  S.charEdits[S.character] = applyKnobs(CHARACTERS[S.character], fitResult.values);
  rebuild();
  faceCam(0.75);
}

/** Make a reference from a deliberately different head (for testing that the fit recovers it). */
async function syntheticReference(values: Record<string, number> = { headScale: 0.08, craniumW: -0.12, jawWidth: 0.24, chinDrop: 0.012, noseLen: 0.008, cheeks: 0.2, neck: 0.16, bangs: 0.04, sides: 0.08, hairVolume: 0.01 }) {
  const def = CHARACTERS[S.character];
  const mesh = buildHeadPreview(applyKnobs(def, values), SKELETONS[def.skeleton]);
  refView.clear();
  for (const v of ['front', 'side'] as const) await refView.load(maskToDataURL(refView.renderMask(mesh, v, 'head', 320), 320), v);
  refView.fit = 'head'; refView.mode = 'side'; refView.layout();
  fitLog = `synthetic reference loaded (hidden values: ${Object.entries(values).map(([k, v]) => `${k} ${v}`).join(', ')})`;
  renderPanel();
  return values;
}

view.addEventListener('dragover', e => e.preventDefault());
view.addEventListener('drop', async e => {
  e.preventDefault();
  for (const f of Array.from(e.dataTransfer?.files ?? [])) await refView.load(f, /side/i.test(f.name) ? 'side' : 'front');
  renderPanel();
});

function setExpression(name: string, weight: number) {
  if (!face) throw new Error(`${S.character} has no expression rig (toon characters with face decals only)`);
  face.set(name, weight);
  S.expressions[name] = weight;
  renderer.render(scene, camera);
}
function setSprings(on: boolean) {
  S.springs = on;
  if (springs) { springs.enabled = on; springs.reset(); }
  renderPanel();
}
/** Close-up of the face: the head bone's position, viewed from the front (characters face -z). */
function faceCam(dist = 0.55) {
  const head = built?.skeleton.byName.get('head');
  if (!head) return;
  built!.mesh.updateMatrixWorld(true);
  const p = head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.1, 0));
  camera.position.set(p.x, p.y + 0.02, p.z - dist);
  controls.target.copy(p);
  controls.update();
  renderer.render(scene, camera);
}

function setTime(t: number) {
  if (!mixer) return;
  mixer.setTime(t);
}

// ---------------------------------------------------------------- loop
let last = performance.now();
let treadmill = 0;
const frameVel = new THREE.Vector3();
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const m = MOTIONS[S.motion];
  if (mixer && S.playing) {
    mixer.update(dt * S.speed);
    treadmill += (m?.speed ?? 0) * dt * S.speed;
    // The treadmill holds the character still, so tell the springs how fast it "really" moves (-z).
    springs?.update(dt * S.speed, frameVel.set(0, 0, -(m?.speed ?? 0)));
  }
  face?.update(dt);
  refView.update(dt * (S.playing ? S.speed : 0));
  grid.position.z = treadmill % 0.25;
  if (built && m) {
    const time = mixer ? (mixer.time % m.duration) : 0;
    ['footL', 'footR'].forEach((f, i) => {
      const bone = built!.skeleton.byName.get(f);
      if (!bone) return;
      bone.getWorldPosition(footMarkers[i].position);
      const planted = (m.contacts?.[f] ?? []).some(([a, b]) => time >= a && time <= b);
      (footMarkers[i].material as THREE.MeshBasicMaterial).color.set(planted ? 0x7dffb2 : 0xff8a6a);
    });
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

resize();
rebuild();
requestAnimationFrame(loop);

// ---------------------------------------------------------------- agent API
(window as any).workbench = {
  state: S,
  get stats() { return built?.stats; },
  get mesh() { return built?.mesh; },
  setCharacter(id: string) { S.character = id; rebuild(); },
  setMotion(id: string) { S.motion = id; playMotion(); renderPanel(); },
  setTime(t: number) { S.playing = false; setTime(t); renderer.render(scene, camera); },
  setCamera(pos: [number, number, number], target: [number, number, number] = [0, 1, 0]) { camera.position.set(...pos); controls.target.set(...target); controls.update(); renderer.render(scene, camera); },
  /** Append layers to a material (e.g. strokes or decals) and re-bake. */
  addLayers(materialId: string, layers: Layer[]) { mat(materialId).layers.push(...layers); rebuild(); },
  material(id: string) { return mat(id); },
  analyze() { const m = MOTIONS[S.motion]; return analyzeMotion(buildSkeleton(SKELETONS[m.skeleton]), m); },
  screenshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); },
  exportGLB: (download = false) => exportGLB(download),
  rebuild,
  /** Set a VRM expression weight (0..1): happy, angry, sad, relaxed, surprised, aa, ih, ou, ee, oh, blink, blinkLeft, blinkRight. */
  setExpression,
  expressions: () => ({ names: EXPRESSION_NAMES, weights: { ...face?.weights } }),
  clearExpressions() { S.expressions = {}; face?.clear(); renderer.render(scene, camera); },
  setAutoBlink(on: boolean) { S.autoBlink = on; if (face) face.autoBlink = on; },
  setSprings,
  /** Run the springs (and mixer) forward `seconds` in fixed steps, e.g. before a screenshot of a paused pose. */
  settle(seconds = 1) { for (let t = 0; t < seconds; t += 1 / 60) { if (S.playing) mixer?.update(S.speed / 60); springs?.update(S.speed / 60, frameVel.set(0, 0, -(MOTIONS[S.motion]?.speed ?? 0) * (S.playing ? 1 : 0))); } renderer.render(scene, camera); },
  faceCam,
  /** Auto-fit the head/hair to the loaded reference images; resolves with the progress record. */
  fitHead: (rounds = 6) => runHeadFit({ rounds }),
  stopFit() { fitStop = true; },
  applyFit,
  syntheticReference,
  get fitResult() { return fitResult; },
  /** The edited character definition (after applyFit) — write it to content/characters to keep it. */
  characterJSON() { return charDef(); },
  /** Load a reference model (glb/gltf/vrm/obj/fbx) or image (png/jpg/webp) by URL, e.g. '/reference/head-front.png'. */
  async loadReference(url: string, view: RefView = 'front') { await refView.load(url, view); renderPanel(); return { model: refView.model?.name ?? null, images: refView.images.map(i => i.view) }; },
  setReferenceMode(mode: RefMode, fit?: RefFit, opacity?: number) { refView.mode = mode; if (fit) refView.fit = fit; if (opacity) refView.opacity = opacity; refView.layout(); renderPanel(); },
  turnReference(deg = 180) { refView.rotateModel(deg); },
  clearReference() { refView.clear(); renderPanel(); },
  /** Silhouette IoU (0..1) of the character vs the loaded reference, front or side, body or head framing. */
  silhouetteScore(view: RefView = 'front', fit?: RefFit) { return refView.silhouetteScore(view, fit); },
};
