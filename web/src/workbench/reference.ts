// Reference import for the workbench: models (GLB/glTF/VRM/OBJ/FBX) and images (front/side/face).
// References are shown beside the character or overlaid as a ghost, and can be scored
// against it by silhouette overlap (IoU) — a number agents can optimise sculpt volumes against.
//
// Files can be dropped onto the viewport, picked with the file input, or loaded by URL
// (put local-only references in web/public/reference/, which is gitignored).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

export type RefMode = 'side' | 'overlay' | 'hidden';
export type RefFit = 'body' | 'head';
export type RefView = 'front' | 'side';

interface ImageRef { kind: 'image'; view: RefView; tex: THREE.Texture; aspect: number; mask: { w: number; h: number; data: Uint8Array } | null; mesh: THREE.Mesh; name: string; }
interface ModelRef { kind: 'model'; root: THREE.Object3D; height: number; mixer: THREE.AnimationMixer | null; name: string; }

const BODY_H = 1.86, HEAD_H = 0.27, HEAD_Y = 1.72;

export class ReferenceView {
  readonly group = new THREE.Group();
  mode: RefMode = 'side';
  fit: RefFit = 'body';
  opacity = 0.5;
  images: ImageRef[] = [];
  model: ModelRef | null = null;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, private character: () => THREE.Object3D | null) {
    scene.add(this.group);
  }

  /** Load from a File (drop / picker) or a URL. `view` is for images: which direction the photo shows. */
  async load(src: File | string, view: RefView = 'front') {
    const name = typeof src === 'string' ? src : src.name;
    const ext = name.toLowerCase().split('.').pop()!.split('?')[0];
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    const isImage = (typeof src === 'string' && src.startsWith('data:image')) || (typeof src !== 'string' && src.type.startsWith('image/')) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
    if (isImage) await this.loadImage(url, view, name.startsWith('data:') ? 'image' : name);
    else await this.loadModel(url, ext, name);
    this.layout();
  }

  private async loadImage(url: string, view: RefView, name: string) {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.renderOrder = 10;
    this.images = this.images.filter(r => { if (r.view === view) { this.group.remove(r.mesh); return false; } return true; });
    this.images.push({ kind: 'image', view, tex, aspect: img.width / img.height, mask: imageMask(img), mesh, name });
    this.group.add(mesh);
  }

  private async loadModel(url: string, ext: string, name: string) {
    let root: THREE.Object3D, clips: THREE.AnimationClip[] = [];
    if (ext === 'obj') root = await new OBJLoader().loadAsync(url);
    else if (ext === 'fbx') { const r = await new FBXLoader().loadAsync(url); root = r; clips = r.animations; }
    else { const g = await new GLTFLoader().loadAsync(url); root = g.scene; clips = g.animations; } // glb, gltf, vrm
    if (this.model) this.group.remove(this.model.root);
    // Normalise: feet on the ground, height matched to our character, facing -Z like ours.
    const box = new THREE.Box3().setFromObject(root);
    const h = box.max.y - box.min.y || 1;
    const wrap = new THREE.Group();
    root.position.y -= box.min.y;
    root.position.x -= (box.min.x + box.max.x) / 2;
    root.position.z -= (box.min.z + box.max.z) / 2;
    wrap.add(root);
    wrap.scale.setScalar(BODY_H / h);
    const mixer = clips.length ? new THREE.AnimationMixer(root) : null;
    if (mixer) mixer.clipAction(clips[0]).play();
    this.model = { kind: 'model', root: wrap, height: h, mixer, name };
    this.group.add(wrap);
  }

  /** Turn the reference model around (glTF characters often face +Z; ours face -Z). */
  rotateModel(deg: number) { if (this.model) this.model.root.rotation.y += deg * Math.PI / 180; }

  layout() {
    const side = this.mode === 'side', over = this.mode === 'overlay';
    this.group.visible = this.mode !== 'hidden';
    for (const r of this.images) {
      const head = this.fit === 'head';
      const H = head ? HEAD_H * 1.6 : BODY_H, W = H * r.aspect;
      r.mesh.scale.set(W, H, 1);
      const y = head ? HEAD_Y - 0.03 : H / 2;
      const m = r.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = over ? this.opacity : 1;
      m.depthTest = !over;
      if (r.view === 'front') {
        r.mesh.rotation.set(0, Math.PI, 0); // face the default camera (looking from -Z)
        r.mesh.position.set(side ? (head ? 0.45 : 1.1) : 0, y, over ? -0.35 : 0);
      } else {
        r.mesh.rotation.set(0, -Math.PI / 2, 0);
        r.mesh.position.set(over ? 0.35 : 0, y, side ? (head ? 0.45 : 1.1) : 0);
      }
    }
    if (this.model) {
      this.model.root.position.set(side ? 1.1 : 0, 0, 0);
      this.model.root.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
        for (const m of mats) { m.transparent = over; m.opacity = over ? this.opacity : 1; m.depthWrite = !over; }
      });
    }
  }

  update(dt: number) { this.model?.mixer?.update(dt); }

  clear() { this.group.clear(); this.images = []; this.model = null; }

  /**
   * Silhouette agreement (IoU, 0..1) between our character and the reference, from the front or side.
   * Both are rendered as flat masks in an orthographic view framed on the body (or head) and compared;
   * images are segmented against their border colour.
   */
  silhouetteScore(view: RefView = 'front', fit: RefFit = this.fit): { iou: number; ours: number; ref: number } | null {
    const ch = this.character();
    if (!ch) return null;
    const N = 160;
    const ours = this.renderMask(ch, view, fit, N);
    let ref: Uint8Array | null = null;
    const img = this.images.find(r => r.view === view);
    if (this.model) ref = this.renderMask(this.model.root, view, fit, N, true);
    else if (img?.mask) ref = resampleMask(img.mask, N, img.aspect, fit === 'head' ? HEAD_H * 1.6 : BODY_H);
    if (!ref) return null;
    let inter = 0, uni = 0, a = 0, b = 0;
    for (let i = 0; i < N * N; i++) { const x = ours[i] > 0, y = ref[i] > 0; if (x) a++; if (y) b++; if (x && y) inter++; if (x || y) uni++; }
    return { iou: +(inter / Math.max(1, uni)).toFixed(3), ours: a, ref: b };
  }

  renderMask(obj: THREE.Object3D, view: RefView, fit: RefFit, N: number, centered = false): Uint8Array {
    const H = fit === 'head' ? HEAD_H * 1.6 : BODY_H;
    const cy = fit === 'head' ? HEAD_Y - 0.03 : BODY_H / 2;
    const cam = new THREE.OrthographicCamera(-H / 2, H / 2, H / 2, -H / 2, 0.01, 20);
    const cx = centered ? obj.position.x : 0, cz = centered ? obj.position.z : 0;
    if (view === 'front') cam.position.set(cx, cy, cz - 5); else cam.position.set(cx + 5, cy, cz);
    cam.lookAt(cx, cy, cz);
    const rt = new THREE.WebGLRenderTarget(N, N);
    const tmp = new THREE.Scene();
    tmp.background = new THREE.Color(0);
    const parent = obj.parent, pos = obj.position.clone();
    tmp.add(obj);
    tmp.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.renderer.setRenderTarget(rt);
    this.renderer.render(tmp, cam);
    const px = new Uint8Array(N * N * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, N, N, px);
    this.renderer.setRenderTarget(null);
    parent?.add(obj);
    obj.position.copy(pos);
    rt.dispose();
    const m = new Uint8Array(N * N);
    // readPixels is bottom-up; flip to top-down to match image masks.
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) m[(N - 1 - y) * N + x] = px[(y * N + x) * 4] > 127 ? 1 : 0;
    return m;
  }
}

/** Foreground mask: pixels that differ from the dominant border colour (or are opaque, for PNGs with alpha). */
function imageMask(img: HTMLImageElement) {
  const w = Math.min(512, img.width), h = Math.round(w * img.height / img.width);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  let d: Uint8ClampedArray;
  try { d = ctx.getImageData(0, 0, w, h).data; } catch { return null; } // cross-origin without CORS
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }
  // Background = the most common colour around the border (robust when the subject touches an edge,
  // e.g. shoulders cut off at the bottom of a head shot).
  const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const o = (y * w + x) * 4, key = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
    const e = hist.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += d[o]; e.g += d[o + 1]; e.b += d[o + 2]; hist.set(key, e);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  const top = [...hist.values()].sort((a, b) => b.n - a.n)[0];
  const br = top.r / top.n, bg = top.g / top.n, bb = top.b / top.n;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[i] = hasAlpha ? (d[o + 3] > 128 ? 1 : 0) : (Math.hypot(d[o] - br, d[o + 1] - bg, d[o + 2] - bb) > 40 ? 1 : 0);
  }
  return { w, h, data };
}

/** Fit an image mask into the N×N ortho frame: image height spans the frame height, centred horizontally. */
export function resampleMask(m: { w: number; h: number; data: Uint8Array }, N: number, aspect: number, _frameH: number) {
  const out = new Uint8Array(N * N);
  const wFrac = aspect; // image width as a fraction of the frame height
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x / N - 0.5) / wFrac + 0.5, v = y / N;
    if (u < 0 || u >= 1) continue;
    out[y * N + x] = m.data[Math.floor(v * m.h) * m.w + Math.floor(u * m.w)];
  }
  return out;
}
