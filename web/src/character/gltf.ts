// Write a built character (skinned mesh + baked textures + motions) to GLB with glTF-Transform.
// Node-safe: no DOM or canvas needed; textures arrive as encoded PNG bytes.
import * as THREE from 'three';
import { Document, NodeIO, Node as GNode } from '@gltf-transform/core';
import type { BuildResult } from './builder';
import type { MotionDef } from '../anim/motion';

export interface TextureSet { albedo: Uint8Array; normal: Uint8Array; orm: Uint8Array; emissive?: Uint8Array; }

export async function characterToGLB(res: BuildResult, opts: { body: TextureSet; armor: TextureSet; glowColor: number; motions: MotionDef[] }): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('character');
  const sk = res.skeleton;

  // Bones as nodes (rest pose).
  const nodes = new Map<string, GNode>();
  for (const b of sk.def.bones) {
    const n = doc.createNode(b.name).setTranslation(b.offset);
    nodes.set(b.name, n);
    if (b.parent) nodes.get(b.parent)!.addChild(n); else scene.addChild(n);
  }
  const skin = doc.createSkin('skin');
  const ibm: number[] = [];
  sk.skeleton.bones.forEach((bone, i) => { skin.addJoint(nodes.get(bone.name)!); ibm.push(...sk.skeleton.boneInverses[i].elements); });
  skin.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(new Float32Array(ibm)).setBuffer(buffer));
  skin.setSkeleton(nodes.get(sk.def.bones[0].name)!);

  const tex = (name: string, png: Uint8Array) => doc.createTexture(name).setImage(png).setMimeType('image/png');
  const pbr = (name: string, t: TextureSet) => {
    const orm = tex(`${name}-orm`, t.orm);
    const m = doc.createMaterial(name)
      .setBaseColorTexture(tex(`${name}-albedo`, t.albedo))
      .setNormalTexture(tex(`${name}-normal`, t.normal))
      .setMetallicRoughnessTexture(orm).setOcclusionTexture(orm)
      .setMetallicFactor(1).setRoughnessFactor(1);
    if (t.emissive) m.setEmissiveTexture(tex(`${name}-emissive`, t.emissive)).setEmissiveFactor([1, 1, 1]);
    return m;
  };
  const glow = new THREE.Color(opts.glowColor);
  const materials = [pbr('body', opts.body), pbr('armor', opts.armor), doc.createMaterial('glow').setBaseColorFactor([glow.r, glow.g, glow.b, 1]).setEmissiveFactor([glow.r, glow.g, glow.b])];

  const g = res.mesh.geometry;
  const mesh = doc.createMesh('character');
  const attr = (name: string) => g.getAttribute(name) as THREE.BufferAttribute;
  for (const grp of g.groups) {
    const slice = (a: THREE.BufferAttribute, size: number, Ctor: any) => new Ctor((a.array as Float32Array).slice(grp.start * size, (grp.start + grp.count) * size));
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(slice(attr('position'), 3, Float32Array)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(slice(attr('normal'), 3, Float32Array)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(slice(attr('uv'), 2, Float32Array)).setBuffer(buffer))
      .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(slice(attr('skinIndex'), 4, Uint16Array)).setBuffer(buffer))
      .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(slice(attr('skinWeight'), 4, Float32Array)).setBuffer(buffer))
      .setMaterial(materials[grp.materialIndex ?? 0]);
    mesh.addPrimitive(prim);
  }
  scene.addChild(doc.createNode('character-mesh').setMesh(mesh).setSkin(skin));

  // Animations from interpretable motions (Euler degrees → quaternions).
  const e = new THREE.Euler(), q = new THREE.Quaternion();
  for (const m of opts.motions) {
    const anim = doc.createAnimation(m.id);
    for (const [boneName, tr] of Object.entries(m.tracks)) {
      const node = nodes.get(boneName);
      if (!node) continue;
      if (tr.rot?.length) {
        const times = new Float32Array(tr.rot.map(k => k[0]));
        const vals = new Float32Array(tr.rot.length * 4);
        tr.rot.forEach((k, i) => { q.setFromEuler(e.set(k[1] * Math.PI / 180, k[2] * Math.PI / 180, k[3] * Math.PI / 180, 'XYZ')); vals.set([q.x, q.y, q.z, q.w], i * 4); });
        const s = doc.createAnimationSampler().setInput(doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer)).setOutput(doc.createAccessor().setType('VEC4').setArray(vals).setBuffer(buffer)).setInterpolation('LINEAR');
        anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath('rotation').setSampler(s));
      }
      if (tr.pos?.length) {
        const off = sk.def.bones.find(b => b.name === boneName)!.offset;
        const times = new Float32Array(tr.pos.map(k => k[0]));
        const vals = new Float32Array(tr.pos.flatMap(k => [off[0] + k[1], off[1] + k[2], off[2] + k[3]]));
        const s = doc.createAnimationSampler().setInput(doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer)).setOutput(doc.createAccessor().setType('VEC3').setArray(vals).setBuffer(buffer)).setInterpolation('LINEAR');
        anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath('translation').setSampler(s));
      }
    }
  }
  return new NodeIO().writeBinary(doc);
}
