// Character worker: meshing (surface nets + skinning) and texture baking off the main thread.
// Results come back as transferable typed arrays; the main thread assembles THREE objects.
import { buildCharacter, CharacterDef } from './builder';
import { bakeMaterial, BakeOptions, MaterialDef } from '../paint/painter';
import type { SkeletonDef } from '../anim/skeleton';

export type WorkerJob =
  | { type: 'build'; key: string; def: CharacterDef; skeleton: SkeletonDef }
  | { type: 'bake'; key: string; def: MaterialDef; opts: BakeOptions };

self.onmessage = (e: MessageEvent<WorkerJob>) => {
  const job = e.data;
  try {
    if (job.type === 'build') {
      const res = buildCharacter(job.def, job.skeleton, {});
      const g = res.mesh.geometry;
      const attrs: Record<string, { array: ArrayBufferView; itemSize: number }> = {};
      const transfer: ArrayBuffer[] = [];
      for (const [name, a] of Object.entries(g.attributes)) {
        const arr = (a as any).array as ArrayBufferView;
        attrs[name] = { array: arr, itemSize: (a as any).itemSize };
        transfer.push(arr.buffer as ArrayBuffer);
      }
      (self as any).postMessage({ key: job.key, type: 'build', attrs, groups: g.groups, bones: res.skeleton.def.bones, springs: res.springs, stats: res.stats }, transfer);
    } else {
      const b = bakeMaterial(job.def, job.opts);
      (self as any).postMessage({ key: job.key, type: 'bake', baked: b }, [b.albedo.buffer, b.normal.buffer, b.orm.buffer, b.emissive.buffer, b.height.buffer]);
    }
  } catch (err) {
    (self as any).postMessage({ key: job.key, type: 'error', error: String((err as Error).stack ?? err) });
  }
};
